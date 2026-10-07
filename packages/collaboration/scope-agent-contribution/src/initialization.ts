/** Explicit recorded-tool export plans and bounded replay of their original completion evidence. */
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { DevelopmentTaskRecordedToolObservationResult, DevelopmentTaskToolObservationResult } from '@deepseek-ai/dsh-development-task/types'
import { recordedToolObservationResultSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { ScopeAgentContributionInitialization, ScopeAgentContributionInitializationRequest } from './types.ts'
import type { NativeSample } from './state.ts'
import type { LocalSample } from './local-state.ts'
import { nativeDigest } from './identity.ts'

/** Immutable source coordinates, kept locally without copying the source transcript or original filesystem roots. */
export interface InitializationProof {
  readonly sourceSampleId: string
  readonly sourceSequence: number
  readonly callSeq: NativeSample['callSeq']
  readonly resultSeq: NativeSample['resultSeq']
  readonly callId: string
  readonly rootCallId: string
  readonly argumentDigest: string
  readonly completionDigest: string
}

/** Durable initialization intent and its one fixed selection; delivery counts are derived from receipts. */
export interface NativeInitialization extends Omit<ScopeAgentContributionInitialization, 'coverage'> {
  readonly coverage: Omit<ScopeAgentContributionInitialization['coverage'], 'acknowledged'>
  readonly plan: { readonly digest: string; readonly sources: readonly InitializationProof[] } | null
}

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = natural.positive()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.string().min(1)
/** Exact local capture and assignment chosen with the ordinary join permission. */
export const initializationRequestSchema = z.strictObject({ kind: z.literal('recorded-local-tools'),
  expectedLocalCapture: z.strictObject({ captureId: identity, captureGeneration: identity }),
  localTask: z.strictObject({ taskId: identity, bindingId: identity,
    expectedBindingEpoch: z.strictObject({ nodeId: identity, seq: positive }) }),
}).transform(value => value as ScopeAgentContributionInitializationRequest)
const proofSchema: z.ZodType<InitializationProof> = z.strictObject({ sourceSampleId: digest, sourceSequence: positive,
  callSeq: positive.transform(SessionSeq), resultSeq: positive.transform(SessionSeq), callId: identity, rootCallId: identity,
  argumentDigest: digest, completionDigest: digest })

/** Version-two source rows validate pending and frozen history independently of delivery progress. */
export const initializationSchema: z.ZodType<NativeInitialization> = z.strictObject({
  state: z.enum(['pending', 'frozen', 'unavailable']), request: initializationRequestSchema,
  cutoff: z.strictObject({ localSequence: natural,
    sessionSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor) }).nullable(),
  coverage: z.strictObject({ recorded: natural, selected: natural, omitted: natural, unconfirmed: natural, inFlight: natural }),
  reason: z.enum(['source-unavailable', 'source-changed', 'coverage-invalid', 'capacity']).nullable(),
  plan: z.strictObject({ digest, sources: z.array(proofSchema) }).nullable(),
}).superRefine((value, ctx) => {
  const { coverage, plan, cutoff } = value
  if (coverage.selected + coverage.omitted !== coverage.recorded || coverage.unconfirmed > coverage.recorded
    || (value.state === 'frozen') !== (plan !== null && cutoff !== null)
    || (value.state === 'unavailable') !== (value.reason !== null)
    || (value.state !== 'frozen' && (plan !== null || cutoff !== null || coverage.selected !== 0))) {
    ctx.addIssue({ code: 'custom', message: 'initialization phase and coverage disagree' })
    return
  }
  if (plan === null || cutoff === null) return
  if (plan.sources.length !== coverage.selected || initializationPlanDigest(value.request, cutoff, plan.sources) !== plan.digest
    || new Set(plan.sources.map(proof => executionDigest(value.request, proof))).size !== plan.sources.length
    || plan.sources.some((proof, index) => proof.callSeq >= proof.resultSeq || proof.resultSeq > cutoff.sessionSeq
      || proof.sourceSequence > cutoff.localSequence
      || (index > 0 && proof.sourceSequence <= (plan.sources[index - 1]?.sourceSequence ?? 0)))) {
    ctx.addIssue({ code: 'custom', message: 'initialization plan differs from its original ordered source evidence' })
  }
})

/**
 * Start one separately authorized history selection without implying any delivery.
 * @param request - Original local capture and epoch.
 * @returns Empty pending plan.
 */
export function pendingInitialization(request: ScopeAgentContributionInitializationRequest): NativeInitialization {
  return { state: 'pending', request, cutoff: null, coverage: { recorded: 0, selected: 0, omitted: 0, unconfirmed: 0, inFlight: 0 },
    reason: null, plan: null }
}

/**
 * Identify the original execution without exporting its Session or local Task identifiers.
 * @param request - Selected local capture and assignment.
 * @param proof - Source execution coordinates.
 * @returns Digest bound to the original capture and completion.
 */
export function executionDigest(request: ScopeAgentContributionInitializationRequest, proof: InitializationProof): string {
  return nativeDigest(['recorded-local-tools', request.expectedLocalCapture.captureId, request.expectedLocalCapture.captureGeneration,
    proof.sourceSampleId, proof.sourceSequence, proof.callSeq, proof.resultSeq, proof.callId, proof.rootCallId,
    proof.argumentDigest, proof.completionDigest])
}

/**
 * Identify a fixed selection without including the rewritten samples or its own digest.
 * @param request - Original export consent.
 * @param cutoff - Frozen source and Session upper bounds.
 * @param sources - Selected source records in execution order.
 * @returns Complete plan identity.
 */
export function initializationPlanDigest(request: ScopeAgentContributionInitializationRequest,
  cutoff: NonNullable<NativeInitialization['cutoff']>, sources: readonly InitializationProof[]): string {
  return nativeDigest(['recorded-local-tools-plan', request.expectedLocalCapture.captureId, request.expectedLocalCapture.captureGeneration,
    request.localTask.taskId, request.localTask.bindingId, request.localTask.expectedBindingEpoch.nodeId,
    request.localTask.expectedBindingEpoch.seq, cutoff.localSequence, cutoff.sessionSeq,
    sources.map(proof => executionDigest(request, proof))])
}

/**
 * Check only selected durable execution coordinates; never scan the transcript or read files.
 * @param session - The same live Session that produced the local capture.
 * @param sample - A persisted local observation.
 * @returns Stable proof when start and settlement exactly match the recorded observation.
 */
export function recordedProof(session: Session, sample: LocalSample): InitializationProof | undefined {
  if (sample.sample.result.version !== 1) return undefined
  const call = session.eventAt(sample.callSeq)
  const result = session.eventAt(sample.resultSeq)
  if (call === undefined || result === undefined || sample.callSeq >= sample.resultSeq
    || nativeDigest(result.data) !== sample.completionDigest) return undefined
  const tool = sample.sample.result.tool === 'Write' ? 'write' : 'edit'
  let args: unknown
  let failed: boolean
  if (call.type === 'tool/call' && result.type === 'tool/result') {
    if (call.data.callId !== sample.callId || call.data.name !== tool || sample.rootCallId !== sample.callId
      || result.data.message.content[0].toolCallId !== sample.callId
      || result.sourceEventSeqs?.includes(sample.callSeq) !== true) return undefined
    try { args = JSON.parse(call.data.arguments) as unknown }
    catch { return undefined } // Only the exact logged JSON arguments can establish this dispatch.
    failed = result.data.message.content[0].isError === true
  } else if (call.type === 'tool/ptc-dispatch-start' && result.type === 'tool/ptc-dispatch') {
    if (call.data.subCallId !== sample.callId || call.data.rootCallId !== sample.rootCallId || call.data.name !== tool
      || result.data.subCallId !== sample.callId || result.data.rootCallId !== sample.rootCallId || result.data.name !== tool
      || nativeDigest(result.data.arguments) !== sample.argumentDigest) return undefined
    args = call.data.arguments
    failed = result.data.isError
  } else return undefined
  if (nativeDigest(args) !== sample.argumentDigest || failed !== (sample.sample.result.reportedStatus === 'failure')
    || typeof args !== 'object' || args === null) return undefined
  const report = sample.sample.result
  if (report.fields.error !== undefined) return undefined
  if (report.tool === 'Write') {
    if (!('content' in args) || typeof args.content !== 'string'
      || (report.fields.content !== undefined && report.fields.content !== args.content)) return undefined
  } else if (!('old_string' in args) || typeof args.old_string !== 'string'
    || !('new_string' in args) || typeof args.new_string !== 'string'
    || (report.fields.oldString !== undefined && report.fields.oldString !== args.old_string)
    || (report.fields.newString !== undefined && report.fields.newString !== args.new_string)
    || report.fields.replaceAll !== ('replace_all' in args ? args.replace_all : false)) return undefined
  return { sourceSampleId: sample.id, sourceSequence: sample.sample.sequence, callSeq: sample.callSeq, resultSeq: sample.resultSeq,
    callId: sample.callId, rootCallId: sample.rootCallId, argumentDigest: sample.argumentDigest, completionDigest: sample.completionDigest }
}

/**
 * Keep the recorded fields or omit whole fields to fit a new independently authorized payload.
 * @param original - Original local report; omitted text is never recovered.
 * @param rootIndex - Matching root ordinal in the current remote consent.
 * @param origin - Fixed original-plan and execution attribution.
 * @param fits - Complete owner-bound payload limit.
 * @returns Historical report, or undefined when even attribution cannot fit.
 */
export function recordedReport(original: DevelopmentTaskToolObservationResult, rootIndex: number,
  origin: DevelopmentTaskRecordedToolObservationResult['origin'],
  fits: (report: DevelopmentTaskRecordedToolObservationResult) => boolean): DevelopmentTaskRecordedToolObservationResult | undefined {
  const parsed = recordedToolObservationResultSchema.safeParse({ ...original, version: 2,
    fields: { ...original.fields, rootIndex }, origin })
  if (!parsed.success) return undefined
  let candidate: DevelopmentTaskRecordedToolObservationResult = parsed.data
  if (fits(candidate)) return candidate
  if (candidate.tool === 'Write' && candidate.fields.content !== undefined) {
    const { content: _content, ...fields } = candidate.fields
    candidate = { ...candidate, fields, omissions: [...candidate.omissions, 'content'] }
    if (fits(candidate)) return candidate
  }
  if (candidate.tool === 'Edit') {
    for (const key of ['newString', 'oldString'] as const) {
      if (candidate.fields[key] === undefined) continue
      const { [key]: _removed, ...fields }: Extract<DevelopmentTaskRecordedToolObservationResult, { tool: 'Edit' }>['fields']
        = candidate.fields
      candidate = { ...candidate, fields, omissions: [...candidate.omissions, key] }
      if (fits(candidate)) return candidate
    }
  }
  if (candidate.fields.error !== undefined) {
    const fields = { ...candidate.fields }
    delete fields.error
    candidate = recordedToolObservationResultSchema.parse({ ...candidate, fields, omissions: [...candidate.omissions, 'error'] })
    if (fits(candidate)) return candidate
  }
  return undefined
}
