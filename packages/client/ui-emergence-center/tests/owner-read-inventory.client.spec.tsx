// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  ClaudeScopeContributionDetail, ClaudeScopeSessionSummary, DevelopmentNodeId, DevelopmentTaskSnapshot, RemoteResult, ScopeAccessList,
  ScopeContributionApplicationApprovalRequest, ScopeContributionApplicationRejectRequest, ScopeContributionEntryRecoverRequest,
  ScopeContributionInvitation, ScopeGroupApplication, ScopeGroupEntry, ScopeGroupEntrySelection, ScopeGroupEntryStatus, ScopeInvitation,
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
  let ended = false
  let closed = false
  const groupStatus = (): ScopeGroupEntryStatus => ({ entry: groupEntry, text: JSON.stringify(groupEntry),
    state: closed ? 'closed' : 'open', applicationCount: 1 })
  const closeGroupEntry = vi.fn(async (_request: ScopeGroupEntrySelection) => {
    closed = true
    remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    return ok(groupStatus())
  })
  let readGrant: ScopeAccessList['grants'][number] | undefined = initiallyApproved
    ? { invitation: readInvitation, state: 'active' } : undefined
  const currentMember = (): ScopeGroupApplication => ({ ...member, result: !approved ? { status: 'pending' }
    : ended ? { status: 'ended', reason: 'revoked', invitation: contribution, readInvitation, readState: 'revoked',
      receipt: { ...receipt, revision: 3, event: { ...receipt.event, seq: 3, kind: 'peer-contribution-ended' } } }
      : { status: 'approved', invitation: contribution, receipt, readInvitation,
        readState: readGrant?.state === 'revoked' ? 'revoked' : 'active' } })
  const list = vi.fn(async (): Promise<Extract<RemoteResult<ScopeAccessList>, { readonly ok: true }>> =>
    ok({ grants: readGrant === undefined ? [] : [readGrant], subscriptions: [] }))
  const groupApplications = vi.fn(async () => ok({ entries: [currentMember()], nextApplicationId: null }))
  const approve = vi.fn(async (request: ScopeContributionApplicationApprovalRequest): Promise<RemoteResult<ScopeGroupApplication>> => {
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
  const recoverContributionEntry = vi.fn(async (_request: ScopeContributionEntryRecoverRequest) =>
    ok({ entry: groupEntry, text: JSON.stringify(groupEntry) }))
  const endMember = vi.fn(async (_request: ScopeContributionApplicationRejectRequest) => {
    ended = true
    readGrant = { invitation: readInvitation, state: 'revoked' }
    remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    return ok(currentMember())
  })
  const recipient: ClaudeScopeSessionSummary = { sessionKey: 'claude-recipient' as ClaudeScopeSessionSummary['sessionKey'],
    sessionId: 'original-claude-session', observedAt: 1, ended: false, readRevision: 0 }
  const receiving: ClaudeScopeSessionSummary = { ...recipient, readRevision: 1,
    receiveSubscriptionId: 'subscription' as NonNullable<ClaudeScopeSessionSummary['receiveSubscriptionId']>,
    receiveTaskId: groupEntry.taskId, receiveState: 'pending' }
  let observed = recipientState === 'joined' ? receiving : recipient
  const sessions = vi.fn(async () => ok(recipientState === undefined ? [] : [observed]))
  const receive = vi.fn(async (): Promise<RemoteResult<ClaudeScopeSessionSummary>> => { observed = receiving; return ok(observed) })
  const receiveLeave = vi.fn(async (): Promise<RemoteResult<ClaudeScopeSessionSummary>> => {
    observed = { ...recipient, readRevision: 2 }; return ok(observed)
  })
  const contributionDetail = vi.fn(async (): Promise<RemoteResult<ClaudeScopeContributionDetail>> =>
    ok({ session: observed, capture: null }))
  const tasksList = vi.fn(async () => ok([task]))
  const remote = new TestRemote(runtime.ctx, {
    developmentRooms: { list: async () => ok({ nodeId, participants: [], rooms: [], presenceTtlMs: 15_000 }) },
    developmentTasks: {
      list: tasksList, lineage: async () => ok({ tasks: [task], boundaryTaskIds: [] }),
      observedCandidates: async () => ok([]), observedIntervals: async () => ok([]),
    },
    developmentTaskAssignments: { list: async () => ok([]) },
    mcpClientSetup: { list: async () => ok({ clients: [] }) },
    claudeScope: { sessions, receive, receiveLeave, contributionDetail },
    scopeAgentContext: {}, scopeAgentContributions: {},
    scopeAccess: {
      identity: async () => ok({ peerId: groupEntry.ownerPeerId, addresses: [groupEntry.ownerAddress] }),
      list, revoke,
      contributionInventory: async () => ok({ entries: [], nextGrantId: null }),
      contributionApplications: async () => ok({ entries: [], nextEntryId: null }),
      groupEntries: async () => ok({ entries: [groupStatus()], nextEntryId: null }),
      groupApplications, approveContributionApplication: approve, closeGroupEntry, recoverContributionEntry,
      rejectContributionApplication: endMember,
      previewContributionText: async () => ok(groupEntry),
      probeContributionEntry: async () => ok({ status: 'ready' }),
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
  return { runtime, application, access, approve, revoke, list, groupApplications, sessions, receive, receiveLeave,
    recipient, tasksList, closeGroupEntry, contributionDetail, recoverContributionEntry, endMember,
    authority: () => readGrant,
    invalidateOwner() { remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }]) },
    revokeFromAnotherClient() {
      readGrant = { invitation: readInvitation, state: 'revoked' }
      remote.emit('scope-access/contribution-application-changed', [{ taskId: groupEntry.taskId }])
    } }
}

describe('Emergence Center owner read inventory', () => {
  it('recovers the original entry, confirms a committed approval after a lost reply and ends only that member despite a stale pending read', async () => {
    const subject = await mountOwner(false)
    const entered = Promise.withResolvers<undefined>()
    const releaseApproval = Promise.withResolvers<undefined>()
    const oldRead = Promise.withResolvers<Awaited<ReturnType<typeof subject.groupApplications>>>()
    let approvalWork: Promise<RemoteResult<ScopeGroupApplication>> | undefined
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const group = document.querySelector(`[data-group-entry="${groupEntry.entryId}"]`)
      if (!(group instanceof HTMLElement)) throw new Error('Owner group entry missing')
      const groupControls = within(group)
      const memberControls = within(subject.application)
      fireEvent.click(groupControls.getByRole('button', { name: zh['contribution.application.recover'] }))
      await waitFor(() => { expect(subject.recoverContributionEntry).toHaveBeenCalledExactlyOnceWith({
        entryId: groupEntry.entryId, ownerAddress: groupEntry.ownerAddress,
      }) })
      await waitFor(() => { expect(memberControls.getByRole<HTMLButtonElement>('button', {
        name: zh['contribution.join.approve'],
      }).disabled).toBe(true) })
      expect(groupControls.getByLabelText<HTMLTextAreaElement>(zh['contribution.application.entryText']).value)
        .toBe(JSON.stringify(groupEntry))
      expect(subject.authority()).toBeUndefined()
      expect(subject.approve).not.toHaveBeenCalled()
      fireEvent.change(memberControls.getByLabelText(zh['contribution.join.responsibility']),
        { target: { value: readInvitation.responsibility } })
      const commit = subject.approve.getMockImplementation()
      if (commit === undefined) throw new Error('Owner approval fixture missing')
      subject.approve.mockImplementationOnce((request) => {
        approvalWork = (async () => {
          entered.resolve(undefined)
          await releaseApproval.promise
          await commit(request)
          return { ok: false as const, error: new RemoteError('gateway/internal', 'Approval reply lost after commit', {}) }
        })()
        return approvalWork
      })
      await waitFor(() => { expect(memberControls.getByRole<HTMLButtonElement>('button', {
        name: zh['contribution.join.approve'],
      }).disabled).toBe(false) })
      fireEvent.click(memberControls.getByRole('button', { name: zh['contribution.join.approve'] }))
      await entered.promise
      expect(memberControls.getByRole<HTMLButtonElement>('button', { name: zh['contribution.join.approve'] }).disabled).toBe(true)
      subject.groupApplications.mockReturnValueOnce(oldRead.promise)
      const previousReads = subject.groupApplications.mock.calls.length
      await act(async () => { subject.invalidateOwner() })
      await waitFor(() => { expect(subject.groupApplications).toHaveBeenCalledTimes(previousReads + 1) })
      await act(async () => { releaseApproval.resolve(undefined) })
      await memberControls.findByText(zh['contribution.application.owner.approved'])
      await memberControls.findByText(zh['contribution.join.read.active'])
      await waitFor(() => { expect(memberControls.getByRole<HTMLButtonElement>('button', {
        name: zh['contribution.group.endMember'],
      }).disabled).toBe(false) })
      expect(subject.authority()).toEqual({ invitation: readInvitation, state: 'active' })
      expect(subject.approve).toHaveBeenCalledOnce()
      await act(async () => { oldRead.resolve(ok({ entries: [member], nextApplicationId: null })); await oldRead.promise })
      expect(memberControls.queryByRole('button', { name: zh['contribution.join.approve'] })).toBeNull()
      expect(memberControls.getByText(zh['contribution.join.read.active'])).toBeTruthy()
      fireEvent.click(memberControls.getByRole('button', { name: zh['contribution.group.endMember'] }))
      await memberControls.findByText(zh['contribution.application.owner.ended'])
      await memberControls.findByText(zh['contribution.join.read.revoked'])
      await screen.findByText(zh['access.revoked'])
      expect(subject.endMember).toHaveBeenCalledExactlyOnceWith({ entryId: groupEntry.entryId,
        applicationId: member.applicationId, expectedProposal: member.proposal })
      expect(subject.authority()).toEqual({ invitation: readInvitation, state: 'revoked' })
      expect(memberControls.queryByRole('button', { name: zh['contribution.group.endMember'] })).toBeNull()
      expect(groupControls.getByText(zh['contribution.group.state.open'])).toBeTruthy()
      expect(subject.closeGroupEntry).not.toHaveBeenCalled()
      expect(subject.revoke).not.toHaveBeenCalled()
      expect(subject.approve).toHaveBeenCalledOnce()
      expect(diagnostics).toHaveBeenCalledOnce()
    } finally {
      releaseApproval.resolve(undefined)
      oldRead.resolve(ok({ entries: [member], nextApplicationId: null }))
      await Promise.allSettled([oldRead.promise, approvalWork])
      try { await subject.runtime.dispose() }
      finally { diagnostics.mockRestore() }
    }
  })

  it('closes entry admission while retaining the pending applicant and its separate approval consent', async () => {
    const subject = await mountOwner(false)
    const memberControls = within(subject.application)
    fireEvent.change(memberControls.getByLabelText(zh['contribution.join.responsibility']),
      { target: { value: readInvitation.responsibility } })
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.group.close'] }))
    await screen.findByText(zh['contribution.group.state.closed'])
    expect(subject.closeGroupEntry).toHaveBeenCalledExactlyOnceWith({ entryId: groupEntry.entryId })
    expect(screen.queryByRole('button', { name: zh['contribution.group.close'] })).toBeNull()
    expect(memberControls.getByText(zh['contribution.application.owner.pending'])).toBeTruthy()
    expect(memberControls.getByLabelText<HTMLInputElement>(zh['contribution.join.responsibility']).value).toBe(readInvitation.responsibility)
    expect(subject.approve).not.toHaveBeenCalled()
    expect(subject.revoke).not.toHaveBeenCalled()
    expect(subject.authority()).toBeUndefined()
    const approve = memberControls.getByRole<HTMLButtonElement>('button', { name: zh['contribution.join.approve'] })
    await waitFor(() => { expect(approve.disabled).toBe(false) })
    fireEvent.click(approve)
    await memberControls.findByText(zh['contribution.join.read.active'])
    expect(subject.approve).toHaveBeenCalledOnce()
    expect(subject.authority()).toEqual({ invitation: readInvitation, state: 'active' })
    expect(screen.getByText(zh['contribution.group.state.closed'])).toBeTruthy()
  })

  it('re-reads mounted Task and permission inventories on reset without restoring the old connection authority', async () => {
    const subject = await mountOwner(true)
    const old = Promise.withResolvers<{ ok: true; value: ScopeAccessList }>()
    const detached = Promise.withResolvers<{ ok: true; value: ScopeAccessList }>()
    const active = ok({ grants: [{ invitation: readInvitation, state: 'active' as const }], subscriptions: [] })
    const initialReads = subject.list.mock.calls.length
    subject.list.mockReturnValueOnce(old.promise)
    try {
      await act(async () => { subject.revokeFromAnotherClient() })
      await waitFor(() => { expect(subject.list).toHaveBeenCalledTimes(initialReads + 1) })
      const taskReads = subject.tasksList.mock.calls.length
      const permissionReads = subject.list.mock.calls.length
      await act(async () => { subject.runtime.ctx.emit('connection/reset') })
      await screen.findByText(zh['access.revoked'])
      await waitFor(() => {
        expect(subject.tasksList.mock.calls.length).toBeGreaterThan(taskReads)
        expect(subject.list.mock.calls.length).toBeGreaterThan(permissionReads)
      })
      await act(async () => { old.resolve(active); await old.promise })
      expect(screen.queryByRole('button', { name: zh['access.revoke'] })).toBeNull()
      expect(screen.getByText(zh['access.revoked'])).toBeTruthy()
      expect(screen.getAllByText(task.objective).length).toBeGreaterThan(0)
      expect(subject.approve).not.toHaveBeenCalled()
      expect(subject.revoke).not.toHaveBeenCalled()
      expect(subject.receive).not.toHaveBeenCalled()
      expect(subject.receiveLeave).not.toHaveBeenCalled()

      subject.list.mockReturnValueOnce(detached.promise)
      const beforeDetached = subject.list.mock.calls.length
      await act(async () => { subject.revokeFromAnotherClient() })
      await waitFor(() => { expect(subject.list).toHaveBeenCalledTimes(beforeDetached + 1) })
      await act(async () => { await subject.runtime.dispose() })
      runtimes.splice(runtimes.indexOf(subject.runtime), 1)
      const afterDispose = [subject.list.mock.calls.length, subject.tasksList.mock.calls.length]
      await act(async () => { detached.resolve(active); await detached.promise })
      expect([subject.list.mock.calls.length, subject.tasksList.mock.calls.length]).toEqual(afterDispose)
      expect(screen.queryByLabelText(zh['access.identity'])).toBeNull()
    } finally {
      old.resolve(active); detached.resolve(active)
      await Promise.all([old.promise, detached.promise])
    }
  })

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

  it.each([
    { operation: 'receive', lostReply: false }, { operation: 'stop', lostReply: false },
    { operation: 'receive', lostReply: true }, { operation: 'stop', lostReply: true },
  ] as const)('refreshes the mounted source permission after independent $operation (lost reply: $lostReply) without restoring earlier read consent', async ({ operation, lostReply }) => {
    const subject = await mountOwner(false, operation === 'receive' ? 'available' : 'joined')
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(subject.recipient.sessionId) }))
    const sourceElement = screen.getByRole('heading', { name: zh['contribution.sourceTitle'] }).closest('section')
    if (sourceElement === null) throw new Error('Selected source panel missing')
    const source = within(sourceElement)
    const access = within(subject.access)
    await source.findByText(zh['contribution.stopped'])
    fireEvent.change(source.getByLabelText(zh['contribution.application.paste']), { target: { value: JSON.stringify(groupEntry) } })
    fireEvent.click(source.getByRole('button', { name: zh['contribution.application.verify'] }))
    const consent = await source.findByLabelText<HTMLInputElement>(zh['claude.joint.readConsent'])
    const initialReads = subject.contributionDetail.mock.calls.length
    const mutation = operation === 'receive' ? subject.receive : subject.receiveLeave
    const commit = mutation.getMockImplementation()
    if (commit === undefined) throw new Error('Read mutation fixture missing')
    if (lostReply) mutation.mockImplementationOnce(async () => {
      await commit()
      return { ok: false, error: new RemoteError('gateway/internal', 'Reply lost after read mutation committed', {}) }
    })
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      if (operation === 'receive') {
        expect(consent.disabled).toBe(false)
        fireEvent.click(consent)
        expect(consent.checked).toBe(true)
        fireEvent.change(access.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(readInvitation) } })
        fireEvent.change(access.getByLabelText(zh['claude.chooseSession']), { target: { value: subject.recipient.sessionKey } })
        fireEvent.click(access.getByRole('button', { name: zh['access.receive'] }))
        await access.findByText(zh['access.state.pending'])
        await waitFor(() => { expect(consent.disabled).toBe(true); expect(consent.checked).toBe(false) })
        expect(source.getByText(zh['claude.joint.conflict'])).toBeTruthy()
        expect(subject.contributionDetail.mock.calls.length).toBeGreaterThan(initialReads)
        expect(subject.receive).toHaveBeenCalledOnce()
      } else {
        expect(consent.disabled).toBe(true)
        expect(source.getByText(zh['claude.joint.conflict'])).toBeTruthy()
      }
      fireEvent.click(access.getByRole('button', { name: zh['access.stop'] }))
      await waitFor(() => { expect(access.queryByRole('button', { name: zh['access.stop'] })).toBeNull() })
      await waitFor(() => { expect(consent.disabled).toBe(false) })
      expect(consent.checked).toBe(false)
      expect(source.queryByText(zh['claude.joint.conflict'])).toBeNull()
      expect(subject.contributionDetail.mock.calls.length).toBeGreaterThan(initialReads)
      expect(subject.receiveLeave).toHaveBeenCalledExactlyOnceWith({ sessionKey: subject.recipient.sessionKey })
      fireEvent.click(consent)
      expect(consent.checked).toBe(true)
      expect(source.getByLabelText<HTMLTextAreaElement>(zh['contribution.application.paste']).value).toBe(JSON.stringify(groupEntry))
      if (lostReply) expect(diagnostics).toHaveBeenCalledOnce()
      else expect(diagnostics).not.toHaveBeenCalled()
    } finally { diagnostics.mockRestore() }
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
