/** Replay validation and the whole-state native scope projection. */

import { z } from 'zod'
import { policySchema } from './policy.ts'
import { foldRoute, routeEventSchema } from './route.ts'
import { foldJoinRead, joinReadEventSchema } from './join-read.ts'
import { localContextTargetSchema } from '@deepseek-ai/dsh-development-task-context/local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { invitationSchema, projectionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentActivationId, ScopeAgentBindingId, ScopeAgentBindingStatus, ScopeAgentContextSource, ScopeAgentPulseSource } from './types.ts'

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const bindingId = z.uuid().transform(value => value as ScopeAgentBindingId)
const activationId = z.uuid().transform(value => value as ScopeAgentActivationId)

export { policySchema } from './policy.ts'

const schedulingFields = {
  agentId: z.string().min(1).transform(SessionId),
  automatic: policySchema.nullable(), mode: z.enum(['passive', 'enabled', 'paused', 'left']),
  pauseReason: z.enum(['user', 'restored', 'cancelled', 'turn-ended', 'step-limit', 'budget', 'conflict', 'unavailable', 'terminal', 'failed', 'coverage']).nullable(),
  usedBudget: natural, lastActivationAt: natural.nullable(),
  pendingActivation: z.object({ id: activationId, bindingId }).strict().nullable(),
}
const remoteState = z.object({ ...schedulingFields, version: z.literal(1),
  binding: z.object({ id: bindingId, subscriptionId: z.uuid().transform(value => value as ScopeSubscriptionId),
    invitation: invitationSchema }).strict().nullable() }).strict()
const retainedLocalSchema = z.object({ bindingId, automatic: policySchema.nullable() }).strict()

const localState = z.object({ ...schedulingFields, version: z.literal(2),
  binding: z.object({ kind: z.literal('local-task'), id: bindingId, target: localContextTargetSchema }).strict() }).strict()

const compositeState = z.object({ ...schedulingFields, version: z.literal(3),
  binding: z.object({ kind: z.literal('local-task-scope'), id: bindingId, target: localContextTargetSchema,
    subscriptionId: z.uuid().transform(value => value as ScopeSubscriptionId), invitation: invitationSchema,
    retainedLocal: retainedLocalSchema }).strict() }).strict()

/** Whole-state parser retains prior readers and requires explicit combined authority in version 3. */
export const stateSchema: z.ZodType<ScopeAgentBindingStatus> = z.discriminatedUnion('version', [remoteState, localState, compositeState]).superRefine((state, ctx) => {
  if ((state.version === 3 && state.binding.id === state.binding.retainedLocal.bindingId)
    || (state.mode === 'left') !== (state.binding === null)
    || (state.mode === 'enabled' && state.automatic === null)
    || (state.pendingActivation !== null && (state.binding?.id !== state.pendingActivation.bindingId
      || state.automatic === null || state.usedBudget === 0))) {
    ctx.addIssue({ code: 'custom', message: 'native scope binding and scheduling state disagree' })
  }
})

/** Exact received projection or an explicit current-context withdrawal. */
export const contextSourceSchema: z.ZodType<ScopeAgentContextSource> = z.discriminatedUnion('form', [
  z.object({ kind: z.literal('scope-agent-context'), version: z.literal(1), form: z.literal('snapshot'), bindingId,
    subscriptionId: z.uuid().transform(value => value as ScopeSubscriptionId), projection: projectionSchema }).strict(),
  z.object({ kind: z.literal('scope-agent-context'), version: z.literal(1), form: z.literal('withdrawn'),
    reason: z.enum(['left', 'revoked', 'expired', 'unavailable', 'conflict', 'failed']) }).strict(),
])

/** The pulse carries local permission identity, never remote message text. */
export const pulseSourceSchema: z.ZodType<ScopeAgentPulseSource> = z.object({
  kind: z.literal('scope-agent-pulse'), version: z.literal(1), bindingId, activationId,
}).strict()

/**
 * Initialize an unbound Session without inheriting another Session's authorization.
 * @param agentId - Session whose local authority is being read.
 * @returns empty scheduling state.
 */
export function initialState(agentId: SessionId): ScopeAgentBindingStatus {
  return { version: 1, agentId, binding: null, automatic: null, mode: 'left', pauseReason: null,
    usedBudget: 0, lastActivationAt: null, pendingActivation: null }
}

/** Session events, not storage cache rows, own binding and consumed activation counts. */
export const scopeAgentProjection = {
  key: 'scopeAgentContext', stateVersion: 1, stateSchema,
  wire: { viewSchema: stateSchema, view: state => state },
  init: header => initialState(header.id),
  apply: (state, event) => {
    if (event.type === 'scope-agent-context/route') return foldRoute(state, routeEventSchema.parse(event.data))
    if (event.type === 'scope-agent-context/join-read') return foldJoinRead(state, joinReadEventSchema.parse(event.data))
    if (event.type === 'turn/end') {
      const paused = state.mode === 'enabled' && event.data.reason.kind !== 'completed'
      if (state.pendingActivation === null && !paused) return state
      return { ...state, pendingActivation: null,
        ...(paused ? { mode: 'paused', pauseReason: 'turn-ended' } as const : {}) }
    }
    if (event.type !== 'scope-agent-context/state') return state
    const next = stateSchema.parse(event.data)
    if (next.agentId !== state.agentId) return state
    if (next.usedBudget < state.usedBudget) throw new Error('scope-agent-context: reservation count decreased')
    return next
  },
} satisfies ProjectionDefinition<'scopeAgentContext'>
