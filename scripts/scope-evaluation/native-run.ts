/** Four named dsh Hosts calibrating real file tools and passive scope delivery with reviewed programs. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import type { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { createWorkbench, type Workbench } from './workbench.ts'
import { assertControlledSources, type CaseFixture } from './fixtures.ts'
import { resolveNativeModules } from './native-dependencies.ts'
import type { GradeResult } from './oracle.ts'

const limit = 262144
const operationSchema = z.discriminatedUnion('operation', [
  z.object({ role: z.enum(['B', 'C']), sessionId: z.string(), operation: z.literal('evaluation_read'), path: z.string() }).strict(),
  z.object({ role: z.enum(['B', 'C']), sessionId: z.string(), operation: z.literal('evaluation_write'), path: z.string(), text: z.string() }).strict(),
  z.object({ role: z.enum(['B', 'C']), sessionId: z.string(), operation: z.literal('evaluation_test') }).strict(),
])
const publicTestSchema = z.object({ tests: z.number().int().positive(), passed: z.number().int().nonnegative(),
  assertionFailures: z.number().int().nonnegative(), invalidFailures: z.literal(0), skipped: z.literal(0) }).strict()
const identitySchema = z.object({ peerId: z.string(), addresses: z.array(z.string()).min(1) })
const descriptorSchema = z.object({ launchUrl: z.string() })
const sourceSessionSchema = z.object({ sessionKey: z.string(), sessionId: z.string() })
const preparationSchema = z.object({ proposal: z.object({ captureId: z.string(), captureGeneration: z.string() }).loose() }).loose()
const taskSchema = z.object({ id: z.string(), revision: z.number(), context: z.array(z.unknown()) }).loose()
const sourceSchema = z.object({ kind: z.string(), form: z.string().optional(),
  projection: z.object({ taskRevision: z.number() }).loose().optional() }).loose()
const eventSchema = z.object({ seq: z.number(), type: z.string(), data: z.unknown() })
const observationSchema = z.object({ agentId: z.string(), sessionId: z.string(), header: z.unknown(),
  events: z.array(eventSchema), requests: z.array(z.object({ index: z.number(), messages: z.array(z.unknown()),
    tools: z.array(z.unknown()), eventCount: z.number(), sourceSeqs: z.array(z.number()), reconstructed: z.literal(true) })),
  flushed: z.literal(true), modelUsage: z.null(), durable: z.object({ sha256: z.string(), bytes: z.number(),
    eventCount: z.number(), requestReconstruction: z.literal(true), file: z.string() }) })
type Role = 'B' | 'C'

/** Explicit configuration; the optional grader runs only after both Sessions and artifacts are sealed. */
export interface NativeRunRequest {
  readonly fixture: CaseFixture
  readonly condition: 'N' | 'R'
  readonly output: string
  readonly nodePath: string
  readonly repo: string
  readonly timeoutMs: number
  readonly cancelAtBarrier?: boolean
  readonly grade?: (clientSource: string, testSource: string) => Promise<GradeResult>
}

/** Controlled runner evidence, without a quality score or inferred provider usage. */
export interface NativeRunResult {
  readonly kind: 'controlled-native-run'
  readonly condition: 'N' | 'R'
  readonly caseId: CaseFixture['id']
  readonly modelTrialsExecuted: 0
  readonly modelUsage: null
  readonly modelCost: null
  readonly cancelled: boolean
  readonly ownerRevision: number | null
  readonly peers: readonly string[]
  readonly roles: Readonly<Record<Role, {
    readonly requests: number
    readonly scopeSources: number
    readonly pulses: number
    readonly publicTests: unknown
  }>>
  readonly artifacts: { readonly clientSha256: string; readonly testSha256: string } | null
  readonly oracle: GradeResult | null
  readonly cleanup: { readonly started: number; readonly closed: number; readonly forced: number }
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }
function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'LANG', 'TZ', 'TMPDIR'].flatMap(name =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}

function errorText(error: unknown): string {
  return (typeof error === 'string' ? error : error instanceof Error ? error.message : 'evaluation failed')
    .replace(/token=[^\s&]+/gu, 'token=<redacted>')
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    bytes += chunk.length
    if (bytes > limit) throw new Error('coordinator request exceeds byte bound')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
function respond(response: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > limit) throw new Error('coordinator response exceeds byte bound')
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(text)
}

interface ChildResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}
function child(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
  const process = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''; let failure: Error | undefined
  process.stdout.on('data', (data: Buffer) => {
    stdout += data.toString('utf8')
    if (Buffer.byteLength(stdout) > 1048576) { failure = new Error('child stdout exceeds byte bound'); process.kill('SIGTERM') }
  })
  process.stderr.on('data', (data: Buffer) => {
    stderr += data.toString('utf8')
    if (Buffer.byteLength(stderr) > 1048576) { failure = new Error('child stderr exceeds byte bound'); process.kill('SIGTERM') }
  })
  const closed = new Promise<ChildResult>((resolveClose, reject) => {
    process.once('error', (error) => { failure = error })
    process.once('close', (code, signal) => {
      if (failure !== undefined) reject(failure)
      else resolveClose({ code, signal, stdout, stderr })
    })
  })
  void closed.catch(() => {}) // Each owner awaits this promise, including launch failure cleanup.
  process.stdin.on('error', () => {}) // An exited child can close stdin before the finite input flushes.
  process.stdin.end(input)
  let stopping: Promise<ChildResult> | undefined
  const stop = (): Promise<ChildResult> => stopping ??= (async () => {
    process.kill('SIGTERM')
    const force = setTimeout(() => process.kill('SIGKILL'), 3000)
    try { return await closed } finally { clearTimeout(force) }
  })()
  return { process, closed, stop }
}

async function runCommand(
  command: string, args: readonly string[], cwd: string, signal: AbortSignal, input?: string,
): Promise<ChildResult> {
  signal.throwIfAborted()
  const running = child(command, args, cwd, environment(), input)
  const abort = () => { void running.stop().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try { return await running.closed } finally {
    signal.removeEventListener('abort', abort)
    await running.stop()
    signal.throwIfAborted()
  }
}

const transportSource = `const seen = []
export async function request(value) { seen.push(structuredClone(value)); return { accepted: true } }
export async function resetRequests() { seen.length = 0 }
export async function requests() { return structuredClone(seen) }
`
const smokeSource = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submit } from '../frontend/client.mjs'
test('the initial API requires a body', async () => {
  await assert.rejects(submit(undefined), { code: 'CONTRACT_INVALID_PAYLOAD' })
})
`

interface Recipient {
  readonly role: Role
  readonly sessionId: string
  readonly project: string
  readonly workbench: Workbench
  readonly ready: ReturnType<typeof Promise.withResolvers<undefined>>
  readonly release: ReturnType<typeof Promise.withResolvers<undefined>>
  readonly receipts: unknown[]
  reads: number
}
async function recipient(root: string, role: Role, fixture: CaseFixture): Promise<Recipient> {
  const project = join(root, role === 'B' ? 'project-one' : 'project-two')
  await mkdir(join(project, 'frontend'), { recursive: true, mode: 0o700 })
  await mkdir(join(project, 'qa'), { recursive: true, mode: 0o700 })
  await writeFile(join(project, 'frontend/transport.mjs'), transportSource, { mode: 0o600 })
  if (role === 'B') await writeFile(join(project, 'frontend/client.mjs'), fixture.initialClientSource, { mode: 0o600 })
  else {
    await writeFile(join(project, 'frontend/implementation.mjs'), fixture.initialClientSource, { mode: 0o600 })
    await writeFile(join(project, 'frontend/client.mjs'), "export { submit } from './implementation.mjs'\nexport { resetRequests, requests } from './transport.mjs'\n", { mode: 0o600 })
  }
  await writeFile(join(project, 'qa/public.test.mjs'), smokeSource, { mode: 0o600 })
  await writeFile(join(project, 'qa/contract.test.mjs'), smokeSource, { mode: 0o600 })
  const writableFiles = role === 'B' ? ['frontend/client.mjs'] : ['qa/contract.test.mjs', 'qa/verdict.json']
  const readableFiles = role === 'B' ? ['frontend/client.mjs', 'qa/public.test.mjs'] : ['qa/contract.test.mjs', 'frontend/client.mjs']
  const workbench = await createWorkbench({ root: project, readableFiles, writableFiles, maxReadBytes: 65536, maxWriteBytes: 65536 })
  const ready = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  void ready.promise.catch(() => {}); void release.promise.catch(() => {})
  return { role, sessionId: `evaluation-${role.toLowerCase()}`, project, workbench, ready, release, receipts: [], reads: 0 }
}
async function waitRelease(recipient: Recipient, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = () => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try { await Promise.race([recipient.release.promise, aborted.promise]) } finally { signal.removeEventListener('abort', abort) }
}
async function coordinator(recipients: Readonly<Record<Role, Recipient>>, fixture: CaseFixture, nodePath: string, lifetime: AbortSignal) {
  const tokens = { B: randomUUID(), C: randomUUID() }; const pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/tool' || !Object.values(tokens).some(token => request.headers.authorization === `Bearer ${token}`)) {
      response.writeHead(403); response.end(); return
    }
    const cancellation = new AbortController()
    const close = () => { if (!response.writableEnded) cancellation.abort(new Error('tool client disconnected')) }
    response.once('close', close)
    const signal = AbortSignal.any([lifetime, cancellation.signal, AbortSignal.timeout(30000)])
    const operation = (async () => {
      const input = operationSchema.parse(await body(request))
      const target = recipients[input.role]
      if (request.headers.authorization !== `Bearer ${tokens[input.role]}` || target.sessionId !== input.sessionId) throw new Error('tool session does not match role')
      let result: unknown
      if (input.operation === 'evaluation_read') {
        result = await target.workbench.read(input.path, signal)
        if (++target.reads === 1) { target.ready.resolve(undefined); await waitRelease(target, signal) }
      } else if (input.operation === 'evaluation_write') result = await target.workbench.write(input.path, input.text, signal)
      else {
        const selected = target.role === 'B' ? 'qa/public.test.mjs' : 'qa/contract.test.mjs'
        const code = await readFile(join(target.project, selected), 'utf8')
        const clientCode = await readFile(join(target.project, target.role === 'B' ? 'frontend/client.mjs' : 'frontend/implementation.mjs'), 'utf8')
        if (code !== smokeSource && code !== fixture.correctTestSource) throw new Error('unregistered public test source')
        if (clientCode !== fixture.initialClientSource && clientCode !== fixture.correctClientSource) throw new Error('unregistered public client source')
        const runner = fileURLToPath(new URL('./native-public-tests.mjs', import.meta.url))
        const executed = await runCommand(nodePath, ['--permission', `--allow-fs-read=${target.project}`, `--allow-fs-read=${runner}`,
          `--allow-fs-write=${join(target.project, 'qa/verdict.json')}`, runner, join(target.project, selected)], target.project, signal)
        const report = publicTestSchema.parse(JSON.parse(executed.stdout) as unknown)
        if (executed.signal !== null || (target.role === 'B' ? executed.code !== 0 || report.passed !== report.tests
          : executed.code !== 1 || report.assertionFailures === 0)) throw new Error('public test behavior did not match reviewed fixture')
        result = { kind: 'public-project-tests', exitCode: executed.code, signal: executed.signal,
          report, stderr: executed.stderr, hiddenOracleUsed: false }
      }
      target.receipts.push({ operation: input.operation, result })
      signal.throwIfAborted(); respond(response, 200, result)
    })().catch((error: unknown) => {
      if (!response.destroyed) respond(response, 400, { error: errorText(error) })
    }).finally(() => { response.removeListener('close', close); pending.delete(operation) })
    pending.add(operation)
  })
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('coordinator has no loopback address')
  return { url: `http://127.0.0.1:${address.port}/tool`, tokens, async close() {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) => server.close((error) => {
      if (error === undefined) resolveClose()
      else reject(error)
    }))
    await Promise.allSettled(pending)
  } }
}

async function launch(root: string, role: string, request: NativeRunRequest, modules: Readonly<Record<string, string>>, native?: unknown) {
  const directory = join(root, `host-${role}`); const home = join(directory, 'home')
  const profileName = `scope-evaluation-${role.toLowerCase()}`
  const profile = join(home, 'profiles', profileName)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: profileName, private: true,
    dsh: { profile: { bundles: [], patchReload: 'startup' } } }), { mode: 0o600 })
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'evaluation',
    name: new URL('./native-profile.mjs', import.meta.url).href,
    config: { directory, nodeId: `evaluation-${role.toLowerCase()}`, cliPath: join(request.repo, 'apps/cli/lib/bin.js'), modules,
      ...native === undefined ? {} : { native } },
  }] }]), { mode: 0o600 })
  const launcherUrl = modules.Launcher
  if (launcherUrl === undefined) throw new Error('shared launcher module missing')
  const launcher = await import(launcherUrl) as { resolveExampleLaunch: typeof resolveExampleLaunch }
  const invocation = launcher.resolveExampleLaunch({ srcBin: join(request.repo, 'apps/cli/src/bin.ts'), mode: 'lib',
    configArgs: ['--profile', profileName], env: { DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'),
      DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' } })
  if (await realpath(request.nodePath) !== await realpath(invocation.command)) throw new Error('nodePath must match the running Node launcher')
  const running = child(invocation.command, invocation.args, directory,
    { ...environment(), ...invocation.env, HOME: home, USERPROFILE: home })
  return { ...running, directory, home, async connect(signal: AbortSignal) {
    const stopped = running.closed.then((result) => { throw new Error(`Host ${role} exited before readiness: ${result.code}: ${errorText(result.stderr)}`) })
    void stopped.catch(() => {})
    const readReady = async (name: string): Promise<unknown> => {
      for (;;) {
        signal.throwIfAborted()
        try { return JSON.parse(await readFile(join(directory, name), 'utf8')) as unknown } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        await delay(25, undefined, { signal })
      }
    }
    const descriptor = descriptorSchema.parse(await Promise.race([readReady('connection.json'), stopped]))
    const identity = identitySchema.parse(await Promise.race([readReady('identity.json'), stopped]))
    const login = await fetch(descriptor.launchUrl, { redirect: 'manual', signal })
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('dsh-auth-'))?.split(';')[0]
    await login.body?.cancel()
    if (login.status !== 303 || cookie === undefined) throw new Error('Host authentication failed')
    const origin = new URL(descriptor.launchUrl).origin
    const post = async (path: string, input: unknown): Promise<unknown> => {
      const response = await fetch(`${origin}${path}`, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(input) })
      if (!response.ok) throw new Error(`Host ${role} request failed ${path}: ${response.status}: ${await response.text()}`)
      return response.json() as Promise<unknown>
    }
    return { identity, async rpc(method: string, args: unknown = {}): Promise<unknown> {
      const rpcId = randomUUID()
      const value = z.object({ rpcId: z.literal(rpcId), result: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), value: z.unknown().optional() }),
        z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).loose() }),
      ]) }).loose().parse(await post(`/api/${method}`, { type: 'client-request', rpcId, method, payload: { args } }))
      if (!value.result.ok) throw new Error(`${method}: ${value.result.error.code}: ${value.result.error.message}`)
      return value.result.value
    }, native: (kind: 'status' | 'start' | 'finish' | 'cancel') => post('/evaluation/session', { kind }) }
  } }
}

/** Execute one F1 N/R calibration using actual named profiles, tools, hooks, and exact saved Session sources.
 * @param request Explicit fixture, runtime, output, and optional sealed-artifact grader.
 * @returns Recorded observations and awaited cleanup, never a model-quality comparison.
 */
export async function runControlledNative(request: NativeRunRequest): Promise<NativeRunResult> {
  if (request.fixture.id !== 'F1') throw new Error('native calibration currently supports F1 only')
  assertControlledSources(request.fixture, request.fixture.correctClientSource, request.fixture.correctTestSource)
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) throw new Error('invalid run timeout')
  await mkdir(request.output, { recursive: false, mode: 0o700 })
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'scope-native-run-')))
  const lifetime = new AbortController()
  const timer = setTimeout(() => { lifetime.abort(new Error('native run deadline exceeded')) }, request.timeoutMs)
  const hosts: Awaited<ReturnType<typeof launch>>[] = []
  let server: Awaited<ReturnType<typeof coordinator>> | undefined
  let result: Omit<NativeRunResult, 'cleanup'> | undefined
  let failed: unknown
  const cleanup = { started: 0, closed: 0, forced: 0 }
  try {
    const recipients = { B: await recipient(temporary, 'B', request.fixture), C: await recipient(temporary, 'C', request.fixture) }
    lifetime.signal.addEventListener('abort', () => {
      for (const target of Object.values(recipients)) {
        target.ready.reject(lifetime.signal.reason); target.release.reject(lifetime.signal.reason)
      }
    }, { once: true })
    server = await coordinator(recipients, request.fixture, request.nodePath, lifetime.signal)
    const modules = resolveNativeModules(request.repo)
    const connected: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['connect']>>[] = []
    for (const role of ['A', 'O', 'B', 'C'] as const) {
      const target = role === 'B' || role === 'C' ? recipients[role] : undefined
      const artifact = role === 'B' ? 'frontend/client.mjs' : 'qa/contract.test.mjs'
      const native = target === undefined ? undefined : { role, sessionId: target.sessionId, project: target.project,
        sessionRoot: join(temporary, `host-${role}`, 'sessions'), coordinatorUrl: server.url, coordinatorToken: server.tokens[role as Role],
        operationTimeoutMs: 30000, maxToolBytes: limit,
        readableFiles: role === 'B' ? ['frontend/client.mjs', 'qa/public.test.mjs'] : ['qa/contract.test.mjs', 'frontend/client.mjs'],
        writableFiles: role === 'B' ? ['frontend/client.mjs'] : ['qa/contract.test.mjs', 'qa/verdict.json'],
        goal: role === 'B' ? 'Read the existing client, update its API behavior when current authorized evidence is available, and run project tests.'
          : 'Read the existing tests, update their API assertions when current authorized evidence is available, and run project tests.',
        program: [{ name: 'evaluation_read', args: { path: artifact } },
          { name: 'evaluation_write', args: { path: artifact, text: role === 'B' ? request.fixture.correctClientSource : request.fixture.correctTestSource } },
          { name: 'evaluation_test', args: {} }],
      }
      const host = await launch(temporary, role, request, modules, native)
      hosts.push(host); cleanup.started++
      connected.push(await host.connect(lifetime.signal))
    }
    const [source, owner, frontend, qa] = connected
    if (source === undefined || owner === undefined || frontend === undefined || qa === undefined) throw new Error('four Hosts did not start')
    const peers = connected.map(host => host.identity.peerId)
    if (new Set(peers).size !== 4 || new Set(hosts.map(host => host.process.pid)).size !== 4) throw new Error('Hosts share identity')
    const address = owner.identity.addresses[0]
    if (address === undefined || !address.startsWith('/ip4/127.0.0.1/tcp/')) throw new Error('owner address is not explicit loopback')
    await owner.rpc('developmentRooms/announce', { request: { id: 'evaluation-human', kind: 'human', displayName: 'Evaluation owner' } })
    const created = z.object({ task: taskSchema }).loose().parse(await owner.rpc('developmentTasks/create', { request: {
      origin: { kind: 'root' }, objective: 'Integrate the order API', scope: 'Authorized API declarations', createdBy: 'evaluation-human',
    } }))
    const sourceHost = hosts[0]
    if (sourceHost === undefined) throw new Error('source Host missing')
    const sourceProject = join(sourceHost.directory, 'project')
    await mkdir(sourceProject, { mode: 0o700 })
    const file = join(sourceProject, 'openapi.json')
    const initial = request.fixture.timeline.find(item => item.kind === 'write')?.document
    if (initial === undefined || initial === null) throw new Error('source timeline has no initial document')
    await writeFile(file, initial)
    const setup = z.object({ settingsPath: z.string() }).loose().parse(
      await source.rpc('claudeScope/setup', { request: { projectPath: sourceProject } }))
    const settings = z.object({ hooks: z.record(z.string(),
      z.array(z.object({ hooks: z.array(z.object({ command: z.string() }).loose()) }).loose())) }).loose()
      .parse(JSON.parse(await readFile(setup.settingsPath, 'utf8')) as unknown)
    const hook = async (input: Record<string, unknown>) => {
      const eventName = String(input.hook_event_name)
      const command = settings.hooks[eventName]?.[0]?.hooks[0]?.command
      if (command === undefined) throw new Error(`installed hook missing: ${eventName}`)
      const executed = await runCommand('/bin/sh', ['-c', command], sourceProject, lifetime.signal, JSON.stringify(input))
      if (executed.code !== 0 || executed.stdout.trim().split('\n').length !== 1) throw new Error(`hook failed: ${executed.stderr}`)
      return JSON.parse(executed.stdout) as unknown
    }
    const sourceInput = { session_id: 'evaluation-source', cwd: sourceProject }
    await hook({ ...sourceInput, hook_event_name: 'SessionStart' })
    const summaries = z.array(sourceSessionSchema).parse(await source.rpc('claudeScope/sessions'))
    const session = summaries.find(item => item.sessionId === sourceInput.session_id)
    if (session === undefined) throw new Error('source Session not observed')
    const preparation = preparationSchema.parse(await source.rpc('claudeScope/prepareContribution', { request: {
      sessionKey: session.sessionKey, expectedCapture: null, roots: [sourceProject],
      source: { name: 'Orders', filePath: file, method: 'post', path: '/orders' },
    } }))
    const approval = z.object({ invitation: z.unknown() }).loose().parse(await owner.rpc('scopeAccess/approveContribution', { request: {
      taskId: created.task.id, ownerAddress: address, proposal: preparation.proposal,
      expiresAt: Date.now() + 600000, maxSamples: 32, maxSampleBytes: 8192,
    } }))
    await source.rpc('claudeScope/activateContribution', { request: { sessionKey: session.sessionKey,
      expectedCapture: { captureId: preparation.proposal.captureId, captureGeneration: preparation.proposal.captureGeneration },
      invitation: approval.invitation,
    } })
    for (const [receiver, responsibility] of [[frontend, 'frontend'], [qa, 'qa']] as const) {
      const status = z.object({ agentId: z.string() }).loose().parse(await receiver.native('status'))
      if (request.condition === 'R') {
        const invitation = await owner.rpc('scopeAccess/invite', { request: { taskId: created.task.id,
          ownerAddress: address, recipientPeerId: receiver.identity.peerId, expiresAt: Date.now() + 600000, responsibility } })
        await receiver.rpc('scopeAgentContext/bind', { request: { agentId: status.agentId, invitation, expectedBindingId: null, automatic: null } })
      }
      await receiver.native('start')
    }
    await Promise.all([recipients.B.ready.promise, recipients.C.ready.promise])
    let ownerRevision: number | null = null
    if (request.cancelAtBarrier === true) {
      for (const receiver of [frontend, qa]) {
        await receiver.native('cancel')
      }
    } else {
      for (const item of request.fixture.timeline) {
        if (item.kind !== 'write' || item.document === null) throw new Error('F1 requires ordinary writes only')
        const tool = { ...sourceInput, tool_name: 'Write', tool_use_id: randomUUID(), tool_input: { file_path: file, content: item.document } }
        await hook({ ...tool, hook_event_name: 'PreToolUse' })
        await writeFile(file, item.document)
        await hook({ ...tool, hook_event_name: 'PostToolUse' })
      }
      const current = taskSchema.parse(await owner.rpc('developmentTasks/get', { request: { taskId: created.task.id } }))
      ownerRevision = current.revision
      if (!JSON.stringify(current.context).includes(request.fixture.mappedFields.final)) throw new Error('owner did not commit source correction')
      const ownerHost = hosts[1]
      if (ownerHost === undefined) throw new Error('owner process missing')
      const sourceDb = new DatabaseSync(join(sourceHost.directory, 'state.sqlite'), { readOnly: true })
      const ownerDb = new DatabaseSync(join(ownerHost.directory, 'state.sqlite'), { readOnly: true })
      try {
        const values = (db: DatabaseSync, table: 'u_claude_scope_contribution_leases' | 'u_development_context_tasks_events') =>
          db.prepare(`SELECT value FROM ${table} ORDER BY key`).all().map(row => JSON.parse(z.string().parse(row.value)) as unknown)
        const leases = values(sourceDb, 'u_claude_scope_contribution_leases')
        const events = values(ownerDb, 'u_development_context_tasks_events')
        for (const value of leases) {
          const lease = z.object({ sample: z.object({ sourceId: z.string() }).loose(), receipt: z.object({
            sourceId: z.string(), ownerPeerId: z.literal(owner.identity.peerId), contributorPeerId: z.literal(source.identity.peerId),
            publicationId: z.string(), event: z.object({ nodeId: z.string(), seq: z.number(), kind: z.literal('context-published') }),
          }).loose() }).loose().parse(value)
          if (lease.sample.sourceId !== lease.receipt.sourceId || !events.some((event) => {
            const entry = z.object({ nodeId: z.string(), seq: z.number(),
              change: z.object({ kind: z.string(), publication: z.object({ id: z.string() }).loose().optional() }).loose(),
            }).loose().parse(event)
            return entry.nodeId === lease.receipt.event.nodeId && entry.seq === lease.receipt.event.seq
              && entry.change.kind === 'context-published' && entry.change.publication?.id === lease.receipt.publicationId
          })) throw new Error('source receipt does not match a durable owner event')
        }
        if (leases.length !== request.fixture.timeline.length) throw new Error('ordinary writes did not retain source receipts')
        await writeFile(join(request.output, 'contribution-ledger.json'), JSON.stringify({ leases, events }, null, 2) + '\n', { flag: 'wx' })
      } finally { sourceDb.close(); ownerDb.close() }
      await writeFile(join(request.output, 'owner-task.json'), JSON.stringify(current, null, 2) + '\n', { flag: 'wx' })
      recipients.B.release.resolve(undefined); recipients.C.release.resolve(undefined)
    }
    const observations = { B: observationSchema.parse(await frontend.native('finish')), C: observationSchema.parse(await qa.native('finish')) }
    const roles: Record<Role, { requests: number; scopeSources: number; pulses: number; publicTests: unknown }> = {
      B: { requests: 0, scopeSources: 0, pulses: 0, publicTests: null }, C: { requests: 0, scopeSources: 0, pulses: 0, publicTests: null } }
    for (const role of ['B', 'C'] as const) {
      const observation = observations[role]
      const sources = observation.events.flatMap(event => event.type === 'user/message'
        ? [sourceSchema.parse(z.object({ source: z.unknown() }).loose().parse(event.data).source)] : [])
      const snapshots = sources.filter(value => value.kind === 'scope-agent-context' && value.form === 'snapshot')
      roles[role] = { requests: observation.requests.length, scopeSources: snapshots.length,
        pulses: sources.filter(value => value.kind === 'scope-agent-pulse').length, publicTests: null }
      if (request.cancelAtBarrier !== true) {
        const tests = recipients[role].receipts.filter(value =>
          z.object({ operation: z.string() }).loose().parse(value).operation === 'evaluation_test')
        if (tests.length !== 1) throw new Error(`${role} did not execute one public test command`)
        roles[role].publicTests = z.object({ result: z.unknown() }).loose().parse(tests[0]).result
      }
      const expectedRequests = request.cancelAtBarrier === true ? 1 : 4
      if (roles[role].requests !== expectedRequests || roles[role].pulses !== 0) throw new Error(`${role} ran unexpected requests or pulses`)
      if (request.condition === 'N' && snapshots.length !== 0) throw new Error('N received scope context')
      if (request.condition === 'R' && request.cancelAtBarrier !== true) {
        const actualSources = observation.requests[1]?.messages.flatMap((message) => {
          const value = z.object({ source: sourceSchema.optional() }).loose().parse(message)
          return value.source === undefined ? [] : [value.source]
        }) ?? []
        if (!actualSources.some(value => value.kind === 'scope-agent-context' && value.projection?.taskRevision === ownerRevision)) {
          throw new Error(`${role} next request did not adopt owner watermark`)
        }
        if (!JSON.stringify(observation.requests[1]?.messages).includes(request.fixture.mappedFields.final)) throw new Error(`${role} next request missed current facts`)
      }
      await writeFile(join(request.output, `${role}-session.json`), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' })
      await cp(join(temporary, `host-${role}`, 'sessions'), join(request.output, `${role}-durable-sessions`), { recursive: true, errorOnExist: true })
      await writeFile(join(request.output, `${role}-tools.json`), JSON.stringify(recipients[role].receipts, null, 2) + '\n', { flag: 'wx' })
    }
    let artifacts: NativeRunResult['artifacts'] = null
    let oracle: GradeResult | null = null
    if (request.cancelAtBarrier !== true) {
      const clientSource = await readFile(join(recipients.B.project, 'frontend/client.mjs'), 'utf8')
      const testSource = await readFile(join(recipients.C.project, 'qa/contract.test.mjs'), 'utf8')
      assertControlledSources(request.fixture, clientSource, testSource)
      if (clientSource !== request.fixture.correctClientSource || testSource !== request.fixture.correctTestSource) throw new Error('controlled tools did not write registered golden bytes')
      await writeFile(join(request.output, 'client.mjs'), clientSource, { flag: 'wx' })
      await writeFile(join(request.output, 'contract.test.mjs'), testSource, { flag: 'wx' })
      artifacts = { clientSha256: hash(clientSource), testSha256: hash(testSource) }
      if (request.grade !== undefined) oracle = await request.grade(clientSource, testSource)
      lifetime.signal.throwIfAborted()
    }
    result = { kind: 'controlled-native-run', condition: request.condition, caseId: request.fixture.id, modelTrialsExecuted: 0,
      modelUsage: null, modelCost: null, cancelled: request.cancelAtBarrier === true, ownerRevision, peers, roles, artifacts, oracle }
  } catch (error) { failed = error } finally {
    clearTimeout(timer)
    lifetime.abort(new Error('native evaluation complete'))
    if (server !== undefined) await server.close().catch((error: unknown) => { failed ??= error })
    for (const host of hosts.reverse()) {
      try {
        const ended = await host.stop(); cleanup.closed++
        if (ended.signal === 'SIGKILL') cleanup.forced++
      } catch (error) { failed ??= error }
    }
    await rm(temporary, { recursive: true, force: true })
  }
  if (cleanup.closed !== cleanup.started || cleanup.forced !== 0) failed ??= new Error('native child cleanup did not settle normally')
  if (failed !== undefined || result === undefined) {
    await writeFile(join(request.output, 'failure.json'), JSON.stringify({ error: errorText(failed), cleanup }, null, 2) + '\n')
    throw failed instanceof Error ? failed : new Error('native evaluation produced no result', { cause: failed })
  }
  const final = { ...result, cleanup }
  await writeFile(join(request.output, 'result.json'), JSON.stringify(final, null, 2) + '\n', { flag: 'wx' })
  return final
}
