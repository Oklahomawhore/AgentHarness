import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult, ScopeAgentStatusResult, ScopeAgentBindingStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { createNativeScopeSource, type NativeScopePort, type NativeScopeSnapshot } from '../src/client/native-scopes.ts'
import { compositeExecution, localExecution, localObservation, target } from './native-local-automatic-fixture.client.ts'
import { bound, invitation, observation, observable, recordedContext, state } from './native-scope-fixture.client.ts'

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
function fixture(overrides: Partial<NativeScopePort> = {}) {
  const projection = observable<unknown>(undefined)
  const evidence = observable<unknown>(undefined)
  const contextProgress = observable<{ readonly steps: number } | undefined>(undefined)
  const session = observable({ running: false })
  const connection = observable<{ id: number } | undefined>({ id: 1 })
  const resets = observable(0)
  const assignments = observable(0)
  const port: NativeScopePort = { updateRoute: vi.fn(async () => ok(bound)), bindLocal: vi.fn(async () => ok(bound)),
    leaveLocalTask: vi.fn(async () => ok(state)),
    status: vi.fn(async () => ok(observation())), bind: vi.fn(async () => ok(bound)),
    pause: vi.fn(async () => ok(bound)), resume: vi.fn(async () => ok(bound)), leave: vi.fn(async () => ok(state)), ...overrides }
  const source = createNativeScopeSource({ agentId: state.agentId, port, projection, evidence, contextProgress, session, connection,
    subscribeAssignments: listener => assignments.subscribe(listener), subscribeReset: listener => resets.subscribe(listener) })
  return { source, port, projection, evidence, contextProgress, session, connection, resets, assignments }
}
const join = { kind: 'bind', request: { invitation, automatic: null, expectedBindingId: null } } as const

describe('native scope source', () => {
  it('isolates a throwing subscriber and keeps upstream observations until the last subscriber leaves', async () => {
    const f = fixture()
    const failure = new Error('Panel subscriber failed')
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = vi.fn(() => { throw failure })
    const healthy = vi.fn()
    const stopBroken = f.source.subscribe(broken)
    const stopHealthy = f.source.subscribe(healthy)
    const upstream = () => [f.projection, f.evidence, f.contextProgress, f.session, f.connection, f.resets, f.assignments]
      .map(source => source.count())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(diagnostics).toHaveBeenCalledWith('[native-scope] subscriber failed:', failure)
      expect(healthy).toHaveBeenCalledOnce()
      expect(f.port.status).toHaveBeenCalledOnce()
      expect(upstream()).toEqual([1, 1, 1, 1, 1, 1, 1])
      stopBroken()
      expect(upstream()).toEqual([1, 1, 1, 1, 1, 1, 1])
      f.session.set({ running: false })
      expect(f.port.status).toHaveBeenCalledOnce()
      f.projection.set({ revision: 2 })
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(healthy).toHaveBeenCalledTimes(3)
      expect(f.port.status).toHaveBeenCalledTimes(2)
      stopHealthy()
      expect(upstream()).toEqual([0, 0, 0, 0, 0, 0, 0])
      f.projection.set({ revision: 3 })
      expect(f.port.status).toHaveBeenCalledTimes(2)
    } finally { stopBroken(); stopHealthy(); diagnostics.mockRestore() }
  })

  it.each(['delegated', 'fork', 'task-conflict'] as const)('rejects resuming a %s Agent without sending a mutation', async (eligibility) => {
    const current = { ...observation(bound), eligibility }
    const f = fixture({ status: vi.fn(async () => ok(current)) })
    const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'resume', expectedBindingId: bound.binding!.id,
        automatic: { goal: 'Maintain the current Task', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 1000 } })).toBe(false)
      expect(f.port.resume).not.toHaveBeenCalled()
      expect(f.port.status).toHaveBeenCalledOnce()
      expect(f.source.getSnapshot().pending).toBe(false)
    } finally { stop() }
  })

  it('allows explicit local permission replacement after the Task changes while rejecting resume of the old permission', async () => {
    const nextTarget = { ...target, expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 22 } }
    const current = { ...observation(localExecution, 10), localTask: nextTarget,
      subscriptionState: 'unbound' as const, eligibility: 'task-conflict' as const }
    const f = fixture({ status: vi.fn(async () => ok(current)) })
    const stop = f.source.subscribe(vi.fn())
    const expectedBindingId = localExecution.binding!.id
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'resume', expectedBindingId,
        automatic: { goal: 'Maintain the current Task', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 1000 } })).toBe(false)
      expect(f.port.resume).not.toHaveBeenCalled()
      const request = { ...nextTarget, expectedBindingId, automatic: null }
      expect(await f.source.act({ kind: 'bindLocal', request })).toBe(true)
      expect(f.port.bindLocal).toHaveBeenCalledExactlyOnceWith({ ...request, agentId: state.agentId })
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(f.port.status).toHaveBeenCalledTimes(2)
    } finally { stop() }
  })

  it.each([
    { error: new RemoteError('scope-agent/task-conflict', 'The local Task changed', { agentId: state.agentId }),
      issue: 'scope-agent/task-conflict' },
    { error: new RemoteError('gateway/internal', 'Binding could not be confirmed', {}), issue: 'unknown' },
  ])('reconciles a rejected mutation with issue $issue without retrying it', async ({ error, issue }) => {
    const next = observation(state, 2)
    const status = vi.fn<NativeScopePort['status']>().mockResolvedValueOnce(ok(observation())).mockResolvedValue(ok(next))
    const bind = vi.fn<NativeScopePort['bind']>().mockResolvedValue({ ok: false, error })
    const f = fixture({ status, bind })
    const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act(join)).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', pending: false, issue, observation: next }) })
      expect(bind).toHaveBeenCalledExactlyOnceWith({ ...join.request, agentId: state.agentId })
      expect(status).toHaveBeenCalledTimes(2)
    } finally { stop() }
  })

  it('ignores a rejected mutation from before reset and then reads the current connection', async () => {
    const held = Promise.withResolvers<RemoteResult<ScopeAgentBindingStatus>>()
    const next = observation(bound, 2)
    const status = vi.fn<NativeScopePort['status']>().mockResolvedValueOnce(ok(observation())).mockResolvedValue(ok(next))
    const bind = vi.fn<NativeScopePort['bind']>().mockReturnValue(held.promise)
    const f = fixture({ status, bind })
    const publications: NativeScopeSnapshot[] = []
    const stop = f.source.subscribe(() => { publications.push(f.source.getSnapshot()) })
    let action: Promise<boolean> | undefined
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      action = f.source.act(join)
      f.resets.set(1)
      expect(f.source.getSnapshot()).toMatchObject({ pending: true, issue: 'unknown', observation: null })
      expect(status).toHaveBeenCalledOnce()
      const afterReset = publications.length
      held.reject(new Error('The old connection closed after sending'))
      expect(await action).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', pending: false, observation: next }) })
      expect(publications.slice(afterReset).every(snapshot => !snapshot.pending)).toBe(true)
      expect(bind).toHaveBeenCalledOnce()
      expect(status).toHaveBeenCalledTimes(2)
    } finally { held.resolve(ok(bound)); await action; stop() }
  })

  it('keeps a detached mutation outcome silent and resumes observation when mounted again', async () => {
    const held = Promise.withResolvers<RemoteResult<ScopeAgentBindingStatus>>()
    const bind = vi.fn<NativeScopePort['bind']>().mockReturnValue(held.promise)
    const f = fixture({ bind })
    const listener = vi.fn()
    const stop = f.source.subscribe(listener)
    let action: Promise<boolean> | undefined
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      action = f.source.act(join)
      stop()
      const detached = f.source.getSnapshot()
      const notifications = listener.mock.calls.length
      held.reject(new Error('The detached connection closed'))
      expect(await action).toBe(false)
      expect(f.source.getSnapshot()).toBe(detached)
      expect(listener).toHaveBeenCalledTimes(notifications)
      expect(f.port.status).toHaveBeenCalledOnce()
      const stopAgain = f.source.subscribe(listener)
      try {
        await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', pending: false, issue: null }) })
        expect(f.port.status).toHaveBeenCalledTimes(2)
        expect(bind).toHaveBeenCalledOnce()
      } finally { stopAgain() }
    } finally { held.resolve(ok(bound)); await action; stop() }
  })

  it('resumes only on an explicit current binding intent and publishes the subsequent status observation', async () => {
    const automatic = { goal: 'Maintain the current Task', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 1000 }
    const paused = observation({ ...bound, mode: 'paused' }, 5)
    const next = observation({ ...bound, mode: 'enabled', automatic }, 6)
    const status = vi.fn<NativeScopePort['status']>().mockResolvedValueOnce(ok(paused)).mockResolvedValue(ok(next))
    const resume = vi.fn<NativeScopePort['resume']>().mockResolvedValue(ok(state))
    const f = fixture({ status, resume })
    const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(resume).not.toHaveBeenCalled()
      expect(await f.source.act({ kind: 'resume', expectedBindingId: bound.binding!.id, automatic })).toBe(true)
      expect(resume).toHaveBeenCalledExactlyOnceWith({ agentId: state.agentId, expectedBindingId: bound.binding!.id, automatic })
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', observation: next }) })
      expect(f.port.bind).not.toHaveBeenCalled()
    } finally { stop() }
  })

  it('owns listeners only while mounted and never creates a cold Agent', async () => {
    const f = fixture({ status: vi.fn(async () => ok<ScopeAgentStatusResult>({ agentId: state.agentId, eligibility: 'not-live' })) })
    expect(f.port.status).not.toHaveBeenCalled()
    const stop = f.source.subscribe(vi.fn())
    await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
    expect(await f.source.act(join)).toBe(false)
    expect(f.port.bind).not.toHaveBeenCalled()
    stop()
    expect([f.connection.count(), f.projection.count(), f.evidence.count(),
      f.contextProgress.count(), f.session.count(), f.resets.count()]).toEqual([0, 0, 0, 0, 0, 0])
  })
  it('rejects reads overtaken by a projection and keeps the later watermark', async () => {
    const old = Promise.withResolvers<RemoteResult<ScopeAgentStatusResult>>()
    const status = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok(observation(bound, 9)))
    const f = fixture({ status }); const stop = f.source.subscribe(vi.fn())
    try {
      f.projection.set(bound)
      old.resolve(ok(observation(state, 3)))
      await vi.waitFor(() => { expect(f.source.getSnapshot().observation).toEqual(observation(bound, 9)) })
      status.mockResolvedValue(ok(observation(state, 2)))
      f.source.refresh()
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('error') })
      expect(f.source.getSnapshot().observation).toEqual(observation(bound, 9))
    } finally { stop() }
  })
  it('refreshes on evidence-only changes and rejects the overtaken status reply', async () => {
    const old = Promise.withResolvers<RemoteResult<ScopeAgentStatusResult>>()
    const status = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok(observation(bound, 12)))
    const f = fixture({ status }); const stop = f.source.subscribe(vi.fn())
    try {
      expect(f.evidence.count()).toBe(1)
      f.evidence.set({ evaluation: 'suppress-unchanged' })
      old.resolve(ok(observation(bound, 10)))
      await vi.waitFor(() => { expect(f.source.getSnapshot().observation).toEqual(observation(bound, 12)) })
      expect(status).toHaveBeenCalledTimes(2)
      expect(f.port.bind).not.toHaveBeenCalled()
      expect(f.port.resume).not.toHaveBeenCalled()
    } finally { old.resolve(ok(observation())); stop() }
    expect(f.evidence.count()).toBe(0)
  })
  it('refreshes completed steps while still running and discards a status overtaken by the new context', async () => {
    const old = Promise.withResolvers<RemoteResult<ScopeAgentStatusResult>>()
    const next = { ...observation(bound, 14), recordedContext }
    const status = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok(next))
    const f = fixture({ status })
    f.session.set({ running: true })
    f.contextProgress.set({ steps: 0 })
    const ready: (ScopeAgentStatusResult | null)[] = []
    const stop = f.source.subscribe(() => {
      const snapshot = f.source.getSnapshot()
      if (snapshot.phase === 'ready') ready.push(snapshot.observation)
    })
    try {
      f.contextProgress.set({ steps: 1 })
      f.contextProgress.set({ steps: 1 })
      old.resolve(ok(observation(bound, 11)))
      await vi.waitFor(() => { expect(f.source.getSnapshot().observation).toEqual(next) })
      expect(ready).toEqual([next])
      expect(status).toHaveBeenCalledTimes(2)
      f.contextProgress.set({ steps: 1 })
      expect(status).toHaveBeenCalledTimes(2)
      f.contextProgress.set({ steps: 2 })
      await vi.waitFor(() => { expect(status).toHaveBeenCalledTimes(3) })
      expect(f.session.getSnapshot().running).toBe(true)
      expect(f.port.bind).not.toHaveBeenCalled()
      expect(f.port.resume).not.toHaveBeenCalled()
    } finally { old.resolve(ok(observation())); stop() }
    expect(f.contextProgress.count()).toBe(0)
  })

  it('resets the step observation when reconnecting to a changed projection', async () => {
    const f = fixture()
    f.contextProgress.set({ steps: 8 })
    const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      f.connection.set(undefined)
      f.contextProgress.set(undefined)
      f.contextProgress.set({ steps: 0 })
      f.connection.set({ id: 2 })
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const calls = vi.mocked(f.port.status).mock.calls.length
      f.contextProgress.set({ steps: 0 })
      expect(f.port.status).toHaveBeenCalledTimes(calls)
      f.contextProgress.set({ steps: 1 })
      await vi.waitFor(() => { expect(f.port.status).toHaveBeenCalledTimes(calls + 1) })
    } finally { stop() }
  })

  it('clears trusted display while disconnected and discards prior connection replies', async () => {
    const old = Promise.withResolvers<RemoteResult<ScopeAgentStatusResult>>()
    const f = fixture({ status: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok(observation(bound, 2))) })
    const stop = f.source.subscribe(vi.fn())
    try {
      f.connection.set(undefined)
      expect(f.source.getSnapshot()).toMatchObject({ phase: 'disconnected', observation: null })
      expect(await f.source.act(join)).toBe(false)
      f.connection.set({ id: 2 })
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      old.resolve(ok(observation(state, 100)))
      await old.promise
      expect(f.source.getSnapshot().observation).toEqual(observation(bound, 2))
    } finally { stop() }
  })

  it.each([
    { kind: 'remote', label: 'an unavailable service', error: new RemoteError('gateway/service-unavailable', 'Service is not mounted',
      { endpoint: 'scopeAgentContext/status' }), phase: 'unavailable' },
    { kind: 'remote', label: 'an unavailable method', error: new RemoteError('gateway/method-unavailable', 'Method is not mounted',
      { endpoint: 'scopeAgentContext/status' }), phase: 'unavailable' },
    { kind: 'remote', label: 'a Host read failure', error: new RemoteError('gateway/internal', 'Status read failed', {}), phase: 'error' },
    { kind: 'rejected', label: 'a rejected transport', error: new Error('Connection closed during status read'), phase: 'error' },
  ] as const)('recovers from $label on the next connection without starting work', async (failure) => {
    const next = observation(bound, 2)
    const status = vi.fn<NativeScopePort['status']>().mockImplementationOnce(async () => {
      if (failure.kind === 'rejected') throw failure.error
      return { ok: false, error: failure.error }
    }).mockResolvedValue(ok(next))
    const f = fixture({ status })
    const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: failure.phase, observation: null }) })
      expect(await f.source.act(join)).toBe(false)
      f.connection.set({ id: 2 })
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', observation: next }) })
      expect(status).toHaveBeenCalledTimes(2)
      expect(f.port.bind).not.toHaveBeenCalled()
      expect(f.port.resume).not.toHaveBeenCalled()
    } finally { stop() }
  })

  it('ignores a previous connection rejection after the current connection has published ready', async () => {
    const old = Promise.withResolvers<RemoteResult<ScopeAgentStatusResult>>()
    const next = observation(bound, 2)
    const status = vi.fn<NativeScopePort['status']>().mockReturnValueOnce(old.promise).mockResolvedValue(ok(next))
    const f = fixture({ status })
    const listener = vi.fn()
    const stop = f.source.subscribe(listener)
    try {
      f.connection.set({ id: 2 })
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', observation: next }) })
      const current = f.source.getSnapshot()
      const notifications = listener.mock.calls.length
      old.reject(new Error('Previous connection closed'))
      await expect(old.promise).rejects.toThrow('Previous connection closed')
      expect(f.source.getSnapshot()).toBe(current)
      expect(listener).toHaveBeenCalledTimes(notifications)
      expect(status).toHaveBeenCalledTimes(2)
      expect(f.port.bind).not.toHaveBeenCalled()
      expect(f.port.resume).not.toHaveBeenCalled()
    } finally { old.resolve(ok(observation())); stop() }
  })

  it('serializes same-frame mutation clicks and recovers a lost reply by reading, never rebinding', async () => {
    const result = Promise.withResolvers<RemoteResult<ScopeAgentBindingStatus>>()
    const status = vi.fn().mockResolvedValueOnce(ok(observation())).mockResolvedValue(ok(observation(bound, 2)))
    const f = fixture({ status, bind: vi.fn(() => result.promise) }); const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const first = f.source.act(join)
      expect(await f.source.act(join)).toBe(false)
      result.reject(new Error('reply lost'))
      expect(await first).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', observation: observation(bound, 2), issue: 'unknown' }) })
      expect(f.port.bind).toHaveBeenCalledOnce()
      expect(await f.source.act(join)).toBe(false)
      expect(f.port.bind).toHaveBeenCalledOnce()
    } finally { stop() }
  })
  it('keeps a sent mutation locked through reset, ignores its stale success, and reconciles afterward', async () => {
    const result = Promise.withResolvers<RemoteResult<ScopeAgentBindingStatus>>()
    const f = fixture({ bind: () => result.promise }); const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const action = f.source.act(join)
      f.resets.set(1)
      expect(f.source.getSnapshot()).toMatchObject({ pending: true, observation: null })
      expect(await f.source.act(join)).toBe(false)
      result.resolve(ok(bound))
      expect(await action).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(f.source.getSnapshot().observation).toEqual(observation())
    } finally { stop() }
  })
  it('preserves exact binding expectations and uses status, never mutation return state', async () => {
    const f = fixture({ status: async () => ok(observation(bound, 5)), pause: vi.fn(async () => ok(state)) })
    const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      await f.source.act({ kind: 'pause', expectedBindingId: bound.binding!.id })
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(f.port.pause).toHaveBeenCalledWith({ agentId: state.agentId, expectedBindingId: bound.binding!.id })
      expect(f.source.getSnapshot().observation).toEqual(observation(bound, 5))
    } finally { stop() }
  })
  it('discards unmounted reads and suppresses detached mutations', async () => {
    const read = Promise.withResolvers<RemoteResult<ScopeAgentStatusResult>>()
    const f = fixture({ status: () => read.promise }); const listener = vi.fn(); const stop = f.source.subscribe(listener)
    stop(); const before = listener.mock.calls.length
    read.resolve(ok(observation(bound)))
    await read.promise
    expect(listener).toHaveBeenCalledTimes(before)
    expect(await f.source.act(join)).toBe(false)
  })
  it('refreshes live eligibility after a normal turn without issuing a model request', async () => {
    const f = fixture(); const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      f.session.set({ running: true })
      await vi.waitFor(() => { expect(f.port.status).toHaveBeenCalledTimes(2) })
      expect(f.port.bind).not.toHaveBeenCalled()
    } finally { stop() }
  })
  it('requires the exact local target for added reading and keeps combined departure separate from whole-Task leave', async () => {
    const f = fixture({ status: async () => ok(localObservation()) }); const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const request = { invitation, automatic: null, expectedBindingId: null }
      expect(await f.source.act({ kind: 'bind', request })).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'bind', request: { ...request, localTask: { ...target,
        expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 999 } } } })).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'bind', request: { ...request, localTask: target } })).toBe(true)
      expect(f.port.bind).toHaveBeenCalledExactlyOnceWith({ ...request, localTask: target, agentId: state.agentId })
    } finally { stop() }
    const combined = fixture({ status: async () => ok(localObservation(compositeExecution)) })
    const stopCombined = combined.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(combined.source.getSnapshot().phase).toBe('ready') })
      const expectedBindingId = compositeExecution.binding!.id
      expect(await combined.source.act({ kind: 'leaveLocalTask', request: { ...target, expectedBindingId } })).toBe(false)
      expect(await combined.source.act({ kind: 'bindLocal', request: { ...target, expectedBindingId, automatic: null } })).toBe(false)
      expect(combined.port.leaveLocalTask).not.toHaveBeenCalled()
      expect(combined.port.bindLocal).not.toHaveBeenCalled()
      expect(await combined.source.act({ kind: 'leave', expectedBindingId })).toBe(true)
      expect(combined.port.leave).toHaveBeenCalledExactlyOnceWith({ agentId: state.agentId, expectedBindingId })
    } finally { stopCombined() }
  })

  it('guards local bind and departure by Task epoch even before an automatic binding exists', async () => {
    const f = fixture({ status: async () => ok(localObservation()) }); const stop = f.source.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const request = { ...target, expectedBindingId: null }
      expect(await f.source.act({ kind: 'bindLocal', request: { ...request, automatic: null } })).toBe(true)
      expect(f.port.bindLocal).toHaveBeenCalledExactlyOnceWith({ ...request, automatic: null, agentId: state.agentId })
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'leaveLocalTask', request: { ...request,
        expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 999 } } })).toBe(false)
      expect(f.port.leaveLocalTask).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'leaveLocalTask', request })).toBe(true)
      expect(f.port.leaveLocalTask).toHaveBeenCalledExactlyOnceWith({ ...request, agentId: state.agentId })
    } finally { stop() }
  })

  it('invalidates local commands after an assignment notification and ignores a prior-generation success', async () => {
    const held = Promise.withResolvers<RemoteResult<ScopeAgentBindingStatus>>()
    const status = vi.fn(async () => ok(localObservation()))
    const f = fixture({ status, bindLocal: vi.fn(() => held.promise) }); const stop = f.source.subscribe(vi.fn())
    const request = { ...target, expectedBindingId: null, automatic: null }
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const first = f.source.act({ kind: 'bindLocal', request })
      f.resets.set(1)
      f.assignments.set(1)
      expect(f.source.getSnapshot().pending).toBe(true)
      expect(await f.source.act({ kind: 'bindLocal', request })).toBe(false)
      const next = localObservation(state, { ...target, expectedBindingEpoch: { ...target.expectedBindingEpoch, seq: 22 } })
      status.mockResolvedValue(ok(next))
      held.resolve(ok(bound))
      expect(await first).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', observation: next }) })
      expect(await f.source.act({ kind: 'bindLocal', request })).toBe(false)
      expect(f.port.bindLocal).toHaveBeenCalledOnce()
    } finally { held.resolve(ok(bound)); stop() }
  })

})

describe('existing read route recovery', () => {
  it('rejects a stale read-state cursor and keeps a sent route mutation locked across reconnect', async () => {
    const current = observation({ ...bound, mode: 'paused', usedBudget: 1, automatic: {
      goal: 'Maintain the client', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 1000,
    } }, 7)
    const pending = Promise.withResolvers<RemoteResult<ScopeAgentBindingStatus>>()
    const f = fixture({ status: vi.fn(async () => ok(current)), updateRoute: vi.fn(() => pending.promise) })
    const dispose = f.source.subscribe(vi.fn())
    const request = { expectedBindingId: bound.binding!.id, expectedReadStateSeq: current.readStateSeq,
      ownerAddress: '/ip4/127.0.0.1/tcp/4568/p2p/owner-peer' }
    try {
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      expect(await f.source.act({ kind: 'updateRoute', request: { ...request, expectedReadStateSeq: observation().readStateSeq } })).toBe(false)
      expect(f.port.updateRoute).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
      const sent = f.source.act({ kind: 'updateRoute', request })
      f.connection.set({ id: 2 })
      expect(await f.source.act({ kind: 'updateRoute', request })).toBe(false)
      expect(f.port.updateRoute).toHaveBeenCalledExactlyOnceWith({ ...request, agentId: state.agentId })
      expect(f.port.bind).not.toHaveBeenCalled()
      expect(f.port.resume).not.toHaveBeenCalled()
      pending.resolve(ok(current.state)); expect(await sent).toBe(false)
      await vi.waitFor(() => { expect(f.source.getSnapshot()).toMatchObject({ phase: 'ready', pending: false }) })
    } finally { dispose() }
  })
})
