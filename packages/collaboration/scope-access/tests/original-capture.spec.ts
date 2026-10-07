import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import type { Config } from '../src/index.ts'
import type { ScopeCaptureSubscription, ScopeContributionProposal, ScopeContributionSample, ScopeOriginalCapture } from '../src/types.ts'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { legacySubscriptionSchema, subscriptionSchema, projectionDigest, originalCaptureSchema } from '../src/schema.ts'
import { captureReadRequestSchema, readRequestSchema, readResponseSchema } from '../src/state.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
const ownerPeer = peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy')
let fixtureId = 0
const original = (proposal: ScopeContributionProposal): ScopeOriginalCapture => ({
  captureId: proposal.captureId, captureGeneration: proposal.captureGeneration,
})
const projections = (node: Awaited<ReturnType<typeof host>>) =>
  node.pool.media.get('scope_access')!.tables.get('projections') ?? new Map<string, unknown>()

async function fixture(kind: 'group' | 'single' = 'group', overrides: Partial<Config> = {}) {
  const suffix = ++fixtureId
  const aId = `capture-owner-${suffix}`
  const bId = `capture-source-${suffix}`
  const a = await host(aId, undefined, overrides, [], ownerPeer)
  const b = await host(bId)
  const task = await a.createTask()
  const ownerAddress = (await a.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address is missing')
  const expiresAt = Date.now() + 50_000
  const entry = (kind === 'group'
    ? await a.access.createGroupEntry({ taskId: task.id, ownerAddress, expiresAt, maxMembers: 4 })
    : await a.access.createContributionEntry({ taskId: task.id, ownerAddress, expiresAt,
      sourceKind: 'tool-observations', participation: 'join' })).entry
  const limits = { expiresAt, maxSamples: 8, maxSampleBytes: 8192 }
  const proposal = (): ScopeContributionProposal => contributionProposalSchema.parse({
    contributorPeerId: b.transport.peerId, captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] },
  })
  const first = proposal()
  const request = { entry, proposal: first, limits }
  await b.access.applyContribution(request, signal())
  const member = entry.kind === 'scope-group-entry'
    ? (await a.access.groupApplications({ entryId: entry.entryId })).entries[0] : undefined
  await a.access.approveContributionApplication({ entryId: entry.entryId,
    ...(member === undefined ? {} : { applicationId: member.applicationId }),
    expectedProposal: first, limits, ownerAddress, read: { responsibility: 'Maintain my implementation.' } })
  const approval = await b.access.contributionApplicationStatus(request, signal())
  if (approval.status !== 'approved' || approval.readInvitation === undefined) throw new Error('Joint approval is missing')
  const read = approval.readInvitation
  const plan: ScopeCaptureSubscription = { version: 2, originalCapture: original(first),
    id: randomUUID() as ScopeCaptureSubscription['id'], generation: randomUUID() as ScopeCaptureSubscription['generation'],
    invitation: read, state: 'active' }
  await b.access.ensureSubscription(plan)
  const another = proposal()
  const second = await a.access.approveContribution({ taskId: task.id, proposal: another, ownerAddress, ...limits })
  const sample = (name: string, content: string): ScopeContributionSample => ({
    sourceId: createHash('sha256').update(name).digest('hex') as DevelopmentTaskObservedSourceId,
    sequence: 1, result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: `${name}.ts`, content }, omissions: [] },
  })
  const publish = async (own = 'OWN_CAPTURE_BODY', other = 'OTHER_CAPTURE_BODY') => {
    expect((await b.access.contribute({ invitation: approval.invitation, sample: sample('own', own) }, signal())).status).toBe('accepted')
    expect((await b.access.contribute({ invitation: second.invitation, sample: sample('other', other) }, signal())).status).toBe('accepted')
  }
  const wire = (capture = plan.originalCapture) => ({ version: 2 as const, requestId: randomUUID(), subscriptionId: plan.id,
    generation: plan.generation, invitation: read, originalCapture: capture })
  return { a, b, aId, bId, task, request, approval, read, plan, first, another, second, publish, wire, overrides }
}

it.each(['group', 'single'] as const)('omits only the original %s capture and preserves manual same-peer reads', async (kind) => {
  const f = await fixture(kind)
  await f.publish()
  const compute = vi.spyOn(f.a.backend, 'compute')
  const result = await f.b.access.retrieve(f.plan.id, signal())
  if (result.status !== 'active' || result.projection.version !== 3) throw new Error('Associated projection is missing')
  expect(result.projection.text).not.toContain('OWN_CAPTURE_BODY')
  expect(result.projection.text).toContain('OTHER_CAPTURE_BODY')
  expect(result.projection.omittedSources.filter(item => item.reason === 'self-published')).toHaveLength(1)
  expect(result.projection.peerCapture).toEqual({ ownerPeerId: f.read.ownerPeerId, contributorPeerId: f.read.recipientPeerId,
    taskId: f.task.id, grantId: f.approval.invitation.grant.grantId, generation: f.approval.invitation.grant.generation,
    ...f.plan.originalCapture })
  expect(compute.mock.calls[0]?.[0].recipient.peerCapture).toEqual(result.projection.peerCapture)
  expect(f.a.tasks.contextView(f.task.id).task.context).toHaveLength(2)
  const manual = await f.b.access.join({ invitation: f.read })
  expect(manual.version).toBeUndefined()
  const full = await f.b.access.retrieve(manual.id, signal())
  if (full.status !== 'active') throw new Error('Manual read is missing')
  expect(full.projection.version).toBe(2)
  expect(full.projection.text).toContain('OWN_CAPTURE_BODY')
  expect(full.projection.text).toContain('OTHER_CAPTURE_BODY')
  expect(compute.mock.calls[1]?.[0].recipient.peerCapture).toBeUndefined()
})

it.each(['captureId', 'captureGeneration', 'peer'] as const)('denies a mismatched %s before looking up Task facts', async (field) => {
  const f = await fixture()
  const source = field === 'peer' ? await host(`foreign-${fixtureId}`) : f.b
  const capture = field === 'peer' ? f.plan.originalCapture
    : originalCaptureSchema.parse({ ...f.plan.originalCapture, [field]: randomUUID() })
  const read = vi.spyOn(f.a.tasks, 'currentContextView')
  const raw = await source.transport.request({ peerId: f.read.ownerPeerId, address: f.read.ownerAddress },
    '/agentharness/scope-read/2', f.wire(capture), signal())
  expect(readResponseSchema.parse(raw).result).toEqual({ status: 'denied' })
  expect(read).not.toHaveBeenCalled()
  expect(projections(f.a).size).toBe(0)
})

it('does not infer a capture association for an unrelated manually issued read grant', async () => {
  const f = await fixture()
  const invitation = await f.a.access.invite({ taskId: f.task.id, recipientPeerId: f.read.recipientPeerId,
    ownerAddress: f.read.ownerAddress, expiresAt: f.read.expiresAt, responsibility: f.read.responsibility })
  const read = vi.spyOn(f.a.tasks, 'currentContextView')
  const raw = await f.b.transport.request({ peerId: f.read.ownerPeerId, address: f.read.ownerAddress },
    '/agentharness/scope-read/2', { ...f.wire(), invitation }, signal())
  expect(readResponseSchema.parse(raw).result).toEqual({ status: 'denied' })
  expect(read).not.toHaveBeenCalled()
})

it('keeps version-1 wire and durable subscription fields strict instead of silently enabling omission', async () => {
  const f = await fixture()
  const { version: _version, originalCapture: _capture, ...legacy } = f.plan
  expect(legacySubscriptionSchema.parse(legacy)).toEqual(legacy)
  expect(subscriptionSchema.parse(f.plan)).toEqual(f.plan)
  expect(legacySubscriptionSchema.safeParse(f.plan).success).toBe(false)
  expect(subscriptionSchema.safeParse({ ...legacy, originalCapture: f.plan.originalCapture }).success).toBe(false)
  expect(subscriptionSchema.safeParse({ ...legacy, version: 2 }).success).toBe(false)
  expect(subscriptionSchema.safeParse({ ...f.plan, version: 3 }).success).toBe(false)
  expect(readRequestSchema.safeParse(f.wire()).success).toBe(false)
  expect(captureReadRequestSchema.safeParse({ ...f.wire(), version: 1 }).success).toBe(false)
  await expect(f.b.transport.request({ peerId: f.read.ownerPeerId, address: f.read.ownerAddress },
    '/agentharness/scope-read/1', f.wire(), signal())).rejects.toThrow()
})

it('pins original capture through ensure retries and monotonic address recovery', async () => {
  const f = await fixture()
  const changed = { ...f.plan, originalCapture: original(f.another) }
  await expect(f.b.access.ensureSubscription(changed)).rejects.toThrow('another plan')
  await expect(f.b.access.updateSubscriptionRoute({ ...changed, routeRevision: 1 })).rejects.toThrow('authority')
  const { version: _version, originalCapture: _capture, ...plain } = f.plan
  await expect(f.b.access.ensureSubscription(plain)).rejects.toThrow('another plan')
  await expect(f.b.access.updateSubscriptionRoute({ ...plain, routeRevision: 1 })).rejects.toThrow('authority')
  const routed = await f.b.access.updateSubscriptionRoute({ ...f.plan, routeRevision: 1 })
  expect(routed).toEqual({ ...f.plan, routeRevision: 1 })
  await expect(f.b.access.ensureSubscription(f.plan)).resolves.toEqual(routed)
  await f.b.access.leave({ subscriptionId: f.plan.id })
  await expect(f.b.access.ensureSubscription(f.plan)).resolves.toEqual({ ...routed, state: 'left' })
})

it('restores the associated subscription and exact projections on both Hosts without changing old rows', async () => {
  const f = await fixture()
  await f.publish()
  const plain = await f.b.access.join({ invitation: f.read })
  const expected = await f.b.access.retrieve(f.plan.id, signal())
  const ownerEvents = f.a.tasks.log()
  await f.b.ctx.fiber.dispose()
  await f.a.ctx.fiber.dispose()
  const a = await host(f.aId, f.a.pool, f.overrides, ownerEvents, ownerPeer)
  const b = await host(f.bId, f.b.pool)
  expect((await b.access.list()).subscriptions).toEqual([f.plan, plain])
  await expect(b.access.retrieve(f.plan.id, signal())).resolves.toEqual(expected)
  expect(a.exit).not.toHaveBeenCalled()
  expect(b.exit).not.toHaveBeenCalled()
})

it('restores historical associated projections after owner termination without reactivating authorization', async () => {
  const f = await fixture()
  await f.publish()
  expect((await f.b.access.retrieve(f.plan.id, signal())).status).toBe('active')
  const row = (await f.a.access.groupApplications({ entryId: f.request.entry.entryId })).entries[0]!
  await f.a.access.rejectContributionApplication({ entryId: f.request.entry.entryId, applicationId: row.applicationId,
    expectedProposal: f.first })
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const a = await host(f.aId, f.a.pool, f.overrides, events, ownerPeer)
  await expect(f.b.access.retrieve(f.plan.id, signal())).resolves.toEqual({ status: 'revoked' })
  expect(a.exit).not.toHaveBeenCalled()
  expect(projections(a).size).toBe(1)
})

it('rejects malformed persisted association variants on startup instead of downgrading them', async () => {
  const f = await fixture()
  await f.b.ctx.fiber.dispose()
  const rows = f.b.pool.media.get('scope_access')!.tables.get('subscriptions')!
  rows.set(f.plan.id, { ...f.plan, originalCapture: { captureId: f.first.captureId } })
  const restored = await host(f.bId, f.b.pool)
  await expect(restored.access.identity()).rejects.toThrow("in table 'subscriptions' does not match its schema")
  expect(restored.exit).toHaveBeenCalledWith(1)
})

it.each(['capture', 'downgrade'] as const)('rejects a changed %s in the owner response before receiver persistence', async (change) => {
  const f = await fixture()
  f.b.transport.transform = (raw) => {
    const response = readResponseSchema.parse(raw)
    if (response.result.status !== 'active' || response.result.projection.version !== 3) return raw
    const value = response.result.projection
    const { peerCapture, ...withoutCapture } = value
    const changed = change === 'capture' ? { ...value, peerCapture: { ...peerCapture, ...original(f.another) } }
      : { ...withoutCapture, version: 2 as const }
    return { ...response, result: { status: 'active', projection: { ...changed, projectionId: projectionDigest(changed) } } }
  }
  await expect(f.b.access.retrieve(f.plan.id, signal())).rejects.toThrow('invitation')
  expect(projections(f.b).size).toBe(0)
})

it('rechecks read revocation after a slow associated backend without persisting its text', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = f.a.backend.compute.bind(f.a.backend)
  vi.spyOn(f.a.backend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return compute(input)
  })
  const pending = f.b.access.retrieve(f.plan.id, signal())
  try { await entered.promise; await f.a.access.revoke({ grantId: f.read.grantId }) }
  finally { release.resolve(undefined) }
  await expect(pending).resolves.toEqual({ status: 'revoked' })
  expect(projections(f.a).size).toBe(0)
  expect(projections(f.b).size).toBe(0)
})

it('keeps terminal notices and other captures when the original contribution ends but reading stays active', async () => {
  const f = await fixture()
  await f.publish()
  await f.b.access.endContribution({ invitation: f.approval.invitation }, signal())
  const result = await f.b.access.retrieve(f.plan.id, signal())
  if (result.status !== 'active') throw new Error('Reading should remain active')
  expect(result.projection.text).toContain('OTHER_CAPTURE_BODY')
  expect(result.projection.text).not.toContain('OWN_CAPTURE_BODY')
  expect(result.projection.omittedSources.some(item => item.reason === 'withdrawn')).toBe(true)
  const terminal = f.a.tasks.contextView(f.task.id).task.context.find(item => item.peerContribution?.ended !== undefined)
  expect(result.projection.selectedSources.some(item => item.kind === 'publication' && item.publicationId === terminal?.id)).toBe(true)
  expect((await f.a.access.list()).grants[0]?.state).toBe('active')
})

it('retains associated expiry and never reopens it through exact adoption retry', async () => {
  const f = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(f.read.expiresAt)
  await expect(f.b.access.retrieve(f.plan.id, signal())).resolves.toEqual({ status: 'expired' })
  await expect(f.b.access.ensureSubscription(f.plan)).resolves.toEqual({ ...f.plan, state: 'expired' })
})

it('enforces the complete associated response budget before persistence', async () => {
  const f = await fixture('group', { maxResponseBytes: 3000, maxDecodedResponseBytes: 3000 })
  await f.publish('我的原始写入', '另一职责事实'.repeat(150))
  await expect(f.b.access.retrieve(f.plan.id, signal())).rejects.toThrow('response exceeds budget')
  expect(projections(f.a).size).toBe(0)
  expect(projections(f.b).size).toBe(0)
})

it('rejects a pre-termination capture projection after the original contribution ends during computation', async () => {
  const f = await fixture()
  await f.publish()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = f.a.backend.compute.bind(f.a.backend)
  vi.spyOn(f.a.backend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return compute(input)
  })
  const pending = f.b.access.retrieve(f.plan.id, signal())
  try { await entered.promise; await f.b.access.endContribution({ invitation: f.approval.invitation }, signal()) }
  finally { release.resolve(undefined) }
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  expect(projections(f.a).size).toBe(0)
  expect(projections(f.b).size).toBe(0)
  const current = await f.b.access.retrieve(f.plan.id, signal())
  if (current.status !== 'active') throw new Error('Reading should remain authorized')
  expect(current.projection.text).toContain('OTHER_CAPTURE_BODY')
  expect(current.projection.text).not.toContain('OWN_CAPTURE_BODY')
})

it('rejects a delayed associated reply after local leave while a manual subscription remains independent', async () => {
  const f = await fixture()
  const arrived = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.b.transport.transform = async (response) => { arrived.resolve(undefined); await release.promise; return response }
  const pending = f.b.access.retrieve(f.plan.id, signal())
  try {
    await arrived.promise
    await f.b.access.leave({ subscriptionId: f.plan.id })
    const manual = await f.b.access.join({ invitation: f.read })
    expect(manual.originalCapture).toBeUndefined()
    expect(manual.id).not.toBe(f.plan.id)
  } finally { release.resolve(undefined) }
  await expect(pending).resolves.toEqual({ status: 'left' })
  expect(projections(f.b).size).toBe(0)
  expect((await f.a.access.list()).grants[0]?.state).toBe('active')
})

it('negotiates an allowance while preserving exact source omission and independent manual reads', async () => {
  const f = await fixture()
  await f.publish()
  const compute = vi.spyOn(f.a.backend, 'compute')
  const transport = vi.spyOn(f.b.transport, 'request')
  const associated = await f.b.access.retrieveWithinBudget({ subscriptionId: f.plan.id, maxContextBytes: 5000 }, signal())
  if (associated.status !== 'active' || associated.projection.version !== 3) throw new Error('Associated budgeted result is missing')
  expect(associated.projection.maxContextBytes).toBe(5000)
  expect(associated.projection.text).not.toContain('OWN_CAPTURE_BODY')
  expect(associated.projection.text).toContain('OTHER_CAPTURE_BODY')
  expect(compute.mock.calls[0]?.[0]).toMatchObject({ maxContextBytes: 5000,
    recipient: { peerCapture: associated.projection.peerCapture } })
  expect(transport.mock.calls[0]?.[1]).toBe('/agentharness/scope-read/4')
  expect(transport.mock.calls[0]?.[2]).toMatchObject({ version: 4, originalCapture: f.plan.originalCapture, maxContextBytes: 5000 })
  const manual = await f.b.access.join({ invitation: f.read })
  const current = await f.b.access.retrieveWithinBudget({ subscriptionId: manual.id, maxContextBytes: 5000 }, signal())
  if (current.status !== 'active') throw new Error('Manual budgeted result is missing')
  expect(current.projection.version).toBe(2)
  expect(current.projection.text).toContain('OWN_CAPTURE_BODY')
  expect(current.projection.text).toContain('OTHER_CAPTURE_BODY')
  expect(compute.mock.calls[1]?.[0].recipient.peerCapture).toBeUndefined()
})

it.each(['captureId', 'captureGeneration'] as const)('rejects a mismatched budgeted %s before Task lookup', async (field) => {
  const f = await fixture()
  const read = vi.spyOn(f.a.tasks, 'currentContextView')
  const originalCapture = originalCaptureSchema.parse({ ...f.plan.originalCapture, [field]: randomUUID() })
  const raw = await f.b.transport.request({ peerId: f.read.ownerPeerId, address: f.read.ownerAddress },
    '/agentharness/scope-read/3', { ...f.wire(originalCapture), version: 3, maxContextBytes: 5000 }, signal())
  expect(readResponseSchema.parse(raw).result).toEqual({ status: 'denied' })
  expect(read).not.toHaveBeenCalled()
  expect(projections(f.a).size).toBe(0)
})
