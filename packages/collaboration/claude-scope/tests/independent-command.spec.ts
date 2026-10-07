import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { DevelopmentRoomDirectorySnapshot } from '@deepseek-ai/dsh-development-room'
import type { DevelopmentTaskCreateResult, DevelopmentTaskSnapshot, DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task'
import type { ScopeAccessList, ScopeContributionInvitation, ScopeChangeCursor, ScopeInvitation, ScopeReadGrant, ScopeWaitResult } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeContributionApproval, ScopeContributionEndResult, ScopeContributionInventory } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeTransportIdentity } from '@deepseek-ai/dsh-scope-transport/types'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ScopeAgentStatusResult } from '@deepseek-ai/dsh-scope-agent-context/types'
import type { ClaudeScopeContributionDetail } from '../src/types.ts'
import type { ScopeContributionLease } from '../src/contribution-state.ts'
import type { ScopeSession } from '../src/state.ts'
import type { ClaudeScopeDescriptor, ClaudeScopeContributionPreparation, ClaudeScopeHookOutput, ClaudeScopeSessionSummary, ClaudeScopeSetupResult } from '../src/types.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length !== 0) throw new AggregateError(failures, 'independent Host fixture cleanup failed')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD|PROXY)/iu.test(name) && !/^(?:DSH_|CLAUDE|NODE_OPTIONS$)/u.test(name)))
}

async function launchHost(root: string, nodeId: string, listenAddress = '/ip4/127.0.0.1/tcp/0',
  options: { nativeRecipient?: boolean; factsBackend?: boolean } = {}) {
  const directory = join(root, nodeId)
  const home = join(directory, 'home')
  const profile = join(home, 'profiles', 'independent-host')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  // Restart removes only readiness files owned by this fixture; credentials and databases survive.
  await Promise.all(['connection.json', 'identity.json'].map(name => rm(join(directory, name), { force: true })))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'independent-host', private: true, dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: 'host', name: new URL('./fixtures/independent-command-host.mjs', import.meta.url).href,
    config: { ...options, directory, nodeId, listenAddress, cliPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)) },
  }] }]))
  const invocation = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)), mode: 'lib',
    configArgs: ['--profile', 'independent-host'],
    env: { DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' },
  })
  const child = execa(invocation.command, invocation.args, {
    cwd: directory, env: { ...environment(), ...invocation.env }, extendEnv: false,
    stdin: 'ignore', reject: false, stripFinalNewline: false, forceKillAfterDelay: 5000,
  })
  let stopping: Promise<void> | undefined
  function stop(): Promise<void> {
    stopping ??= (async () => {
      child.kill('SIGTERM')
      const result = await child
      expect(result.timedOut).toBe(false)
      expect(result.signal, 'Host must settle without forced termination').not.toBe('SIGKILL')
    })()
    return stopping
  }
  disposers.push(stop)
  const exited = child.then((result): never => {
    throw new Error(`Host ${nodeId} exited before readiness (status ${String(result.exitCode)}, signal ${String(result.signal)}): ${result.stderr.replace(/token=[^\s&]+/gu, 'token=<redacted>')}`)
  })
  void exited.catch(() => {}) // File readiness races this owned exit; teardown separately awaits the child.
  async function readReady<T>(name: string): Promise<T> {
    const cancellation = new AbortController()
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(20000)])
    const pending = (async (): Promise<T> => {
      for (;;) {
        signal.throwIfAborted()
        try { return JSON.parse(await readFile(join(directory, name), 'utf8')) as T } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await delay(25, undefined, { signal })
      }
    })()
    try { return await Promise.race([pending, exited]) } finally {
      cancellation.abort()
      await pending.catch(() => {}) // The raced outcome reports readiness or process failures.
    }
  }
  return { directory, home, nodeId, child, readReady, stop }
}

type HostProcess = Awaited<ReturnType<typeof launchHost>>

async function connect(host: HostProcess) {
  const descriptor = await host.readReady<ClaudeScopeDescriptor>('connection.json')
  await host.readReady<ScopeTransportIdentity>('identity.json')
  const origin = new URL(descriptor.launchUrl).origin
  const login = await fetch(descriptor.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('dsh-auth-'))?.split(';', 1)[0]
  await login.body?.cancel()
  expect(login.status).toBe(303)
  if (cookie === undefined) throw new Error('fixture login did not set its authorization cookie')
  async function rpc<T>(method: string, args: unknown = {}): Promise<T> {
    const rpcId = randomUUID()
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    expect(response.status).toBe(200)
    const message = await response.json() as {
      type: string
      rpcId: string
      result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
    }
    expect(message.type).toBe('server-response')
    expect(message.rpcId).toBe(rpcId)
    if (!message.result.ok) throw new Error(`${method}: ${message.result.error.code}: ${message.result.error.message}`)
    return message.result.value
  }
  async function fixture<T>(body: unknown, path = '/fixture/scope-read'): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<T>
  }
  async function probe(invitation: ScopeInvitation): Promise<unknown> {
    return await fixture({
      target: { peerId: invitation.ownerPeerId, address: invitation.ownerAddress },
      protocol: '/agentharness/scope-read/1',
      payload: { version: 1, requestId: randomUUID(), subscriptionId: randomUUID(), generation: randomUUID(), invitation },
    })
  }
  function watch(invitation: ScopeInvitation) {
    const subscriptionId = randomUUID()
    const generation = randomUUID()
    return (cursor?: ScopeChangeCursor) => {
      const requestId = randomUUID()
      const result = fixture<{ result: ScopeWaitResult }>({
        target: { peerId: invitation.ownerPeerId, address: invitation.ownerAddress },
        protocol: '/agentharness/scope-watch/1',
        payload: { version: 1, requestId, subscriptionId, generation, invitation, ...(cursor === undefined ? {} : { cursor }) },
      })
      void result.catch(() => {}) // The test awaits every request after its owner-side admission barrier.
      return { requestId, result }
    }
  }
  return { ...host, rpc, probe, watch, fixture }
}

type ConnectedHost = Awaited<ReturnType<typeof connect>>

// Occupy the stopped Host's actual port so listen(0) must choose a different route.
async function occupyPreviousAddress(address: string): Promise<() => Promise<void>> {
  const match = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)\/p2p\/[^/]+$/u.exec(address)
  if (match === null) throw new Error('route fixture requires an allocated loopback IPv4 address')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.destroy()
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) { resolve(); return }
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    return closing
  }
  disposers.push(close)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: Number(match[1]) }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return close
}

async function installedHooks(host: ConnectedHost) {
  const projectPath = join(host.directory, 'project')
  await mkdir(projectPath, { recursive: true })
  const setup = await host.rpc<ClaudeScopeSetupResult>('claudeScope/setup', { request: { projectPath } })
  const settings = JSON.parse(await readFile(setup.settingsPath, 'utf8')) as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
  }
  const outputs: string[] = []
  async function hook(input: { hook_event_name: string; [key: string]: unknown }): Promise<ClaudeScopeHookOutput> {
    const commands = settings.hooks[input.hook_event_name]!.flatMap(group => group.hooks)
      .filter(item => item.command.includes('# agentharness-claude-scope:v1'))
    expect(commands).toHaveLength(1)
    const child = execa('/bin/sh', ['-c', commands[0]!.command], {
      cwd: projectPath, input: JSON.stringify(input), reject: false, stripFinalNewline: false,
      env: { ...environment(), PATH: '', NODE_NO_WARNINGS: '1', DSH_TELEMETRY_DISABLED: '1' }, extendEnv: false,
      timeout: 20000, killSignal: 'SIGKILL',
    })
    disposers.push(async () => { child.kill('SIGTERM'); await child })
    const result = await child
    expect(result.timedOut, 'the installed Hook exceeded its subprocess deadline').toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    outputs.push(result.stdout)
    return JSON.parse(result.stdout) as ClaudeScopeHookOutput
  }
  async function write(sessionId: string, text: string): Promise<void> {
    const filePath = join(projectPath, `${sessionId}.txt`)
    const tool = { session_id: sessionId, cwd: projectPath, tool_name: 'Write', tool_use_id: randomUUID(),
      tool_input: { file_path: filePath, content: text } }
    await hook({ ...tool, hook_event_name: 'PreToolUse' })
    await writeFile(filePath, text)
    await hook({ ...tool, hook_event_name: 'PostToolUse' })
  }
  return { projectPath, hook, write, outputs }
}

function records<T>(host: HostProcess, table: 'u_claude_scope_sessions' | 'u_claude_scope_leases' | 'u_claude_scope_contribution_leases' | 'u_scope_access_grants'): T[] {
  const db = new DatabaseSync(join(host.directory, 'state.sqlite'), { readOnly: true })
  try {
    return (db.prepare(`SELECT value FROM ${table} ORDER BY key`).all() as { value: string }[])
      .map(row => JSON.parse(row.value) as T)
  } finally { db.close() }
}

function durableText(host: HostProcess): string {
  const db = new DatabaseSync(join(host.directory, 'state.sqlite'), { readOnly: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'u_*' ORDER BY name").all() as { name: string }[])
    const globals = JSON.stringify(db.prepare('SELECT value FROM unit_globals ORDER BY unit').all())
    return [globals, ...tables.map(({ name }) => {
      if (!/^u_[a-z0-9_]+$/u.test(name)) throw new Error('fixture encountered a non-domain table name')
      return JSON.stringify(db.prepare(`SELECT value FROM ${name} ORDER BY key`).all())
    })].join('\n')
  } finally { db.close() }
}

async function session(host: ConnectedHost, sessionId: string): Promise<ClaudeScopeSessionSummary> {
  const value = (await host.rpc<ClaudeScopeSessionSummary[]>('claudeScope/sessions')).find(item => item.sessionId === sessionId)
  if (value === undefined) throw new Error(`fixture session ${sessionId} was not observed`)
  return value
}

// Installed shell hooks and POSIX process signals are exercised by the POSIX lane.
describe.skipIf(process.platform === 'win32')('independent built dsh Hosts with recipient-pinned scope reads', () => {
  it('keeps private Tasks out of B and C, restores identity and receipt intent, and retains revocation across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-independent-command-'))
    disposers.push(() => rm(root, { recursive: true, force: true }))
    await chmod(root, 0o700)
    const processes = [
      await launchHost(root, 'owner-a'), await launchHost(root, 'recipient-b'), await launchHost(root, 'outsider-c'),
    ] as const
    const connected = await Promise.all(processes.map(connect)) as [ConnectedHost, ConnectedHost, ConnectedHost]
    let [owner, receiver] = connected
    const outsider = connected[2]
    const identities = await Promise.all([owner, receiver, outsider].map(host => host.rpc<ScopeTransportIdentity>('scopeAccess/identity')))
    expect(new Set(identities.map(identity => identity.peerId)).size).toBe(3)
    expect(new Set(processes.map(host => host.child.pid)).size).toBe(3)
    expect(new Set(await Promise.all(processes.map(async host => (await stat(join(host.directory, 'state.sqlite'))).ino))).size).toBe(3)
    const ownerIdentity = identities[0]!
    const receiverIdentity = identities[1]!
    const ownerAddress = ownerIdentity.addresses[0]!
    expect(ownerAddress).toMatch(/\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\//u)
    const listenAddress = ownerAddress.slice(0, ownerAddress.lastIndexOf('/p2p/'))
    const ownerHooks = await installedHooks(owner)
    let receiverHooks = await installedHooks(receiver)
    const outsiderHooks = await installedHooks(outsider)
    await owner.rpc('developmentRooms/announce', { request: { id: 'human-owner', kind: 'human', displayName: 'Owner' } })
    const createTask = async (objective: string): Promise<DevelopmentTaskSnapshot> => {
      const result = await owner.rpc<DevelopmentTaskCreateResult>('developmentTasks/create', { request: {
        origin: { kind: 'root' }, objective, scope: 'API', createdBy: 'human-owner',
      } })
      return result.task
    }
    const shared = await createTask('Shared client integration')
    const privateTask = await createTask('Private unrelated project')
    for (const [sessionId, task] of [['shared-writer', shared], ['private-writer', privateTask]] as const) {
      await ownerHooks.hook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: ownerHooks.projectPath })
      const writer = await session(owner, sessionId)
      await owner.rpc('claudeScope/join', { request: {
        sessionKey: writer.sessionKey, taskId: task.id, responsibility: 'backend', roots: [ownerHooks.projectPath], bashCommands: [],
      } })
    }
    for (const sessionId of ['reader', 'unjoined']) {
      await receiverHooks.hook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: receiverHooks.projectPath })
    }
    await outsiderHooks.hook({ hook_event_name: 'SessionStart', session_id: 'outsider', cwd: outsiderHooks.projectPath })
    const reader = await session(receiver, 'reader')
    const cSession = await session(outsider, 'outsider')
    const firstNonce = `shared-original-${randomUUID()}`
    const nextNonce = `shared-updated-${randomUUID()}`
    const privateCanary = `never-share-${randomUUID()}`
    await ownerHooks.write('shared-writer', firstNonce)
    await ownerHooks.write('private-writer', privateCanary)
    const invitation = await owner.rpc<ScopeInvitation>('scopeAccess/invite', { request: {
      taskId: shared.id, recipientPeerId: receiverIdentity.peerId, ownerAddress,
      expiresAt: Date.now() + 300000, responsibility: 'frontend',
    } })
    await expect(outsider.rpc('claudeScope/receive', { request: { sessionKey: cSession.sessionKey, invitation } })).rejects.toThrow()
    expect(await outsider.probe(invitation)).toMatchObject({ result: { status: 'denied' } })
    expect(await receiver.probe({ ...invitation, taskId: privateTask.id })).toMatchObject({ result: { status: 'denied' } })
    const received = await receiver.rpc<ClaudeScopeSessionSummary>('claudeScope/receive', { request: { sessionKey: reader.sessionKey, invitation } })
    expect(received.receiveTaskId).toBe(shared.id)
    expect(received.taskId).toBeUndefined()
    const input = { hook_event_name: 'PostToolBatch', session_id: 'reader', cwd: receiverHooks.projectPath }
    expect(JSON.stringify(input)).not.toContain(firstNonce)
    expect((await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext).toContain(firstNonce)
    expect((await receiverHooks.hook({ ...input, session_id: 'unjoined' })).hookSpecificOutput).toBeUndefined()
    await receiverHooks.write('reader', `receiver-local-${randomUUID()}`)
    expect(records(receiver, 'u_claude_scope_leases')).toEqual([])
    const storedReader = records<{ sessionId: string; grant?: unknown; receive?: unknown }>(receiver, 'u_claude_scope_sessions')
      .find(item => item.sessionId === 'reader')
    expect(storedReader?.receive).toBeDefined()
    expect(storedReader?.grant).toBeUndefined()
    expect(await receiver.rpc<DevelopmentTaskSnapshot[]>('developmentTasks/list', { request: { limit: 32 } })).toEqual([])
    expect(await outsider.rpc<DevelopmentTaskSnapshot[]>('developmentTasks/list', { request: { limit: 32 } })).toEqual([])
    expect((await receiver.rpc<DevelopmentRoomDirectorySnapshot>('developmentRooms/list')).rooms).toEqual([])
    expect((await outsider.rpc<DevelopmentRoomDirectorySnapshot>('developmentRooms/list')).rooms).toEqual([])
    const watch = receiver.watch(invitation)
    const aligned = (await watch().result).result
    if (aligned.status !== 'changed') throw new Error(`initial watch failed: ${aligned.status}`)
    const pendingChange = watch(aligned.cursor)
    expect(await owner.fixture({ kind: 'watch-admission', requestId: pendingChange.requestId })).toEqual({ active: true })
    expect(await receiver.probe(invitation)).toMatchObject({ result: { status: 'active' } })
    expect(await owner.fixture({ kind: 'watch-state', requestId: pendingChange.requestId })).toEqual({ active: true })
    await ownerHooks.write('private-writer', `${privateCanary}-changed`)
    expect(await owner.fixture({ kind: 'watch-state', requestId: pendingChange.requestId })).toEqual({ active: true })
    await ownerHooks.write('shared-writer', nextNonce)
    const changed = (await pendingChange.result).result
    expect(changed.status).toBe('changed')
    expect(changed).not.toEqual(aligned)
    expect(JSON.stringify(changed)).not.toContain(nextNonce)
    expect(JSON.stringify(changed)).not.toContain(privateCanary)
    expect((await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext).toContain(nextNonce)
    for (const host of [receiver, outsider]) expect(durableText(host)).not.toContain(privateCanary)
    expect(receiverHooks.outputs.join('\n')).not.toContain(privateCanary)
    expect(outsiderHooks.outputs.join('\n')).not.toContain(privateCanary)

    await receiver.stop()
    receiver = await connect(await launchHost(root, 'recipient-b'))
    receiverHooks = await installedHooks(receiver)
    expect((await receiver.rpc<ScopeTransportIdentity>('scopeAccess/identity')).peerId).toBe(receiverIdentity.peerId)
    expect((await session(receiver, 'reader')).receiveSubscriptionId).toBe(received.receiveSubscriptionId)
    expect((await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext).toContain(nextNonce)
    await owner.stop()
    const offline = (await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext
    expect(offline).toContain('The owner could not be reached to verify current authorization.')
    expect(offline).not.toContain(nextNonce)
    expect((await session(receiver, 'reader')).receiveState).toBe('unavailable')
    // Rebind the port allocated by this same Host before its restart; no free-port probe is used.
    owner = await connect(await launchHost(root, 'owner-a', listenAddress))
    expect((await owner.rpc<ScopeTransportIdentity>('scopeAccess/identity')).peerId).toBe(ownerIdentity.peerId)
    expect((await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext).toContain(nextNonce)
    const restoredWatch = receiver.watch(invitation)
    const restoredCursor = (await restoredWatch().result).result
    if (restoredCursor.status !== 'changed') throw new Error(`restored watch failed: ${restoredCursor.status}`)
    const pendingRevocation = restoredWatch(restoredCursor.cursor)
    expect(await owner.fixture({ kind: 'watch-admission', requestId: pendingRevocation.requestId })).toEqual({ active: true })
    await owner.rpc('scopeAccess/revoke', { request: { grantId: invitation.grantId } })
    expect((await pendingRevocation.result).result).toEqual({ status: 'revoked' })
    expect(records<ScopeReadGrant>(owner, 'u_scope_access_grants')).toContainEqual({ invitation, state: 'revoked' })
    const revoked = (await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext
    expect(revoked).toContain('This receiving interval is no longer authorized.')
    expect(revoked).not.toContain(firstNonce)
    expect(revoked).not.toContain(nextNonce)
    expect((await session(receiver, 'reader')).receiveState).toBe('revoked')
    await Promise.all([owner.stop(), receiver.stop()])
    const restarted = [await launchHost(root, 'owner-a', listenAddress), await launchHost(root, 'recipient-b')] as const
    ;[owner, receiver] = await Promise.all([connect(restarted[0]), connect(restarted[1])])
    receiverHooks = await installedHooks(receiver)
    expect((await owner.rpc<ScopeTransportIdentity>('scopeAccess/identity')).peerId).toBe(ownerIdentity.peerId)
    expect((await receiver.rpc<ScopeTransportIdentity>('scopeAccess/identity')).peerId).toBe(receiverIdentity.peerId)
    expect((await owner.rpc<ScopeAccessList>('scopeAccess/list')).grants).toContainEqual({ invitation, state: 'revoked' })
    expect((await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext).not.toContain(nextNonce)
    await receiver.rpc('claudeScope/receiveLeave', { request: { sessionKey: reader.sessionKey } })
    const rejoined = await receiver.rpc<ClaudeScopeSessionSummary>('claudeScope/receive', { request: { sessionKey: reader.sessionKey, invitation } })
    expect(rejoined.receiveState).toBe('pending')
    const stillRevoked = (await receiverHooks.hook(input)).hookSpecificOutput?.additionalContext
    expect(stillRevoked).toContain('This receiving interval is no longer authorized.')
    expect(stillRevoked).not.toContain(nextNonce)
    expect((await session(receiver, 'reader')).receiveState).toBe('revoked')
    for (const host of [receiver, outsider]) expect(durableText(host)).not.toContain(privateCanary)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

it.skipIf(process.platform === 'win32')('automatically carries independent Claude file changes into native requests through three real dsh Hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-contribution-command-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const owner = await connect(await launchHost(root, 'scope-owner', undefined, { factsBackend: true }))
  const source = await connect(await launchHost(root, 'source-user'))
  const recipient = await connect(await launchHost(root, 'recipient-user', undefined, { nativeRecipient: true }))
  const [ownerIdentity, sourceIdentity, recipientIdentity] = await Promise.all([owner, source, recipient]
    .map(host => host.rpc<ScopeTransportIdentity>('scopeAccess/identity')))
  expect(new Set([owner.child.pid, source.child.pid, recipient.child.pid]).size).toBe(3)
  expect(new Set([ownerIdentity!.peerId, sourceIdentity!.peerId, recipientIdentity!.peerId]).size).toBe(3)
  await owner.rpc('developmentRooms/announce', { request: { id: 'human-owner', kind: 'human', displayName: 'Owner' } })
  const { task } = await owner.rpc<DevelopmentTaskCreateResult>('developmentTasks/create', { request: {
    origin: { kind: 'root' }, objective: 'Integrate the order API', scope: 'Backend declarations and frontend integration', createdBy: 'human-owner',
  } })
  const hooks = await installedHooks(source)
  const input = { session_id: 'backend-work', cwd: hooks.projectPath }
  await hooks.hook({ ...input, hook_event_name: 'SessionStart' })
  const sourceSession = await session(source, input.session_id)
  const filePath = join(hooks.projectPath, 'openapi.json')
  const document = (field: string, responseStatus = '201') => JSON.stringify({ openapi: '3.1.1', info: { title: 'Orders', version: '1' }, paths: {
    '/orders': { post: { operationId: 'createOrder', requestBody: { required: true,
      content: { 'application/json': { schema: { type: 'object', required: [field] } } } }, responses: { [responseStatus]: { description: 'Created' } } } },
  } })
  await writeFile(filePath, document('initial-unpublished'))
  const preparation = await source.rpc<ClaudeScopeContributionPreparation>('claudeScope/prepareContribution', { request: {
    sessionKey: sourceSession.sessionKey, expectedCapture: null, roots: [hooks.projectPath],
    source: { name: 'Orders', filePath, method: 'post', path: '/orders' },
  } })
  expect(JSON.stringify(preparation.proposal)).not.toContain(hooks.projectPath)
  const grant: DevelopmentTaskPeerContributionGrant = {
    version: 1, ...preparation.proposal, taskId: task.id, ownerPeerId: ownerIdentity!.peerId,
    grantId: randomUUID() as DevelopmentTaskPeerContributionGrant['grantId'],
    generation: randomUUID() as DevelopmentTaskPeerContributionGrant['generation'],
    expiresAt: Date.now() + 300000, maxSamples: 8, maxSampleBytes: 4096,
  }
  const contribution = await owner.rpc<ScopeContributionInvitation>('scopeAccess/inviteContribution', {
    request: { ownerAddress: ownerIdentity!.addresses[0]!, grant },
  })
  await source.rpc('claudeScope/activateContribution', { request: { sessionKey: sourceSession.sessionKey, invitation: contribution,
    expectedCapture: { captureId: preparation.proposal.captureId, captureGeneration: preparation.proposal.captureGeneration },
  } })
  const invitation = await owner.rpc<ScopeInvitation>('scopeAccess/invite', { request: {
    taskId: task.id, recipientPeerId: recipientIdentity!.peerId, ownerAddress: ownerIdentity!.addresses[0]!,
    expiresAt: Date.now() + 300000, responsibility: 'frontend',
  } })
  interface NativeObservation {
    agentId: string
    requests: { messages: GenerateOptions['messages'] }[]
    events: SessionEvent[]
  }
  const observe = (count: number, suppressedRevision?: number) => recipient.fixture<NativeObservation>({ count, suppressedRevision }, '/fixture/native')
  const initial = await observe(0)
  expect(initial.requests).toHaveLength(0)
  const unrelated = `unselected-${randomUUID()}`
  await hooks.write(input.session_id, unrelated)
  expect(JSON.stringify((await owner.rpc<DevelopmentTaskSnapshot>('developmentTasks/get', { request: { taskId: task.id } })).context))
    .not.toContain(unrelated)
  const write = async (content: string) => {
    const tool = { ...input, tool_name: 'Write', tool_use_id: randomUUID(), tool_input: { file_path: filePath, content } }
    await hooks.hook({ ...tool, hook_event_name: 'PreToolUse' })
    await writeFile(filePath, content)
    await hooks.hook({ ...tool, hook_event_name: 'PostToolUse' })
  }
  const text = (state: NativeObservation) => state.requests.at(-1)!.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  await write(document('sku'))
  await recipient.rpc('scopeAgentContext/bind', { request: {
    agentId: initial.agentId, invitation, expectedBindingId: null,
    automatic: { goal: 'Update the frontend for current order API declarations', activationLimit: 4, maxStepsPerTurn: 1, minIntervalMs: 0 },
  } })
  const first = await observe(1)
  expect(text(first)).toContain('"requiredRequestFields":["sku"]')
  expect(text(first)).toContain('"observerPeerId":"' + sourceIdentity!.peerId + '"')
  expect(text(first)).toContain('"attribution":"authenticated-peer-report"')
  const firstProjection = first.events.flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'scope-agent-context' && event.data.source.form === 'snapshot' ? [event.data.source.projection] : [])[0]
  expect(firstProjection).toMatchObject({ version: 2, activation: { kind: 'recipient-evidence', coverage: 'complete' } })
  for (const [index, content] of [document('sku'), document('sku', '202')].entries()) {
    await write(content)
    const audited = await owner.rpc<DevelopmentTaskSnapshot>('developmentTasks/get', { request: { taskId: task.id } })
    const samples = audited.context.flatMap(item => item.peerObservation === undefined ? [] : [item.peerObservation])
    expect(samples.map(sample => sample.sequence)).toEqual(Array.from({ length: index + 2 }, (_, sequence) => sequence + 1))
    expect(new Set(samples.map(sample => sample.sourceId)).size).toBe(index + 2)
    expect(samples.at(-1)).toMatchObject({ state: 'valid', facts: { requiredRequestFields: ['sku'], responseStatuses: [index === 0 ? '201' : '202'] } })
    const unchanged = await observe(1, audited.revision)
    expect(unchanged.requests).toHaveLength(1)
    expect(unchanged.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(1)
    const evaluation = unchanged.events.find(event => event.type === 'scope-agent-context/evaluation'
      && event.data.projection.taskRevision === audited.revision)
    if (evaluation?.type !== 'scope-agent-context/evaluation') throw new Error('native evaluation was not recorded')
    expect(evaluation.data.decision).toBe('suppress-unchanged')
    const projection = evaluation.data.projection
    if ('kind' in projection) throw new Error('Expected an independent remote scope projection')
    expect(projection.activation).toEqual(firstProjection?.activation)
    expect(evaluation.data.baseline).not.toBeNull()
    expect(await recipient.rpc('scopeAgentContext/status', { request: { agentId: initial.agentId } }))
      .toMatchObject({ state: { mode: 'enabled', usedBudget: 1, pendingActivation: null } })
  }
  await write(document('customerCode'))
  const corrected = await observe(2)
  expect(text(corrected)).toContain('"requiredRequestFields":["customerCode"]')
  expect(text(corrected)).not.toContain('"sku"')
  await write('{invalid JSON')
  const invalid = await observe(3)
  expect(text(invalid)).toContain('"evidence":"unavailable"')
  expect(text(invalid)).not.toContain('customerCode')
  await owner.rpc('scopeAccess/revokeContribution', { request: { grant } })
  const withdrawn = await observe(4)
  expect(text(withdrawn)).toContain('"state":"revoked"')
  expect(text(withdrawn)).not.toContain('customerCode')
  expect(withdrawn.requests).toHaveLength(4)
  expect(withdrawn.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(4)
  expect(withdrawn.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(0)
  const snapshots = withdrawn.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context'
    && event.data.source.form === 'snapshot')
  expect(snapshots).toHaveLength(4)
  const state = await recipient.rpc<ScopeAgentStatusResult>('scopeAgentContext/status', { request: { agentId: initial.agentId } })
  expect(state).toMatchObject({ state: { mode: 'paused', pauseReason: 'budget', usedBudget: 4 } })
  for (const host of [source, recipient]) {
    expect(await host.rpc<DevelopmentTaskSnapshot[]>('developmentTasks/list', { request: { limit: 32 } })).toEqual([])
    expect((await host.rpc<DevelopmentRoomDirectorySnapshot>('developmentRooms/list')).rooms).toEqual([])
  }
  const final = await owner.rpc<DevelopmentTaskSnapshot>('developmentTasks/get', { request: { taskId: task.id } })
  expect(final.context.filter(item => item.peerObservation !== undefined)).toHaveLength(6)
  expect(final.context.filter(item => item.peerContribution?.ended !== undefined)).toHaveLength(1)
  expect(JSON.stringify(final.context)).not.toContain(filePath)
  expect(JSON.stringify(withdrawn)).not.toContain(unrelated)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(process.platform === 'win32')('recovers the same contribution grant at new owner addresses for sampling and terminal acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-contribution-route-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  await chmod(root, 0o700)
  let owner = await connect(await launchHost(root, 'route-owner'))
  const source = await connect(await launchHost(root, 'route-source'))
  expect(owner.child.pid).not.toBe(source.child.pid)
  const ownerIdentity = await owner.rpc<ScopeTransportIdentity>('scopeAccess/identity')
  const sourceIdentity = await source.rpc<ScopeTransportIdentity>('scopeAccess/identity')
  expect(ownerIdentity.peerId).not.toBe(sourceIdentity.peerId)
  await owner.rpc('developmentRooms/announce', { request: { id: 'human-owner', kind: 'human', displayName: 'Owner' } })
  const { task } = await owner.rpc<DevelopmentTaskCreateResult>('developmentTasks/create', { request: {
    origin: { kind: 'root' }, objective: 'Retain one order API contribution across address changes', scope: 'Orders', createdBy: 'human-owner',
  } })
  const hooks = await installedHooks(source)
  const input = { session_id: 'route-backend', cwd: hooks.projectPath }
  await hooks.hook({ ...input, hook_event_name: 'SessionStart' })
  const observed = await session(source, input.session_id)
  const filePath = join(hooks.projectPath, 'openapi.json')
  const document = (field: string) => JSON.stringify({ openapi: '3.1.1', info: { title: 'Orders', version: '1' }, paths: {
    '/orders': { post: { operationId: 'createOrder', requestBody: { required: true,
      content: { 'application/json': { schema: { type: 'object', required: [field] } } } }, responses: { '201': { description: 'Created' } } } },
  } })
  await writeFile(filePath, document('unpublished'))
  const preparation = await source.rpc<ClaudeScopeContributionPreparation>('claudeScope/prepareContribution', { request: {
    sessionKey: observed.sessionKey, expectedCapture: null, roots: [hooks.projectPath],
    source: { name: 'Orders', filePath, method: 'post', path: '/orders' },
  } })
  const selection = { captureId: preparation.proposal.captureId, captureGeneration: preparation.proposal.captureGeneration }
  const permission = { taskId: task.id, proposal: preparation.proposal, expiresAt: Date.now() + 300000,
    maxSamples: 8, maxSampleBytes: 4096 }
  const approved = await owner.rpc<ScopeContributionApproval>('scopeAccess/approveContribution', { request: {
    ...permission, ownerAddress: ownerIdentity.addresses[0],
  } })
  const grant = approved.invitation.grant
  const activate = (invitation: ScopeContributionInvitation) => source.rpc<ClaudeScopeSessionSummary>('claudeScope/activateContribution', {
    request: { sessionKey: observed.sessionKey, expectedCapture: selection, invitation },
  })
  const write = async (field: string) => {
    const content = document(field)
    const tool = { ...input, tool_name: 'Write', tool_use_id: randomUUID(), tool_input: { file_path: filePath, content } }
    await hooks.hook({ ...tool, hook_event_name: 'PreToolUse' })
    await writeFile(filePath, content)
    await hooks.hook({ ...tool, hook_event_name: 'PostToolUse' })
  }
  const snapshot = () => owner.rpc<DevelopmentTaskSnapshot>('developmentTasks/get', { request: { taskId: task.id } })
  const inventory = () => owner.rpc<ScopeContributionInventory>('scopeAccess/contributionInventory', { request: { taskId: task.id } })
  const detail = () => source.rpc<ClaudeScopeContributionDetail>('claudeScope/contributionDetail', {
    request: { sessionKey: observed.sessionKey },
  })
  const restartAtNewAddress = async (previousAddress: string): Promise<string> => {
    await owner.stop()
    const releasePort = await occupyPreviousAddress(previousAddress)
    try { owner = await connect(await launchHost(root, 'route-owner')) } finally { await releasePort() }
    const identity = await owner.rpc<ScopeTransportIdentity>('scopeAccess/identity')
    expect(identity.peerId).toBe(ownerIdentity.peerId)
    const address = identity.addresses[0]
    if (address === undefined) throw new Error('restarted owner did not advertise its listener')
    expect(address).not.toBe(previousAddress)
    return address
  }
  const recover = (ownerAddress: string) => owner.rpc<ScopeContributionApproval>('scopeAccess/recoverContributionInvitation', {
    request: { taskId: task.id, grantId: grant.grantId, generation: grant.generation, ownerAddress },
  })

  expect((await activate(approved.invitation)).contributionState).toBe('active')
  await write('sku')
  const first = await snapshot()
  expect(first.context.flatMap(item => item.peerObservation === undefined ? [] : [item.peerObservation]))
    .toMatchObject([{ sequence: 1, state: 'valid', facts: { requiredRequestFields: ['sku'] } }])
  const address = await restartAtNewAddress(approved.invitation.ownerAddress)
  const recovered = await recover(address)
  expect(recovered.invitation.grant).toEqual(grant)
  expect(recovered.invitation.ownerAddress).toBe(address)
  expect((await snapshot()).revision).toBe(first.revision)
  expect((await activate(recovered.invitation)).contributionState).toBe('active')
  expect((await detail()).capture).toMatchObject({ selection, proposal: preparation.proposal, invitation: recovered.invitation })
  await write('customerCode')
  const corrected = await snapshot()
  const samples = corrected.context.flatMap(item => item.peerObservation === undefined ? [] : [item.peerObservation])
  expect(samples.map(sample => sample.sequence)).toEqual([1, 2])
  expect(samples.at(-1)).toMatchObject({ state: 'valid', facts: { requiredRequestFields: ['customerCode'] } })
  expect(corrected.context.filter(item => item.peerObservation !== undefined).map(item => item.peerContribution?.grant))
    .toEqual([grant, grant])
  expect(await inventory()).toMatchObject({ entries: [{ state: 'active', grant }], nextGrantId: null })

  const ended = await owner.rpc<ScopeContributionEndResult>('scopeAccess/revokeContribution', { request: { grant } })
  if (ended.status !== 'ended') throw new Error(`owner revoke failed: ${ended.status}`)
  const terminalRevision = (await snapshot()).revision
  await owner.stop()
  const pending = await source.rpc<ClaudeScopeSessionSummary>('claudeScope/contributionLeave', { request: {
    sessionKey: observed.sessionKey, expectedCapture: selection,
  } })
  expect(pending.contributionState).toBe('withdrawal-pending')
  expect((await detail()).capture?.invitation).toEqual(recovered.invitation)
  const terminalAddress = await restartAtNewAddress(address)
  const terminal = await recover(terminalAddress)
  expect(terminal.invitation.grant).toEqual(grant)
  expect(terminal.invitation.ownerAddress).toBe(terminalAddress)
  expect(await inventory()).toMatchObject({ entries: [{ state: 'ended', grant, endReceipt: ended.receipt }], nextGrantId: null })
  const left = await source.rpc<ClaudeScopeSessionSummary>('claudeScope/contributionLeave', { request: {
    sessionKey: observed.sessionKey, expectedCapture: selection, invitation: terminal.invitation,
  } })
  expect(left.contributionState).toBeUndefined()
  expect((await detail()).capture).toBeNull()
  const terminalRetry = await owner.rpc<ScopeContributionEndResult>('scopeAccess/revokeContribution', { request: { grant } })
  expect(terminalRetry).toEqual(ended)
  await expect(owner.rpc('scopeAccess/approveContribution', { request: { ...permission, ownerAddress: terminalAddress } }))
    .rejects.toThrow('scope-contribution/grant-ended')
  await write('after-withdrawal')
  const final = await snapshot()
  expect(final.revision).toBe(terminalRevision)
  expect(final.context.flatMap(item => item.peerObservation === undefined ? [] : [item.peerObservation.state]))
    .toEqual(['valid', 'valid', 'revoked'])
  expect(final.context.filter(item => item.peerContribution?.ended !== undefined)).toHaveLength(1)
  expect(JSON.stringify(final.context)).not.toContain('after-withdrawal')
  expect(await source.rpc<DevelopmentTaskSnapshot[]>('developmentTasks/list', { request: { limit: 32 } })).toEqual([])
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it.skipIf(process.platform === 'win32')('automatically delivers exact queued work and withdrawal after an owner restart at the same address', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-contribution-outbox-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  await chmod(root, 0o700)
  let owner = await connect(await launchHost(root, 'outbox-owner'))
  const source = await connect(await launchHost(root, 'outbox-source'))
  const sourcePid = source.child.pid
  const ownerIdentity = await owner.rpc<ScopeTransportIdentity>('scopeAccess/identity')
  const sourceIdentity = await source.rpc<ScopeTransportIdentity>('scopeAccess/identity')
  expect(ownerIdentity.peerId).not.toBe(sourceIdentity.peerId)
  const ownerAddress = ownerIdentity.addresses[0]!
  const listenAddress = ownerAddress.slice(0, ownerAddress.lastIndexOf('/p2p/'))
  await owner.rpc('developmentRooms/announce', { request: { id: 'human-owner', kind: 'human', displayName: 'Owner' } })
  const { task } = await owner.rpc<DevelopmentTaskCreateResult>('developmentTasks/create', { request: {
    origin: { kind: 'root' }, objective: 'Coordinate retry policy', scope: 'Implementation', createdBy: 'human-owner',
  } })
  const hooks = await installedHooks(source)
  const input = { session_id: 'outbox-writer', cwd: hooks.projectPath }
  await hooks.hook({ ...input, hook_event_name: 'SessionStart' })
  const observed = await session(source, input.session_id)
  const preparation = await source.rpc<ClaudeScopeContributionPreparation>('claudeScope/prepareContribution', { request: {
    sessionKey: observed.sessionKey, expectedCapture: null, roots: [hooks.projectPath],
    source: { kind: 'tool-observations', tools: ['Write'] },
  } })
  const selection = { captureId: preparation.proposal.captureId, captureGeneration: preparation.proposal.captureGeneration }
  const approved = await owner.rpc<ScopeContributionApproval>('scopeAccess/approveContribution', { request: {
    taskId: task.id, proposal: preparation.proposal, expiresAt: Date.now() + 300000,
    maxSamples: 8, maxSampleBytes: 4096, ownerAddress,
  } })
  await source.rpc('claudeScope/activateContribution', { request: {
    sessionKey: observed.sessionKey, expectedCapture: selection, invitation: approved.invitation,
  } })
  const filePath = join(hooks.projectPath, 'retry.ts')
  const content = `export const retryLimit = 7; // ${'complete original work '.repeat(135)}`
  const tool = { ...input, tool_name: 'Write', tool_use_id: randomUUID(), tool_input: { file_path: filePath, content } }
  await hooks.hook({ ...tool, hook_event_name: 'PreToolUse' })
  await owner.stop()
  await writeFile(filePath, content)
  await hooks.hook({ ...tool, hook_event_name: 'PostToolUse' })
  const leases = () => records<ScopeContributionLease>(source, 'u_claude_scope_contribution_leases')
  const pending = leases()[0]!
  expect(pending.sample?.result).toMatchObject({ kind: 'tool-observation', fields: { path: 'retry.ts', content } })
  expect(pending.receipt).toBeUndefined()
  await writeFile(filePath, 'CHANGED_AFTER_CAPTURE')
  owner = await connect(await launchHost(root, 'outbox-owner', listenAddress))
  expect(await owner.rpc<ScopeTransportIdentity>('scopeAccess/identity')).toMatchObject({ peerId: ownerIdentity.peerId, addresses: [ownerAddress] })
  const snapshot = () => owner.rpc<DevelopmentTaskSnapshot>('developmentTasks/get', { request: { taskId: task.id } })
  // Only owner reads and read-only SQLite inspection follow recovery; the source receives no new Hook or management call.
  await expect.poll(async () => (await snapshot()).context.filter(item => item.peerToolObservation !== undefined).length,
    { timeout: 10000 }).toBe(1)
  const publication = (await snapshot()).context.find(item => item.peerToolObservation !== undefined)!
  await expect.poll(() => leases()[0]?.receipt?.publicationId, { timeout: 10000 }).toBe(publication.id)
  expect(leases()[0]?.sample).toEqual(pending.sample)
  expect(publication.peerToolObservation).toMatchObject({ sequence: 1, fields: { path: 'retry.ts', content } })
  expect(JSON.stringify(publication)).not.toContain('CHANGED_AFTER_CAPTURE')
  expect(source.child.pid).toBe(sourcePid)

  await hooks.hook({ hook_event_name: 'SessionStart', session_id: 'outbox-reader', cwd: hooks.projectPath })
  const reader = await session(source, 'outbox-reader')
  const invitation = await owner.rpc<ScopeInvitation>('scopeAccess/invite', { request: {
    taskId: task.id, recipientPeerId: sourceIdentity.peerId, ownerAddress,
    expiresAt: Date.now() + 300000, responsibility: 'frontend',
  } })
  await source.rpc('claudeScope/receive', { request: { sessionKey: reader.sessionKey, invitation } })
  const received = await hooks.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'outbox-reader', cwd: hooks.projectPath })
  const text = received.hookSpecificOutput?.additionalContext ?? ''
  expect(text).toContain('retryLimit = 7')
  expect(text).not.toContain('CHANGED_AFTER_CAPTURE')
  const projected = JSON.parse(text.split('<development-task-context>\n')[1]!.split('\n</development-task-context>')[0]!) as {
    publications: { text: string; peerToolObservation?: unknown }[]
  }
  expect(projected.publications).toHaveLength(1)
  expect(projected.publications[0]?.text).toBe(publication.text)
  expect(projected.publications[0]?.peerToolObservation).toBeUndefined()

  await owner.stop()
  const left = await source.rpc<ClaudeScopeSessionSummary>('claudeScope/contributionLeave', { request: {
    sessionKey: observed.sessionKey, expectedCapture: selection,
  } })
  expect(left.contributionState).toBe('withdrawal-pending')
  expect(leases()).toHaveLength(1)
  owner = await connect(await launchHost(root, 'outbox-owner', listenAddress))
  await expect.poll(async () => (await snapshot()).context.filter(item => item.peerContribution?.ended !== undefined).length,
    { timeout: 10000 }).toBe(1)
  await expect.poll(() => records<ScopeSession>(source, 'u_claude_scope_sessions')
    .find(item => item.sessionKey === observed.sessionKey)?.contribution, { timeout: 10000 }).toBeUndefined()
  expect(leases()).toEqual([])
  expect(await source.rpc<DevelopmentTaskSnapshot[]>('developmentTasks/list', { request: { limit: 32 } })).toEqual([])
  expect(source.child.pid).toBe(sourcePid)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
