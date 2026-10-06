/** Text-free automatic activity derived from validated request and completion evidence. */

import { z } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ScopeAgentActivity, ScopeAgentActivityIdentity, ScopeAgentActivityRequest, ScopeAgentActivationId,
  ScopeAgentBindingId, ScopeAgentEvidenceState, ScopeAgentGoalDigest, ScopeAgentRequestEvidence } from './types.ts'

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const seq = natural.transform(SessionSeq)
const activationId = z.uuid().transform(value => value as ScopeAgentActivationId)
const identityFields = {
  bindingId: z.uuid().transform(value => value as ScopeAgentBindingId),
  goalDigest: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ScopeAgentGoalDigest),
  taskRevision: natural,
  projectionId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ScopeAgentActivityIdentity['projectionId']),
}
const requestFields = { ...identityFields, activationId, requestSeq: seq, contextSeq: seq,
  turn: natural.positive(), step: natural.positive() }

/** The Client receives recorded identities and outcomes, never shared context or source bodies. */
export const scopeAgentActivitySchema: z.ZodType<ScopeAgentActivity> = z.object({
  request: z.object(requestFields).strict().nullable(),
  completed: z.object({ ...requestFields, assistantSeq: seq, turnEndSeq: seq }).strict().nullable(),
  evaluation: z.object({ ...identityFields,
    decision: z.enum(['activate', 'suppress-unchanged', 'blocked-current', 'suppress-reserved']),
    activationId: activationId.nullable() }).strict().nullable(),
}).strict()

function identity(value: ScopeAgentRequestEvidence | NonNullable<ScopeAgentEvidenceState['lastEvaluation']>): ScopeAgentActivityIdentity {
  return { bindingId: value.bindingId, goalDigest: value.goalDigest,
    taskRevision: value.projection.taskRevision, projectionId: value.projection.projectionId }
}

function requestActivity(request: ScopeAgentRequestEvidence, requestSeq: ScopeAgentActivityRequest['requestSeq']): ScopeAgentActivityRequest {
  return { ...identity(request), activationId: request.activationId, requestSeq, contextSeq: request.contextSeq,
    turn: request.turn, step: request.step }
}

/**
 * Crop the existing evidence fold without adding a completion or failure state machine.
 * @param state - validated Host evidence at the Session projection watermark.
 * @returns automatic request, completion, and evaluation metadata without shared text.
 */
export function scopeAgentActivityView(state: ScopeAgentEvidenceState): ScopeAgentActivity {
  const { dispatched, completed, lastEvaluation } = state
  return {
    request: dispatched === null ? null : requestActivity(dispatched.request, dispatched.requestSeq),
    completed: completed === null ? null : { ...requestActivity(completed.request, completed.requestSeq),
      assistantSeq: completed.assistantSeq, turnEndSeq: completed.turnEndSeq },
    evaluation: lastEvaluation === null ? null : { ...identity(lastEvaluation), decision: lastEvaluation.decision,
      activationId: lastEvaluation.activationId },
  }
}

/**
 * Restrict recorded activity to the current eligible binding and explicitly authorized goal.
 * @param activity - cropped evidence from the same snapshot as the scheduling state.
 * @param bindingId - current eligible binding, or null when its target is absent or terminal.
 * @param goalDigest - current local goal identity, or null without automatic permission.
 * @returns matching historical metadata; it does not attest current remote authorization.
 */
export function currentScopeAgentActivity(activity: ScopeAgentActivity, bindingId: ScopeAgentBindingId | null,
  goalDigest: ScopeAgentGoalDigest | null): ScopeAgentActivity {
  const matches = (value: ScopeAgentActivityIdentity | null): boolean => value !== null
    && bindingId !== null && goalDigest !== null && value.bindingId === bindingId && value.goalDigest === goalDigest
  return { request: matches(activity.request) ? activity.request : null,
    completed: matches(activity.completed) ? activity.completed : null,
    evaluation: matches(activity.evaluation) ? activity.evaluation : null }
}
