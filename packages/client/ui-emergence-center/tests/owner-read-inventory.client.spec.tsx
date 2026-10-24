// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  ClaudeScopeSessionSummary, DevelopmentNodeId, DevelopmentTaskSnapshot, ScopeAccessList, ScopeContributionApplicationApprovalRequest,
  ScopeContributionInvitation, ScopeGroupApplication, ScopeGroupEntry, ScopeInvitation,
} from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { applicationEntry, capture } from './native-contribution-fixture.client.ts'
import { invitation as originalRead, observable } from './native-scope-fixture.client.ts'

// Graph geometry is independent of permission controls; the real panel and slot assembly remain mounted.
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Background: () => null, Controls: () => null, MiniMap: () => null,
}))

const runtimes: SlotTestRuntime[] = []
afterEach(async () => {
  const settled = await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.dispose()))
  const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'Owner inventory fixture cleanup failed')
})

const nodeId = 'owner-node' as DevelopmentNodeId
const groupEntry: ScopeGroupEntry = { ...applicationEntry, version: 2, kind: 'scope-group-entry', maxMembers: 2 }
const member: ScopeGroupApplication = {
  entry: groupEntry, text: JSON.stringify(groupEntry),
  applicationId: 'application-source' as ScopeGroupApplication['applicationId'],
  proposal: capture.proposal, limits: capture.limits, result: { status: 'pending' },
}
const contribution: ScopeContributionInvitation = {
  version: 1, kind: 'tool-contribution', ownerAddress: groupEntry.ownerAddress,
  grant: { version: 1, taskId: groupEntry.taskId, ownerPeerId: groupEntry.ownerPeerId,
    ...capture.proposal, ...capture.limits,
    grantId: 'contribution-grant' as ScopeContributionInvitation['grant']['grantId'],
    generation: 'contribution-generation' as ScopeContributionInvitation['grant']['generation'] },
}
const readInvitation: ScopeInvitation = { ...originalRead, taskId: groupEntry.taskId,
  ownerPeerId: groupEntry.ownerPeerId, ownerAddress: groupEntry.ownerAddress,
  recipientPeerId: capture.proposal.contributorPeerId, expiresAt: capture.limits.expiresAt,
}
const receipt = { taskId: groupEntry.taskId, ownerPeerId: groupEntry.ownerPeerId,
  contributorPeerId: contribution.grant.contributorPeerId, grantId: contribution.grant.grantId,
  generation: contribution.grant.generation, captureId: contribution.grant.captureId,
  captureGeneration: contribution.grant.captureGeneration, revision: 2,
  event: { nodeId, seq: 2, kind: 'peer-contribution-opened' as const },
}
const task: DevelopmentTaskSnapshot = { id: groupEntry.taskId, ownerNodeId: nodeId, revision: 2,
  origin: { kind: 'root' }, hiddenRoomId: 'owner-room' as DevelopmentTaskSnapshot['hiddenRoomId'],
  runtime: 'ready', objective: 'Connect independent frontend work', scope: 'Shared API decisions',
  createdBy: 'human-owner' as DevelopmentTaskSnapshot['createdBy'], context: [], createdAt: 1, updatedAt: 2,
}

function ok<T>(value: T) { return { ok: true as const, value } }

async function mountOwner(initiallyApproved: boolean, recipientState?: 'available' | 'joined') {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // This root-only entry requires no transport operations or native Session header.
  runtime.ctx.provide('connection', { generation: observable(undefined) } as never)
  let approved = initiallyApproved
  let readGrant: ScopeAccessList['grants'][number] | undefined = initiallyApproved
    ? { invitation: readInvitation, state: 'active' } : undefined
  const currentMember = (): ScopeGroupApplication => ({ ...member, result: !approved ? { status: 'pending' }
    : { status: 'approved', invitation: contribution, receipt, readInvitation,
      readState: readGrant?.state === 'revoked' ? 'revoked' : 'active' } })
  const list = vi.fn(async () => ok({ grants: readGrant === undefined ? [] : [readGrant], subscriptions: [] } satisfies ScopeAccessList))
  const groupApplications = vi.fn(async () => ok({ entries: [currentMember()], nextApplicationId: null }))
  const approve = vi.fn(async (request: ScopeContributionApplicationApprovalRequest) => {
    expect(request).toEqual({ entryId: groupEntry.entryId, applicationId: member.applicationId,
      expectedProposal: member.proposal, limits: member.limits, ownerAddress: groupEntry.ownerAddress,
      read: { responsibility: readInvitation.responsibility } })
    approved = true
    remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    readGrant = { invitation: readInvitation, state: 'active' }
    remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    return ok(currentMember())
  })
  const revoke = vi.fn(async (request: { grantId: ScopeInvitation['grantId'] }) => {
    expect(request.grantId).toBe(readInvitation.grantId)
    readGrant = { invitation: readInvitation, state: 'revoked' }
    remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    return ok(undefined)
  })
  const recipient: ClaudeScopeSessionSummary = { sessionKey: 'claude-recipient' as ClaudeScopeSessionSummary['sessionKey'],
    sessionId: 'original-claude-session', observedAt: 1, ended: false, readRevision: 0 }
  const receiving: ClaudeScopeSessionSummary = { ...recipient, readRevision: 1,
    receiveSubscriptionId: 'subscription' as NonNullable<ClaudeScopeSessionSummary['receiveSubscriptionId']>,
    receiveTaskId: groupEntry.taskId, receiveState: 'pending' }
  let observed = recipientState === 'joined' ? receiving : recipient
  const sessions = vi.fn(async () => ok(recipientState === undefined ? [] : [observed]))
  const receive = vi.fn(async () => { observed = receiving; return ok(observed) })
  const receiveLeave = vi.fn(async () => { observed = recipient; return ok(observed) })
  const remote = new TestRemote(runtime.ctx, {
    developmentRooms: { list: async () => ok({ nodeId, participants: [], rooms: [], presenceTtlMs: 15_000 }) },
    developmentTasks: {
      list: async () => ok([task]), lineage: async () => ok({ tasks: [task], boundaryTaskIds: [] }),
      observedCandidates: async () => ok([]), observedIntervals: async () => ok([]),
    },
    developmentTaskAssignments: { list: async () => ok([]) },
    mcpClientSetup: { list: async () => ok({ clients: [] }) },
    claudeScope: { sessions, receive, receiveLeave },
    scopeAgentContext: {}, scopeAgentContributions: {},
    scopeAccess: {
      identity: async () => ok({ peerId: groupEntry.ownerPeerId, addresses: [groupEntry.ownerAddress] }),
      list, revoke,
      contributionInventory: async () => ok({ entries: [], nextGrantId: null }),
      contributionApplications: async () => ok({ entries: [], nextEntryId: null }),
      groupEntries: async () => ok({ entries: [{ entry: groupEntry, text: JSON.stringify(groupEntry),
        state: 'open', applicationCount: 1 }], nextEntryId: null }),
      groupApplications, approveContributionApplication: approve,
    },
  })
  await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject, apply })
  runtime.renderSlot('sidebar.footer.action', { wide: true })
  fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
  fireEvent.click(await screen.findByText(zh['contribution.ownerTitle']))
  fireEvent.click(screen.getByText(zh['access.title']))
  await screen.findByLabelText(zh['access.identity'])
  const access = screen.getByText(zh['access.title']).closest('details')!
  const application = await waitFor(() => {
    const value = document.querySelector(`[data-group-application="${member.applicationId}"]`)
    expect(value).toBeInstanceOf(HTMLElement)
    return value as HTMLElement
  })
  return { runtime, application, access, approve, revoke, list, groupApplications, sessions, receive, receiveLeave, recipient,
    authority: () => readGrant,
    revokeFromAnotherClient() {
      readGrant = { invitation: readInvitation, state: 'revoked' }
      remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    } }
}

describe('Emergence Center owner read inventory', () => {
  it('shows a newly approved group member in the independent read revocation controls on the same page', async () => {
    const subject = await mountOwner(false)
    expect(subject.list).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: zh['access.revoke'] })).toBeNull()
    fireEvent.change(within(subject.application).getByLabelText(zh['contribution.join.responsibility']),
      { target: { value: readInvitation.responsibility } })
    fireEvent.click(within(subject.application).getByRole('button', { name: zh['contribution.join.approve'] }))
    await within(subject.application).findByText(zh['contribution.join.read.active'])
    expect(subject.approve).toHaveBeenCalledOnce()
    expect(subject.authority()).toEqual({ invitation: readInvitation, state: 'active' })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.revoke'] }).disabled).toBe(false)
    })
  })

  it('updates the member read state after independently revoking its read grant on the same page', async () => {
    const subject = await mountOwner(true)
    expect(within(subject.application).getByText(zh['contribution.join.read.active'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['access.revoke'] }))
    await screen.findByText(zh['access.revoked'])
    expect(subject.revoke).toHaveBeenCalledOnce()
    expect(subject.authority()).toEqual({ invitation: readInvitation, state: 'revoked' })
    await within(subject.application).findByText(zh['contribution.join.read.revoked'])
    expect(within(subject.application).queryByText(zh['contribution.join.read.active'])).toBeNull()
  })

  it('updates both inventories when another client revokes the member read permission', async () => {
    const subject = await mountOwner(true)
    expect(screen.getByRole('button', { name: zh['access.revoke'] })).toBeTruthy()
    await act(async () => { subject.revokeFromAnotherClient() })
    await screen.findByText(zh['access.revoked'])
    await within(subject.application).findByText(zh['contribution.join.read.revoked'])
    expect(subject.revoke).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: zh['access.revoke'] })).toBeNull()
    expect(within(subject.application).queryByText(zh['contribution.join.read.active'])).toBeNull()
  })

  it.each(['receive', 'stop'] as const)('refreshes the original Claude session after %s while inventory confirmation fails', async (operation) => {
    const subject = await mountOwner(false, operation === 'receive' ? 'available' : 'joined')
    const panel = within(subject.access)
    const sessionReads = subject.sessions.mock.calls.length
    subject.list.mockRejectedValueOnce(new Error('inventory temporarily unavailable'))
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      if (operation === 'receive') {
        fireEvent.change(panel.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(readInvitation) } })
        fireEvent.change(panel.getByLabelText(zh['claude.chooseSession']), { target: { value: subject.recipient.sessionKey } })
      }
      fireEvent.click(panel.getByRole('button', { name: zh[operation === 'receive' ? 'access.receive' : 'access.stop'] }))
      await panel.findByText(zh['access.loadFailed'])
      expect(subject.sessions.mock.calls.length).toBeGreaterThan(sessionReads)
      const mutation = operation === 'receive' ? subject.receive : subject.receiveLeave
      expect(mutation).toHaveBeenCalledOnce()
      if (operation === 'receive') expect(panel.getByText(zh['access.state.pending'])).toBeTruthy()
      else expect(panel.queryByRole('button', { name: zh['access.stop'] })).toBeNull()
      fireEvent.click(panel.getByRole('button', { name: zh['access.retry'] }))
      await waitFor(() => { expect(panel.queryByText(zh['access.loadFailed'])).toBeNull() })
      expect(mutation).toHaveBeenCalledOnce()
      expect(diagnostics).toHaveBeenCalledOnce()
    } finally { diagnostics.mockRestore() }
  })
})
