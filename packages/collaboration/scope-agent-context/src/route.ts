/** Durable same-authority route changes, independent of scheduling permission. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import { sameReadGrant, legacySubscriptionSchema, captureSubscriptionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import type { ScopeAgentBindingId, ScopeAgentBindingStatus, ScopeAgentRouteEvent } from './types.ts'

const routeFields = {
  agentId: z.string().min(1).transform(SessionId), bindingId: z.uuid().transform(value => value as ScopeAgentBindingId),
  expectedReadStateSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor),
  previousOwnerAddress: z.string().min(1).max(2048),
}
const activeRouteFields = { state: z.literal('active'), routeRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }

/** Strict persisted route intent preserves the original capture association in version 2. */
export const routeEventSchema: z.ZodType<ScopeAgentRouteEvent> = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...routeFields,
    subscription: legacySubscriptionSchema.extend(activeRouteFields) }).strict(),
  z.object({ version: z.literal(2), ...routeFields,
    subscription: captureSubscriptionSchema.extend(activeRouteFields) }).strict(),
])

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
    || !sameReadGrant(binding.invitation, event.subscription.invitation)
    || !isDeepStrictEqual(binding.originalCapture, event.subscription.version === 2 ? event.subscription.originalCapture : undefined)) {
    throw new Error('scope-agent-context: route intent changed read authority')
  }
  directAddress(event.subscription.invitation.ownerAddress, binding.invitation.ownerPeerId)
  return { ...state, binding: { ...binding, invitation: event.subscription.invitation } }
}
