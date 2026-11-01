import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentRoomService, {
  type Config,
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
  type DevelopmentRoomId,
} from '../src/index.ts'

const contexts: Context[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId
const node = (value: string): DevelopmentNodeId => value as DevelopmentNodeId

const config: Config = {
  nodeId: 'node-a',
  presenceTtlMs: 100,
  maxParticipants: 2,
  maxRooms: 2,
  maxTextBytes: 64,
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function setup(overrides: Partial<Config> = {}): DevelopmentRoomService {
  const ctx = new Context()
  contexts.push(ctx)
  return new DevelopmentRoomService(ctx, { ...config, ...overrides })
}

describe('DevelopmentRoomService edge cases', () => {
  it.each(['presenceTtlMs', 'maxParticipants', 'maxRooms', 'maxTextBytes'] as const)(
    'rejects an invalid %s bound',
    (field) => {
      expect(() => setup({ [field]: 0 })).toThrow(`${field} must be a positive safe integer`)
    },
  )

  it('validates topic text, ids, roster bounds, and room bounds', async () => {
    const rooms = setup({ maxParticipants: 1, maxRooms: 1 })
    await expect(rooms.create({ objective: '   ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(rooms.announce({
      id: participant('Bad ID'),
      kind: 'human',
      displayName: 'Alice',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    await rooms.announce({ id: participant('alice'), kind: 'human', displayName: 'Alice' })
    await expect(rooms.announce({
      id: participant('bob'),
      kind: 'human',
      displayName: 'Bob',
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    await rooms.create({ objective: '第一个话题' })
    await expect(rooms.create({ objective: '第二个话题' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('keeps membership operations independent from the presence lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const rooms = setup()
    const alice = participant('alice')
    await rooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await rooms.create({ objective: '租约独立性' })

    vi.setSystemTime(1_200)
    expect(rooms.list().participants[0]?.presence).toBe('offline')
    const joined = await rooms.join({ roomId: room.id, participantId: alice })
    expect(joined.participantIds).toEqual([alice])
    const left = await rooms.leave({ roomId: room.id, participantId: alice })
    expect(left.participantIds).toEqual([])
  })

  it('rejects missing participants without inventing a profile', async () => {
    const rooms = setup()
    const room = await rooms.create({ objective: '参与者先出现' })
    await expect(rooms.join({ roomId: room.id, participantId: participant('missing') }))
      .rejects.toMatchObject({ code: 'PARTICIPANT_NOT_FOUND' })
    expect(rooms.log()).toHaveLength(1)
  })

  it('rejects malformed, foreign, and non-contiguous replica logs', async () => {
    const rooms = setup({ nodeId: 'node-b' })
    const first = {
      nodeId: node('node-a'),
      seq: 1,
      at: 1,
      roomId: 'room-one' as DevelopmentRoomId,
      change: { kind: 'room-created' as const, objective: '合法话题' },
    }
    await expect(rooms.acceptLogReplica({ ...first, at: -1 }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await expect(rooms.acceptLogReplica(first, node('node-c')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await expect(rooms.acceptLogReplica({ ...first, seq: 2 }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
  })

  it('rejects blank and oversized identities and multibyte text without retaining them', async () => {
    expect(() => setup({ nodeId: ' ' })).toThrow('node id must not be blank')
    expect(() => setup({ nodeId: 'a'.repeat(65) })).toThrow('node id exceeds maxTextBytes')
    const rooms = setup()
    for (const id of [' ', 'a'.repeat(65)]) {
      await expect(rooms.announce({ id: participant(id), kind: 'human', displayName: 'Alice' }))
        .rejects.toMatchObject({ code: id.trim() === '' ? 'INVALID_REQUEST' : 'LIMIT_EXCEEDED' })
    }
    await expect(rooms.announce({ id: participant('alice'), kind: 'human', displayName: '界'.repeat(22) }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(rooms.create({ objective: '界'.repeat(22) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(rooms.list().participants).toEqual([])
    expect(rooms.log()).toEqual([])
  })

  it('renews only locally owned leases and preserves remote identity ownership', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const local = setup()
    const remote = setup({ nodeId: 'node-b' })
    const alice = participant('alice')
    await local.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    vi.setSystemTime(1_100)
    expect(local.list().participants[0]?.presence).toBe('offline')
    expect((await local.heartbeat({ participantId: alice })).participants[0])
      .toMatchObject({ lastSeenAt: 1_100, presence: 'online' })
    const profile = local.list().participants[0]!
    await expect(remote.acceptPresenceReplica(profile, node('node-c'))).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await remote.acceptPresenceReplica(profile, node('node-a'))
    await expect(remote.announce({ id: alice, kind: 'agent', displayName: 'Impersonator' }))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    for (const method of ['heartbeat', 'withdraw'] as const) {
      await expect(remote[method]({ participantId: alice })).rejects.toMatchObject({ code: 'NOT_CREATION_NODE' })
    }
    await expect(remote.acceptPresenceReplica({ ...profile, nodeId: node('node-c') }, node('node-c')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await local.withdraw({ participantId: alice })
    const offline = await remote.acceptPresenceReplica(local.list().participants[0]!, node('node-a'))
    expect(offline).toMatchObject({ id: alice, nodeId: 'node-a', presence: 'offline', lastSeenAt: 0 })
    await remote.announce({ id: participant('bob'), kind: 'human', displayName: 'Bob' })
    await expect(remote.acceptPresenceReplica({ ...profile, id: participant('charlie') }, node('node-a')))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(remote.list().participants.map(item => item.id)).toEqual([alice, 'bob'])
  })

  it('materializes deterministic rooms once and rejects content or creator collisions', async () => {
    const rooms = setup({ maxRooms: 1 })
    const replica = setup({ nodeId: 'node-b' })
    const request = { roomId: 'room-task-one' as DevelopmentRoomId, objective: 'Owned Task context' }
    const created = await rooms.ensure(request)
    expect(await rooms.ensure(request)).toEqual(created)
    expect(rooms.log()).toHaveLength(1)
    await expect(rooms.ensure({ ...request, objective: 'Other context' }))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await expect(rooms.ensure({ ...request, roomId: 'room-task-two' as DevelopmentRoomId }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await replica.acceptLogReplica(rooms.log()[0]!, node('node-a'))
    await expect(replica.ensure(request)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    for (const method of ['join', 'leave'] as const) {
      await expect(replica[method]({ roomId: created.id, participantId: participant('alice') }))
        .rejects.toMatchObject({ code: 'NOT_CREATION_NODE' })
    }
    await expect(rooms.join({ roomId: 'room-missing' as DevelopmentRoomId, participantId: participant('alice') }))
      .rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' })
  })

  it('rejects inconsistent room transitions without consuming their peer sequence', async () => {
    const creator = setup()
    const replica = setup({ nodeId: 'node-b' })
    const alice = participant('alice')
    await creator.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await creator.create({ objective: 'Ordered replica history' })
    const first = creator.log()[0]!
    await replica.acceptLogReplica(first, node('node-a'))
    expect(await replica.acceptLogReplica(first, node('node-a'))).toEqual(replica.list().rooms[0])
    await expect(replica.acceptLogReplica({ ...first, seq: 2 }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await creator.join({ roomId: room.id, participantId: alice })
    const joined = creator.log()[1]!
    await expect(replica.acceptLogReplica({ ...joined, roomId: 'room-missing' as DevelopmentRoomId }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await expect(replica.acceptLogReplica({ ...joined, at: first.at - 1 }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await expect(replica.acceptLogReplica({ ...joined, seq: 1, nodeId: node('node-c') }, node('node-c')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await replica.acceptLogReplica(joined, node('node-a'))
    await expect(replica.acceptLogReplica({ ...joined, seq: 3 }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await creator.leave({ roomId: room.id, participantId: alice })
    const left = creator.log()[2]!
    await replica.acceptLogReplica(left, node('node-a'))
    await expect(replica.acceptLogReplica({ ...left, seq: 4 }, node('node-a')))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(replica.log()).toEqual(creator.log())
    expect(replica.list().rooms[0]?.participantIds).toEqual([])
  })

  it('applies the room capacity bound to peer creation', async () => {
    const creator = setup()
    const replica = setup({ nodeId: 'node-b', maxRooms: 1 })
    await creator.create({ objective: 'First room' })
    await creator.create({ objective: 'Second room' })
    await replica.acceptLogReplica(creator.log()[0]!, node('node-a'))
    await expect(replica.acceptLogReplica(creator.log()[1]!, node('node-a')))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(replica.log()).toEqual(creator.log().slice(0, 1))
  })
})
