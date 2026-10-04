/** Durable same-authority route changes, independent of scheduling permission. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import { invitationSchema, sameReadGrant } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeGeneration, ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import type { ScopeAgentBindingId, ScopeAgentBindingStatus, ScopeAgentRouteEvent } from './types.ts'

/** Strict persisted route intent; revision zero belongs to historical subscriptions only. */
export const routeEventSchema: z.ZodType<ScopeAgentRouteEvent> = z.object({
  version: z.literal(1), agentId: z.string().min(1).transform(SessionId),
  bindingId: z.uuid().transform(value => value as ScopeAgentBindingId),
  expectedReadStateSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor),
  previousOwnerAddress: z.string().min(1).max(2048),
  subscription: z.object({
    id: z.uuid().transform(value => value as ScopeSubscriptionId),
    generation: z.uuid().transform(value => value as ScopeGeneration), invitation: invitationSchema,
    state: z.literal('active'), routeRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict()

/**
 * Change only the route of the still-owned read binding.
 * @param state - preceding native scheduling state.
 * @param event - parsed route intent.
 * @returns the same policy, budget, and identities with the new address.
 */
export function foldRoute(state: ScopeAgentBindingStatus, event: ScopeAgentRouteEvent): ScopeAgentBindingStatus {
  const binding = state.binding
  if (state.agentId !== event.agentId || binding === null || binding.kind === 'local-task'
    || binding.id !== event.bindingId || binding.subscriptionId !== event.subscription.id
    || binding.invitation.ownerAddress !== event.previousOwnerAddress
    || !sameReadGrant(binding.invitation, event.subscription.invitation)) {
    throw new Error('scope-agent-context: route intent changed read authority')
  }
  directAddress(event.subscription.invitation.ownerAddress, binding.invitation.ownerPeerId)
  return { ...state, binding: { ...binding, invitation: event.subscription.invitation } }
}
