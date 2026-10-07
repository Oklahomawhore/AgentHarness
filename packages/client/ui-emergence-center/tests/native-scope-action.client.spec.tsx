// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DevelopmentTaskSnapshot, ScopeContributionEntry, ScopeContributionEntryProbeResult, ScopeContributionTransfer } from '@deepseek-ai/dsh-api-remotes/client'
import { NativeScopeAction, type NativeScopeActionProps } from '../src/client/NativeScopeAction.tsx'
import type { NativeScopeSnapshot } from '../src/client/native-scopes.ts'
import { zh } from '../src/client/locales.ts'
import { compositeExecution, localExecution, localSnapshot, target } from './native-local-automatic-fixture.client.ts'
import { localCapture, assigned as localStatus } from './native-local-contribution-fixture.client.ts'
import { applicationEntry, capturedStatus, capture, emptyStatus } from './native-contribution-fixture.client.ts'
import { bound, invitation, observation, observable, recordedContext, state } from './native-scope-fixture.client.ts'

afterEach(cleanup)
function fixture(initial: NativeScopeSnapshot = { phase: 'ready', pending: false, issue: null, observation: observation() },
  overrides: Partial<NativeScopeActionProps> = {}) {
  const source = observable(initial)
  const action = vi.fn<NativeScopeActionProps['actNativeScope']>().mockResolvedValue(true)
  const refresh = vi.fn()
  const selectView = vi.fn()
  const hooks: Pick<NativeScopeActionProps, 'useNativeContributions' | 'useNativeLocalContributions'> = {
    useNativeContributions: select => select({}), useNativeLocalContributions: select => select({}),
  }
  const props = {
    sessionId: state.agentId, t: makeTranslate(zh), selectView, actNativeScope: action, refreshNativeScope: refresh,
    ...hooks,
    useNativeTasks: () => ({ tasks: [], read: true }), useNativeParticipants: () => ({ read: true }),
    readNativeLocalContribution: vi.fn(), suggestNativeContributionPermission: vi.fn(async () => null), checkoutNativeLocalTask: vi.fn(),
    requestNativeLocalContribution: vi.fn(), stopNativeLocalContribution: vi.fn(),
    recoverNativeContributionRoute: vi.fn(), readNativeContribution: vi.fn(), requestNativeContribution: vi.fn(),
    stopNativeContribution: vi.fn(), leaveNativeJoin: vi.fn(), previewNativeContribution: vi.fn(), probeNativeContribution: vi.fn(),
    useNativeScope: <T,>(select: (value: NativeScopeSnapshot) => T): T => select(useSyncExternalStore(
      listener => source.subscribe(listener), () => source.getSnapshot())),
    ...overrides,
  } as unknown as NativeScopeActionProps
  const view = render(<NativeScopeAction {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh['native.trigger'] }))
  return { ...view, source, props, action, selectView }
}
function paste(text = JSON.stringify(invitation)) {
  fireEvent.change(screen.getByLabelText(zh['native.invitation']), { target: { value: text } })
}
function policy() {
  fireEvent.click(screen.getByRole('radio', { name: zh['native.automatic'] }))
  fireEvent.change(screen.getByLabelText(zh['native.goal']), { target: { value: 'Update the order form' } })
  fireEvent.change(screen.getByLabelText(zh['native.extra']), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText(zh['native.steps']), { target: { value: '4' } })
  fireEvent.change(screen.getByLabelText(zh['native.interval']), { target: { value: '2' } })
}

describe('current Session collaboration action', () => {
  it('shows a passive current recorded summary and removes it during refresh, target switching and leave', () => {
    const current = { ...observation(bound, 14), recordedContext }
    const ready: NativeScopeSnapshot = { phase: 'ready', pending: false, issue: null, observation: current }
    const f = fixture(ready)
    const summary = () => screen.queryByRole('region', { name: zh['native.recorded.title'] })
    expect(summary()).not.toBeNull()
    expect(screen.queryByRole('region', { name: zh['native.activity.title'] })).toBeNull()
    expect(within(screen.getByRole('dialog', { name: zh['native.title'] }))
      .getByText(zh['native.mode.passive'])).not.toBeNull()
    expect(f.action).not.toHaveBeenCalled()
    act(() => { f.source.set({ ...ready, observation: { ...current, state: { ...bound, mode: 'paused',
      automatic: { goal: 'Keep my responsibility', activationLimit: 1, maxStepsPerTurn: 1, minIntervalMs: 0 } } } }) })
    expect(summary()).not.toBeNull()
    act(() => { f.source.set({ ...ready, phase: 'loading' }) })
    expect(summary()).toBeNull()
    act(() => { f.source.set({ ...ready, phase: 'disconnected', observation: null }) })
    expect(summary()).toBeNull()
    act(() => { f.source.set(ready) })
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.local'] }))
    expect(summary()).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.remote'] }))
    expect(summary()).not.toBeNull()
    act(() => { f.source.set({ ...ready, observation: { ...current, recordedContext: null } }) })
    expect(summary()).toBeNull()
    act(() => { f.source.set({ ...ready, observation: observation() }) })
    expect(summary()).toBeNull()
    expect(f.action).not.toHaveBeenCalled()
  })

  it('keeps both file permissions discoverable and preserves the selected destination across local capture changes', async () => {
    const f = fixture(localSnapshot(localExecution))
    const local = { status: 'ready' as const, pending: false, value: { ...localStatus, capture: localCapture } }
    const remote = { status: 'ready' as const, pending: false, value: capturedStatus }
    const props: NativeScopeActionProps = { ...f.props,
      useNativeLocalContributions: select => select({ [state.agentId]: local }),
      useNativeContributions: select => select({ [state.agentId]: remote }),
    }
    f.rerender(<NativeScopeAction {...props} />)
    expect(screen.getByText(zh['native.share.parallel'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.pause'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({ kind: 'pause', expectedBindingId: localExecution.binding?.id }) })
    act(() => { f.source.set(localSnapshot({ ...localExecution, mode: 'paused', pauseReason: 'user' })) })
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.remote'] }))
    fireEvent.click(screen.getByText(zh['native.share.title']))
    expect(screen.getAllByRole('status').map(item => item.textContent).join(' ')).not.toContain(zh['native.mode.enabled'])
    expect(screen.getByText(zh['native.local.scopeAdded'])).not.toBeNull()
    expect(screen.queryByText(zh['native.saved'])).toBeNull()
    expect(screen.queryByText(localExecution.automatic!.goal, { exact: false })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.stop'] }).disabled).toBe(false)
    f.rerender(<NativeScopeAction {...props}
      useNativeLocalContributions={select => select({ [state.agentId]: { ...local, pending: true,
        value: { ...local.value, capture: { ...localCapture, selection: { ...localCapture.selection,
          captureId: 'new-local' as typeof localCapture.selection.captureId } } } } })} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.target.remote'] }).checked).toBe(true)
    const stop = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.stop'] })
    expect(stop.disabled).toBe(false)
    fireEvent.click(stop)
    await waitFor(() => { expect(f.props.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({
      agentId: state.agentId, expectedCapture: capture.selection,
    }) })
    expect(f.props.stopNativeLocalContribution).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
  })

  it('adds direct reading with the displayed local target and manages the combined policy separately', async () => {
    const f = fixture(localSnapshot({ ...localExecution, mode: 'paused' }))
    paste()
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({ kind: 'bind', request: {
      invitation, automatic: null, expectedBindingId: localExecution.binding!.id, localTask: target,
    } }) })
    act(() => { f.source.set(localSnapshot(compositeExecution)) })
    expect(screen.getByText(zh['native.local.scopeAdded'])).not.toBeNull()
    expect(screen.getByText(makeTranslate(zh)('native.local.retainedPolicy', { goal: localExecution.automatic!.goal }))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.leave'] }))
    await waitFor(() => { expect(f.action).toHaveBeenLastCalledWith({ kind: 'leave', expectedBindingId: compositeExecution.binding!.id }) })
    expect(f.props.stopNativeLocalContribution).not.toHaveBeenCalled()
    f.rerender(<NativeScopeAction {...f.props} useNativeLocalContributions={select => select({ [state.agentId]: {
      status: 'ready', pending: false, value: { ...localStatus, capture: localCapture },
    } })} />)
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.local'] }))
    expect(screen.queryByText(zh['native.local.remoteRead'])).toBeNull()
    expect(screen.getByText(zh['native.local.manageShared'])).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.stop'] }).disabled).toBe(false)
  })

  it('labels the owner-local connection and capture without claiming remote membership', () => {
    const f = fixture()
    f.rerender(<NativeScopeAction {...f.props} useNativeLocalContributions={select => select({ [state.agentId]: { status: 'ready', pending: false, value: localStatus } })} />)
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['native.local.trigger.connected'])
    f.rerender(<NativeScopeAction {...f.props}
      useNativeLocalContributions={select => select({
        [state.agentId]: { status: 'ready', pending: false, value: { ...localStatus, capture: localCapture } },
      })} />)
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['native.local.trigger.sharing'])
  })
  it('labels local automatic status separately from ongoing file collection', () => {
    const f = fixture(localSnapshot(localExecution))
    const local = { status: 'ready' as const, pending: false, value: { ...localStatus, capture: localCapture } }
    f.rerender(<NativeScopeAction {...f.props} useNativeLocalContributions={select => select({ [state.agentId]: local })} />)
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['native.mode.enabled'])
    act(() => { f.source.set(localSnapshot({ ...localExecution, mode: 'paused', pauseReason: 'user' })) })
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['native.mode.paused'])
  })
  it('requires renewed automatic consent after a remote invitation or execution binding changes', () => {
    const f = fixture(); paste(); policy()
    paste(JSON.stringify({ ...invitation, responsibility: 'A newly reviewed responsibility' }))
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.passive'] }).checked).toBe(true)
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    paste()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.passive'] }).checked).toBe(true)
    policy()
    act(() => { f.source.set({ ...f.source.getSnapshot(), observation: observation({ ...bound, mode: 'paused' }) }) })
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.automatic'] }).checked).toBe(false)
    expect(f.action).not.toHaveBeenCalled()
  })
  it('accepts the real string-generation invitation in passive mode without authorizing idle work', async () => {
    const f = fixture(); paste()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.passive'] }).checked).toBe(true)
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({ kind: 'bind', request: { invitation, automatic: null, expectedBindingId: null } }) })
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(JSON.stringify(invitation))
    await waitFor(() => { expect(screen.getByText(zh['native.saved'])).not.toBeNull() })
  })
  it('can clear or replace an orphan local permission without reusing its automatic consent', async () => {
    const orphan = localSnapshot({ ...localExecution, mode: 'paused', pauseReason: 'conflict' })
    const live = orphan.observation
    if (live === null || live.eligibility === 'not-live') throw new Error('Live local fixture missing')
    const f = fixture({ ...orphan, observation: { ...live, localTask: null } })
    expect(screen.getByText(zh['native.local.orphanHint'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.clearPermission'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledWith({ kind: 'leave', expectedBindingId: localExecution.binding?.id }) })
    paste()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.passive'] }).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    await waitFor(() => { expect(f.action).toHaveBeenLastCalledWith({ kind: 'bind', request: {
      invitation, automatic: null, expectedBindingId: localExecution.binding?.id,
    } }) })
    act(() => { f.source.set(localSnapshot(localExecution)) })
    expect(screen.queryByRole('button', { name: zh['native.local.clearPermission'] })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(false)
  })
  it('retains malformed drafts and never treats numeric invitation generations as valid', () => {
    const f = fixture(); paste('{broken')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe('{broken')
    paste(JSON.stringify({ ...invitation, generation: 1 }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
    expect(f.action).not.toHaveBeenCalled()
  })
  it('requires explicit local policy and computes the absolute limit from fresh used reservations', async () => {
    const f = fixture({ phase: 'ready', pending: false, issue: null, observation: observation({ ...bound, mode: 'paused', usedBudget: 5, pauseReason: 'budget' }) })
    fireEvent.click(screen.getByRole('radio', { name: zh['native.automatic'] }))
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.goal']).value).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.resume'] }).disabled).toBe(true)
    policy()
    act(() => { f.source.set({ ...f.source.getSnapshot(), observation: observation({ ...bound, mode: 'paused', usedBudget: 6 }, 9) }) })
    fireEvent.click(screen.getByRole('button', { name: zh['native.resume'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledWith({ kind: 'resume', expectedBindingId: bound.binding!.id,
      automatic: { goal: 'Update the order form', activationLimit: 9, maxStepsPerTurn: 4, minIntervalMs: 2000 } }) })
  })
  it('explains a current-evidence capacity pause without resuming automatically', () => {
    const f = fixture({ phase: 'ready', pending: false, issue: null,
      observation: observation({ ...bound, mode: 'paused', pauseReason: 'coverage',
        automatic: { goal: 'Inspect current evidence', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 } }) })
    expect(screen.getByText('当前共享更新超出接收容量，自动启动已暂停。调整共享范围或容量后，再明确恢复。')).not.toBeNull()
    expect(screen.queryByText(zh['native.pause.failed'])).toBeNull()
    expect(f.action).not.toHaveBeenCalled()
  })
  it('rejects overflowing policy arithmetic and keeps goal text through an uncertain outcome', async () => {
    const f = fixture(); f.action.mockResolvedValue(false); paste(); policy()
    fireEvent.change(screen.getByLabelText(zh['native.extra']), { target: { value: '1e30' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh['native.extra']), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledOnce() })
    act(() => { f.source.set({ ...f.source.getSnapshot(), issue: 'unknown' }) })
    expect(screen.getByRole('alert').textContent).toBe(zh['native.error.unknown'])
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.goal']).value).toBe('Update the order form')
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(JSON.stringify(invitation))
  })
  it('single-flights same-frame clicks before pending props arrive', async () => {
    const f = fixture(); paste()
    const pending = Promise.withResolvers<boolean>(); f.action.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    expect(f.action).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(true); await pending.promise })
  })
  it('offers exact-binding pause and leave but never revives a terminal invitation', async () => {
    const f = fixture({ phase: 'ready', pending: false, issue: null, observation: observation({ ...bound, mode: 'enabled' }) })
    fireEvent.click(screen.getByRole('button', { name: zh['native.pause'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledWith({ kind: 'pause', expectedBindingId: bound.binding!.id }) })
    act(() => { f.source.set({ ...f.source.getSnapshot(), observation: { ...observation(bound, 3), subscriptionState: 'revoked' } }) })
    expect(screen.queryByRole('button', { name: zh['native.resume'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.leave'] }))
    await waitFor(() => { expect(f.action).toHaveBeenLastCalledWith({ kind: 'leave', expectedBindingId: bound.binding!.id }) })
  })
  it('keeps disconnected and cold Sessions inert while leaving their drafts editable', () => {
    const f = fixture({ phase: 'ready', pending: false, issue: null, observation: { agentId: state.agentId, eligibility: 'not-live' } })
    paste()
    expect(screen.getByText(zh['native.eligibility.not-live'])).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
    act(() => { f.source.set({ phase: 'disconnected', pending: false, issue: null, observation: null }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
    expect(f.action).not.toHaveBeenCalled()
  })
  it('opens the existing trajectory and dismisses with keyboard focus returned to its trigger', () => {
    const f = fixture()
    fireEvent.click(screen.getByRole('button', { name: zh['native.sources'] }))
    expect(f.selectView).toHaveBeenCalledExactlyOnceWith('trajectory')
    expect(screen.queryByRole('dialog')).toBeNull()
    const trigger = screen.getByRole('button', { name: zh['native.trigger'] })
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
  it('dismisses with Escape after binding removes the focused submit button', async () => {
    const f = fixture(); paste(); policy()
    const submit = screen.getByRole('button', { name: zh['native.bind'] })
    submit.focus()
    fireEvent.click(submit)
    await waitFor(() => { expect(f.action).toHaveBeenCalledOnce() })
    act(() => { f.source.set({ phase: 'ready', pending: false, issue: null, observation: observation({ ...bound, mode: 'enabled' }, 2) }) })
    expect(submit.isConnected).toBe(false)
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['native.trigger'] }))
  })
  it('consumes Escape while open and releases page shortcuts after closing', () => {
    const pageShortcut = vi.fn()
    const overlayShortcut = vi.fn()
    document.body.addEventListener('keydown', pageShortcut)
    document.addEventListener('keydown', overlayShortcut)
    try {
      fixture()
      expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(pageShortcut).not.toHaveBeenCalled()
      expect(overlayShortcut).not.toHaveBeenCalled()
      expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true)
      expect(pageShortcut).toHaveBeenCalledOnce()
      expect(overlayShortcut).toHaveBeenCalledOnce()
    } finally {
      document.body.removeEventListener('keydown', pageShortcut)
      document.removeEventListener('keydown', overlayShortcut)
    }
  })
  it('leaves Escape to the active input composition', () => {
    fixture()
    const invitationInput = screen.getByLabelText(zh['native.invitation'])
    invitationInput.focus()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    fireEvent(invitationInput, escape)
    expect(escape.defaultPrevented).toBe(false)
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(document.activeElement).toBe(invitationInput)
  })
  it('does not carry a prior Session draft or late success into a newly selected Session', async () => {
    const f = fixture(); paste()
    const pending = Promise.withResolvers<boolean>(); f.action.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    f.rerender(<NativeScopeAction {...f.props} sessionId={'session-b' as NativeScopeActionProps['sessionId']} />)
    await act(async () => { pending.resolve(true); await pending.promise })
    fireEvent.click(screen.getByRole('button', { name: zh['native.trigger'] }))
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe('')
    expect(screen.queryByText(zh['native.saved'])).toBeNull()
  })
})

describe('passive receiving failures', () => {
  it.each([localExecution, compositeExecution])('keeps a passive $binding.kind header free of automatic permission', (execution) => {
    const current = { ...execution, mode: 'paused' as const, pauseReason: 'unavailable' as const, automatic: null }
    const f = fixture(localSnapshot(current))
    f.rerender(<NativeScopeAction {...f.props} useNativeLocalContributions={select => select({
      [state.agentId]: { status: 'ready', pending: false, value: localStatus },
    })} />)
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['native.mode.passive'])
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.remote'] }))
    const panel = within(screen.getByRole('dialog', { name: zh['native.title'] }))
    expect(panel.getByRole('status').textContent).toBe(zh[execution.binding?.kind === 'local-task'
      ? 'native.mode.left' : 'native.mode.passive'])
    expect(panel.queryByText(zh['native.mode.paused'])).toBeNull()
    expect(f.action).not.toHaveBeenCalled()
  })

  it.each(['failed', 'unavailable', 'coverage', 'conflict'] as const)('reports %s without implying automatic authority', (reason) => {
    const current = { ...bound, mode: 'paused' as const, pauseReason: reason, automatic: null }
    const f = fixture({ phase: 'ready', pending: false, issue: null, observation: observation(current) })
    const trigger = screen.getByRole('button', { name: zh['native.trigger'] })
    const panel = within(screen.getByRole('dialog', { name: zh['native.title'] }))
    expect(trigger.textContent).toContain(zh['native.mode.passive'])
    expect(panel.getByRole('status').textContent).toBe(zh['native.mode.passive'])
    expect(screen.queryByText(zh['native.mode.paused'])).toBeNull()
    expect(screen.getByText(zh[`native.read.${reason}`])).toBeTruthy()
    expect(screen.queryByText(zh[`native.pause.${reason}`])).toBeNull()
    expect(f.action).not.toHaveBeenCalled()
    act(() => { f.source.set({ phase: 'ready', pending: false, issue: null, observation: observation({ ...current,
      automatic: { goal: 'Maintain the existing task', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 },
    }) }) })
    expect(trigger.textContent).toContain(zh['native.mode.paused'])
    expect(panel.getByRole('status').textContent).toBe(zh['native.mode.paused'])
    expect(screen.getByText(zh[`native.pause.${reason}`])).toBeTruthy()
    expect(screen.queryByText(zh[`native.read.${reason}`])).toBeNull()
  })
})

describe('read route recovery controls', () => {
  it('submits the displayed binding and read-state cursor without changing automatic permission', async () => {
    const current = observation({ ...bound, mode: 'paused', usedBudget: 1, automatic: {
      goal: 'Maintain the client', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 1000,
    } }, 7)
    const f = fixture({ phase: 'ready', pending: false, issue: null, observation: current })
    fireEvent.click(screen.getByText(zh['native.route.title']))
    fireEvent.change(screen.getByLabelText(zh['native.route.new']), { target: { value: ' /ip4/127.0.0.1/tcp/4568/p2p/owner-peer ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.apply'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({ kind: 'updateRoute', request: {
      expectedBindingId: bound.binding!.id, expectedReadStateSeq: current.readStateSeq,
      ownerAddress: '/ip4/127.0.0.1/tcp/4568/p2p/owner-peer',
    } }) })
    act(() => { f.source.set({ phase: 'ready', pending: false, issue: null, observation: observation(current.state, 8) }) })
    fireEvent.click(screen.getByText(zh['native.route.title']))
    expect(screen.getByLabelText<HTMLInputElement>(zh['native.route.new']).value).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.route.apply'] }).disabled).toBe(true)
  })
})


const groupEntry = { ...applicationEntry, version: 2, kind: 'scope-group-entry', maxMembers: 2 } satisfies ScopeContributionEntry
function entranceFixture(entry: ScopeContributionEntry = groupEntry,
  initial: NativeScopeSnapshot = { phase: 'ready', pending: false, issue: null, observation: observation() }) {
  const preview = vi.fn<NativeScopeActionProps['previewNativeContribution']>().mockResolvedValue(entry)
  const probe = vi.fn<NativeScopeActionProps['probeNativeContribution']>().mockResolvedValue({ status: 'ready' })
  const request = vi.fn<NativeScopeActionProps['requestNativeContribution']>().mockResolvedValue(undefined)
  const stop = vi.fn<NativeScopeActionProps['stopNativeContribution']>().mockResolvedValue(undefined)
  const f = fixture(initial, { previewNativeContribution: preview, probeNativeContribution: probe,
    requestNativeContribution: request, stopNativeContribution: stop,
    useNativeContributions: select => select({ [state.agentId]: {
      status: 'ready', pending: false, value: { ...emptyStatus, agentId: state.agentId },
    } }),
  })
  return { ...f, preview, probe, request, stop }
}
function filePermission() {
  fireEvent.change(screen.getByLabelText(zh['contribution.roots']), { target: { value: '/project' } })
  fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.write'] }))
  fireEvent.change(screen.getByLabelText(zh['contribution.hours']), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText(zh['contribution.maxSamples']), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText(zh['contribution.maxBytes']), { target: { value: '4096' } })
  fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
}
const verifyEntry = async () => {
  fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
  await screen.findByText(zh['native.share.probe.ready'])
}

describe('one native collaboration entrance', () => {
  it.each([
    applicationEntry,
    { ...applicationEntry, kind: 'scope-join-entry' } satisfies ScopeContributionEntry,
    groupEntry,
  ])('opens the $kind permission form from the main input without granting either permission', async (entry) => {
    const f = entranceFixture(entry)
    paste(JSON.stringify(entry))
    expect(screen.queryByText(zh['native.invalidInvitation'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.application.paste'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(screen.queryByRole('button', { name: zh['native.bind'] })).toBeNull()
    expect(f.preview).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    const panel = screen.getByText(zh['native.share.title']).closest('details')
    expect(panel?.open).toBe(true)
    fireEvent.click(screen.getByText(zh['native.share.title']))
    expect(panel?.open).toBe(false)
    act(() => { f.source.set({ ...f.source.getSnapshot() }) })
    expect(panel?.open).toBe(false)
    fireEvent.click(screen.getByText(zh['native.share.title']))
    await verifyEntry()
    expect(f.preview).toHaveBeenCalledExactlyOnceWith(JSON.stringify(entry))
    expect(f.probe).toHaveBeenCalledExactlyOnceWith({ entry })
    expect(f.action).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    filePermission()
    if (entry.kind !== 'contribution-entry') {
      const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.join.request'] })
      expect(submit.disabled).toBe(true)
      fireEvent.click(screen.getByRole('checkbox', { name: zh['native.join.readConsent'] }))
      expect(submit.disabled).toBe(false)
      fireEvent.click(submit)
    } else fireEvent.click(screen.getByRole('button', { name: zh['native.share.request'] }))
    await waitFor(() => { expect(f.request).toHaveBeenCalledOnce() })
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({ agentId: state.agentId, entry, roots: ['/project'], tools: ['write'] })
    expect(f.action).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it.each([
    ['{', 'native.invalidInvitation'],
    ['null', 'native.entry.unsupported'],
    ['[]', 'native.entry.unsupported'],
    ['42', 'native.entry.unsupported'],
    [JSON.stringify({ kind: 'tool-contribution' }), 'native.entry.unsupported'],
    [JSON.stringify({ ...applicationEntry, sourceKind: 'openapi' }), 'native.entry.unsupported'],
    [JSON.stringify({ ...applicationEntry, sourceKind: undefined }), 'native.entry.incomplete'],
    [JSON.stringify({ ...applicationEntry, entryId: '' }), 'native.entry.incomplete'],
    [JSON.stringify({ ...groupEntry, version: 1 }), 'native.entry.incomplete'],
    [JSON.stringify({ ...groupEntry, maxMembers: 0 }), 'native.entry.incomplete'],
    [JSON.stringify({ ...invitation, generation: 1 }), 'native.entry.incomplete'],
    [JSON.stringify({ ...invitation, expiresAt: 'tomorrow' }), 'native.entry.incomplete'],
    [JSON.stringify({ ...invitation, expiresAt: -1 }), 'native.entry.incomplete'],
    [JSON.stringify({ ...invitation, expiresAt: 1.5 }), 'native.entry.incomplete'],
  ] as const)('keeps %s editable and distinguishes its diagnostic', (text, key) => {
    const f = entranceFixture()
    paste(text)
    expect(screen.getByRole('alert').textContent).toBe(zh[key])
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(text)
    expect(f.preview).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.action).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    paste(' ')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps consent across ordinary status refresh and resets it when switching between read and group documents', async () => {
    const f = entranceFixture()
    paste(JSON.stringify(groupEntry)); await verifyEntry(); filePermission()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.join.readConsent'] }))
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.join.automaticConsent'] }))
    act(() => { f.source.set({ ...f.source.getSnapshot(), observation: observation() }) })
    for (const key of ['native.share.consent', 'native.join.readConsent', 'native.join.automaticConsent'] as const) {
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh[key] }).checked).toBe(true)
    }
    paste()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(false)
    policy()
    paste(JSON.stringify(groupEntry)); await verifyEntry()
    for (const key of ['native.share.consent', 'native.join.readConsent', 'native.join.automaticConsent'] as const) {
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh[key] }).checked).toBe(false)
    }
    paste()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['native.automatic'] }).checked).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
    expect(f.action).not.toHaveBeenCalled()
  })

  it.each(['preview', 'probe'] as const)('ignores an old %s after changing the main input to a read invitation', async (stage) => {
    const f = entranceFixture()
    const preview = Promise.withResolvers<ScopeContributionTransfer>()
    const probe = Promise.withResolvers<ScopeContributionEntryProbeResult>()
    if (stage === 'preview') f.preview.mockReturnValueOnce(preview.promise)
    else f.probe.mockReturnValueOnce(probe.promise)
    try {
      paste(JSON.stringify(groupEntry))
      fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
      await waitFor(() => { expect(stage === 'preview' ? f.preview : f.probe).toHaveBeenCalledOnce() })
      paste()
    } finally {
      await act(async () => {
        preview.resolve(groupEntry); probe.resolve({ status: 'ready' })
        await Promise.allSettled([preview.promise, probe.promise])
      })
    }
    expect(screen.queryByText(zh['native.share.probe.ready'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(false)
    if (stage === 'preview') expect(f.probe).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.action).not.toHaveBeenCalled()
  })

  it('discards a pending main-input probe when the selected Session changes', async () => {
    const f = entranceFixture()
    const pending = Promise.withResolvers<ScopeContributionEntryProbeResult>()
    f.probe.mockReturnValueOnce(pending.promise)
    try {
      paste(JSON.stringify(groupEntry))
      fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
      await waitFor(() => { expect(f.probe).toHaveBeenCalledOnce() })
      f.rerender(<NativeScopeAction {...f.props} sessionId={'second-session' as typeof state.agentId} />)
      fireEvent.click(screen.getByRole('button', { name: zh['native.trigger'] }))
    } finally {
      await act(async () => { pending.resolve({ status: 'ready' }); await pending.promise })
    }
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe('')
    expect(screen.queryByText(zh['native.share.probe.ready'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(f.request).not.toHaveBeenCalled()
  })

  it('allows an independent read invitation while file contribution remains active', async () => {
    const f = entranceFixture()
    const status = { ...capturedStatus, agentId: state.agentId, capture: { ...capture, state: 'active' as const, collecting: true } }
    f.rerender(<NativeScopeAction {...f.props} useNativeContributions={select => select({ [state.agentId]: {
      status: 'ready', pending: false, value: status,
    } })} />)
    paste()
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({ kind: 'bind', request: {
      invitation, expectedBindingId: null, automatic: null,
    } }) })
    expect(f.request).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    paste(JSON.stringify(groupEntry))
    expect(screen.queryByRole('button', { name: zh['native.share.verify'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['native.join.request'] })).toBeNull()
  })

  it('preserves the current read binding while permitting contribution-only sharing and refusing joint replacement', async () => {
    const f = entranceFixture(applicationEntry, { phase: 'ready', pending: false, issue: null, observation: observation(bound) })
    paste(JSON.stringify(applicationEntry)); await verifyEntry(); filePermission()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.request'] }))
    await waitFor(() => { expect(f.request).toHaveBeenCalledOnce() })
    expect(f.request.mock.calls[0]?.[0].receive).toBeUndefined()
    f.preview.mockResolvedValueOnce(groupEntry)
    paste(JSON.stringify(groupEntry)); await verifyEntry()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.join.readConsent'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.join.request'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.leave'] }).disabled).toBe(false)
    expect(f.action).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.request).toHaveBeenCalledOnce()
  })
})


describe('native entrance permission recovery', () => {
  it.each([
    ['scope-agent/invalid-route', 'native.route.invalidAddress'],
    ['scope-agent/stale-task', 'native.error.changed'],
    ['scope-agent/stale-binding', 'native.error.changed'],
    ['scope-agent/superseded', 'native.error.changed'],
    ['scope-agent/not-live', 'native.eligibility.not-live'],
    ['scope-agent/ineligible', 'native.error.ineligible'],
    ['scope-agent/task-conflict', 'native.eligibility.task-conflict'],
    ['scope-agent/terminal-subscription', 'native.error.terminal'],
    ['scope-agent/budget-exhausted', 'native.error.budget'],
  ] as const)('keeps the pasted entry while explaining %s', (issue, label) => {
    const f = fixture(); paste()
    act(() => { f.source.set({ ...f.source.getSnapshot(), issue }) })
    expect(screen.getByRole('alert').textContent).toBe(zh[label])
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(JSON.stringify(invitation))
    expect(f.action).not.toHaveBeenCalled()
  })

  it('resumes only the remaining permission on the exact current read binding', async () => {
    const automatic = { goal: 'Continue my approved responsibility', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 0 }
    const f = fixture({ phase: 'ready', pending: false, issue: null,
      observation: observation({ ...bound, mode: 'paused', automatic, usedBudget: 1, pauseReason: 'user' }) })
    fireEvent.click(screen.getByRole('button', { name: makeTranslate(zh)('native.resumeRemaining', { count: 2 }) }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({
      kind: 'resume', expectedBindingId: bound.binding?.id, automatic,
    }) })
    expect(screen.getByText(makeTranslate(zh)('native.currentGoal', { goal: automatic.goal }))).not.toBeNull()
  })

  it('drops optional automatic work when the user chooses passive reading', async () => {
    const f = fixture(); paste(); policy()
    fireEvent.click(screen.getByRole('radio', { name: zh['native.passive'] }))
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.bind'] }))
    await waitFor(() => { expect(f.action).toHaveBeenCalledExactlyOnceWith({ kind: 'bind', request: {
      invitation, expectedBindingId: null, automatic: null,
    } }) })
  })

  it('rejects submitted forms with missing permission or an uncertain current observation', () => {
    const f = fixture()
    const form = (): HTMLFormElement => {
      const value = screen.getByRole('button', { name: zh['native.bind'] }).closest('form')
      if (value === null) throw new Error('Read form is missing')
      return value
    }
    fireEvent.submit(form())
    paste()
    fireEvent.click(screen.getByRole('radio', { name: zh['native.automatic'] }))
    fireEvent.submit(form())
    act(() => { f.source.set({ ...f.source.getSnapshot(), pending: true }) })
    expect(screen.getByLabelText(zh['native.goal']).matches(':disabled')).toBe(true)
    fireEvent.submit(form())
    act(() => { f.source.set({ phase: 'ready', pending: false, issue: null, observation: observation(bound) }) })
    const resume = screen.getByRole('button', { name: zh['native.resume'] }).closest('form')
    if (resume === null) throw new Error('Resume form is missing')
    fireEvent.submit(resume)
    expect(f.action).not.toHaveBeenCalled()
  })

  it('closes the panel from its trigger without refreshing or changing the selected entry', () => {
    const f = fixture(); paste(JSON.stringify(groupEntry))
    const trigger = screen.getByRole('button', { name: zh['native.trigger'] })
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(JSON.stringify(groupEntry))
    expect(f.action).not.toHaveBeenCalled()
  })

  it('keeps the original named local Task while the collaboration entrance targets a remote scope', () => {
    const task: DevelopmentTaskSnapshot = { id: target.taskId, ownerNodeId: target.expectedBindingEpoch.nodeId,
      revision: 1, origin: { kind: 'root' }, hiddenRoomId: 'local-room' as DevelopmentTaskSnapshot['hiddenRoomId'],
      runtime: 'ready', objective: 'Maintain my original responsibility', scope: 'Local code',
      createdBy: localCapture.grant.participantId, context: [], createdAt: 1, updatedAt: 1 }
    const f = fixture(localSnapshot(localExecution), {
      useNativeTasks: select => select({ tasks: [task, { ...task, id: 'other-task' as typeof task.id,
        ownerNodeId: 'other-owner' as typeof task.ownerNodeId }], graphTasks: [], boundaryTaskIds: [], assignments: [], read: true }),
      useNativeParticipants: select => select({ nodeId: task.ownerNodeId, presenceTtlMs: 1000, participants: [], read: true }),
      useNativeLocalContributions: select => select({ [state.agentId]: { status: 'ready', pending: false,
        value: { ...localStatus, agentId: state.agentId, capture: localCapture } } }),
    })
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.remote'] }))
    paste(JSON.stringify(groupEntry))
    expect(screen.getByText(makeTranslate(zh)('native.local.retainedTask', { task: task.objective }))).not.toBeNull()
    f.rerender(<NativeScopeAction {...f.props} useNativeLocalContributions={select => select({ [state.agentId]: {
      status: 'loading', pending: false, value: { ...localStatus, agentId: state.agentId, capture: localCapture },
    } })} />)
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['contribution.loading'])
    expect(f.action).not.toHaveBeenCalled()
  })
})


describe('native entrance while local collection or receiving is unavailable', () => {
  it('shows pending local withdrawal while retaining the original Task and remote entrance', () => {
    const f = fixture(localSnapshot(), {
      useNativeLocalContributions: select => select({ [state.agentId]: { status: 'ready', pending: false,
        value: { ...localStatus, agentId: state.agentId, capture: { ...localCapture, state: 'ending', collecting: false } } } }),
    })
    expect(screen.getByRole('button', { name: zh['native.trigger'] }).textContent).toContain(zh['native.local.trigger.ending'])
    fireEvent.click(screen.getByRole('radio', { name: zh['native.target.remote'] }))
    paste()
    expect(screen.getByText(makeTranslate(zh)('native.local.retainedTask', { task: target.taskId }))).not.toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(JSON.stringify(invitation))
    expect(f.action).not.toHaveBeenCalled()
    expect(f.props.stopNativeLocalContribution).not.toHaveBeenCalled()
  })

  it('explains an unavailable receive service without discarding the editable draft or connecting', () => {
    const f = fixture(); paste()
    act(() => { f.source.set({ phase: 'unavailable', pending: false, issue: null, observation: null }) })
    expect(screen.getByText(zh['native.unavailable'])).not.toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.invitation']).value).toBe(JSON.stringify(invitation))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
    expect(f.action).not.toHaveBeenCalled()
  })
})
