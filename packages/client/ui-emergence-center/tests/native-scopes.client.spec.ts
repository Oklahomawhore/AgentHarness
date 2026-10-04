import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult, ScopeAgentStatusResult, ScopeAgentBindingStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { createNativeScopeSource, type NativeScopePort } from '../src/client/native-scopes.ts'
import { localObservation, target } from './native-local-automatic-fixture.client.ts'
import { bound, invitation, observation, observable, state } from './native-scope-fixture.client.ts'

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
function fixture(overrides: Partial<NativeScopePort> = {}) {
  const projection = observable<unknown>(undefined)
  const session = observable({ running: false })
  const connection = observable<{ id: number } | undefined>({ id: 1 })
  const resets = observable(0)
  const assignments = observable(0)
  const port: NativeScopePort = { updateRoute: vi.fn(async () => ok(bound)), bindLocal: vi.fn(async () => ok(bound)),
    leaveLocalTask: vi.fn(async () => ok(state)),
    status: vi.fn(async () => ok(observation())), bind: vi.fn(async () => ok(bound)),
    pause: vi.fn(async () => ok(bound)), resume: vi.fn(async () => ok(bound)), leave: vi.fn(async () => ok(state)), ...overrides }
  const source = createNativeScopeSource({ agentId: state.agentId, port, projection, session, connection,
    subscribeAssignments: listener => assignments.subscribe(listener), subscribeReset: listener => resets.subscribe(listener) })
  return { source, port, projection, session, connection, resets, assignments }
}
const join = { kind: 'bind', request: { invitation, automatic: null, expectedBindingId: null } } as const

describe('native scope source', () => {
  it('owns listeners only while mounted and never creates a cold Agent', async () => {
    const f = fixture({ status: vi.fn(async () => ok<ScopeAgentStatusResult>({ agentId: state.agentId, eligibility: 'not-live' })) })
    expect(f.port.status).not.toHaveBeenCalled()
    const stop = f.source.subscribe(vi.fn())
    await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
    expect(await f.source.act(join)).toBe(false)
    expect(f.port.bind).not.toHaveBeenCalled()
    stop()
    expect([f.connection.count(), f.projection.count(), f.session.count(), f.resets.count()]).toEqual([0, 0, 0, 0])
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
