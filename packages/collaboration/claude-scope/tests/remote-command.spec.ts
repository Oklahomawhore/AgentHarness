import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type {
  DevelopmentTaskCreateResult, DevelopmentTaskSnapshot, DevelopmentTaskObservedCandidate,
  DevelopmentTaskObservedInterval, DevelopmentTaskLogEntry, DevelopmentTaskAdmitRemoteObservedContextResult,
} from '@deepseek-ai/dsh-development-task'
import type { ClaudeScopeDescriptor, ClaudeScopeHookOutput, ClaudeScopeSessionSummary, ClaudeScopeSetupResult } from '../src/types.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length !== 0) throw new AggregateError(failures, 'two-Host fixture cleanup failed')
})

function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD|PROXY)/iu.test(name) && !/^(?:DSH_|CLAUDE|NODE_OPTIONS$)/u.test(name)))
}

async function launchHost(root: string, nodeId: string, secret: string) {
  const directory = join(root, nodeId)
  const home = join(directory, 'home')
  const profile = join(home, 'profiles', 'remote-host')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'credentials.yml'), JSON.stringify({ FIXTURE_MESH_SECRET: secret }), { flag: 'wx', mode: 0o600 })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'remote-host', private: true, dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: 'host', name: new URL('./fixtures/remote-command-host.mjs', import.meta.url).href,
    config: { directory, nodeId, cliPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)) },
  }] }]))
  const invocation = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)), mode: 'lib',
    configArgs: ['--profile', 'remote-host'],
    env: { DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' },
  })
  const child = execa(invocation.command, invocation.args, {
    cwd: directory, env: { ...environment(), ...invocation.env }, extendEnv: false,
    stdin: 'ignore', reject: false, stripFinalNewline: false, forceKillAfterDelay: 5000,
  })
  disposers.push(async () => {
    child.kill('SIGTERM')
    const result = await child
    expect(result.timedOut).toBe(false)
    expect(result.signal, 'Host must dispose before forced termination').not.toBe('SIGKILL')
  })
  const exited = child.then((result): never => {
    throw new Error(`Host ${nodeId} exited before readiness (status ${String(result.exitCode)}, signal ${String(result.signal)}): ${result.stderr.replaceAll(secret, '<redacted>').replace(/token=[^\s&]+/gu, 'token=<redacted>')}`)
  })
  void exited.catch(() => {}) // Each file wait races this same owned exit; teardown also awaits the child.
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
      await pending.catch(() => {}) // The raced outcome owns readiness failures.
    }
  }
  return { directory, home, nodeId, child, readReady }
}

type HostProcess = Awaited<ReturnType<typeof launchHost>>

async function connect(host: HostProcess) {
  const descriptor = await host.readReady<ClaudeScopeDescriptor>('connection.json')
  const login = await fetch(descriptor.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('dsh-auth-'))?.split(';', 1)[0]
  await login.body?.cancel()
  expect(login.status).toBe(303)
  expect(cookie).toBeDefined()
  async function rpc<T>(method: string, args: unknown = {}): Promise<T> {
    const rpcId = randomUUID()
    const response = await fetch(`${new URL(descriptor.launchUrl).origin}/api/${method}`, {
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
  return { ...host, rpc }
}

type ConnectedHost = Awaited<ReturnType<typeof connect>>

async function installedHooks(host: ConnectedHost) {
  const projectPath = join(host.directory, 'project')
  await mkdir(projectPath)
  const setup = await host.rpc<ClaudeScopeSetupResult>('claudeScope/setup', { request: { projectPath } })
  const settings = JSON.parse(await readFile(setup.settingsPath, 'utf8')) as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
  }
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
    expect(result.stdout).not.toContain('receipt')
    return JSON.parse(result.stdout) as ClaudeScopeHookOutput
  }
  return { projectPath, hook }
}

function rows<T>(host: HostProcess, table: 'u_claude_scope_leases' | 'u_development_context_tasks_events'): T[] {
  const db = new DatabaseSync(join(host.directory, 'state.sqlite'), { readOnly: true })
  try {
    return (db.prepare(`SELECT value FROM ${table} ORDER BY key`).all() as { value: string }[])
      .map(row => JSON.parse(row.value) as T)
  } finally { db.close() }
}

describe.skipIf(process.platform === 'win32')('two independent built dsh Hosts with real Mesh and installed Claude hooks', () => {
  it('requires owner approval, retains the original remote receipt on replay, and withdraws the source when B leaves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-remote-command-'))
    disposers.push(() => rm(root, { recursive: true, force: true }))
    await chmod(root, 0o700)
    const secret = randomBytes(32).toString('hex')
    const processes = [await launchHost(root, 'owner-a', secret), await launchHost(root, 'source-b', secret)] as const
    const [ownerProcess, sourceProcess] = processes
    const listening = await Promise.all(processes.map(host => host.readReady<{ nodeId: string; port: number }>('listening.json')))
    expect(listening[0]!.port).not.toBe(listening[1]!.port)
    expect(ownerProcess.child.pid).not.toBe(sourceProcess.child.pid)
    for (const [index, host] of processes.entries()) {
      const peer = listening[1 - index]!
      const path = join(host.directory, 'peer.json')
      await writeFile(`${path}.tmp`, JSON.stringify({ nodeId: peer.nodeId, url: `ws://127.0.0.1:${String(peer.port)}`, connect: index === 1 }), { flag: 'wx', mode: 0o600 })
      await rename(`${path}.tmp`, path)
    }
    const [owner, source] = await Promise.all([connect(ownerProcess), connect(sourceProcess)])
    const [ownerHooks, sourceHooks] = await Promise.all([installedHooks(owner), installedHooks(source)])
    expect((await stat(join(owner.directory, 'state.sqlite'))).ino).not.toBe((await stat(join(source.directory, 'state.sqlite'))).ino)
    await owner.rpc('developmentRooms/announce', { request: { id: 'human-owner', kind: 'human', displayName: 'Owner' } })
    const { task } = await owner.rpc<DevelopmentTaskCreateResult>('developmentTasks/create', { request: {
      origin: { kind: 'root' }, objective: 'Use the independently changed response field', scope: 'API', createdBy: 'human-owner',
    } })
    await expect.poll(async () => (await source.rpc<DevelopmentTaskSnapshot[]>('developmentTasks/list', { request: { limit: 32 } })).some(value => value.id === task.id), { timeout: 10000 }).toBe(true)
    await sourceHooks.hook({ hook_event_name: 'SessionStart', session_id: 'writer', cwd: sourceHooks.projectPath })
    await ownerHooks.hook({ hook_event_name: 'SessionStart', session_id: 'reader', cwd: ownerHooks.projectPath })
    const [writer] = await source.rpc<ClaudeScopeSessionSummary[]>('claudeScope/sessions')
    const [reader] = await owner.rpc<ClaudeScopeSessionSummary[]>('claudeScope/sessions')
    expect(writer).toBeDefined()
    expect(reader).toBeDefined()
    const awaiting = await source.rpc<ClaudeScopeSessionSummary>('claudeScope/join', { request: {
      sessionKey: writer!.sessionKey, taskId: task.id, responsibility: 'backend', roots: [sourceHooks.projectPath], bashCommands: [],
    } })
    expect(awaiting.sharingState).toBe('awaiting-approval')
    await owner.rpc('claudeScope/join', { request: {
      sessionKey: reader!.sessionKey, taskId: task.id, responsibility: 'frontend', roots: [ownerHooks.projectPath], bashCommands: [],
    } })
    const nonce = `writer-only-${randomUUID()}`
    const filePath = join(sourceHooks.projectPath, 'response.txt')
    const tool = { session_id: 'writer', cwd: sourceHooks.projectPath, tool_name: 'Write', tool_use_id: 'before-approval',
      tool_input: { file_path: filePath, content: nonce } }
    await sourceHooks.hook({ ...tool, hook_event_name: 'PreToolUse' })
    await sourceHooks.hook({ ...tool, hook_event_name: 'PostToolUse' })
    expect((await owner.rpc<DevelopmentTaskSnapshot>('developmentTasks/get', { request: { taskId: task.id } })).context).toEqual([])
    await expect.poll(async () => (await owner.rpc<DevelopmentTaskObservedCandidate[]>('developmentTasks/observedCandidates', { request: { taskId: task.id } })).length, { timeout: 10000 }).toBe(1)
    const [candidate] = await owner.rpc<DevelopmentTaskObservedCandidate[]>('developmentTasks/observedCandidates', { request: { taskId: task.id } })
    expect(candidate!.sourceNodeId).toBe('source-b')
    const { sessionLabel: _sessionLabel, ...identity } = candidate!
    const interval = await owner.rpc<DevelopmentTaskObservedInterval>('developmentTasks/approveObservedInterval', { request: identity })
    expect(interval.state).toBe('active')
    const authorizedTool = { ...tool, tool_use_id: 'approved-write' }
    await sourceHooks.hook({ ...authorizedTool, hook_event_name: 'PreToolUse' })
    await writeFile(filePath, nonce)
    await sourceHooks.hook({ ...authorizedTool, hook_event_name: 'PostToolUse' })
    type Lease = { completion?: { sourceId: string; receipt: DevelopmentTaskAdmitRemoteObservedContextResult['receipt'] } }
    const leases = rows<Lease>(source, 'u_claude_scope_leases')
    expect(leases).toHaveLength(1)
    const [firstLease] = leases
    expect(firstLease?.completion?.receipt).toMatchObject({ taskId: task.id, ownerNodeId: 'owner-a', intervalId: interval.id, event: { nodeId: 'owner-a' } })
    const receipt = firstLease!.completion!.receipt
    expect(receipt.sourceId).toBe(firstLease!.completion!.sourceId)
    const publications = rows<DevelopmentTaskLogEntry>(owner, 'u_development_context_tasks_events').filter(entry => entry.change.kind === 'context-published')
    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({ nodeId: 'owner-a', seq: receipt.event.seq, revision: receipt.revision,
      change: { publication: { id: receipt.publicationId, publishedBy: identity.participantId, observedIntervalId: interval.id } } })
    await sourceHooks.hook({ ...authorizedTool, hook_event_name: 'PostToolUse' })
    expect(rows<Lease>(source, 'u_claude_scope_leases')[0]!.completion!.receipt).toEqual(receipt)
    expect(rows<DevelopmentTaskLogEntry>(owner, 'u_development_context_tasks_events').filter(entry => entry.change.kind === 'context-published')).toHaveLength(1)
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'reader', prompt: 'Continue ordinary client work.' }
    expect(JSON.stringify(input)).not.toContain(nonce)
    expect((await ownerHooks.hook(input)).hookSpecificOutput?.additionalContext).toContain(nonce)
    const left = await source.rpc<ClaudeScopeSessionSummary>('claudeScope/leave', { request: { sessionKey: writer!.sessionKey } })
    expect(left.taskId).toBeUndefined()
    expect(left.sharingState).toBeUndefined()
    const [ended] = await owner.rpc<DevelopmentTaskObservedInterval[]>('developmentTasks/observedIntervals', { request: { taskId: task.id } })
    expect(ended).toMatchObject({ id: interval.id, state: 'ended', sourceNodeId: 'source-b', endReceipt: { ownerNodeId: 'owner-a' } })
    const withdrawal = (await ownerHooks.hook(input)).hookSpecificOutput?.additionalContext
    expect(withdrawal).toContain('Earlier observations from this interval do not establish current facts.')
    expect(withdrawal).not.toContain(nonce)
    expect(rows<DevelopmentTaskLogEntry>(owner, 'u_development_context_tasks_events').filter(entry => entry.change.kind === 'observed-interval-ended')).toHaveLength(1)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
