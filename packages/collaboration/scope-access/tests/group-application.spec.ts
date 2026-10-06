import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { applicationRecordSchema, applicationRequestSchema, groupRecordSchema, groupReservedBytes } from '../src/application-schema.ts'
import { plannedContributionGrant } from '../src/contribution.ts'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import type { Config } from '../src/index.ts'
import type { ScopeContributionEntry, ScopeContributionProposal } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
let sequence = 0

async function fixture(overrides: Partial<Config> = {}, maxMembers = 4) {
  const suffix = String(++sequence).padStart(3, '0')
  const a = await host(`group-owner-${suffix}`, undefined, overrides)
  const b = await host(`group-source-b-${suffix}`)
  const c = await host(`group-source-c-${suffix}`)
  const task = await a.createTask()
  const ownerAddress = (await a.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner has no published address')
  const created = await a.access.createGroupEntry({ taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000, maxMembers })
  const proposal = (source: typeof b): ScopeContributionProposal => contributionProposalSchema.parse({
    contributorPeerId: source.transport.peerId, captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] },
  })
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096 }
  const requestB = { entry: created.entry, proposal: proposal(b), limits }
  const requestC = { entry: created.entry, proposal: proposal(c), limits }
  const retained = () => groupRecordSchema.parse(a.pool.media.get('scope_group_applications')?.tables.get('entries')?.get(created.entry.entryId))
  const member = async (selection: ScopeContributionProposal) => {
    const row = (await a.access.groupApplications({ entryId: created.entry.entryId })).entries
      .find(item => item.proposal.captureId === selection.captureId)
    if (row === undefined) throw new Error('Applicant has not been retained')
    return row
  }
  const approve = async (selection: ScopeContributionProposal) => {
    const row = await member(selection)
    return await a.access.approveContributionApplication({ entryId: created.entry.entryId, applicationId: row.applicationId,
      expectedProposal: selection, limits, ownerAddress, read: { responsibility: 'Frontend 联合职责' } })
  }
  return { a, b, c, task, ownerAddress, created, limits, requestB, requestC, retained, member, approve }
}

async function approveBoth(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.b.access.applyContribution(f.requestB, signal())).toEqual({ status: 'pending' })
  expect(await f.c.access.applyContribution(f.requestC, signal())).toEqual({ status: 'pending' })
  await f.approve(f.requestB.proposal)
  await f.approve(f.requestC.proposal)
  const b = await f.b.access.contributionApplicationStatus(f.requestB, signal())
  const c = await f.c.access.contributionApplicationStatus(f.requestC, signal())
  if (b.status !== 'approved' || c.status !== 'approved' || b.readInvitation === undefined || c.readInvitation === undefined) {
    throw new Error('Both approved members must retain separate reading permission')
  }
  return { b: { ...b, readInvitation: b.readInvitation }, c: { ...c, readInvitation: c.readInvitation } }
}

it('retains two independently approved members behind the same group entry and reuses neither grant', async () => {
  const f = await fixture()
  expect(await f.a.access.previewContributionText({ text: f.created.text })).toEqual(f.created.entry)
  expect(f.created.entry).toMatchObject({ kind: 'scope-group-entry', version: 2, maxMembers: 4 })
  expect(await f.a.access.contributionApplications({ taskId: f.task.id })).toEqual({ entries: [], nextEntryId: null })
  expect((await f.a.access.list()).grants).toEqual([])
  const { b, c } = await approveBoth(f)
  expect(b.invitation.grant.grantId).not.toBe(c.invitation.grant.grantId)
  expect(b.readInvitation.grantId).not.toBe(c.readInvitation.grantId)
  const rows = (await f.a.access.groupApplications({ entryId: f.created.entry.entryId })).entries
  expect(new Set(rows.map(row => row.applicationId)).size).toBe(2)
  const before = f.a.tasks.log()
  expect(await f.b.access.applyContribution(f.requestB, signal())).toEqual(b)
  await f.approve(f.requestB.proposal)
  expect(f.a.tasks.log()).toEqual(before)
  expect(f.retained().members).toHaveLength(2)
})

it('closes future admission while preserving pending approval and independently revocable approved members', async () => {
  const f = await fixture()
  await f.b.access.applyContribution(f.requestB, signal())
  await f.c.access.applyContribution(f.requestC, signal())
  await f.approve(f.requestB.proposal)
  expect(await f.a.access.closeGroupEntry({ entryId: f.created.entry.entryId })).toMatchObject({ state: 'closed', applicationCount: 2 })
  const unknown = { ...f.requestB, proposal: contributionProposalSchema.parse({ ...f.requestB.proposal, captureId: randomUUID() }) }
  expect(await f.b.access.applyContribution(unknown, signal())).toEqual({ status: 'denied' })
  await f.approve(f.requestC.proposal)
  const c = await f.c.access.contributionApplicationStatus(f.requestC, signal())
  expect(c.status).toBe('approved')
  const memberB = await f.member(f.requestB.proposal)
  expect(await f.a.access.rejectContributionApplication({ entryId: f.created.entry.entryId,
    applicationId: memberB.applicationId, expectedProposal: f.requestB.proposal })).toMatchObject({ result: { status: 'ended', readState: 'revoked' } })
  expect(await f.c.access.contributionApplicationStatus(f.requestC, signal())).toEqual(c)
  expect((await f.a.access.groupEntries({ taskId: f.task.id })).entries[0]).toMatchObject({ state: 'closed', applicationCount: 2 })
  expect((await f.a.access.recoverContributionEntry({
    entryId: f.created.entry.entryId, ownerAddress: f.ownerAddress,
  })).entry).toEqual(f.created.entry)
})

it('retains cancellation before delayed apply per full authenticated capture identity', async () => {
  const f = await fixture()
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toEqual({ status: 'cancelled' })
  expect(await f.b.access.applyContribution(f.requestB, signal())).toEqual({ status: 'cancelled' })
  expect(await f.c.access.applyContribution(f.requestC, signal())).toEqual({ status: 'pending' })
  await f.approve(f.requestC.proposal)
  expect((await f.c.access.contributionApplicationStatus(f.requestC, signal())).status).toBe('approved')
  expect(f.retained().members.map(member => member.decision)).toEqual(['cancelled', 'approved'])
  expect((await f.a.access.list()).grants).toHaveLength(1)
})

it('pins member, entry, proposal, owner and source consent without transferring approval between selections', async () => {
  const f = await fixture()
  await f.b.access.applyContribution(f.requestB, signal())
  await f.c.access.applyContribution(f.requestC, signal())
  const memberB = await f.member(f.requestB.proposal)
  const memberC = await f.member(f.requestC.proposal)
  const approval = { entryId: f.created.entry.entryId, applicationId: memberB.applicationId, expectedProposal: f.requestB.proposal,
    limits: f.limits, ownerAddress: f.ownerAddress, read: { responsibility: 'Frontend' } }
  for (const request of [{ ...approval, applicationId: memberC.applicationId }, { ...approval, entryId: randomUUID() },
    { ...approval, expectedProposal: f.requestC.proposal }, { ...approval, applicationId: undefined }]) {
    await expect(f.a.access.approveContributionApplication(request as typeof approval)).rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  }
  expect(await f.c.access.applyContribution({ ...f.requestB, proposal: f.requestC.proposal,
    entry: { ...f.created.entry, maxMembers: 5 } }, signal())).toEqual({ status: 'denied' })
  expect(await f.b.access.applyContribution({ ...f.requestB, limits: { ...f.limits, maxSamples: 7 } }, signal())).toEqual({ status: 'denied' })
  const changed = contributionProposalSchema.parse({ ...f.requestB.proposal, source: { ...f.requestB.proposal.source, name: 'changed' } })
  expect(await f.b.access.applyContribution({ ...f.requestB, proposal: changed }, signal())).toEqual({ status: 'denied' })
  expect(f.a.tasks.peerContributions({})).toEqual([])
})

it('serializes the final member slot and keeps terminal members and group entries in shared capacity', async () => {
  const f = await fixture({ maxContributionApplications: 3 }, 1)
  const results = await Promise.all([
    f.b.access.applyContribution(f.requestB, signal()), f.c.access.applyContribution(f.requestC, signal()),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['capacity', 'pending'])
  const winner = results[0]?.status === 'pending' ? { source: f.b, request: f.requestB } : { source: f.c, request: f.requestC }
  await winner.source.access.cancelContributionApplication(winner.request, signal())
  expect(f.retained().members).toHaveLength(1)
  await f.a.access.createContributionEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.created.entry.expiresAt, sourceKind: 'tool-observations' })
  await expect(f.a.access.createGroupEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.created.entry.expiresAt, maxMembers: 1 })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  await expect(f.a.access.createContributionEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.created.entry.expiresAt, sourceKind: 'tool-observations' })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
})

it('counts concurrent group members against the shared single-entry inventory', async () => {
  const f = await fixture({ maxContributionApplications: 2 }, 2)
  const results = await Promise.all([
    f.b.access.applyContribution(f.requestB, signal()), f.c.access.applyContribution(f.requestC, signal()),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['capacity', 'pending'])
  expect(f.retained().members).toHaveLength(1)
})

it('preserves approved member lifetimes but never extends pending approval past the entry deadline', async () => {
  const f = await fixture()
  await f.b.access.applyContribution(f.requestB, signal())
  await f.c.access.applyContribution(f.requestC, signal())
  await f.approve(f.requestB.proposal)
  await f.a.access.closeGroupEntry({ entryId: f.created.entry.entryId })
  vi.spyOn(Date, 'now').mockReturnValue(f.created.entry.expiresAt)
  await expect(f.approve(f.requestC.proposal)).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
  expect((await f.b.access.contributionApplicationStatus(f.requestB, signal())).status).toBe('approved')
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toMatchObject({ status: 'ended', readState: 'revoked' })
})

it.each([['group', 'group'], ['single', 'group'], ['group', 'single'], ['single', 'single']] as const)(
  'refuses same Task capture aliases from %s to %s without letting the second cancellation end the first grant', async (firstKind, secondKind) => {
    const f = await fixture()
    const create = async (kind: 'group' | 'single'): Promise<ScopeContributionEntry> => kind === 'group'
      ? (await f.a.access.createGroupEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
        expiresAt: f.created.entry.expiresAt, maxMembers: 2 })).entry
      : (await f.a.access.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations', taskId: f.task.id,
        ownerAddress: f.ownerAddress, expiresAt: f.created.entry.expiresAt })).entry
    const first = { ...f.requestB, entry: await create(firstKind) }
    const second = { ...f.requestB, entry: await create(secondKind) }
    await f.b.access.applyContribution(first, signal())
    const member = first.entry.kind === 'scope-group-entry'
      ? (await f.a.access.groupApplications({ entryId: first.entry.entryId })).entries[0] : undefined
    await f.a.access.approveContributionApplication({ entryId: first.entry.entryId,
      ...(member === undefined ? {} : { applicationId: member.applicationId }), expectedProposal: first.proposal,
      limits: first.limits, ownerAddress: f.ownerAddress, read: { responsibility: 'Frontend' } })
    const approved = await f.b.access.contributionApplicationStatus(first, signal())
    expect(await f.b.access.applyContribution(second, signal())).toEqual({ status: 'denied' })
    expect(await f.b.access.cancelContributionApplication(second, signal())).toEqual({ status: 'denied' })
    expect(await f.b.access.contributionApplicationStatus(first, signal())).toEqual(approved)
    const events = f.a.tasks.log()
    await f.a.ctx.fiber.dispose()
    const restored = await host(f.a.transport.peerId, f.a.pool, {}, events)
    expect((await restored.access.list()).grants).toHaveLength(1)
    expect(await f.b.access.contributionApplicationStatus(first, signal())).toEqual(approved)
  })

it('allows the same capture to apply independently to another owned Task', async () => {
  const f = await fixture()
  await f.b.access.applyContribution(f.requestB, signal())
  const task = await f.a.createTask('Another independent goal')
  const entry = (await f.a.access.createGroupEntry({ taskId: task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.created.entry.expiresAt, maxMembers: 2 })).entry
  expect(await f.b.access.applyContribution({ ...f.requestB, entry }, signal())).toEqual({ status: 'pending' })
})

it('reserves complete group bytes for cancellation of every member after another member fills the row', async () => {
  const measured = await fixture()
  await measured.b.access.applyContribution(measured.requestB, signal())
  await measured.c.access.applyContribution(measured.requestC, signal())
  const maximum = Buffer.byteLength(JSON.stringify({ ...measured.retained(), closed: false,
    members: measured.retained().members.map(member => ({ ...member, decision: 'cancelled' })) }), 'utf8')
  const f = await fixture({ maxApplicationRequestBytes: maximum })
  expect(await f.b.access.applyContribution(f.requestB, signal())).toEqual({ status: 'pending' })
  expect(await f.c.access.applyContribution(f.requestC, signal())).toEqual({ status: 'pending' })
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toEqual({ status: 'cancelled' })
  expect(await f.c.access.cancelContributionApplication(f.requestC, signal())).toEqual({ status: 'cancelled' })
  expect(await f.a.access.closeGroupEntry({ entryId: f.created.entry.entryId })).toMatchObject({ state: 'closed' })
  const tooSmall = await fixture({ maxApplicationRequestBytes: maximum - 1 })
  await tooSmall.b.access.applyContribution(tooSmall.requestB, signal())
  expect(await tooSmall.c.access.applyContribution(tooSmall.requestC, signal())).toEqual({ status: 'capacity' })
  expect(tooSmall.retained().members).toHaveLength(1)
})

it('reserves pending read plans before Task commits and restores both members independently after owner restart', async () => {
  const f = await fixture({ maxGrants: 1 })
  await f.b.access.applyContribution(f.requestB, signal())
  await f.c.access.applyContribution(f.requestC, signal())
  const stop = f.a.ctx.on('scope-access/contribution-application-changed', () => {
    if (f.retained().members.some(member => member.decision === 'approved')) f.a.pool.failNextWrites = 1
  })
  await expect(f.approve(f.requestB.proposal)).rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  stop()
  expect((await f.a.access.list()).grants).toEqual([])
  await expect(f.approve(f.requestC.proposal)).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  const planned = f.retained().members.find(member => member.decision === 'approved')
  if (planned?.readInvitation === undefined) throw new Error('Read plan was not retained')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const restored = await host(f.a.transport.peerId, f.a.pool, { maxGrants: 1 }, events)
  expect(await f.b.access.contributionApplicationStatus(f.requestB, signal())).toMatchObject({ status: 'approved',
    readInvitation: planned.readInvitation, invitation: { grant: planned.grant } })
  expect((await restored.access.list()).grants).toHaveLength(1)
  expect((await restored.access.groupApplications({ entryId: f.created.entry.entryId })).entries).toHaveLength(2)
})

it('leaves other members unchanged when one application update fails to persist', async () => {
  const f = await fixture()
  const { c } = await approveBoth(f)
  const before = f.retained()
  f.a.pool.failNextWrites = 1
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toEqual({ status: 'unavailable' })
  expect(f.retained()).toEqual(before)
  expect(await f.c.access.contributionApplicationStatus(f.requestC, signal())).toEqual(c)
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toMatchObject({ status: 'ended', readState: 'revoked' })
  expect(await f.c.access.contributionApplicationStatus(f.requestC, signal())).toEqual(c)
})

it('recovers per-member cancellation after a failed read revocation without mutating another member', async () => {
  const f = await fixture()
  const { c } = await approveBoth(f)
  const stop = f.a.ctx.on('scope-access/contribution-application-changed', () => {
    if (f.retained().members.some(member => member.decision === 'cancelled')) f.a.pool.failNextWrites = 1
  })
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toEqual({ status: 'unavailable' })
  stop()
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  await host(f.a.transport.peerId, f.a.pool, {}, events)
  expect(await f.b.access.contributionApplicationStatus(f.requestB, signal())).toMatchObject({ status: 'ended', readState: 'revoked' })
  expect(await f.c.access.contributionApplicationStatus(f.requestC, signal())).toEqual(c)
})

it('never accepts reusable records or requests under the single-capture storage and wire version', async () => {
  const f = await fixture()
  expect(applicationRecordSchema.safeParse({ entry: f.created.entry, decision: 'open', proposal: null, limits: null, grant: null }).success).toBe(false)
  expect(applicationRequestSchema.safeParse({ version: 1, requestId: randomUUID(), op: 'apply', ...f.requestB }).success).toBe(false)
  const legacy = f.a.transport.handlers.get('/agentharness/scope-apply/1')
  if (legacy === undefined) throw new Error('Missing original protocol')
  await expect(legacy({ peerId: f.b.transport.peerId,
    payload: { version: 2, requestId: randomUUID(), op: 'apply', ...f.requestB }, signal: signal() })).rejects.toThrow()
  expect(f.retained().members).toEqual([])
})

it.each(['owner', 'application', 'capture', 'grant', 'budget'] as const)('refuses restored group %s conflicts', async (field) => {
  const f = await fixture()
  await approveBoth(f)
  const record = f.retained()
  const [b, c] = record.members
  if (b === undefined || c === undefined) throw new Error('Missing members')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const records = f.a.pool.media.get('scope_group_applications')?.tables.get('entries')
  if (records === undefined) throw new Error('Group table is absent')
  if (field === 'owner') records.set(record.entry.entryId, { ...record, entry: { ...record.entry, ownerPeerId: peer('another-owner') } })
  if (field === 'application') records.set(record.entry.entryId, { ...record, members: [b, { ...c, applicationId: b.applicationId }] })
  if (field === 'capture') records.set(record.entry.entryId, { ...record, members: [b, { ...c, proposal: b.proposal }] })
  if (field === 'grant') records.set(record.entry.entryId, { ...record, members: [b, { ...c, readInvitation: b.readInvitation }] })
  const restored = await host(f.a.transport.peerId, f.a.pool,
    field === 'budget' ? { maxApplicationRequestBytes: groupReservedBytes(record) - 1 } : {}, events)
  await expect(restored.access.identity()).rejects.toThrow()
  expect(restored.exit).toHaveBeenCalledWith(1)
})

it('removes both versioned group endpoints and closes its durable domain when disposed', async () => {
  const f = await fixture()
  await f.a.ctx.fiber.dispose()
  expect(f.a.transport.handlers.has('/agentharness/scope-apply/2')).toBe(false)
  expect(f.a.transport.handlers.has('/agentharness/scope-entry-probe/2')).toBe(false)
  await expect(f.b.access.applyContribution(f.requestB, signal())).resolves.toEqual({ status: 'unavailable' })
})

it('does not invent approval after a lost response and recovers the original member on retry', async () => {
  const f = await fixture()
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  expect(await f.b.access.applyContribution(f.requestB, signal())).toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  expect(await f.b.access.applyContribution(f.requestB, signal())).toEqual({ status: 'pending' })
  expect(f.retained().members).toHaveLength(1)
  expect((await f.a.access.list()).grants).toEqual([])
})


it('paginates complete member and entrance JSON without dropping another member or accepting a foreign cursor', async () => {
  const measured = await fixture()
  await measured.b.access.applyContribution(measured.requestB, signal())
  await measured.c.access.applyContribution(measured.requestC, signal())
  const row = (await measured.a.access.groupApplications({ entryId: measured.created.entry.entryId })).entries[0]
  if (row === undefined) throw new Error('Missing measured member')
  const maximum = Buffer.byteLength(JSON.stringify({ entries: [row], nextApplicationId: row.applicationId }), 'utf8')
  const f = await fixture({ maxResponseBytes: maximum })
  await f.b.access.applyContribution(f.requestB, signal())
  await f.c.access.applyContribution(f.requestC, signal())
  const first = await f.a.access.groupApplications({ entryId: f.created.entry.entryId })
  expect(first.entries).toHaveLength(1)
  if (first.nextApplicationId === null) throw new Error('First member page must continue')
  const second = await f.a.access.groupApplications({ entryId: f.created.entry.entryId, afterApplicationId: first.nextApplicationId })
  expect(second.entries).toHaveLength(1)
  expect(second.nextApplicationId).toBeNull()
  expect(new Set([...first.entries, ...second.entries].map(item => item.applicationId)).size).toBe(2)
  expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(maximum)
  expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(maximum)
  const other = await f.a.access.createGroupEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.created.entry.expiresAt, maxMembers: 2 })
  await expect(f.a.access.groupApplications({ entryId: other.entry.entryId, afterApplicationId: first.nextApplicationId }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  for (let i = 0; i < 3; i++) await f.a.access.createGroupEntry({ taskId: f.task.id, ownerAddress: f.ownerAddress,
    expiresAt: f.created.entry.expiresAt, maxMembers: 2 })
  let page = await f.a.access.groupEntries({ taskId: f.task.id })
  const ids = new Set(page.entries.map(item => item.entry.entryId))
  expect(page.nextEntryId).not.toBeNull()
  for (let i = 0; page.nextEntryId !== null && i < 6; i++) {
    page = await f.a.access.groupEntries({ taskId: f.task.id, afterEntryId: page.nextEntryId })
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(maximum)
    for (const item of page.entries) { expect(ids.has(item.entry.entryId)).toBe(false); ids.add(item.entry.entryId) }
  }
  expect(page.nextEntryId).toBeNull()
  expect(ids.size).toBe(5)
})

it('keeps group probes read-only and reports ready, capacity, closed and expired without revealing members', async () => {
  const ownerPeer = peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy')
  const a = await host('group-probe-owner', undefined, {}, [], ownerPeer)
  const b = await host('group-probe-source')
  const task = await a.createTask('Private goal')
  const ownerAddress = (await a.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing route')
  const entry = (await a.access.createGroupEntry({ taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000, maxMembers: 1 })).entry
  await b.access.identity()
  const before = structuredClone(a.pool.media)
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
  expect(a.pool.media).toEqual(before)
  const payload = { version: 2, requestId: randomUUID(), entry }
  const legacy = a.transport.handlers.get('/agentharness/scope-entry-probe/1')
  if (legacy === undefined) throw new Error('Missing original probe')
  await expect(legacy({ peerId: b.transport.peerId, payload, signal: signal() })).rejects.toThrow()
  expect(await b.access.probeContributionEntry({ entry: { ...entry, maxMembers: 2 } })).toEqual({ status: 'denied' })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: b.transport.peerId, captureId: randomUUID(),
    captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'work', tools: ['Write'] } })
  await b.access.applyContribution({ entry, proposal,
    limits: { expiresAt: Date.now() + 30_000, maxSamples: 3, maxSampleBytes: 1000 } }, signal())
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'capacity' })
  vi.spyOn(Date, 'now').mockReturnValue(entry.expiresAt)
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'expired' })
  vi.restoreAllMocks()
  await a.access.closeGroupEntry({ entryId: entry.entryId })
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'closed' })
})


it.each(['cancel', 'reject'] as const)('does not let an unapproved group member %s an independent manual grant', async (operation) => {
  const f = await fixture()
  const grant = plannedContributionGrant(f.created.entry.ownerPeerId, { taskId: f.task.id,
    proposal: f.requestB.proposal, ownerAddress: f.ownerAddress, ...f.limits })
  await f.a.access.inviteContribution({ ownerAddress: f.ownerAddress, grant })
  if (operation === 'cancel') {
    expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toEqual({ status: 'cancelled' })
  } else {
    await f.b.access.applyContribution(f.requestB, signal())
    const member = await f.member(f.requestB.proposal)
    expect(await f.a.access.rejectContributionApplication({ entryId: f.created.entry.entryId,
      applicationId: member.applicationId, expectedProposal: member.proposal })).toMatchObject({ result: { status: 'rejected' } })
  }
  expect(f.a.tasks.peerContributions({})[0]).toMatchObject({ state: 'active', grant })
  expect((await f.a.access.list()).grants).toEqual([])
})

it('allows explicit owner approval to adopt an exact manual contribution before member cancellation ends it', async () => {
  const f = await fixture()
  const grant = plannedContributionGrant(f.created.entry.ownerPeerId, { taskId: f.task.id,
    proposal: f.requestB.proposal, ownerAddress: f.ownerAddress, ...f.limits })
  await f.a.access.inviteContribution({ ownerAddress: f.ownerAddress, grant })
  await f.b.access.applyContribution(f.requestB, signal())
  await f.approve(f.requestB.proposal)
  expect(f.retained().members[0]).toMatchObject({ decision: 'approved', grant })
  expect(await f.b.access.cancelContributionApplication(f.requestB, signal())).toMatchObject({ status: 'ended', readState: 'revoked' })
})


it('reserves the longest legal terminal read state before persisting either approved permission', async () => {
  const measured = await fixture()
  await measured.b.access.applyContribution(measured.requestB, signal())
  await measured.approve(measured.requestB.proposal)
  const approved = await measured.b.access.contributionApplicationStatus(measured.requestB, signal())
  if (approved.status !== 'approved') throw new Error('Measured member is not approved')
  const worst = { version: 2, requestId: randomUUID(), op: 'cancel', result: { ...approved, status: 'ended',
    reason: 'expired', readState: 'revoked', receipt: { ...approved.receipt, revision: Number.MAX_SAFE_INTEGER,
      event: { ...approved.receipt.event, seq: Number.MAX_SAFE_INTEGER, kind: 'peer-contribution-ended' } } } }
  const maximum = Buffer.byteLength(JSON.stringify(worst), 'utf8')
  const narrow = await fixture({ maxResponseBytes: maximum - 1 })
  expect(await narrow.b.access.applyContribution(narrow.requestB, signal())).toEqual({ status: 'pending' })
  await expect(narrow.approve(narrow.requestB.proposal)).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(narrow.retained().members[0]).toMatchObject({ decision: 'pending', grant: null })
  expect(narrow.retained().members[0]?.readInvitation).toBeUndefined()
  expect((await narrow.a.access.list()).grants).toEqual([])
  expect(narrow.a.tasks.peerContributions({})).toEqual([])
  const enough = await fixture({ maxResponseBytes: maximum })
  await enough.b.access.applyContribution(enough.requestB, signal())
  await enough.approve(enough.requestB.proposal)
  expect(await enough.b.access.cancelContributionApplication(enough.requestB, signal())).toMatchObject({ status: 'ended', readState: 'revoked' })
})
