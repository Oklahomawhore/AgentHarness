import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import DevelopmentRoomContextService from '@deepseek-ai/dsh-development-room-context'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { afterEach, describe, expect, it } from 'vitest'
import * as DevelopmentRoomContextStorageInvariant from '../src/invariant.ts'
import { DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME } from '../src/schema.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const invariantViolation: unknown = expect.objectContaining<Partial<InvariantError>>({
  code: 'INVARIANT',
  packageName: '@deepseek-ai/dsh-development-room-context-storage-domain',
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  new DevelopmentRoomService(ctx, {
    nodeId: 'node-a', presenceTtlMs: 10_000, maxParticipants: 8, maxRooms: 4, maxTextBytes: 256,
  })
  new DevelopmentRoomContextService(ctx, { maxTextBytes: 256, maxEntriesPerStep: 8 })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(DevelopmentRoomContextStorageInvariant)
  return ctx
}

describe('development-room-context storage invariants', () => {
  it('accepts a matching append and rejects unpaired or contradictory writes', async () => {
    const ctx = await setup()
    const alice = 'alice' as DevelopmentParticipantId
    await ctx.developmentRooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await ctx.developmentRooms.create({ objective: 'Durable context' })
    await ctx.developmentRooms.join({ roomId: room.id, participantId: alice })
    const entry = {
      nodeId: ctx.developmentRoomContexts.list().nodeId,
      seq: 1,
      at: 1,
      roomId: room.id,
      participantId: alice,
      text: 'shared',
    }

    expect(() => {
      ctx.emit('domain/changed', {
        domain: 'unrelated', table: 'logs', key: entry.nodeId, operation: 'put', value: { entries: [entry] },
      })
    }).not.toThrow()
    expect(() => {
      ctx.emit('domain/changed', {
        domain: DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME,
        table: 'logs',
        key: entry.nodeId,
        operation: 'put',
        value: { entries: [entry] },
      })
    }).toThrow(invariantViolation)

    await ctx.parallel('development-room-context/persist', entry)
    expect(() => {
      ctx.emit('domain/changed', {
        domain: DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME,
        table: 'logs',
        key: entry.nodeId,
        operation: 'put',
        value: { entries: [{ ...entry, seq: 2 }] },
      })
    }).toThrow(invariantViolation)
    expect(() => {
      ctx.emit('domain/changed', {
        domain: DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME,
        table: 'logs',
        key: entry.nodeId,
        operation: 'put',
        value: { entries: [entry] },
      })
    }).not.toThrow()
    expect(() => {
      ctx.emit('development-room-context/changed', { ...entry, seq: 2 }, {
        kind: 'restored', nodeId: entry.nodeId,
      })
    }).not.toThrow()
    expect(() => {
      ctx.emit('development-room-context/changed', { ...entry, seq: 2 }, {
        kind: 'local', nodeId: entry.nodeId,
      })
    }).not.toThrow()
    expect(() => {
      ctx.emit('development-room-context/changed', entry, {
        kind: 'local', nodeId: entry.nodeId,
      })
    }).not.toThrow()
  })
})
