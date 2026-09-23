import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh/types'
import DevelopmentRoomService, {
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
} from '@deepseek-ai/dsh-development-room'
import { afterEach, describe, expect, it } from 'vitest'
import DevelopmentRoomMeshService from '../src/index.ts'

const contexts: Context[] = []
const NODE = 'node-local' as DevelopmentNodeId
const OWNER = 'human-owner' as DevelopmentParticipantId
const AGENT = 'agent-local' as DevelopmentParticipantId

class MemoryMesh extends DevelopmentMeshService {
  list(): DevelopmentMeshSnapshot {
    return { nodeId: NODE, clusterId: 'cluster', secretFingerprint: 'fingerprint', peers: [] }
  }

  publish(): void {}

  async command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown> {
    return await this.channel(channel)?.command?.(payload, ownerNodeId)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('development Room Mesh consumer', () => {
  it('routes hidden Room membership through the local creation node', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(DevelopmentRoomService, {
      nodeId: NODE,
      presenceTtlMs: 10_000,
      maxParticipants: 8,
      maxRooms: 8,
      maxTextBytes: 1_024,
    })
    await ctx.developmentRooms.announce({ id: OWNER, kind: 'human', displayName: 'Owner' })
    await ctx.developmentRooms.announce({ id: AGENT, kind: 'agent', displayName: 'Agent' })
    const room = await ctx.developmentRooms.create({ objective: 'Hidden Task runtime' })
    await ctx.plugin(MemoryMesh)
    await ctx.plugin(DevelopmentRoomMeshService)

    await ctx.developmentRoomMesh.join({ roomId: room.id, participantId: AGENT })
    expect(ctx.developmentRooms.list().rooms.find(item => item.id === room.id)?.participantIds).toEqual([AGENT])

    await ctx.developmentRoomMesh.leave({ roomId: room.id, participantId: AGENT })
    expect(ctx.developmentRooms.list().rooms.find(item => item.id === room.id)?.participantIds).toEqual([])
  })
})
