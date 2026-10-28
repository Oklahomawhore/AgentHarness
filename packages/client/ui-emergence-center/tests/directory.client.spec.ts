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

  it('uses Host defaults for the Task catalog and focused lineage neighborhood', async () => {
    const remote = taskPort()
    const { lineage, list } = remote
    const sibling = task('task-sibling' as DevelopmentTaskId)
    list.mockResolvedValueOnce([task(), sibling])
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const changes = vi.fn()
    const unsubscribe = directory.subscribe(changes)
    expect(list).toHaveBeenCalledWith({})

    await directory.focus(ROOT)
    expect(lineage).toHaveBeenCalledWith({ taskId: ROOT })
    expect(directory.getSnapshot().boundaryTaskIds).toEqual(['task-parent'])
    expect(directory.getSnapshot().graphTasks.map(item => item.id)).toEqual([ROOT])
    expect(directory.getSnapshot().tasks.map(item => item.id)).toEqual([ROOT, sibling.id])
    expect(changes).toHaveBeenCalledOnce()
    unsubscribe()
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

  it.each([false, true])('retains the latest lineage request when an older reply arrives last (same Task: %s)', async (sameTask) => {
    const remote = taskPort()
    const stale = Promise.withResolvers<DevelopmentTaskLineageSnapshot>()
    remote.lineage.mockReturnValueOnce(stale.promise)
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const first = directory.focus(ROOT)
    const selected = { ...task(sameTask ? ROOT : 'selected-task' as DevelopmentTaskId), revision: 2 }
    remote.lineage.mockResolvedValueOnce({ tasks: [selected], boundaryTaskIds: [selected.id] })
    await directory.focus(selected.id)
    stale.resolve({ tasks: [task()], boundaryTaskIds: [] })
    await first
    expect(directory.getSnapshot().graphTasks).toEqual([selected])
    expect(directory.getSnapshot().boundaryTaskIds).toEqual([selected.id])
  })

  it('retains focused lineage and its selected Task when the initial catalog arrives later', async () => {
    const remote = taskPort()
    const catalog = Promise.withResolvers<readonly DevelopmentTaskSnapshot[]>()
    remote.list.mockReturnValueOnce(catalog.promise)
    const selected = task('outside-catalog' as DevelopmentTaskId)
    remote.lineage.mockResolvedValue({ tasks: [selected], boundaryTaskIds: [ROOT] })
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await directory.focus(selected.id)
    catalog.resolve([task()])
    await vi.waitFor(() => { expect(directory.getSnapshot().tasks.some(item => item.id === ROOT)).toBe(true) })
    expect(directory.getSnapshot().tasks).toContainEqual(selected)
    expect(directory.getSnapshot().graphTasks).toEqual([selected])
    expect(directory.getSnapshot().boundaryTaskIds).toEqual([ROOT])
  })

  it('refreshes the selected lineage and retains it across a connection reset', async () => {
    const remote = taskPort()
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const selected = task('outside-catalog' as DevelopmentTaskId)
    remote.lineage.mockResolvedValue({ tasks: [selected], boundaryTaskIds: [ROOT] })
    await directory.focus(selected.id)
    const updated = { ...selected, revision: 2 }
    remote.lineage.mockResolvedValue({ tasks: [updated], boundaryTaskIds: [ROOT] })
    directory.refresh()
    await vi.waitFor(() => { expect(remote.list).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(directory.getSnapshot().graphTasks).toEqual([updated]) })
    expect(directory.getSnapshot().tasks).toContainEqual(updated)
    directory.reset()
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    expect(directory.getSnapshot().graphTasks).toEqual([updated])
    expect(directory.getSnapshot().boundaryTaskIds).toEqual([ROOT])
    expect(remote.lineage).toHaveBeenLastCalledWith({ taskId: selected.id })
  })

  it.each(['selection', 'connection'])('ignores a failed lineage request after its %s changes', async (changed) => {
    const remote = taskPort()
    const stale = Promise.withResolvers<DevelopmentTaskLineageSnapshot>()
    remote.lineage.mockReturnValueOnce(stale.promise)
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const first = directory.focus(ROOT)
    const result = expect(first).resolves.toBeUndefined()
    if (changed === 'selection') await directory.focus('selected-task' as DevelopmentTaskId)
    else directory.reset()
    stale.reject(new Error('old selection is unavailable'))
    await result
    remote.lineage.mockRejectedValueOnce(new Error('current selection is unavailable'))
    await expect(directory.focus(ROOT)).rejects.toThrow('current selection is unavailable')
  })

  it('retains a newer Task notification when an earlier lineage snapshot arrives later', async () => {
    const remote = taskPort()
    const lineage = Promise.withResolvers<DevelopmentTaskLineageSnapshot>()
    remote.lineage.mockReturnValueOnce(lineage.promise)
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const focusing = directory.focus(ROOT)
    const updated = { ...task(), revision: 3, objective: 'Current shared objective' }
    directory.applyTask(updated)
    lineage.resolve({ tasks: [{ ...task(), revision: 2 }], boundaryTaskIds: [] })
    await focusing
    expect(directory.getSnapshot().tasks).toEqual([updated])
    expect(directory.getSnapshot().graphTasks).toEqual([updated])
    directory.refresh()
    await vi.waitFor(() => { expect(remote.list).toHaveBeenCalledTimes(2) })
    expect(directory.getSnapshot().tasks).toEqual([updated])
  })

  it('preserves a newer catalog notification outside the selected graph during Refresh', async () => {
    const remote = taskPort()
    const directory = createDevelopmentTaskDirectory(remote, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    await directory.focus(ROOT)
    const other = { ...task('catalog-task' as DevelopmentTaskId), revision: 3 }
    directory.applyTask(other)
    remote.list.mockResolvedValueOnce([{ ...other, revision: 2 }, task()])
    directory.refresh()
    await vi.waitFor(() => { expect(remote.lineage).toHaveBeenCalledTimes(2) })
    expect(directory.getSnapshot().tasks.find(item => item.id === other.id)).toEqual(other)
    expect(directory.getSnapshot().graphTasks).toEqual([task()])
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

  it('retries a failed automatic announcement only when refreshed', async () => {
    vi.useFakeTimers()
    const remote = participantPort()
    const failure = new Error('participant limit reached')
    remote.announce.mockRejectedValueOnce(failure)
    const report = vi.fn()
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: 'Jet' }, report)
    await vi.advanceTimersByTimeAsync(0)
    expect(directory.getSnapshot().error).toBe(failure.message)
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    expect(remote.announce).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    directory.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(remote.announce).toHaveBeenCalledTimes(2)
    expect(directory.getSnapshot().error).toBeUndefined()
    expect(directory.getSnapshot().participants[0]?.displayName).toBe('Jet')
    await directory.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'])('drains an in-flight heartbeat after disposal begins with %s', async (outcome) => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<DevelopmentRoomDirectorySnapshot>()
    const remote = participantPort()
    remote.heartbeat.mockReturnValueOnce(pending.promise)
    const report = vi.fn()
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: 'Jet' }, report)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(remote.heartbeat).toHaveBeenCalledOnce()
    const retained = directory.getSnapshot()
    let closed = false
    const closing = directory.dispose().then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(false)
    expect(remote.withdraw).not.toHaveBeenCalled()
    if (outcome === 'success') pending.resolve(EMPTY)
    else pending.reject(new Error('connection closed'))
    await closing
    expect(directory.getSnapshot()).toBe(retained)
    expect(report).not.toHaveBeenCalled()
    expect(remote.withdraw).toHaveBeenCalledExactlyOnceWith({ participantId: HUMAN })
    directory.refresh()
    directory.reset()
    directory.applyPresence({ id: AGENT, nodeId: NODE, kind: 'agent', displayName: 'Late Agent', presence: 'online', lastSeenAt: 2 })
    await directory.setProfile({ id: HUMAN, displayName: 'Late profile' })
    await directory.dispose()
    await vi.advanceTimersByTimeAsync(18_000)
    expect(remote.heartbeat).toHaveBeenCalledOnce()
    expect(remote.list).toHaveBeenCalledOnce()
    expect(remote.announce).toHaveBeenCalledOnce()
    expect(remote.withdraw).toHaveBeenCalledOnce()
    expect(directory.getSnapshot()).toBe(retained)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['automatic', 'explicit'] as const)('withdraws only after an in-flight %s announcement settles', async (kind) => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<DevelopmentRoomDirectorySnapshot>()
    const remote = participantPort()
    remote.announce.mockReturnValueOnce(pending.promise)
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: kind === 'automatic' ? 'Jet' : '' }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    const announced = kind === 'explicit' ? directory.setProfile({ id: HUMAN, displayName: 'Jet' }) : Promise.resolve()
    expect(remote.announce).toHaveBeenCalledOnce()
    const retained = directory.getSnapshot()
    const closing = directory.dispose()
    expect(directory.dispose()).toBe(closing)
    let closed = false
    void closing.then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(false)
    expect(remote.withdraw).not.toHaveBeenCalled()
    pending.resolve(EMPTY)
    await Promise.all([announced, closing])
    expect(closed).toBe(true)
    expect(directory.getSnapshot()).toBe(retained)
    expect(remote.withdraw).toHaveBeenCalledExactlyOnceWith({ participantId: HUMAN })
    await vi.advanceTimersByTimeAsync(18_000)
    expect(remote.heartbeat).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['announcement', 'heartbeat'] as const)('discards a previous connection’s in-flight %s after reset', async (kind) => {
    vi.useFakeTimers()
    const stale = Promise.withResolvers<DevelopmentRoomDirectorySnapshot>()
    const remote = participantPort()
    if (kind === 'announcement') remote.announce.mockReturnValueOnce(stale.promise)
    else remote.heartbeat.mockReturnValueOnce(stale.promise)
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: 'Jet' }, vi.fn())
    await vi.advanceTimersByTimeAsync(kind === 'heartbeat' ? 3_000 : 0)
    directory.reset()
    await vi.advanceTimersByTimeAsync(0)
    expect(remote.announce).toHaveBeenCalledTimes(2)
    const retained = directory.getSnapshot()
    stale.resolve({ ...EMPTY, nodeId: 'old-node' as DevelopmentNodeId })
    await vi.advanceTimersByTimeAsync(0)
    expect(directory.getSnapshot()).toBe(retained)
    expect(vi.getTimerCount()).toBe(1)
    await directory.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['read', 'announcement', 'heartbeat', 'heartbeat failure'] as const)(
    'keeps a reset triggered by a %s observer free of the previous renewal timer', async (kind) => {
      vi.useFakeTimers()
      const pending = Promise.withResolvers<DevelopmentRoomDirectorySnapshot>()
      const remote = participantPort()
      const report = vi.fn(() => { if (kind === 'heartbeat failure') directory.reset() })
      const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: 'Jet' }, report)
      await vi.advanceTimersByTimeAsync(0)
      if (kind === 'read') remote.list.mockResolvedValueOnce(EMPTY)
      remote.list.mockReturnValueOnce(pending.promise)
      if (kind === 'heartbeat failure') remote.heartbeat.mockRejectedValueOnce(new Error('connection changed'))
      let reset = false
      const unsubscribe = directory.subscribe(() => {
        if (!reset && kind !== 'heartbeat failure') { reset = true; directory.reset() }
      })
      try {
        if (kind === 'read') directory.refresh()
        else if (kind === 'announcement') await directory.setProfile({ id: HUMAN, displayName: 'Updated' })
        await vi.advanceTimersByTimeAsync(kind.startsWith('heartbeat') ? 3_000 : 0)
        expect(directory.getSnapshot().read).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        pending.resolve(EMPTY)
        await vi.advanceTimersByTimeAsync(0)
        expect(directory.getSnapshot().read).toBe(true)
        expect(vi.getTimerCount()).toBe(1)
      } finally {
        unsubscribe()
        pending.resolve(EMPTY)
        await directory.dispose()
      }
      expect(vi.getTimerCount()).toBe(0)
    },
  )

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

  it('releases the participant refresh lock when the Remote call throws before returning a Promise', async () => {
    const remote = participantPort()
    remote.list.mockImplementationOnce(() => { throw new Error('connection context is inactive') })
    const report = vi.fn()
    const directory = createParticipantDirectory(remote, { id: HUMAN, displayName: '' }, report)
    try {
      await vi.waitFor(() => { expect(directory.getSnapshot().error).toBe('connection context is inactive') })
      directory.refresh()
      await vi.waitFor(() => { expect(directory.getSnapshot().error).toBeUndefined() })
      expect(remote.list).toHaveBeenCalledTimes(2)
      expect(directory.getSnapshot().read).toBe(true)
      expect(report).toHaveBeenCalledOnce()
    } finally { await directory.dispose() }
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
