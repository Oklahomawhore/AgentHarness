import { afterEach, describe, expect, it, type Mocked, vi } from 'vitest'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomDirectorySnapshot,
  DevelopmentTaskAssignment,
  DevelopmentTaskBindingId,
  DevelopmentTaskId,
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
  })
})
