import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { applicationRecordSchema, applicationResponseSchema } from '../src/application-schema.ts'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { plannedContributionGrant } from '../src/contribution.ts'
import { invitationSchema } from '../src/schema.ts'
import type { Config } from '../src/index.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal

async function application(participation: 'join' | 'contribution' = 'join', overrides: Partial<Config> = {}) {
  const a = await host('joint-owner', undefined, overrides)
  const b = await host('joint-source')
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('owner has no address')
  const created = await a.access.createContributionEntry({ participation, sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('joint-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } })
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096 }
  const request = { entry: created.entry, proposal, limits }
  const approve = () => a.access.approveContributionApplication({ entryId: request.entry.entryId,
    expectedProposal: proposal, limits, ownerAddress, ...(participation === 'join' ? { read: { responsibility: 'Frontend' } } : {}) })
  const retained = () => applicationRecordSchema.parse(a.pool.media.get('scope_access')?.tables.get('applications')?.get(request.entry.entryId))
  return { a, b, task, request, created, approve, ownerAddress, retained }
}

async function approved(fixture: Awaited<ReturnType<typeof application>>) {
  await fixture.b.access.applyContribution(fixture.request, signal())
  await fixture.approve()
  const result = await fixture.b.access.contributionApplicationStatus(fixture.request, signal())
  if (result.status !== 'approved' || result.readInvitation === undefined || result.readState === undefined) {
    throw new Error('joint approval did not return both original permissions')
  }
  return { ...result, readInvitation: result.readInvitation, readState: result.readState }
}

it('separately approves one read grant and one contribution and preserves both identities on retry', async () => {
  const fixture = await application()
  expect(fixture.created.entry.kind).toBe('scope-join-entry')
  expect(await fixture.a.access.previewContributionText({ text: fixture.created.text })).toEqual(fixture.created.entry)
  const result = await approved(fixture)
  expect(result.readInvitation).toMatchObject({ taskId: fixture.task.id, ownerPeerId: fixture.request.entry.ownerPeerId,
    recipientPeerId: fixture.request.proposal.contributorPeerId, expiresAt: fixture.request.limits.expiresAt, responsibility: 'Frontend' })
  expect(result.readState).toBe('active')
  const events = fixture.a.tasks.log()
  await fixture.approve()
  await expect(fixture.b.access.applyContribution(fixture.request, signal())).resolves.toEqual(result)
  expect(fixture.a.tasks.log()).toHaveLength(events.length)
  expect((await fixture.a.access.list()).grants).toEqual([{ invitation: result.readInvitation, state: 'active' }])
  expect((await fixture.b.access.list()).subscriptions).toEqual([])
  const subscription = await fixture.b.access.join({ invitation: result.readInvitation })
  expect((await fixture.b.access.retrieve(subscription.id, signal())).status).toBe('active')
})

it('requires explicit owner read approval only for joint entries and rejects a joint OpenAPI entry', async () => {
  const joint = await application()
  await joint.b.access.applyContribution(joint.request, signal())
  await expect(joint.a.access.approveContributionApplication({ entryId: joint.request.entry.entryId,
    expectedProposal: joint.request.proposal, limits: joint.request.limits, ownerAddress: joint.ownerAddress }))
    .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  await expect(joint.a.access.createContributionEntry({ participation: 'join', sourceKind: 'openapi', taskId: joint.task.id,
    ownerAddress: joint.ownerAddress, expiresAt: joint.created.entry.expiresAt })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(joint.a.tasks.peerContributions({})).toEqual([])
  expect((await joint.a.access.list()).grants).toEqual([])
  const only = await application('contribution')
  await only.b.access.applyContribution(only.request, signal())
  await expect(only.a.access.approveContributionApplication({ entryId: only.request.entry.entryId,
    expectedProposal: only.request.proposal, limits: only.request.limits, ownerAddress: only.ownerAddress, read: { responsibility: 'Frontend' } }))
    .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  await only.approve()
  const result = await only.b.access.contributionApplicationStatus(only.request, signal())
  expect(result.status).toBe('approved')
  expect(result).not.toHaveProperty('readInvitation')
  expect((await only.a.access.list()).grants).toEqual([])
})

it('retains the original normalized read responsibility instead of changing it on approval retry', async () => {
  const fixture = await application()
  await approved(fixture)
  await expect(fixture.a.access.approveContributionApplication({ entryId: fixture.request.entry.entryId,
    expectedProposal: fixture.request.proposal, limits: fixture.request.limits, ownerAddress: fixture.ownerAddress,
    read: { responsibility: 'QA' } })).rejects.toMatchObject({ code: 'scope-contribution/source-conflict' })
  expect((await fixture.a.access.list()).grants[0]?.invitation.responsibility).toBe('Frontend')
})

it('restores the original planned read and contribution after read commits but Task opening fails', async () => {
  const fixture = await application()
  await fixture.b.access.applyContribution(fixture.request, signal())
  const stop = fixture.a.ctx.on('development-task/persist', (entry) => {
    if (entry.change.kind === 'peer-contribution-opened') throw new Error('Task disk unavailable')
  })
  await expect(fixture.approve()).rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  stop()
  const planned = fixture.retained()
  expect(planned.readInvitation).toBeDefined()
  expect((await fixture.a.access.list()).grants).toHaveLength(1)
  expect(fixture.a.tasks.peerContributions({})).toEqual([])
  const events = fixture.a.tasks.log()
  await fixture.a.ctx.fiber.dispose()
  const restarted = await host('joint-owner', fixture.a.pool, {}, events)
  const result = await fixture.b.access.contributionApplicationStatus(fixture.request, signal())
  expect(result).toMatchObject({ status: 'approved', readInvitation: planned.readInvitation,
    invitation: { grant: planned.grant }, readState: 'active' })
  expect((await restarted.access.list()).grants).toHaveLength(1)
  expect(restarted.tasks.peerContributions({})).toHaveLength(1)
})

it('reserves a planned read slot before a failed read write and does not let another invitation consume it', async () => {
  const fixture = await application('join', { maxGrants: 1 })
  await fixture.b.access.applyContribution(fixture.request, signal())
  const stop = fixture.a.ctx.on('scope-access/contribution-application-changed', () => {
    if (fixture.retained().readInvitation !== undefined) fixture.a.pool.failNextWrites = 1
  })
  await expect(fixture.approve()).rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  stop()
  const planned = fixture.retained()
  expect(planned.readInvitation).toBeDefined()
  expect((await fixture.a.access.list()).grants).toEqual([])
  await expect(fixture.a.access.invite({ taskId: fixture.task.id, recipientPeerId: peer('another-source'),
    ownerAddress: fixture.ownerAddress, expiresAt: fixture.request.limits.expiresAt, responsibility: 'Other' })).rejects.toThrow('capacity')
  const recovered = await fixture.b.access.contributionApplicationStatus(fixture.request, signal())
  expect(recovered).toMatchObject({ status: 'approved', readInvitation: planned.readInvitation })
  expect((await fixture.a.access.list()).grants).toHaveLength(1)
})

it('keeps contribution active when the independent read grant is revoked', async () => {
  const fixture = await application()
  const result = await approved(fixture)
  await fixture.a.access.revoke({ grantId: result.readInvitation.grantId })
  const current = await fixture.b.access.contributionApplicationStatus(fixture.request, signal())
  expect(current).toMatchObject({ status: 'approved', readState: 'revoked', readInvitation: result.readInvitation })
  expect((await fixture.b.access.contributionStatus({ invitation: result.invitation }, signal())).status).toBe('active')
  await fixture.approve()
  expect((await fixture.a.access.list()).grants).toEqual([{ invitation: result.readInvitation, state: 'revoked' }])
})

it('keeps reading active after ending only contribution, then revokes both on application cancellation', async () => {
  const fixture = await application()
  const result = await approved(fixture)
  expect((await fixture.b.access.endContribution({ invitation: result.invitation }, signal())).status).toBe('ended')
  expect(await fixture.b.access.contributionApplicationStatus(fixture.request, signal())).toMatchObject({ status: 'ended', readState: 'active' })
  const subscription = await fixture.b.access.join({ invitation: result.readInvitation })
  expect((await fixture.b.access.retrieve(subscription.id, signal())).status).toBe('active')
  expect(await fixture.b.access.cancelContributionApplication(fixture.request, signal())).toMatchObject({ status: 'ended', readState: 'revoked' })
  expect(await fixture.b.access.retrieve(subscription.id, signal())).toEqual({ status: 'revoked' })
})

it('serializes cancellation after held approval and never reopens either permission', async () => {
  const fixture = await application()
  await fixture.b.access.applyContribution(fixture.request, signal())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.a.ctx.on('development-task/persist', async (entry) => {
    if (entry.change.kind === 'peer-contribution-opened') { entered.resolve(undefined); await release.promise }
  })
  const approval = fixture.approve()
  try {
    await entered.promise
    const cancellation = fixture.b.access.cancelContributionApplication(fixture.request, signal())
    release.resolve(undefined)
    await approval
    const result = await cancellation
    expect(result).toMatchObject({ status: 'ended', readState: 'revoked' })
    await expect(fixture.b.access.applyContribution(fixture.request, signal())).resolves.toEqual(result)
    expect((await fixture.a.access.list()).grants[0]?.state).toBe('revoked')
  } finally { release.resolve(undefined); await Promise.allSettled([approval]) }
})

it('recovers a failed read revocation before confirming cancellation after owner restart', async () => {
  const fixture = await application()
  await approved(fixture)
  const stop = fixture.a.ctx.on('scope-access/contribution-application-changed', () => {
    if (fixture.retained().decision === 'cancelled') fixture.a.pool.failNextWrites = 1
  })
  await expect(fixture.b.access.cancelContributionApplication(fixture.request, signal())).resolves.toEqual({ status: 'unavailable' })
  stop()
  expect((await fixture.a.access.list()).grants[0]?.state).toBe('active')
  expect(fixture.a.tasks.peerContributions({})[0]?.state).toBe('active')
  const events = fixture.a.tasks.log()
  await fixture.a.ctx.fiber.dispose()
  const restarted = await host('joint-owner', fixture.a.pool, {}, events)
  const result = await fixture.b.access.contributionApplicationStatus(fixture.request, signal())
  expect(result).toMatchObject({ status: 'ended', readState: 'revoked' })
  expect((await restarted.access.list()).grants[0]?.state).toBe('revoked')
  expect(restarted.tasks.peerContributions({})[0]?.state).toBe('ended')
})

it('retains cancellation before apply without minting read or contribution authority', async () => {
  const fixture = await application()
  expect(await fixture.b.access.cancelContributionApplication(fixture.request, signal())).toEqual({ status: 'cancelled' })
  expect(await fixture.b.access.applyContribution(fixture.request, signal())).toEqual({ status: 'cancelled' })
  expect((await fixture.a.access.list()).grants).toEqual([])
  expect(fixture.a.tasks.peerContributions({})).toEqual([])
})

it.each(['missing', 'task', 'recipient', 'expiry', 'state'] as const)('rejects a joint reply with %s read authority', async (field) => {
  const fixture = await application()
  await approved(fixture)
  fixture.b.transport.transform = (raw) => {
    const response = applicationResponseSchema.parse(raw)
    const result = response.result
    if (result.status !== 'approved' || result.readInvitation === undefined) throw new Error('expected joint reply')
    if (field === 'missing') {
      const { readInvitation: _invitation, readState: _state, ...rest } = result
      return { ...response, result: rest }
    }
    if (field === 'state') return { ...response, result: { ...result, readState: undefined } }
    const invitation = result.readInvitation
    return { ...response, result: { ...result, readInvitation: field === 'task' ? { ...invitation, taskId: 'another-task' }
      : field === 'recipient' ? { ...invitation, recipientPeerId: 'another-peer' } : { ...invitation, expiresAt: invitation.expiresAt + 1 } } }
  }
  await expect(fixture.b.access.contributionApplicationStatus(fixture.request, signal())).rejects.toThrow()
})

it('refuses injected read authority on a contribution-only application', async () => {
  const fixture = await application('contribution')
  await fixture.b.access.applyContribution(fixture.request, signal())
  await fixture.approve()
  const read = invitationSchema.parse({ version: 1, ownerPeerId: fixture.request.entry.ownerPeerId,
    recipientPeerId: fixture.request.proposal.contributorPeerId, taskId: fixture.task.id, ownerAddress: fixture.ownerAddress,
    grantId: randomUUID(), generation: randomUUID(), expiresAt: fixture.request.limits.expiresAt, responsibility: 'Frontend' })
  fixture.b.transport.transform = (raw) => {
    const response = applicationResponseSchema.parse(raw)
    return { ...response, result: { ...response.result, readInvitation: read, readState: 'active' } }
  }
  await expect(fixture.b.access.contributionApplicationStatus(fixture.request, signal())).rejects.toThrow('read permission')
})

it('reports independent read expiration and rejects a restored mismatched read plan', async () => {
  const fixture = await application()
  const result = await approved(fixture)
  vi.spyOn(Date, 'now').mockReturnValue(result.readInvitation.expiresAt + 1)
  expect(await fixture.b.access.contributionApplicationStatus(fixture.request, signal())).toMatchObject({ status: 'ended', readState: 'expired' })
  vi.restoreAllMocks()
  const events = fixture.a.tasks.log()
  await fixture.a.ctx.fiber.dispose()
  const record = fixture.retained()
  const records = fixture.a.pool.media.get('scope_access')?.tables.get('applications')
  if (records === undefined || record.readInvitation === undefined) throw new Error('read plan was not retained')
  records.set(fixture.request.entry.entryId, { ...record, readInvitation: { ...record.readInvitation, recipientPeerId: peer('wrong-peer') } })
  const restored = await host('joint-owner', fixture.a.pool, {}, events)
  await expect(restored.access.identity()).rejects.toThrow()
  expect(restored.exit).toHaveBeenCalledWith(1)
})

it('cancels an unapproved joint entry without inventing reading when an independent contribution already exists', async () => {
  const fixture = await application()
  const grant = plannedContributionGrant(fixture.request.entry.ownerPeerId, { taskId: fixture.task.id,
    proposal: fixture.request.proposal, ownerAddress: fixture.ownerAddress, ...fixture.request.limits })
  await fixture.a.access.inviteContribution({ ownerAddress: fixture.ownerAddress, grant })
  expect(await fixture.b.access.cancelContributionApplication(fixture.request, signal())).toEqual({ status: 'cancelled' })
  expect(fixture.a.tasks.peerContributions({})[0]?.state).toBe('ended')
  expect((await fixture.a.access.list()).grants).toEqual([])
})

it('rejects joint approval at read capacity without committing a plan or Task authority', async () => {
  const fixture = await application('join', { maxGrants: 1 })
  await fixture.a.access.invite({ taskId: fixture.task.id, ownerAddress: fixture.ownerAddress,
    recipientPeerId: peer('another-recipient'), expiresAt: fixture.request.limits.expiresAt, responsibility: 'Other' })
  await fixture.b.access.applyContribution(fixture.request, signal())
  await expect(fixture.approve()).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(fixture.retained().decision).toBe('pending')
  expect(fixture.retained().readInvitation).toBeUndefined()
  expect(fixture.a.tasks.peerContributions({})).toEqual([])
})

it('recovers both original permissions after the source loses its first approved status response', async () => {
  const fixture = await application()
  await fixture.b.access.applyContribution(fixture.request, signal())
  await fixture.approve()
  const retained = fixture.retained()
  fixture.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  expect(await fixture.b.access.contributionApplicationStatus(fixture.request, signal())).toEqual({ status: 'unavailable' })
  fixture.b.transport.transform = undefined
  expect(await fixture.b.access.contributionApplicationStatus(fixture.request, signal())).toMatchObject({ status: 'approved',
    invitation: { grant: retained.grant }, readInvitation: retained.readInvitation, readState: 'active' })
  expect((await fixture.a.access.list()).grants).toHaveLength(1)
  expect(fixture.a.tasks.peerContributions({})).toHaveLength(1)
})

it('rejects an approval whose complete joint response cannot fit before committing either authority', async () => {
  const measured = await application()
  const result = await approved(measured)
  const maximum = Buffer.byteLength(JSON.stringify({ version: 1, requestId: randomUUID(), op: 'status', result }), 'utf8') - 1
  await measured.a.ctx.fiber.dispose()
  await measured.b.ctx.fiber.dispose()
  const narrow = await application('join', { maxResponseBytes: maximum })
  await narrow.b.access.applyContribution(narrow.request, signal())
  await expect(narrow.approve()).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(narrow.retained().decision).toBe('pending')
  expect((await narrow.a.access.list()).grants).toEqual([])
  expect(narrow.a.tasks.peerContributions({})).toEqual([])
})
