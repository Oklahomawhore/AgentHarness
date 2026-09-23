import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh/types'
import DevelopmentRoomService, {
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
  type DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskId, DevelopmentTaskLogEntry } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, describe, expect, it } from 'vitest'
import DevelopmentTaskMeshService from '../src/index.ts'

const contexts: Context[] = []
const REMOTE = 'remote-node' as DevelopmentNodeId
const TASK = 'task-remote' as DevelopmentTaskId
const ROOM = 'room-remote' as DevelopmentRoomId
const HUMAN = 'human-remote' as DevelopmentParticipantId

class MemoryMesh extends DevelopmentMeshService {
  list(): DevelopmentMeshSnapshot {
    return { nodeId: 'local-node' as DevelopmentNodeId, clusterId: 'test', secretFingerprint: 'test', peers: [] }
  }
  publish(): void {}
  async command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown> {
    if (ownerNodeId !== 'local-node') throw Object.assign(new Error('offline'), { code: 'RUNTIME_UNAVAILABLE' })
    return await this.channel(channel)?.command?.(payload, ownerNodeId)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DevelopmentRoomService, {
    nodeId: 'local-node', presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 2_048,
  })
  await ctx.plugin(DevelopmentTaskService, {
    maxTasks: 32, maxEventsPerTask: 64,
    maxMergeParents: 8, maxContextBlockBytes: 65_536, maxLineageTasks: 64, maxTextBytes: 2_048, roomRetryIntervalMs: 10_000,
  })
  await ctx.plugin(MemoryMesh)
  await ctx.plugin(DevelopmentTaskMeshService)
  return ctx
}

function created(objective = 'Remote Root'): DevelopmentTaskLogEntry {
  return {
    nodeId: REMOTE,
    seq: 1,
    at: 1,
    taskId: TASK,
    revision: 1,
    hiddenRoomId: ROOM,
    change: {
      kind: 'task-created',
      origin: { kind: 'root' },
      objective,
      scope: 'remote scope',
      createdBy: HUMAN,
    },
  }
}

function contextPublished(): DevelopmentTaskLogEntry {
  return {
    nodeId: REMOTE,
    seq: 2,
    at: 2,
    taskId: TASK,
    revision: 2,
    hiddenRoomId: ROOM,
    change: {
      kind: 'context-published',
      publication: { id: 'context-one', text: 'arrived out of order', publishedBy: HUMAN, publishedAt: 2 },
    },
  }
}

describe('development Task Mesh channel', () => {
  it('buffers an out-of-order event until its exact predecessor arrives', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await channel.receive([{ kind: 'task-event', entry: contextPublished() }], REMOTE)
    expect(ctx.developmentTasks.list({ limit: 32 })).toEqual([])

    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    expect(ctx.developmentTasks.get({ taskId: TASK })).toMatchObject({ revision: 2, context: [{ text: 'arrived out of order' }] })
  })

  it('rejects a different payload for an already committed event identity', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    await expect(channel.receive([{ kind: 'task-event', entry: created('Conflicting Root') }], REMOTE))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(ctx.developmentTasks.get({ taskId: TASK }).objective).toBe('Remote Root')
  })

  it('rejects an event whose claimed origin differs from its authenticated peer', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await expect(channel.receive([{ kind: 'task-event', entry: created() }], 'other-node' as DevelopmentNodeId))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
  })
})
