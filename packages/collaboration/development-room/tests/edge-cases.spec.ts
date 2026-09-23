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
})
