/** Durable joint-join ownership and exact local read-state comparison. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Session, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { invitationSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeGeneration, ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentBindingId, ScopeAgentBindingStatus, ScopeAgentJoinReadEvent, ScopeAgentJoinReadId, ScopeAgentJoinReadPlan } from './types.ts'

const cursor = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor)
const planSchema: z.ZodType<ScopeAgentJoinReadPlan> = z.object({
  expectedReadStateSeq: cursor,
  subscription: z.object({
    id: z.uuid().transform(value => value as ScopeSubscriptionId),
    generation: z.uuid().transform(value => value as ScopeGeneration),
    invitation: invitationSchema, state: z.literal('active'),
  }).strict(),
  bindingId: z.uuid().transform(value => value as ScopeAgentBindingId),
}).strict()
const common = { version: z.literal(1), agentId: z.string().min(1).transform(SessionId),
  adoptionId: z.uuid().transform(value => value as ScopeAgentJoinReadId) }

/** Strict durable parser; terminal records retain the original plan when one exists. */
export const joinReadEventSchema: z.ZodType<ScopeAgentJoinReadEvent> = z.union([
  z.object({ ...common, phase: z.enum(['planned', 'adopted']), plan: planSchema }).strict(),
  z.object({ ...common, phase: z.enum(['ended', 'superseded']), plan: planSchema.nullable(), leaveAdopted: z.boolean() }).strict(),
])

/**
 * Apply one atomic adoption or owned departure without resetting lifetime reservations.
 * @param state - preceding scheduling state.
 * @param event - validated adoption record.
 * @returns current binding state; plans and unrelated terminal records do not change it.
 */
export function foldJoinRead(state: ScopeAgentBindingStatus, event: ScopeAgentJoinReadEvent): ScopeAgentBindingStatus {
  if (event.agentId !== state.agentId) throw new Error('scope-agent-context: adoption belongs to another Session')
  if (event.phase === 'adopted') {
    const { subscription, bindingId } = event.plan
    return { ...state, version: 1, binding: { id: bindingId, subscriptionId: subscription.id, invitation: subscription.invitation },
      automatic: null, mode: 'passive', pauseReason: null, pendingActivation: null }
  }
  if ((event.phase === 'ended' || event.phase === 'superseded') && event.leaveAdopted
    && event.plan !== null && state.binding?.id === event.plan.bindingId) {
    return { ...state, version: 1, binding: null, automatic: null, mode: 'left', pauseReason: null, pendingActivation: null }
  }
  return state
}

/** Parsed original operations and the last event that actually changed reading management. */
export interface JoinReadHistory {
  readonly records: ReadonlyMap<ScopeAgentJoinReadId, ScopeAgentJoinReadEvent>
  readonly readStateSeq: SessionSeqCursor
  readonly bindingId: ScopeAgentBindingId | null
}

/**
 * Validate replayed operation transitions against original inputs and the Session's intervening read state.
 * @param session - live or detached durable Session.
 * @returns exact operation records and current comparison cursor.
 */
export function joinReadHistory(session: Session): JoinReadHistory {
  const records = new Map<ScopeAgentJoinReadId, ScopeAgentJoinReadEvent>()
  let readStateSeq: SessionSeqCursor = -1
  let bindingId: ScopeAgentBindingId | null = null
  for (const event of session.snapshotEvents()) {
    if (event.type === 'scope-agent-context/state') {
      if (event.data.agentId !== session.id) throw new Error('scope-agent-context: read state belongs to another Session')
      readStateSeq = event.seq
      bindingId = event.data.binding?.id ?? null
      continue
    }
    if (event.type !== 'scope-agent-context/join-read') continue
    const data = joinReadEventSchema.parse(event.data)
    if (data.agentId !== session.id) throw new Error('scope-agent-context: adoption belongs to another Session')
    const prior = records.get(data.adoptionId)
    if (data.phase === 'planned') {
      if (prior !== undefined || data.plan.expectedReadStateSeq !== readStateSeq || bindingId !== null) {
        throw new Error('scope-agent-context: adoption plan lacks its original unbound read state')
      }
    } else if (data.phase === 'adopted') {
      if (prior?.phase !== 'planned' || !isDeepStrictEqual(prior.plan, data.plan)
        || data.plan.expectedReadStateSeq !== readStateSeq || bindingId !== null) {
        throw new Error('scope-agent-context: adoption does not match its pending plan')
      }
      bindingId = data.plan.bindingId
      readStateSeq = event.seq
    } else {
      if ((prior === undefined && data.plan !== null)
        || (prior !== undefined && !isDeepStrictEqual(prior.plan, data.plan))) {
        throw new Error('scope-agent-context: terminal adoption changed its original plan')
      }
      if ((prior?.phase === 'ended' || prior?.phase === 'superseded')
        && (data.phase !== prior.phase || (prior.leaveAdopted && !data.leaveAdopted))) {
        throw new Error('scope-agent-context: terminal adoption cannot change outcome or weaken departure')
      }
      if (data.leaveAdopted && data.plan !== null && bindingId === data.plan.bindingId) {
        bindingId = null
        readStateSeq = event.seq
      }
    }
    records.set(data.adoptionId, data)
  }
  return { records, readStateSeq, bindingId }
}
