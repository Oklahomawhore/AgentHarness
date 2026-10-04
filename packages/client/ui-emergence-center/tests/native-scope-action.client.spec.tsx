// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NativeScopeAction, type NativeScopeActionProps } from '../src/client/NativeScopeAction.tsx'
import type { NativeScopeSnapshot } from '../src/client/native-scopes.ts'
import { zh } from '../src/client/locales.ts'
import { localExecution, localSnapshot } from './native-local-automatic-fixture.client.ts'
import { localCapture, assigned as localStatus } from './native-local-contribution-fixture.client.ts'
import { bound, invitation, observation, observable, state } from './native-scope-fixture.client.ts'

afterEach(cleanup)
function fixture(initial: NativeScopeSnapshot = { phase: 'ready', pending: false, issue: null, observation: observation() }) {
  const source = observable(initial)
  const action = vi.fn<NativeScopeActionProps['actNativeScope']>().mockResolvedValue(true)
  const refresh = vi.fn()
  const selectView = vi.fn()
  const props = {
    sessionId: state.agentId, t: makeTranslate(zh), selectView, actNativeScope: action, refreshNativeScope: refresh,
    useNativeContributions: () => undefined, useNativeLocalContributions: () => undefined,
    useNativeTasks: () => ({ tasks: [], read: true }), useNativeParticipants: () => ({ read: true }),
    readNativeLocalContribution: vi.fn(), checkoutNativeLocalTask: vi.fn(),
    requestNativeLocalContribution: vi.fn(), stopNativeLocalContribution: vi.fn(),
    readNativeContribution: vi.fn(), requestNativeContribution: vi.fn(),
    stopNativeContribution: vi.fn(), leaveNativeJoin: vi.fn(), previewNativeContribution: vi.fn(),
    useNativeScope: <T,>(select: (value: NativeScopeSnapshot) => T): T => select(useSyncExternalStore(
      listener => source.subscribe(listener), () => source.getSnapshot())),
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
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.bind'] }).disabled).toBe(true)
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
      observation: observation({ ...bound, mode: 'paused', pauseReason: 'coverage' }) })
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
