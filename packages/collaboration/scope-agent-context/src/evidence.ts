/** Bounded automatic-goal evidence derived from frozen requests and successful whole turns. */

import { compositeProjectionSchema } from './composite.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { scopeAgentActivitySchema, scopeAgentActivityView } from './activity.ts'
import { localContextProjectionSchema } from '@deepseek-ai/dsh-development-task-context/local'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { projectionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeAgentActivationId, ScopeAgentBindingId, ScopeAgentCompletedEvidence, ScopeAgentEvaluation, ScopeAgentEvidenceState, ScopeAgentGoalDigest, ScopeAgentRequestEvidence, ScopeAgentReadProjection } from './types.ts'

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const seq = natural.transform(SessionSeq)
const bindingId = z.uuid().transform(value => value as ScopeAgentBindingId)
const activationId = z.uuid().transform(value => value as ScopeAgentActivationId)
const goal = z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ScopeAgentGoalDigest)
const baseline = z.object({ requestSeq: seq, turnEndSeq: seq }).strict()
const evaluationFields = { decision: z.enum(['activate', 'suppress-unchanged', 'blocked-current', 'suppress-reserved']),
  bindingId, goalDigest: goal, maxContextBytes: natural.positive(),
  activationId: activationId.nullable(), baseline: baseline.nullable() }
const evaluationObject = z.discriminatedUnion('version', [
  z.object({ ...evaluationFields, version: z.literal(1), projection: projectionSchema }).strict(),
  z.object({ ...evaluationFields, version: z.literal(2), projection: localContextProjectionSchema }).strict(),
  z.object({ ...evaluationFields, version: z.literal(3), projection: compositeProjectionSchema }).strict(),
])
/** Strict durable scheduling decisions, including the complete evaluated source representation. */
export const evaluationSchema: z.ZodType<ScopeAgentEvaluation> = evaluationObject.superRefine((value, ctx) => {
  if ((value.decision === 'activate' || value.decision === 'suppress-reserved') !== (value.activationId !== null)
    || ((value.decision === 'suppress-unchanged' || value.decision === 'suppress-reserved') && value.baseline === null)) {
    ctx.addIssue({ code: 'custom', message: 'scope scheduling decision has inconsistent reservation or baseline' })
  }
})
const requestFields = { turn: natural.positive(), step: natural.positive(), bindingId, activationId, goalDigest: goal,
  contextSeq: seq, maxContextBytes: natural.positive() }
/** A dispatch anchor retains the actual projection, not its earlier prefetch candidate. */
export const requestEvidenceSchema: z.ZodType<ScopeAgentRequestEvidence> = z.discriminatedUnion('version', [
  z.object({ ...requestFields, version: z.literal(1), projection: projectionSchema }).strict(),
  z.object({ ...requestFields, version: z.literal(2), projection: localContextProjectionSchema }).strict(),
  z.object({ ...requestFields, version: z.literal(3), projection: compositeProjectionSchema, localContextSeq: seq }).strict(),
])
const completedSchema = z.object({ request: requestEvidenceSchema, requestSeq: seq, assistantSeq: seq, turnEndSeq: seq }).strict()
const evidenceSchema: z.ZodType<ScopeAgentEvidenceState> = z.object({ version: z.literal(1), activeTurn: natural.positive().nullable(),
  reservation: evaluationSchema.nullable(),
  dispatched: z.object({ request: requestEvidenceSchema, requestSeq: seq, assistantSeq: seq.nullable() }).strict().nullable(),
  completed: completedSchema.nullable(), lastEvaluation: evaluationSchema.nullable() }).strict()

/**
 * Identify the explicit local goal independently of its remaining allowance and pacing.
 * @param value - admitted, trimmed goal text.
 * @returns stable opaque goal identity.
 */
export function goalDigest(value: string): ScopeAgentGoalDigest {
  return createHash('sha256').update(value).digest('hex') as ScopeAgentGoalDigest
}

function comparison(projection: ScopeAgentReadProjection, maxContextBytes: number): string {
  if ('kind' in projection && projection.kind === 'local-task-scope') {
    return JSON.stringify([comparison(projection.local, maxContextBytes), comparison(projection.remote, maxContextBytes)])
  }
  if ('kind' in projection) {
    const activation = projection.activation
    return JSON.stringify(['local-task', projection.taskId, projection.ownerNodeId, projection.participantId,
      projection.taskBindingId, projection.bindingEpoch, projection.backend.id, projection.backend.revision,
      activation.kind === 'exact' ? ['exact', projection.projectionId, maxContextBytes]
        : ['recipient-evidence', activation.version, activation.digest, activation.coverage]])
  }
  const activation = projection.version === 2 ? projection.activation : { kind: 'exact' as const }
  return JSON.stringify([projection.taskId, projection.ownerPeerId, projection.recipientPeerId, projection.grantId,
    projection.grantGeneration, projection.expiresAt, projection.backend.id, projection.backend.revision,
    activation.kind === 'exact' ? ['exact', projection.projectionId, maxContextBytes]
      : ['recipient-evidence', activation.version, activation.digest, activation.coverage]])
}

/**
 * Compare current authorized evidence with one successfully completed automatic goal.
 * @param completed - durable proof from an actual request and completed turn, or no proof.
 * @param binding - local binding interval; rejoining does not inherit suppression.
 * @param goalId - current explicit local goal identity.
 * @param projection - freshly authorized exact projection.
 * @param maxContextBytes - complete native framing budget used for this decision.
 * @returns whether no new automatic work is required for this evidence.
 */
export function completedMatches(completed: ScopeAgentCompletedEvidence | null, binding: ScopeAgentBindingId,
  goalId: ScopeAgentGoalDigest, projection: ScopeAgentReadProjection, maxContextBytes: number): boolean {
  return completed !== null && completed.request.bindingId === binding && completed.request.goalDigest === goalId
    && comparison(completed.request.projection, completed.request.maxContextBytes) === comparison(projection, maxContextBytes)
}

/** Only an authorized request followed by a non-interrupted assistant and completed turn advances the baseline. */
export const scopeAgentEvidenceProjection = {
  key: 'scopeAgentEvidence', stateVersion: 1, stateSchema: evidenceSchema,
  wire: { viewSchema: scopeAgentActivitySchema, view: scopeAgentActivityView },
  init: () => ({ version: 1, activeTurn: null, reservation: null, dispatched: null, completed: null, lastEvaluation: null }),
  apply: (state, event) => {
    if (event.type === 'scope-agent-context/join-read'
      && ((event.data.phase === 'planned' && event.data.version === 3) || event.data.phase === 'adopted' || ((event.data.phase === 'ended' || event.data.phase === 'superseded')
        && event.data.leaveAdopted && event.data.plan?.bindingId === state.reservation?.bindingId))) {
      return { ...state, activeTurn: null, reservation: null, dispatched: null }
    }
    if (event.type === 'scope-agent-context/state') {
      const reservation = state.reservation
      if (reservation === null) return state
      const next = event.data
      if (next.mode !== 'enabled' || next.pendingActivation?.id !== reservation.activationId || next.binding?.id !== reservation.bindingId
        || next.automatic === null || goalDigest(next.automatic.goal) !== reservation.goalDigest) {
        return { ...state, activeTurn: null, reservation: null, dispatched: null }
      }
      return state
    }
    if (event.type === 'scope-agent-context/evaluation') {
      const decision = evaluationSchema.parse(event.data)
      if (decision.decision === 'suppress-unchanged' || decision.decision === 'suppress-reserved') {
        if (state.completed === null || decision.baseline?.requestSeq !== state.completed.requestSeq
          || decision.baseline.turnEndSeq !== state.completed.turnEndSeq
          || !completedMatches(state.completed, decision.bindingId, decision.goalDigest, decision.projection, decision.maxContextBytes)) {
          throw new Error('scope-agent-context: suppression lacks its completed evidence')
        }
      }
      return { ...state, lastEvaluation: decision, ...(decision.decision === 'activate' ? { activeTurn: null, reservation: decision, dispatched: null } : {}) }
    }
    if (event.type === 'scope-agent-context/request') {
      const request = requestEvidenceSchema.parse(event.data)
      const reservation = state.reservation
      if (reservation === null || reservation.activationId !== request.activationId || reservation.bindingId !== request.bindingId
        || reservation.goalDigest !== request.goalDigest || request.contextSeq >= event.seq
        || (request.localContextSeq !== undefined && request.localContextSeq >= event.seq)
        || (state.activeTurn !== null && state.activeTurn !== request.turn)) {
        throw new Error('scope-agent-context: dispatch lacks its matching automatic reservation')
      }
      return { ...state, activeTurn: request.turn, dispatched: { request, requestSeq: event.seq, assistantSeq: null } }
    }
    if (event.type === 'step/start' && state.dispatched !== null) return { ...state, dispatched: null }
    const dispatched = state.dispatched
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      if (dispatched === null || event.data.turn !== dispatched.request.turn || event.data.step !== dispatched.request.step) return state
      return { ...state, dispatched: event.type === 'assistant/message' && event.data.interrupted !== true
        ? { ...dispatched, assistantSeq: event.seq } : null }
    }
    if (event.type === 'turn/end') {
      const completed = dispatched !== null && dispatched.request.turn === event.data.turn && dispatched.assistantSeq !== null
        && event.data.reason.kind === 'completed'
        ? { request: dispatched.request, requestSeq: dispatched.requestSeq, assistantSeq: dispatched.assistantSeq, turnEndSeq: event.seq }
        : state.completed
      return state.reservation === null && dispatched === null && completed === state.completed
        ? state : { ...state, activeTurn: null, reservation: null, dispatched: null, completed }
    }
    return state
  },
} satisfies ProjectionDefinition<'scopeAgentEvidence'>
