import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { invitationSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { joinReadEventSchema, joinReadHistory } from '../src/join-read.ts'
import { initialState, scopeAgentProjection } from '../src/state.ts'
import type { ScopeAgentJoinReadEvent } from '../src/types.ts'

const invitation = invitationSchema.parse({ version: 1, ownerPeerId: 'owner', recipientPeerId: 'source',
  ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner', taskId: 'task-one', grantId: randomUUID(), generation: randomUUID(),
  expiresAt: 4_000_000_000_000, responsibility: 'Review reported changes' })

function planned(session: Session): Extract<ScopeAgentJoinReadEvent, { version: 1; phase: 'planned' | 'adopted' }> {
  const value = joinReadEventSchema.parse({ version: 1, agentId: session.id, adoptionId: randomUUID(), phase: 'planned',
    plan: { expectedReadStateSeq: -1, bindingId: randomUUID(), subscription: {
      id: randomUUID(), generation: randomUUID(), invitation, state: 'active',
    } } })
  if (value.version !== 1 || value.phase !== 'planned') throw new Error('fixture plan must be pending and passive')
  return value
}
function create() { return Session.create(SessionId(randomUUID())) }
function replay(session: Session) {
  return session.snapshotEvents().reduce((state, event) => scopeAgentProjection.apply(state, event), initialState(session.id))
}

describe('durable joint read adoption history', () => {
  it('uses only reading management events for CAS and adopts passively once', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary input' }] }), { surfaceOp: 'append' })
    expect(joinReadHistory(session).readStateSeq).toBe(-1)
    const adopted = session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    expect(joinReadHistory(session)).toMatchObject({ readStateSeq: adopted.seq, bindingId: plan.plan.bindingId })
    expect(replay(session)).toMatchObject({ mode: 'passive', automatic: null, pendingActivation: null,
      binding: { id: plan.plan.bindingId, subscriptionId: plan.plan.subscription.id } })
  })

  it('rejects adopted records without their original plan', () => {
    const session = create()
    session.append('scope-agent-context/join-read', { ...planned(session), phase: 'adopted' })
    expect(() => joinReadHistory(session)).toThrow('pending plan')
  })

  it('rejects adoption after a manual bind then leave even when reading is unbound again', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    const binding = { id: plan.plan.bindingId, subscriptionId: plan.plan.subscription.id, invitation }
    session.append('scope-agent-context/state', { ...initialState(session.id), binding, mode: 'passive' })
    session.append('scope-agent-context/state', initialState(session.id))
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    expect(() => joinReadHistory(session)).toThrow('pending plan')
  })

  it.each(['planned', 'adopted'] as const)('refuses %s after cancellation', (phase) => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', leaveAdopted: false })
    session.append('scope-agent-context/join-read', { ...plan, phase })
    expect(() => joinReadHistory(session)).toThrow(phase === 'planned' ? 'original unbound' : 'pending plan')
  })

  it('retains cancel-before-apply tombstones and refuses later plans', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', plan: null, leaveAdopted: false })
    session.append('scope-agent-context/join-read', plan)
    expect(() => joinReadHistory(session)).toThrow('original unbound')
  })

  it('allows exact terminal retries and strengthening departure, but never weakening it', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    const terminal = { ...plan, phase: 'ended', leaveAdopted: false } as const
    session.append('scope-agent-context/join-read', terminal)
    session.append('scope-agent-context/join-read', terminal)
    expect(joinReadHistory(session).bindingId).toBe(plan.plan.bindingId)
    const departure = session.append('scope-agent-context/join-read', { ...terminal, leaveAdopted: true })
    expect(joinReadHistory(session)).toMatchObject({ bindingId: null, readStateSeq: departure.seq })
    expect(replay(session).binding).toBeNull()
    session.append('scope-agent-context/join-read', terminal)
    expect(() => joinReadHistory(session)).toThrow('weaken departure')
  })

  it('does not let old departure clear a later manual binding', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    const later = planned(create()).plan
    const state = { ...initialState(session.id), mode: 'passive' as const,
      binding: { id: later.bindingId, subscriptionId: later.subscription.id, invitation } }
    const manual = session.append('scope-agent-context/state', state)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'superseded', leaveAdopted: true })
    expect(joinReadHistory(session)).toMatchObject({ bindingId: later.bindingId, readStateSeq: manual.seq })
    expect(replay(session)).toEqual(state)
  })

  it('rejects a changed subscription or invitation in an otherwise well-formed adopted record', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted', plan: {
      ...plan.plan, subscription: { ...plan.plan.subscription, invitation: { ...invitation, responsibility: 'Different authority' } },
    } })
    expect(() => joinReadHistory(session)).toThrow('pending plan')
  })

  it('keeps old Sessions without adoption events readable', () => {
    const session = create()
    session.append('scope-agent-context/state', initialState(session.id))
    expect(joinReadHistory(session).records.size).toBe(0)
    expect(replay(session)).toEqual(initialState(session.id))
  })
})

const automatic = { goal: 'Review authorized updates', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 }

function automaticPlan(session: Session) {
  const original = planned(session)
  return { ...original, version: 2 as const, plan: { ...original.plan, automatic } }
}

describe('explicit automatic joint adoption records', () => {
  it('keeps passive v1 strict and requires an explicit policy in v2', () => {
    const plan = planned(create())
    expect(joinReadEventSchema.safeParse({ ...plan, plan: { ...plan.plan, automatic } }).success).toBe(false)
    expect(joinReadEventSchema.safeParse({ ...plan, version: 2 }).success).toBe(false)
    expect(joinReadEventSchema.parse(automaticPlan(create())).version).toBe(2)
  })

  it('adopts binding and policy atomically while retaining lifetime budget', () => {
    const session = create()
    const state = session.append('scope-agent-context/state', { ...initialState(session.id), usedBudget: 1 })
    const value = automaticPlan(session)
    const plan = { ...value, plan: { ...value.plan, expectedReadStateSeq: state.seq } }
    session.append('scope-agent-context/join-read', plan)
    expect(replay(session)).toMatchObject({ binding: null, automatic: null, usedBudget: 1 })
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    expect(joinReadHistory(session).bindingId).toBe(plan.plan.bindingId)
    expect(replay(session)).toMatchObject({ mode: 'enabled', automatic, usedBudget: 1,
      binding: { id: plan.plan.bindingId }, pendingActivation: null })
  })

  it('rejects changing accepted automatic permission at adoption', () => {
    const session = create()
    const plan = automaticPlan(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted',
      plan: { ...plan.plan, automatic: { ...automatic, activationLimit: 3 } } })
    expect(() => joinReadHistory(session)).toThrow('pending plan')
  })

  it('rejects switching a pending passive record to automatic', () => {
    const session = create()
    const plan = planned(session)
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, version: 2, phase: 'adopted',
      plan: { ...plan.plan, automatic } })
    expect(() => joinReadHistory(session)).toThrow('original event version')
  })

  it('rejects an automatic plan that grants no remaining lifetime activation', () => {
    const session = create()
    const state = session.append('scope-agent-context/state', { ...initialState(session.id), usedBudget: 2 })
    const value = automaticPlan(session)
    session.append('scope-agent-context/join-read', { ...value, plan: { ...value.plan, expectedReadStateSeq: state.seq } })
    expect(() => joinReadHistory(session)).toThrow('remaining lifetime budget')
  })
})
