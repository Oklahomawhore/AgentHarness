import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh/types'
import DevelopmentRoomService, {
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
  type DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentRoomMeshService from '../src/index.ts'

const contexts: Context[] = []
const NODE = 'node-local' as DevelopmentNodeId
const OWNER = 'human-owner' as DevelopmentParticipantId
const AGENT = 'agent-local' as DevelopmentParticipantId

class MemoryMesh extends DevelopmentMeshService {
  list(): DevelopmentMeshSnapshot {
    return { nodeId: this.ctx.developmentRooms.list().nodeId, clusterId: 'cluster', secretFingerprint: 'fingerprint', peers: [] }
  }

  publish(): void {}

  async command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown> {
    return await this.channel(channel)?.command?.(payload, ownerNodeId)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(nodeId: DevelopmentNodeId = NODE): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DevelopmentRoomService, {
    nodeId, presenceTtlMs: 10_000, maxParticipants: 8, maxRooms: 8, maxTextBytes: 1_024,
  })
  await ctx.plugin(MemoryMesh)
  await ctx.plugin(DevelopmentRoomMeshService)
  return ctx
}

describe('development Room Mesh consumer', () => {
  it('replicates only locally authored deltas and withdraws only the disconnected peer presence', async () => {
    const ctx = await setup()
    const peer = 'peer-node' as DevelopmentNodeId
    const source = await setup(peer)
    const remote = 'remote-agent' as DevelopmentParticipantId
    const channel = ctx.developmentMesh.channel('development-room/v1')!
    const publish = vi.spyOn(ctx.developmentMesh, 'publish')
    await ctx.developmentRooms.announce({ id: AGENT, kind: 'agent', displayName: 'Local Agent' })
    const localRoom = await ctx.developmentRooms.create({ objective: 'Local Room' })
    await ctx.developmentRooms.join({ roomId: localRoom.id, participantId: AGENT })
    expect(publish).toHaveBeenCalledTimes(3)
    await source.developmentRooms.announce({ id: remote, kind: 'agent', displayName: 'Remote Agent' })
    const remoteRoom = await source.developmentRooms.create({ objective: 'Remote Room' })
    const sourceChannel = source.developmentMesh.channel('development-room/v1')!
    await channel.receive(await sourceChannel.read({}), peer)
    expect(publish).toHaveBeenCalledTimes(3)
    expect(await channel.heads()).toEqual({ [NODE]: 2, [peer]: 1 })
    const localEvents = ctx.developmentRooms.log().filter(entry => entry.nodeId === NODE)
    const localPresence = ctx.developmentRooms.list().participants.find(item => item.id === AGENT)!
    expect(await channel.read({})).toEqual([
      { kind: 'presence', participant: localPresence },
      ...localEvents.map(entry => ({ kind: 'room-event', entry })),
    ])
    expect(await channel.read({ [NODE]: 2 })).toEqual([{ kind: 'presence', participant: localPresence }])
    await channel.peerOffline!(peer)
    expect(ctx.developmentRooms.list().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: AGENT, presence: 'online' }), expect.objectContaining({ id: remote, presence: 'offline' }),
    ]))
    await channel.peerOffline!(peer)
    await channel.peerOffline!('unknown-peer' as DevelopmentNodeId)
    expect(publish).toHaveBeenCalledTimes(3)
    expect(ctx.developmentRooms.list().rooms).toHaveLength(2)
    expect(ctx.developmentRooms.list().rooms.find(item => item.id === remoteRoom.id)?.objective).toBe('Remote Room')
  })

  it('routes membership to the remote creation node and rejects commands addressed to a replica', async () => {
    const ctx = await setup()
    const peer = 'peer-node' as DevelopmentNodeId
    const source = await setup(peer)
    await ctx.developmentRooms.announce({ id: AGENT, kind: 'agent', displayName: 'Agent' })
    await source.developmentRooms.acceptPresenceReplica(ctx.developmentRooms.list().participants[0]!, NODE)
    const room = await source.developmentRooms.create({ objective: 'Remote Room' })
    const sourceChannel = source.developmentMesh.channel('development-room/v1')!
    const channel = ctx.developmentMesh.channel('development-room/v1')!
    await channel.receive(await sourceChannel.read({}), peer)
    const transport = vi.spyOn(ctx.developmentMesh, 'command').mockImplementation(async (owner, name, payload) => {
      expect(owner).toBe(peer)
      expect(name).toBe('development-room/v1')
      return await sourceChannel.command!(payload, NODE)
    })
    const request = { roomId: room.id, participantId: AGENT }
    await ctx.developmentRoomMesh.join(request)
    expect(source.developmentRooms.list().rooms[0]?.participantIds).toEqual([AGENT])
    await ctx.developmentRoomMesh.leave(request)
    expect(source.developmentRooms.list().rooms[0]?.participantIds).toEqual([])
    expect(transport).toHaveBeenCalledTimes(2)
    await expect(channel.command!({ method: 'join', request }, peer)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await expect(async () => await channel.command!({ method: 'unknown', request }, peer)).rejects.toMatchObject({ name: 'ZodError' })
    await expect(ctx.developmentRoomMesh.join({ ...request, roomId: 'missing-room' as DevelopmentRoomId }))
      .rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
    await expect(channel.receive([{ kind: 'room-event', entry: { seq: 0 } }], peer)).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('unregisters its channel and publication listeners when its plugin is removed', async () => {
    const ctx = await setup()
    const publish = vi.spyOn(ctx.developmentMesh, 'publish')
    const runtime = ctx.registry.get(DevelopmentRoomMeshService)
    expect(runtime).toBeDefined()
    const [consumer] = runtime!.fibers
    await consumer!.dispose()
    expect(ctx.developmentMesh.channel('development-room/v1')).toBeUndefined()
    await ctx.developmentRooms.announce({ id: AGENT, kind: 'agent', displayName: 'Agent' })
    await ctx.developmentRooms.create({ objective: 'Independent Room' })
    expect(publish).not.toHaveBeenCalled()
  })

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
