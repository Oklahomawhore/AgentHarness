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

function planned(session: Session): Extract<ScopeAgentJoinReadEvent, { phase: 'planned' | 'adopted' }> {
  const value = joinReadEventSchema.parse({ version: 1, agentId: session.id, adoptionId: randomUUID(), phase: 'planned',
    plan: { expectedReadStateSeq: -1, bindingId: randomUUID(), subscription: {
      id: randomUUID(), generation: randomUUID(), invitation, state: 'active',
    } } })
  if (value.phase !== 'planned') throw new Error('fixture plan must be pending')
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
