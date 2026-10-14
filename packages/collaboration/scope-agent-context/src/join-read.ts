/** Durable joint-join ownership and exact local read-state comparison. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { routeEventSchema } from './route.ts'
import { localContextTargetSchema } from '@deepseek-ai/dsh-development-task-context/local'
import { policySchema } from './policy.ts'
import type { Session, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { invitationSchema, sameReadGrant, captureSubscriptionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeGeneration, ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentBindingId, ScopeAgentBindingStatus, ScopeAgentJoinReadEvent, ScopeAgentJoinReadId, ScopeAgentRouteEvent, ScopeAgentBinding, ScopeAgentAutomaticPolicy, ScopeAgentCompositeJoinReadPlan, ScopeAgentCaptureJoinReadPlan } from './types.ts'

const cursor = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor)
const planSchema = z.object({
  expectedReadStateSeq: cursor,
  subscription: z.object({
    id: z.uuid().transform(value => value as ScopeSubscriptionId),
    generation: z.uuid().transform(value => value as ScopeGeneration),
    invitation: invitationSchema, state: z.literal('active'),
  }).strict(),
  bindingId: z.uuid().transform(value => value as ScopeAgentBindingId),
}).strict()
const retainedLocalSchema = z.object({ bindingId: z.uuid().transform(value => value as ScopeAgentBindingId),
  automatic: policySchema.nullable() }).strict()
const compositePlanSchema = planSchema.extend({ expectedBindingId: z.uuid().transform(value => value as ScopeAgentBindingId).nullable(),
  target: localContextTargetSchema, retainedLocal: retainedLocalSchema, automatic: policySchema.nullable() })
const capturePlanFields = { ...planSchema.shape,
  subscription: captureSubscriptionSchema.omit({ routeRevision: true }).extend({ state: z.literal('active') }), automatic: policySchema.nullable() }
const capturePlanSchema = z.discriminatedUnion('kind', [
  z.object({ ...capturePlanFields, kind: z.literal('scope') }).strict(),
  z.object({ ...capturePlanFields, kind: z.literal('local-task-scope'), expectedBindingId: compositePlanSchema.shape.expectedBindingId,
    target: localContextTargetSchema, retainedLocal: retainedLocalSchema }).strict(),
])
const common = { version: z.literal(1), agentId: z.string().min(1).transform(SessionId),
  adoptionId: z.uuid().transform(value => value as ScopeAgentJoinReadId) }

/** Strict durable parser; terminal records retain the original plan when one exists. */
export const joinReadEventSchema: z.ZodType<ScopeAgentJoinReadEvent> = z.union([
  z.object({ ...common, phase: z.enum(['planned', 'adopted']), plan: planSchema }).strict(),
  z.object({ ...common, phase: z.enum(['ended', 'superseded']), plan: planSchema.nullable(), leaveAdopted: z.boolean() }).strict(),
  z.object({ ...common, version: z.literal(2), phase: z.enum(['planned', 'adopted']),
    plan: planSchema.extend({ automatic: policySchema }) }).strict(),
  z.object({ ...common, version: z.literal(2), phase: z.enum(['ended', 'superseded']),
    plan: planSchema.extend({ automatic: policySchema }).nullable(), leaveAdopted: z.boolean() }).strict(),
  z.object({ ...common, version: z.literal(3), phase: z.enum(['planned', 'adopted']), plan: compositePlanSchema }).strict(),
  z.object({ ...common, version: z.literal(3), phase: z.enum(['ended', 'superseded']),
    plan: compositePlanSchema.nullable(), leaveAdopted: z.boolean() }).strict(),
  z.object({ ...common, version: z.literal(4), phase: z.enum(['planned', 'adopted']), plan: capturePlanSchema }).strict(),
  z.object({ ...common, version: z.literal(4), phase: z.enum(['ended', 'superseded']),
    plan: capturePlanSchema.nullable(), leaveAdopted: z.boolean() }).strict(),
])

/** Read only the retained local responsibility of an explicitly composite adoption.
 * @param event - Validated historical or current join transition.
 * @returns The original local plan, or undefined for remote-only receiving.
 */
export function joinCompositePlan(event: ScopeAgentJoinReadEvent): ScopeAgentCompositeJoinReadPlan | Extract<ScopeAgentCaptureJoinReadPlan, { kind: 'local-task-scope' }> | undefined {
  if (event.version === 3) return event.plan ?? undefined
  return event.version === 4 && event.plan?.kind === 'local-task-scope' ? event.plan : undefined
}

/** Identify plans whose local or execution permission must remain owned by the live command.
 * @param event - Original adoption plan or terminal transition.
 * @returns Whether adoption requires its original live consent token.
 */
export function joinUsesLiveConsent(event: ScopeAgentJoinReadEvent): boolean {
  return joinCompositePlan(event) !== undefined || (event.version !== 1 && event.plan !== null && event.plan.automatic !== null)
}

function adoptedBinding(event: Extract<ScopeAgentJoinReadEvent, { phase: 'planned' | 'adopted' }>): ScopeAgentBinding {
  const { subscription, bindingId } = event.plan
  const original = event.version === 4 ? { originalCapture: event.plan.subscription.originalCapture } : {}
  const local = joinCompositePlan(event)
  return local === undefined ? { id: bindingId, subscriptionId: subscription.id, invitation: subscription.invitation, ...original }
    : { kind: 'local-task-scope', id: bindingId, target: local.target, subscriptionId: subscription.id,
      invitation: subscription.invitation, retainedLocal: local.retainedLocal, ...original }
}

/**
 * Apply one atomic adoption or owned departure without resetting lifetime reservations.
 * @param state - preceding scheduling state.
 * @param event - validated adoption record.
 * @returns current binding state; composite plans pause existing local scheduling, and unrelated terminal records preserve it.
 */
export function foldJoinRead(state: ScopeAgentBindingStatus, event: ScopeAgentJoinReadEvent): ScopeAgentBindingStatus {
  if (event.agentId !== state.agentId) throw new Error('scope-agent-context: adoption belongs to another Session')
  if (event.phase === 'planned' && joinCompositePlan(event) !== undefined && state.binding !== null) return { ...state,
    mode: state.automatic === null ? 'passive' : 'paused', pauseReason: state.automatic === null ? null : 'user',
    pendingActivation: null }
  if (event.phase === 'adopted') {
    const automatic = event.version !== 1 ? event.plan.automatic : null
    return { ...state, version: event.version === 4 ? 4 : event.version === 3 ? 3 : 1,
      binding: adoptedBinding(event), automatic, mode: automatic === null ? 'passive' : 'enabled',
      pauseReason: null, pendingActivation: null }
  }
  if ((event.phase === 'ended' || event.phase === 'superseded') && event.leaveAdopted
    && event.plan !== null && state.binding?.id === event.plan.bindingId) {
    return departedState(state)
  }
  return state
}

/**
 * Restore retained local permission as a fresh paused interval, preserving lifetime consumption.
 * @param state - current interval being left.
 * @returns local-only permission or an unbound remote-only state.
 */
export function departedState(state: ScopeAgentBindingStatus): ScopeAgentBindingStatus {
  const binding = state.binding
  if (binding?.kind === 'local-task-scope') return { ...state, version: 2,
    binding: { kind: 'local-task', id: binding.retainedLocal.bindingId, target: binding.target },
    automatic: binding.retainedLocal.automatic, mode: binding.retainedLocal.automatic === null ? 'passive' : 'paused',
    pauseReason: binding.retainedLocal.automatic === null ? null : 'user', pendingActivation: null }
  return { ...state, version: 1, binding: null, automatic: null, mode: 'left', pauseReason: null, pendingActivation: null }
}

/** Parsed original operations and the last event that actually changed reading management. */
export interface JoinReadHistory {
  readonly records: ReadonlyMap<ScopeAgentJoinReadId, ScopeAgentJoinReadEvent>
  readonly readStateSeq: SessionSeqCursor
  readonly bindingId: ScopeAgentBindingId | null
  readonly routes: ReadonlyMap<ScopeAgentBindingId, { readonly event: ScopeAgentRouteEvent; readonly seq: SessionSeqCursor }>
}

/**
 * Validate replayed operation transitions against original inputs and the Session's intervening read state.
 * @param session - live or detached durable Session.
 * @returns exact operation records and current comparison cursor.
 */
export function joinReadHistory(session: Session): JoinReadHistory {
  const records = new Map<ScopeAgentJoinReadId, ScopeAgentJoinReadEvent>()
  const routes = new Map<ScopeAgentBindingId, { event: ScopeAgentRouteEvent; seq: SessionSeqCursor }>()
  let binding: ScopeAgentBinding | null = null
  let readStateSeq: SessionSeqCursor = -1
  let bindingId: ScopeAgentBindingId | null = null
  let usedBudget = 0
  let automatic: ScopeAgentAutomaticPolicy | null = null
  for (const event of session.snapshotEvents()) {
    if (event.type === 'scope-agent-context/state') {
      if (event.data.agentId !== session.id) throw new Error('scope-agent-context: read state belongs to another Session')
      const next = event.data.binding
      if (next !== null && next.kind !== 'local-task' && next.originalCapture !== undefined) {
        const origin = [...records.values()].find(record => record.version === 4 && record.plan?.bindingId === next.id)
        if (binding?.id !== next.id || origin === undefined || origin.version !== 4 || origin.plan === null || origin.phase === 'planned'
          || ((origin.phase === 'ended' || origin.phase === 'superseded') && origin.leaveAdopted)
          || origin.plan.subscription.id !== next.subscriptionId
          || !sameReadGrant(origin.plan.subscription.invitation, next.invitation)
          || !isDeepStrictEqual(origin.plan.subscription.originalCapture, next.originalCapture)) {
          throw new Error('scope-agent-context: capture state lacks its original adopted permission')
        }
      }
      if (binding !== null && binding.kind !== 'local-task' && binding.originalCapture !== undefined
        && next?.id === binding.id && (next.kind === 'local-task' || !isDeepStrictEqual(binding.originalCapture, next.originalCapture))) {
        throw new Error('scope-agent-context: capture state cannot change identity within its adopted interval')
      }
      usedBudget = event.data.usedBudget
      automatic = event.data.automatic
      readStateSeq = event.seq
      binding = event.data.binding
      bindingId = binding?.id ?? null
      continue
    }
    if (event.type === 'scope-agent-context/route') {
      const data = routeEventSchema.parse(event.data)
      const previous = routes.get(data.bindingId)
      if (data.agentId !== session.id || data.expectedReadStateSeq !== readStateSeq || binding === null
        || binding.kind === 'local-task' || binding.id !== data.bindingId || binding.subscriptionId !== data.subscription.id
        || binding.invitation.ownerAddress !== data.previousOwnerAddress
        || !sameReadGrant(binding.invitation, data.subscription.invitation)
        || !isDeepStrictEqual(binding.originalCapture, data.subscription.version === 2 ? data.subscription.originalCapture : undefined)
        || data.subscription.routeRevision !== (previous?.event.subscription.routeRevision ?? 0) + 1) {
        throw new Error('scope-agent-context: route intent lacks its exact preceding read state')
      }
      routes.set(data.bindingId, { event: data, seq: event.seq })
      binding = { ...binding, invitation: data.subscription.invitation }
      readStateSeq = event.seq
      continue
    }
    if (event.type !== 'scope-agent-context/join-read') continue
    const data = joinReadEventSchema.parse(event.data)
    if (data.agentId !== session.id) throw new Error('scope-agent-context: adoption belongs to another Session')
    const prior = records.get(data.adoptionId)
    if ((data.phase === 'planned' || data.phase === 'adopted') && data.version !== 1 && data.plan.automatic !== null
      && data.plan.automatic.activationLimit <= usedBudget) {
      throw new Error('scope-agent-context: automatic adoption has no remaining lifetime budget')
    }
    if (prior !== undefined && prior.version !== data.version) {
      throw new Error('scope-agent-context: adoption changed its original event version')
    }
    if (data.phase === 'planned') {
      if (prior !== undefined || data.plan.expectedReadStateSeq !== readStateSeq || !matchesPredecessor(data, binding, automatic)) {
        throw new Error('scope-agent-context: adoption plan lacks its original unbound read state')
      }
    } else if (data.phase === 'adopted') {
      if (prior?.phase !== 'planned' || !isDeepStrictEqual(prior.plan, data.plan)
        || data.plan.expectedReadStateSeq !== readStateSeq || !matchesPredecessor(data, binding, automatic)) {
        throw new Error('scope-agent-context: adoption does not match its pending plan')
      }
      automatic = data.version === 1 ? null : data.plan.automatic
      bindingId = data.plan.bindingId
      binding = adoptedBinding(data)
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
        automatic = binding?.kind === 'local-task-scope' ? binding.retainedLocal.automatic : null
        binding = binding?.kind === 'local-task-scope'
          ? { kind: 'local-task', id: binding.retainedLocal.bindingId, target: binding.target } : null
        bindingId = binding?.id ?? null
        readStateSeq = event.seq
      }
    }
    records.set(data.adoptionId, data)
  }
  return { records, readStateSeq, bindingId, routes }
}

function matchesPredecessor(event: Extract<ScopeAgentJoinReadEvent, { phase: 'planned' | 'adopted' }>,
  binding: ScopeAgentBinding | null, automatic: ScopeAgentAutomaticPolicy | null): boolean {
  const plan = joinCompositePlan(event)
  if (plan === undefined) return binding === null
  return isDeepStrictEqual(plan.retainedLocal.automatic, binding === null ? null : automatic)
    && plan.expectedBindingId === (binding?.id ?? null)
    && (binding === null || (binding.kind === 'local-task' && isDeepStrictEqual(binding.target, plan.target)))
    && plan.retainedLocal.bindingId !== plan.bindingId
    && plan.retainedLocal.bindingId !== plan.expectedBindingId
}
