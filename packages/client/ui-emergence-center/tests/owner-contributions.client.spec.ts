import { describe, expect, it, vi } from 'vitest'
import type { DevelopmentNodeId, ScopeContributionApplication, ScopeContributionInventory,
  ScopeGroupEntry, ScopeGroupApplication } from '@deepseek-ai/dsh-api-remotes/client'
import { readOwnerContributions, type OwnerContributionPort } from '../src/client/owner-contributions.ts'
import { applicationEntry, capture } from './native-contribution-fixture.client.ts'

const entry: ScopeGroupEntry = { ...applicationEntry, version: 2, kind: 'scope-group-entry', sourceKind: 'tool-observations', maxMembers: 3 }
const group = { entry, text: 'one-reusable-entry', state: 'open' as const, applicationCount: 2 }
function member(name: string): ScopeGroupApplication {
  return { entry, text: group.text, applicationId: name as ScopeGroupApplication['applicationId'],
    proposal: { ...capture.proposal, contributorPeerId: name as ScopeGroupApplication['proposal']['contributorPeerId'] },
    limits: capture.limits, result: { status: 'pending' } }
}
function fixture() {
  const first = member('application-b')
  const second = member('application-c')
  const port: OwnerContributionPort = {
    identity: vi.fn(async () => ({ peerId: entry.ownerPeerId, addresses: [entry.ownerAddress] })),
    contributionInventory: vi.fn(async () => ({ entries: [], nextGrantId: null })),
    contributionApplications: vi.fn(async () => ({ entries: [], nextEntryId: null })),
    groupEntries: vi.fn(async () => ({ entries: [group], nextEntryId: null })),
    groupApplications: vi.fn(async () => ({ entries: [first], nextApplicationId: first.applicationId })),
  }
  return { port, first, second }
}

describe('owner reusable-entry pagination', () => {
  it('retains grant and single-use application pages after their cursors finish while other streams continue', async () => {
    const { port, first, second } = fixture()
    const grant = { version: 1 as const, taskId: entry.taskId, ownerPeerId: entry.ownerPeerId,
      ...capture.proposal, ...capture.limits,
      grantId: 'grant-a' as ScopeContributionInventory['entries'][number]['grant']['grantId'],
      generation: 'grant-generation' as ScopeContributionInventory['entries'][number]['grant']['generation'] }
    const receipt = { taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
      grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId,
      captureGeneration: grant.captureGeneration, revision: 2,
      event: { nodeId: 'owner-node' as DevelopmentNodeId, seq: 2, kind: 'peer-contribution-opened' as const } }
    const active: ScopeContributionInventory['entries'][number] = { grant, state: 'active', openReceipt: receipt }
    const otherGrant = { ...active, grant: { ...grant,
      grantId: 'grant-b' as typeof grant.grantId, captureId: 'capture-b' as typeof grant.captureId },
    openReceipt: { ...receipt, grantId: 'grant-b' as typeof grant.grantId, captureId: 'capture-b' as typeof grant.captureId,
      revision: 4, event: { ...receipt.event, seq: 4 } } }
    const pending: ScopeContributionApplication = { entry: applicationEntry, text: 'single-use-entry',
      proposal: capture.proposal, limits: capture.limits, result: { status: 'pending' } }
    const open: ScopeContributionApplication = { entry: { ...applicationEntry,
      entryId: 'entry-b' as typeof applicationEntry.entryId }, text: 'another-single-use-entry',
    proposal: null, limits: null, result: { status: 'open' } }
    vi.mocked(port.contributionInventory).mockResolvedValueOnce({ entries: [active], nextGrantId: grant.grantId })
    vi.mocked(port.contributionApplications).mockResolvedValueOnce({ entries: [pending], nextEntryId: pending.entry.entryId })
    const initial = await readOwnerContributions(port, entry.taskId)
    vi.mocked(port.contributionInventory).mockResolvedValueOnce({ entries: [otherGrant], nextGrantId: null })
    vi.mocked(port.contributionApplications).mockResolvedValueOnce({ entries: [open], nextEntryId: null })
    vi.mocked(port.groupApplications).mockResolvedValueOnce({ entries: [second], nextApplicationId: second.applicationId })
    const next = await readOwnerContributions(port, entry.taskId, initial)
    expect(port.contributionInventory).toHaveBeenNthCalledWith(1, { taskId: entry.taskId })
    expect(port.contributionApplications).toHaveBeenNthCalledWith(1, { taskId: entry.taskId })
    expect(port.contributionInventory).toHaveBeenLastCalledWith({ taskId: entry.taskId, afterGrantId: grant.grantId })
    expect(port.contributionApplications).toHaveBeenLastCalledWith({ taskId: entry.taskId, afterEntryId: pending.entry.entryId })
    expect(next.inventory).toEqual({ entries: [active, otherGrant], nextGrantId: null })
    expect(next.applications).toEqual({ entries: [pending, open], nextEntryId: null })
    const third = member('application-d')
    vi.mocked(port.groupApplications).mockResolvedValueOnce({ entries: [third], nextApplicationId: null })
    const more = await readOwnerContributions(port, entry.taskId, next)
    expect(more.inventory).toEqual(next.inventory)
    expect(more.applications).toEqual(next.applications)
    expect(more.groups.entries[0]?.applications.entries).toEqual([first, second, third])
    expect(port.contributionInventory).toHaveBeenCalledTimes(2)
    expect(port.contributionApplications).toHaveBeenCalledTimes(2)
    expect(port.groupEntries).toHaveBeenCalledOnce()
    expect(port.groupApplications).toHaveBeenCalledTimes(3)
  })

  it('appends members with separate application ids under the same entry and resumes only unfinished cursors', async () => {
    const { port, first, second } = fixture()
    const page = await readOwnerContributions(port, entry.taskId)
    vi.mocked(port.groupApplications).mockResolvedValueOnce({ entries: [first, second], nextApplicationId: null })
    const more = await readOwnerContributions(port, entry.taskId, page)
    expect(more.groups.entries).toEqual([{ group, applications: { entries: [first, second], nextApplicationId: null } }])
    expect(port.groupApplications).toHaveBeenLastCalledWith({ entryId: entry.entryId, afterApplicationId: first.applicationId })
    expect(port.groupEntries).toHaveBeenCalledOnce()
    expect(port.contributionInventory).toHaveBeenCalledOnce()
    expect(port.contributionApplications).toHaveBeenCalledOnce()
    await readOwnerContributions(port, entry.taskId, more)
    expect(port.groupApplications).toHaveBeenCalledTimes(2)
  })

  it('refreshes closed entries and changed member authority without carrying stale pages forward', async () => {
    const { port, first, second } = fixture()
    await readOwnerContributions(port, entry.taskId)
    const closed = { ...group, state: 'closed' as const }
    const rejected = { ...second, result: { status: 'rejected' as const } }
    vi.mocked(port.groupEntries).mockResolvedValueOnce({ entries: [closed], nextEntryId: null })
    vi.mocked(port.groupApplications).mockResolvedValueOnce({ entries: [rejected], nextApplicationId: null })
    const fresh = await readOwnerContributions(port, entry.taskId)
    expect(fresh.groups.entries).toEqual([{ group: closed, applications: { entries: [rejected], nextApplicationId: null } }])
    expect(fresh.groups.entries[0]?.applications.entries).not.toContainEqual(first)
    expect(port.groupApplications).toHaveBeenLastCalledWith({ entryId: entry.entryId })
  })

  it('pages group entries and each group’s applicants independently', async () => {
    const { port, first, second } = fixture()
    const otherEntry: ScopeGroupEntry = { ...entry, entryId: 'group-other' as ScopeGroupEntry['entryId'] }
    vi.mocked(port.groupEntries).mockResolvedValueOnce({ entries: [group], nextEntryId: entry.entryId })
    const initial = await readOwnerContributions(port, entry.taskId)
    vi.mocked(port.groupEntries).mockResolvedValueOnce({ entries: [{ ...group, entry: otherEntry }], nextEntryId: null })
    vi.mocked(port.groupApplications).mockImplementation(async request => request.entryId === entry.entryId
      ? { entries: [second], nextApplicationId: null }
      : { entries: [{ ...first, entry: otherEntry }], nextApplicationId: null })
    const next = await readOwnerContributions(port, entry.taskId, initial)
    expect(port.groupEntries).toHaveBeenLastCalledWith({ taskId: entry.taskId, afterEntryId: entry.entryId })
    expect(next.groups.entries.map(value => value.applications.entries.length)).toEqual([2, 1])
    expect(port.groupApplications).toHaveBeenCalledWith({ entryId: otherEntry.entryId })
  })
})
