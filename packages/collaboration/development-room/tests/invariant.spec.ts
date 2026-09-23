import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { afterEach, describe, expect, it } from 'vitest'
import DevelopmentRoomService from '../src/index.ts'
import * as DevelopmentRoomInvariant from '../src/invariant.ts'
import type { DevelopmentRoomId, DevelopmentRoomLogEntry } from '../src/types.ts'

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
  await ctx.plugin(DevelopmentRoomInvariant)
  return { ctx, rooms }
}

const invariantViolation: unknown = expect.objectContaining<Partial<InvariantError>>({
  code: 'INVARIANT',
  packageName: '@deepseek-ai/dsh-development-room',
})

async function expectParallelInvariant(operation: Promise<void>): Promise<void> {
  const error: unknown = await operation.then(() => undefined, (failure: unknown): unknown => failure)
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toContainEqual(invariantViolation)
}

describe('development-room invariants', () => {
  it('accepts real publication and rejects contradictory persistence and change events', async () => {
    const { ctx, rooms } = await setup()
    const room = await rooms.create({ objective: 'Verify room publication' })
    const current = rooms.log()[0]!

    await expectParallelInvariant(ctx.parallel('development-room/persist', {
      ...current,
      nodeId: 'node-b' as never,
    }))

    const skipped: DevelopmentRoomLogEntry = { ...current, seq: current.seq + 2 }
    await expectParallelInvariant(ctx.parallel('development-room/persist', skipped))

    expect(() => {
      ctx.emit('development-room/changed', {
        ...room,
        id: 'room-missing' as DevelopmentRoomId,
      }, current, { kind: 'local', nodeId: room.creationNodeId })
    }).toThrow(invariantViolation)

    expect(() => {
      ctx.emit('development-room/changed', {
        ...room,
        participantIds: ['unexpected' as never],
      }, current, { kind: 'local', nodeId: room.creationNodeId })
    }).toThrow(invariantViolation)
  })
})
