// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopeAgentActivity, ScopeAgentActivityRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NativeScopeActivity } from '../src/client/NativeScopeActivity.tsx'
import type { NativeScopeSnapshot } from '../src/client/native-scopes.ts'
import { zh } from '../src/client/locales.ts'
import { localExecution, localObservation } from './native-local-automatic-fixture.client.ts'
import { bound, observation } from './native-scope-fixture.client.ts'

afterEach(cleanup)
const t = makeTranslate(zh)
const empty = { request: null, completed: null, evaluation: null }
const request: ScopeAgentActivityRequest = {
  bindingId: bound.binding!.id, goalDigest: 'goal-hash' as ScopeAgentActivityRequest['goalDigest'],
  activationId: 'activation-1' as ScopeAgentActivityRequest['activationId'],
  projectionId: 'projection-1' as ScopeAgentActivityRequest['projectionId'], taskRevision: 7,
  requestSeq: 10 as ScopeAgentActivityRequest['requestSeq'], contextSeq: 8 as ScopeAgentActivityRequest['contextSeq'],
  turn: 3, step: 1,
}
const completed = { ...request, assistantSeq: 11 as ScopeAgentActivityRequest['requestSeq'],
  turnEndSeq: 12 as ScopeAgentActivityRequest['requestSeq'] }
const activated = { bindingId: request.bindingId, goalDigest: request.goalDigest, activationId: request.activationId,
  projectionId: request.projectionId, taskRevision: request.taskRevision, decision: 'activate' as const }
const automatic = { goal: 'Keep frontend aligned', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 1000 }
function snapshot(activity: ScopeAgentActivity = empty): NativeScopeSnapshot {
  return { phase: 'ready', pending: false, issue: null,
    observation: { ...observation({ ...bound, automatic, mode: 'enabled' }), activity } }
}

describe('recorded automatic collaboration activity', () => {
  it('distinguishes a reservation, a dispatched request, and a completed response', () => {
    const view = render(<NativeScopeActivity snapshot={snapshot({ ...empty, evaluation: activated })} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.activate', { revision: 7 }))).not.toBeNull()
    expect(view.container.querySelector('[data-native-scope-activity-request]')).toBeNull()
    expect(view.container.querySelector('[data-native-scope-activity-completed]')).toBeNull()
    view.rerender(<NativeScopeActivity snapshot={snapshot({ ...empty, request, evaluation: activated })} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.request', { turn: 3, step: 1 }))).not.toBeNull()
    expect(screen.queryByText(t('native.activity.activate', { revision: 7 }))).toBeNull()
    view.rerender(<NativeScopeActivity snapshot={snapshot({ ...empty, completed, evaluation: activated })} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.completed', { turn: 3, revision: 7 }))).not.toBeNull()
    expect(view.container.querySelector('[data-native-scope-activity-request]')).toBeNull()
    expect(screen.queryByText(t('native.activity.activate', { revision: 7 }))).toBeNull()
  })
  it('shows an unchanged-evidence decision beside its historical completed response', () => {
    const activity: ScopeAgentActivity = { request: null, completed,
      evaluation: { ...activated, activationId: null, decision: 'suppress-unchanged', taskRevision: 8 } }
    const view = render(<NativeScopeActivity snapshot={snapshot(activity)} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.suppress-unchanged', { revision: 8 }))).not.toBeNull()
    expect(screen.getByText(t('native.activity.completed', { turn: 3, revision: 7 }))).not.toBeNull()
    expect(view.container.textContent).not.toContain(request.goalDigest)
    expect(view.container.textContent).not.toContain(request.projectionId)
    expect(view.container.querySelector('[data-native-scope-activity-request]')).toBeNull()
    view.rerender(<NativeScopeActivity snapshot={snapshot({ ...activity, evaluation: { ...activated,
      decision: 'blocked-current', activationId: null, taskRevision: 9 } })} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.blocked-current', { revision: 9 }))).not.toBeNull()
  })
  it('retains a historical completion while a different automatic response has a recorded request', () => {
    const next = { ...request, activationId: 'activation-2' as ScopeAgentActivityRequest['activationId'], turn: 4 }
    const view = render(<NativeScopeActivity snapshot={snapshot({ ...empty, request: next, completed })} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.completed', { turn: 3, revision: 7 }))).not.toBeNull()
    expect(screen.getByText(t('native.activity.request', { turn: 4, step: 1 }))).not.toBeNull()
    const paused = snapshot({ ...empty, completed })
    const value = paused.observation
    if (value === null || value.eligibility === 'not-live') throw new Error('Missing live fixture')
    view.rerender(<NativeScopeActivity snapshot={{ ...paused,
      observation: { ...value, state: { ...value.state, mode: 'paused', pauseReason: 'restored' } } }} local={false} t={t} />)
    expect(screen.getByText(t('native.activity.completed', { turn: 3, revision: 7 }))).not.toBeNull()
    expect(view.container.querySelector('[data-native-scope-activity-request]')).toBeNull()
  })
  it('hides old evidence during refresh, disconnect, departure, and target switching', () => {
    const ready = snapshot({ ...empty, completed })
    const view = render(<NativeScopeActivity snapshot={ready} local={false} t={t} />)
    expect(screen.getByRole('region', { name: zh['native.activity.title'] })).not.toBeNull()
    for (const phase of ['loading', 'disconnected', 'error'] as const) {
      view.rerender(<NativeScopeActivity snapshot={{ ...ready, phase }} local={false} t={t} />)
      expect(view.container.querySelector('[data-native-scope-activity]')).toBeNull()
    }
    view.rerender(<NativeScopeActivity snapshot={ready} local t={t} />)
    expect(view.container.querySelector('[data-native-scope-activity]')).toBeNull()
    view.rerender(<NativeScopeActivity snapshot={{ ...ready, observation: observation() }} local={false} t={t} />)
    expect(view.container.querySelector('[data-native-scope-activity]')).toBeNull()
    view.rerender(<NativeScopeActivity snapshot={snapshot()} local={false} t={t} />)
    expect(view.container.querySelector('[data-native-scope-activity]')).toBeNull()
  })
  it('uses the same presentation for an exact owner-local assignment', () => {
    const value = localObservation(localExecution)
    if (value.eligibility === 'not-live') throw new Error('Missing local fixture')
    const live = { ...snapshot(), observation: { ...value, activity: { ...empty, completed } } }
    const view = render(<NativeScopeActivity snapshot={live} local t={t} />)
    expect(screen.getByText(t('native.activity.completed', { turn: 3, revision: 7 }))).not.toBeNull()
    view.rerender(<NativeScopeActivity snapshot={live} local={false} t={t} />)
    expect(view.container.querySelector('[data-native-scope-activity]')).toBeNull()
  })
})
