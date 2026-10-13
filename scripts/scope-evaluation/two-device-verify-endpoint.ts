/** Restore one captured endpoint independently of the observer's success flags. */
import { isDeepStrictEqual } from 'node:util'
import * as SessionModule from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import * as Catalog from '@deepseek-ai/dsh-session-format-catalog'
import { ExportReader } from './two-device-verify-files.ts'
import { canonicalEvidence, evidenceDigest, persistedEvidenceHeader, reconstructEvidenceRequest, restoreEvidenceSession } from './two-device-verify-replay.mjs'

const natural = z.number().int().nonnegative()
const positive = z.number().int().positive()
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const fileSchema = z.strictObject({ path: z.string(), text: z.string() })
const stageSchema = z.strictObject({ prompt: z.string(), reply: z.string() })
const manifestSchema = z.looseObject({ version: z.literal(1), role: z.enum(['A', 'B']), root: z.string(), workspace: z.string(),
  expectedRequests: positive, modelTrialsExecuted: z.literal(0), sourceHashes: z.record(z.string(), digest),
  files: z.strictObject({ shared: fileSchema, afterLeave: fileSchema, private: fileSchema.optional() }),
  stages: z.strictObject({ ready: stageSchema, publish: stageSchema, receive: stageSchema, afterLeave: stageSchema }),
})
const messageSchema = z.looseObject({ source: z.looseObject({ kind: z.string(), form: z.string().optional() }),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })), role: z.string() })
const requestSchema = z.looseObject({ version: z.literal(1), index: natural, sessionId: z.string(), turn: positive, step: positive,
  eventCount: positive, prefixSha256: digest, header: z.looseObject({ cwd: z.string(), delegationDepth: natural.optional() }),
  config: z.record(z.string(), z.unknown()),
  tools: z.array(z.unknown()), messages: z.array(messageSchema), contextBytes: natural,
  sourceSeqs: z.array(z.strictObject({ kind: z.string(), seq: natural })),
})
const verificationSchema = z.looseObject({ version: z.literal(1), final: z.boolean(), status: z.string(), expectedRequests: positive,
  observedRequests: natural, verifiedRequests: natural, activeStreams: natural, evidenceBytes: natural,
  drainBudgetExceeded: z.boolean(), failures: z.array(z.string()), sessions: z.array(z.looseObject({
    sessionId: z.string(), observedRequests: natural, latestTurnId: positive.nullable(), idle: z.boolean(), eventCount: natural,
    lastTurnEnd: z.unknown(), path: z.string(), bytes: natural, sha256: digest, requestReconstruction: z.boolean(),
  })),
})
const callSchema = z.looseObject({ turn: positive, step: positive, callId: z.string(), name: z.literal('write'), arguments: z.string() })
const argsSchema = z.strictObject({ file_path: z.string(), content: z.string() })
const resultSchema = z.looseObject({ turn: positive, step: positive, message: z.looseObject({
  source: z.strictObject({ kind: z.literal('tool'), callId: z.string() }),
  content: z.array(z.looseObject({ type: z.literal('tool-result'), toolCallId: z.string(), isError: z.boolean().optional() })),
}) })
/** Captured request with complete original message and source fields retained. */
export type DeviceRequest = z.infer<typeof requestSchema>
/** A completed source write, identified by original Session event coordinates. */
export interface DeviceWrite { path: string; text: string; callSeq: number; resultSeq: number; turn: number }
/** Refuse a specific material inconsistency. @param condition Required fact. @param detail Diagnostic. */
export function evidenceCheck(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`two-device evidence: ${detail}`)
}
/** Compare complete recorded values. @param actual Observed value. @param expected Required value. @param detail Diagnostic. */
export function evidenceEqual(actual: unknown, expected: unknown, detail: string): void {
  evidenceCheck(isDeepStrictEqual(actual, expected), detail)
}
/** Join only actual textual blocks, never projection metadata. @param request Actual request. @returns Visible text. */
export function requestText(request: DeviceRequest): string {
  return request.messages.flatMap(message => message.content).map(block => block.text ?? '').join('\n')
}
function lines(text: string): string[] {
  evidenceCheck(text !== '' && text.endsWith('\n'), 'incomplete or empty JSONL')
  return text.slice(0, -1).split('\n')
}
function validateManifest(manifest: z.infer<typeof manifestSchema>, role: 'A' | 'B'): void {
  evidenceEqual(manifest.role, role, 'manifest role mismatch')
  evidenceEqual(manifest.expectedRequests, role === 'A' ? 6 : 7, 'manifest request program mismatch')
  const filenames = role === 'A' ? ['project/owner.ts', 'project/owner-after.ts']
    : ['project/before.ts', 'project/shared.ts', 'project/after.ts']
  const files = [manifest.files.private, manifest.files.shared, manifest.files.afterLeave].filter(item => item !== undefined)
  evidenceEqual(files.map(file => file.path), filenames, 'manifest business file program mismatch')
  const markers = role === 'A' ? ['A_SHARED', 'A_AFTER_LEAVE'] : ['B_PRIVATE', 'B_SHARED', 'B_AFTER']
  let nonce: string | undefined
  for (const [index, file] of files.entries()) {
    const match = /^export const fact = "([A-Z_]+)_([a-f0-9-]{36})";\n$/u.exec(file.text)
    evidenceCheck(match !== null && match[1] === markers[index], 'manifest business fact program mismatch')
    nonce ??= match[2]
    evidenceEqual(match[2], nonce, 'manifest nonce changed between stages')
  }
  evidenceEqual(manifest.stages, {
    ready: { prompt: `${role}: Complete your initial local work.`, reply: `${role}_READY` },
    publish: { prompt: `${role}: Complete your local shared work.`, reply: `${role}_PUBLISHED` },
    receive: { prompt: `${role}: Continue with currently available context.`, reply: `${role}_RECEIVED` },
    afterLeave: { prompt: `${role}: Complete your local work after shared reading ends.`, reply: role === 'A' ? 'A_AFTER_PUBLISHED' : 'B_LEFT' },
  }, 'manifest neutral stage program mismatch')
}

/** Restore and compare all requests, completed turns, tools, files and observer totals.
 * @param reader Static endpoint export reader.
 * @param role Required endpoint role.
 * @returns Exact restored material and derived execution evidence.
 */
export async function verifyEndpoint(reader: ExportReader, role: 'A' | 'B') {
  const manifest = manifestSchema.parse(await reader.json('device.json'))
  validateManifest(manifest, role)
  const requestBytes = await reader.read('evidence/requests.jsonl', 67108864)
  const requests = lines(new TextDecoder('utf-8', { fatal: true }).decode(requestBytes)).map((line) => {
    evidenceCheck(Buffer.byteLength(line + '\n') <= 4194304, 'request byte limit exceeded')
    return requestSchema.parse(JSON.parse(line) as unknown)
  })
  evidenceEqual(requests.length, manifest.expectedRequests, 'controlled request program was not fully consumed')
  const paths = await reader.sessions()
  evidenceCheck(paths.length === 1 && paths[0] !== undefined, 'expected exactly one persisted Session')
  const path = paths[0]
  const sessionBytes = await reader.read(path, 33554432)
  const rows = lines(new TextDecoder('utf-8', { fatal: true }).decode(sessionBytes)).map(line => JSON.parse(line) as unknown)
  const { session, events, header } = restoreEvidenceSession(SessionModule, Catalog, rows)
  evidenceEqual(header.cwd, manifest.workspace, 'Session working directory differs from original manifest')
  const expectedSteps = role === 'A' ? [[1, 1], [2, 1], [2, 2], [3, 1], [4, 1], [4, 2]]
    : [[1, 1], [1, 2], [2, 1], [3, 1], [3, 2], [4, 1], [4, 2]]
  let lastCount = 0
  for (const [index, request] of requests.entries()) {
    evidenceEqual([request.index, request.sessionId, request.turn, request.step],
      [index, session.id, ...expectedSteps[index] ?? []], 'request identity or stage mismatch')
    evidenceCheck(request.eventCount > lastCount && request.eventCount <= events.length, 'request prefix order or length mismatch')
    lastCount = request.eventCount
    const prefix = events.slice(0, request.eventCount)
    evidenceEqual(evidenceDigest(canonicalEvidence({ header: persistedEvidenceHeader(header), events: prefix })),
      request.prefixSha256, 'persisted request prefix hash mismatch')
    evidenceEqual(persistedEvidenceHeader(header), { ...request.header, delegationDepth: request.header.delegationDepth ?? 0 },
      'request original header mismatch')
    reconstructEvidenceRequest(SessionModule, session.id, header, prefix, request)
    const step = prefix.findLast(event => event.type === 'step/start')
    evidenceCheck(step?.type === 'step/start', 'request has no recorded step')
    evidenceEqual([step.data.turn, step.data.step], [request.turn, request.step], 'request step differs from Session')
    evidenceEqual(request.tools, requests[0]?.tools, 'original tool set changed')
    const managed = request.messages.filter(message => ['scope-agent-context', 'development-task-context'].includes(message.source.kind))
    const seqs = managed.map((message) => {
      const event = prefix.findLast(item => item.type === 'user/message' && isDeepStrictEqual(item.data, message))
      evidenceCheck(event !== undefined, 'managed message lacks exact source event')
      return { kind: message.source.kind, seq: event.seq }
    })
    evidenceEqual(request.sourceSeqs, seqs, 'managed source sequence mismatch')
    evidenceEqual(request.contextBytes, managed.reduce((total, message) => total + message.content.reduce((sum, block) =>
      sum + (block.type === 'text' ? Buffer.byteLength(block.text ?? '') : 0), 0), 0), 'managed context byte count mismatch')
    evidenceCheck(!request.messages.some(message => message.source.kind === 'scope-agent-pulse'), 'unexpected autonomous request')
  }
  const stages = role === 'A' ? [manifest.stages.ready, manifest.stages.publish, manifest.stages.receive, manifest.stages.afterLeave]
    : [manifest.stages.ready, manifest.stages.receive, manifest.stages.publish, manifest.stages.afterLeave]
  const userTexts = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  evidenceEqual(userTexts, stages.map(stage => stage.prompt), 'ordinary prompts changed or contained shared facts')
  const replies = events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  evidenceEqual(replies, stages.map(stage => stage.reply), 'ordinary stage replies incomplete')
  const starts = events.filter(event => event.type === 'turn/start')
  const ends = events.filter(event => event.type === 'turn/end')
  evidenceEqual(starts.map(event => event.data.turn), [1, 2, 3, 4], 'ordinary turn starts differ')
  evidenceEqual(ends.map(event => event.data), [1, 2, 3, 4].map(turn => ({ turn, reason: { kind: 'completed' } })), 'ordinary turns did not complete')
  evidenceCheck(events.at(-1)?.type === 'turn/end', 'Session did not end with a completed turn')
  for (const event of events) {
    if (event.type === 'scope-agent-context/state') {
      const state = z.looseObject({ automatic: z.null(), usedBudget: z.literal(0) }).safeParse(event.data)
      evidenceCheck(state.success, 'unexpected automatic authorization or budget consumption')
    }
  }
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  const files = [manifest.files.private, manifest.files.shared, manifest.files.afterLeave].filter(item => item !== undefined)
  evidenceEqual([calls.length, results.length], [files.length, files.length], 'write call/result count mismatch')
  const writes: DeviceWrite[] = []
  for (const [index, file] of files.entries()) {
    const callEvent = calls[index]
    const resultEvent = results[index]
    evidenceCheck(callEvent !== undefined && resultEvent !== undefined, 'missing write execution')
    const call = callSchema.parse(callEvent.data)
    const result = resultSchema.parse(resultEvent.data)
    evidenceEqual(argsSchema.parse(JSON.parse(call.arguments) as unknown), { file_path: file.path, content: file.text }, 'write arguments mismatch')
    evidenceEqual([result.turn, result.step, result.message.source.callId], [call.turn, call.step, call.callId], 'tool result execution mismatch')
    evidenceCheck(callEvent.seq < resultEvent.seq && result.message.content.length === 1
      && result.message.content.every(block => block.toolCallId === call.callId && block.isError !== true), 'write did not complete successfully')
    evidenceEqual(resultEvent.sourceEventSeqs, [callEvent.seq], 'tool result source event mismatch')
    evidenceEqual(await reader.text(`workspace/${file.path}`, 1048576), file.text, 'business file differs from completed write')
    writes.push({ path: file.path, text: file.text, callSeq: callEvent.seq, resultSeq: resultEvent.seq, turn: call.turn })
  }
  evidenceEqual(writes.map(write => write.turn), role === 'A' ? [2, 4] : [1, 3, 4], 'write stage mismatch')
  const verification = verificationSchema.parse(await reader.json('evidence/verification.json'))
  evidenceEqual([verification.final, verification.expectedRequests, verification.observedRequests, verification.verifiedRequests,
    verification.activeStreams, verification.evidenceBytes, verification.drainBudgetExceeded, verification.failures, verification.status],
  [true, requests.length, requests.length, requests.length, 0, requestBytes.length, false, [], 'passed'], 'observer summary disagrees with rebuilt evidence')
  evidenceCheck(verification.sessions.length === 1, 'observer Session summary count mismatch')
  const summary = verification.sessions[0]
  evidenceCheck(summary !== undefined, 'missing observer Session summary')
  evidenceEqual([summary.idle, summary.requestReconstruction], [true, true], 'observer completion flags contradict rebuilt evidence')
  evidenceEqual({ sessionId: summary.sessionId, observedRequests: summary.observedRequests, latestTurnId: summary.latestTurnId,
    eventCount: summary.eventCount, lastTurnEnd: summary.lastTurnEnd, path: summary.path.replaceAll('\\', '/'), bytes: summary.bytes, sha256: summary.sha256 },
  { sessionId: session.id, observedRequests: requests.length, latestTurnId: 4, eventCount: events.length,
    lastTurnEnd: events.at(-1), path: path.slice('sessions/'.length), bytes: sessionBytes.length, sha256: evidenceDigest(sessionBytes) },
  'observer Session digest or totals mismatch')
  const termination = z.looseObject({ version: z.literal(1), pid: positive, closeObserved: z.literal(true), code: z.literal(0),
    signal: z.null(), forced: z.literal(false) }).parse(await reader.json('process-exit.json'))
  return { manifest, requests, session, events, writes, termination, hashes: reader.hashes }
}
/** Fully rebuilt single-endpoint material. */
export type VerifiedEndpoint = Awaited<ReturnType<typeof verifyEndpoint>>
