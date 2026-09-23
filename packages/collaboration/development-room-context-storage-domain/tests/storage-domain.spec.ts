import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import DevelopmentRoomService, {
  type DevelopmentParticipantId,
} from '@deepseek-ai/dsh-development-room'
import DevelopmentRoomContextService from '@deepseek-ai/dsh-development-room-context'
import * as DevelopmentRoomStorageDomain from '@deepseek-ai/dsh-development-room-storage-domain'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import * as DevelopmentRoomContextStorageDomain from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  if (root === undefined) root = await mkdtemp(join(tmpdir(), 'dsh-room-context-storage-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-development-room'",
    '  config:',
    '    nodeId: node-a',
    '    presenceTtlMs: 10000',
    '    maxParticipants: 8',
    '    maxRooms: 8',
    '    maxTextBytes: 512',
    "- name: '@deepseek-ai/dsh-development-room-storage-domain'",
    "- name: '@deepseek-ai/dsh-development-room-context'",
    '  config:',
    '    maxTextBytes: 512',
    '    maxEntriesPerStep: 16',
    "- name: '@deepseek-ai/dsh-development-room-context-storage-domain'",
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-room-storage-domain', DevelopmentRoomStorageDomain],
    ['@deepseek-ai/dsh-development-room-context', DevelopmentRoomContextService],
    ['@deepseek-ai/dsh-development-room-context-storage-domain', DevelopmentRoomContextStorageDomain],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return ctx
}

describe('development-room-context storage-domain composition', () => {
  it('restores rooms and their explicit shared context after a cold Loader restart', async () => {
    const first = await boot()
    const alice = 'alice' as DevelopmentParticipantId
    await first.developmentRooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await first.developmentRooms.create({ objective: 'Cold restart context' })
    await first.developmentRooms.join({ roomId: room.id, participantId: alice })
    const entry = await first.developmentRoomContexts.share({
      roomId: room.id,
      participantId: alice,
      text: 'Release starts at 20:00',
    })

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await boot()
    expect(second.developmentRooms.list().rooms).toContainEqual(expect.objectContaining({ id: room.id }))
    expect(second.developmentRoomContexts.log()).toEqual([entry])
  })

  it('fails startup when the durable context log belongs to another node', async () => {
    const first = await boot()
    const alice = 'alice' as DevelopmentParticipantId
    await first.developmentRooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await first.developmentRooms.create({ objective: 'Foreign context' })
    await first.developmentRooms.join({ roomId: room.id, participantId: alice })
    await first.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'local' })
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const storagePath = join(root as string, 'storage', 'development_room_context.json')
    const document = JSON.parse(await readFile(storagePath, 'utf8')) as {
      tables: { logs: Record<string, { entries: Array<{ nodeId: string }> }> }
    }
    const record = Object.values(document.tables.logs)[0]
    if (record === undefined) throw new Error('expected one durable context log')
    for (const entry of record.entries) entry.nodeId = 'node-b'
    await writeFile(storagePath, `${JSON.stringify(document, null, 2)}\n`)

    await expect(boot()).rejects.toThrow('restored context log contains a foreign node')
  })

  it('fails startup when the durable record key belongs to another node', async () => {
    const first = await boot()
    const alice = 'alice' as DevelopmentParticipantId
    await first.developmentRooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })
    const room = await first.developmentRooms.create({ objective: 'Foreign record key' })
    await first.developmentRooms.join({ roomId: room.id, participantId: alice })
    await first.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'local' })
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const storagePath = join(root as string, 'storage', 'development_room_context.json')
    const document = JSON.parse(await readFile(storagePath, 'utf8')) as {
      tables: { logs: Record<string, unknown> }
    }
    const record = document.tables.logs['node-a']
    if (record === undefined) throw new Error('expected local durable context record')
    delete document.tables.logs['node-a']
    document.tables.logs['node-b'] = record
    await writeFile(storagePath, `${JSON.stringify(document, null, 2)}\n`)

    await expect(boot()).rejects.toThrow('durable log belongs to another node')
  })

  it('rejects a foreign context persistence candidate', async () => {
    const ctx = await boot()
    const error: unknown = await ctx.parallel('development-room-context/persist', {
      nodeId: 'node-b' as never,
      seq: 1,
      at: 1,
      roomId: 'room-a' as never,
      participantId: 'alice' as never,
      text: 'foreign',
    }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.some((failure: unknown) =>
      failure instanceof Error && failure.message.includes('cannot persist foreign entry'))).toBe(true)
  })
})
