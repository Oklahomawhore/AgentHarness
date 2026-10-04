/** Executes only registry-reviewed offline fixtures; Node permissions here are not a malicious-code sandbox. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { assertControlledSources, type CaseFixture } from './fixtures.ts'
import { startDockerProgram, type DockerProgramHandle, type DockerProgramRequest, type DockerReceipt } from './docker-execution.ts'

const helpers = dirname(fileURLToPath(import.meta.url))
const wireLimit = 256 * 1024
const diagnosticLimit = 16 * 1024
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict()
const outcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: errorSchema }),
])
type Outcome = z.infer<typeof outcomeSchema>
const requestSchema = z.object({ method: z.literal('POST'), path: z.literal('/orders'), hasBody: z.boolean(), body: z.unknown() }).strict()
const reportSchema = z.object({ testCount: z.number().int().nonnegative(), passed: z.number().int().nonnegative(),
  assertionFailures: z.number().int().nonnegative(), invalidFailures: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(), todo: z.number().int().nonnegative(), errors: z.array(errorSchema),
}).strict()
type Report = z.infer<typeof reportSchema>

/** One real request received by the parent-owned service fixture. */
export interface ObservedRequest {
  readonly method: 'POST'
  readonly path: '/orders'
  readonly hasBody: boolean
  readonly body: unknown
  readonly bodyBytes: string | null
  readonly accepted: boolean
}

/** Node test execution classified separately from assertion-based mutant detection. */
export interface TestRun {
  readonly outcome: 'passed' | 'assertion-failed' | 'invalid' | 'timeout'
  readonly testCount: number
  readonly assertionFailures: number
  readonly operations: { readonly submit: number; readonly reset: number; readonly requests: number }
  readonly verdictValid: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly errors: readonly { readonly code: string; readonly message: string }[]
}

/** Controlled fixture evidence; none of these fields score a model trial. */
export interface GradeResult {
  readonly caseId: CaseFixture['id']
  readonly kind: 'controlled-oracle-check'
  readonly client: {
    readonly pass: boolean
    readonly executionValid: boolean
    readonly checks: readonly {
      readonly id: string
      readonly pass: boolean
      readonly observation: { readonly outcome: Outcome; readonly requests: readonly ObservedRequest[] }
    }[]
    readonly error: string | null
  }
  readonly tests: {
    readonly pass: boolean
    readonly correct: TestRun
    readonly mutants: readonly { readonly id: string; readonly killed: boolean; readonly run: TestRun }[]
  }
  readonly controlledPairPass: boolean
  readonly cleanup: { readonly childrenStarted: number; readonly childrenClosed: number }
  readonly execution: { readonly kind: 'controlled-node' } | { readonly kind: 'controlled-docker'; readonly receipts: readonly DockerReceipt[] }
}

/** A controlled run must use an original registered fixture and exact reviewed source bytes. */
export interface GradeRequest {
  readonly fixture: CaseFixture
  readonly clientSource: string
  readonly testSource: string
  readonly workRoot?: string
  readonly nodePath?: string
  readonly timeoutMs?: number
  readonly docker?: Omit<DockerProgramRequest, 'nodePath' | 'mode' | 'target' | 'runner' | 'root' | 'timeoutMs'>
}

class ExecutionFailure extends Error {
  constructor(readonly reason: 'invalid' | 'timeout', message: string) { super(message) }
}

interface RunOwner {
  started: number
  closed: number
  readonly children: Set<OwnedChild>
  readonly docker: GradeRequest['docker']
  readonly receipts: DockerReceipt[]
}

class OwnedChild {
  readonly child: ChildProcess
  readonly ready = Promise.withResolvers<undefined>()
  readonly report = Promise.withResolvers<Report>()
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  readonly pending = new Map<number, ReturnType<typeof Promise.withResolvers<Outcome>>>()
  readonly work = new Set<Promise<unknown>>()
  error: ExecutionFailure | undefined
  stderr = ''
  private nextId = 0
  private outputBytes = 0
  private didClose = false
  private disposal: Promise<undefined> | undefined
  private termination: Promise<void> | undefined

  static async create(nodePath: string, mode: 'client' | 'tests', target: string, runner: string, root: string,
    timeoutMs: number, owner: RunOwner, handler: (message: unknown) => Promise<undefined> | undefined): Promise<OwnedChild> {
    const docker = owner.docker === undefined ? undefined : await startDockerProgram({
      ...owner.docker, nodePath, mode, target, runner, root, timeoutMs,
    })
    const child = docker?.child ?? spawn(nodePath, ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${runner}`,
      ...(mode === 'tests' ? [`--allow-fs-write=${join(root, 'qa/verdict.json')}`] : []), runner, mode, target], {
      cwd: root, env: { LANG: 'C', TZ: 'UTC', ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const owned = new OwnedChild(child, timeoutMs, owner, handler, docker)
    docker?.start()
    return owned
  }

  private constructor(child: ChildProcess, timeoutMs: number, private readonly owner: RunOwner,
    handler: (message: unknown) => Promise<undefined> | undefined, private readonly docker: DockerProgramHandle | undefined) {
    this.child = child
    owner.started++
    owner.children.add(this)
    // Startup/report may fail before the caller reaches that await; retain the rejection for that caller.
    void this.ready.promise.catch(() => undefined)
    void this.report.promise.catch(() => undefined)
    const timer = setTimeout(() =>{  this.fail(new ExecutionFailure('timeout', 'controlled child deadline exceeded')) }, timeoutMs)
    this.closed = new Promise((resolveClose) => {
      this.child.once('error', (error) =>{  this.fail(new ExecutionFailure('invalid', error.message)) })
      this.child.once('close', (code, signal) => {
        this.didClose = true
        clearTimeout(timer)
        owner.closed++
        const error = this.error ?? new ExecutionFailure('invalid', `controlled child exited before completing an operation (code=${code}, signal=${signal}): ${this.stderr}`)
        this.ready.reject(error)
        this.report.reject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        resolveClose({ code, signal })
      })
    })
    this.child.stdout?.on('data', (chunk: Buffer) =>{  this.account(chunk) })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = Buffer.from(this.stderr + chunk.toString('utf8')).subarray(0, diagnosticLimit).toString('utf8')
      this.account(chunk)
    })
    this.child.on('message', (message) => {
      try {
        if (Buffer.byteLength(JSON.stringify(message), 'utf8') > wireLimit) throw new Error('controlled message exceeded byte limit')
        const tag = z.object({ kind: z.string() }).loose().parse(message).kind
        if (tag === 'ready') this.ready.resolve(undefined)
        else if (tag === 'startup-error') {
          const parsed = z.object({ kind: z.literal('startup-error'), error: errorSchema }).strict().parse(message)
          this.fail(new ExecutionFailure('invalid', parsed.error.message))
        } else if (tag === 'result') {
          const parsed = z.object({ kind: z.literal('result'), id: z.number().int().positive() }).loose().parse(message)
          const pending = this.pending.get(parsed.id)
          if (!pending) throw new Error('unexpected controlled call result')
          this.pending.delete(parsed.id)
          pending.resolve(outcomeSchema.parse(message))
        } else if (tag === 'report') {
          const parsed = z.object({ kind: z.literal('report'), value: reportSchema }).strict().parse(message)
          this.report.resolve(parsed.value)
        } else {
          const work = handler(message)
          if (work) {
            this.work.add(work)
            void work.catch((error: unknown) =>{  this.fail(new ExecutionFailure('invalid', String(error))) }).finally(() => this.work.delete(work))
          }
        }
      } catch (error) { this.fail(new ExecutionFailure('invalid', String(error))) }
    })
  }

  private account(chunk: Buffer): void {
    this.outputBytes += chunk.byteLength
    if (this.outputBytes > wireLimit) this.fail(new ExecutionFailure('invalid', 'controlled diagnostic output exceeded byte limit'))
  }

  fail(error: ExecutionFailure): void {
    this.error ??= error
    this.ready.reject(error)
    this.report.reject(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.terminate()
  }

  private terminate(): void {
    if (this.didClose) return
    if (this.docker === undefined) { this.child.kill('SIGKILL'); return }
    this.termination ??= this.docker.terminate()
    // Disposal awaits and reports this cleanup result; cancellation can precede that await.
    void this.termination.catch(() => { if (!this.didClose) this.child.kill('SIGKILL') })
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (!this.child.connected) return
    const bytes = JSON.stringify(message)
    if (Buffer.byteLength(bytes, 'utf8') > wireLimit) { this.fail(new ExecutionFailure('invalid', 'controlled input exceeded byte limit')); return }
    this.child.send(message, (error) => { if (error) this.fail(new ExecutionFailure('invalid', error.message)) })
  }

  async submit(payload: unknown): Promise<Outcome> {
    await this.ready.promise
    if (this.error) throw this.error
    if (this.didClose || !this.child.connected) throw new ExecutionFailure('invalid', 'controlled child is no longer connected')
    const id = ++this.nextId
    const pending = Promise.withResolvers<Outcome>()
    this.pending.set(id, pending)
    this.send({ kind: 'call', id, payload })
    return pending.promise
  }

  dispose(): Promise<undefined> {
    return this.disposal ??= this.close()
  }

  private async close(): Promise<undefined> {
    if (!this.didClose) this.send({ kind: 'stop' })
    const timer = setTimeout(() => { this.terminate() }, 1000)
    try { await this.closed } finally { clearTimeout(timer) }
    await Promise.allSettled(this.work)
    if (this.docker !== undefined) this.owner.receipts.push(await this.docker.dispose())
    await this.termination
    return undefined
  }
}

function candidateService(fixture: CaseFixture, value: unknown, requests: ObservedRequest[]): Outcome {
  const request = requestSchema.parse(value)
  const body = request.body
  const accepted = request.hasBody
    ? body !== null && typeof body === 'object' && !Array.isArray(body) && fixture.requiredFields.every(key => Object.hasOwn(body, key))
    : !fixture.bodyRequired
  requests.push({ ...request, body: request.body, bodyBytes: request.hasBody ? JSON.stringify(body) : null, accepted })
  return accepted ? { ok: true, value: { accepted: true } }
    : { ok: false, error: { code: 'SERVICE_REJECTED', message: 'candidate service rejected request' } }
}

async function files(root: string, clientSource: string, testSource?: string): Promise<{ client: string; tests: string }> {
  const clientPath = join(root, 'frontend/client.mjs')
  const testsPath = join(root, 'qa/contract.test.mjs')
  await mkdir(join(root, 'frontend'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'qa'), { recursive: true, mode: 0o700 })
  await writeFile(clientPath, clientSource, { mode: 0o600, flag: 'wx' })
  if (testSource !== undefined) await writeFile(testsPath, testSource, { mode: 0o600, flag: 'wx' })
  return { client: clientPath, tests: testsPath }
}

async function startClient(root: string, source: string, fixture: CaseFixture, requests: ObservedRequest[], owner: RunOwner,
  nodePath: string, timeoutMs: number, runner: string): Promise<OwnedChild> {
  const paths = await files(root, source)
  await copyFile(join(helpers, 'transport.mjs'), join(root, 'frontend/transport.mjs'))
  const child = await OwnedChild.create(nodePath, 'client', paths.client, runner, root, timeoutMs, owner, (message) => {
    const parsed = z.object({ kind: z.literal('transport'), id: z.number().int().positive(), value: requestSchema }).strict().parse(message)
    child.send({ kind: 'transport-result', id: parsed.id, ...candidateService(fixture, parsed.value, requests) })
    return undefined
  })
  await child.ready.promise
  return child
}

async function gradeClient(request: GradeRequest, root: string, owner: RunOwner, nodePath: string, timeoutMs: number, runner: string): Promise<GradeResult['client']> {
  const checks: GradeResult['client']['checks'][number][] = []
  const requests: ObservedRequest[] = []
  try {
    const child = await startClient(root, request.clientSource, request.fixture, requests, owner, nodePath, timeoutMs, runner)
    try {
      for (const check of request.fixture.checks) {
        requests.length = 0
        const outcome = await child.submit(check.payload)
        const valid = outcome.ok || ['CONTRACT_INVALID_PAYLOAD', 'CONTRACT_UNRESOLVED', 'CONTRACT_UNAVAILABLE', 'SERVICE_REJECTED'].includes(outcome.error.code)
        if (!valid) throw new ExecutionFailure('invalid', outcome.error.message)
        const actualRequest = requests[0]
        const pass = check.expectedError === null
          ? outcome.ok && isDeepStrictEqual(outcome.value, { accepted: true }) && requests.length === 1 && actualRequest?.accepted === true
            && actualRequest.hasBody === (check.payload !== undefined) && isDeepStrictEqual(actualRequest.body, check.payload ?? null)
          : !outcome.ok && outcome.error.code === check.expectedError && requests.length === 0
        checks.push({ id: check.id, pass, observation: { outcome, requests: [...requests] } })
      }
      return { pass: checks.every(check => check.pass), executionValid: true, checks, error: null }
    } finally { await child.dispose() }
  } catch (error) {
    return { pass: false, executionValid: false, checks, error: error instanceof Error ? error.message : String(error) }
  }
}

async function gradeTests(fixture: CaseFixture, clientSource: string, testSource: string, root: string, owner: RunOwner,
  nodePath: string, timeoutMs: number, runner: string): Promise<TestRun> {
  const requests: ObservedRequest[] = []
  const operations = { submit: 0, reset: 0, requests: 0 }
  let testChild: OwnedChild | undefined
  let clientChild: OwnedChild | undefined
  let report: Report | undefined
  let failure: unknown
  const testRoot = join(root, 'test')
  try {
    clientChild = await startClient(join(root, 'client'), clientSource, fixture, requests, owner, nodePath, timeoutMs, runner)
    const client = clientChild
    const facade = await readFile(join(helpers, 'client-facade.mjs'), 'utf8')
    const paths = await files(testRoot, facade, testSource)
    testChild = await OwnedChild.create(nodePath, 'tests', paths.tests, runner, testRoot, timeoutMs, owner, async (message) => {
      const parsed = z.object({ kind: z.literal('operation'), id: z.number().int().positive(),
        method: z.enum(['submit', 'reset', 'requests']), payload: z.unknown().optional() }).strict().parse(message)
      operations[parsed.method]++
      let outcome: Outcome
      if (parsed.method === 'submit') outcome = await client.submit(parsed.payload)
      else if (parsed.method === 'reset') { requests.length = 0; outcome = { ok: true, value: null } }
      else outcome = { ok: true, value: requests.map(({ method, path, hasBody, body }) => ({ method, path, hasBody, body })) }
      testChild?.send({ kind: 'operation-result', id: parsed.id, ...outcome })
      return undefined
    })
    report = await testChild.report.promise
    await testChild.closed
  } catch (error) { failure = error }
  finally {
    await testChild?.dispose()
    await clientChild?.dispose()
  }
  let verdictValid = fixture.expectedVerdict === null
  if (fixture.expectedVerdict !== null && report !== undefined) {
    try { verdictValid = isDeepStrictEqual(JSON.parse(await readFile(join(testRoot, 'qa/verdict.json'), 'utf8')), fixture.expectedVerdict) }
    catch { verdictValid = false } // Missing or invalid candidate verdict is an unsuccessful artifact, never an oracle default.
  }
  const exit = await testChild?.closed
  const executionError = failure ?? testChild?.error ?? clientChild?.error
  const outcome: TestRun['outcome'] = executionError instanceof ExecutionFailure && executionError.reason === 'timeout' ? 'timeout'
    : executionError !== undefined || report === undefined || report.testCount === 0 || report.skipped > 0 || report.todo > 0
      || report.invalidFailures > 0 || exit?.signal !== null ? 'invalid'
      : report.assertionFailures > 0 && exit.code === 1 ? 'assertion-failed'
        : report.assertionFailures === 0 && exit.code === 0 && verdictValid ? 'passed' : 'invalid'
  return { outcome, testCount: report?.testCount ?? 0, assertionFailures: report?.assertionFailures ?? 0, operations,
    verdictValid, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, stderr: testChild?.stderr ?? clientChild?.stderr ?? '',
    errors: report?.errors ?? [{ code: 'EXECUTION_ERROR',
      message: executionError instanceof Error ? executionError.message
        : typeof executionError === 'string' ? executionError : 'Controlled execution did not produce a report' }] }
}

/** Run B behavior checks and independently execute C against a trusted client and every required mutant.
 * @param request Registered controlled sources, scratch location, per-child deadline, and optional explicit Docker execution limits.
 * @returns Observed behavior and mutation evidence after all owned children have exited and scratch files are removed.
 */
export async function grade(request: GradeRequest): Promise<GradeResult> {
  assertControlledSources(request.fixture, request.clientSource, request.testSource)
  const timeoutMs = request.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) throw new Error('invalid controlled child timeout')
  const nodePath = request.nodePath ?? process.execPath
  const parent = await realpath(resolve(request.workRoot ?? tmpdir()))
  const root = await mkdtemp(join(parent, 'scope-oracle-'))
  const owner: RunOwner = { started: 0, closed: 0, children: new Set(), docker: request.docker, receipts: [] }
  try {
    const runner = join(root, 'runner.mjs')
    await copyFile(join(helpers, 'runner.mjs'), runner)
    await mkdir(join(root, 'private'), { mode: 0o700 })
    await writeFile(join(root, 'private/oracle.json'), '{"private":"must-not-be-readable-by-QA"}\n', { mode: 0o600 })
    const client = await gradeClient(request, join(root, 'behavior'), owner, nodePath, timeoutMs, runner)
    const correct = await gradeTests(request.fixture, request.fixture.correctClientSource, request.testSource, await mkdtemp(join(root, 'run-')), owner, nodePath, timeoutMs, runner)
    const mutants: GradeResult['tests']['mutants'][number][] = []
    for (const mutant of request.fixture.mutants) {
      const run = await gradeTests(request.fixture, mutant.clientSource, request.testSource, await mkdtemp(join(root, 'run-')), owner, nodePath, timeoutMs, runner)
      mutants.push({ id: mutant.id, killed: run.outcome === 'assertion-failed' && run.operations.submit > 0, run })
    }
    const tests = { pass: correct.outcome === 'passed' && mutants.every(mutant => mutant.killed), correct, mutants }
    await Promise.all([...owner.children].map(child => child.dispose()))
    return { caseId: request.fixture.id, kind: 'controlled-oracle-check', client, tests, controlledPairPass: client.pass && tests.pass,
      cleanup: { childrenStarted: owner.started, childrenClosed: owner.closed },
      execution: request.docker === undefined ? { kind: 'controlled-node' } : { kind: 'controlled-docker', receipts: owner.receipts } }
  } finally {
    await Promise.all([...owner.children].map(child => child.dispose()))
    await rm(root, { recursive: true, force: true })
  }
}
