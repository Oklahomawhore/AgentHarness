// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClaudeScopeContributionDetail, ClaudeScopeJointSummary, ClaudeScopeSessionSummary,
  ScopeContributionEntry, ScopeContributionEntryProbeResult } from '@deepseek-ai/dsh-api-remotes/client'
import { SourceContributionPanel, type SourceContributionActions } from '../src/client/SourceContributionPanel.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
const session: ClaudeScopeSessionSummary = { sessionKey: 'claude-one' as ClaudeScopeSessionSummary['sessionKey'],
  sessionId: 'existing-claude', cwd: '/project', observedAt: 1, ended: false, readRevision: 3 }
const group: ScopeContributionEntry = {
  version: 2, kind: 'scope-group-entry', sourceKind: 'tool-observations', maxMembers: 3,
  entryId: 'entry' as ScopeContributionEntry['entryId'], taskId: 'task' as ScopeContributionEntry['taskId'],
  ownerPeerId: 'owner' as ScopeContributionEntry['ownerPeerId'], ownerAddress: '/ip4/127.0.0.1/tcp/6000/p2p/owner',
  expiresAt: 2000000000000,
}
const single: ScopeContributionEntry = { ...group, version: 1, kind: 'scope-join-entry' }
const subscriptionId = 'subscription' as NonNullable<ClaudeScopeJointSummary['subscriptionId']>
const joint: ClaudeScopeJointSummary = { id: 'joint-one' as ClaudeScopeJointSummary['id'],
  capture: { captureId: 'capture' as ClaudeScopeJointSummary['capture']['captureId'],
    captureGeneration: 'generation' as ClaudeScopeJointSummary['capture']['captureGeneration'] },
  expectedReadRevision: 3, state: 'active', intent: 'adopt', cleanupPending: false,
  subscriptionId }
function actions(overrides: Partial<SourceContributionActions> = {}): SourceContributionActions {
  const noop = async (): Promise<void> => {}
  return { readContribution: vi.fn(), requestContribution: vi.fn(noop), prepareContribution: vi.fn(noop),
    activateContribution: vi.fn(noop), stopContribution: vi.fn(noop), leaveJointContribution: vi.fn(noop),
    recoverJointContribution: vi.fn(noop), probeContributionEntry: vi.fn(async () => ({ status: 'ready' as const })),
    previewContributionText: vi.fn(async () => group), ...overrides }
}
function value(subject = session, capture: ClaudeScopeContributionDetail['capture'] = null) {
  return { status: 'ready' as const, pending: false, value: { session: subject, capture } }
}
function change(label: string, text: string) { fireEvent.change(screen.getByLabelText(label), { target: { value: text } }) }
async function review() {
  change(zh['contribution.application.paste'], 'group-entry')
  fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
  await screen.findByText(zh['claude.joint.hint'])
  change(zh['contribution.hours'], '1'); change(zh['contribution.maxSamples'], '8'); change(zh['contribution.maxBytes'], '4096')
}
function consent() {
  fireEvent.click(screen.getByRole('checkbox', { name: zh['claude.joint.readConsent'] }))
  fireEvent.click(screen.getByRole('checkbox', { name: zh['claude.joint.collectionConsent'] }))
}
afterEach(cleanup)

describe('Claude joint collaboration controls', () => {
  it.each([single, group])('requires both permissions for $kind and sends the observed read revision', async (entry) => {
    const port = actions({ previewContributionText: vi.fn(async () => entry) })
    render(<SourceContributionPanel session={session} entry={value()} {...port} t={t} />)
    await review()
    expect(port.probeContributionEntry).toHaveBeenCalledExactlyOnceWith({ entry })
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.joint.request'] })
    expect(submit.disabled).toBe(true)
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').map(input => input.checked)).toEqual([false, false])
    fireEvent.click(screen.getByRole('checkbox', { name: zh['claude.joint.readConsent'] }))
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['claude.joint.collectionConsent'] }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(port.requestContribution).toHaveBeenCalledTimes(1)
    const request = vi.mocked(port.requestContribution).mock.calls[0]?.[0]
    expect(request).toEqual({ sessionKey: session.sessionKey, expectedCapture: null, roots: ['/project'],
      source: { kind: 'tool-observations', tools: ['Write', 'Edit'] }, entry, receive: { expectedReadRevision: 3 },
      limits: { expiresAt: request?.limits.expiresAt, maxSamples: 8, maxSampleBytes: 4096 } })
    expect(screen.queryByText(zh['contribution.application.manual'])).toBeNull()
    expect(port.activateContribution).not.toHaveBeenCalled()
  })

  it('requires renewed collection consent after a permission edit and renewed reading consent after a read change', async () => {
    const port = actions()
    const view = render(<SourceContributionPanel session={session} entry={value()} {...port} t={t} />)
    await review(); consent()
    change(zh['contribution.roots'], '/project/selected')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['claude.joint.readConsent'] }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['claude.joint.collectionConsent'] }).checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['claude.joint.collectionConsent'] }))
    view.rerender(<SourceContributionPanel session={session} entry={value({ ...session, readRevision: 4 })} {...port} t={t} />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['claude.joint.readConsent'] }).checked).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.joint.request'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['claude.joint.readConsent'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['claude.joint.request'] }))
    expect(vi.mocked(port.requestContribution).mock.calls[0]?.[0].receive).toEqual({ expectedReadRevision: 4 })
  })

  it('leaves an existing read connection intact instead of permitting a joint replacement', async () => {
    const subject = { ...session, receiveSubscriptionId: subscriptionId }
    const port = actions()
    render(<SourceContributionPanel session={subject} entry={value(subject)} {...port} t={t} />)
    await review()
    expect(screen.getByText(zh['claude.joint.conflict'])).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['claude.joint.readConsent'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.joint.request'] }).disabled).toBe(true)
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it.each(['denied', 'unavailable'] as const)('does not authorize a %s entry', async (status) => {
    const port = actions({ probeContributionEntry: vi.fn(async () => ({ status })) })
    render(<SourceContributionPanel session={session} entry={value()} {...port} t={t} />)
    change(zh['contribution.application.paste'], 'entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await screen.findByText(zh[`native.share.probe.${status}`])
    expect(screen.queryByText(zh['claude.joint.readConsent'])).toBeNull()
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it('discards a late entry probe after selecting a different observed session', async () => {
    const pending = Promise.withResolvers<ScopeContributionEntryProbeResult>()
    const port = actions({ probeContributionEntry: vi.fn(() => pending.promise) })
    const view = render(<SourceContributionPanel key={session.sessionKey} session={session} entry={value()} {...port} t={t} />)
    change(zh['contribution.application.paste'], 'first')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] })) })
    const other = { ...session, sessionKey: 'other' as ClaudeScopeSessionSummary['sessionKey'] }
    view.rerender(<SourceContributionPanel key={other.sessionKey} session={other} entry={value(other)} {...port} t={t} />)
    await act(async () => { pending.resolve({ status: 'ready' }) })
    expect(screen.queryByText(zh['claude.joint.readConsent'])).toBeNull()
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it('disables recovery for blank addresses and while the selected operation is pending', () => {
    const selected = { ...session, joint }
    const port = actions()
    const view = render(<SourceContributionPanel session={selected} entry={value(selected)} {...port} t={t} />)
    fireEvent.click(screen.getByText(zh['native.route.title']))
    const recover = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.route.apply'] })
    expect(recover.disabled).toBe(true)
    fireEvent.click(recover)
    change(zh['native.route.new'], '   ')
    expect(recover.disabled).toBe(true)
    fireEvent.click(recover)
    expect(port.recoverJointContribution).not.toHaveBeenCalled()
    change(zh['native.route.new'], '/ip4/127.0.0.1/tcp/7000/p2p/owner')
    expect(recover.disabled).toBe(false)
    view.rerender(<SourceContributionPanel session={selected} entry={{ ...value(selected), pending: true }} {...port} t={t} />)
    expect(recover.disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['native.route.new']).disabled).toBe(true)
    fireEvent.click(recover)
    expect(port.recoverJointContribution).not.toHaveBeenCalled()
  })

  it.each(['waiting', 'adopting', 'active'] as const)('recovers the exact %s join without another invitation', (state) => {
    const selected = { ...session, readRevision: 9, joint: { ...joint, state } }
    const port = actions()
    render(<SourceContributionPanel session={selected} entry={value(selected)} {...port} t={t} />)
    expect(screen.getByText(zh[`claude.joint.state.${state}`])).toBeTruthy()
    expect(screen.getByText(zh['claude.joint.passiveHint'])).toBeTruthy()
    fireEvent.click(screen.getByText(zh['native.route.title']))
    change(zh['native.route.new'], ' /ip4/127.0.0.1/tcp/7000/p2p/owner ')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.apply'] }))
    expect(port.recoverJointContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, jointId: joint.id,
      expectedReadRevision: 9, ownerAddress: '/ip4/127.0.0.1/tcp/7000/p2p/owner' })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.joint.leave'] }))
    expect(port.leaveJointContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, jointId: joint.id })
    expect(screen.queryByLabelText(zh['contribution.pasteInvitation'])).toBeNull()
    expect(port.requestContribution).not.toHaveBeenCalled()
    expect(port.stopContribution).not.toHaveBeenCalled()
  })

  it('stops only the capture while an active join retains its separate read controls', () => {
    const selected = { ...session, joint, contributionState: 'active' as const, receiveSubscriptionId: subscriptionId }
    const capture: NonNullable<ClaudeScopeContributionDetail['capture']> = { selection: joint.capture,
      roots: ['/project'], source: { kind: 'tool-observations', tools: ['Write', 'Edit'] },
      proposal: { contributorPeerId: 'source' as ScopeContributionEntry['ownerPeerId'], ...joint.capture,
        source: { kind: 'tool-observations', name: 'file-work', tools: ['Write', 'Edit'] } },
      proposalText: 'proposal', invitation: null, application: null }
    const port = actions()
    const view = render(<SourceContributionPanel session={selected} entry={value(selected, capture)} {...port} t={t} />)
    expect(screen.getByText(zh['claude.joint.stopActiveHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.stop'] }))
    expect(port.stopContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, expectedCapture: joint.capture })
    expect(port.leaveJointContribution).not.toHaveBeenCalled()
    view.rerender(<SourceContributionPanel session={selected} entry={value(selected)} {...port} t={t} />)
    expect(screen.getByRole('button', { name: zh['claude.joint.leave'] })).toBeTruthy()
    expect(screen.getByLabelText(zh['native.route.new'])).toBeTruthy()
    const retainedReading = screen.getByRole('region', { name: zh['claude.joint.title'] })
    const newApplication = screen.getByLabelText(zh['contribution.application.paste']).closest('form')
    if (newApplication === null) throw new Error('Independent capture form is missing')
    expect(retainedReading.compareDocumentPosition(newApplication)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })


  it.each(['active', 'ended'] as const)('keeps a new manual capture usable beside an old %s joint', async (state) => {
    const selected = { ...session, joint: { ...joint, state }, contributionState: 'prepared' as const }
    const selection = { ...joint.capture, captureId: 'new-capture' as typeof joint.capture.captureId }
    const source = { kind: 'tool-observations' as const, name: 'session-work', tools: ['Write' as const] }
    const proposal = { contributorPeerId: 'source' as ScopeContributionEntry['ownerPeerId'], ...selection, source }
    const invitation = { version: 1 as const, kind: 'tool-contribution' as const, ownerAddress: group.ownerAddress,
      grant: { ...proposal, version: 1 as const, ownerPeerId: group.ownerPeerId, taskId: group.taskId,
        grantId: 'new-grant' as import('@deepseek-ai/dsh-api-remotes/client').ScopeContributionInvitation['grant']['grantId'],
        generation: 'new-generation' as import('@deepseek-ai/dsh-api-remotes/client').ScopeContributionInvitation['grant']['generation'],
        expiresAt: group.expiresAt, maxSamples: 8, maxSampleBytes: 4096 } }
    const capture = { selection, roots: ['/project'], source: { kind: 'tool-observations' as const, tools: ['Write' as const] },
      proposal, proposalText: 'new-proposal', invitation: null, application: null }
    const port = actions({ previewContributionText: vi.fn(async () => invitation) })
    render(<SourceContributionPanel session={selected} entry={value(selected, capture)} {...port} t={t} />)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.proposalText']).value).toBe('new-proposal')
    change(zh['contribution.pasteInvitation'], 'new-invitation')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    fireEvent.click(await screen.findByRole('button', { name: zh['contribution.activate'] }))
    expect(port.activateContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
      expectedCapture: selection, invitation })
    expect(port.recoverJointContribution).not.toHaveBeenCalled()
  })

  it('offers recovery for a terminal join whose original contribution still needs owner confirmation', () => {
    const selected = { ...session, joint: { ...joint, state: 'ended' as const, intent: 'leave' as const, cleanupPending: true } }
    const port = actions()
    render(<SourceContributionPanel session={selected} entry={value(selected)} {...port} t={t} />)
    expect(screen.getByText(zh['claude.joint.ending'])).toBeTruthy()
    expect(screen.queryByText(zh['claude.joint.passiveHint'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.application.paste'])).toBeNull()
    fireEvent.click(screen.getByText(zh['native.route.title']))
    change(zh['native.route.new'], '/ip4/127.0.0.1/tcp/9000/p2p/owner')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.apply'] }))
    expect(port.recoverJointContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, jointId: joint.id,
      expectedReadRevision: 3, ownerAddress: '/ip4/127.0.0.1/tcp/9000/p2p/owner' })
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it('reports failed reading without promising context preparation while recovery remains available', () => {
    const selected = { ...session, joint: { ...joint, state: 'failed' as const } }
    render(<SourceContributionPanel session={selected} entry={value(selected)} {...actions()} t={t} />)
    expect(screen.getByText(zh['claude.joint.state.failed'])).toBeTruthy()
    expect(screen.queryByText(zh['claude.joint.passiveHint'])).toBeNull()
    expect(screen.getByText(zh['native.route.title'])).toBeTruthy()
  })

  it.each(['ended', 'superseded'] as const)('keeps %s history without offering recovery or another leave', (state) => {
    const selected = { ...session, joint: { ...joint, state } }
    render(<SourceContributionPanel session={selected} entry={value(selected)} {...actions()} t={t} />)
    expect(screen.getByText(zh[`claude.joint.state.${state}`])).toBeTruthy()
    expect(screen.queryByText(zh['claude.joint.passiveHint'])).toBeNull()
    expect(screen.queryByRole('button', { name: zh['claude.joint.leave'] })).toBeNull()
    expect(screen.queryByLabelText(zh['native.route.new'])).toBeNull()
  })
})
