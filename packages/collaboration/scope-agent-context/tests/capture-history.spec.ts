/** Original-capture attribution belongs to an explicit adoption interval, never a peer-wide identity. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { peerContributionGrantSchema } from '@deepseek-ai/dsh-development-task/schema'
import { activationSchema, invitationSchema, originalCaptureSchema, projectionDigest, projectionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { joinReadEventSchema, joinReadHistory } from '../src/join-read.ts'
import { routeEventSchema } from '../src/route.ts'
import { contextSourceSchema, initialState, scopeAgentProjection, stateSchema } from '../src/state.ts'
import { snapshotMessage } from '../src/messages.ts'
import { completedMatches, evaluationSchema, goalDigest, requestEvidenceSchema } from '../src/evidence.ts'
import { blocksCurrentCoverage } from '../src/coverage.ts'
import type { ScopeAccessCaptureProjection } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentActivationId, ScopeAgentCompletedEvidence } from '../src/types.ts'

const invitation = invitationSchema.parse({ version: 1, ownerPeerId: 'owner', recipientPeerId: 'source',
  ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner', taskId: 'task-one', grantId: randomUUID(), generation: randomUUID(),
  expiresAt: 4_000_000_000_000, responsibility: 'Review reported changes' })
const originalCapture = originalCaptureSchema.parse({ captureId: randomUUID(), captureGeneration: randomUUID() })
function fixture() {
  const session = Session.create(SessionId(randomUUID()))
  const plan = joinReadEventSchema.parse({ version: 4, agentId: session.id, adoptionId: randomUUID(), phase: 'planned',
    plan: { kind: 'scope', automatic: null, expectedReadStateSeq: -1, bindingId: randomUUID(), subscription: {
      version: 2, originalCapture, id: randomUUID(), generation: randomUUID(), invitation, state: 'active',
    } } })
  if (plan.version !== 4 || plan.phase !== 'planned') throw new Error('Expected a capture-aware plan')
  return { session, plan }
}
function adopt(value: ReturnType<typeof fixture>) {
  value.session.append('scope-agent-context/join-read', value.plan)
  value.session.append('scope-agent-context/join-read', { ...value.plan, phase: 'adopted' })
  return value.session.snapshotEvents().reduce((state, event) => scopeAgentProjection.apply(state, event), initialState(value.session.id))
}
function projection(): ScopeAccessCaptureProjection {
  const grant = peerContributionGrantSchema.parse({ ...originalCapture, version: 1, ownerPeerId: invitation.ownerPeerId,
    contributorPeerId: invitation.recipientPeerId, taskId: invitation.taskId, grantId: randomUUID(), generation: randomUUID(),
    source: { kind: 'tool-observations', name: 'Original author', tools: ['Write'] }, expiresAt: invitation.expiresAt,
    maxSamples: 4, maxSampleBytes: 8000 })
  const value = { version: 3 as const, taskId: invitation.taskId, taskRevision: 1,
    ownerPeerId: invitation.ownerPeerId, recipientPeerId: invitation.recipientPeerId,
    grantId: invitation.grantId, grantGeneration: invitation.generation, expiresAt: invitation.expiresAt,
    backend: { id: 'semantic', revision: 'capture-v1' }, maxContextBytes: 8000, text: 'PEER_FACT',
    selectedSources: [], omittedSources: [], activation: activationSchema.parse({ kind: 'recipient-evidence', version: 1,
      digest: 'a'.repeat(64), coverage: 'complete' }),
    peerCapture: { ...originalCapture, ownerPeerId: invitation.ownerPeerId, contributorPeerId: invitation.recipientPeerId,
      taskId: invitation.taskId, grantId: grant.grantId, generation: grant.generation } }
  // JSON parsing exercises the durable branded-id and digest boundary.
  const parsed = projectionSchema.parse({ ...value, projectionId: projectionDigest(value) })
  if (parsed.version !== 3) throw new Error('Missing capture projection')
  return parsed
}

describe('capture-aware durable receiving', () => {
  it('keeps v1-v3 plans strict and requires an explicit kind plus capture subscription in v4', () => {
    const { plan } = fixture()
    for (const version of [1, 2, 3]) expect(joinReadEventSchema.safeParse({ ...plan, version }).success).toBe(false)
    const { kind, ...withoutKind } = plan.plan
    expect(kind).toBe('scope')
    expect(joinReadEventSchema.safeParse({ ...plan, plan: withoutKind }).success).toBe(false)
    const { originalCapture: removed, version, ...subscription } = plan.plan.subscription
    expect(removed).toEqual(originalCapture)
    expect(version).toBe(2)
    expect(joinReadEventSchema.safeParse({ ...plan, plan: { ...plan.plan, subscription } }).success).toBe(false)
    expect(joinReadEventSchema.safeParse({ ...plan,
      plan: { ...plan.plan, retainedLocal: { bindingId: randomUUID(), automatic: null } } }).success).toBe(false)
  })

  it.each(['captureId', 'captureGeneration'] as const)('rejects a changed %s between plan and adoption', (field) => {
    const { session, plan } = fixture()
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted', plan: { ...plan.plan,
      subscription: { ...plan.plan.subscription,
        originalCapture: originalCaptureSchema.parse({ ...originalCapture, [field]: randomUUID() }) } } })
    expect(() => joinReadHistory(session)).toThrow('pending plan')
  })

  it('persists origin only after adoption and rejects state-only inheritance or same-interval downgrade', () => {
    const value = fixture()
    const state = adopt(value)
    expect(state).toMatchObject({ version: 4, mode: 'passive', binding: { originalCapture } })
    value.session.append('scope-agent-context/state', state)
    expect(joinReadHistory(value.session).bindingId).toBe(state.binding?.id)
    const orphan = Session.create(SessionId(randomUUID()))
    orphan.append('scope-agent-context/state', { ...state, agentId: orphan.id })
    expect(() => joinReadHistory(orphan)).toThrow('original adopted permission')
    if (state.binding === null || state.binding.kind === 'local-task') throw new Error('Missing captured binding')
    const { originalCapture: removed, ...plain } = state.binding
    expect(removed).toEqual(originalCapture)
    expect(stateSchema.safeParse({ ...state, version: 1 }).success).toBe(false)
    expect(stateSchema.safeParse({ ...state, binding: plain }).success).toBe(false)
    value.session.append('scope-agent-context/state', { ...state, version: 1, binding: plain })
    expect(() => joinReadHistory(value.session)).toThrow('change identity')
  })

  it('retains association on route changes and removes it on departure and a new manual interval', () => {
    const value = fixture()
    const state = adopt(value)
    const cursor = joinReadHistory(value.session).readStateSeq
    const route = { version: 2, agentId: value.session.id, bindingId: value.plan.plan.bindingId,
      expectedReadStateSeq: cursor, previousOwnerAddress: invitation.ownerAddress,
      subscription: { ...value.plan.plan.subscription, invitation: { ...invitation, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner' }, routeRevision: 1 } }
    expect(routeEventSchema.safeParse({ ...route, version: 1 }).success).toBe(false)
    value.session.append('scope-agent-context/route', routeEventSchema.parse(route))
    expect(joinReadHistory(value.session).bindingId).toBe(state.binding?.id)
    value.session.append('scope-agent-context/join-read', { ...value.plan, phase: 'ended', leaveAdopted: true })
    const manual = stateSchema.parse({ ...initialState(value.session.id), mode: 'passive',
      binding: { id: randomUUID(), subscriptionId: randomUUID(), invitation } })
    value.session.append('scope-agent-context/state', manual)
    expect(joinReadHistory(value.session).bindingId).toBe(manual.binding?.id)
    value.session.append('scope-agent-context/state', state)
    expect(() => joinReadHistory(value.session)).toThrow('original adopted permission')
  })
})

describe('capture-aware request evidence', () => {
  it('requires matching adopted attribution and a new snapshot version', () => {
    const state = adopt(fixture())
    if (state.binding === null || state.binding.kind === 'local-task') throw new Error('Missing captured binding')
    const binding = state.binding
    const current = projection()
    const message = snapshotMessage(binding, current, 8000)
    expect(message.source).toMatchObject({ version: 2, projection: current })
    expect(contextSourceSchema.safeParse({ ...message.source, version: 1 }).success).toBe(false)
    const { originalCapture: removed, ...manual } = state.binding
    expect(removed).toEqual(originalCapture)
    expect(() => snapshotMessage(manual, current, 8000)).toThrow('original capture binding')
    expect(() => snapshotMessage({ ...binding, originalCapture: originalCaptureSchema.parse({ ...originalCapture,
      captureGeneration: randomUUID() }) }, current, 8000)).toThrow('original capture binding')
  })

  it('uses recipient evidence and blocked coverage for v3 without conflating distinct capture generations', () => {
    const state = adopt(fixture())
    if (state.binding === null) throw new Error('Missing binding')
    const current = projection()
    const request = requestEvidenceSchema.parse({ version: 4, turn: 1, step: 1, bindingId: state.binding.id,
      activationId: randomUUID() as ScopeAgentActivationId, goalDigest: goalDigest('Review'), projection: current,
      contextSeq: 1, maxContextBytes: 8000 })
    const completed: ScopeAgentCompletedEvidence = { request, requestSeq: SessionSeq(2),
      assistantSeq: SessionSeq(3), turnEndSeq: SessionSeq(4) }
    const revised = { ...current, text: 'Equivalent independently rendered representation', taskRevision: 2 }
    const sameEvidence = { ...revised, projectionId: projectionDigest(revised) }
    expect(completedMatches(completed, state.binding.id, request.goalDigest, sameEvidence, 8000)).toBe(true)
    const different = { ...current, peerCapture: { ...current.peerCapture,
      captureGeneration: originalCaptureSchema.parse({ ...originalCapture, captureGeneration: randomUUID() }).captureGeneration } }
    expect(completedMatches(completed, state.binding.id, request.goalDigest,
      { ...different, projectionId: projectionDigest(different) }, 8000)).toBe(false)
    if (current.activation.kind !== 'recipient-evidence') throw new Error('Missing semantic evidence')
    expect(blocksCurrentCoverage({ ...current, activation: { ...current.activation, coverage: 'blocked-current' as const } }, false)).toBe(true)
    expect(requestEvidenceSchema.safeParse({ ...request, version: 1 }).success).toBe(false)
    expect(requestEvidenceSchema.safeParse({ ...request, localContextSeq: 2 }).success).toBe(false)
    const evaluation = { version: 4, decision: 'activate', bindingId: request.bindingId, goalDigest: request.goalDigest,
      projection: current, maxContextBytes: 8000, activationId: request.activationId, baseline: null }
    expect(evaluationSchema.safeParse(evaluation).success).toBe(true)
    expect(evaluationSchema.safeParse({ ...evaluation, version: 1 }).success).toBe(false)
  })
})
