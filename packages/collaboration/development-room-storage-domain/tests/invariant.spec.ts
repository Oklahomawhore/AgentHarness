import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { afterEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_ROOM_DOMAIN_NAME } from '../src/schema.ts'
import * as DevelopmentRoomStorageInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<{ ctx: Context; rooms: DevelopmentRoomService }> {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId: 'node-a',
    presenceTtlMs: 10_000,
    maxParticipants: 8,
    maxRooms: 4,
    maxTextBytes: 256,
  })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(DevelopmentRoomStorageInvariant)
  return { ctx, rooms }
}

const invariantViolation: unknown = expect.objectContaining<Partial<InvariantError>>({
  code: 'INVARIANT',
  packageName: '@deepseek-ai/dsh-development-room-storage-domain',
})

describe('development-room storage invariants', () => {
  it('accepts one matching log append and rejects unpaired or contradictory writes', async () => {
    const { ctx, rooms } = await setup()
    const room = await rooms.create({ objective: 'Verify durable publication' })
    const first = rooms.log()[0]!
    const durable = { entries: [first] }

    expect(() => {
      ctx.emit('domain/changed', {
        domain: 'unrelated',
        table: 'logs',
        key: first.nodeId,
        operation: 'put',
        value: durable,
      })
    }).not.toThrow()

    expect(() => {
      ctx.emit('domain/changed', {
        domain: DEVELOPMENT_ROOM_DOMAIN_NAME,
        table: 'logs',
        key: first.nodeId,
        operation: 'put',
        value: durable,
      })
    }).toThrow(invariantViolation)

    const next = {
      nodeId: first.nodeId,
      seq: 2,
      at: first.at + 1,
      roomId: room.id,
      change: { kind: 'participant-joined' as const, participantId: 'alice' as never },
    }
    await ctx.parallel('development-room/persist', next)
    expect(() => {
      ctx.emit('domain/changed', {
        domain: DEVELOPMENT_ROOM_DOMAIN_NAME,
        table: 'logs',
        key: first.nodeId,
        operation: 'put',
        value: { entries: [first, { ...next, seq: 3 }] },
      })
    }).toThrow(invariantViolation)

    expect(() => {
      ctx.emit('domain/changed', {
        domain: DEVELOPMENT_ROOM_DOMAIN_NAME,
        table: 'logs',
        key: first.nodeId,
        operation: 'put',
        value: { entries: [first, next] },
      })
    }).not.toThrow()
  })
})
