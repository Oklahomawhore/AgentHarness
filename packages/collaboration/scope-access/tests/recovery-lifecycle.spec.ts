/** Route recovery preserves independently durable owner and terminal contribution authority. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { applicationRecordSchema } from '../src/application-schema.ts'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { cleanup, host } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal

async function fixture() {
  const owner = await host('recovery-lifecycle-owner')
  const source = await host('recovery-lifecycle-source')
  const task = await owner.createTask()
  const ownerAddress = (await owner.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const expiresAt = Date.now() + 20_000
  const single = (await owner.access.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt })).entry
  const group = (await owner.access.createGroupEntry({ taskId: task.id, ownerAddress, expiresAt, maxMembers: 2 })).entry
  const proposal = contributionProposalSchema.parse({ contributorPeerId: source.transport.peerId,
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const limits = { expiresAt: expiresAt + 20_000, maxSamples: 4, maxSampleBytes: 4096 }
  const request = { entry: single, proposal, limits }
  expect(await source.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  const approved = await owner.access.approveContributionApplication({ entryId: single.entryId,
    expectedProposal: proposal, limits, ownerAddress })
  return { owner, source, task, ownerAddress, single, group, request, approved }
}

it('keeps withdrawal available without an advertised route and recovers only the original terminal authority when a route returns', async () => {
  const f = await fixture()
  const selection = { taskId: f.task.id, grantId: f.approved.invitation.grant.grantId,
    generation: f.approved.invitation.grant.generation }
  const identity = vi.spyOn(f.owner.transport, 'identity').mockResolvedValue({ peerId: f.owner.transport.peerId, addresses: [] })
  try {
    const before = structuredClone(f.owner.pool.media)
    const events = f.owner.tasks.log()
    for (const entry of [f.single, f.group]) {
      await expect(f.owner.access.recoverContributionEntry({ entryId: entry.entryId, ownerAddress: f.ownerAddress }))
        .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
    }
    await expect(f.owner.access.recoverContributionInvitation({ ...selection, ownerAddress: f.ownerAddress }))
      .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
    expect(f.owner.pool.media).toEqual(before)
    expect(f.owner.tasks.log()).toEqual(events)
    const ended = await f.owner.access.revokeContribution({ grant: f.approved.invitation.grant })
    expect(ended).toMatchObject({ status: 'ended', reason: 'revoked' })
    if (ended.status !== 'ended') throw new Error('Local owner revocation did not retain its terminal receipt')
    const terminalEvents = f.owner.tasks.log()
    const retained = structuredClone(f.owner.pool.media)
    const ownerAddress = f.ownerAddress.replace('/tcp/1/', '/tcp/2/')
    identity.mockResolvedValue({ peerId: f.owner.transport.peerId, addresses: [ownerAddress] })
    for (const entry of [f.single, f.group]) {
      const recovered = await f.owner.access.recoverContributionEntry({ entryId: entry.entryId, ownerAddress })
      expect(recovered.entry).toEqual({ ...entry, ownerAddress })
    }
    const recovered = await f.owner.access.recoverContributionInvitation({ ...selection, ownerAddress })
    expect(recovered.invitation).toEqual({ ...f.approved.invitation, ownerAddress })
    expect(await f.source.access.contributionStatus({ invitation: recovered.invitation }, signal())).toEqual(ended)
    expect(await f.source.access.contributionApplicationStatus({ ...f.request,
      entry: { ...f.single, ownerAddress } }, signal())).toMatchObject({ status: 'ended', reason: 'revoked',
      invitation: recovered.invitation, receipt: ended.receipt })
    expect(f.owner.pool.media).toEqual(retained)
    expect(f.owner.tasks.log()).toEqual(terminalEvents)
    expect(f.owner.tasks.peerContributions({ taskId: f.task.id })).toMatchObject([{ state: 'ended', grant: recovered.invitation.grant }])
  } finally { identity.mockRestore() }
})

it('refuses a pending durable entry owned by another transport peer before recovering any route', async () => {
  const f = await fixture()
  const pending = (await f.owner.access.createContributionEntry({ sourceKind: 'tool-observations', taskId: f.task.id,
    ownerAddress: f.ownerAddress, expiresAt: f.single.expiresAt })).entry
  const request = { ...f.request, entry: pending,
    proposal: contributionProposalSchema.parse({ ...f.request.proposal, captureId: randomUUID() }) }
  expect(await f.source.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  const rows = f.owner.pool.media.get('scope_access')?.tables.get('applications')
  if (rows === undefined) throw new Error('Missing durable application table')
  const record = applicationRecordSchema.parse(rows.get(pending.entryId))
  const events = f.owner.tasks.log()
  await f.owner.ctx.fiber.dispose()
  rows.set(pending.entryId, applicationRecordSchema.parse({ ...record, entry: { ...record.entry, ownerPeerId: 'different-owner' } }))
  const before = structuredClone(f.owner.pool.media)
  const restored = await host('recovery-lifecycle-owner', f.owner.pool, {}, events)
  await expect(restored.access.recoverContributionEntry({ entryId: pending.entryId, ownerAddress: f.ownerAddress }))
    .rejects.toThrow('invalid retained application identity')
  expect(restored.exit).toHaveBeenCalledWith(1)
  expect(restored.pool.media).toEqual(before)
  expect(restored.tasks.log()).toEqual(events)
})
