import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import DevelopmentRoomService, {
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
  type DevelopmentRoomId,
  type DevelopmentRoomLogEntry,
} from '@deepseek-ai/dsh-development-room'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import * as DevelopmentRoomStorageDomain from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  if (root === undefined) root = await mkdtemp(join(tmpdir(), 'dsh-room-storage-domain-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-development-room'",
    '  config:',
    '    nodeId: node-a',
    '    presenceTtlMs: 10000',
    '    maxParticipants: 8',
    '    maxRooms: 8',
    '    maxTextBytes: 512',
    "- name: '@deepseek-ai/dsh-development-room-storage-domain'",
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
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-room-storage-domain', DevelopmentRoomStorageDomain],
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

function remoteEntry(): DevelopmentRoomLogEntry {
  return {
    nodeId: 'node-b' as DevelopmentNodeId,
    seq: 1,
    at: 1,
    roomId: 'room-remote' as DevelopmentRoomId,
    change: { kind: 'room-created', objective: 'Remote replica is transient' },
  }
}

describe('development-room storage-domain composition', () => {
  it('restores the local append-only log after a cold Loader restart', async () => {
    const first = await boot()
    expect(first.developmentRoomStorageReady).toEqual({ nodeId: 'node-a' })
    const alice = participant('alice')
    await first.developmentRooms.announce({
      id: alice,
      kind: 'human',
      displayName: 'Alice',
    })
    const created = await first.developmentRooms.create({ objective: '持久化话题房间' })
    await first.developmentRooms.join({ roomId: created.id, participantId: alice })
    await first.developmentRooms.create({ objective: '第二个话题房间' })
    await first.developmentRooms.acceptLogReplica(remoteEntry(), 'node-b' as DevelopmentNodeId)

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await boot()
    const rooms = second.developmentRooms.list().rooms
    expect(rooms).toHaveLength(2)
    expect(rooms.find(room => room.id === created.id)).toMatchObject({
      id: created.id,
      creationNodeId: 'node-a',
      objective: '持久化话题房间',
      participantIds: [alice],
      participants: [],
    })
    expect(second.developmentRooms.log()).toHaveLength(3)
    expect(second.developmentRooms.log().every(entry => entry.nodeId === 'node-a')).toBe(true)
  })

  it('rejects a foreign log persistence candidate', async () => {
    const ctx = await boot()
    const rejection: unknown = await ctx.parallel('development-room/persist', remoteEntry())
      .catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(AggregateError)
    if (!(rejection instanceof AggregateError)) throw new Error('expected aggregate listener rejection')
    expect(rejection.errors.some((error: unknown) =>
      error instanceof Error && error.message.includes('cannot persist foreign log entry'))).toBe(true)
  })

  it('fails startup instead of accepting a durable log from another node', async () => {
    const first = await boot()
    await first.developmentRooms.create({ objective: 'Preserve local log' })
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const storagePath = join(root as string, 'storage', 'development_rooms.json')
    const document = JSON.parse(await readFile(storagePath, 'utf8')) as {
      tables: { logs: Record<string, { entries: Array<{ nodeId: string }> }> }
    }
    const record = Object.values(document.tables.logs)[0]
    if (record === undefined) throw new Error('expected one persisted log')
    for (const entry of record.entries) entry.nodeId = 'node-b'
    await writeFile(storagePath, `${JSON.stringify(document, null, 2)}\n`)

    await expect(boot()).rejects.toThrow('restored log contains an entry from another node')
  })
})
