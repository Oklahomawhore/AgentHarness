// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ScopeAgentContributionInitialization, ScopeAgentLocalContributionStatus } from '@deepseek-ai/dsh-api-remotes/client'
import type { NativeContributionActions } from '../src/client/NativeContributionPanel.tsx'
import { NativeContributionPanel } from './native-contribution-panel-fixture.client.tsx'
import { NativeContributionInitialization } from '../src/client/NativeContributionInitialization.tsx'
import { ContributionSourceSummary } from '../src/client/contribution-ui.tsx'
import { zh } from '../src/client/locales.ts'
import { observation, state } from './native-scope-fixture.client.ts'
import { agentId, applicationEntry, capture, capturedStatus, emptyStatus } from './native-contribution-fixture.client.ts'
import { assigned, binding, localCapture } from './native-local-contribution-fixture.client.ts'

afterEach(cleanup)
const t = makeTranslate(zh)
const local: ScopeAgentLocalContributionStatus = { ...assigned, capture: localCapture,
  initialization: { eligible: true, recordedSamples: 4, unconfirmedSamples: 1 } }
const history = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.initialization.consent'] })
const sharing = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.share.consent'] })
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: zh['native.share.request'] })
const change = (label: string, value: string): void => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function fixture(initial: ScopeAgentLocalContributionStatus | undefined = local, joint = false) {
  const actions: NativeContributionActions = {
    recoverNativeContributionRoute: vi.fn(async () => {}), readNativeContribution: vi.fn(),
    suggestNativeContributionPermission: vi.fn(async () => null),
    requestNativeContribution: vi.fn(async () => {}), stopNativeContribution: vi.fn(async () => {}), leaveNativeJoin: vi.fn(async () => {}),
    previewNativeContribution: vi.fn(async () => joint ? { ...applicationEntry, kind: 'scope-join-entry' as const } : applicationEntry),
    probeNativeContribution: vi.fn(async () => ({ status: 'ready' as const })),
  }
  const props: Parameters<typeof NativeContributionPanel>[0] = { agentId, t, ...actions,
    scope: { phase: 'ready', pending: false, issue: null, observation: observation({ ...state, agentId }) },
    entry: { value: emptyStatus, status: 'ready', pending: false },
    ...(initial === undefined ? {} : { localEntry: { value: initial, status: 'ready', pending: false } }),
  }
  const view = render(<NativeContributionPanel {...props} />)
  fireEvent.click(screen.getByText(zh['native.share.title']))
  const verify = async (entryText = 'entry') => {
    change(zh['native.invitation'], entryText)
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(applicationEntry.ownerPeerId)
  }
  return { ...view, props, actions, verify }
}

describe('recorded native tool consent', () => {
  it('keeps historical initialization and complete-file permission mutually exclusive without upgrading saved records', async () => {
    const f = fixture()
    await f.verify()
    const full = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.fileContent.consent'] })
    expect(full().checked).toBe(false)
    fireEvent.click(history())
    expect(full().disabled).toBe(true)
    expect(full().checked).toBe(false)
    fireEvent.click(history())
    expect(full().disabled).toBe(false)
    fireEvent.click(full())
    expect(history().disabled).toBe(true)
    expect(history().checked).toBe(false)
    expect(screen.getByText(zh['native.fileContent.historyExclusive'])).toBeTruthy()
    fireEvent.click(sharing()); fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const sent = vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0]
    expect(sent?.fileContent).toBe('completed-native-file')
    expect(sent?.initialization).toBeUndefined()
  })

  it('keeps permission blank when the retained local capture has expired', async () => {
    const f = fixture({ ...local, capture: { ...localCapture, collecting: false,
      grant: { ...localCapture.grant, expiresAt: Date.now() - 3_600_000 } } })
    await f.verify()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>(zh['contribution.hours']).value).toBe('')
    expect(sharing().checked).toBe(false)
    expect(history().checked).toBe(false)
    expect(submit().disabled).toBe(true)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('omits historical initialization when the user explicitly unchecks that permission', async () => {
    const f = fixture()
    await f.verify(); fireEvent.click(sharing()); fireEvent.click(history())
    expect(history().checked).toBe(true)
    fireEvent.click(history())
    expect(history().checked).toBe(false)
    expect(sharing().checked).toBe(true)
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0].initialization).toBeUndefined()
  })

  it('prefills permission without granting sharing or historical export, then sends the exact selected local capture and epoch', async () => {
    const f = fixture()
    await f.verify()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('/project')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.share.write'] }).checked).toBe(true)
    expect(history().checked).toBe(false)
    expect(sharing().checked).toBe(false)
    expect(submit().disabled).toBe(true)
    fireEvent.click(history()); fireEvent.click(sharing()); fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0].initialization).toEqual({
      kind: 'recorded-local-tools', expectedLocalCapture: localCapture.selection, localTask: binding,
    })
  })

  it('keeps renewed history permission when independent joint receiving is confirmed after a limit edit', async () => {
    const f = fixture(local, true)
    await f.verify()
    fireEvent.click(sharing()); fireEvent.click(history())
    change(zh['contribution.maxSamples'], '7')
    expect(history().checked).toBe(false)
    expect(sharing().checked).toBe(false)
    change(zh['contribution.maxSamples'], '8')
    fireEvent.click(history())
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.join.readConsent'] }))
    expect(history().checked).toBe(true)
    expect(sharing().checked).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.join.request'] }).disabled).toBe(true)
    fireEvent.click(sharing())
    expect(history().checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['native.join.request'] }))
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0]).toMatchObject({
      initialization: { kind: 'recorded-local-tools', expectedLocalCapture: localCapture.selection, localTask: binding },
      receive: { expectedReadStateSeq: 1 }, limits: { maxSamples: 8 },
    })
  })

  it('retains history consent across sample-only refresh while blocking submission until fresh status arrives', async () => {
    const f = fixture()
    await f.verify(); fireEvent.click(history()); fireEvent.click(sharing())
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ value: local, status: 'loading', pending: false }} />)
    expect(history().checked).toBe(true)
    expect(submit().disabled).toBe(true)
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ value: { ...local, revision: local.revision + 1,
      initialization: { ...local.initialization, recordedSamples: 5 } }, status: 'ready', pending: false }} />)
    expect(history().checked).toBe(true)
    expect(submit().disabled).toBe(false)
    expect(screen.getByText(t('native.initialization.available', { count: 5, unconfirmed: 1, inFlight: 1 }))).toBeTruthy()
  })

  it('clears historical and sharing consent when the main entry changes, including when restored to its earlier content', async () => {
    const f = fixture()
    await f.verify(); fireEvent.click(history()); fireEvent.click(sharing())
    expect(submit().disabled).toBe(false)

    change(zh['native.invitation'], 'another-entry')
    expect(screen.queryByRole('checkbox', { name: zh['native.initialization.consent'] })).toBeNull()
    expect(f.actions.previewNativeContribution).toHaveBeenCalledOnce()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    await f.verify('another-entry')
    expect(history().checked).toBe(false)
    expect(sharing().checked).toBe(false)
    expect(submit().disabled).toBe(true)

    fireEvent.click(history()); fireEvent.click(sharing())
    change(zh['native.invitation'], 'entry')
    expect(screen.queryByRole('checkbox', { name: zh['native.initialization.consent'] })).toBeNull()
    await f.verify()
    expect(history().checked).toBe(false)
    expect(sharing().checked).toBe(false)
    expect(submit().disabled).toBe(true)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it.each(['roots', 'maxSamples', 'maxBytes', 'hours'] as const)('clears historical consent when %s changes and does not restore it when changed back', async (field) => {
    const f = fixture()
    await f.verify(); fireEvent.click(history())
    const input = screen.getByLabelText<HTMLInputElement | HTMLTextAreaElement>(zh[`contribution.${field}`])
    const before = input.value
    fireEvent.change(input, { target: { value: field === 'roots' ? '/other' : '3' } })
    expect(history().checked).toBe(false)
    fireEvent.change(input, { target: { value: before } })
    expect(history().checked).toBe(false)
  })

  it('clears history consent on tool, entry, capture, or task epoch changes', async () => {
    const f = fixture()
    await f.verify(); fireEvent.click(history())
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.edit'] }))
    expect(history().checked).toBe(false)
    fireEvent.click(history())
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ value: { ...local,
      assignment: { ...binding, expectedBindingEpoch: { ...binding.expectedBindingEpoch, seq: 5 } } }, status: 'ready', pending: false }} />)
    expect(history().checked).toBe(false)
    fireEvent.click(history())
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ value: local, status: 'ready', pending: false }} />)
    expect(history().checked).toBe(false)
    fireEvent.click(history())
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ value: { ...local, capture: null,
      initialization: { eligible: false, recordedSamples: 0, unconfirmedSamples: 0 } }, status: 'ready', pending: false }} />)
    expect(history().checked).toBe(false)
    expect(history().disabled).toBe(true)
    f.rerender(<NativeContributionPanel {...f.props} />)
    fireEvent.click(history()); await f.verify()
    expect(history().checked).toBe(false)
  })

  it('preserves user-edited scope when local status arrives and permits normal joining without historical consent', async () => {
    const f = fixture({ ...assigned, capture: null })
    await f.verify()
    expect(history().disabled).toBe(true)
    change(zh['contribution.roots'], '/chosen'); change(zh['contribution.hours'], '2')
    change(zh['contribution.maxSamples'], '2'); change(zh['contribution.maxBytes'], '2048')
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.edit'] }))
    f.rerender(<NativeContributionPanel {...f.props} localEntry={{ value: local, status: 'ready', pending: false }} />)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('/chosen')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.share.write'] }).checked).toBe(false)
    expect(history().checked).toBe(false)
    fireEvent.click(sharing()); fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls[0]?.[0].initialization).toBeUndefined()
  })

  it('allows retained history after collection budget exhaustion and keeps an uncertain request single-flight', async () => {
    const f = fixture({ ...local, capture: { ...localCapture, collecting: false, collectionIssue: 'sample-limit' } })
    const held = Promise.withResolvers<undefined>()
    vi.mocked(f.actions.requestNativeContribution).mockReturnValue(held.promise)
    await f.verify()
    expect(history().disabled).toBe(false)
    fireEvent.click(history()); fireEvent.click(sharing()); fireEvent.click(submit()); fireEvent.click(submit())
    expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce()
    await act(async () => { held.resolve(undefined); await held.promise })
  })
})

const initialization: ScopeAgentContributionInitialization = {
  state: 'frozen', request: { kind: 'recorded-local-tools', expectedLocalCapture: localCapture.selection, localTask: binding },
  cutoff: { localSequence: 4, sessionSeq: 20 as SessionSeq },
  coverage: { recorded: 4, selected: 3, omitted: 1, unconfirmed: 1, inFlight: 1, acknowledged: 2 }, reason: null,
}
describe('recorded work coverage', () => {
  it('makes the requested full-content scope visible in the owner permission summary', () => {
    render(<dl><ContributionSourceSummary source={{ kind: 'tool-observations', name: 'Completed native file work',
      tools: ['Edit'], version: 3, fileContent: 'completed-native-file' }} t={t} /></dl>)
    expect(screen.getByText(zh['native.fileContent.scope'])).toBeTruthy()
    expect(screen.getByText(zh['native.fileContent.complete'])).toBeTruthy()
    expect(screen.queryByText(zh['contribution.recordedTools'])).toBeNull()
  })

  it('shows frozen historical selection and owner receipts on the retained capture panel', () => {
    const f = fixture()
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false,
      value: { ...capturedStatus, capture: { ...capture, initialization, state: 'active', collecting: true,
        proposal: { ...capture.proposal, source: { kind: 'tool-observations', name: 'Recorded native work',
          tools: ['Write'], version: 2, initialization: 'recorded-local-tools' } } } } }} />)
    expect(screen.getByText(t('native.initialization.delivery', { count: 3, acknowledged: 2 }))).toBeTruthy()
    expect(screen.getByText(t('native.initialization.coverage', {
      recorded: 4, selected: 3, omitted: 1, unconfirmed: 1, inFlight: 1,
    }))).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: zh['native.initialization.consent'] })).toBeNull()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('distinguishes selection, actual owner receipt, empty coverage, and unavailable initialization', () => {
    const view = render(<NativeContributionInitialization value={initialization} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(t('native.initialization.delivery', { count: 3, acknowledged: 2 }))
    expect(screen.getByText(t('native.initialization.coverage', { recorded: 4, selected: 3, omitted: 1, unconfirmed: 1, inFlight: 1 }))).toBeTruthy()
    view.rerender(<NativeContributionInitialization value={{ ...initialization, state: 'pending', cutoff: null }} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(zh['native.initialization.pending'])
    view.rerender(<NativeContributionInitialization value={{ ...initialization,
      coverage: { ...initialization.coverage, acknowledged: 3 } }} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(t('native.initialization.complete', { count: 3 }))
    view.rerender(<NativeContributionInitialization value={{ ...initialization,
      coverage: { recorded: 0, selected: 0, omitted: 0, unconfirmed: 0, inFlight: 0, acknowledged: 0 } }} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(zh['native.initialization.empty'])
    view.rerender(<NativeContributionInitialization value={{ ...initialization, state: 'unavailable', reason: 'source-changed' }} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(zh['native.initialization.stopped'])
    expect(screen.getByText(zh['native.initialization.reason.source-changed'])).toBeTruthy()
  })

  it('shows the same explicit historical permission in pending owner proposals and approved grant summaries', () => {
    const source = { kind: 'tool-observations' as const, name: 'Recorded native work', tools: ['Write' as const],
      version: 2 as const, initialization: 'recorded-local-tools' as const }
    const view = render(<dl><ContributionSourceSummary source={source} t={t} /></dl>)
    expect(screen.getByText(zh['contribution.recordedTools'])).toBeTruthy()
    view.rerender(<dl><ContributionSourceSummary source={localCapture.grant.source} t={t} /></dl>)
    expect(screen.queryByText(zh['contribution.recordedTools'])).toBeNull()
  })
})
