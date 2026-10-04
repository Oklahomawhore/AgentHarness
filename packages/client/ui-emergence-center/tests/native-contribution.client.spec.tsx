// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeContributionTransfer, ScopeAgentContributionStatus, ScopeAgentContributionCapture } from '@deepseek-ai/dsh-api-remotes/client'
import { NativeContributionPanel, type NativeContributionActions } from '../src/client/NativeContributionPanel.tsx'
import type { NativeScopeSnapshot } from '../src/client/native-scopes.ts'
import { bound, invitation, observation, state } from './native-scope-fixture.client.ts'
import type { ContributionEntry } from '../src/client/contribution-directory.ts'
import { zh } from '../src/client/locales.ts'
import { agentId, applicationEntry, capture, capturedStatus, emptyStatus } from './native-contribution-fixture.client.ts'

afterEach(cleanup)
const t = makeTranslate(zh)
function fixture(value: ScopeAgentContributionStatus = emptyStatus) {
  const actions: NativeContributionActions = {
    readNativeContribution: vi.fn(), requestNativeContribution: vi.fn(async () => {}),
    stopNativeContribution: vi.fn(async () => {}), leaveNativeJoin: vi.fn(async () => {}),
    previewNativeContribution: vi.fn(async (): Promise<ScopeContributionTransfer> => applicationEntry),
  }
  const scope: NativeScopeSnapshot = { phase: 'ready', pending: false, issue: null, observation: observation({ ...state, agentId }) }
  const props = { agentId, t, scope, ...actions, entry: { value, status: 'ready', pending: false } as ContributionEntry<ScopeAgentContributionStatus> }
  const view = render(<NativeContributionPanel {...props} />)
  fireEvent.click(screen.getByText(zh['native.share.title']))
  return { ...view, props, actions }
}
function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}
async function consentFields(): Promise<void> {
  change(zh['contribution.application.paste'], 'tool-entry')
  fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
  await screen.findByText(applicationEntry.ownerPeerId)
  change(zh['contribution.roots'], ' /project\n/project/docs\n/project ')
  fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.write'] }))
  change(zh['contribution.hours'], '1')
  change(zh['contribution.maxSamples'], '8')
  change(zh['contribution.maxBytes'], '4096')
}
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: zh['native.share.request'] })

describe('native file-work consent', () => {
  it('starts closed to sharing and sends only explicitly selected permission after separate consent', async () => {
    const f = fixture()
    for (const control of screen.getAllByRole<HTMLInputElement>('checkbox')) expect(control.checked).toBe(false)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('')
    expect(submit().disabled).toBe(true)
    await consentFields()
    expect(submit().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const sent = vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0]
    expect(sent).toEqual({ agentId, expectedCapture: null, entry: applicationEntry,
      roots: ['/project', '/project/docs'], tools: ['write'],
      limits: { expiresAt: sent?.limits.expiresAt, maxSamples: 8, maxSampleBytes: 4096 } })
    expect(sent?.limits.expiresAt).toBeLessThanOrEqual(Date.now() + 3600000)
    expect(sent?.limits.expiresAt).toBeGreaterThan(Date.now() + 3500000)
    expect(f.actions.stopNativeContribution).not.toHaveBeenCalled()
  })

  it('rejects an OpenAPI entry and invalidates a preview when its text changes', async () => {
    const f = fixture()
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValueOnce({ ...applicationEntry, kind: 'contribution-entry', sourceKind: 'openapi' })
    change(zh['contribution.application.paste'], 'openapi-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await screen.findByText(zh['native.share.invalidEntry'])
    expect(submit().disabled).toBe(true)
    await consentFields()
    change(zh['contribution.application.paste'], 'unverified replacement')
    expect(screen.queryByText(applicationEntry.ownerPeerId)).toBeNull()
    expect(submit().disabled).toBe(true)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('ignores a delayed preview after the user replaces its input', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ScopeContributionTransfer>()
    vi.mocked(f.actions.previewNativeContribution).mockReturnValueOnce(pending.promise)
    change(zh['contribution.application.paste'], 'old entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    change(zh['contribution.application.paste'], 'new draft')
    await act(async () => { pending.resolve(applicationEntry); await pending.promise })
    expect(screen.queryByText(applicationEntry.ownerPeerId)).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.application.paste']).value).toBe('new draft')
    expect(submit().disabled).toBe(true)
  })

  it('keeps an uncertain request draft and disables edits until authoritative status recovers', async () => {
    const f = fixture()
    await consentFields()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
    fireEvent.click(submit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    f.rerender(<NativeContributionPanel {...f.props} entry={{ value: emptyStatus, status: 'error', pending: false,
      error: 'contribution/unknown-outcome' }} />)
    expect(submit().disabled).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toContain('/project/docs')
    expect(screen.getByRole('alert').textContent).toBe(zh['contribution.error.unknown'])
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.refresh'] }))
    expect(f.actions.readNativeContribution).toHaveBeenCalledTimes(2)
    expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce()
    f.rerender(<NativeContributionPanel {...f.props} entry={{ value: capturedStatus, status: 'ready', pending: false }} />)
    expect(screen.getByText(zh['contribution.application.waiting'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
  })

  it('single-flights request clicks before pending observation arrives', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<undefined>()
    vi.mocked(f.actions.requestNativeContribution).mockReturnValue(pending.promise)
    await consentFields()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
    fireEvent.click(submit()); fireEvent.click(submit())
    expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(undefined); await pending.promise })
  })

  it('shows retained permission with collection paused and permits exact stop for a cold Agent', async () => {
    const f = fixture({ ...capturedStatus, eligibility: 'not-live',
      capture: { ...capture, state: 'active', collecting: false } })
    expect(screen.getByText(zh['native.share.paused'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.stop'] }))
    await waitFor(() => {
      expect(f.actions.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    })
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('keeps ending and pending work visible without claiming withdrawal has completed', async () => {
    const f = fixture({ ...capturedStatus, capture: { ...capture, state: 'ending', pendingSamples: 2,
      application: 'cancelling', issue: 'owner-unavailable' } })
    expect(screen.getByText(zh['contribution.ending'])).toBeTruthy()
    expect(screen.getByText(t('native.share.pending', { count: 2 }))).toBeTruthy()
    expect(screen.getByText(zh['native.share.endingHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.retryStop'] }))
    await waitFor(() => {
      expect(f.actions.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    })
    f.rerender(<NativeContributionPanel {...f.props} entry={{ value: { ...capturedStatus, capture: { ...capture, state: 'ending' } }, status: 'loading', pending: false }} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.share.retryStop'] }).disabled).toBe(true)
  })

  it.each(['retention-limit', 'sample-limit', 'attribution-budget', 'durability-unavailable', 'durability-failed'] as const)(
    'shows the source-local %s issue even while permission remains active', (collectionIssue) => {
      const f = fixture({ ...capturedStatus, capture: { ...capture, state: 'active', collecting: true, collectionIssue } })
      expect(screen.getByText(zh[`native.share.collection.${collectionIssue}`])).toBeTruthy()
      expect(screen.getByText(zh['native.share.active'])).toBeTruthy()
      expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
      f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false,
        value: { ...capturedStatus, capture: { ...capture, state: 'active', collecting: true, collectionIssue: null } } }} />)
      expect(screen.queryByText(zh[`native.share.collection.${collectionIssue}`])).toBeNull()
    },
  )

  it.each(['delegated', 'fork', 'task-conflict'] as const)('never requests permission for a %s Agent', (eligibility) => {
    const f = fixture({ ...emptyStatus, eligibility })
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.application.paste']).disabled).toBe(true)
    expect(submit().disabled).toBe(true)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })
})

const joinEntry = { ...applicationEntry, kind: 'scope-join-entry', sourceKind: 'tool-observations' } satisfies ScopeContributionTransfer
const joinSubmit = (): HTMLButtonElement => screen.getByRole('button', { name: zh['native.join.request'] })
const readConsent = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.join.readConsent'] })
const jointReceiving = {
  adoptionId: 'adoption-a' as NonNullable<ScopeAgentContributionCapture['receiving']>['adoptionId'],
  state: 'waiting', invitation: null,
} satisfies NonNullable<ScopeAgentContributionCapture['receiving']>

describe('native joint joining', () => {
  it('requires two explicit permissions and sends the original reading watermark without automatic execution', async () => {
    const f = fixture()
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(joinEntry)
    await consentFields()
    expect(readConsent().checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
    expect(joinSubmit().disabled).toBe(true)
    fireEvent.click(readConsent())
    expect(joinSubmit().disabled).toBe(false)
    fireEvent.click(joinSubmit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const sent = vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0]
    expect(sent).toEqual({ agentId, expectedCapture: null, entry: joinEntry, roots: ['/project', '/project/docs'], tools: ['write'],
      limits: { expiresAt: sent?.limits.expiresAt, maxSamples: 8, maxSampleBytes: 4096 }, receive: { expectedReadStateSeq: 1 } })
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })

  it('invalidates read consent after bind-and-leave even when the Session is again unbound', async () => {
    const f = fixture()
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(joinEntry)
    await consentFields()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] })); fireEvent.click(readConsent())
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, observation: observation({ ...bound, agentId }, 2) }} />)
    expect(readConsent().checked).toBe(false)
    expect(readConsent().disabled).toBe(true)
    expect(joinSubmit().disabled).toBe(true)
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, observation: observation({ ...state, agentId }, 3) }} />)
    expect(readConsent().checked).toBe(false)
    fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    fireEvent.click(readConsent()); fireEvent.click(joinSubmit())
    await waitFor(() => {
      expect(f.actions.requestNativeContribution).toHaveBeenCalledWith(expect.objectContaining({ receive: { expectedReadStateSeq: 3 } }))
    })
  })

  it('keeps joint approval inert while reading status is uncertain and requires reapproval after entry edits', async () => {
    const f = fixture()
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(joinEntry)
    await consentFields()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] })); fireEvent.click(readConsent())
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, phase: 'loading' }} />)
    expect(joinSubmit().disabled).toBe(true)
    fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    f.rerender(<NativeContributionPanel {...f.props} />)
    change(zh['contribution.application.paste'], 'a different entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await screen.findByText(applicationEntry.ownerPeerId)
    expect(readConsent().checked).toBe(false)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh['native.share.consent'] }).checked).toBe(false)
    expect(joinSubmit().disabled).toBe(true)
  })

  it.each(['waiting', 'adopting', 'active', 'ended', 'superseded', 'failed'] as const)(
    'shows %s reading separately from contribution and keeps stop and joint leave distinct', async (receivingState) => {
      const f = fixture({ ...capturedStatus, capture: { ...capture, entry: joinEntry,
        receiving: { ...jointReceiving, state: receivingState, invitation: receivingState === 'active' ? invitation : null } } })
      expect(screen.getByText(zh[`native.join.state.${receivingState}`])).toBeTruthy()
      expect(screen.getByText(zh['native.join.passiveHint'])).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: zh[receivingState === 'waiting' || receivingState === 'adopting'
        ? 'native.join.cancelPending' : 'native.share.stop'] }))
      await waitFor(() => { expect(f.actions.stopNativeContribution).toHaveBeenCalledOnce() })
      expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: zh['native.join.leave'] }))
      await waitFor(() => {
        expect(f.actions.leaveNativeJoin).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
      })
      f.rerender(<NativeContributionPanel {...f.props} entry={{ ...f.props.entry, status: 'error', error: 'contribution/unknown-outcome' }} />)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.join.leave'] }).disabled).toBe(true)
      expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    },
  )
})


describe('joint termination and receiving continuation', () => {
  it('describes pending cancellation separately from stopping already connected reading', () => {
    const pending: ScopeAgentContributionStatus = { ...capturedStatus, capture: { ...capture, entry: joinEntry,
      receiving: jointReceiving, receivingIntent: 'adopt' } }
    const f = fixture(pending)
    expect(screen.getByRole('button', { name: zh['native.join.cancelPending'] })).toBeTruthy()
    expect(screen.getByText(zh['native.join.stopPendingHint'])).toBeTruthy()
    expect(screen.queryByText(zh['native.join.stopSharingHint'])).toBeNull()
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false,
      value: { ...pending, capture: { ...capture, entry: joinEntry, state: 'active', receivingIntent: 'adopt',
        receiving: { ...jointReceiving, state: 'active', invitation } } } }} />)
    expect(screen.getByRole('button', { name: zh['native.share.stop'] })).toBeTruthy()
    expect(screen.getByText(zh['native.join.stopSharingHint'])).toBeTruthy()
    expect(screen.queryByText(zh['native.join.stopPendingHint'])).toBeNull()
  })

  it.each(['cancel-pending', 'leave'] as const)('does not present stale reading as connected or ended during %s', (receivingIntent) => {
    const value: ScopeAgentContributionStatus = { ...capturedStatus, capture: { ...capture, entry: joinEntry,
      state: 'ending', receivingIntent, receiving: { ...jointReceiving, state: 'active', invitation } } }
    const f = fixture(value)
    expect(screen.getByText(zh['native.join.confirming'])).toBeTruthy()
    expect(screen.queryByText(zh['native.join.state.active'])).toBeNull()
    expect(screen.queryByText(zh['native.join.state.ended'])).toBeNull()
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false,
      value: { ...value, capture: { ...capture, entry: joinEntry, state: 'ending', receivingIntent,
        receiving: { ...jointReceiving, state: 'ended' } } } }} />)
    expect(screen.getByText(zh['native.join.state.ended'])).toBeTruthy()
    expect(screen.queryByText(zh['native.join.confirming'])).toBeNull()
  })

  it('keeps failed receiving cleanup available after capture removal without claiming contributions remain pending', async () => {
    const continuation: NonNullable<ScopeAgentContributionStatus['receivingContinuation']> = {
      selection: capture.selection, entry: joinEntry, intent: 'cancel-pending',
      receiving: { ...jointReceiving, state: 'failed' },
    }
    const value: ScopeAgentContributionStatus = { ...emptyStatus, revision: 2, receivingContinuation: continuation }
    const f = fixture(value)
    expect(screen.getByText(zh['native.join.continuation'])).toBeTruthy()
    expect(screen.getByText(zh['native.join.confirming'])).toBeTruthy()
    expect(screen.getByText(zh['native.join.retryHint'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['contribution.application.paste'])).toBeNull()
    expect(screen.queryByText(zh['native.share.endingHint'])).toBeNull()
    expect(screen.queryByText(t('native.share.pending', { count: 0 }))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.join.retryCancel'] }))
    await waitFor(() => {
      expect(f.actions.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    })
    fireEvent.click(screen.getByRole('button', { name: zh['native.join.leave'] }))
    await waitFor(() => {
      expect(f.actions.leaveNativeJoin).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    })
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'error', pending: false, value,
      error: 'contribution/unknown-outcome' }} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.join.retryCancel'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.join.leave'] }).disabled).toBe(true)
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false, value: { ...emptyStatus, revision: 3 } }} />)
    expect(screen.queryByText(zh['native.join.continuation'])).toBeNull()
    expect(screen.getByLabelText(zh['contribution.application.paste'])).toBeTruthy()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('does not attribute a later independent reading connection to an obsolete join button', () => {
    const f = fixture({ ...capturedStatus, capture: { ...capture, entry: joinEntry, receivingIntent: 'adopt',
      receiving: { ...jointReceiving, state: 'superseded' } } })
    expect(screen.getByText(zh['native.join.stopSeparateHint'])).toBeTruthy()
    expect(screen.queryByText(zh['native.join.stopSharingHint'])).toBeNull()
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, observation: observation({ ...bound, agentId }) }}
      entry={{ status: 'ready', pending: false, value: emptyStatus }} />)
    expect(screen.queryByRole('button', { name: zh['native.join.leave'] })).toBeNull()
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })
})
