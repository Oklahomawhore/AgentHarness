/** Public entry admission, immutable manual authority, and bounded owner recovery. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { applicationRecordSchema, groupRecordSchema } from '../src/application-schema.ts'
import { plannedContributionGrant } from '../src/contribution.ts'
import type { Config } from '../src/index.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal

async function fixture(overrides: Partial<Config> = {}) {
  const owner = await host('release-application-owner', undefined, overrides)
  const source = await host('release-application-source')
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
  const approve = () => owner.access.approveContributionApplication({ entryId: single.entryId,
    expectedProposal: proposal, limits, ownerAddress })
  return { owner, source, task, ownerAddress, expiresAt, single, group, request, approve }
}

it.each(['single', 'group'] as const)('refuses %s entries outside the local Root Task and admission lifetime', async (kind) => {
  const f = await fixture()
  const fork = await f.owner.tasks.create({ origin: { kind: 'fork', parent: { taskId: f.task.id, revision: f.task.revision } },
    objective: 'Private derived work', scope: 'Derived scope', createdBy: f.owner.participantId })
  const foreign = await f.source.createTask()
  for (const event of f.source.tasks.log()) await f.owner.tasks.acceptLogReplica(event, event.nodeId)
  const original = structuredClone(f.owner.pool.media)
  const create = (fields: { taskId: typeof f.task.id; expiresAt: number; ownerAddress: string }) => kind === 'single'
    ? f.owner.access.createContributionEntry({ ...fields, sourceKind: 'tool-observations' })
    : f.owner.access.createGroupEntry({ ...fields, maxMembers: 2 })
  for (const fields of [
    { taskId: fork.id, expiresAt: f.expiresAt, ownerAddress: f.ownerAddress },
    { taskId: foreign.id, expiresAt: f.expiresAt, ownerAddress: f.ownerAddress },
    { taskId: f.task.id, expiresAt: Date.now(), ownerAddress: f.ownerAddress },
    { taskId: f.task.id, expiresAt: Date.now() + 120_000, ownerAddress: f.ownerAddress },
    { taskId: f.task.id, expiresAt: f.expiresAt, ownerAddress: f.ownerAddress.replace('/tcp/1/', '/tcp/2/') },
  ]) await expect(create(fields)).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(f.owner.pool.media).toEqual(original)
  expect(f.owner.tasks.peerContributions({})).toEqual([])
})

it('rejects a group member limit above retained application capacity without adding an entrance', async () => {
  const f = await fixture({ maxContributionApplications: 4 })
  const before = structuredClone(f.owner.pool.media)
  await expect(f.owner.access.createGroupEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.expiresAt, maxMembers: 5 })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(f.owner.pool.media).toEqual(before)
})

it('refuses fresh group admission after either entry or source consent expires without consuming member capacity', async () => {
  const f = await fixture()
  const request = { ...f.request, entry: f.group }
  const before = structuredClone(f.owner.pool.media)
  expect(await f.source.access.applyContribution({ ...request, limits: { ...request.limits, expiresAt: Date.now() } }, signal()))
    .toEqual({ status: 'denied' })
  expect(f.owner.pool.media).toEqual(before)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt)
  try {
    expect(await f.source.access.applyContribution(request, signal())).toEqual({ status: 'expired' })
    expect((await f.owner.access.groupEntries({ taskId: f.task.id })).entries).toMatchObject([{ state: 'expired', applicationCount: 0 }])
    expect(f.owner.pool.media).toEqual(before)
  } finally { clock.mockRestore() }
  expect(await f.source.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  expect((await f.owner.access.groupApplications({ entryId: f.group.entryId })).entries).toHaveLength(1)
})

it('keeps single and group selectors separate and refuses foreign inventory cursors', async () => {
  const f = await fixture()
  expect(await f.source.access.applyContribution(f.request, signal())).toEqual({ status: 'pending' })
  expect(await f.source.access.applyContribution({ ...f.request, entry: f.group,
    proposal: contributionProposalSchema.parse({ ...f.request.proposal, captureId: randomUUID() }) }, signal())).toEqual({ status: 'pending' })
  const member = (await f.owner.access.groupApplications({ entryId: f.group.entryId })).entries[0]
  if (member === undefined) throw new Error('Missing independently selected group member')
  const before = structuredClone(f.owner.pool.media)
  await expect(f.owner.access.rejectContributionApplication({ entryId: f.single.entryId, applicationId: member.applicationId,
    expectedProposal: f.request.proposal })).rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  await expect(f.owner.access.rejectContributionApplication({ entryId: f.single.entryId,
    expectedProposal: member.proposal })).rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  await expect(f.owner.access.contributionApplications({ taskId: f.task.id, afterEntryId: f.group.entryId }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  await expect(f.owner.access.groupEntries({ taskId: f.task.id, afterEntryId: f.single.entryId }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  expect(f.owner.pool.media).toEqual(before)
})

it.each(['limits', 'source', 'ended'] as const)('preserves independent manual %s authority when online approval cannot adopt it', async (conflict) => {
  const f = await fixture()
  const manual = await f.owner.access.approveContribution({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    proposal: conflict === 'source' ? { ...f.request.proposal, source: { kind: 'tool-observations', name: 'other-work', tools: ['Write'] } }
      : f.request.proposal, ...f.request.limits, maxSamples: conflict === 'limits' ? 2 : f.request.limits.maxSamples })
  if (conflict === 'ended') await f.owner.access.revokeContribution({ grant: manual.invitation.grant })
  expect(await f.source.access.applyContribution(f.request, signal())).toEqual({ status: 'pending' })
  const events = f.owner.tasks.log()
  await expect(f.approve()).rejects.toMatchObject({ code: conflict === 'limits' ? 'scope-contribution/source-conflict'
    : conflict === 'ended' ? 'scope-contribution/grant-ended' : 'scope-contribution/invalid-permission' })
  expect(f.owner.tasks.log()).toEqual(events)
  expect(f.owner.tasks.peerContributions({})).toMatchObject([{ grant: manual.invitation.grant,
    state: conflict === 'ended' ? 'ended' : 'active' }])
})

it.each(['lifetime', 'sample bytes'] as const)('refuses online approval above owner %s policy before retaining a grant', async (limit) => {
  const f = await fixture(limit === 'lifetime' ? { maxInvitationLifetimeMs: 1000 } : {})
  const limits = limit === 'sample bytes' ? { ...f.request.limits, maxSampleBytes: 20_000 } : f.request.limits
  expect(await f.source.access.applyContribution({ ...f.request, limits }, signal())).toEqual({ status: 'pending' })
  await expect(f.owner.access.approveContributionApplication({ entryId: f.single.entryId, expectedProposal: f.request.proposal,
    limits, ownerAddress: f.ownerAddress })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(f.owner.tasks.peerContributions({})).toEqual([])
  expect((await f.owner.access.contributionApplications({ taskId: f.task.id })).entries).toMatchObject([{ result: { status: 'pending' } }])
})

it.each(['single', 'group', 'member'] as const)('rejects a cold-restored %s page whose first complete wrapper exceeds its byte budget', async (kind) => {
  const f = await fixture()
  await f.source.access.applyContribution({ ...f.request, entry: f.group }, signal())
  const single = (await f.owner.access.contributionApplications({ taskId: f.task.id })).entries[0]
  const group = (await f.owner.access.groupEntries({ taskId: f.task.id })).entries[0]
  const member = (await f.owner.access.groupApplications({ entryId: f.group.entryId })).entries[0]
  if (single === undefined || group === undefined || member === undefined) throw new Error('Missing retained owner observations')
  const value = kind === 'single' ? single : kind === 'group' ? group : member
  const maximum = Buffer.byteLength(JSON.stringify(value), 'utf8')
  const events = f.owner.tasks.log()
  await f.owner.ctx.fiber.dispose()
  const restored = await host('release-application-owner', f.owner.pool, { maxResponseBytes: maximum }, events)
  const before = structuredClone(restored.pool.media)
  const page = () => kind === 'single' ? restored.access.contributionApplications({ taskId: f.task.id })
    : kind === 'group' ? restored.access.groupEntries({ taskId: f.task.id }) : restored.access.groupApplications({ entryId: f.group.entryId })
  await expect(page()).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(restored.pool.media).toEqual(before)
  expect(restored.tasks.log()).toEqual(events)
})

it('refuses duplicate pending capture selections restored from independent durable entry rows', async () => {
  const f = await fixture()
  await f.source.access.applyContribution(f.request, signal())
  const other = (await f.owner.access.createContributionEntry({ sourceKind: 'tool-observations', taskId: f.task.id,
    ownerAddress: f.ownerAddress, expiresAt: f.expiresAt })).entry
  const events = f.owner.tasks.log()
  const rows = f.owner.pool.media.get('scope_access')?.tables.get('applications')
  if (rows === undefined) throw new Error('Missing durable application table')
  const original = applicationRecordSchema.parse(rows.get(f.single.entryId))
  await f.owner.ctx.fiber.dispose()
  rows.set(other.entryId, { ...original, entry: other })
  const before = structuredClone(f.owner.pool.media)
  const restored = await host('release-application-owner', f.owner.pool, {}, events)
  await expect(restored.access.approveContributionApplication({ entryId: f.single.entryId,
    expectedProposal: f.request.proposal, limits: f.request.limits, ownerAddress: f.ownerAddress }))
    .rejects.toMatchObject({ code: 'scope-contribution/source-conflict' })
  expect(restored.pool.media).toEqual(before)
  expect(restored.tasks.log()).toEqual(events)
  expect(restored.tasks.peerContributions({})).toEqual([])
})

it('refuses independently issued Task authority naming a different transport owner', async () => {
  const f = await fixture()
  await f.source.access.applyContribution(f.request, signal())
  const grant = plannedContributionGrant(peer('different-transport-owner'), { taskId: f.task.id,
    proposal: f.request.proposal, ownerAddress: f.ownerAddress, ...f.request.limits })
  await f.owner.tasks.openPeerContribution(grant)
  const before = structuredClone(f.owner.pool.media)
  const events = f.owner.tasks.log()
  await expect(f.approve()).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(f.owner.pool.media).toEqual(before)
  expect(f.owner.tasks.log()).toEqual(events)
})

it('denies an approved peer status when independently added Task authority has another owner', async () => {
  const f = await fixture()
  await f.source.access.applyContribution(f.request, signal())
  await f.approve()
  const grant = plannedContributionGrant(peer('different-transport-owner'), { taskId: f.task.id,
    proposal: contributionProposalSchema.parse({ ...f.request.proposal, captureId: randomUUID() }),
    ownerAddress: f.ownerAddress, ...f.request.limits })
  await f.owner.tasks.openPeerContribution(grant)
  const events = f.owner.tasks.log()
  expect(await f.source.access.contributionApplicationStatus(f.request, signal())).toEqual({ status: 'denied' })
  expect(f.owner.tasks.log()).toEqual(events)
})

it('ends due Task authority before refusing a repeated owner approval at its original grant deadline', async () => {
  const f = await fixture()
  await f.source.access.applyContribution(f.request, signal())
  const approved = await f.approve()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(f.request.limits.expiresAt)
  try {
    await expect(f.approve()).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
    expect(await f.source.access.contributionApplicationStatus(f.request, signal())).toMatchObject({ status: 'ended', reason: 'expired',
      invitation: approved.invitation })
    expect(f.owner.tasks.log().filter(event => event.change.kind === 'peer-contribution-ended')).toHaveLength(1)
  } finally { clock.mockRestore() }
})

it.each(['cancelled', 'rejected', 'expired'] as const)('preserves an application already %s when its owner retries rejection', async (terminal) => {
  const f = await fixture()
  await f.source.access.applyContribution(f.request, signal())
  const selection = { entryId: f.single.entryId, expectedProposal: f.request.proposal }
  if (terminal === 'cancelled') await f.source.access.cancelContributionApplication(f.request, signal())
  else if (terminal === 'rejected') await f.owner.access.rejectContributionApplication(selection)
  else {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt)
    try {
      expect(await f.source.access.contributionApplicationStatus(f.request, signal())).toEqual({ status: 'expired' })
    } finally { clock.mockRestore() }
  }
  const retained = structuredClone(f.owner.pool.media)
  const events = f.owner.tasks.log()
  expect(await f.owner.access.rejectContributionApplication(selection)).toMatchObject({ result: { status: terminal } })
  expect(await f.source.access.contributionApplicationStatus(f.request, signal())).toEqual({ status: terminal })
  expect(f.owner.pool.media).toEqual(retained)
  expect(f.owner.tasks.log()).toEqual(events)
  expect(f.owner.tasks.peerContributions({ taskId: f.task.id })).toEqual([])
})

it('reports unavailable for a malformed durable application without replacing it or opening Task authority', async () => {
  const f = await fixture()
  await f.source.access.applyContribution(f.request, signal())
  const rows = f.owner.pool.media.get('scope_access')?.tables.get('applications')
  if (rows === undefined) throw new Error('Missing durable application table')
  const pending = applicationRecordSchema.parse(rows.get(f.single.entryId))
  const events = f.owner.tasks.log()
  await f.owner.ctx.fiber.dispose()
  rows.set(f.single.entryId, { ...pending, decision: 'approved' })
  const before = structuredClone(f.owner.pool.media)
  const restored = await host('release-application-owner', f.owner.pool, {}, events)
  await expect(restored.access.contributionApplications({ taskId: f.task.id }))
    .rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  expect(restored.exit).toHaveBeenCalledWith(1)
  expect(restored.pool.media).toEqual(before)
  expect(restored.tasks.log()).toEqual(events)
})

it.each(['single', 'group'] as const)('restores terminal %s joint authority and refuses a durable plan missing its original read permission', async (kind) => {
  const f = await fixture()
  const entry = kind === 'group' ? f.group : (await f.owner.access.createContributionEntry({ participation: 'join',
    sourceKind: 'tool-observations', taskId: f.task.id, ownerAddress: f.ownerAddress, expiresAt: f.expiresAt })).entry
  const request = { ...f.request, entry }
  expect(await f.source.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  const applicationId = kind === 'group'
    ? (await f.owner.access.groupApplications({ entryId: entry.entryId })).entries[0]?.applicationId : undefined
  if (kind === 'group' && applicationId === undefined) throw new Error('Missing retained group applicant')
  await f.owner.access.approveContributionApplication({ entryId: entry.entryId, expectedProposal: request.proposal,
    limits: request.limits, ownerAddress: f.ownerAddress, read: { responsibility: 'Frontend integration' },
    ...(applicationId === undefined ? {} : { applicationId }) })
  const terminal = await f.source.access.cancelContributionApplication(request, signal())
  expect(terminal).toMatchObject({ status: 'ended', reason: 'left', readState: 'revoked' })
  const events = f.owner.tasks.log()
  await f.owner.ctx.fiber.dispose()
  const restored = await host('release-application-owner', f.owner.pool, {}, events)
  expect(await f.source.access.contributionApplicationStatus(request, signal())).toEqual(terminal)
  expect(restored.tasks.log()).toEqual(events)
  await restored.ctx.fiber.dispose()
  if (kind === 'group') {
    const rows = f.owner.pool.media.get('scope_group_applications')?.tables.get('entries')
    if (rows === undefined) throw new Error('Missing retained group table')
    const record = groupRecordSchema.parse(rows.get(entry.entryId))
    rows.set(entry.entryId, { ...record, members: record.members.map(({ readInvitation: _read, ...member }) => member) })
  } else {
    const rows = f.owner.pool.media.get('scope_access')?.tables.get('applications')
    if (rows === undefined) throw new Error('Missing retained application table')
    const { readInvitation: _read, ...record } = applicationRecordSchema.parse(rows.get(entry.entryId))
    rows.set(entry.entryId, record)
  }
  const before = structuredClone(f.owner.pool.media)
  const damaged = await host('release-application-owner', f.owner.pool, {}, events)
  await expect(damaged.access.identity()).rejects.toMatchObject({ code: 'invalid-record',
    detail: { table: kind === 'group' ? 'entries' : 'applications', key: entry.entryId } })
  expect(damaged.exit).toHaveBeenCalledWith(1)
  expect(damaged.pool.media).toEqual(before)
  expect(damaged.tasks.log()).toEqual(events)
})

it('paginates restored entries by identity when durable insertion order differs from identity order', async () => {
  const f = await fixture()
  for (let index = 0; index < 3; index++) await f.owner.access.createContributionEntry({ sourceKind: 'tool-observations',
    taskId: f.task.id, ownerAddress: f.ownerAddress, expiresAt: f.expiresAt })
  const events = f.owner.tasks.log()
  const rows = f.owner.pool.media.get('scope_access')?.tables.get('applications')
  if (rows === undefined) throw new Error('Missing durable application table')
  const records = [...rows.values()].map(value => applicationRecordSchema.parse(value))
  const ids = [3, 1, 4, 2].map(value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`)
  expect(records).toHaveLength(ids.length)
  await f.owner.ctx.fiber.dispose()
  rows.clear()
  for (const [index, record] of records.entries()) {
    const selected = applicationRecordSchema.parse({ ...record, entry: { ...record.entry, entryId: ids[index] } })
    rows.set(selected.entry.entryId, selected)
  }
  const restored = await host('release-application-owner', f.owner.pool, { maxResponseBytes: 1500 }, events)
  const before = structuredClone(restored.pool.media)
  let page = await restored.access.contributionApplications({ taskId: f.task.id })
  const observed = page.entries.map(item => item.entry.entryId)
  expect(page.nextEntryId).not.toBeNull()
  for (let pages = 0; page.nextEntryId !== null && pages < ids.length; pages++) {
    page = await restored.access.contributionApplications({ taskId: f.task.id, afterEntryId: page.nextEntryId })
    observed.push(...page.entries.map(item => item.entry.entryId))
  }
  expect(page.nextEntryId).toBeNull()
  expect(observed).toEqual(ids.toSorted())
  expect(restored.pool.media).toEqual(before)
  expect(restored.tasks.log()).toEqual(events)
})
