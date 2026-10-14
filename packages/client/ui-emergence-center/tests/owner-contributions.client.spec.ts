import { describe, expect, it, vi } from 'vitest'
import type { ScopeGroupEntry, ScopeGroupApplication } from '@deepseek-ai/dsh-api-remotes/client'
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
