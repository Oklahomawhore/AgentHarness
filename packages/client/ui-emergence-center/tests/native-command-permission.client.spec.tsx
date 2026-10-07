// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeAgentContributionCapture, ScopeContributionTransfer } from '@deepseek-ai/dsh-api-remotes/client'
import { NativeContributionPanel } from './native-contribution-panel-fixture.client.tsx'
import type { NativeContributionActions } from '../src/client/NativeContributionPanel.tsx'
import { NativeLocalContributionPanel, type NativeLocalContributionActions } from '../src/client/NativeLocalContributionPanel.tsx'
import { OwnerContributionApplications } from '../src/client/OwnerContributionApplications.tsx'
import { ContributionSourceSummary } from '../src/client/contribution-ui.tsx'
import { nativeCommandSelectors, emptyNativeCommands } from '../src/client/NativeCommandPermission.tsx'
import { assigned, binding, localCapture, tasks } from './native-local-contribution-fixture.client.ts'
import { agentId, applicationEntry, capture, emptyStatus } from './native-contribution-fixture.client.ts'
import { observation, state } from './native-scope-fixture.client.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
const command = 'node verify.mjs --label "exact spacing"\nprintf done'
const selectors = [{ command, rootIndex: 1 }]
const source = { kind: 'tool-observations', version: 4, name: 'Permitted work', tools: ['Write'], commands: selectors,
  fileContent: 'completed-native-file' } satisfies ScopeAgentContributionCapture['proposal']['source']
afterEach(cleanup)
const check = (key: keyof typeof zh): HTMLInputElement => screen.getByRole('checkbox', { name: zh[key] })
function change(key: keyof typeof zh, value: string): void {
  fireEvent.change(screen.getByLabelText(zh[key]), { target: { value } })
}
function fields(): void {
  change('contribution.roots', '/project\n/project/checks')
  change('contribution.hours', '2'); change('contribution.maxSamples', '8'); change('contribution.maxBytes', '4096')
}
function commands(rootIndex = '1'): void {
  fireEvent.click(check('native.commands.consent'))
  change('native.commands.command', command)
  change('native.commands.cwd', rootIndex)
}
function remote() {
  const actions: NativeContributionActions = {
    readNativeContribution: vi.fn(), recoverNativeContributionRoute: vi.fn(async () => {}),
    suggestNativeContributionPermission: vi.fn(async () => null), requestNativeContribution: vi.fn(async () => {}),
    stopNativeContribution: vi.fn(async () => {}), leaveNativeJoin: vi.fn(async () => {}),
    previewNativeContribution: vi.fn(async (): Promise<ScopeContributionTransfer> => applicationEntry),
    probeNativeContribution: vi.fn(async () => ({ status: 'ready' as const })),
  }
  const props = { agentId, t, ...actions,
    scope: { phase: 'ready' as const, pending: false, issue: null, observation: observation({ ...state, agentId }) },
    entry: { status: 'ready' as const, pending: false, value: emptyStatus },
    localEntry: { status: 'ready' as const, pending: false, value: assigned } }
  return { ...render(<NativeContributionPanel {...props} />), props, actions }
}
async function openRemote(): Promise<void> {
  change('native.invitation', 'entry')
  fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
  await screen.findByText(applicationEntry.ownerPeerId)
  fields()
}
function local() {
  const actions: NativeLocalContributionActions = {
    readNativeLocalContribution: vi.fn(), suggestNativeContributionPermission: vi.fn(async () => null),
    checkoutNativeLocalTask: vi.fn(async () => {}), requestNativeLocalContribution: vi.fn(async () => {}),
    stopNativeLocalContribution: vi.fn(async () => {}),
  }
  const props = { agentId, tasks, catalogReady: true, receivingElsewhere: false, t, ...actions,
    scope: { phase: 'ready' as const, pending: false, issue: null, observation: null }, actScope: vi.fn(async () => false),
    entry: { status: 'ready' as const, pending: false, value: assigned } }
  return { ...render(<NativeLocalContributionPanel {...props} />), props, actions }
}

describe('native foreground command-result permission', () => {
  it.each([false, true])('submits exact remote commands with file sharing=%s only after separate confirmation', async (files) => {
    const f = remote()
    await openRemote()
    expect(check('native.commands.consent').checked).toBe(false)
    expect(screen.queryByLabelText(zh['native.commands.command'])).toBeNull()
    if (files) fireEvent.click(check('native.share.write'))
    commands()
    expect(check('native.fileContent.consent').disabled).toBe(!files)
    if (files) fireEvent.click(check('native.fileContent.consent'))
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.request'] })
    expect(submit.disabled).toBe(true)
    fireEvent.click(check('native.commands.remoteConsent'))
    fireEvent.click(submit)
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const sent = vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0]
    expect(sent).toMatchObject({ agentId, roots: ['/project', '/project/checks'],
      tools: files ? ['write'] : [], commands: selectors })
    expect(sent?.fileContent).toBe(files ? 'completed-native-file' : undefined)
    expect(sent?.receive).toBeUndefined()
    expect(sent?.initialization).toBeUndefined()
  })

  it('keeps incomplete and duplicate selections unsubmitted and allows editing a second command', async () => {
    const f = remote()
    await openRemote()
    fireEvent.click(check('native.commands.consent'))
    fireEvent.click(check('native.commands.remoteConsent'))
    const submit = (): HTMLButtonElement => screen.getByRole('button', { name: zh['native.share.request'] })
    expect(submit().disabled).toBe(true)
    change('native.commands.command', command)
    expect(check('native.commands.remoteConsent').checked).toBe(false)
    change('native.commands.cwd', '1')
    fireEvent.click(screen.getByRole('button', { name: zh['native.commands.add'] }))
    const inputs = screen.getAllByLabelText<HTMLTextAreaElement>(zh['native.commands.command'])
    const directories = screen.getAllByLabelText<HTMLSelectElement>(zh['native.commands.cwd'])
    fireEvent.change(inputs[1]!, { target: { value: command } })
    fireEvent.change(directories[1]!, { target: { value: '1' } })
    fireEvent.click(check('native.commands.remoteConsent'))
    expect(submit().disabled).toBe(true)
    fireEvent.change(inputs[1]!, { target: { value: 'node second.mjs' } })
    fireEvent.click(check('native.commands.remoteConsent'))
    expect(submit().disabled).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: zh['native.commands.remove'] })[1]!)
    expect(check('native.commands.remoteConsent').checked).toBe(false)
    fireEvent.click(check('native.commands.remoteConsent'))
    fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0].commands).toEqual(selectors)
  })

  it('clears selected directory and command consent when roots change without silently renumbering duplicates', async () => {
    const f = remote()
    await openRemote(); commands()
    change('contribution.roots', '/project\n/project')
    expect(check('native.commands.consent').checked).toBe(false)
    fireEvent.click(check('native.commands.consent'))
    expect(screen.getByLabelText<HTMLSelectElement>(zh['native.commands.cwd']).value).toBe('')
    change('native.commands.cwd', '1')
    fireEvent.click(check('native.commands.remoteConsent'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.request'] }).disabled).toBe(true)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('retains edited commands on ordinary refresh but clears opt-in on a new entry and local assignment', async () => {
    const f = remote()
    await openRemote(); commands()
    fireEvent.click(check('native.commands.remoteConsent'))
    f.rerender(<NativeContributionPanel {...f.props} entry={{ ...f.props.entry, value: { ...emptyStatus, revision: 1 } }} />)
    expect(check('native.commands.consent').checked).toBe(true)
    expect(check('native.commands.remoteConsent').checked).toBe(true)
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ ...f.props.localEntry,
      value: { ...assigned, assignment: { ...binding, expectedBindingEpoch: { ...binding.expectedBindingEpoch, seq: 5 } } } }} />)
    expect(check('native.commands.consent').checked).toBe(false)
    commands()
    change('native.invitation', 'new-entry')
    expect(screen.queryByRole('checkbox', { name: zh['native.commands.consent'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(applicationEntry.ownerPeerId)
    expect(check('native.commands.consent').checked).toBe(false)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('applies workspace suggestions without guessing commands or preserving command permission', async () => {
    const f = remote()
    await openRemote(); commands()
    fireEvent.click(check('native.commands.remoteConsent'))
    vi.mocked(f.actions.suggestNativeContributionPermission).mockResolvedValue({
      agentId, roots: ['/suggested'], tools: ['edit'], durationHours: 8, maxSamples: 100, maxSampleBytes: 8192,
    })
    fireEvent.click(screen.getByRole('button', { name: zh['native.suggestion.use'] }))
    await waitFor(() => { expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('/suggested') })
    expect(check('native.commands.consent').checked).toBe(false)
    expect(check('native.share.consent').checked).toBe(false)
    fireEvent.click(check('native.commands.consent'))
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.commands.command']).value).toBe('')
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('does not combine command-result permission with recorded file initialization', async () => {
    const f = remote()
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ ...f.props.localEntry,
      value: { ...assigned, capture: localCapture, initialization: { eligible: true, recordedSamples: 2, unconfirmedSamples: 0 } } }} />)
    await openRemote()
    fireEvent.click(check('native.initialization.consent'))
    expect(check('native.commands.consent').disabled).toBe(true)
    fireEvent.click(check('native.initialization.consent'))
    commands()
    expect(check('native.initialization.consent').disabled).toBe(true)
    expect(check('native.initialization.consent').checked).toBe(false)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('allows local commands alone while preserving the exact Task assignment and clearing consent after edits', async () => {
    const f = local()
    fields(); commands()
    fireEvent.click(check('native.commands.localConsent'))
    change('native.commands.command', 'node local.mjs')
    expect(check('native.commands.localConsent').checked).toBe(false)
    fireEvent.click(check('native.commands.localConsent'))
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.enable'] }))
    await waitFor(() => { expect(f.actions.requestNativeLocalContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeLocalContribution).mock.calls[0]?.[0]).toMatchObject({ ...binding,
      roots: ['/project', '/project/checks'], tools: [], commands: [{ command: 'node local.mjs', rootIndex: 1 }] })
    expect(f.actions.checkoutNativeLocalTask).not.toHaveBeenCalled()
  })

  it('keeps local suggestions and assignment changes separate from command permission', async () => {
    const f = local()
    fields(); commands()
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...assigned, revision: 2 } }} />)
    expect(check('native.commands.consent').checked).toBe(true)
    vi.mocked(f.actions.suggestNativeContributionPermission).mockResolvedValue({
      agentId, roots: ['/suggested'], tools: ['write'], durationHours: 8, maxSamples: 100, maxSampleBytes: 8192,
    })
    fireEvent.click(screen.getByRole('button', { name: zh['native.suggestion.use'] }))
    await waitFor(() => { expect(check('native.commands.consent').checked).toBe(false) })
    commands('0')
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...assigned, assignment: { ...binding, expectedBindingEpoch: { ...binding.expectedBindingEpoch, seq: 5 } } } }} />)
    expect(check('native.commands.consent').checked).toBe(false)
    expect(f.actions.requestNativeLocalContribution).not.toHaveBeenCalled()
  })

  it('shows exact command identities in owner approval without source-local directory paths', () => {
    render(<dl><ContributionSourceSummary source={source} t={t} /></dl>)
    expect(screen.getByText(command, { collapseWhitespace: false }).textContent).toBe(command)
    expect(screen.getByText(t('native.commands.root', { index: 2 }), { exact: false })).toBeTruthy()
    expect(screen.getByText(zh['native.fileContent.complete'])).toBeTruthy()
    expect(document.body.textContent).not.toContain('/project')
  })


  it('approves the displayed command-only joint source without describing it as file-only permission', () => {
    const commandOnly = { kind: 'tool-observations' as const, version: 4 as const, name: source.name,
      tools: [], commands: selectors }
    const expectedProposal = { ...capture.proposal, source: commandOnly }
    const approve = vi.fn(async () => {})
    render(<OwnerContributionApplications taskId={applicationEntry.taskId} ownerAddress={applicationEntry.ownerAddress}
      pending={false} groups={[]} t={t} applications={{ nextEntryId: null, entries: [{
        entry: { ...applicationEntry, kind: 'scope-join-entry' }, text: 'joint-entry', proposal: expectedProposal,
        limits: capture.limits, result: { status: 'pending' },
      }] }} createContributionEntry={vi.fn()} createGroupEntry={vi.fn()} closeGroupEntry={vi.fn()}
      recoverContributionEntry={vi.fn()} approveContributionApplication={approve} rejectContributionApplication={vi.fn()} />)
    expect(screen.queryByRole('button', { name: zh['contribution.join.approve'] })).toBeNull()
    change('contribution.join.responsibility', 'Review the permitted checks.')
    fireEvent.click(screen.getByRole('button', { name: zh['native.commands.approve'] }))
    expect(approve).toHaveBeenCalledExactlyOnceWith(applicationEntry.taskId, {
      entryId: applicationEntry.entryId, expectedProposal, limits: capture.limits,
      ownerAddress: applicationEntry.ownerAddress, read: { responsibility: 'Review the permitted checks.' },
    })
  })

  it('shows a mixed local capture and stops its exact identity without leaving the Task', async () => {
    const f = local()
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry, value: { ...assigned,
      capture: { ...localCapture, commands: selectors, grant: { ...localCapture.grant, source } } } }} />)
    expect(screen.getByText(command, { collapseWhitespace: false })).toBeTruthy()
    expect(screen.getByText(zh['native.commands.stopHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.stop'] }))
    await waitFor(() => { expect(f.actions.stopNativeLocalContribution).toHaveBeenCalledExactlyOnceWith({
      agentId, expectedCapture: localCapture.selection,
    }) })
    expect(f.actions.checkoutNativeLocalTask).not.toHaveBeenCalled()
  })

  it('shows remote command permission and keeps stop distinct from joint leave', async () => {
    const f = remote()
    f.rerender(<NativeContributionPanel {...f.props} entry={{ ...f.props.entry, value: { ...emptyStatus,
      capture: { ...capture, commands: selectors, proposal: { ...capture.proposal, source } } } }} />)
    expect(screen.getByText(command, { collapseWhitespace: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.stop'] }))
    await act(async () => {})
    expect(f.actions.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })

  it('resolves no permission for an unchecked draft and rejects incomplete form selections', () => {
    expect(nativeCommandSelectors(emptyNativeCommands(), [])).toBeUndefined()
    expect(nativeCommandSelectors({ enabled: true, selectors: [] }, ['/project'])).toBeNull()
    for (const rootIndex of ['', '1', '-1', '0.5']) {
      expect(nativeCommandSelectors({ enabled: true, selectors: [{ command: 'node verify.mjs', rootIndex }] }, ['/project'])).toBeNull()
    }
  })
})
