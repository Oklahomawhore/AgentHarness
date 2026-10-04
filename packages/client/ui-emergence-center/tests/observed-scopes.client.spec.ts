import { describe, expect, it, vi } from 'vitest'
import type {
  DevelopmentNodeId, DevelopmentParticipantId, DevelopmentTaskBindingId, DevelopmentTaskId,
  DevelopmentTaskObservedCandidate, DevelopmentTaskObservedInterval, DevelopmentTaskObservedIntervalId,
  DevelopmentTaskObservedReceipt,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createObservedScopeDirectory, type ObservedScopePort } from '../src/client/observed-scopes.ts'

const TASK = 'task-a' as DevelopmentTaskId
const OTHER = 'task-b' as DevelopmentTaskId
const NODE = 'node-b' as DevelopmentNodeId
const CANDIDATE: DevelopmentTaskObservedCandidate = {
  taskId: TASK, sourceNodeId: NODE, participantId: 'agent-b' as DevelopmentParticipantId,
  bindingId: 'binding-b' as DevelopmentTaskBindingId, expectedBindingEpoch: { nodeId: NODE, seq: 2 }, sessionLabel: 'Claude B',
}
const RECEIPT: DevelopmentTaskObservedReceipt = {
  taskId: TASK, ownerNodeId: 'node-a' as DevelopmentNodeId, intervalId: 'interval' as DevelopmentTaskObservedIntervalId,
  revision: 2, event: { nodeId: 'node-a' as DevelopmentNodeId, seq: 2 },
}
const ACTIVE: DevelopmentTaskObservedInterval = { ...CANDIDATE, id: RECEIPT.intervalId, state: 'active', approvalReceipt: RECEIPT }
const END = { ...RECEIPT, revision: 3, event: { ...RECEIPT.event, seq: 3 } }
const ENDED: DevelopmentTaskObservedInterval = { ...ACTIVE, state: 'ended', endReceipt: END }

function port(overrides: Partial<ObservedScopePort> = {}): ObservedScopePort {
  return { candidates: async () => [CANDIDATE], intervals: async () => [], approve: async () => ACTIVE, end: async () => END, ...overrides }
}

describe('Owner observation directory', () => {
  it('rejects a previous Task query after selection changes and does not carry old candidates', async () => {
    const old = Promise.withResolvers<readonly DevelopmentTaskObservedCandidate[]>()
    const directory = createObservedScopeDirectory(port({
      candidates: request => request.taskId === TASK ? old.promise : Promise.resolve([]),
    }), vi.fn())
    directory.focus(TASK)
    directory.focus(OTHER)
    await vi.waitFor(() => { expect(directory.getSnapshot()).toEqual({ taskId: OTHER, candidates: [], intervals: [], status: 'ready' }) })
    old.resolve([CANDIDATE])
    await old.promise
    expect(directory.getSnapshot().candidates).toEqual([])
    directory.dispose()
  })

  it('coalesces an event arriving during an owner read and discards the stale result', async () => {
    const old = Promise.withResolvers<readonly DevelopmentTaskObservedInterval[]>()
    const intervals = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue([ENDED])
    const directory = createObservedScopeDirectory(port({ intervals }), vi.fn())
    directory.focus(TASK)
    directory.refresh()
    directory.refresh()
    expect(intervals).toHaveBeenCalledOnce()
    old.resolve([ACTIVE])
    await vi.waitFor(() => { expect(directory.getSnapshot().intervals).toEqual([ENDED]) })
    expect(intervals).toHaveBeenCalledTimes(2)
    directory.dispose()
  })

  it('retains termination when the approval response arrives later', async () => {
    const approval = Promise.withResolvers<DevelopmentTaskObservedInterval>()
    let current: readonly DevelopmentTaskObservedInterval[] = []
    const directory = createObservedScopeDirectory(port({
      intervals: async () => current, approve: () => approval.promise,
      end: async () => { current = [ENDED]; return END },
    }), vi.fn())
    directory.focus(TASK)
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('ready') })
    const approving = directory.approve(CANDIDATE)
    await directory.end(CANDIDATE)
    approval.resolve(ACTIVE)
    await approving
    await vi.waitFor(() => { expect(directory.getSnapshot().intervals).toEqual([ENDED]) })
    directory.dispose()
  })

  it('reads the durable owner result after an acknowledged write loses its response', async () => {
    let current: readonly DevelopmentTaskObservedInterval[] = []
    const directory = createObservedScopeDirectory(port({
      intervals: async () => current, approve: async () => { current = [ACTIVE]; throw new Error('connection lost') },
    }), vi.fn())
    directory.focus(TASK)
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('ready') })
    await expect(directory.approve(CANDIDATE)).rejects.toThrow('connection lost')
    await vi.waitFor(() => { expect(directory.getSnapshot().intervals).toEqual([ACTIVE]) })
    directory.dispose()
  })

  it('isolates subscriber errors and ignores prior connection results after reset and disposal', async () => {
    const old = Promise.withResolvers<readonly DevelopmentTaskObservedInterval[]>()
    const report = vi.fn(() => { throw new Error('diagnostic consumer failed') })
    const directory = createObservedScopeDirectory(port({ intervals: () => old.promise }), report)
    directory.subscribe(() => { throw new Error('subscriber failed') })
    const listener = vi.fn()
    directory.subscribe(listener)
    directory.focus(TASK)
    directory.reset()
    const snapshot = directory.getSnapshot()
    directory.dispose()
    old.resolve([ACTIVE])
    await old.promise
    expect(directory.getSnapshot()).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(2)
    await expect(directory.approve(CANDIDATE)).rejects.toThrow('disposed')
  })

  it('reports owner read failure and retries explicitly', async () => {
    const error = new Error('offline')
    const intervals = vi.fn().mockRejectedValueOnce(error).mockResolvedValue([ACTIVE])
    const report = vi.fn()
    const directory = createObservedScopeDirectory(port({ intervals }), report)
    directory.focus(TASK)
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('error') })
    expect(report).toHaveBeenCalledWith(error)
    directory.refresh()
    await vi.waitFor(() => { expect(directory.getSnapshot().intervals).toEqual([ACTIVE]) })
    directory.dispose()
  })
})
