// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RemoteError, SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ClaudeScopeJoinRequest, ClaudeScopeSessionSummary, ClaudeScopeSetupResult, DevelopmentParticipantAnnounceRequest,
  DevelopmentTaskCreateRequest, DevelopmentTaskLineageRequest, DevelopmentTaskPublishContextRequest,
  DevelopmentTaskSnapshot, RemoteResult, ScopeAgentBindingStatus, ScopeAgentBindRequest, ScopeAgentBindingRequest,
  ScopeAgentResumeRequest, ScopeAgentContributionStatus, ScopeAgentContributionRequest, ClaudeScopeContributionDetail,
  ClaudeScopePrepareContributionRequest, ClaudeScopeActivateContributionRequest, ScopeContributionApproval,
  ScopeContributionApproveRequest, ScopeContributionInvitation, ScopeContributionTransfer } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import type { EmergenceCenterPanelFace } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'
import { binding, localCapture, unbound } from './native-local-contribution-fixture.client.ts'
import { bound, invitation, observation, observable, state } from './native-scope-fixture.client.ts'
import { agentId, applicationEntry, capture, emptyStatus } from './native-contribution-fixture.client.ts'

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Background: () => null, Controls: () => null, MiniMap: () => null,
}))

const task: DevelopmentTaskSnapshot = {
  id: binding.taskId, ownerNodeId: binding.expectedBindingEpoch.nodeId, revision: 1, origin: { kind: 'root' },
  hiddenRoomId: 'local-room' as DevelopmentTaskSnapshot['hiddenRoomId'], runtime: 'ready',
  objective: 'Connect independent local work', scope: 'API integration decisions',
  createdBy: localCapture.grant.participantId, context: [], createdAt: 1, updatedAt: 1,
}
const ok = <T,>(value: T) => ({ ok: true as const, value })
const session: ClaudeScopeSessionSummary = { sessionKey: 'claude-observed' as ClaudeScopeSessionSummary['sessionKey'],
  sessionId: 'external-original-session', cwd: '/project', observedAt: 1, ended: false, readRevision: 0 }
const project = { projectPath: '/project', settingsPath: '/project/.claude/settings.local.json', profileName: 'scope-hook' }
const proposalDocument = { version: 1, kind: 'tool-contribution-request', proposal: capture.proposal } satisfies ScopeContributionTransfer

async function mountPanel(initialSessions: readonly ClaudeScopeSessionSummary[] = [], native = false) {
  const runtime = await SlotTestRuntime.create()
  try {
    localStorage.setItem('dsh.emergence-center.profile.v1', JSON.stringify({ id: task.createdBy, displayName: '' }))
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('zh')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const connection = observable({ id: 1, host: { home: '/home/test-owner' } })
    runtime.ctx.provide('connection', { generation: connection })
    const tasksList = vi.fn(async () => ok([task]))
    let created: DevelopmentTaskSnapshot | undefined
    const lineage = vi.fn(async (request: DevelopmentTaskLineageRequest) => ok({
      tasks: [created?.id === request.taskId ? created : task], boundaryTaskIds: [] }))
    let currentSessions = initialSessions
    const sessions = vi.fn(async () => ok(currentSessions))
    const setup = vi.fn(async (): Promise<RemoteResult<ClaudeScopeSetupResult>> => ok({ ...project, outcome: 'configured' }))
    const projectSetup = vi.fn(async () => ok({ ...project, state: 'configured' }))
    const removeSetup = vi.fn(async () => ok({ ...project, outcome: 'removed' }))
    const join = vi.fn(async (request: ClaudeScopeJoinRequest) => {
      const joined = { ...session, taskId: request.taskId, responsibility: request.responsibility }
      currentSessions = [joined]
      return ok(joined)
    })
    const leave = vi.fn(async () => { currentSessions = [session]; return ok(session) })
    let sourceDetail: ClaudeScopeContributionDetail = { session, capture: null }
    const prepare = vi.fn(async (request: ClaudeScopePrepareContributionRequest) => {
      const prepared: ClaudeScopeSessionSummary = { ...session, contributionState: 'prepared' }
      currentSessions = [prepared]
      sourceDetail = { session: prepared, capture: { selection: capture.selection, proposal: capture.proposal,
        proposalText: JSON.stringify(proposalDocument), roots: request.roots, source: request.source,
        invitation: null, application: null } }
      return ok({ session: prepared, proposal: capture.proposal, proposalText: JSON.stringify(proposalDocument) })
    })
    const activate = vi.fn(async (request: ClaudeScopeActivateContributionRequest) => {
      if (sourceDetail.capture === null) throw new Error('Fixture capture was not prepared')
      const active: ClaudeScopeSessionSummary = { ...session, contributionState: 'active', contributionTaskId: request.invitation.grant.taskId }
      currentSessions = [active]
      sourceDetail = { session: active, capture: { ...sourceDetail.capture, invitation: request.invitation } }
      return ok(active)
    })
    const stopSource = vi.fn(async () => { currentSessions = [session]; sourceDetail = { session, capture: null }; return ok(session) })
    let approved: ScopeContributionApproval | undefined
    const approve = vi.fn(async (request: ScopeContributionApproveRequest) => {
      const issued: ScopeContributionInvitation = { version: 1, kind: 'tool-contribution', ownerAddress: request.ownerAddress,
        grant: { ...request.proposal, version: 1, taskId: request.taskId, ownerPeerId: applicationEntry.ownerPeerId,
          grantId: '11111111-1111-4111-8111-111111111111' as ScopeContributionInvitation['grant']['grantId'],
          generation: '22222222-2222-4222-8222-222222222222' as ScopeContributionInvitation['grant']['generation'],
          expiresAt: request.expiresAt, maxSamples: request.maxSamples, maxSampleBytes: request.maxSampleBytes } }
      approved = { invitation: issued, text: JSON.stringify(issued) }
      return ok(approved)
    })
    const announce = vi.fn(async (request: DevelopmentParticipantAnnounceRequest) => ok({ nodeId: task.ownerNodeId,
      participants: [{ ...request, nodeId: task.ownerNodeId, presence: 'online', lastSeenAt: 1 }], rooms: [], presenceTtlMs: 15_000 }))
    const withdraw = vi.fn(async () => ok({ nodeId: task.ownerNodeId, participants: [], rooms: [], presenceTtlMs: 15_000 }))
    const publishContext = vi.fn(async (
      request: DevelopmentTaskPublishContextRequest,
    ): Promise<RemoteResult<DevelopmentTaskSnapshot>> => ok({ ...task, revision: 2,
      context: [{ id: 'published-decision', text: request.text, publishedBy: request.participantId, publishedAt: 2 }] }))
    const create = vi.fn(async (request: DevelopmentTaskCreateRequest) => {
      created = { ...task, id: 'new-local-task' as DevelopmentTaskSnapshot['id'], objective: request.objective,
        scope: request.scope, createdBy: request.createdBy, origin: request.origin }
      return ok({ task: created, runtime: created.runtime })
    })
    let execution: ScopeAgentBindingStatus = { ...state, agentId }
    let executionSeq = 0
    const bind = vi.fn(async (request: ScopeAgentBindRequest) => {
      execution = { ...bound, agentId, automatic: request.automatic, mode: request.automatic === null ? 'passive' : 'enabled' }
      return ok(execution)
    })
    const pause = vi.fn(async (_request: ScopeAgentBindingRequest) => {
      execution = { ...execution, mode: 'paused' }; return ok(execution)
    })
    const resume = vi.fn(async (request: ScopeAgentResumeRequest) => {
      execution = { ...execution, automatic: request.automatic, mode: 'enabled' }; return ok(execution)
    })
    const leaveScope = vi.fn(async (_request: ScopeAgentBindingRequest) => {
      execution = { ...state, agentId }; return ok(execution)
    })
    let contribution: ScopeAgentContributionStatus = emptyStatus
    const requestNative = vi.fn(async (request: ScopeAgentContributionRequest) => {
      if (request.sourceKind === 'completed-turn-outcomes' || request.sourceKind === 'native-work') throw new Error('Fixture expects file permission')
      contribution = { ...emptyStatus, revision: 1,
        capture: { ...capture, roots: request.roots, tools: request.tools, limits: request.limits } }
      return ok(contribution)
    })
    const stopNative = vi.fn(async () => { contribution = { ...emptyStatus, revision: 2 }; return ok(contribution) })
    const remote = new TestRemote(runtime.ctx, {
      developmentRooms: { list: async () => ok({ nodeId: task.ownerNodeId, participants: [], rooms: [], presenceTtlMs: 15_000 }),
        announce, withdraw },
      developmentTasks: { list: tasksList, lineage, publishContext, create,
        observedCandidates: async () => ok([]), observedIntervals: async () => ok([]) },
      developmentTaskAssignments: { list: async () => ok([]) },
      mcpClientSetup: { list: async () => ok({ clients: [] }) },
      claudeScope: { sessions, setup, projectSetup, removeSetup, join, leave,
        prepareContribution: prepare, activateContribution: activate, contributionLeave: stopSource,
        contributionDetail: async () => ok({ ...sourceDetail, session: currentSessions[0] ?? session }) },
      scopeAccess: {
        identity: async () => ok({ peerId: applicationEntry.ownerPeerId, addresses: [applicationEntry.ownerAddress] }),
        list: async () => ok({ grants: [], subscriptions: [] }),
        contributionInventory: async () => ok({ entries: [], nextGrantId: null }),
        contributionApplications: async () => ok({ entries: [], nextEntryId: null }),
        groupEntries: async () => ok({ entries: [], nextEntryId: null }),
        groupApplications: async () => ok({ entries: [], nextApplicationId: null }),
        previewContributionText: async ({ text }: { text: string }): Promise<RemoteResult<ScopeContributionTransfer>> => {
          if (text === JSON.stringify(proposalDocument)) return ok(proposalDocument)
          if (text === approved?.text) return ok(approved.invitation)
          return ok(applicationEntry)
        },
        approveContribution: approve,
        probeContributionEntry: async () => ok({ status: 'ready' }),
      },
      scopeAgentContext: {
        status: async () => ok({ ...observation(execution, ++executionSeq),
          subscriptionState: execution.binding === null ? 'unbound' : 'active' }),
        bind, pause, resume, leave: leaveScope,
      },
      scopeAgentContributions: {
        status: async () => ok(contribution), localStatus: async () => ok(unbound), permissionDraft: async () => ok(null),
        request: requestNative, stop: stopNative,
      },
    })
    if (native) {
      await runtime.sessions.add({ id: agentId })
      await runtime.root.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'conversation.session.header.actions': { kind: 'list', scope: 'session' } }, ({ renderSlot, SessionProvider }) => <>
        {renderSlot('sidebar.footer.action', { wide: true })}
        <SessionProvider>{renderSlot('conversation.session.header.actions', { selectView: () => {} })}</SessionProvider>
      </>)
    } else await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
    const feature = await runtime.mount({ inject, apply })
    if (native) runtime.renderRoot()
    else runtime.renderSlot('sidebar.footer.action', { wide: true })
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    await screen.findByText(zh['observed.empty'])
    await runtime.flush()
    return { runtime, feature, remote, connection, tasksList, lineage, sessions, setup, projectSetup, removeSetup, join, leave,
      announce, withdraw, publishContext, create, bind, pause, resume, leaveScope, requestNative, stopNative,
      prepare, approve, activate, stopSource, issuedApproval: () => approved }
  } catch (error) { await runtime.dispose(); throw error }
}

function refreshPanel(): void {
  const header = screen.getByRole('button', { name: zh['panel.close'] }).parentElement
  if (header === null) throw new Error('Collaboration header missing')
  fireEvent.click(within(header).getByRole('button', { name: zh['action.refresh'] }))
}

describe('Collaboration client registration lifecycle', () => {
  it.each(['publication', 'creation'] as const)('does not repopulate a replacement Host catalog from an old %s reply', async (operation) => {
    const subject = await mountPanel()
    const reply = Promise.withResolvers<DevelopmentTaskSnapshot>()
    let pending: Promise<DevelopmentTaskSnapshot> | undefined
    try {
      const registration = subject.runtime.slots.entries('sidebar.footer.action')[0]
      if (registration?.inject === undefined) throw new Error('Collaboration center entry missing')
      // Slot registration erases the component-specific injected face.
      const face = registration.inject() as unknown as EmergenceCenterPanelFace
      if (operation === 'publication') {
        subject.publishContext.mockImplementationOnce(async () => ok(await reply.promise))
        pending = face.publishContext({ taskId: task.id, participantId: task.createdBy, text: 'Old Host decision' })
      } else {
        subject.create.mockImplementationOnce(async () => ok({ task: await reply.promise, runtime: task.runtime }))
        pending = face.createTask({ origin: { kind: 'root' }, objective: task.objective, scope: task.scope, createdBy: task.createdBy })
      }
      subject.tasksList.mockResolvedValue(ok([]))
      subject.lineage.mockResolvedValue(ok({ tasks: [], boundaryTaskIds: [] }))
      await act(async () => {
        subject.connection.set({ id: 2, host: { home: '/home/replacement-owner' } })
        subject.runtime.ctx.emit('connection/reset')
      })
      await waitFor(() => { expect(face.hooks.tasks.getSnapshot()).toMatchObject({ read: true, tasks: [] }) })
      await act(async () => {
        const obsolete = { ...task, revision: 2, scope: 'Old Host-only scope' }
        reply.resolve(obsolete)
        expect(await pending).toEqual(obsolete)
      })
      expect(face.hooks.tasks.getSnapshot().tasks).toEqual([])
      const current = { ...task, id: 'replacement-host-task' as DevelopmentTaskSnapshot['id'],
        objective: 'Fresh Host work', scope: 'Fresh Host decision' }
      await act(async () => {
        if (operation === 'publication') {
          subject.publishContext.mockResolvedValueOnce(ok(current))
          expect(await face.publishContext({ taskId: current.id, participantId: current.createdBy, text: current.scope })).toEqual(current)
        } else {
          subject.create.mockResolvedValueOnce(ok({ task: current, runtime: current.runtime }))
          expect(await face.createTask({ origin: { kind: 'root' }, objective: current.objective,
            scope: current.scope, createdBy: current.createdBy })).toEqual(current)
        }
      })
      expect(face.hooks.tasks.getSnapshot().tasks).toEqual([current])
    } finally {
      reply.resolve(task)
      await pending
      await subject.runtime.dispose()
    }
  })

  it('prepares one Claude capture, approves its exact proposal as owner, activates the returned grant and stops that capture', async () => {
    const subject = await mountPanel([session])
    try {
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(session.sessionId) }))
      const sourceElement = screen.getByRole('heading', { name: zh['contribution.sourceTitle'] }).parentElement?.parentElement
      const ownerElement = screen.getByText(zh['contribution.ownerTitle']).parentElement
      if (sourceElement == null || ownerElement === null) throw new Error('Contribution panels missing')
      const source = within(sourceElement)
      const owner = within(ownerElement)
      await source.findByText(zh['contribution.stopped'])
      fireEvent.click(source.getByText(zh['contribution.application.manual']))
      fireEvent.click(source.getByRole('button', { name: zh['contribution.prepare'] }))
      const transfer = await source.findByLabelText<HTMLTextAreaElement>(zh['contribution.proposalText'])
      expect(subject.prepare).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, expectedCapture: null,
        roots: ['/project'], source: { kind: 'tool-observations', tools: ['Write', 'Edit'] } })
      expect(subject.activate).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
      fireEvent.click(owner.getByText(zh['contribution.application.manual']))
      fireEvent.change(owner.getByLabelText(zh['contribution.pasteProposal']), { target: { value: transfer.value } })
      fireEvent.click(owner.getByRole('button', { name: zh['contribution.verifyProposal'] }))
      await owner.findByText(capture.proposal.contributorPeerId)
      for (const [key, value] of [['contribution.hours', '1'], ['contribution.maxSamples', '8'], ['contribution.maxBytes', '4096']] as const) {
        fireEvent.change(owner.getByLabelText(zh[key]), { target: { value } })
      }
      const requestedAt = Date.now()
      fireEvent.click(owner.getByRole('button', { name: zh['contribution.approve'] }))
      const invitationText = await owner.findByLabelText<HTMLTextAreaElement>(zh['contribution.invitationText'])
      const approved = subject.issuedApproval()
      if (approved === undefined) throw new Error('Owner approval missing')
      const expiresAt = approved.invitation.grant.expiresAt
      expect(expiresAt).toBeGreaterThanOrEqual(requestedAt + 3_600_000)
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
      expect(subject.approve).toHaveBeenCalledExactlyOnceWith({ taskId: task.id, ownerAddress: applicationEntry.ownerAddress,
        proposal: capture.proposal, expiresAt, maxSamples: 8, maxSampleBytes: 4096 })
      fireEvent.change(source.getByLabelText(zh['contribution.pasteInvitation']), { target: { value: invitationText.value } })
      fireEvent.click(source.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
      fireEvent.click(await source.findByRole('button', { name: zh['contribution.activate'] }))
      await source.findByText(zh['contribution.active'])
      expect(subject.activate).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
        expectedCapture: capture.selection, invitation: approved.invitation })
      fireEvent.click(source.getByRole('button', { name: zh['contribution.stop'] }))
      await source.findByText(zh['contribution.stopped'])
      expect(subject.stopSource).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, expectedCapture: capture.selection })
      expect(subject.bind).not.toHaveBeenCalled()
    } finally { await subject.runtime.dispose() }
  })

  it('binds finite automatic permission in the original native Session and pauses, resumes, then leaves that exact binding', async () => {
    const subject = await mountPanel([], true)
    try {
      fireEvent.click(screen.getByRole('button', { name: zh['native.trigger'] }))
      const panel = await screen.findByRole('dialog', { name: zh['native.title'] })
      const controls = within(panel)
      fireEvent.change(controls.getByLabelText(zh['native.invitation']), { target: { value: JSON.stringify(invitation) } })
      fireEvent.click(controls.getByRole('radio', { name: zh['native.automatic'] }))
      for (const [key, value] of [['native.goal', 'Coordinate the order form'], ['native.extra', '2'],
        ['native.steps', '3'], ['native.interval', '1']] as const) {
        fireEvent.change(controls.getByLabelText(zh[key]), { target: { value } })
      }
      fireEvent.click(controls.getByRole('button', { name: zh['native.bind'] }))
      await controls.findByRole('button', { name: zh['native.pause'] })
      const automatic = { goal: 'Coordinate the order form', activationLimit: 2, maxStepsPerTurn: 3, minIntervalMs: 1000 }
      expect(subject.bind).toHaveBeenCalledExactlyOnceWith({ agentId, expectedBindingId: null, invitation, automatic })
      fireEvent.click(controls.getByRole('button', { name: zh['native.pause'] }))
      const remainingLabel = zh['native.resumeRemaining'].replace('{count}', '2')
      await controls.findByRole('button', { name: remainingLabel })
      expect(subject.pause).toHaveBeenCalledExactlyOnceWith({ agentId, expectedBindingId: bound.binding!.id })
      fireEvent.click(controls.getByRole('button', { name: remainingLabel }))
      await controls.findByRole('button', { name: zh['native.pause'] })
      expect(subject.resume).toHaveBeenCalledExactlyOnceWith({ agentId, expectedBindingId: bound.binding!.id, automatic })
      fireEvent.click(controls.getByRole('button', { name: zh['native.leave'] }))
      await controls.findByRole('button', { name: zh['native.bind'] })
      expect(subject.leaveScope).toHaveBeenCalledExactlyOnceWith({ agentId, expectedBindingId: bound.binding!.id })
      expect(subject.requestNative).not.toHaveBeenCalled()
    } finally { await subject.runtime.dispose() }
  })

  it('requests only explicitly selected native file work and stops the returned capture without granting automatic responses', async () => {
    const subject = await mountPanel([], true)
    try {
      fireEvent.click(screen.getByRole('button', { name: zh['native.trigger'] }))
      const panel = await screen.findByRole('dialog', { name: zh['native.title'] })
      const controls = within(panel)
      fireEvent.change(controls.getByLabelText(zh['native.invitation']), { target: { value: JSON.stringify(applicationEntry) } })
      fireEvent.click(controls.getByText(zh['native.share.title']))
      fireEvent.click(await controls.findByRole('button', { name: zh['native.share.verify'] }))
      await controls.findByText(applicationEntry.ownerPeerId)
      const draftedAt = Date.now()
      for (const [key, value] of [['contribution.roots', '/project'], ['contribution.hours', '1'],
        ['contribution.maxSamples', '8'], ['contribution.maxBytes', '4096']] as const) {
        fireEvent.change(controls.getByLabelText(zh[key]), { target: { value } })
      }
      fireEvent.click(controls.getByRole('checkbox', { name: zh['native.share.write'] }))
      fireEvent.click(controls.getByRole('checkbox', { name: zh['native.share.edit'] }))
      const submit = controls.getByRole<HTMLButtonElement>('button', { name: zh['native.share.request'] })
      expect(submit.disabled).toBe(true)
      fireEvent.click(controls.getByRole('checkbox', { name: zh['native.share.consent'] }))
      fireEvent.click(submit)
      await controls.findByText(zh['contribution.application.waiting'])
      const request = subject.requestNative.mock.calls[0]?.[0]
      if (request === undefined) throw new Error('Native file request missing')
      expect(request.limits.expiresAt).toBeGreaterThanOrEqual(draftedAt + 3_600_000)
      expect(request.limits.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
      expect(subject.requestNative).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: null, entry: applicationEntry,
        roots: ['/project'], tools: ['write', 'edit'], limits: { expiresAt: request.limits.expiresAt, maxSamples: 8, maxSampleBytes: 4096 } })
      fireEvent.click(controls.getByRole('button', { name: zh['native.share.stop'] }))
      await controls.findByText(zh['native.share.none'])
      expect(subject.stopNative).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
      expect(subject.bind).not.toHaveBeenCalled()
    } finally { await subject.runtime.dispose() }
  })

  it('creates and selects the returned Root Task through the registered creation action', async () => {
    const subject = await mountPanel()
    try {
      fireEvent.change(screen.getByLabelText(zh['profile.name']), { target: { value: 'Frontend owner' } })
      fireEvent.click(screen.getByRole('button', { name: zh['create.open'] }))
      fireEvent.click(screen.getByRole('button', { name: zh['create.root'] }))
      fireEvent.change(screen.getByLabelText(zh['create.objective']), { target: { value: 'New integration goal' } })
      fireEvent.change(screen.getByLabelText(zh['create.scope']), { target: { value: 'Current API decisions' } })
      fireEvent.click(screen.getByRole('button', { name: zh['create.submit'] }))
      await screen.findByRole('heading', { name: 'New integration goal' })
      expect(subject.create).toHaveBeenCalledExactlyOnceWith({ origin: { kind: 'root' }, createdBy: task.createdBy,
        objective: 'New integration goal', scope: 'Current API decisions' })
      expect(screen.getByText('Current API decisions')).toBeTruthy()
      expect(screen.queryByRole('button', { name: zh['create.submit'] })).toBeNull()
    } finally { await subject.runtime.dispose() }
  })

  it('renders a typed project setup refusal without Host diagnostics and permits explicit recovery', async () => {
    const subject = await mountPanel()
    try {
      subject.setup.mockResolvedValueOnce({ ok: false,
        error: new RemoteError('claude-scope/write-failed', 'private Host diagnostics /private/project', {}) })
      fireEvent.change(screen.getByLabelText(zh['claude.projectPath']), { target: { value: '/project' } })
      fireEvent.click(screen.getByRole('button', { name: zh['claude.configure'] }))
      await screen.findByText(zh['claude.writeFailed'])
      expect(document.body.textContent).not.toContain('private Host diagnostics')
      fireEvent.click(screen.getByRole('button', { name: zh['claude.configure'] }))
      await screen.findByText(zh['claude.configured'])
      expect(screen.queryByText(zh['claude.writeFailed'])).toBeNull()
      expect(subject.setup).toHaveBeenCalledTimes(2)
    } finally { await subject.runtime.dispose() }
  })

  it('persists the confirmed human profile and publishes the returned Task context on the mounted panel', async () => {
    const subject = await mountPanel()
    try {
      fireEvent.change(screen.getByLabelText(zh['profile.name']), { target: { value: '  Frontend owner  ' } })
      fireEvent.click(screen.getByRole('button', { name: zh['profile.save'] }))
      await screen.findByRole('button', { name: zh['profile.online'] })
      expect(JSON.parse(localStorage.getItem('dsh.emergence-center.profile.v1') ?? 'null')).toEqual({
        id: task.createdBy, displayName: 'Frontend owner',
      })
      expect(subject.announce).toHaveBeenCalledExactlyOnceWith({ id: task.createdBy, kind: 'human', displayName: 'Frontend owner' })
      fireEvent.change(screen.getByPlaceholderText(zh['context.placeholder']), { target: { value: '  API is ready for integration  ' } })
      fireEvent.click(screen.getByRole('button', { name: zh['context.publish'] }))
      await screen.findByText('API is ready for integration')
      expect(subject.publishContext).toHaveBeenCalledExactlyOnceWith({ taskId: task.id, participantId: task.createdBy,
        text: 'API is ready for integration' })
      expect(screen.getByPlaceholderText<HTMLTextAreaElement>(zh['context.placeholder']).value).toBe('')
    } finally { await subject.runtime.dispose() }
    expect(subject.withdraw).toHaveBeenCalledExactlyOnceWith({ participantId: task.createdBy })
  })

  it('configures project hooks and joins then leaves only the explicitly selected Claude session', async () => {
    const subject = await mountPanel([session])
    try {
      fireEvent.change(screen.getByLabelText(zh['claude.projectPath']), { target: { value: ' /project ' } })
      fireEvent.click(screen.getByRole('button', { name: zh['claude.configure'] }))
      await screen.findByText(zh['claude.configured'])
      expect(subject.setup).toHaveBeenCalledExactlyOnceWith({ projectPath: '/project' })
      fireEvent.click(screen.getByRole('button', { name: zh['claude.check'] }))
      await waitFor(() => { expect(subject.projectSetup).toHaveBeenCalledExactlyOnceWith({ projectPath: '/project' }) })
      fireEvent.click(screen.getByRole('button', { name: zh['claude.remove'] }))
      await screen.findByText(zh['claude.notConfigured'])
      expect(subject.removeSetup).toHaveBeenCalledExactlyOnceWith({ projectPath: '/project' })
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(session.sessionId) }))
      fireEvent.change(screen.getByPlaceholderText(zh['claude.responsibilityPlaceholder']), { target: { value: '  Frontend API integration  ' } })
      fireEvent.click(screen.getByRole('button', { name: zh['claude.join'] }))
      await screen.findByText(zh['claude.currentTask'])
      expect(subject.join).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, taskId: task.id,
        responsibility: 'Frontend API integration', roots: ['/project'], bashCommands: [] })
      fireEvent.click(screen.getByRole('button', { name: zh['claude.leave'] }))
      await screen.findByRole('button', { name: zh['claude.join'] })
      expect(subject.leave).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey })
    } finally { await subject.runtime.dispose() }
  })

  it('receives committed Task changes while mounted and withdraws its Host subscriptions on unload', async () => {
    const subject = await mountPanel()
    try {
      const changed = { ...task, revision: 2, scope: 'Committed API route is /v2/orders' }
      await act(async () => { subject.remote.emit('development-task/changed', [changed]) })
      await screen.findByText(changed.scope)
      const reads = subject.sessions.mock.calls.length
      await subject.feature.dispose()
      await act(async () => {
        subject.remote.emit('development-task/changed', [{ ...changed, revision: 3 }])
        subject.remote.emit('claude-scope/session-changed', [session.sessionKey])
        subject.runtime.ctx.emit('connection/reset')
      })
      expect(subject.sessions).toHaveBeenCalledTimes(reads)
      expect(screen.queryByRole('button', { name: zh['trigger.aria'] })).toBeNull()
    } finally { await subject.runtime.dispose() }
  })

  it('does not send another Task lineage request when a catalog read settles after unloading the feature', async () => {
    const subject = await mountPanel()
    const read = Promise.withResolvers<ReturnType<typeof ok<DevelopmentTaskSnapshot[]>>>()
    try {
      subject.tasksList.mockReturnValueOnce(read.promise)
      const catalogs = subject.tasksList.mock.calls.length
      refreshPanel()
      expect(subject.tasksList).toHaveBeenCalledTimes(catalogs + 1)
      const sent = subject.lineage.mock.calls.length
      expect(sent).toBeGreaterThan(0)
      await subject.feature.dispose()
      await act(async () => { read.resolve(ok([task])); await read.promise })
      await subject.runtime.flush()
      expect(subject.lineage).toHaveBeenCalledTimes(sent)
      expect(screen.queryByRole('button', { name: zh['trigger.aria'] })).toBeNull()
    } finally { read.resolve(ok([task])); await read.promise; await subject.runtime.dispose() }
  })
})
