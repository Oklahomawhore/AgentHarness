/** Shared bounded native evaluation projects, model accounting, and durable receipt verification. */
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { resolveDataNetwork } from './data-network.ts'
import { createWorkbench, type Workbench } from './workbench.ts'
import { executePayment, parseCases, parsePolicy, sealDataArtifact, type SealedDataArtifact } from './data-artifacts.ts'
import type { DataModelRoute, DataRoleProject, NativeDataStudy } from './data-study.ts'

const usageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }).loose()
/** A persisted native Session observation returned by the private profile endpoint. */
export const observationSchema = z.object({ agentId: z.string(),
  requests: z.array(z.object({ messages: z.array(z.unknown()), eventCount: z.number() }).loose()),
  events: z.array(z.object({ seq: z.number(), type: z.string(), data: z.unknown() }).loose()), durable: z.unknown(),
  turnReason: z.unknown(), flushed: z.literal(true), modelUsage: z.unknown() }).loose()
/** Current contribution capture and durable pending-sample state. */
export const captureSchema = z.object({ capture: z.object({ selection: z.unknown(), proposal: z.unknown(), collecting: z.boolean(),
  pendingSamples: z.number(), state: z.string() }).loose().nullable() }).loose()
/** Owner Task revision and authoritative admitted publication list. */
export const taskSchema = z.object({ id: z.string(), revision: z.number(), context: z.array(z.unknown()) }).loose()
/** Recorded scope projection provenance used only by parent admission checks. */
export const projectionMessageSchema = z.object({ source: z.object({ kind: z.string(), form: z.string().optional(),
  projection: z.object({ taskRevision: z.number(), backend: z.object({ id: z.string() }).loose() }).loose().optional() }).loose() }).loose()
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('evaluation_read'), path: z.string() }),
  z.object({ operation: z.literal('evaluation_write'), path: z.string(), text: z.string() }),
  z.object({ operation: z.literal('evaluation_test') }),
  z.object({ operation: z.literal('model-reserve'), request: z.unknown(), evidence: z.unknown() }),
  z.object({ operation: z.literal('model-settle'), reservation: z.string(), usage: z.unknown(), finish: z.unknown(),
    outputBytes: z.number(), responseObserved: z.boolean() }),
])
/** Bounded public role project owned by one native receiving Session. */
export interface Recipient {
  readonly project: string
  readonly workbench: Workbench
  readonly spec: DataRoleProject
  readonly checks: unknown[]
}
interface Reservation {
  readonly id: string
  readonly role: 'B' | 'C' | 'O'
  readonly request: unknown
  readonly evidence: unknown
  result: unknown
}
/** Describe an evaluation failure without assuming an Error instance.
 * @param error Caught failure.
 * @returns Its message for private run evidence. */
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
/** Persist one immutable private JSON evidence file.
 * @param directory Existing private output directory.
 * @param name Unique evidence filename.
 * @param value Serializable observation.
 * @returns Completion after a successful exclusive write. */
export async function save(directory: string, name: string, value: unknown): Promise<void> {
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
/** Create a bounded public receiving workspace without exposing grading inputs.
 * @param root Private run directory.
 * @param role Receiver responsibility.
 * @param study Frozen public projects and file limits.
 * @returns Owned project and file allowlist enforcement. */
export async function project(root: string, role: 'B' | 'C', study: Pick<NativeDataStudy, 'roles' | 'limits' | 'ordinary' | 'semantic'>): Promise<Recipient> {
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
async function waitSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('evaluation wait aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })]) } finally { if (abort !== undefined) signal.removeEventListener('abort', abort) }
}
/** Own file tools, cumulative model reservations and explicit request admission for all Hosts.
 * @param output Existing private evidence directory.
 * @param recipients Bounded independent receiving projects.
 * @param study Frozen routes and limits.
 * @param signal Whole-run cancellation.
 * @param continuity Whether existing automatic phase gates are enabled.
 * @returns Owned server and finite admission controls; the caller must await close. */
export async function coordinator(output: string, recipients: Record<'B' | 'C', Recipient>, study: Pick<NativeDataStudy, 'roles' | 'limits' | 'ordinary' | 'semantic'>, signal: AbortSignal, continuity: boolean) {
  const tokens = { A: randomUUID(), D: randomUUID(), B: randomUUID(), C: randomUUID(), O: randomUUID() }
  const reservations: Reservation[] = []; const pending = new Set<Promise<void>>()
  let blocked = false
  let admission = Promise.withResolvers<void>()
  const sourceStage = Promise.withResolvers<void>()
  let sourceWaiting = false
  let accounting = Promise.withResolvers<void>()
  const changed = () => { accounting.resolve(); accounting = Promise.withResolvers<void>() }
  let initial = false
  let watermark: { taskId: string; revision: number; condition: 'N' | 'E' | 'R' | 'reported' | 'semantic' } | undefined
  const server = createServer((request, response) => {
    const disconnected = new AbortController()
    const onClose = () => { if (!response.writableEnded) disconnected.abort(new Error('coordinator caller disconnected')) }
    response.once('close', onClose)
    const requestSignal = AbortSignal.any([signal, disconnected.signal])
    const operation = (async () => {
      if (request.method !== 'POST' || request.url !== '/tool') { respond(response, 403, {}); return }
      const body = z.object({ role: z.enum(['A', 'D', 'B', 'C', 'O']), sessionId: z.string() }).loose().parse(await readBody(request))
      if (request.headers.authorization !== `Bearer ${tokens[body.role]}` || body.sessionId !== `data-${body.role}`) {
        respond(response, 403, {}); return
      }
      signal.throwIfAborted()
      const gate = z.object({ operation: z.enum(['source-stage', 'phase-admission']) }).safeParse(body)
      if (gate.success) {
        if (!continuity || (gate.data.operation === 'source-stage' ? body.role !== 'A' : body.role !== 'B')) {
          throw new Error('phase operation does not belong to this Host')
        }
        if (gate.data.operation === 'source-stage') sourceWaiting = true
        await waitSignal(gate.data.operation === 'source-stage' ? sourceStage.promise : admission.promise, requestSignal)
        respond(response, 200, { admitted: true }); return
      }
      if (body.role === 'A' || body.role === 'D') throw new Error('source has no project or model accounting tools')
      const input = commandSchema.parse(body)
      let result: unknown
      if (input.operation === 'model-reserve') {
        if (continuity) {
          const waiting = AbortSignal.any([requestSignal, AbortSignal.timeout(study.limits.operationTimeoutMs)])
          while (!blocked && reservations.some(item => item.result === null)) await waitSignal(accounting.promise, waiting)
          waiting.throwIfAborted()
        }
        requestSignal.throwIfAborted()
        if (blocked || reservations.some(item => item.result === null)) throw new Error('previous model accounting is incomplete')
        const route = body.role === 'O' ? study.semantic : study.ordinary
        if (reservations.filter(item => item.role === body.role).length >= route.maxCalls) throw new Error('model call limit reached')
        const actual = z.object({ provider: z.literal(route.provider), model: z.literal(route.model),
          maxTokens: z.literal(route.maxOutputTokens), purpose: z.literal(body.role === 'O' ? 'context-summary' : 'ordinary') }).loose().parse(input.request)
        if (Buffer.byteLength(JSON.stringify(actual)) > route.maxInputBytes) throw new Error('model input limit reached')
        if (body.role !== 'O') {
          const expected = watermark
          if (expected === undefined && !initial) throw new Error('source receipt watermark is not ready')
          const messages = z.object({ messages: z.array(z.unknown()) }).loose().parse(input.request).messages
          const snapshots = messages.flatMap((message) => {
            const parsed = projectionMessageSchema.safeParse(message)
            return parsed.success && parsed.data.source.kind === 'scope-agent-context' && parsed.data.source.form === 'snapshot'
              ? [parsed.data.source] : []
          })
          if (initial || expected?.condition === 'N' ? snapshots.length !== 0 : !snapshots.some(({ projection }) => projection !== undefined
            && projection.taskRevision === expected?.revision
            && projection.backend.id === (expected.condition === 'R' || expected.condition === 'semantic' ? 'semantic'
              : expected.condition === 'reported' ? 'reported-files' : 'text')
            && z.object({ taskId: z.string() }).loose().parse(projection).taskId === expected.taskId)) {
            throw new Error('ordinary dispatch lacks the frozen treatment context')
          }
        }
        const reservation: Reservation = { id: randomUUID(), role: body.role,
          request: input.request, evidence: input.evidence, result: null }
        reservations.push(reservation)
        try { await save(output, `dispatch-${reservations.length}.json`, reservation) } catch (error) { blocked = true; changed(); throw error }
        result = { reservation: reservation.id }
      } else if (input.operation === 'model-settle') {
        const reservation = reservations.find(item => item.id === input.reservation && item.role === body.role)
        if (reservation === undefined || reservation.result !== null) throw new Error('unknown or settled model reservation')
        const usage = usageSchema.safeParse(input.usage)
        if (!usage.success || usage.data.outputTokens > (body.role === 'O' ? study.semantic : study.ordinary).maxOutputTokens) blocked = true
        try {
          await save(output, `settled-${reservations.indexOf(reservation) + 1}.json`, input)
          reservation.result = input
        } catch (error) { blocked = true; throw error } finally { changed() }
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
      .finally(() => { response.removeListener('close', onClose); pending.delete(operation) })
    pending.add(operation)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('private coordinator has no address')
  return { url: `http://127.0.0.1:${address.port}/tool`, tokens, reservations,
    setWatermark(value: NonNullable<typeof watermark>) { watermark = value; initial = false },
    allowInitial() { if (watermark !== undefined) throw new Error('cannot reopen initial model admission'); initial = true },
    closeAdmission() { admission = Promise.withResolvers<void>() },
    openAdmission() { admission.resolve() },
    releaseSource() { sourceStage.resolve() },
    sourceWaiting: () => sourceWaiting,
    failedAccounting: () => blocked,
    blocked: () => blocked || reservations.some(item => item.result === null), async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
      await Promise.allSettled(pending)
    } }
}
/** Observe a live condition until it holds or the run is cancelled.
 * @param read Current-state observation.
 * @param ready Acceptance predicate.
 * @param signal Run deadline or cancellation.
 * @returns The first accepted observation. */
export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  for (;;) { signal.throwIfAborted(); const value = await read(); if (ready(value)) return value; await delay(25, undefined, { signal }) }
}
/** Resolve only the explicit model route credential and network environment.
 * @param route Frozen provider route.
 * @param execution Live credentials or local transport calibration.
 * @returns Minimal Host environment; calibration never reads credential values. */
export function environment(route: DataModelRoute, execution: { readonly kind: 'live' | 'transport-calibration' }): NodeJS.ProcessEnv {
  if (execution.kind === 'transport-calibration') {
    if (route.network.kind !== 'direct') throw new Error('transport calibration requires direct networking')
    return { [route.apiKeyEnv]: 'transport-calibration-not-a-secret' }
  }
  const network = resolveDataNetwork(route.network, process.env, process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))
  if (route.credentialsPath !== null) return network
  const value = process.env[route.apiKeyEnv]
  return value === undefined ? network : { ...network, [route.apiKeyEnv]: value }
}
/** Read durable evaluation records in deterministic key order.
 * @param path Closed-over Host SQLite path.
 * @param table Explicit allowed evidence table.
 * @returns Parsed persisted values. */
export function sqliteRows(path: string, table: 'u_scope_agent_contributions_sessions' | 'u_development_context_tasks_events'): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(`SELECT value FROM ${table} ORDER BY key`).all().map(row => JSON.parse(z.string().parse(row.value)) as unknown) }
  finally { db.close() }
}

/** Read and seal a receiving artifact without interpreting generated content.
 * @param target Bounded receiving workspace.
 * @param path Explicit readable artifact path.
 * @param signal Run deadline or cancellation.
 * @returns Exact UTF-8 artifact, or null only when the file does not exist. */
export async function sealedFile(target: Recipient, path: string, signal: AbortSignal): Promise<SealedDataArtifact | null> {
  try { return sealDataArtifact((await target.workbench.read(path, signal)).text) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}
/** Require every admitted source sample to match its durable tool and owner records.
 * @param observation Persisted source Session.
 * @param sourceRows Durable contribution capture rows.
 * @param ownerEvents Durable owner Task events.
 * @param sourcePeer Independent source identity.
 * @param ownerPeer Scope owner identity.
 * @param count Required settled publication count.
 * @returns Normally only when every receipt has both corresponding records. */
export function verifyReceipts(observation: z.infer<typeof observationSchema>, sourceRows: readonly unknown[],
  ownerEvents: readonly unknown[], sourcePeer: string, ownerPeer: string, count: number): void {
  const samples = sourceRows.flatMap(value => z.object({ samples: z.array(z.object({ callSeq: z.number(), resultSeq: z.number(),
    sample: z.object({ sourceId: z.string() }).loose(), receipt: z.object({ sourceId: z.string(),
      ownerPeerId: z.literal(ownerPeer), contributorPeerId: z.literal(sourcePeer), publicationId: z.string(),
      event: z.object({ nodeId: z.string(), seq: z.number(), kind: z.literal('context-published') }) }).loose() }).loose()),
  }).loose().parse(value).samples)
  if (samples.length !== count) throw new Error('durable source receipt count differs from phase')
  for (const item of samples) {
    if (item.sample.sourceId !== item.receipt.sourceId || !observation.events.some(event => event.seq === item.callSeq && event.type === 'tool/call')
      || !observation.events.some(event => event.seq === item.resultSeq && event.type === 'tool/result')
      || !ownerEvents.some((value) => {
        const event = z.object({ nodeId: z.string(), seq: z.number(), change: z.object({ kind: z.string(),
          publication: z.object({ id: z.string() }).loose().optional() }).loose() }).loose().parse(value)
        return event.nodeId === item.receipt.event.nodeId && event.seq === item.receipt.event.seq
          && event.change.kind === 'context-published' && event.change.publication?.id === item.receipt.publicationId
      })) throw new Error('source settlement/receipt does not match durable owner event')
  }
}
