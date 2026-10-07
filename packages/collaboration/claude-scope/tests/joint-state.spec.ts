import { describe, expect, it } from 'vitest'
import { jointSchema } from '../src/joint-state.ts'

const address = '/ip4/127.0.0.1/tcp/7000/p2p/owner'
const expiresAt = 2000000000000

function waitingRecord() {
  return {
    id: 'joint-original',
    proposal: { contributorPeerId: 'recipient-peer', captureId: 'capture-original', captureGeneration: 'capture-generation',
      source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } },
    entry: { version: 2, kind: 'scope-group-entry', sourceKind: 'tool-observations',
      entryId: '10000000-0000-4000-8000-000000000001', taskId: 'task-original', ownerPeerId: 'owner-peer',
      ownerAddress: address, expiresAt, maxMembers: 4 },
    limits: { expiresAt, maxSamples: 8, maxSampleBytes: 4096 },
    expectedReadRevision: 3, authorizedReadRevision: 3, cleanupPending: false,
    state: 'waiting', intent: 'adopt', ready: false, routeRevision: 0, routePending: false,
  }
}

function activeRecord() {
  const waiting = waitingRecord()
  return { ...waiting, state: 'active', ready: true, authorizedReadRevision: 4, adoptedReadRevision: 4,
    subscription: { version: 2, id: '20000000-0000-4000-8000-000000000001',
      generation: '20000000-0000-4000-8000-000000000002', state: 'active', routeRevision: 0,
      originalCapture: { captureId: waiting.proposal.captureId, captureGeneration: waiting.proposal.captureGeneration },
      invitation: { version: 1, ownerPeerId: waiting.entry.ownerPeerId, ownerAddress: address,
        recipientPeerId: waiting.proposal.contributorPeerId, taskId: waiting.entry.taskId,
        grantId: '30000000-0000-4000-8000-000000000001', generation: '30000000-0000-4000-8000-000000000002',
        expiresAt, responsibility: 'Maintain the recipient implementation' } },
    contributionInvitation: { version: 1, kind: 'tool-contribution', ownerAddress: address,
      grant: { version: 1, ownerPeerId: waiting.entry.ownerPeerId, taskId: waiting.entry.taskId,
        grantId: 'contribution-grant', generation: 'contribution-generation', ...waiting.proposal, ...waiting.limits } },
  }
}

function parseStored(record: unknown) {
  const stored: unknown = JSON.parse(JSON.stringify(record))
  return jointSchema.safeParse(stored)
}

function expectRelationshipRejected(record: unknown) {
  const parsed = parseStored(record)
  expect(parsed.success).toBe(false)
  if (parsed.success) throw new Error('Changed durable association was accepted')
  expect(parsed.error.issues).toContainEqual(expect.objectContaining({ code: 'custom',
    message: 'joint consent, original capture, and selected permissions disagree' }))
}

describe('persisted Claude joint consent', () => {
  it('retains waiting consent without inventing a receiving plan or activation', () => {
    const waiting = waitingRecord()
    const parsed = jointSchema.parse(JSON.parse(JSON.stringify(waiting)))
    expect(parsed).toEqual(waiting)
    expect(parsed).not.toHaveProperty('subscription')
    expect(parsed).not.toHaveProperty('contributionInvitation')
  })

  it('retains the complete approved permissions and exact source association through serialization', () => {
    const active = activeRecord()
    expect(parseStored(active)).toEqual({ success: true, data: active })
    const stopped = { ...active, intent: 'leave', cleanupPending: true }
    expect(parseStored(stopped)).toEqual({ success: true, data: stopped })
  })

  it.each(['waiting', 'adopting', 'ended'])('rejects %s readiness without an owner-selected subscription', (state) => {
    expectRelationshipRejected({ ...waitingRecord(), state, ready: true })
  })

  it('rejects pending subscription cleanup when no receiving plan was ever retained', () => {
    expectRelationshipRejected({ ...waitingRecord(), state: 'ended', intent: 'leave', cleanupPending: true })
  })

  it('rejects half of an approved receiving plan and active state without an adoption revision', () => {
    const active = activeRecord()
    const { subscription: _subscription, ...withoutSubscription } = active
    const { contributionInvitation: _invitation, ...withoutInvitation } = active
    const { adoptedReadRevision: _revision, ...withoutRevision } = active
    expectRelationshipRejected(withoutSubscription)
    expectRelationshipRejected(withoutInvitation)
    expectRelationshipRejected(withoutRevision)
  })

  it('rejects contribution-only entries masquerading as joint receiving consent', () => {
    const waiting = waitingRecord()
    const { maxMembers: _members, ...entry } = waiting.entry
    expectRelationshipRejected({ ...waiting, entry: { ...entry, version: 1, kind: 'contribution-entry' } })
  })

  it.each(['captureId', 'captureGeneration'] as const)('rejects another original %s even on the same recipient peer', (field) => {
    const active = activeRecord()
    expectRelationshipRejected({ ...active, subscription: { ...active.subscription,
      originalCapture: { ...active.subscription.originalCapture, [field]: 'another-source' } } })
  })

  it.each(['ownerPeerId', 'taskId', 'contributorPeerId', 'captureId', 'captureGeneration'] as const)(
    'rejects a contribution grant with a different %s', (field) => {
      const active = activeRecord()
      expectRelationshipRejected({ ...active, contributionInvitation: { ...active.contributionInvitation,
        grant: { ...active.contributionInvitation.grant, [field]: 'another-identity' } } })
    })

  it('rejects a contribution grant that changes the originally selected tools', () => {
    const active = activeRecord()
    expectRelationshipRejected({ ...active, contributionInvitation: { ...active.contributionInvitation,
      grant: { ...active.contributionInvitation.grant, source: { ...active.proposal.source, tools: ['Write'] } } } })
  })

  it.each(['expiresAt', 'maxSamples', 'maxSampleBytes'] as const)('rejects an owner approval exceeding accepted %s', (field) => {
    const active = activeRecord()
    expectRelationshipRejected({ ...active, contributionInvitation: { ...active.contributionInvitation,
      grant: { ...active.contributionInvitation.grant, [field]: active.limits[field] + 1 } } })
  })

  it.each(['ownerPeerId', 'taskId', 'recipientPeerId'] as const)('rejects a read invitation with a different %s', (field) => {
    const active = activeRecord()
    expectRelationshipRejected({ ...active, subscription: { ...active.subscription,
      invitation: { ...active.subscription.invitation, [field]: 'another-identity' } } })
  })

  it('rejects read expiry or either invitation address that differs from its original joint permission', () => {
    const active = activeRecord()
    const changedReadExpiry = { ...active.subscription.invitation, expiresAt: expiresAt - 1 }
    const changedReadAddress = { ...active.subscription.invitation, ownerAddress: address.replace('/7000/', '/7001/') }
    expectRelationshipRejected({ ...active, subscription: { ...active.subscription, invitation: changedReadExpiry } })
    expectRelationshipRejected({ ...active, subscription: { ...active.subscription, invitation: changedReadAddress } })
    expectRelationshipRejected({ ...active, contributionInvitation: { ...active.contributionInvitation,
      ownerAddress: changedReadAddress.ownerAddress } })
  })

  it('rejects regressed consent, route disagreement, and simultaneous cleanup with adoption intent', () => {
    const active = activeRecord()
    expectRelationshipRejected({ ...active, authorizedReadRevision: active.expectedReadRevision - 1 })
    expectRelationshipRejected({ ...active, adoptedReadRevision: active.expectedReadRevision })
    expectRelationshipRejected({ ...active, subscription: { ...active.subscription, routeRevision: 1 } })
    expectRelationshipRejected({ ...active, cleanupPending: true })
  })

  it('rejects a terminal subscription or unknown durable fields without normalizing them into an active plan', () => {
    const active = activeRecord()
    expect(parseStored({ ...active, subscription: { ...active.subscription, state: 'left' } }).success).toBe(false)
    expect(parseStored({ ...active, automatic: { maxTurns: 1 } }).success).toBe(false)
    expect(parseStored({ ...active, subscription: { ...active.subscription, originalCapture: {
      ...active.subscription.originalCapture, sessionId: 'unrelated-private-session',
    } } }).success).toBe(false)
  })
})
