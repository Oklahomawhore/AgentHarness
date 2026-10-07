// @vitest-environment jsdom
import { useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NativeLocalContributionPanel, type NativeLocalContributionActions } from '../src/client/NativeLocalContributionPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { agentId } from './native-contribution-fixture.client.ts'
import { assigned, binding, localCapture, tasks, unbound } from './native-local-contribution-fixture.client.ts'

afterEach(cleanup)
function fixture(value = unbound) {
  const actions: NativeLocalContributionActions = { readNativeLocalContribution: vi.fn(),
    suggestNativeContributionPermission: vi.fn(async () => null),
    checkoutNativeLocalTask: vi.fn(async () => {}), requestNativeLocalContribution: vi.fn(async () => {}),
    stopNativeLocalContribution: vi.fn(async () => {}) }
  const props = { agentId, tasks, catalogReady: true, receivingElsewhere: false, t: makeTranslate(zh), ...actions,
    scope: { phase: 'ready' as const, observation: null, pending: false, issue: null }, actScope: vi.fn(async () => false),
    entry: { status: 'ready' as const, pending: false, value } }
  return { ...render(<NativeLocalContributionPanel {...props} />), props, actions }
}
function SubmitBeforePassiveEffects() {
  useLayoutEffect(() => {
    const button = screen.getByRole('button', { name: zh['native.local.enable'] })
    const form = button.closest('form')
    if (form === null) throw new Error('Permission form missing')
    fireEvent.submit(form)
  }, [])
  return null
}
function fillPermission(): void {
  fireEvent.change(screen.getByLabelText(zh['contribution.roots']), { target: { value: '/project' } })
  fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.write'] }))
  for (const [label, value] of [[zh['contribution.hours'], '1'], [zh['contribution.maxSamples'], '8'], [zh['contribution.maxBytes'], '4096']] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
}

describe('current Session owner-local consent', () => {
  it('applies local workspace suggestions as editable fields and requires fresh consent after edits', async () => {
    const f = fixture(assigned)
    vi.mocked(f.actions.suggestNativeContributionPermission).mockResolvedValue({
      agentId, roots: ['/workspace'], tools: ['write', 'edit'], durationHours: 3, maxSamples: 12, maxSampleBytes: 2048,
    })
    fireEvent.click(screen.getByRole('button', { name: zh['native.suggestion.use'] }))
    await waitFor(() => { expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('/workspace') })
    for (const [label, value] of [[zh['contribution.hours'], '3'], [zh['contribution.maxSamples'], '12'],
      [zh['contribution.maxBytes'], '2048']] as const) expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe(value)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.share.write'] }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.share.edit'] }).checked).toBe(true)
    const consent = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.local.consent'] })
    expect(consent().checked).toBe(false)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.fileContent.consent'] }).checked).toBe(false)
    expect(f.actions.requestNativeLocalContribution).not.toHaveBeenCalled()
    fireEvent.click(consent())
    fireEvent.change(screen.getByLabelText(zh['contribution.roots']), { target: { value: '/workspace/narrow' } })
    expect(consent().checked).toBe(false)
    fireEvent.click(consent())
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.enable'] }))
    await waitFor(() => { expect(f.actions.requestNativeLocalContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeLocalContribution).mock.calls[0]?.[0]).toMatchObject({
      ...binding, roots: ['/workspace/narrow'], tools: ['write', 'edit'], limits: { maxSamples: 12, maxSampleBytes: 2048 },
    })
  })

  it('adds complete file contents only when explicitly selected with the current local permission', async () => {
    const f = fixture(assigned)
    fillPermission()
    const full = screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.fileContent.consent'] })
    expect(full.checked).toBe(false)
    fireEvent.click(full)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.local.enable'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.local.consent'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['native.local.enable'] }))
    await waitFor(() => { expect(f.actions.requestNativeLocalContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeLocalContribution).mock.calls[0]?.[0]).toMatchObject({
      ...binding, fileContent: 'completed-native-file', tools: ['write'], roots: ['/project'],
    })
  })

  it('clears full-content consent on scope and capture changes without clearing it on an ordinary status refresh', () => {
    const f = fixture(assigned)
    fillPermission()
    const full = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.fileContent.consent'] })
    fireEvent.click(full())
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...assigned, revision: assigned.revision + 1 } }} />)
    expect(full().checked).toBe(true)
    fireEvent.change(screen.getByLabelText(zh['contribution.roots']), { target: { value: '/other' } })
    expect(full().checked).toBe(false)
    fireEvent.click(full())
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...assigned, capture: localCapture } }} />)
    expect(screen.getByText(zh['native.fileContent.arguments'])).toBeTruthy()
    f.rerender(<NativeLocalContributionPanel {...f.props} />)
    expect(full().checked).toBe(false)
    fireEvent.click(full())
    f.rerender(<NativeLocalContributionPanel {...f.props} agentId={'another-session' as SessionId} />)
    expect(full().checked).toBe(false)
    expect(f.actions.requestNativeLocalContribution).not.toHaveBeenCalled()
  })

  it('identifies completed file permission on an active local capture', () => {
    fixture({ ...assigned, capture: { ...localCapture, grant: { ...localCapture.grant,
      source: { kind: 'tool-observations', name: 'Completed native file work', tools: ['Edit'],
        version: 3, fileContent: 'completed-native-file' } } } })
    expect(screen.getByText(zh['native.fileContent.complete'])).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: zh['native.fileContent.consent'] })).toBeNull()
  })

  it('selects a named local goal and connects without sending file permission', async () => {
    const f = fixture()
    expect(screen.queryByRole('checkbox')).toBeNull()
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.local.connect'] })
    expect(connect.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: binding.taskId } })
    fireEvent.click(connect)
    await waitFor(() => { expect(f.actions.checkoutNativeLocalTask).toHaveBeenCalledExactlyOnceWith(agentId, binding.taskId) })
    expect(f.actions.requestNativeLocalContribution).not.toHaveBeenCalled()
  })

  it('requires separate consent and submits the observed binding epoch with only selected tools', async () => {
    const f = fixture(assigned)
    expect(screen.getByText(zh['native.local.receiveHint'])).toBeTruthy()
    for (const checkbox of screen.getAllByRole<HTMLInputElement>('checkbox')) expect(checkbox.checked).toBe(false)
    fillPermission()
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.local.enable'] })
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.local.consent'] }))
    fireEvent.click(submit)
    await waitFor(() => { expect(f.actions.requestNativeLocalContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeLocalContribution).mock.calls[0]?.[0]).toMatchObject({
      agentId, expectedCapture: null, ...binding, roots: ['/project'], tools: ['write'], limits: { maxSamples: 8, maxSampleBytes: 4096 },
    })
    expect(vi.mocked(f.actions.requestNativeLocalContribution).mock.calls[0]?.[0].fileContent).toBeUndefined()
    expect(f.actions.checkoutNativeLocalTask).not.toHaveBeenCalled()
  })

  it('requires renewed consent after an externally changed binding epoch and blocks uncertain status', async () => {
    const f = fixture(assigned)
    f.rerender(<><NativeLocalContributionPanel {...f.props} /></>)
    fillPermission(); fireEvent.click(screen.getByRole('checkbox', { name: zh['native.local.consent'] }))
    f.rerender(<><NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...assigned, assignment: { ...binding, expectedBindingEpoch: { ...binding.expectedBindingEpoch, seq: 5 } } } }} />
    <SubmitBeforePassiveEffects /></>)
    expect(f.actions.requestNativeLocalContribution).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.local.consent'] }).checked).toBe(false)
    f.rerender(<><NativeLocalContributionPanel {...f.props}
      entry={{ ...f.props.entry, status: 'error', error: 'contribution/unknown-outcome' }} /></>)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.local.enable'] }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('/project')
    expect(f.actions.requestNativeLocalContribution).not.toHaveBeenCalled()
  })

  it('stops only the exact capture and keeps the separate receiving connection clear', async () => {
    const f = fixture({ ...assigned, capture: localCapture })
    expect(screen.getByText(zh['native.local.stopHint'])).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: zh['native.local.consent'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.stop'] }))
    await waitFor(() => {
      expect(f.actions.stopNativeLocalContribution).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: localCapture.selection })
    })
    f.rerender(<NativeLocalContributionPanel {...f.props} entry={{ ...f.props.entry,
      value: { ...assigned, capture: { ...localCapture, state: 'ending', collecting: false } } }} />)
    expect(screen.getByText(zh['native.local.ending'])).toBeTruthy()
    expect(f.actions.checkoutNativeLocalTask).not.toHaveBeenCalled()
  })

  it('does not connect a second receiver and single-flights an already sent checkout', async () => {
    const f = fixture()
    f.rerender(<NativeLocalContributionPanel {...f.props} receivingElsewhere />)
    expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true)
    expect(screen.getByText(zh['native.local.remoteRead'])).toBeTruthy()
    f.rerender(<NativeLocalContributionPanel {...f.props} />)
    const held = Promise.withResolvers<undefined>()
    vi.mocked(f.actions.checkoutNativeLocalTask).mockReturnValue(held.promise)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: binding.taskId } })
    const connect = screen.getByRole('button', { name: zh['native.local.connect'] })
    fireEvent.click(connect); fireEvent.click(connect)
    expect(f.actions.checkoutNativeLocalTask).toHaveBeenCalledOnce()
    await act(async () => { held.resolve(undefined); await held.promise })
  })
})
