// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeAgentContributionCapture, ScopeContributionInvitation, ScopeContributionTransfer } from '@deepseek-ai/dsh-api-remotes/client'
import { NativeContributionPanel } from './native-contribution-panel-fixture.client.tsx'
import type { NativeContributionActions } from '../src/client/NativeContributionPanel.tsx'
import { NativeLocalContributionPanel, type NativeLocalContributionActions } from '../src/client/NativeLocalContributionPanel.tsx'
import { OwnerContributionApplications } from '../src/client/OwnerContributionApplications.tsx'
import { ContributionSourceSummary } from '../src/client/contribution-ui.tsx'
import { assigned, binding, tasks } from './native-local-contribution-fixture.client.ts'
import { agentId, applicationEntry, capture, emptyStatus } from './native-contribution-fixture.client.ts'
import { observation, state } from './native-scope-fixture.client.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
const entry = { ...applicationEntry, sourceKind: 'native-work' as const }
const source = { kind: 'native-work', version: 6, name: 'Combined permission', tools: ['Write'],
  commands: [{ command: 'node verify.mjs', rootIndex: 0 }], completedTurns: true,
} satisfies ScopeAgentContributionCapture['proposal']['source']
afterEach(cleanup)
const check = (key: keyof typeof zh): HTMLInputElement => screen.getByRole('checkbox', { name: zh[key] })
function change(key: keyof typeof zh, value: string): void {
  fireEvent.change(screen.getByLabelText(zh[key]), { target: { value } })
}
function limits(): void {
  change('contribution.hours', '1'); change('contribution.maxSamples', '8'); change('contribution.maxBytes', '8192')
}
function remote() {
  const actions: NativeContributionActions = {
    readNativeContribution: vi.fn(), recoverNativeContributionRoute: vi.fn(async () => {}),
    suggestNativeContributionPermission: vi.fn(async () => null), requestNativeContribution: vi.fn(async () => {}),
    stopNativeContribution: vi.fn(async () => {}), leaveNativeJoin: vi.fn(async () => {}),
    previewNativeContribution: vi.fn(async (): Promise<ScopeContributionTransfer> => entry),
    probeNativeContribution: vi.fn(async () => ({ status: 'ready' as const })),
  }
  const props = { agentId, t, ...actions,
    scope: { phase: 'ready' as const, pending: false, issue: null, observation: observation({ ...state, agentId }) },
    entry: { status: 'ready' as const, pending: false, value: emptyStatus },
    localEntry: { status: 'ready' as const, pending: false, value: assigned } }
  return { ...render(<NativeContributionPanel {...props} />), props, actions }
}
function local() {
  const actions: NativeLocalContributionActions = {
    readNativeLocalContribution: vi.fn(), suggestNativeContributionPermission: vi.fn(async () => null),
    checkoutNativeLocalTask: vi.fn(async () => {}), requestNativeLocalContribution: vi.fn(async () => {}),
    stopNativeLocalContribution: vi.fn(async () => {}),
  }
  render(<NativeLocalContributionPanel agentId={agentId} tasks={tasks} catalogReady receivingElsewhere={false} t={t}
    {...actions} scope={{ phase: 'ready', pending: false, issue: null, observation: null }} actScope={vi.fn(async () => false)}
    entry={{ status: 'ready', pending: false, value: assigned }} />)
  return actions
}
async function open(): Promise<void> {
  change('native.invitation', 'combined-entry')
  fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
  await screen.findByText(entry.ownerPeerId)
  limits()
}

describe('same-Session combined source permission', () => {
  it('submits complete future file contents only with the combined source permission explicitly confirmed', async () => {
    const f = remote(); await open()
    change('contribution.roots', '/project')
    fireEvent.click(check('native.share.write'))
    fireEvent.click(check('native.fileContent.consent'))
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.request'] })
    expect(submit.disabled).toBe(true)
    fireEvent.click(check('native.work.remoteConsent'))
    fireEvent.click(submit)
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0]).toMatchObject({
      sourceKind: 'native-work', agentId, expectedCapture: null, entry, roots: ['/project'], tools: ['write'],
      commands: [], completedTurns: false, fileContent: 'completed-native-file',
    })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0].initialization).toBeUndefined()
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })

  it.each([false, true])('sends exactly selected categories with final answers=%s in one request', async (answers) => {
    const f = remote(); await open()
    for (const key of ['native.share.write', 'native.share.edit', 'native.commands.consent', 'native.work.completedTurns'] as const) {
      expect(check(key).checked).toBe(false)
    }
    expect(screen.queryByRole('checkbox', { name: zh['native.initialization.consent'] })).toBeNull()
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.request'] })
    fireEvent.click(check('native.work.remoteConsent'))
    expect(submit.disabled).toBe(true)
    change('contribution.roots', '/project')
    fireEvent.click(check('native.share.write'))
    fireEvent.click(check('native.commands.consent'))
    change('native.commands.command', 'node verify.mjs'); change('native.commands.cwd', '0')
    if (answers) fireEvent.click(check('native.work.completedTurns'))
    expect(check('native.work.remoteConsent').checked).toBe(false)
    fireEvent.click(check('native.work.remoteConsent'))
    fireEvent.click(submit)
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const request = vi.mocked(f.actions.requestNativeContribution).mock.calls[0]![0]
    expect(request).toMatchObject({ sourceKind: 'native-work', agentId, expectedCapture: null,
      entry, roots: ['/project'], tools: ['write'], commands: source.commands, completedTurns: answers })
    expect(request.initialization).toBeUndefined()
    expect(request.receive).toBeUndefined()
  })

  it('allows explicitly selected answers alone without acquiring roots or file permissions and clears consent after edits', async () => {
    const f = remote(); await open()
    change('contribution.roots', '/unused')
    fireEvent.click(check('native.work.completedTurns')); fireEvent.click(check('native.work.remoteConsent'))
    change('contribution.maxSamples', '9')
    expect(check('native.work.remoteConsent').checked).toBe(false)
    fireEvent.click(check('native.work.remoteConsent'))
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.request'] }))
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]![0]).toMatchObject({
      sourceKind: 'native-work', roots: [], tools: [], commands: [], completedTurns: true,
    })
    change('native.invitation', 'replacement-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(entry.ownerPeerId)
    expect(check('native.work.completedTurns').checked).toBe(false)
  })

  it.each(['local', 'remote'] as const)('requires fresh %s consent when complete-file sharing changes', async (route) => {
    if (route === 'remote') { remote(); await open() } else { local(); change('contribution.sourceKind', 'native-work'); limits() }
    change('contribution.roots', '/project')
    fireEvent.click(check('native.share.write')); fireEvent.click(check('native.work.completedTurns'))
    const consent = route === 'remote' ? 'native.work.remoteConsent' : 'native.work.localConsent'
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh[route === 'remote' ? 'native.share.request' : 'native.local.enable'] })
    fireEvent.click(check(consent))
    expect(submit.disabled).toBe(false)
    fireEvent.click(check('native.fileContent.consent'))
    expect(check('native.fileContent.consent').checked).toBe(true)
    expect(check(consent).checked).toBe(false)
    expect(submit.disabled).toBe(true)
    fireEvent.click(check(consent))
    expect(submit.disabled).toBe(false)
    fireEvent.click(check('native.fileContent.consent'))
    expect(check(consent).checked).toBe(false)
    expect(submit.disabled).toBe(true)
  })

  it.each([false, true])('keeps the retained answer selection=%s immutable when stopping combined work', async (answers) => {
    const f = remote()
    const proposal = { ...capture.proposal, source: { ...source, completedTurns: answers } }
    const combined: ScopeAgentContributionCapture = { ...capture, sourceKind: 'native-work', entry,
      tools: ['write'], commands: source.commands, completedTurns: answers,
      proposal, state: 'active', collecting: true, application: null,
      invitation: { version: 1, kind: 'native-work-contribution', ownerAddress: entry.ownerAddress,
        grant: { version: 1, ...proposal, ...capture.limits, taskId: entry.taskId, ownerPeerId: entry.ownerPeerId,
          grantId: 'native-work-grant' as ScopeContributionInvitation['grant']['grantId'],
          generation: 'native-work-generation' as ScopeContributionInvitation['grant']['generation'] } } }
    f.rerender(<NativeContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...emptyStatus, capture: combined } }} />)
    expect(screen.getByText(zh['native.work.stopHint'])).toBeTruthy()
    for (const label of screen.getAllByText(zh['native.work.completedTurns'])) {
      expect(label.nextElementSibling?.textContent).toBe(zh[answers ? 'native.work.selected' : 'native.work.notSelected'])
    }
    expect(screen.queryByRole('checkbox', { name: zh['native.work.completedTurns'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.stop'] }))
    await waitFor(() => { expect(f.actions.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({
      agentId, expectedCapture: capture.selection,
    }) })
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })

  it.each([zh, en])('describes leaving every selected category while preserving the legacy file-only hint', (dictionary) => {
    const f = remote()
    const receiving = { state: 'waiting' as const, invitation: null,
      adoptionId: 'adoption-a' as NonNullable<ScopeAgentContributionCapture['receiving']>['adoptionId'] }
    const combined = { ...capture, sourceKind: 'native-work' as const,
      entry: { ...entry, kind: 'scope-join-entry' as const }, commands: source.commands, completedTurns: true,
      proposal: { ...capture.proposal, source }, receiving }
    const props = { ...f.props, t: makeTranslate(dictionary) }
    f.rerender(<NativeContributionPanel {...props} entry={{ ...f.props.entry,
      value: { ...emptyStatus, capture: combined } }} />)
    expect(screen.getByText(dictionary['native.work.leaveHint'])).toBeTruthy()
    expect(screen.queryByText(dictionary['native.join.leaveHint'])).toBeNull()
    f.rerender(<NativeContributionPanel {...props} entry={{ ...f.props.entry, value: {
      ...emptyStatus, receivingContinuation: { routeRevision: 0, selection: capture.selection,
        entry: combined.entry, intent: 'leave', receiving },
    } }} />)
    expect(screen.getByText(dictionary['native.work.leaveHint'])).toBeTruthy()
    f.rerender(<NativeContributionPanel {...props} entry={{ ...f.props.entry,
      value: { ...emptyStatus, capture: { ...capture, receiving } } }} />)
    expect(screen.getByText(dictionary['native.join.leaveHint'])).toBeTruthy()
    expect(screen.queryByText(dictionary['native.work.leaveHint'])).toBeNull()
  })

  it('submits a local combined permission against the original assignment and never enables final answers by changing source mode', async () => {
    const actions = local()
    change('contribution.sourceKind', 'native-work'); limits()
    expect(check('native.work.completedTurns').checked).toBe(false)
    fireEvent.click(check('native.work.completedTurns')); fireEvent.click(check('native.work.localConsent'))
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.enable'] }))
    await waitFor(() => { expect(actions.requestNativeLocalContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(actions.requestNativeLocalContribution).mock.calls[0]![0]).toMatchObject({
      ...binding, sourceKind: 'native-work', roots: [], tools: [], commands: [], completedTurns: true,
    })
    expect(actions.checkoutNativeLocalTask).not.toHaveBeenCalled()
  })

  it.each([zh, en])('discloses the complete combined source to the owner in each locale', (dictionary) => {
    const translate = makeTranslate(dictionary)
    const expectedProposal = { ...capture.proposal, source }
    const approve = vi.fn(async () => {})
    render(<OwnerContributionApplications taskId={entry.taskId} ownerAddress={entry.ownerAddress} pending={false}
      groups={[]} t={translate} applications={{ nextEntryId: null, entries: [{
        entry: { ...entry, kind: 'scope-join-entry' }, text: 'entry', proposal: expectedProposal,
        limits: capture.limits, result: { status: 'pending' },
      }] }} createContributionEntry={vi.fn()} createGroupEntry={vi.fn()} closeGroupEntry={vi.fn()}
      recoverContributionEntry={vi.fn()} approveContributionApplication={approve} rejectContributionApplication={vi.fn()} />)
    expect(screen.getByText('Write')).toBeTruthy()
    expect(screen.getByText(source.commands[0]!.command)).toBeTruthy()
    expect(screen.getByText(dictionary['native.work.selected'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(dictionary['contribution.join.responsibility']), { target: { value: 'My responsibility' } })
    fireEvent.click(screen.getByRole('button', { name: dictionary['native.work.approve'] }))
    expect(approve).toHaveBeenCalledExactlyOnceWith(entry.taskId, { entryId: entry.entryId,
      expectedProposal, limits: capture.limits, ownerAddress: entry.ownerAddress, read: { responsibility: 'My responsibility' } })
  })

  it.each([zh, en])('marks file and command categories unselected for an answer-only permission', (dictionary) => {
    render(<dl><ContributionSourceSummary source={{ ...source, tools: [], commands: [] }} t={makeTranslate(dictionary)} /></dl>)
    expect(screen.getAllByText(dictionary['native.work.notSelected'])).toHaveLength(2)
    expect(screen.getByText(dictionary['native.work.selected'])).toBeTruthy()
  })

  it('shows an unselected answer category without implying approval', () => {
    render(<dl><ContributionSourceSummary source={{ ...source, completedTurns: false }} t={t} /></dl>)
    expect(screen.getByText(zh['native.work.notSelected'])).toBeTruthy()
  })
})
