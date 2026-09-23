import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentRoomService, {
  type Config,
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
} from '../src/index.ts'

const contexts: Context[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId
const node = (value: string): DevelopmentNodeId => value as DevelopmentNodeId

const baseConfig: Config = {
  nodeId: 'node-a',
  presenceTtlMs: 10_000,
  maxParticipants: 8,
  maxRooms: 8,
  maxTextBytes: 256,
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function setup(config: Partial<Config> = {}): { ctx: Context; rooms: DevelopmentRoomService } {
  const ctx = new Context()
  contexts.push(ctx)
  return { ctx, rooms: new DevelopmentRoomService(ctx, { ...baseConfig, ...config }) }
}

describe('DevelopmentRoomService', () => {
  it('keeps presence independent from voluntary room membership', async () => {
    const { rooms } = setup()
    const alice = participant('alice')
    await rooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })

    const created = await rooms.create({ objective: '本周上线协作' })
    expect(created.participantIds).toEqual([])
    expect(created).not.toHaveProperty('task')
    expect(created).not.toHaveProperty('owner')
    expect(created).not.toHaveProperty('revision')

    const joined = await rooms.join({ roomId: created.id, participantId: alice })
    expect(joined.participantIds).toEqual([alice])
    expect((await rooms.join({ roomId: created.id, participantId: alice })).updatedAt).toBe(joined.updatedAt)

    await rooms.withdraw({ participantId: alice })
    expect(rooms.list().participants[0]).toMatchObject({ presence: 'offline' })
    expect(rooms.list().rooms[0]?.participantIds).toEqual([alice])

    const left = await rooms.leave({ roomId: created.id, participantId: alice })
    expect(left.participantIds).toEqual([])
    expect((await rooms.leave({ roomId: created.id, participantId: alice })).updatedAt).toBe(left.updatedAt)
    expect(rooms.list().participants[0]).toMatchObject({ presence: 'offline' })
  })

  it('creates multiple public topics and lets an announced collaborator join either one', async () => {
    const { rooms } = setup()
    const bob = participant('bob')
    await rooms.announce({ id: bob, kind: 'agent', displayName: 'Bob' })

    const first = await rooms.create({ objective: '一次上线协作' })
    const second = await rooms.create({ objective: '一个临时话题' })
    expect(rooms.list().rooms.map(room => room.objective)).toEqual(['一次上线协作', '一个临时话题'])

    await rooms.join({ roomId: first.id, participantId: bob })
    await rooms.join({ roomId: second.id, participantId: bob })
    expect(rooms.list().rooms.map(room => room.participantIds)).toEqual([[bob], [bob]])
  })

  it('appends every room-link change to one immutable log', async () => {
    const { ctx, rooms } = setup()
    const alice = participant('alice')
    const changes: string[] = []
    ctx.on('development-room/changed', (snapshot, entry) => {
      changes.push(`${snapshot.objective}:${String(entry.seq)}:${entry.change.kind}`)
    })
    await rooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })

    const first = await rooms.create({ objective: '实时成员更新' })
    await rooms.join({ roomId: first.id, participantId: alice })
    const second = await rooms.create({ objective: '第二个房间' })
    await rooms.leave({ roomId: first.id, participantId: alice })

    expect(changes).toEqual([
      '实时成员更新:1:room-created',
      '实时成员更新:2:participant-joined',
      '第二个房间:3:room-created',
      '实时成员更新:4:participant-left',
    ])
    expect(rooms.log().map(entry => [entry.seq, entry.roomId, entry.change.kind])).toEqual([
      [1, first.id, 'room-created'],
      [2, first.id, 'participant-joined'],
      [3, second.id, 'room-created'],
      [4, first.id, 'participant-left'],
    ])
    expect(Object.isFrozen(rooms.log()[0])).toBe(true)
  })

  it('does not append an entry rejected by persistence and reuses its sequence on retry', async () => {
    const { ctx, rooms } = setup()
    const alice = participant('alice')
    await rooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await rooms.create({ objective: '持久化失败重试' })
    await rooms.join({ roomId: room.id, participantId: alice })

    let rejectNext = true
    ctx.on('development-room/persist', () => {
      if (rejectNext) {
        rejectNext = false
        throw new Error('disk unavailable')
      }
    })

    await expect(rooms.leave({ roomId: room.id, participantId: alice }))
      .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(rooms.log()).toHaveLength(2)
    expect(rooms.list().rooms[0]?.participantIds).toEqual([alice])

    await rooms.leave({ roomId: room.id, participantId: alice })
    expect(rooms.log().at(-1)).toMatchObject({ seq: 3, change: { kind: 'participant-left' } })
  })

  it('converges peer replicas from the same append-only entries', async () => {
    const creator = setup()
    const replica = setup({ nodeId: 'node-b' })
    const alice = participant('alice')
    await creator.rooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await creator.rooms.create({ objective: '跨节点联调' })
    await creator.rooms.join({ roomId: room.id, participantId: alice })

    await replica.rooms.acceptPresenceReplica(creator.rooms.list().participants[0]!, node('node-a'))
    for (const entry of creator.rooms.log()) await replica.rooms.acceptLogReplica(entry, node('node-a'))
    expect(replica.rooms.list().rooms[0]).toMatchObject({ participantIds: [alice] })

    await creator.rooms.leave({ roomId: room.id, participantId: alice })
    await replica.rooms.acceptLogReplica(creator.rooms.log().at(-1)!, node('node-a'))
    expect(replica.rooms.list().rooms[0]).toMatchObject({ participantIds: [] })

    const divergent = {
      ...creator.rooms.log()[0]!,
      change: { kind: 'room-created' as const, objective: '冲突话题' },
    }
    await expect(replica.rooms.acceptLogReplica(divergent, node('node-a'))).rejects.toMatchObject({
      code: 'REPLICA_CONFLICT',
    })
  })
})
