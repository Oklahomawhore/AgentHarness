// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ScopeContributionTransfer, ScopeContributionEntryProbeResult, ScopeAgentContributionStatus, ScopeAgentContributionCapture,
} from '@deepseek-ai/dsh-api-remotes/client'
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
    recoverNativeContributionRoute: vi.fn(async () => {}), readNativeContribution: vi.fn(),
    requestNativeContribution: vi.fn(async () => {}),
    stopNativeContribution: vi.fn(async () => {}), leaveNativeJoin: vi.fn(async () => {}),
    previewNativeContribution: vi.fn(async (): Promise<ScopeContributionTransfer> => applicationEntry),
    probeNativeContribution: vi.fn(async (): Promise<ScopeContributionEntryProbeResult> => ({ status: 'ready' })),
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
  fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
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
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(zh['native.share.invalidEntry'])
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
    expect(f.actions.probeNativeContribution).not.toHaveBeenCalled()
    await consentFields()
    change(zh['contribution.application.paste'], 'unverified replacement')
    expect(screen.queryByText(applicationEntry.ownerPeerId)).toBeNull()
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('ignores a delayed preview after the user replaces its input', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ScopeContributionTransfer>()
    vi.mocked(f.actions.previewNativeContribution).mockReturnValueOnce(pending.promise)
    change(zh['contribution.application.paste'], 'old entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    change(zh['contribution.application.paste'], 'new draft')
    await act(async () => { pending.resolve(applicationEntry); await pending.promise })
    expect(screen.queryByText(applicationEntry.ownerPeerId)).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.application.paste']).value).toBe('new draft')
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
    expect(f.actions.probeNativeContribution).not.toHaveBeenCalled()
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
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
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
    expect(automaticConsent().checked).toBe(false)
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
    expect(joinSubmit().disabled).toBe(true)
    fireEvent.click(readConsent())
    expect(joinSubmit().disabled).toBe(false)
    fireEvent.click(joinSubmit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const sent = vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0]
    expect(sent).toEqual({ agentId, expectedCapture: null, entry: joinEntry, roots: ['/project', '/project/docs'], tools: ['write'],
      limits: { expiresAt: sent?.limits.expiresAt, maxSamples: 8, maxSampleBytes: 4096 }, receive: { expectedReadStateSeq: 1 } })
    const approvedInvitation = { ...invitation, responsibility: 'Maintain owner-side database migrations.' }
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false,
      value: { ...capturedStatus, capture: { ...capture, entry: joinEntry, state: 'active', collecting: true,
        receiving: { ...jointReceiving, state: 'active', invitation: approvedInvitation }, receivingIntent: 'adopt' } } }} />)
    expect(screen.getByText(t('native.join.responsibility', { value: approvedInvitation.responsibility }))).toBeTruthy()
    expect(screen.getByText(zh['native.join.passiveHint'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    expect(sent?.receive).toEqual({ expectedReadStateSeq: 1 })
    expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce()
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
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
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

const automaticConsent = (): HTMLInputElement => screen.getByRole('checkbox', { name: zh['native.join.automaticConsent'] })
const automaticPermission = { goal: 'Keep the shared interface current.', activationLimit: 5, maxStepsPerTurn: 4, minIntervalMs: 1500 }
function automaticFields(): void {
  change(zh['native.goal'], ` ${automaticPermission.goal} `)
  change(zh['native.extra'], '2')
  change(zh['native.steps'], '4')
  change(zh['native.interval'], '1.5')
}
async function automaticJoinForm(usedBudget = 3) {
  const f = fixture()
  const scope = { ...f.props.scope, observation: observation({ ...state, agentId, usedBudget }) }
  f.rerender(<NativeContributionPanel {...f.props} scope={scope} />)
  vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(joinEntry)
  await consentFields()
  fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
  fireEvent.click(readConsent())
  return { ...f, scope }
}

describe('optional automatic permission with joint joining', () => {
  it('sends one application with the confirmed lifetime limit and never follows approval with another request', async () => {
    const f = await automaticJoinForm()
    expect(automaticConsent().checked).toBe(false)
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    fireEvent.click(automaticConsent())
    expect(joinSubmit().disabled).toBe(true)
    automaticFields()
    expect(joinSubmit().disabled).toBe(false)
    fireEvent.click(joinSubmit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    const sent = vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0]
    expect(sent?.receive).toEqual({ expectedReadStateSeq: 1, automatic: automaticPermission })
    expect(sent?.entry).toEqual(joinEntry)
    const value = { ...capturedStatus, capture: { ...capture, entry: joinEntry,
      receiving: { ...jointReceiving, automatic: automaticPermission } } }
    f.rerender(<NativeContributionPanel {...f.props} scope={f.scope}
      entry={{ status: 'ready', pending: false, value }} />)
    expect(screen.getByText(t('native.join.automaticCaptured', {
      goal: automaticPermission.goal, limit: automaticPermission.activationLimit,
    }))).toBeTruthy()
    const approvedInvitation = { ...invitation, responsibility: 'Maintain owner-side database migrations.' }
    expect(approvedInvitation.responsibility).not.toBe(automaticPermission.goal)
    f.rerender(<NativeContributionPanel {...f.props} scope={f.scope}
      entry={{ status: 'ready', pending: false, value: { ...value, capture: { ...value.capture,
        state: 'active', collecting: true,
        receiving: { ...value.capture.receiving, state: 'active', invitation: approvedInvitation } } } }} />)
    expect(screen.getByText(zh['native.join.state.active'])).toBeTruthy()
    expect(screen.getByText(t('native.join.responsibility', { value: approvedInvitation.responsibility }))).toBeTruthy()
    expect(screen.getByText(t('native.join.automaticCaptured', {
      goal: automaticPermission.goal, limit: automaticPermission.activationLimit,
    }))).toBeTruthy()
    expect(sent?.receive).toEqual({ expectedReadStateSeq: 1, automatic: automaticPermission })
    expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce()
    expect(f.actions.stopNativeContribution).not.toHaveBeenCalled()
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })

  it('removes the optional policy from the application when the user turns it off', async () => {
    const f = await automaticJoinForm()
    fireEvent.click(automaticConsent()); automaticFields(); fireEvent.click(automaticConsent())
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    expect(joinSubmit().disabled).toBe(false)
    fireEvent.click(joinSubmit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0].receive).toEqual({ expectedReadStateSeq: 1 })
  })

  it.each([
    ['native.goal', ''], ['native.extra', '0'], ['native.extra', '1.5'],
    ['native.extra', String(Number.MAX_SAFE_INTEGER)], ['native.steps', '0'], ['native.interval', '-1'],
  ] as const)('does not submit automatic permission with %s=%s', async (key, value) => {
    const f = await automaticJoinForm()
    fireEvent.click(automaticConsent()); automaticFields()
    change(zh[key], value)
    expect(joinSubmit().disabled).toBe(true)
    fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('requires fresh consent after read-state ABA and includes only the newly confirmed lifetime allowance', async () => {
    const f = await automaticJoinForm()
    fireEvent.click(automaticConsent()); automaticFields()
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.scope,
      observation: observation({ ...bound, agentId, usedBudget: 3 }, 2) }} />)
    expect(readConsent().checked).toBe(false)
    expect(automaticConsent().checked).toBe(false)
    expect(joinSubmit().disabled).toBe(true)
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.scope,
      observation: observation({ ...state, agentId, usedBudget: 4 }, 3) }} />)
    fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    fireEvent.click(readConsent())
    expect(automaticConsent().checked).toBe(false)
    fireEvent.click(automaticConsent())
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.goal']).value.trim()).toBe(automaticPermission.goal)
    fireEvent.click(joinSubmit())
    await waitFor(() => { expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce() })
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0].receive).toEqual({
      expectedReadStateSeq: 3, automatic: { ...automaticPermission, activationLimit: 6 },
    })
  })

  it('invalidates automatic consent if confirmed lifetime usage changes without a new displayed read cursor', async () => {
    const f = await automaticJoinForm()
    fireEvent.click(automaticConsent()); automaticFields()
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.scope,
      observation: observation({ ...state, agentId, usedBudget: 4 }) }} />)
    expect(readConsent().checked).toBe(false)
    expect(automaticConsent().checked).toBe(false)
    expect(joinSubmit().disabled).toBe(true)
    fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('discards automatic consent for a rechecked entry and for another Session', async () => {
    const f = await automaticJoinForm()
    fireEvent.click(automaticConsent()); automaticFields()
    change(zh['contribution.application.paste'], 'replacement entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(applicationEntry.ownerPeerId)
    expect(readConsent().checked).toBe(false)
    expect(automaticConsent().checked).toBe(false)
    expect(screen.queryByLabelText(zh['native.goal'])).toBeNull()
    fireEvent.click(readConsent()); fireEvent.click(automaticConsent())
    const otherAgent = 'another-native-session' as typeof agentId
    f.rerender(<NativeContributionPanel {...f.props} agentId={otherAgent}
      scope={{ ...f.scope, observation: observation({ ...state, agentId: otherAgent, usedBudget: 7 }) }}
      entry={{ status: 'ready', pending: false, value: { ...emptyStatus, agentId: otherAgent } }} />)
    fireEvent.click(screen.getByText(zh['native.share.title']))
    await consentFields()
    expect(readConsent().checked).toBe(false)
    expect(automaticConsent().checked).toBe(false)
    fireEvent.click(readConsent()); fireEvent.click(automaticConsent())
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.goal']).value).toBe('')
    expect(joinSubmit().disabled).toBe(true)
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('blocks uncertain reading status and single-flights the complete policy before pending status arrives', async () => {
    const f = await automaticJoinForm()
    fireEvent.click(automaticConsent()); automaticFields()
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.scope, phase: 'loading' }} />)
    expect(joinSubmit().disabled).toBe(true)
    fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    f.rerender(<NativeContributionPanel {...f.props} scope={f.scope} />)
    const pending = Promise.withResolvers<undefined>()
    vi.mocked(f.actions.requestNativeContribution).mockReturnValueOnce(pending.promise)
    fireEvent.click(joinSubmit()); fireEvent.click(joinSubmit())
    expect(f.actions.requestNativeContribution).toHaveBeenCalledOnce()
    expect(vi.mocked(f.actions.requestNativeContribution).mock.calls.at(0)?.[0].receive).toEqual({
      expectedReadStateSeq: 1, automatic: automaticPermission,
    })
    await act(async () => { pending.resolve(undefined); await pending.promise })
  })

  it.each(['waiting', 'active'] as const)('shows original %s permission without treating it as the current execution state', async (receivingState) => {
    const f = fixture({ ...capturedStatus, capture: { ...capture, entry: joinEntry,
      receiving: { ...jointReceiving, state: receivingState, automatic: automaticPermission, invitation }, receivingIntent: 'adopt' } })
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, observation: observation({ ...bound,
      agentId, mode: 'paused', pauseReason: 'user', usedBudget: 4, automatic: { ...automaticPermission, goal: 'A later goal.' } }) }} />)
    expect(screen.getByText(t('native.join.automaticCaptured', {
      goal: automaticPermission.goal, limit: automaticPermission.activationLimit,
    }))).toBeTruthy()
    expect(screen.queryByText(zh['native.join.passiveHint'])).toBeNull()
    expect(screen.queryByText(zh['native.mode.enabled'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh[receivingState === 'waiting' ? 'native.join.cancelPending' : 'native.share.stop'] }))
    await waitFor(() => {
      expect(f.actions.stopNativeContribution).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    })
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    expect(f.actions.leaveNativeJoin).not.toHaveBeenCalled()
  })

  it('keeps the originally captured policy visible during read-only cleanup after sharing ends', async () => {
    const f = fixture({ ...emptyStatus, receivingContinuation: { routeRevision: 0, selection: capture.selection,
      entry: joinEntry, intent: 'leave', receiving: { ...jointReceiving, state: 'failed', automatic: automaticPermission } } })
    expect(screen.getByText(zh['native.join.continuation'])).toBeTruthy()
    expect(screen.getByText(zh['native.join.confirming'])).toBeTruthy()
    expect(screen.getByText(t('native.join.automaticCaptured', {
      goal: automaticPermission.goal, limit: automaticPermission.activationLimit,
    }))).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['native.join.request'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.join.leave'] }))
    await waitFor(() => {
      expect(f.actions.leaveNativeJoin).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    })
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })
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
      routeRevision: 0, selection: capture.selection, entry: joinEntry, intent: 'cancel-pending',
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

describe('native contribution route recovery', () => {
  it('recovers an expired ending capture without collecting new file permission', async () => {
    const ending = { ...capture, entry: { ...capture.entry, expiresAt: 1 }, state: 'ending' as const }
    const f = fixture({ ...capturedStatus, eligibility: 'not-live', capture: ending })
    const replacement = { ...ending.entry, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(replacement)
    fireEvent.click(screen.getByText(zh['native.route.title']))
    change(zh['native.route.paste'], 'recovered original entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.verify'] }))
    await screen.findByText(replacement.ownerAddress)
    expect(screen.queryByRole('checkbox', { name: zh['native.share.consent'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.apply'] }))
    await waitFor(() => { expect(f.actions.recoverNativeContributionRoute).toHaveBeenCalledExactlyOnceWith({
      agentId, expectedCapture: ending.selection, expectedRouteRevision: 0,
      expectedOwnerAddress: ending.entry.ownerAddress, entry: replacement,
    }) })
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
    expect(f.actions.stopNativeContribution).not.toHaveBeenCalled()
  })

  it('rejects changed permission and discards a late preview after the displayed route changes', async () => {
    const f = fixture(capturedStatus)
    fireEvent.click(screen.getByText(zh['native.route.title']))
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValueOnce({ ...capture.entry,
      ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer', expiresAt: capture.entry.expiresAt + 1 })
    change(zh['native.route.paste'], 'different expiry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.verify'] }))
    await screen.findByText(zh['native.route.invalid'])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.route.apply'] }).disabled).toBe(true)
    const pending = Promise.withResolvers<ScopeContributionTransfer>()
    vi.mocked(f.actions.previewNativeContribution).mockReturnValueOnce(pending.promise)
    change(zh['native.route.paste'], 'old delayed route')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.verify'] }))
    const changed = { ...capturedStatus, capture: { ...capture, entry: { ...capture.entry,
      ownerAddress: '/ip4/127.0.0.1/tcp/3/p2p/owner-peer' } } }
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false, value: changed }} />)
    await act(async () => {
      pending.resolve({ ...capture.entry, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }); await pending.promise
    })
    fireEvent.click(screen.getByText(zh['native.route.title']))
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.route.paste']).value).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['native.route.apply'] }).disabled).toBe(true)
    expect(f.actions.recoverNativeContributionRoute).not.toHaveBeenCalled()
  })
})

describe('joint route read-state freshness', () => {
  it('confirms the existing joint address again with the latest reading state', async () => {
    const joint = { ...joinEntry, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }
    const current = { ...capture, routeRevision: 1, entry: joint, receiving: jointReceiving }
    const f = fixture({ ...capturedStatus, capture: current })
    f.rerender(<NativeContributionPanel {...f.props}
      scope={{ ...f.props.scope, observation: observation({ ...bound, agentId, mode: 'paused' }, 7) }} />)
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(joint)
    fireEvent.click(screen.getByText(zh['native.route.title']))
    change(zh['native.route.paste'], 'original joint entry with its already recovered address')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.verify'] }))
    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.route.apply'] })
    await waitFor(() => { expect(save.disabled).toBe(false) })
    fireEvent.click(save)
    await waitFor(() => { expect(f.actions.recoverNativeContributionRoute).toHaveBeenCalledExactlyOnceWith({
      agentId, expectedCapture: current.selection, expectedRouteRevision: 1, expectedOwnerAddress: joint.ownerAddress,
      entry: joint, receive: { expectedReadStateSeq: 7 },
    }) })
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('holds a checked joint route while reading state refreshes and clears it on a newer management cursor', async () => {
    const joint = { ...capture.entry, kind: 'scope-join-entry' as const, sourceKind: 'tool-observations' as const }
    const f = fixture({ ...capturedStatus, capture: { ...capture, entry: joint, receiving: jointReceiving } })
    const replacement = { ...joint, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }
    vi.mocked(f.actions.previewNativeContribution).mockResolvedValue(replacement)
    fireEvent.click(screen.getByText(zh['native.route.title']))
    change(zh['native.route.paste'], 'original joint entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.route.verify'] }))
    await screen.findByText(replacement.ownerAddress)
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, phase: 'loading' }} />)
    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh['native.route.apply'] })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(f.actions.recoverNativeContributionRoute).not.toHaveBeenCalled()
    f.rerender(<NativeContributionPanel {...f.props} scope={{ ...f.props.scope, observation: observation({ ...state, agentId }, 2) }} />)
    fireEvent.click(screen.getByText(zh['native.route.title']))
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.route.paste']).value).toBe('')
  })
})

describe('online entry validation', () => {
  it.each(['claimed', 'closed', 'expired', 'denied', 'capacity', 'unavailable'] as const)(
    'withholds permission for %s and permits a new explicit ready check', async (status) => {
      const f = fixture()
      vi.mocked(f.actions.probeNativeContribution).mockResolvedValueOnce({ status })
      change(zh['contribution.application.paste'], 'tool-entry')
      fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
      await screen.findByText(zh[`native.share.probe.${status}`])
      expect(f.actions.probeNativeContribution).toHaveBeenCalledExactlyOnceWith({ entry: applicationEntry })
      expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
      expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
      expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
      await screen.findByText(zh['native.share.probe.ready'])
      expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.roots']).value).toBe('')
      for (const control of screen.getAllByRole<HTMLInputElement>('checkbox')) expect(control.checked).toBe(false)
      expect(submit().disabled).toBe(true)
    },
  )

  it('keeps permission hidden during the probe and ignores ready from a replaced draft', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ScopeContributionEntryProbeResult>()
    vi.mocked(f.actions.probeNativeContribution).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ status: 'closed' })
    change(zh['contribution.application.paste'], 'old entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await waitFor(() => { expect(f.actions.probeNativeContribution).toHaveBeenCalledOnce() })
    expect(screen.getByText(zh['native.share.verifying'])).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    change(zh['contribution.application.paste'], 'new entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(zh['native.share.probe.closed'])
    await act(async () => { pending.resolve({ status: 'ready' }); await pending.promise })
    expect(screen.queryByText(zh['native.share.probe.ready'])).toBeNull()
    expect(screen.getByText(zh['native.share.probe.closed'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('reports a failed probe without exposing the Host error or granting file permission', async () => {
    const f = fixture()
    vi.mocked(f.actions.probeNativeContribution).mockRejectedValueOnce(new Error('private Host diagnostic'))
    change(zh['contribution.application.paste'], 'tool-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(zh['native.share.probe.unavailable'])
    expect(screen.queryByText('private Host diagnostic')).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('discards pending connection checks when the displayed Session changes', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ScopeContributionEntryProbeResult>()
    vi.mocked(f.actions.probeNativeContribution).mockReturnValueOnce(pending.promise)
    change(zh['contribution.application.paste'], 'old Session entry')
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await waitFor(() => { expect(f.actions.probeNativeContribution).toHaveBeenCalledOnce() })
    const otherAgent = 'another-native-session' as typeof agentId
    f.rerender(<NativeContributionPanel {...f.props} agentId={otherAgent}
      entry={{ status: 'ready', pending: false, value: { ...emptyStatus, agentId: otherAgent } }} />)
    fireEvent.click(screen.getByText(zh['native.share.title']))
    await act(async () => { pending.resolve({ status: 'ready' }); await pending.promise })
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['contribution.application.paste']).value).toBe('')
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(screen.queryByText(zh['native.share.probe.ready'])).toBeNull()
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })

  it('requires a fresh check after a submitted capture has stopped', async () => {
    const f = fixture()
    await consentFields()
    fireEvent.click(screen.getByRole('checkbox', { name: zh['native.share.consent'] }))
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false, value: capturedStatus }} />)
    f.rerender(<NativeContributionPanel {...f.props} entry={{ status: 'ready', pending: false, value: emptyStatus }} />)
    expect(screen.queryByText(zh['native.share.probe.ready'])).toBeNull()
    expect(screen.queryByLabelText(zh['contribution.roots'])).toBeNull()
    expect(screen.queryByRole('button', { name: zh['native.share.request'] })).toBeNull()
    vi.mocked(f.actions.probeNativeContribution).mockResolvedValueOnce({ status: 'claimed' })
    fireEvent.click(screen.getByRole('button', { name: zh['native.share.verify'] }))
    await screen.findByText(zh['native.share.probe.claimed'])
    expect(f.actions.requestNativeContribution).not.toHaveBeenCalled()
  })
})
