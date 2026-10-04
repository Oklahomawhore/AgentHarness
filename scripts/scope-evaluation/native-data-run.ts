/** Real native source tools and ordinary HTTP-provider Agents working on bounded JSON artifacts. */
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { launchNativeHost } from './native-run.ts'
import { resolveNativeModules } from './native-dependencies.ts'
import { createWorkbench, type Workbench } from './workbench.ts'
import { executePayment, parseCases, parsePolicy, sealDataArtifact, type SealedDataArtifact, type DataArtifactGrades } from './data-artifacts.ts'
import type { DataModelRoute, DataRoleProject, NativeDataStudy } from './data-study.ts'

/** Explicit execution provenance; calibration still exercises the production HTTP adapter. */
export interface NativeDataRunRequest {
  readonly repo: string
  readonly nodePath: string
  readonly output: string
  readonly condition: 'N' | 'E' | 'R'
  readonly study: NativeDataStudy
  readonly execution: { readonly kind: 'live' | 'transport-calibration' }
  readonly signal?: AbortSignal
  readonly grade?: (artifacts: {
    readonly policy: SealedDataArtifact | null
    readonly cases: SealedDataArtifact | null
  }) => DataArtifactGrades | Promise<DataArtifactGrades>
}
/** Independent observations of one ordinary Session; a completed turn is not an artifact score. */
export interface NativeDataRoleResult {
  readonly requests: number
  readonly turnReason: unknown
  readonly scopeSnapshots: number
  readonly adoptedWatermark: boolean
  readonly durable: unknown
  readonly publicChecks: readonly unknown[]
  readonly skipped: boolean
  readonly completed: boolean
}
/** Native execution and sealed artifacts, with explicit partial failure and subsequent-dispatch policy. */
export interface NativeDataRunResult {
  readonly kind: 'native-data-run'
  readonly condition: 'N' | 'E' | 'R'
  readonly execution: NativeDataRunRequest['execution']
  readonly failed: boolean
  readonly error: string | null
  readonly dispatchBlocked: boolean
  readonly realModelDispatches: number
  readonly counts: { readonly ordinary: number; readonly semantic: number; readonly sourceControlled: number }
  readonly modelCounterMeaning: string
  readonly ownerRevision: number | null
  readonly peers: readonly string[]
  readonly roles: Readonly<Partial<Record<'B' | 'C', NativeDataRoleResult>>>
  readonly artifacts: { readonly policy: SealedDataArtifact | null; readonly cases: SealedDataArtifact | null }
  readonly grade: unknown
  readonly cleanup: { readonly started: number; readonly closed: number; readonly forced: number }
}

const usageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }).loose()
const observationSchema = z.object({ agentId: z.string(),
  requests: z.array(z.object({ messages: z.array(z.unknown()), eventCount: z.number() }).loose()),
  events: z.array(z.object({ seq: z.number(), type: z.string(), data: z.unknown() })), durable: z.unknown(),
  turnReason: z.unknown(), flushed: z.literal(true), modelUsage: z.unknown() }).loose()
const captureSchema = z.object({ capture: z.object({ selection: z.unknown(), proposal: z.unknown(), collecting: z.boolean(),
  pendingSamples: z.number(), state: z.string() }).loose().nullable() }).loose()
const taskSchema = z.object({ id: z.string(), revision: z.number(), context: z.array(z.unknown()) }).loose()
const projectionMessageSchema = z.object({ source: z.object({ kind: z.string(), form: z.string().optional(),
  projection: z.object({ taskRevision: z.number(), backend: z.object({ id: z.string() }).loose() }).loose().optional() }).loose() }).loose()
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('evaluation_read'), path: z.string() }),
  z.object({ operation: z.literal('evaluation_write'), path: z.string(), text: z.string() }),
  z.object({ operation: z.literal('evaluation_test') }),
  z.object({ operation: z.literal('model-reserve'), request: z.unknown(), evidence: z.unknown() }),
  z.object({ operation: z.literal('model-settle'), reservation: z.string(), usage: z.unknown(), finish: z.unknown(),
    outputBytes: z.number(), responseObserved: z.boolean() }),
])
interface Recipient { readonly project: string; readonly workbench: Workbench; readonly spec: DataRoleProject; readonly checks: unknown[] }
interface Reservation {
  readonly id: string
  readonly role: 'B' | 'C' | 'O'
  readonly request: unknown
  readonly evidence: unknown
  result: unknown
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
async function save(directory: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const bytes of request) {
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    size += chunk.length
    if (size > 1048576) throw new Error('private coordinator request exceeds byte bound')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
}
async function project(root: string, role: 'B' | 'C', study: NativeDataStudy): Promise<Recipient> {
  const directory = join(root, `project-${role}`)
  await mkdir(directory, { mode: 0o700 })
  const spec = study.roles[role]
  // The same bounded path parser validates even the trusted frozen initial file list.
  const seed = await createWorkbench({ root: directory, readableFiles: Object.keys(spec.initialFiles),
    writableFiles: Object.keys(spec.initialFiles), maxReadBytes: study.limits.maxArtifactBytes,
    maxWriteBytes: study.limits.maxArtifactBytes })
  for (const [path, text] of Object.entries(spec.initialFiles)) {
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 })
    await seed.write(path, text, new AbortController().signal)
  }
  return { project: directory, spec, checks: [], workbench: await createWorkbench({ root: directory,
    readableFiles: spec.readableFiles, writableFiles: spec.writableFiles,
    maxReadBytes: study.limits.maxArtifactBytes, maxWriteBytes: study.limits.maxArtifactBytes }) }
}
async function publicCheck(target: Recipient, signal: AbortSignal): Promise<unknown> {
  try {
    const policy = parsePolicy(sealDataArtifact((await target.workbench.read(target.spec.publicPolicyPath, signal)).text))
    const cases = parseCases(sealDataArtifact((await target.workbench.read(target.spec.publicCasesPath, signal)).text))
    return { kind: 'public-data-diagnostics', hiddenOracleUsed: false,
      cases: cases.cases.map(item => ({ id: item.id, passed: isDeepStrictEqual(executePayment(policy, item.input), item.expected),
        actual: executePayment(policy, item.input), expected: item.expected })) }
  } catch (error) { return { kind: 'public-data-diagnostics', hiddenOracleUsed: false, invalid: errorText(error).slice(0, 2048) } }
}
async function coordinator(output: string, recipients: Record<'B' | 'C', Recipient>, study: NativeDataStudy, signal: AbortSignal) {
  const tokens = { B: randomUUID(), C: randomUUID(), O: randomUUID() }
  const reservations: Reservation[] = []; const pending = new Set<Promise<void>>()
  let blocked = false
  let watermark: { taskId: string; revision: number; condition: NativeDataRunRequest['condition'] } | undefined
  const server = createServer((request, response) => {
    const operation = (async () => {
      if (request.method !== 'POST' || request.url !== '/tool') { respond(response, 403, {}); return }
      const body = z.object({ role: z.enum(['B', 'C', 'O']), sessionId: z.string() }).loose().parse(await readBody(request))
      if (request.headers.authorization !== `Bearer ${tokens[body.role]}` || body.sessionId !== `data-${body.role}`) {
        respond(response, 403, {}); return
      }
      signal.throwIfAborted()
      const input = commandSchema.parse(body)
      let result: unknown
      if (input.operation === 'model-reserve') {
        if (blocked || reservations.some(item => item.result === null)) throw new Error('previous model accounting is incomplete')
        const route = body.role === 'O' ? study.semantic : study.ordinary
        if (reservations.filter(item => item.role === body.role).length >= route.maxCalls) throw new Error('model call limit reached')
        const actual = z.object({ provider: z.literal(route.provider), model: z.literal(route.model),
          maxTokens: z.literal(route.maxOutputTokens), purpose: z.literal(body.role === 'O' ? 'context-summary' : 'ordinary') }).loose().parse(input.request)
        if (Buffer.byteLength(JSON.stringify(actual)) > route.maxInputBytes) throw new Error('model input limit reached')
        if (body.role !== 'O') {
          const expected = watermark
          if (expected === undefined) throw new Error('source receipt watermark is not ready')
          const messages = z.object({ messages: z.array(z.unknown()) }).loose().parse(input.request).messages
          const snapshots = messages.flatMap((message) => {
            const parsed = projectionMessageSchema.safeParse(message)
            return parsed.success && parsed.data.source.kind === 'scope-agent-context' && parsed.data.source.form === 'snapshot'
              ? [parsed.data.source] : []
          })
          if (expected.condition === 'N' ? snapshots.length !== 0 : !snapshots.some(({ projection }) => projection !== undefined
            && projection.taskRevision === expected.revision
            && projection.backend.id === (expected.condition === 'R' ? 'semantic' : 'text')
            && z.object({ taskId: z.string() }).loose().parse(projection).taskId === expected.taskId)) {
            throw new Error('ordinary dispatch lacks the frozen treatment context')
          }
        }
        const reservation: Reservation = { id: randomUUID(), role: body.role,
          request: input.request, evidence: input.evidence, result: null }
        reservations.push(reservation)
        try { await save(output, `dispatch-${reservations.length}.json`, reservation) } catch (error) { blocked = true; throw error }
        result = { reservation: reservation.id }
      } else if (input.operation === 'model-settle') {
        const reservation = reservations.find(item => item.id === input.reservation && item.role === body.role)
        if (reservation === undefined || reservation.result !== null) throw new Error('unknown or settled model reservation')
        const usage = usageSchema.safeParse(input.usage)
        if (!usage.success || usage.data.outputTokens > (body.role === 'O' ? study.semantic : study.ordinary).maxOutputTokens) blocked = true
        reservation.result = input
        try { await save(output, `settled-${reservations.indexOf(reservation) + 1}.json`, input) } catch (error) { blocked = true; throw error }
        result = { settled: true }
      } else {
        if (body.role === 'O') throw new Error('owner has no project tools')
        const target = recipients[body.role]
        const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(study.limits.operationTimeoutMs)])
        if (input.operation === 'evaluation_read') result = await target.workbench.read(input.path, operationSignal)
        else if (input.operation === 'evaluation_write') result = await target.workbench.write(input.path, input.text, operationSignal)
        else { result = await publicCheck(target, operationSignal); target.checks.push(result) }
      }
      respond(response, 200, result)
    })().catch((error: unknown) => { if (!response.destroyed) respond(response, 400, { error: errorText(error).slice(0, 2048) }) })
      .finally(() => pending.delete(operation))
    pending.add(operation)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('private coordinator has no address')
  return { url: `http://127.0.0.1:${address.port}/tool`, tokens, reservations,
    setWatermark(value: NonNullable<typeof watermark>) { watermark = value },
    blocked: () => blocked || reservations.some(item => item.result === null), async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
      await Promise.allSettled(pending)
    } }
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  for (;;) { signal.throwIfAborted(); const value = await read(); if (ready(value)) return value; await delay(25, undefined, { signal }) }
}
function environment(route: DataModelRoute, execution: NativeDataRunRequest['execution']): NodeJS.ProcessEnv {
  if (execution.kind === 'transport-calibration') return { [route.apiKeyEnv]: 'transport-calibration-not-a-secret' }
  if (route.credentialsPath !== null) return {}
  const value = process.env[route.apiKeyEnv]
  return value === undefined ? {} : { [route.apiKeyEnv]: value }
}
function sqliteRows(path: string, table: 'u_scope_agent_contributions_sessions' | 'u_development_context_tasks_events'): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(`SELECT value FROM ${table} ORDER BY key`).all().map(row => JSON.parse(z.string().parse(row.value)) as unknown) }
  finally { db.close() }
}

/** Execute one post-update N/E/R wave through four named dsh Hosts; never execute generated artifact code.
 * @param request Frozen public projects, explicit model routes, and optional parent-only sealed-artifact grading.
 * @returns Actual requests, durable source admission, independent artifacts, and awaited cleanup, including failed trials.
 */
export async function runNativeData(request: NativeDataRunRequest): Promise<NativeDataRunResult> {
  await mkdir(request.output, { recursive: false, mode: 0o700 })
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'scope-native-data-')))
  const lifetime = new AbortController()
  const cancelled = () => { lifetime.abort(request.signal?.reason ?? new Error('data study cancelled')) }
  request.signal?.addEventListener('abort', cancelled, { once: true })
  if (request.signal?.aborted === true) cancelled()
  const timer = setTimeout(() => { lifetime.abort(new Error('data run wall deadline exceeded')) }, request.study.limits.wallTimeoutMs)
  const hosts: Awaited<ReturnType<typeof launchNativeHost>>[] = []
  const cleanup = { started: 0, closed: 0, forced: 0 }
  let server: Awaited<ReturnType<typeof coordinator>> | undefined
  let failure: unknown; let ownerRevision: number | null = null; let sourceControlled = 0
  const peers: string[] = []; const roles: Partial<Record<'B' | 'C', NativeDataRoleResult>> = {}
  const artifacts: { policy: SealedDataArtifact | null; cases: SealedDataArtifact | null } = { policy: null, cases: null }
  let grade: unknown = null
  try {
    lifetime.signal.throwIfAborted()
    const study = request.study
    const recipients = { B: await project(temporary, 'B', study), C: await project(temporary, 'C', study) }
    server = await coordinator(request.output, recipients, study, lifetime.signal)
    const modules = resolveNativeModules(request.repo)
    const connections: Awaited<ReturnType<Awaited<ReturnType<typeof launchNativeHost>>['connect']>>[] = []
    const sourceProject = join(temporary, 'source-project')
    await mkdir(sourceProject, { mode: 0o700 })
    for (const role of ['A', 'O', 'B', 'C'] as const) {
      const route = role === 'O' ? study.semantic : study.ordinary
      const target = role === 'B' || role === 'C' ? recipients[role] : undefined
      const shared = { role, sessionId: `data-${role}`, project: target?.project ?? sourceProject,
        sessionRoot: join(temporary, `host-${role}`, 'sessions'), coordinatorUrl: server.url,
        coordinatorToken: role === 'A' ? '' : server.tokens[role], route, contextBytes: study.limits.contextBytes,
        operationTimeoutMs: study.limits.operationTimeoutMs, maxToolBytes: 262144 }
      const native = role === 'O' ? undefined : role === 'A' ? { ...shared, mode: 'data-source',
        goal: 'Apply the scripted local policy write and correction, and record the failed edit without claiming success.',
        program: [
          { name: 'read', args: { file_path: study.source.path } },
          { name: 'write', args: { file_path: study.source.path, content: study.source.initialContent } },
          { name: 'read', args: { file_path: study.source.path } },
          { name: 'edit', args: { file_path: study.source.path, old_string: study.source.correction.oldString, new_string: study.source.correction.newString } },
          { name: 'read', args: { file_path: study.source.path } },
          { name: 'edit', args: { file_path: study.source.path, old_string: study.source.failedEdit.oldString, new_string: study.source.failedEdit.newString } },
        ] } : { ...shared, mode: 'data-recipient', ...target?.spec }
      const host = await launchNativeHost(temporary, role, { ...request, cleanupTimeoutMs: study.limits.cleanupTimeoutMs,
        environment: role === 'A' || role === 'O' && request.condition !== 'R' ? {} : environment(route, request.execution) }, modules, native,
      { ...shared, condition: request.condition, peerTimeoutMs: study.semantic.timeoutMs + study.limits.operationTimeoutMs })
      hosts.push(host); cleanup.started++
      connections.push(await host.connect(lifetime.signal))
    }
    const [source, owner, frontend, qa] = connections
    const [sourceHost, ownerHost] = hosts
    if (!source || !owner || !frontend || !qa || !sourceHost || !ownerHost) throw new Error('four independent Hosts required')
    peers.push(...connections.map(item => item.identity.peerId))
    if (new Set(peers).size !== 4 || new Set(hosts.map(host => host.process.pid)).size !== 4) throw new Error('Host identities overlap')
    const address = owner.identity.addresses[0]
    if (address === undefined) throw new Error('owner address missing')
    await owner.rpc('developmentRooms/announce', { request: { id: 'data-owner', kind: 'human', displayName: 'Data study owner' } })
    const created = z.object({ task: taskSchema }).loose().parse(await owner.rpc('developmentTasks/create', { request: {
      origin: { kind: 'root' }, objective: 'Maintain payment client configuration and independent QA acceptance cases.',
      scope: 'Authorized native policy file work reports.', createdBy: 'data-owner' } }))
    const entry = z.object({ entry: z.object({ entryId: z.string() }).loose() }).loose().parse(
      await owner.rpc('scopeAccess/createContributionEntry', { request: { taskId: created.task.id, sourceKind: 'tool-observations',
        ownerAddress: address, expiresAt: Date.now() + study.limits.wallTimeoutMs } }))
    const sourceId = z.object({ agentId: z.string() }).loose().parse(await source.native('status')).agentId
    const limits = { expiresAt: Date.now() + study.limits.wallTimeoutMs, maxSamples: 3, maxSampleBytes: 16384 }
    const requested = captureSchema.parse(await source.rpc('scopeAgentContributions/request', { request: {
      agentId: sourceId, expectedCapture: null, entry: entry.entry, roots: [sourceProject], tools: ['write', 'edit'], limits } }))
    if (requested.capture === null) throw new Error('source consent missing')
    await until(() => owner.rpc('scopeAccess/contributionApplications', { request: { taskId: created.task.id } }),
      value => JSON.stringify(value).includes('"status":"pending"'), lifetime.signal)
    await owner.rpc('scopeAccess/approveContributionApplication', { request: { entryId: entry.entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress: address } })
    await until(async () => captureSchema.parse(await source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } })),
      value => value.capture?.collecting === true, lifetime.signal)
    await source.native('start')
    const sourceObservation = observationSchema.parse(await source.native('finish'))
    sourceControlled = sourceObservation.requests.length
    const current = await until(async () => taskSchema.parse(await owner.rpc('developmentTasks/get', { request: { taskId: created.task.id } })),
      value => value.context.length === 3, lifetime.signal)
    ownerRevision = current.revision
    await until(async () => captureSchema.parse(await source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } })),
      value => value.capture?.pendingSamples === 0, lifetime.signal)
    const sourceTasks = z.array(taskSchema).parse(await source.rpc('developmentTasks/list', { request: { limit: 1 } }))
    if (sourceTasks.length !== 0) throw new Error('source received a Task replica')
    const reports = current.context.map(value => z.object({ peerToolObservation:
      z.object({ tool: z.string(), reportedStatus: z.string() }).loose() }).loose().parse(value).peerToolObservation)
    if (!isDeepStrictEqual(reports.map(item => [item.tool, item.reportedStatus]), [['Write', 'success'], ['Edit', 'success'], ['Edit', 'failure']])) {
      throw new Error('source trajectory is not Write success, Edit success, Edit failure')
    }
    if (await readFile(join(sourceProject, study.source.path), 'utf8') !== study.source.expectedContent) throw new Error('actual source file differs')
    const sourceRows = sqliteRows(join(sourceHost.directory, 'state.sqlite'), 'u_scope_agent_contributions_sessions')
    const ownerEvents = sqliteRows(join(ownerHost.directory, 'state.sqlite'), 'u_development_context_tasks_events')
    const samples = sourceRows.flatMap(value => z.object({ samples: z.array(z.object({ callSeq: z.number(), resultSeq: z.number(),
      sample: z.object({ sourceId: z.string() }).loose(), receipt: z.object({
        sourceId: z.string(), ownerPeerId: z.literal(owner.identity.peerId),
        contributorPeerId: z.literal(source.identity.peerId), publicationId: z.string(),
        event: z.object({ nodeId: z.string(), seq: z.number(), kind: z.literal('context-published') }) }).loose() }).loose()),
    }).loose().parse(value).samples)
    if (samples.length !== 3) throw new Error('three durable source receipts required')
    for (const item of samples) {
      if (item.sample.sourceId !== item.receipt.sourceId || !sourceObservation.events.some(event => event.seq === item.callSeq && event.type === 'tool/call')
        || !sourceObservation.events.some(event => event.seq === item.resultSeq && event.type === 'tool/result')
        || !ownerEvents.some((value) => {
          const event = z.object({ nodeId: z.string(), seq: z.number(), change: z.object({ kind: z.string(),
            publication: z.object({ id: z.string() }).loose().optional() }).loose() }).loose().parse(value)
          return event.nodeId === item.receipt.event.nodeId && event.seq === item.receipt.event.seq
            && event.change.kind === 'context-published' && event.change.publication?.id === item.receipt.publicationId
        })) throw new Error('source settlement/receipt does not match durable owner event')
    }
    server.setWatermark({ taskId: current.id, revision: current.revision, condition: request.condition })
    await save(request.output, 'source-admission.json', { sourceRows, ownerEvents, task: current, reports, sourceTaskReplicas: sourceTasks.length })
    await save(request.output, 'A-session.json', sourceObservation)
    await cp(join(sourceHost.directory, 'sessions'), join(request.output, 'A-durable-sessions'), { recursive: true })
    for (const [role, receiver] of [['B', frontend], ['C', qa]] as const) {
      if (server.blocked() || Object.values(roles).some(value => !value.completed)) {
        roles[role] = { requests: 0, turnReason: null, scopeSnapshots: 0, adoptedWatermark: false,
          durable: null, publicChecks: [], skipped: true, completed: false }; continue
      }
      const status = z.object({ agentId: z.string() }).loose().parse(await receiver.native('status'))
      if (request.condition !== 'N') {
        const invitation = await owner.rpc('scopeAccess/invite', { request: { taskId: current.id, ownerAddress: address,
          recipientPeerId: receiver.identity.peerId, expiresAt: Date.now() + study.limits.wallTimeoutMs,
          responsibility: role === 'B' ? 'Maintain payment client configuration; preserve exact retry limits and failure semantics.'
            : 'Maintain independent QA acceptance cases; cover corrections, validation, retry limits, and failed tool attempts.' } })
        await receiver.rpc('scopeAgentContext/bind', { request: { agentId: status.agentId, expectedBindingId: null, invitation, automatic: null } })
      }
      await receiver.native('start')
      const observation = observationSchema.parse(await receiver.native('finish'))
      const snapshots = observation.requests.flatMap(item => item.messages.map(message => projectionMessageSchema.safeParse(message))
        .flatMap(value => value.success && value.data.source.kind === 'scope-agent-context' && value.data.source.form === 'snapshot' ? [value.data.source] : []))
      const firstSources = observation.requests[0]?.messages.flatMap((message) => {
        const parsed = projectionMessageSchema.safeParse(message)
        return parsed.success && parsed.data.source.kind === 'scope-agent-context' && parsed.data.source.form === 'snapshot'
          ? [parsed.data.source] : []
      }) ?? []
      const adoptedWatermark = firstSources.some(item => item.projection?.taskRevision === ownerRevision
        && item.projection.backend.id === (request.condition === 'R' ? 'semantic' : 'text'))
      if (request.condition === 'N' && snapshots.length !== 0) throw new Error('N received shared context')
      if (request.condition !== 'N' && observation.requests.length > 0 && !adoptedWatermark) {
        throw new Error('recipient dispatched without selected owner watermark/backend')
      }
      const target = recipients[role]
      const artifact = await target.workbench.read(target.spec.artifactPath, lifetime.signal)
        .then(value => sealDataArtifact(value.text), (error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
          throw error
        })
      if (role === 'B') artifacts.policy = artifact; else artifacts.cases = artifact
      roles[role] = { requests: observation.requests.length, turnReason: observation.turnReason, scopeSnapshots: snapshots.length,
        adoptedWatermark, durable: observation.durable, publicChecks: target.checks, skipped: false,
        completed: z.object({ kind: z.literal('completed') }).safeParse(observation.turnReason).success }
      await save(request.output, `${role}-session.json`, observation)
      await cp(join(temporary, `host-${role}`, 'sessions'), join(request.output, `${role}-durable-sessions`), { recursive: true })
    }
    if (request.condition === 'R') {
      await save(request.output, 'semantic-audit.json', await owner.native('finish'))
      await cp(join(ownerHost.directory, 'sessions'), join(request.output, 'semantic-durable-sessions'), { recursive: true })
    }
    await save(request.output, 'sealed-artifacts.json', artifacts)
    grade = request.grade === undefined ? null : await request.grade(artifacts)
    lifetime.signal.throwIfAborted()
  } catch (error) { failure = error } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', cancelled)
    lifetime.abort(new Error('native data run complete'))
    if (server !== undefined) await server.close().catch((error: unknown) => { failure ??= error })
    for (const host of hosts.reverse()) {
      try { const ended = await host.stop(); cleanup.closed++; if (ended.signal === 'SIGKILL') cleanup.forced++
        await save(request.output, `host-${cleanup.closed}-exit.json`, { code: ended.code, signal: ended.signal,
          stdoutBytes: Buffer.byteLength(ended.stdout), stderrBytes: Buffer.byteLength(ended.stderr) })
      } catch (error) { failure ??= error }
    }
    await rm(temporary, { recursive: true, force: true })
  }
  if (cleanup.closed !== cleanup.started || cleanup.forced > 0) failure ??= new Error('Host cleanup did not settle normally')
  const reservations = server?.reservations ?? []
  const counts = { ordinary: reservations.filter(item => item.role !== 'O').length,
    semantic: reservations.filter(item => item.role === 'O').length, sourceControlled }
  const result: NativeDataRunResult = { kind: 'native-data-run', condition: request.condition, execution: request.execution,
    failed: failure !== undefined || Object.values(roles).some(role => !role.completed),
    error: failure === undefined ? null : errorText(failure), dispatchBlocked: server?.blocked() ?? false,
    realModelDispatches: request.execution.kind === 'live' ? counts.ordinary + counts.semantic : 0,
    counts, modelCounterMeaning: 'Persisted permission to delegate to the production HTTP adapter; not proof of HTTP-send, billing, or useful model output.',
    ownerRevision, peers, roles, artifacts, grade, cleanup }
  await save(request.output, 'dispatch-ledger.json', reservations)
  await save(request.output, 'result.json', result)
  return result
}
