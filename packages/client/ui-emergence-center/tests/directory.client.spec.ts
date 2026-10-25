import { afterEach, describe, expect, it, type Mocked, vi } from 'vitest'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomDirectorySnapshot,
  DevelopmentTaskAssignment,
  DevelopmentTaskBindingId,
  DevelopmentTaskId,
  DevelopmentTaskLineageSnapshot,
  DevelopmentTaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createParticipantDirectory, type ParticipantDirectoryPort } from '../src/client/participant-directory.ts'
import { createDevelopmentTaskDirectory, type DevelopmentTaskDirectoryPort } from '../src/client/task-directory.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const HUMAN = 'human-one' as DevelopmentParticipantId
const AGENT = 'agent-one' as DevelopmentParticipantId
const NODE = 'node-one' as DevelopmentNodeId
const ROOT = 'task-root' as DevelopmentTaskId
const binding = (value: string): DevelopmentTaskBindingId => value as DevelopmentTaskBindingId
const EMPTY: DevelopmentRoomDirectorySnapshot = { nodeId: NODE, presenceTtlMs: 9_000, participants: [], rooms: [] }

function task(id: DevelopmentTaskId = ROOT): DevelopmentTaskSnapshot {
  return {
    id,
    ownerNodeId: NODE,
    revision: 1,
    origin: { kind: 'root' },
    hiddenRoomId: `room-${id}` as DevelopmentTaskSnapshot['hiddenRoomId'],
    runtime: 'ready',
    objective: 'Ship Task lineage',
    scope: 'Task UI',
    createdBy: HUMAN,
    context: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function participantPort(): Mocked<ParticipantDirectoryPort> {
  return {
    list: vi.fn(async () => EMPTY),
    announce: vi.fn(async request => ({
      ...EMPTY,
      participants: [{ ...request, nodeId: NODE, presence: 'online' as const, lastSeenAt: 1 }],
    })),
    heartbeat: vi.fn(async () => EMPTY),
    withdraw: vi.fn(async () => EMPTY),
  }
}

function taskPort(): Mocked<DevelopmentTaskDirectoryPort> {
  return {
    list: vi.fn(async () => [task()]),
    lineage: vi.fn(async () => ({ tasks: [task()], boundaryTaskIds: ['task-parent' as DevelopmentTaskId] })),
    create: vi.fn(async () => task('task-created' as DevelopmentTaskId)),
    assignmentList: vi.fn(async () => []),
  }
}

describe('Emergence Center directories', () => {
  it('keeps Room data hidden while renewing the browser presence lease', async () => {
    vi.useFakeTimers()
    const remote = participantPort()
    const { announce, heartbeat, withdraw } = remote
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: '' }, vi.fn())
    await directory.setProfile({ id: HUMAN, displayName: 'Jet' })
    expect(directory.getSnapshot()).not.toHaveProperty('rooms')
    expect(announce).toHaveBeenCalledWith({ id: HUMAN, kind: 'human', displayName: 'Jet' })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(heartbeat).toHaveBeenCalledWith({ participantId: HUMAN })
    await directory.dispose()
    expect(withdraw).toHaveBeenCalledWith({ participantId: HUMAN })
  })

  it('loads 200 current Tasks and expands a bounded 4/2 lineage neighborhood', async () => {
    const remote = taskPort()
    const { lineage, list } = remote
    const sibling = task('task-sibling' as DevelopmentTaskId)
    list.mockResolvedValueOnce([task(), sibling])
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    expect(list).toHaveBeenCalledWith({ limit: 200 })

    await directory.focus(ROOT)
    expect(lineage).toHaveBeenCalledWith({ taskId: ROOT, ancestorDepth: 4, descendantDepth: 2, limit: 500 })
    expect(directory.getSnapshot().boundaryTaskIds).toEqual(['task-parent'])
    expect(directory.getSnapshot().graphTasks.map(item => item.id)).toEqual([ROOT])
    expect(directory.getSnapshot().tasks.map(item => item.id)).toEqual([ROOT, sibling.id])
  })

  it('tracks independent session bindings instead of replacing every binding for one Agent', async () => {
    const remote = taskPort()
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const first: DevelopmentTaskAssignment = {
      bindingId: binding('binding-one'), participantId: AGENT, taskId: ROOT, assignedAt: 2,
    }
    const second: DevelopmentTaskAssignment = {
      bindingId: binding('binding-two'), participantId: AGENT, taskId: ROOT, assignedAt: 3,
    }
    directory.applyAssignment(first, first.bindingId)
    directory.applyAssignment(second, second.bindingId)
    expect(directory.getSnapshot().assignments).toEqual([first, second])
    directory.applyAssignment(undefined, first.bindingId)
    expect(directory.getSnapshot().assignments).toEqual([second])
  })

  it('reannounces on reset and renews presence after a failed heartbeat', async () => {
    vi.useFakeTimers()
    const remote = participantPort()
    remote.heartbeat.mockRejectedValueOnce(new Error('offline'))
    remote.withdraw.mockRejectedValueOnce(new Error('connection closed'))
    const report = vi.fn()
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: 'Jet' }, report)
    directory.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(remote.announce).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(report).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(remote.heartbeat).toHaveBeenCalledTimes(2)
    directory.reset()
    await vi.advanceTimersByTimeAsync(0)
    expect(remote.announce).toHaveBeenCalledTimes(2)
    await directory.dispose()
    expect(remote.withdraw).toHaveBeenCalledWith({ participantId: HUMAN })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('updates only the announced participant while a blank profile owns no lease', async () => {
    const remote = participantPort()
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: '' }, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const human = { id: HUMAN, nodeId: NODE, kind: 'human' as const, displayName: 'Jet', presence: 'online' as const, lastSeenAt: 1 }
    const agent = { ...human, id: AGENT, displayName: 'Agent' }
    directory.applyPresence(human)
    directory.applyPresence(agent)
    directory.applyPresence({ ...human, displayName: 'Updated' })
    expect(directory.getSnapshot().participants).toEqual([{ ...human, displayName: 'Updated' }, agent])
    expect(Object.isFrozen(directory.getSnapshot().participants[0])).toBe(true)
    await directory.dispose()
    expect(remote.withdraw).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('discards a participant read from a reset connection after %s', async (outcome) => {
    const stale = Promise.withResolvers<DevelopmentRoomDirectorySnapshot>()
    const current = Promise.withResolvers<DevelopmentRoomDirectorySnapshot>()
    const remote = participantPort()
    remote.list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
    const report = vi.fn()
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: '' }, report)
    directory.reset()
    if (outcome === 'success') stale.resolve(EMPTY)
    else stale.reject(new Error('old connection'))
    await Promise.resolve()
    await Promise.resolve()
    directory.refresh()
    expect(remote.list).toHaveBeenCalledTimes(2)
    expect(directory.getSnapshot().read).toBe(false)
    expect(report).not.toHaveBeenCalled()
    current.resolve(EMPTY)
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    await directory.dispose()
  })

  it.each([new Error('offline'), 'offline'])('retains a current participant transport error %s', async (failure) => {
    const remote = participantPort()
    remote.list.mockRejectedValueOnce(failure)
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: '' }, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().error).toBe('offline') })
    await directory.dispose()
  })

  it('updates current Task cards and appends created Tasks to the bounded graph', async () => {
    const directory = createDevelopmentTaskDirectory(taskPort(), vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const updated = { ...task(), revision: 2 }
    directory.applyTask(updated)
    expect(directory.getSnapshot().graphTasks).toEqual([updated])
    const incoming = task('task-new' as DevelopmentTaskId)
    directory.applyTask(incoming)
    expect(directory.getSnapshot().tasks).toEqual([incoming, updated])
    expect(directory.getSnapshot().graphTasks).toEqual([updated])
    const created = await directory.create({ origin: { kind: 'root' }, createdBy: HUMAN, objective: 'Created', scope: 'Client' })
    expect(directory.getSnapshot().graphTasks).toEqual([created, updated])
    expect(Object.isFrozen(directory.getSnapshot().graphTasks[0]?.origin)).toBe(true)
  })

  it('ignores a lineage response after the connection resets', async () => {
    const stale = Promise.withResolvers<DevelopmentTaskLineageSnapshot>()
    const remote = taskPort()
    remote.lineage.mockReturnValueOnce(stale.promise)
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const focusing = directory.focus(ROOT)
    directory.reset()
    stale.resolve({ tasks: [task('old-task' as DevelopmentTaskId)], boundaryTaskIds: [] })
    await focusing
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    expect(directory.getSnapshot().graphTasks).toEqual([task()])
  })

  it.each(['success', 'failure'])('discards a Task read from a reset connection after %s', async (outcome) => {
    const stale = Promise.withResolvers<readonly DevelopmentTaskSnapshot[]>()
    const current = Promise.withResolvers<readonly DevelopmentTaskSnapshot[]>()
    const remote = taskPort()
    remote.list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
    const report = vi.fn()
    const directory = createDevelopmentTaskDirectory(remote, report)
    directory.refresh()
    directory.reset()
    if (outcome === 'success') stale.resolve([task()])
    else stale.reject(new Error('old connection'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    directory.refresh()
    expect(remote.list).toHaveBeenCalledTimes(2)
    expect(directory.getSnapshot().read).toBe(false)
    expect(report).not.toHaveBeenCalled()
    current.resolve([task()])
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
  })

  it.each([new Error('offline'), 'offline'])('retains a current Task transport error %s', async (failure) => {
    const remote = taskPort()
    remote.list.mockRejectedValueOnce(failure)
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().error).toBe('offline') })
  })
})
