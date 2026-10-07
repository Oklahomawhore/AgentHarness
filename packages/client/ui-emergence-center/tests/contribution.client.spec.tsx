// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClaudeScopeContributionDetail, ScopeContributionInvitation, ScopeContributionProposal,
  ScopeContributionTransfer, ScopeContributionEntry, ScopeGroupEntry, ScopeGroupApplicationId, DevelopmentTaskId, ClaudeScopeSessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import type { DevelopmentTaskPeerContribution } from '@deepseek-ai/dsh-development-task/types'
import { SourceContributionPanel, type SourceContributionActions } from '../src/client/SourceContributionPanel.tsx'
import { OwnerContributionPanel, type OwnerContributionActions, type OwnerContributionValue } from '../src/client/OwnerContributionPanel.tsx'
import { createContributionDirectory, type ContributionDirectory } from '../src/client/contribution-directory.ts'
import { zh } from '../src/client/locales.ts'
import { invitation as readInvitation } from './native-scope-fixture.client.ts'

const t = makeTranslate(zh)
const TASK = 'task-a' as DevelopmentTaskId
const G = {
  version: 1, taskId: TASK, grantId: 'grant-a' as ScopeContributionInvitation['grant']['grantId'],
  generation: 'grant-generation' as ScopeContributionInvitation['grant']['generation'],
  ownerPeerId: 'owner-peer' as ScopeContributionInvitation['grant']['ownerPeerId'],
  contributorPeerId: 'source-peer' as ScopeContributionInvitation['grant']['contributorPeerId'],
  captureId: 'capture-a' as ScopeContributionInvitation['grant']['captureId'],
  captureGeneration: 'capture-generation' as ScopeContributionInvitation['grant']['captureGeneration'],
  source: { name: 'Orders', method: 'post', path: '/orders' }, expiresAt: 2000000000000, maxSamples: 8, maxSampleBytes: 5000,
} satisfies ScopeContributionInvitation['grant']
const invitation: ScopeContributionInvitation = { version: 1, kind: 'openapi-contribution', ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner-peer', grant: G }
const applicationEntry: ScopeContributionEntry = {
  version: 1, kind: 'openapi-contribution-entry', entryId: 'entry-a' as ScopeContributionEntry['entryId'],
  taskId: TASK, ownerPeerId: G.ownerPeerId, ownerAddress: invitation.ownerAddress, expiresAt: G.expiresAt,
}
const proposal: ScopeContributionProposal = {
  contributorPeerId: G.contributorPeerId, captureId: G.captureId, captureGeneration: G.captureGeneration, source: G.source,
}
const session: ClaudeScopeSessionSummary = { sessionKey: 'session-a' as ClaudeScopeSessionSummary['sessionKey'], sessionId: 'claude-a', cwd: '/project', observedAt: 1, ended: false, readRevision: 0 }
const captured: ClaudeScopeContributionDetail = {
  session: { ...session, contributionState: 'prepared' },
  capture: { selection: { captureId: G.captureId, captureGeneration: G.captureGeneration }, proposal, proposalText: 'versioned-request',
    roots: ['/project'], source: { ...G.source, filePath: '/project/api.json' }, invitation: null, application: null },
}
const receipt = { taskId: TASK, ownerPeerId: G.ownerPeerId, contributorPeerId: G.contributorPeerId, grantId: G.grantId,
  generation: G.generation, captureId: G.captureId, captureGeneration: G.captureGeneration, revision: 2,
  event: { nodeId: 'owner-node' as import('@deepseek-ai/dsh-api-remotes/client').DevelopmentNodeId, seq: 2, kind: 'peer-contribution-opened' as const } }
const active: DevelopmentTaskPeerContribution = { state: 'active', grant: G, openReceipt: receipt }
const owned: OwnerContributionValue = {
  identity: { peerId: G.ownerPeerId, addresses: [invitation.ownerAddress] },
  inventory: { entries: [], nextGrantId: null }, applications: { entries: [], nextEntryId: null },
  groups: { entries: [], nextEntryId: null },
}
const disposers: (() => void)[] = []
afterEach(() => { cleanup(); disposers.splice(0).forEach((dispose) => { dispose() }) })
const noop = async (): Promise<void> => {}
function sourceActions(overrides: Partial<SourceContributionActions> = {}): SourceContributionActions {
  return { readContribution: () => {}, requestContribution: vi.fn(noop), prepareContribution: vi.fn(noop),
    activateContribution: vi.fn(noop), stopContribution: vi.fn(noop),
    leaveJointContribution: vi.fn(noop), recoverJointContribution: vi.fn(noop),
    probeContributionEntry: vi.fn(async () => ({ status: 'ready' as const })),
    previewContributionText: vi.fn(async () => invitation), ...overrides }

}
function ownerActions(overrides: Partial<OwnerContributionActions> = {}): OwnerContributionActions {
  return { createGroupEntry: vi.fn(), closeGroupEntry: vi.fn(), createContributionEntry: vi.fn(noop),
    recoverContributionEntry: vi.fn(async () => undefined),
    approveContributionApplication: vi.fn(noop), rejectContributionApplication: vi.fn(noop), readOwnedContributions: () => {}, moreOwnedContributions: vi.fn(), approveContribution: vi.fn(async () => undefined), recoverContribution: vi.fn(async () => undefined), revokeContribution: vi.fn(noop), previewContributionText: vi.fn(async (): Promise<ScopeContributionTransfer> => ({ version: 1, kind: 'openapi-contribution-request', proposal })), ...overrides }
}
function paste(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function SourceHarness({ directory, actions }: { directory: ContributionDirectory<ClaudeScopeSessionSummary['sessionKey'], ClaudeScopeContributionDetail>; actions: SourceContributionActions }) {
  const values = useSyncExternalStore(callback => directory.subscribe(callback), () => directory.getSnapshot())
  return <SourceContributionPanel session={session} entry={values[session.sessionKey]} {...actions} t={t} />
}
function OwnerHarness({ directory, actions }: {
  directory: ContributionDirectory<DevelopmentTaskId, OwnerContributionValue>
  actions: OwnerContributionActions
}) {
  const values = useSyncExternalStore(callback => directory.subscribe(callback), () => directory.getSnapshot())
  return <OwnerContributionPanel taskId={TASK} entry={values[TASK]} {...actions} t={t} />
}

describe('source contribution onboarding', () => {
  it('uses one directory permission for tool observations without asking for an API file or operation', async () => {
    const toolEntry: ScopeContributionEntry = { ...applicationEntry, kind: 'contribution-entry', sourceKind: 'tool-observations' }
    const actions = sourceActions({ previewContributionText: vi.fn(async () => toolEntry) })
    render(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false, value: { session, capture: null } }} {...actions} t={t} />)
    expect(screen.queryByLabelText(zh['contribution.file'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.apiPath'])).toBeNull()
    expect(screen.getByText(zh['contribution.toolPermit'])).toBeTruthy()
    paste(zh['contribution.application.paste'], 'tool-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await screen.findByText(G.ownerPeerId)
    expect(screen.getByLabelText<HTMLSelectElement>(zh['contribution.sourceKind']).disabled).toBe(true)
    paste(zh['contribution.roots'], '/project\n/project/docs')
    paste(zh['contribution.hours'], '1'); paste(zh['contribution.maxSamples'], '8'); paste(zh['contribution.maxBytes'], '4096')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.request'] }))
    expect(actions.requestContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, expectedCapture: null,
      source: { kind: 'tool-observations', tools: ['Write', 'Edit'] }, roots: ['/project', '/project/docs'], entry: toolEntry,
      limits: { expiresAt: vi.mocked(actions.requestContribution).mock.calls[0]![0].limits.expiresAt,
        maxSamples: 8, maxSampleBytes: 4096 } })
  })

  it('requests approval with explicit local permission and limits after reviewing one entry', async () => {
    const actions = sourceActions({ previewContributionText: vi.fn(async () => applicationEntry) })
    render(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false, value: { session, capture: null } }} {...actions} t={t} />)
    paste(zh['contribution.application.paste'], 'owner-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await screen.findByText(G.ownerPeerId)
    paste(zh['contribution.file'], ' /project/api.json '); paste(zh['contribution.sourceName'], ' Orders ')
    paste(zh['contribution.apiPath'], ' /orders '); paste(zh['contribution.roots'], '/project')
    paste(zh['contribution.hours'], '1'); paste(zh['contribution.maxSamples'], '8'); paste(zh['contribution.maxBytes'], '4096')
    const before = Date.now()
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.request'] }))
    expect(actions.requestContribution).toHaveBeenCalledTimes(1)
    const request = vi.mocked(actions.requestContribution).mock.calls[0]![0]
    expect(request).toEqual({ sessionKey: session.sessionKey, expectedCapture: null,
      entry: applicationEntry, roots: ['/project'], source: { filePath: '/project/api.json', name: 'Orders', method: 'post', path: '/orders' },
      limits: { expiresAt: request.limits.expiresAt, maxSamples: 8, maxSampleBytes: 4096 } })
    expect(request.limits.expiresAt).toBeGreaterThanOrEqual(before + 3600000)
    expect(request.limits.expiresAt).toBeLessThanOrEqual(Date.now() + 3600000)
    expect(actions.prepareContribution).not.toHaveBeenCalled()
    expect(actions.activateContribution).not.toHaveBeenCalled()
  })

  it('updates waiting permission from background authority without requiring another invitation', async () => {
    let authority: ClaudeScopeContributionDetail = { ...captured,
      session: { ...captured.session, contributionApplicationState: 'waiting' },
      capture: { ...captured.capture!, application: { entry: applicationEntry,
        limits: { expiresAt: G.expiresAt, maxSamples: G.maxSamples, maxSampleBytes: G.maxSampleBytes }, state: 'waiting' } } }
    const directory = createContributionDirectory<ClaudeScopeSessionSummary['sessionKey'], ClaudeScopeContributionDetail>(async () => authority, vi.fn())
    disposers.push(() => { directory.dispose() })
    const actions = sourceActions({ readContribution: (key) => { void directory.refresh(key) } })
    render(<SourceHarness directory={directory} actions={actions} />)
    await screen.findByText(zh['contribution.application.waiting'])
    expect(screen.queryByLabelText(zh['contribution.proposalText'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.pasteInvitation'])).toBeNull()
    await act(async () => {
      authority = { ...authority, capture: { ...authority.capture!, invitation } }
      directory.invalidate(session.sessionKey)
      await directory.refresh(session.sessionKey)
    })
    expect(screen.queryByRole('button', { name: zh['contribution.activate'] })).toBeNull()
    await act(async () => {
      authority = { ...captured, session: { ...session, contributionState: 'active' }, capture: { ...captured.capture!, invitation } }
      directory.invalidate(session.sessionKey)
      await directory.refresh(session.sessionKey)
    })
    await screen.findByText(zh['contribution.active'])
    expect(actions.activateContribution).not.toHaveBeenCalled()
    expect(actions.requestContribution).not.toHaveBeenCalled()
  })

  it('prepares the selected independent session without a local Task and preserves normalized explicit permission', async () => {
    const actions = sourceActions()
    render(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false, value: { session, capture: null } }} {...actions} t={t} />)
    paste(zh['contribution.sourceKind'], 'openapi')
    paste(zh['contribution.file'], ' /project/api.json '); paste(zh['contribution.sourceName'], ' Orders ')
    paste(zh['contribution.apiPath'], ' /orders '); paste(zh['contribution.roots'], ' /project\n/project\n/project/api ')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.prepare'] }))
    expect(actions.prepareContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, expectedCapture: null,
      roots: ['/project', '/project/api'], source: { filePath: '/project/api.json', name: 'Orders', method: 'post', path: '/orders' } })
  })

  it('recovers an existing capture after a lost reply and uses its exact selection to activate', async () => {
    const directory = createContributionDirectory<ClaudeScopeSessionSummary['sessionKey'], ClaudeScopeContributionDetail>(async () => captured, vi.fn())
    disposers.push(() => { directory.dispose() })
    const actions = sourceActions({ readContribution: (key) => { void directory.refresh(key) } })
    render(<SourceHarness directory={directory} actions={actions} />)
    expect((await screen.findByLabelText<HTMLTextAreaElement>(zh['contribution.proposalText'])).value).toBe('versioned-request')
    expect(screen.queryByRole('button', { name: zh['contribution.prepare'] })).toBeNull()
    expect(screen.getByText(zh['contribution.reviewOwnerInvitation'])).toBeTruthy()
    expect(screen.queryByText(zh['contribution.reconnect'])).toBeNull()
    paste(zh['contribution.pasteInvitation'], 'owner-document')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.activate'] }))
    expect(actions.activateContribution).toHaveBeenCalledExactlyOnceWith({
      sessionKey: session.sessionKey, expectedCapture: captured.capture!.selection, invitation,
    })
  })

  it('removes an adopted preview after authority confirms successful activation', async () => {
    let authority = captured
    const directory = createContributionDirectory<ClaudeScopeSessionSummary['sessionKey'], ClaudeScopeContributionDetail>(
      async () => authority, vi.fn(),
    )
    disposers.push(() => { directory.dispose() })
    const actions = sourceActions({ readContribution: (key) => { void directory.refresh(key) }, activateContribution: async () => {
      await directory.mutate(session.sessionKey, async () => {
        authority = { ...captured, session: { ...session, contributionState: 'active' }, capture: { ...captured.capture!, invitation } }
      })
    } })
    render(<SourceHarness directory={directory} actions={actions} />)
    await screen.findByLabelText(zh['contribution.proposalText'])
    paste(zh['contribution.pasteInvitation'], 'owner-document')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.activate'] }))
    await screen.findByText(zh['contribution.active'])
    expect(screen.queryByRole('button', { name: zh['contribution.confirmReconnect'] })).toBeNull()
    expect(screen.getByText(zh['contribution.reconnect'])).toBeTruthy()
  })

  it.each<ScopeContributionInvitation['grant']['source']>([
    { kind: 'tool-observations', version: 2, initialization: 'recorded-local-tools', name: 'File work', tools: ['Write', 'Edit'] },
    { kind: 'tool-observations', version: 3, fileContent: 'completed-native-file', name: 'File work', tools: ['Write', 'Edit'] },
    { kind: 'tool-observations', version: 4, name: 'File work', tools: ['Write', 'Edit'],
      commands: [{ command: 'node verify.mjs', rootIndex: 0 }] },
  ])('retains a different source permission preview instead of acknowledging the existing file grant: $version', async (source) => {
    const original: ScopeContributionInvitation = { ...invitation, kind: 'tool-contribution',
      grant: { ...G, source: { kind: 'tool-observations', name: 'File work', tools: ['Write', 'Edit'] } } }
    const changed: ScopeContributionInvitation = { ...original, grant: { ...original.grant, source } }
    const authority: ClaudeScopeContributionDetail = { session: { ...session, contributionState: 'active' },
      capture: { ...captured.capture!, proposal: { ...proposal, source: original.grant.source },
        source: { kind: 'tool-observations', tools: ['Write', 'Edit'] }, invitation: original } }
    const actions = sourceActions({ previewContributionText: vi.fn(async () => changed) })
    const view = render(<SourceContributionPanel session={session}
      entry={{ status: 'ready', pending: false, value: authority }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.reconnect']))
    paste(zh['contribution.pasteInvitation'], 'different-source-permission')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    await screen.findByRole('button', { name: zh['contribution.confirmReconnect'] })
    view.rerender(<SourceContributionPanel session={session}
      entry={{ status: 'ready', pending: false, value: { ...authority } }} {...actions} t={t} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.confirmReconnect'] }).disabled).toBe(false)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.pasteInvitation']).value).toBe('different-source-permission')
    expect(actions.activateContribution).not.toHaveBeenCalled()
  })

  it('retains a different-address preview and its draft when reconnecting fails', async () => {
    const authority: ClaudeScopeContributionDetail = {
      ...captured, session: { ...session, contributionState: 'active' }, capture: { ...captured.capture!, invitation },
    }
    const relocated = { ...invitation, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }
    const directory = createContributionDirectory<ClaudeScopeSessionSummary['sessionKey'], ClaudeScopeContributionDetail>(
      async () => authority, vi.fn(),
    )
    disposers.push(() => { directory.dispose() })
    const actions = sourceActions({ readContribution: (key) => { void directory.refresh(key) },
      previewContributionText: async () => relocated, activateContribution: async () => {
        await directory.mutate(session.sessionKey, async () => { throw new Error('offline') })
      } })
    render(<SourceHarness directory={directory} actions={actions} />)
    fireEvent.click(await screen.findByText(zh['contribution.reconnect']))
    paste(zh['contribution.pasteInvitation'], 'replacement-address-document')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.confirmReconnect'] }))
    await screen.findByText(zh['contribution.error.unknown'])
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.pasteInvitation']).value).toBe('replacement-address-document')
    expect(screen.getByText(relocated.ownerAddress)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.confirmReconnect'] }).disabled).toBe(false)
  })

  it('disables stale mutation controls until a failed confirmation is explicitly refreshed', async () => {
    const read = vi.fn().mockResolvedValueOnce(captured).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(captured)
    const directory = createContributionDirectory<ClaudeScopeSessionSummary['sessionKey'], ClaudeScopeContributionDetail>(read, vi.fn())
    disposers.push(() => { directory.dispose() })
    const actions = sourceActions({ readContribution: (key) => { void directory.refresh(key) }, stopContribution: async () => { await directory.mutate(session.sessionKey, async () => { throw new Error('reply lost') }) } })
    render(<SourceHarness directory={directory} actions={actions} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.stop'] }))
    await screen.findByText(zh['contribution.loadFailed'])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.stop'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.refresh'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.stop'] }).disabled).toBe(false) })
  })

  it('retries an ended session withdrawal using the reviewed replacement address without activation', async () => {
    const relocated = { ...invitation, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }
    const actions = sourceActions({ previewContributionText: vi.fn(async () => relocated) })
    render(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false,
      value: { ...captured, session: { ...session, ended: true, contributionState: 'withdrawal-pending' }, capture: { ...captured.capture!, invitation } } }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.reconnect']))
    paste(zh['contribution.pasteInvitation'], 'relocated-owner-document')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.retryWithAddress'] }))
    expect(actions.stopContribution).toHaveBeenCalledExactlyOnceWith({
      sessionKey: session.sessionKey, expectedCapture: captured.capture!.selection, invitation: relocated,
    })
    expect(actions.activateContribution).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: zh['contribution.activate'] })).toBeNull()
  })

  it('stops a local preparation without adopting a merely previewed owner grant', async () => {
    const actions = sourceActions()
    render(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false, value: captured }} {...actions} t={t} />)
    paste(zh['contribution.pasteInvitation'], 'unaccepted-owner-document')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    await screen.findByRole('button', { name: zh['contribution.activate'] })
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.stop'] }))
    expect(actions.stopContribution).toHaveBeenCalledExactlyOnceWith({
      sessionKey: session.sessionKey, expectedCapture: captured.capture!.selection,
    })
    expect(actions.activateContribution).not.toHaveBeenCalled()
  })

  it('discards a delayed invitation preview after the capture is replaced', async () => {
    const gate = Promise.withResolvers<ScopeContributionTransfer>()
    const actions = sourceActions({ previewContributionText: () => gate.promise })
    const view = render(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false, value: captured }} {...actions} t={t} />)
    paste(zh['contribution.pasteInvitation'], 'old-capture-document')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    const replacement = { ...captured, capture: { ...captured.capture!, selection: { ...captured.capture!.selection, captureId: 'capture-b' as typeof G.captureId } } }
    view.rerender(<SourceContributionPanel session={session} entry={{ status: 'ready', pending: false, value: replacement }} {...actions} t={t} />)
    await act(async () => { gate.resolve(invitation); await gate.promise })
    expect(screen.queryByRole('button', { name: zh['contribution.activate'] })).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.pasteInvitation']).value).toBe('old-capture-document')
  })
})

describe('owner contribution permissions', () => {
  it('recovers the original inventory grant after approval commits but its reply is lost', async () => {
    let committed = false
    const directory = createContributionDirectory<DevelopmentTaskId, OwnerContributionValue>(
      async () => ({ ...owned, inventory: { entries: committed ? [active] : [], nextGrantId: null } }), vi.fn(),
    )
    disposers.push(() => { directory.dispose() })
    const approve = vi.fn(async () => { committed = true; throw new Error('lost reply') })
    const recovered = { invitation, text: 'original-owner-invitation' }
    const recover = vi.fn(async () => recovered)
    const actions = ownerActions({ readOwnedContributions: (key) => { void directory.refresh(key) },
      approveContribution: request => directory.mutate(request.taskId, approve),
      recoverContribution: request => directory.mutate(request.taskId, recover) })
    render(<OwnerHarness directory={directory} actions={actions} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.verifyProposal'] }).disabled).toBe(true) })
    await screen.findByText(zh['contribution.noGrants'])
    paste(zh['contribution.pasteProposal'], 'versioned-request')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyProposal'] }))
    await screen.findByLabelText(zh['contribution.hours'])
    paste(zh['contribution.hours'], '1'); paste(zh['contribution.maxSamples'], '8'); paste(zh['contribution.maxBytes'], '5000')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.approve'] }))
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.recover'] }))
    expect((await screen.findByLabelText<HTMLTextAreaElement>(zh['contribution.invitationText'])).value).toBe(recovered.text)
    expect(approve).toHaveBeenCalledOnce(); expect(recover).toHaveBeenCalledOnce()
  })

  it('retains terminal state while recovering a route for pending withdrawal and exposes remaining pages', async () => {
    const terminal: DevelopmentTaskPeerContribution = { state: 'ended', reason: 'revoked', grant: G, endReceipt: { ...receipt, event: { ...receipt.event, kind: 'peer-contribution-ended' } } }
    const actions = ownerActions({ recoverContribution: vi.fn(async () => ({ invitation, text: 'terminal-confirmation-route' })) })
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false,
      value: { ...owned, inventory: { entries: [terminal], nextGrantId: G.grantId } } }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.recoverEnded'] }))
    await screen.findByLabelText(zh['contribution.invitationText'])
    expect(screen.getByText(zh['contribution.end.revoked'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['contribution.revoke'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.more'] }))
    expect(actions.moreOwnedContributions).toHaveBeenCalledExactlyOnceWith(TASK)
  })

  it('does not reveal a delayed invitation after switching away and back to the Task', async () => {
    const gate = Promise.withResolvers<ScopeContributionApprovalResult>()
    const actions = ownerActions({ recoverContribution: () => gate.promise })
    const entry = { status: 'ready' as const, pending: false, value: { ...owned, inventory: { entries: [active], nextGrantId: null } } }
    const view = render(<OwnerContributionPanel key="first" taskId={TASK} entry={entry} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.recover'] }))
    view.rerender(<OwnerContributionPanel key="second" taskId={'task-b' as DevelopmentTaskId} entry={entry} {...actions} t={t} />)
    view.rerender(<OwnerContributionPanel key="third" taskId={TASK} entry={entry} {...actions} t={t} />)
    await act(async () => { gate.resolve({ invitation, text: 'stale-invitation' }); await gate.promise })
    expect(screen.queryByDisplayValue('stale-invitation')).toBeNull()
  })
})
type ScopeContributionApprovalResult = Awaited<ReturnType<OwnerContributionActions['recoverContribution']>>


describe('owner online contribution applications', () => {
  it('creates entries for the displayed source mode and preserves the OpenAPI option', () => {
    const actions = ownerActions()
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: owned }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    paste(zh['contribution.join.purpose'], 'contribution')
    paste(zh['contribution.application.entryHours'], '1')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.create'] }))
    expect(actions.createContributionEntry).toHaveBeenLastCalledWith({ taskId: TASK, ownerAddress: invitation.ownerAddress,
      sourceKind: 'tool-observations', expiresAt: vi.mocked(actions.createContributionEntry).mock.calls[0]![0].expiresAt })
    paste(zh['contribution.sourceKind'], 'openapi')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.create'] }))
    expect(actions.createContributionEntry).toHaveBeenLastCalledWith({ taskId: TASK, ownerAddress: invitation.ownerAddress,
      sourceKind: 'openapi', expiresAt: vi.mocked(actions.createContributionEntry).mock.calls[1]![0].expiresAt })
  })

  it('approves the displayed peer and exact source limits without returning a grant text to the source', async () => {
    const actions = ownerActions()
    const limits = { expiresAt: G.expiresAt, maxSamples: G.maxSamples, maxSampleBytes: G.maxSampleBytes }
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false,
      value: { ...owned, applications: { entries: [{ entry: applicationEntry, text: 'owner-entry', proposal, limits, result: { status: 'pending' } }], nextEntryId: null } } }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    expect(screen.getByText(G.contributorPeerId)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.approve'] }))
    expect(actions.approveContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, {
      entryId: applicationEntry.entryId, expectedProposal: proposal, limits, ownerAddress: invitation.ownerAddress,
    })
    expect(actions.approveContribution).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(zh['contribution.invitationText'])).toBeNull()
  })
})


describe('owner joint application decisions', () => {
  it('requires choosing a published route and blocks an explicit choice removed by a refreshed identity', () => {
    const network = '/ip4/192.0.2.10/tcp/43120/p2p/owner-peer'
    const actions = ownerActions()
    const value = { ...owned, identity: { ...owned.identity, addresses: [invitation.ownerAddress, network] } }
    const view = render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    paste(zh['contribution.application.entryHours'], '1')
    const create = () => screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.join.create'] })
    expect(create().disabled).toBe(true)
    expect(screen.getByText(zh['access.addressSetupHint'])).toBeTruthy()
    paste(zh['access.address'], network)
    fireEvent.click(create())
    expect(vi.mocked(actions.createContributionEntry).mock.calls[0]?.[0].ownerAddress).toBe(network)
    view.rerender(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false,
      value: { ...value, identity: { ...owned.identity, addresses: [invitation.ownerAddress] } } }} {...actions} t={t} />)
    expect(screen.getByLabelText<HTMLSelectElement>(zh['access.address']).value).toBe('')
    expect(create().disabled).toBe(true)
    paste(zh['access.address'], invitation.ownerAddress)
    expect(screen.getByText(zh['access.addressLocalHint'])).toBeTruthy()
    expect(create().disabled).toBe(false)
  })

  it('creates one tool-work joint entry while keeping contribution-only as an explicit alternative', () => {
    const actions = ownerActions()
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: owned }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    expect(screen.getByLabelText<HTMLSelectElement>(zh['contribution.join.purpose']).value).toBe('join')
    expect(screen.queryByLabelText(zh['contribution.sourceKind'])).toBeNull()
    expect(screen.getByText(zh['contribution.join.entryHint'])).toBeTruthy()
    paste(zh['contribution.application.entryHours'], '1')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.join.create'] }))
    const sent = vi.mocked(actions.createContributionEntry).mock.calls.at(0)?.[0]
    expect(sent).toEqual({ taskId: TASK, ownerAddress: invitation.ownerAddress, sourceKind: 'tool-observations',
      participation: 'join', expiresAt: sent?.expiresAt })
    expect(actions.approveContributionApplication).not.toHaveBeenCalled()
  })

  it('requires an explicit responsibility before jointly approving the exact displayed applicant and ceilings', () => {
    const actions = ownerActions()
    const jointEntry = { ...applicationEntry, kind: 'scope-join-entry', sourceKind: 'tool-observations' } satisfies ScopeContributionEntry
    const jointProposal: ScopeContributionProposal = { ...proposal, source: { kind: 'tool-observations', name: 'Native file work', tools: ['Write', 'Edit'] } }
    const limits = { expiresAt: G.expiresAt, maxSamples: G.maxSamples, maxSampleBytes: G.maxSampleBytes }
    const value: OwnerContributionValue = { ...owned, applications: { entries: [
      { entry: jointEntry, text: 'one-session-entry', proposal: jointProposal, limits, result: { status: 'pending' } },
    ], nextEntryId: null } }
    const view = render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    const approve = (): HTMLButtonElement => screen.getByRole('button', { name: zh['contribution.join.approve'] })
    expect(approve().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: zh['contribution.application.approve'] })).toBeNull()
    expect(screen.getByText(zh['contribution.join.approvalHint'])).toBeTruthy()
    paste(zh['contribution.join.responsibility'], '  Frontend integration  ')
    fireEvent.click(approve())
    expect(actions.approveContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, { entryId: jointEntry.entryId,
      expectedProposal: jointProposal, limits, ownerAddress: invitation.ownerAddress, read: { responsibility: 'Frontend integration' } })
    expect(actions.approveContribution).not.toHaveBeenCalled()
    view.rerender(<OwnerContributionPanel taskId={TASK} entry={{ status: 'error', pending: false, value }} {...actions} t={t} />)
    expect(approve().disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['contribution.join.responsibility']).value).toBe('  Frontend integration  ')
    fireEvent.click(approve())
    expect(actions.approveContributionApplication).toHaveBeenCalledOnce()
  })
})


describe('owner joint read permission visibility', () => {
  it.each(['active', 'revoked', 'expired'] as const)('shows %s reading independently of ended contribution', (readState) => {
    const jointEntry = { ...applicationEntry, kind: 'scope-join-entry', sourceKind: 'tool-observations' } satisfies ScopeContributionEntry
    const value: OwnerContributionValue = { ...owned, applications: { nextEntryId: null, entries: [{
      entry: jointEntry, text: 'join-entry', proposal, limits: captureLimits(), result: {
        status: 'ended', reason: 'left', invitation, receipt: { ...receipt, event: { ...receipt.event, kind: 'peer-contribution-ended' } },
        readInvitation, readState,
      },
    }] } }
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value }} {...ownerActions()} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    expect(screen.getByText(zh['contribution.application.owner.ended'])).toBeTruthy()
    expect(screen.getByText(zh[`contribution.join.read.${readState}`])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['contribution.join.approve'] })).toBeNull()
  })
})

function captureLimits() {
  return { expiresAt: G.expiresAt, maxSamples: G.maxSamples, maxSampleBytes: G.maxSampleBytes }
}


describe('owner reusable collaboration entries', () => {
  const groupEntry: ScopeGroupEntry = { ...applicationEntry, version: 2, kind: 'scope-group-entry',
    sourceKind: 'tool-observations', maxMembers: 2 }
  const members = ['b', 'c'].map(name => ({
    entry: groupEntry, text: 'same-group-entry', applicationId: `application-${name}` as ScopeGroupApplicationId,
    proposal: { ...proposal, contributorPeerId: `peer-${name}` as typeof proposal.contributorPeerId,
      captureId: `capture-${name}` as typeof proposal.captureId }, limits: captureLimits(), result: { status: 'pending' as const },
  }))
  const value: OwnerContributionValue = { ...owned, groups: { nextEntryId: null, entries: [{
    group: { entry: groupEntry, text: 'same-group-entry', state: 'open', applicationCount: 2 },
    applications: { entries: members, nextApplicationId: null },
  }] } }

  it('requires explicit capacity before issuing one reusable entry and explains retained applicant slots', () => {
    const actions = ownerActions()
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: owned }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    paste(zh['contribution.join.purpose'], 'group')
    paste(zh['contribution.application.entryHours'], '1')
    const create = screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.group.create'] })
    expect(create.disabled).toBe(true)
    expect(screen.getByText(zh['contribution.group.capacityHint'])).toBeTruthy()
    paste(zh['contribution.group.capacity'], '2')
    fireEvent.click(create)
    const expiresAt = vi.mocked(actions.createGroupEntry).mock.calls[0]?.[0].expiresAt
    expect(expiresAt).toBeTypeOf('number')
    expect(actions.createGroupEntry).toHaveBeenCalledExactlyOnceWith({ taskId: TASK,
      ownerAddress: invitation.ownerAddress, expiresAt, maxMembers: 2 })
    expect(actions.createContributionEntry).not.toHaveBeenCalled()
  })

  it('ends only the selected approved member without closing the entry or invoking contribution-only revocation', () => {
    const actions = ownerActions()
    const approved: OwnerContributionValue = { ...value, groups: { ...value.groups, entries: value.groups.entries.map(item => ({
      ...item, applications: { ...item.applications, entries: item.applications.entries.map(member => ({ ...member,
        result: { status: 'approved', invitation, receipt, readInvitation, readState: 'active' },
      })) },
    })) } }
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: approved }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    const buttons = screen.getAllByRole('button', { name: zh['contribution.group.endMember'] })
    const selected = members[1]
    const end = buttons[1]
    if (selected === undefined || end === undefined) throw new Error('Both approved members must be displayed')
    fireEvent.click(end)
    expect(actions.rejectContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, {
      entryId: groupEntry.entryId, applicationId: selected.applicationId, expectedProposal: selected.proposal,
    })
    expect(actions.closeGroupEntry).not.toHaveBeenCalled()
    expect(actions.revokeContribution).not.toHaveBeenCalled()
  })

  it.each(['active', 'revoked', 'expired'] as const)('offers ending a contributed member only while its reading is %s', (readState) => {
    const actions = ownerActions()
    const ended: OwnerContributionValue = { ...value, groups: { ...value.groups, entries: value.groups.entries.map(item => ({
      ...item, applications: { ...item.applications, entries: item.applications.entries.map(member => ({ ...member,
        result: { status: 'ended', reason: 'left', invitation,
          receipt: { ...receipt, event: { ...receipt.event, kind: 'peer-contribution-ended' } }, readInvitation, readState },
      })) },
    })) } }
    render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: ended }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    const buttons = screen.queryAllByRole('button', { name: zh['contribution.group.endMember'] })
    if (readState === 'active') {
      expect(buttons).toHaveLength(2)
      const selected = members[0]
      const end = buttons[0]
      if (selected === undefined || end === undefined) throw new Error('Still authorized member must retain its end control')
      fireEvent.click(end)
      expect(actions.rejectContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, {
        entryId: groupEntry.entryId, applicationId: selected.applicationId, expectedProposal: selected.proposal,
      })
    } else {
      expect(buttons).toEqual([])
      expect(actions.rejectContributionApplication).not.toHaveBeenCalled()
    }
  })

  it('visibly distinguishes two captures on the same peer and approves only the chosen one', () => {
    const actions = ownerActions()
    const samePeer: OwnerContributionValue = { ...value, groups: { ...value.groups, entries: value.groups.entries.map(item => ({
      ...item, applications: { ...item.applications, entries: item.applications.entries.map(member => ({ ...member,
        proposal: { ...member.proposal, contributorPeerId: G.contributorPeerId,
          captureGeneration: `generation-${member.proposal.captureId}` as typeof G.captureGeneration },
      })) },
    })) } }
    const view = render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: samePeer }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    expect(screen.getAllByText(G.contributorPeerId)).toHaveLength(2)
    const second = samePeer.groups.entries[0]?.applications.entries[1]
    if (second === undefined) throw new Error('Second capture fixture is missing')
    const secondLabel = screen.getByText(second.proposal.captureId, { exact: true })
    const row = secondLabel.closest('[data-group-application]')
    if (!(row instanceof HTMLElement)) throw new Error('Capture identity must be visible within its independent member controls')
    expect(within(row).getByText(second.proposal.captureGeneration, { exact: true })).toBeTruthy()
    expect(view.container.textContent).toContain('capture-b')
    fireEvent.change(within(row).getByLabelText(zh['contribution.join.responsibility']), { target: { value: 'Second session responsibility' } })
    fireEvent.click(within(row).getByRole('button', { name: zh['contribution.join.approve'] }))
    expect(actions.approveContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, {
      entryId: groupEntry.entryId, applicationId: second.applicationId, expectedProposal: second.proposal,
      limits: second.limits, ownerAddress: invitation.ownerAddress, read: { responsibility: 'Second session responsibility' },
    })
  })

  it('keeps members distinct through close and approves or rejects only the selected application', () => {
    const actions = ownerActions()
    const view = render(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value }} {...actions} t={t} />)
    fireEvent.click(screen.getByText(zh['contribution.ownerTitle']))
    expect(screen.getByText(t('contribution.group.count', { count: 2, capacity: 2 }))).toBeTruthy()
    expect(screen.getByText(zh['contribution.group.closeHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.group.close'] }))
    expect(actions.closeGroupEntry).toHaveBeenCalledExactlyOnceWith(TASK, { entryId: groupEntry.entryId })
    expect(actions.rejectContributionApplication).not.toHaveBeenCalled()
    expect(actions.revokeContribution).not.toHaveBeenCalled()
    const closed: OwnerContributionValue = { ...value, groups: { ...value.groups,
      entries: value.groups.entries.map(item => ({ ...item, group: { ...item.group, state: 'closed' } })) } }
    view.rerender(<OwnerContributionPanel taskId={TASK} entry={{ status: 'ready', pending: false, value: closed }} {...actions} t={t} />)
    expect(screen.getByText(zh['contribution.group.state.closed'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['contribution.group.close'] })).toBeNull()
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-group-application]')]
    expect(rows).toHaveLength(2)
    const b = within(rows[0]!)
    const c = within(rows[1]!)
    fireEvent.change(b.getByLabelText(zh['contribution.join.responsibility']), { target: { value: 'Frontend implementation' } })
    fireEvent.click(b.getByRole('button', { name: zh['contribution.join.approve'] }))
    expect(actions.approveContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, {
      entryId: groupEntry.entryId, applicationId: members[0]!.applicationId, expectedProposal: members[0]!.proposal,
      limits: captureLimits(), ownerAddress: invitation.ownerAddress, read: { responsibility: 'Frontend implementation' },
    })
    expect(c.getByRole<HTMLButtonElement>('button', { name: zh['contribution.join.approve'] }).disabled).toBe(true)
    fireEvent.click(c.getByRole('button', { name: zh['contribution.application.reject'] }))
    expect(actions.rejectContributionApplication).toHaveBeenCalledExactlyOnceWith(TASK, {
      entryId: groupEntry.entryId, applicationId: members[1]!.applicationId, expectedProposal: members[1]!.proposal,
    })
  })
})
