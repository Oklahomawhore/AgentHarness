import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import type { Config } from '../src/command.ts'
import type { ClaudeScopeSetupResult } from '../src/types.ts'
import { readBoundedUtf8 } from '../src/transport.ts'
import { commandHost, type CommandHost } from './fixtures/command-host.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

async function host(backend: 'text' | 'facts' = 'text'): Promise<CommandHost> {
  const fixture = await commandHost(false, backend)
  disposers.push(() => fixture.dispose())
  return fixture
}

async function launch(fixture: CommandHost, rawInput: string | undefined, overrides: Partial<Config> = {}) {
  const profile = `claude-hook-${randomUUID()}`
  const home = join(fixture.directory, 'home')
  const directory = join(home, 'profiles', profile)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: profile, private: true, dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }))
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: 'command', name: new URL('./fixtures/command.mjs', import.meta.url).href,
    config: { descriptorPath: fixture.descriptorPath, maxRequestBytes: 32768, maxResponseBytes: 32768, timeoutMs: 10000, ...overrides },
  }] }]))
  const invocation = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    mode: 'lib', configArgs: ['--profile', profile],
    env: { DSH_HOME: home, DSH_AGENTS_HOME: join(fixture.directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' },
  })
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name) && !/^(?:DSH_|CLAUDE|NODE_OPTIONS$)/u.test(name)))
  const child = execa(invocation.command, invocation.args, {
    cwd: fixture.directory, env: { ...environment, ...invocation.env }, extendEnv: false,
    stdin: 'pipe', reject: false, stripFinalNewline: false, timeout: 20000, killSignal: 'SIGKILL',
  })
  const done = child.then((result) => {
    expect(result.timedOut, 'the subprocess diagnostic deadline expired').toBe(false)
    return result
  })
  // Teardown still owns settlement if a race assertion throws before awaiting done.
  void done.catch(() => {})
  disposers.push(async () => { child.kill('SIGTERM'); await child })
  if (rawInput !== undefined) child.stdin.end(rawInput)
  return { process: child, done }
}

async function run(fixture: CommandHost, input: unknown, overrides: Partial<Config> = {}) {
  const child = await launch(fixture, JSON.stringify(input), overrides)
  const result = await child.done
  expect(result.signal).toBeUndefined()
  return result
}

async function joinScope(fixture: CommandHost) {
  const observed = await run(fixture, { hook_event_name: 'SessionStart', session_id: 'external-main', cwd: fixture.directory })
  expect(observed.exitCode).toBe(0)
  expect(observed.stdout).toBe(await readFile(new URL('./expected/empty.stdout.json', import.meta.url), 'utf8'))
  const [session] = await fixture.ctx.claudeScope.sessions()
  expect(session).toBeDefined()
  const owner = 'command-owner' as DevelopmentParticipantId
  await fixture.ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
  const task = await fixture.ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Complete the shared API', scope: 'API response fields', createdBy: owner })
  await fixture.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Use field response_id. 中文 remains complete.' })
  await fixture.ctx.claudeScope.join({ sessionKey: session!.sessionKey, taskId: task.id, responsibility: 'Implement the client', roots: [fixture.directory], bashCommands: [] })
  return { task, session: session! }
}

async function runInstalledHook(fixture: CommandHost, settingsPath: string, input: { hook_event_name: string; [key: string]: unknown }) {
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
  }
  const installed = settings.hooks[input.hook_event_name]!.flatMap(group => group.hooks)
    .filter(hook => hook.command.includes('# agentharness-claude-scope:v1'))
  expect(installed).toHaveLength(1)
  expect(installed[0]!.type).toBe('command')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name) && !/^(?:DSH_|CLAUDE|NODE_OPTIONS$)/u.test(name)))
  const child = execa('/bin/sh', ['-c', installed[0]!.command], {
    cwd: fixture.directory, input: JSON.stringify(input), reject: false, stripFinalNewline: false,
    env: { ...environment, PATH: '', NODE_NO_WARNINGS: '1', DSH_TELEMETRY_DISABLED: '1' }, extendEnv: false,
    timeout: 20000, killSignal: 'SIGKILL',
  })
  disposers.push(async () => { child.kill('SIGTERM'); await child })
  const result = await child
  expect(result.timedOut, 'the generated command did not settle within its diagnostic deadline').toBe(false)
  expect(result.signal).toBeUndefined()
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext: string } }
}

async function setupThroughRemote(fixture: CommandHost, projectPath: string): Promise<ClaudeScopeSetupResult> {
  const signal = AbortSignal.timeout(10000)
  const login = await fetch(fixture.descriptor.launchUrl, { redirect: 'manual', signal })
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('dsh-auth-'))?.split(';', 1)[0]
  await login.body?.cancel()
  expect(login.status).toBe(303)
  expect(cookie).toBeDefined()
  const rpcId = randomUUID()
  const method = 'claudeScope/setup'
  const response = await fetch(`${new URL(fixture.descriptor.launchUrl).origin}/api/${method}`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request: { projectPath } } } }),
  })
  expect(response.status).toBe(200)
  const message = await response.json() as { type: string; rpcId: string; result: { ok: boolean; value: ClaudeScopeSetupResult } }
  expect(message).toMatchObject({ type: 'server-response', rpcId, result: { ok: true, value: { outcome: 'configured' } } })
  return message.result.value
}

describe.skipIf(process.platform === 'win32')('Claude command through built dsh and a real Host Loader tree', () => {
  it('installs project hooks and runs their ordinary dsh profile without PATH tools or per-change sharing', async () => {
    const fixture = await host()
    const projectPath = join(fixture.directory, "project 'with $ spaces")
    await mkdir(join(projectPath, '.claude'), { recursive: true })
    const original = {
      permissions: { deny: ['Read(secrets.env)'] },
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'printf existing-hook' }] }] },
    }
    await writeFile(join(projectPath, '.claude', 'settings.local.json'), JSON.stringify(original))
    expect((await fixture.ctx.claudeScope.projectSetup({ projectPath })).state).toBe('not-configured')
    const installed = await setupThroughRemote(fixture, projectPath)
    expect(installed.outcome).toBe('configured')
    expect((await fixture.ctx.claudeScope.setup({ projectPath })).outcome).toBe('already-configured')
    expect(await fixture.ctx.claudeScope.sessions()).toEqual([])
    for (const sessionId of ['writer', 'reader', 'not-joined']) {
      expect(await runInstalledHook(fixture, installed.settingsPath, {
        hook_event_name: 'SessionStart', session_id: sessionId, cwd: projectPath,
      })).toEqual({})
    }
    const observed = await fixture.ctx.claudeScope.sessions()
    expect(observed).toHaveLength(3)
    const owner = 'setup-owner' as DevelopmentParticipantId
    await fixture.ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const task = await fixture.ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Use the changed field', scope: 'Shared API', createdBy: owner })
    for (const session of observed.filter(value => value.sessionId !== 'not-joined')) {
      await fixture.ctx.claudeScope.join({
        sessionKey: session.sessionKey, taskId: task.id, responsibility: session.sessionId, roots: [projectPath], bashCommands: [],
      })
    }
    const nonce = `ordinary-work-${randomUUID()}`
    const filePath = join(projectPath, 'api.txt')
    const tool = { cwd: projectPath, tool_use_id: 'write', tool_name: 'Write', tool_input: { file_path: filePath, content: nonce } }
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
      expect(await runInstalledHook(fixture, installed.settingsPath, { ...tool, hook_event_name, session_id: 'not-joined' })).toEqual({})
    }
    expect(fixture.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    await runInstalledHook(fixture, installed.settingsPath, { ...tool, hook_event_name: 'PreToolUse', session_id: 'writer' })
    await writeFile(filePath, nonce)
    await runInstalledHook(fixture, installed.settingsPath, { ...tool, hook_event_name: 'PostToolUse', session_id: 'writer' })
    const received = await runInstalledHook(fixture, installed.settingsPath, { hook_event_name: 'UserPromptSubmit', session_id: 'reader', cwd: projectPath })
    expect(received.hookSpecificOutput?.additionalContext).toContain(nonce)
    expect(await runInstalledHook(fixture, installed.settingsPath, { hook_event_name: 'UserPromptSubmit', session_id: 'not-joined', cwd: projectPath })).toEqual({})
    const reader = observed.find(value => value.sessionId === 'reader')!
    await fixture.ctx.claudeScope.leave({ sessionKey: reader.sessionKey })
    const withdrawn = await runInstalledHook(fixture, installed.settingsPath, { hook_event_name: 'UserPromptSubmit', session_id: 'reader', cwd: projectPath })
    expect(withdrawn.hookSpecificOutput?.additionalContext).toContain('## Shared scope disconnected')
    expect(withdrawn.hookSpecificOutput?.additionalContext).not.toContain(nonce)
    expect((await fixture.ctx.claudeScope.removeSetup({ projectPath })).outcome).toBe('removed')
    expect(JSON.parse(await readFile(installed.settingsPath, 'utf8'))).toEqual(original)
    expect((await fixture.ctx.claudeScope.projectSetup({ projectPath })).state).toBe('not-configured')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('carries a real file declaration change through public command hooks to distinct recipient facts', async () => {
    const fixture = await host('facts')
    const filePath = join(fixture.directory, 'orders.openapi.json')
    const document = (required: string[], status: string) => JSON.stringify({
      openapi: '3.1.1', info: { title: 'Orders', version: '1' }, paths: { '/orders': { post: {
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required } } } },
        responses: { [status]: { description: status } },
      } } },
    })
    await writeFile(filePath, document(['old_field'], '200'))
    for (const sessionId of ['backend', 'frontend', 'qa']) {
      expect((await run(fixture, { hook_event_name: 'SessionStart', session_id: sessionId, cwd: fixture.directory })).exitCode).toBe(0)
    }
    const owner = 'api-owner' as DevelopmentParticipantId
    await fixture.ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const task = await fixture.ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Update the orders API', scope: 'Orders', createdBy: owner })
    for (const session of await fixture.ctx.claudeScope.sessions()) {
      await fixture.ctx.claudeScope.join({
        sessionKey: session.sessionKey, taskId: task.id, responsibility: session.sessionId, roots: [fixture.directory], bashCommands: [],
        ...(session.sessionId === 'backend' ? { openApiSources: [{ name: 'orders-api', filePath, method: 'post' as const, path: '/orders' }] } : {}),
      })
    }
    const content = document(['account_id'], '201')
    const tool = { session_id: 'backend', cwd: fixture.directory, tool_use_id: 'ordinary-write', tool_name: 'Write', tool_input: { file_path: filePath, content } }
    expect((await run(fixture, { ...tool, hook_event_name: 'PreToolUse' })).exitCode).toBe(0)
    await writeFile(filePath, content)
    expect((await run(fixture, { ...tool, hook_event_name: 'PostToolUse' })).exitCode).toBe(0)
    const received: string[] = []
    for (const sessionId of ['frontend', 'qa']) {
      const result = await run(fixture, { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'Continue normal work.' })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const output = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }
      received.push(output.hookSpecificOutput.additionalContext)
    }
    expect(received[0]).toContain('"requiredRequestFields":["account_id"]')
    expect(received[0]).not.toContain('"responseStatuses":[')
    expect(received[1]).toContain('"responseStatuses":["201"]')
    expect(received[1]).not.toContain('"requiredRequestFields":[')
    expect(received.every(text => !text.includes('old_field') && !text.includes(filePath))).toBe(true)
    expect(fixture.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.observation !== undefined)).toHaveLength(1)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('requests failure and removes its descriptor when durable Host state cannot be opened', async () => {
    await expect(commandHost(true)).rejects.toThrow('Host requested exit 1')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('waits past stdin EOF, authenticates, and writes only one complete recipient projection', async () => {
    const fixture = await host()
    const { task } = await joinScope(fixture)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    disposers.push(async () => { release.resolve(undefined) })
    const compute = fixture.ctx.developmentTaskContextBackend.compute.bind(fixture.ctx.developmentTaskContextBackend)
    vi.spyOn(fixture.ctx.developmentTaskContextBackend, 'compute').mockImplementationOnce(async (input) => {
      const projection = await compute(input)
      entered.resolve(undefined)
      await release.promise
      return projection
    })
    const child = await launch(fixture, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'external-main', prompt: 'Private prompt stays private' }))
    await Promise.race([entered.promise, child.done.then((result) => { throw new Error(`command exited before Host computation: ${result.stderr}`) })])
    expect(child.process.stdin.writableEnded).toBe(true)
    expect(child.process.nodeChildProcess.exitCode).toBeNull()
    expect(child.process.nodeChildProcess.signalCode).toBeNull()
    release.resolve(undefined)
    const result = await child.done
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(Object.keys(output)).toEqual(['hookSpecificOutput'])
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput.additionalContext).toContain('Complete the shared API')
    expect(output.hookSpecificOutput.additionalContext).toContain('Use field response_id. 中文 remains complete.')
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Private prompt stays private')
    expect(result.stdout).not.toContain('receipt')
    expect(result.stdout).not.toContain('token=')
    expect(result.stderr).toBe('')
    expect(fixture.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(1)
    expect(fixture.exitCodes).toEqual([])
    expect((await stat(fixture.descriptorPath)).mode & 0o777).toBe(0o600)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('repeats current output on later requests without claiming a host-admission acknowledgment', async () => {
    const fixture = await host()
    await joinScope(fixture)
    const compute = vi.spyOn(fixture.ctx.developmentTaskContextBackend, 'compute')
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'external-main' }
    const first = await run(fixture, input)
    const second = await run(fixture, input)
    expect(first.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(compute).toHaveBeenCalledTimes(1)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('captures A tool completion automatically and returns its fact to B without a shared prompt', async () => {
    const fixture = await host()
    const owner = 'automatic-owner' as DevelopmentParticipantId
    await fixture.ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const task = await fixture.ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Share the discovered response field', scope: 'API schema', createdBy: owner })
    for (const sessionId of ['writer-A', 'reader-B']) {
      const result = await run(fixture, { hook_event_name: 'SessionStart', session_id: sessionId, cwd: fixture.directory })
      expect(result.exitCode).toBe(0)
      const session = (await fixture.ctx.claudeScope.sessions()).find(candidate => candidate.sessionId === sessionId)!
      await fixture.ctx.claudeScope.join({
        sessionKey: session.sessionKey, taskId: task.id, responsibility: sessionId, roots: [fixture.directory], bashCommands: [],
      })
    }
    const nonce = `writer-only-${randomUUID()}`
    const tool = { session_id: 'writer-A', cwd: fixture.directory, tool_use_id: 'write-1', tool_name: 'Write',
      tool_input: { file_path: join(fixture.directory, 'schema.txt'), content: `response_id = ${nonce}` } }
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const result = await run(fixture, { ...tool, hook_event_name: event })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('{}\n')
    }
    const [publication] = fixture.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(publication).toBeDefined()
    if (publication?.publishedBy === undefined) throw new Error('expected a native participant publication')
    expect(publication.text).toContain(nonce)
    const source = JSON.parse(publication.text) as { sourceId: string }
    const inputB = { hook_event_name: 'UserPromptSubmit', session_id: 'reader-B', prompt: 'Continue the client implementation' }
    expect(JSON.stringify(inputB)).not.toContain(nonce)
    const delivered = await run(fixture, inputB)
    expect(delivered.exitCode).toBe(0)
    const output = JSON.parse(delivered.stdout) as { hookSpecificOutput: { additionalContext: string } }
    const text = output.hookSpecificOutput.additionalContext
    expect(text).toContain(nonce)
    const frame = JSON.parse(text.split('\n')[2]!) as { projectionId: string }
    const expected = text.replaceAll(frame.projectionId, '<projection>')
      .replaceAll(task.id, '<task>').replaceAll(publication.id, '<publication>')
      .replaceAll(source.sourceId, '<source>').replaceAll(publication.publishedBy, '<writer>')
      .replaceAll(String(publication.publishedAt), '<published-at>').replaceAll(nonce, '<nonce>')
    await expect(expected + '\n').toMatchFileSnapshot('./expected/automatic-context.txt')
    const recipient = (await fixture.ctx.claudeScope.sessions()).find(session => session.sessionId === 'reader-B')!
    await fixture.ctx.claudeScope.leave({ sessionKey: recipient.sessionKey })
    const disconnected = await run(fixture, inputB)
    expect(disconnected.exitCode).toBe(0)
    const withdrawnOutput = JSON.parse(disconnected.stdout) as { hookSpecificOutput: { additionalContext: string } }
    const withdrawal = withdrawnOutput.hookSpecificOutput.additionalContext
    const withdrawnFrame = JSON.parse(withdrawal.split('\n')[2]!) as { projectionId: string }
    await expect(withdrawal.replaceAll(withdrawnFrame.projectionId, '<withdrawal>').replaceAll(frame.projectionId, '<projection>') + '\n')
      .toMatchFileSnapshot('./expected/withdrawal-context.txt')
    expect(withdrawal).not.toContain(nonce)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('cancels a running HTTP projection and emits no partial context', async () => {
    const fixture = await host()
    await joinScope(fixture)
    const entered = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    vi.spyOn(fixture.ctx.developmentTaskContextBackend, 'compute').mockImplementationOnce(async (input) => {
      entered.resolve(undefined)
      try {
        await new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => { reject(new Error('computation cancelled', { cause: input.signal.reason })) }, { once: true })
        })
        throw new Error('unreachable aborted computation')
      } finally { settled.resolve(undefined) }
    })
    const child = await launch(fixture, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'external-main' }))
    await Promise.race([entered.promise, child.done.then(() => { throw new Error('command ended before cancellation barrier') })])
    child.process.kill('SIGTERM')
    const result = await child.done
    await settled.promise
    expect(result.stdout).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('rejects malformed input and complete byte budgets with classified stderr', async () => {
    const fixture = await host()
    const malformed = await (await launch(fixture, '{')).done
    expect(malformed.exitCode).toBe(1)
    expect(malformed.stdout).toBe('')
    expect(malformed.stderr).toBe(await readFile(new URL('./expected/invalid.stderr.json', import.meta.url), 'utf8'))
    const tooLarge = await (await launch(fixture, '"中文"', { maxRequestBytes: 7 })).done
    expect(tooLarge.exitCode).toBe(1)
    expect(tooLarge.stdout).toBe('')
    expect(tooLarge.stderr).toBe('{"claudeScopeError":"input-too-large"}\n')
    const response = await run(fixture, { hook_event_name: 'SessionStart', session_id: 'bounded' }, { maxResponseBytes: 1 })
    expect(response.exitCode).toBe(1)
    expect(response.stdout).toBe('')
    expect(response.stderr).toBe('{"claudeScopeError":"response-too-large"}\n')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('settles input collection when the command deadline expires before stdin EOF', async () => {
    const fixture = await host()
    const result = await (await launch(fixture, undefined, { timeoutMs: 20 })).done
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('{"claudeScopeError":"request-timeout"}\n')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('refuses a stale generation and invalid launch token without leaking the capability', async () => {
    const fixture = await host()
    const stalePath = join(fixture.directory, 'stale.json')
    await writeFile(stalePath, JSON.stringify({ ...fixture.descriptor, generation: 'stale-generation' }), { mode: 0o600 })
    const input = { hook_event_name: 'SessionStart', session_id: 'rejected' }
    const stale = await run(fixture, input, { descriptorPath: stalePath })
    expect(stale.exitCode).toBe(1)
    expect(stale.stdout).toBe('')
    expect(stale.stderr).toBe('{"claudeScopeError":"rpc-rejected"}\n')
    const url = new URL(fixture.descriptor.launchUrl)
    url.searchParams.set('token', 'wrong-token')
    const tokenPath = join(fixture.directory, 'wrong-token.json')
    await writeFile(tokenPath, JSON.stringify({ ...fixture.descriptor, launchUrl: url.href }), { mode: 0o600 })
    const rejected = await run(fixture, input, { descriptorPath: tokenPath })
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stdout).toBe('')
    expect(rejected.stderr).toBe('{"claudeScopeError":"authentication-failed"}\n')
    expect(await fixture.ctx.claudeScope.sessions()).toEqual([])
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

describe('complete UTF-8 byte collection', () => {
  it('accepts an exact multibyte limit split across chunks', async () => {
    const bytes = Buffer.from('🙂')
    async function * chunks() { yield bytes.subarray(0, 1); yield bytes.subarray(1) }
    expect(await readBoundedUtf8(chunks(), 4, 'input-too-large', new AbortController().signal)).toBe('🙂')
  })

  it('rejects a single oversized chunk instead of truncating its character', async () => {
    async function * chunks() { yield Buffer.from('🙂') }
    await expect(readBoundedUtf8(chunks(), 3, 'input-too-large', new AbortController().signal)).rejects.toThrow('input-too-large')
  })
})
