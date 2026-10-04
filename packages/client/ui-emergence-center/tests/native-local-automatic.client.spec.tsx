// @vitest-environment jsdom
import { useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NativeLocalContributionPanel } from '../src/client/NativeLocalContributionPanel.tsx'
import type { NativeScopeAction } from '../src/client/native-scopes.ts'
import { zh } from '../src/client/locales.ts'
import { assigned, binding, localCapture, tasks } from './native-local-contribution-fixture.client.ts'
import { localExecution, localObservation, localSnapshot, target } from './native-local-automatic-fixture.client.ts'
import { state } from './native-scope-fixture.client.ts'

afterEach(cleanup)
function fixture(scope = localSnapshot()) {
  const actScope = vi.fn<(action: NativeScopeAction) => Promise<boolean>>().mockResolvedValue(true)
  const props = { agentId: assigned.agentId, tasks, catalogReady: true, receivingElsewhere: false, t: makeTranslate(zh),
    scope, actScope, entry: { status: 'ready' as const, pending: false, value: assigned },
    readNativeLocalContribution: vi.fn(), checkoutNativeLocalTask: vi.fn(async () => {}),
    requestNativeLocalContribution: vi.fn(async () => {}), stopNativeLocalContribution: vi.fn(async () => {}) }
  return { ...render(<NativeLocalContributionPanel {...props} />), props, actScope }
}
function allow() {
  fireEvent.click(screen.getByRole('checkbox', { name: zh['native.local.allowAutomatic'] }))
  for (const [name, value] of [[zh['native.goal'], 'Coordinate retries'], [zh['native.extra'], '2'],
    [zh['native.steps'], '3'], [zh['native.interval'], '1']] as const) fireEvent.change(screen.getByLabelText(name), { target: { value } })
}
function SubmitBeforeEffects() {
  useLayoutEffect(() => {
    const form = document.querySelector('[data-native-local-automatic] form')
    if (form === null) throw new Error('Automatic form missing')
    fireEvent.submit(form)
  }, [])
  return null
}

describe('owner-local automatic permission', () => {
  it('defaults off and starts only an explicitly selected policy independently of file consent', async () => {
    const f = fixture()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.local.allowAutomatic'] }).checked).toBe(false)
    expect(screen.getByText(target.taskBindingId)).not.toBeNull()
    expect(screen.getByText(`${target.expectedBindingEpoch.nodeId}:${String(target.expectedBindingEpoch.seq)}`)).not.toBeNull()
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    allow()
    fireEvent.click(screen.getByRole('button', { name: zh['native.resume'] }))
    await waitFor(() => { expect(f.actScope).toHaveBeenCalledExactlyOnceWith({ kind: 'bindLocal', request: {
      ...target, expectedBindingId: null,
      automatic: { goal: 'Coordinate retries', activationLimit: 2, maxStepsPerTurn: 3, minIntervalMs: 1000 },
    } }) })
    expect(f.props.requestNativeLocalContribution).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.local.consent'] }).checked).toBe(false)
  })

  it('pauses its exact execution and resumes remaining reservations without increasing the ceiling', async () => {
    const f = fixture(localSnapshot(localExecution))
    fireEvent.click(screen.getByRole('button', { name: zh['native.pause'] }))
    await waitFor(() => { expect(f.actScope).toHaveBeenCalledWith({ kind: 'pause', expectedBindingId: localExecution.binding?.id }) })
    f.rerender(<NativeLocalContributionPanel {...f.props}
      scope={localSnapshot({ ...localExecution, mode: 'paused', pauseReason: 'user' })} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复自动工作（剩余 3 次）' }))
    await waitFor(() => { expect(f.actScope).toHaveBeenLastCalledWith({ kind: 'resume', expectedBindingId: localExecution.binding?.id,
      automatic: localExecution.automatic }) })
    expect(screen.getByText(zh['native.pauseHint'])).toBeTruthy()
  })

  it('closes automatic work through the same target while preserving the independent capture', async () => {
    const f = fixture(localSnapshot(localExecution))
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry, value: { ...assigned, capture: localCapture } }} />)
    fireEvent.click(screen.getByRole('button', { name: zh['native.disableAutomatic'] }))
    await waitFor(() => { expect(f.actScope).toHaveBeenCalledWith({ kind: 'bindLocal', request: {
      ...target, expectedBindingId: localExecution.binding?.id, automatic: null,
    } }) })
    expect(f.props.stopNativeLocalContribution).not.toHaveBeenCalled()
  })

  it('leaves a Task without prior automatic permission using one guarded Host command', async () => {
    const f = fixture()
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.leave'] }))
    await waitFor(() => { expect(f.actScope).toHaveBeenCalledExactlyOnceWith({ kind: 'leaveLocalTask', request: {
      ...target, expectedBindingId: null,
    } }) })
    expect(f.props.stopNativeLocalContribution).not.toHaveBeenCalled()
    expect(f.props.checkoutNativeLocalTask).not.toHaveBeenCalled()
  })

  it('requires new consent before submitting to a replacement Task epoch, including before passive effects', () => {
    const f = fixture(); allow()
    const changed = { ...target, expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 11 } }
    f.rerender(<><NativeLocalContributionPanel {...f.props}
      scope={{ ...f.props.scope, observation: localObservation(state, changed) }}
      entry={{ ...f.props.entry, value: { ...assigned,
        assignment: { ...binding, expectedBindingEpoch: changed.expectedBindingEpoch } } }} />
    <SubmitBeforeEffects /></>)
    expect(f.actScope).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.local.allowAutomatic'] }).checked).toBe(false)
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
  })

  it('allows fresh consent for a new Task epoch without resuming the old execution target', async () => {
    const f = fixture(localSnapshot({ ...localExecution, mode: 'paused', pauseReason: 'conflict' }))
    const changed = { ...target, expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 11 } }
    f.rerender(<NativeLocalContributionPanel {...f.props}
      scope={{ ...f.props.scope, observation: localObservation({ ...localExecution, mode: 'paused' }, changed) }}
      entry={{ ...f.props.entry, value: { ...assigned,
        assignment: { ...binding, expectedBindingEpoch: changed.expectedBindingEpoch } } }} />)
    expect(screen.queryByRole('button', { name: /恢复自动工作/ })).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.local.allowAutomatic'] }).checked).toBe(false)
    allow()
    fireEvent.click(screen.getByRole('button', { name: zh['native.resume'] }))
    await waitFor(() => { expect(f.actScope).toHaveBeenCalledExactlyOnceWith({ kind: 'bindLocal', request: {
      ...changed, expectedBindingId: localExecution.binding?.id,
      automatic: { goal: 'Coordinate retries', activationLimit: 4, maxStepsPerTurn: 3, minIntervalMs: 1000 },
    } }) })
  })

  it('blocks unknown or mismatched authority and holds same-frame departure until settlement', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<boolean>(); f.actScope.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.leave'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.leave'] }))
    expect(f.actScope).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(false); await pending.promise })
    f.rerender(<NativeLocalContributionPanel {...f.props} scope={{ ...f.props.scope, phase: 'error', observation: null }} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.local.leave'] }).disabled).toBe(true)
    expect(screen.getByText(zh['native.phase.error'])).toBeTruthy()
    f.rerender(<NativeLocalContributionPanel {...f.props} scope={{ ...f.props.scope,
      observation: localObservation(state, { ...target, expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 9 } }) }} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.local.leave'] }).disabled).toBe(true)
  })

  it('shows spent lifetime reservations without offering an exhausted-policy resume', () => {
    fixture(localSnapshot({ ...localExecution, usedBudget: 5, mode: 'paused', pauseReason: 'budget' }))
    expect(screen.getByText('累计已用 5 / 5 次 · 每轮最多 3 步')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /恢复自动工作/ })).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.local.allowAutomatic'] }).checked).toBe(false)
  })
})
