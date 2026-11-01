/** Restore validates independently persisted grants, group members, and owning identities together. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { groupRecordSchema } from '../src/application-schema.ts'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { invitationSchema } from '../src/invitation-schema.ts'
import { cleanup, host } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal

async function fixture() {
  const owner = await host('restore-relations-owner')
  const source = await host('restore-relations-source')
  const task = await owner.createTask()
  const [address] = (await owner.access.identity()).addresses
  if (address === undefined) throw new Error('Missing owner address')
  const expiresAt = Date.now() + 50_000
  const groups = []
  for (let index = 0; index < 2; index++) {
    const { entry } = await owner.access.createGroupEntry({ taskId: task.id, ownerAddress: address,
      expiresAt, maxMembers: 1 })
    const proposal = contributionProposalSchema.parse({ contributorPeerId: source.transport.peerId,
      captureId: randomUUID(), captureGeneration: randomUUID(),
      source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
    const limits = { expiresAt, maxSamples: 4, maxSampleBytes: 4096 }
    expect(await source.access.applyContribution({ entry, proposal, limits }, signal())).toEqual({ status: 'pending' })
    const [application] = (await owner.access.groupApplications({ entryId: entry.entryId })).entries
    if (application === undefined) throw new Error('Missing original group member')
    await owner.access.approveContributionApplication({ entryId: entry.entryId, applicationId: application.applicationId,
      expectedProposal: proposal, limits, ownerAddress: address, read: { responsibility: 'Independent responsibility' } })
    const rows = owner.pool.media.get('scope_group_applications')?.tables.get('entries')
    if (rows === undefined) throw new Error('Missing durable group table')
    groups.push(groupRecordSchema.parse(rows.get(entry.entryId)))
  }
  const [first, second] = groups
  if (first === undefined || second === undefined) throw new Error('Missing independent groups')
  const [firstMember] = first.members
  const [secondMember] = second.members
  if (firstMember?.readInvitation === undefined || secondMember?.readInvitation === undefined) {
    throw new Error('Missing separately approved read plans')
  }
  const grants = (await owner.access.list()).grants
  const events = owner.tasks.log()
  await owner.ctx.fiber.dispose()
  const groupMedium = owner.pool.media.get('scope_group_applications')
  const accessMedium = owner.pool.media.get('scope_access')
  const groupRows = groupMedium?.tables.get('entries')
  const grantRows = accessMedium?.tables.get('grants')
  if (groupMedium === undefined || accessMedium === undefined || groupRows === undefined || grantRows === undefined) {
    throw new Error('Missing retained authorization media')
  }
  return { owner, groups, first, second, firstMember, secondMember, grants, events,
    groupMedium, accessMedium, groupRows, grantRows }
}

it('restores two independent group plans and their exact read permissions without rewriting evidence', async () => {
  const f = await fixture()
  const before = structuredClone(f.owner.pool.media)
  const restored = await host('restore-relations-owner', f.owner.pool, {}, f.events)
  expect((await restored.access.list()).grants).toEqual(f.grants)
  for (const group of f.groups) {
    const [member] = (await restored.access.groupApplications({ entryId: group.entry.entryId })).entries
    expect(member).toMatchObject({ applicationId: group.members[0]?.applicationId, result: {
      status: 'approved', readInvitation: group.members[0]?.readInvitation, readState: 'active',
    } })
  }
  expect(restored.exit).not.toHaveBeenCalled()
  expect(restored.pool.media).toEqual(before)
  expect(restored.tasks.log()).toEqual(f.events)
})

it.each(['missing-read-owner', 'missing-group-owner', 'shared-member', 'shared-contribution', 'shared-read', 'changed-read'] as const)(
  'refuses individually valid persisted records with a %s relation before exposing authority', async (conflict) => {
    const f = await fixture()
    if (conflict === 'missing-read-owner') f.accessMedium.global = { peerId: null }
    if (conflict === 'missing-group-owner') f.groupMedium.global = { peerId: null }
    if (conflict === 'shared-member') f.groupRows.set(f.second.entry.entryId, groupRecordSchema.parse({ ...f.second,
      members: [{ ...f.secondMember, applicationId: f.firstMember.applicationId }] }))
    if (conflict === 'shared-contribution') f.groupRows.set(f.second.entry.entryId, groupRecordSchema.parse({ ...f.second,
      members: [{ ...f.firstMember, applicationId: f.secondMember.applicationId }] }))
    if (conflict === 'shared-read') f.groupRows.set(f.second.entry.entryId, groupRecordSchema.parse({ ...f.second,
      members: [{ ...f.secondMember, readInvitation: f.firstMember.readInvitation }] }))
    if (conflict === 'changed-read') {
      const grant = f.grants.find(item => item.invitation.grantId === f.firstMember.readInvitation?.grantId)
      if (grant === undefined) throw new Error('Missing original read permission')
      f.grantRows.set(grant.invitation.grantId, { ...grant, invitation: invitationSchema.parse({
        ...grant.invitation, responsibility: 'Different retained responsibility',
      }) })
    }
    const before = structuredClone(f.owner.pool.media)
    const restored = await host('restore-relations-owner', f.owner.pool, {}, f.events)
    const message = conflict === 'missing-read-owner' ? 'records have no owning peer identity'
      : conflict === 'missing-group-owner' ? 'groups have no owning peer identity'
        : conflict === 'shared-member' || conflict === 'shared-contribution' ? 'group members share a retained application or grant identity'
          : 'planned read permission differs from its original application'
    await expect(restored.access.identity()).rejects.toThrow(message)
    await expect(restored.access.list()).rejects.toThrow(message)
    expect(restored.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(restored.pool.media).toEqual(before)
    expect(restored.tasks.log()).toEqual(f.events)
  },
)
