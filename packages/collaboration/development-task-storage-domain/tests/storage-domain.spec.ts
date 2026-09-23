import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import * as DevelopmentRoomStorageDomain from '@deepseek-ai/dsh-development-room-storage-domain'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskContextBlock, DevelopmentTaskId } from '@deepseek-ai/dsh-development-task'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import * as DevelopmentTaskStorageDomain from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId
const task = (value: string): DevelopmentTaskId => value as DevelopmentTaskId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(orphanGraceMs = 86_400_000): Promise<Context> {
  if (root === undefined) root = await mkdtemp(join(tmpdir(), 'dsh-task-storage-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-sqlite'",
    '  config:',
    `    path: ${JSON.stringify(join(root, 'tasks.sqlite'))}`,
    '    journalMode: wal',
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: sqlite',
    "- name: '@deepseek-ai/dsh-development-room'",
    '  config:',
    '    nodeId: node-a',
    '    presenceTtlMs: 10000',
    '    maxParticipants: 16',
    '    maxRooms: 64',
    '    maxTextBytes: 2048',
    "- name: '@deepseek-ai/dsh-development-room-storage-domain'",
    "- name: '@deepseek-ai/dsh-development-task'",
    '  config:',
    '    maxTasks: 32',
    '    maxEventsPerTask: 64',
    '    maxMergeParents: 8',
    '    maxContextBlockBytes: 65536',
    '    maxLineageTasks: 64',
    '    roomRetryIntervalMs: 10000',
    '    maxTextBytes: 1024',
    "- name: '@deepseek-ai/dsh-development-task-storage-domain'",
    '  config:',
    `    orphanGraceMs: ${String(orphanGraceMs)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-room-storage-domain', DevelopmentRoomStorageDomain],
    ['@deepseek-ai/dsh-development-task', DevelopmentTaskService],
    ['@deepseek-ai/dsh-development-task-storage-domain', DevelopmentTaskStorageDomain],
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
  return ctx
}

describe('development-task SQLite storage composition', () => {
  it('reuses one content-addressed block when the same parent revision is forked repeatedly', async () => {
    const ctx = await boot()
    const owner = participant('owner')
    await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const parent = await ctx.developmentTasks.create({
      origin: { kind: 'root' },
      objective: 'Shared parent',
      scope: 'repeated Fork persistence',
      createdBy: owner,
    })
    const origin = {
      kind: 'fork' as const,
      parent: { taskId: parent.id, revision: parent.revision },
    }
    for (const objective of ['First child', 'Second child']) {
      await ctx.developmentTasks.create({
        origin,
        objective,
        scope: 'same fixed parent',
        createdBy: owner,
      })
    }

    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const count = database.prepare('SELECT COUNT(*) AS count FROM u_development_context_tasks_context_blocks').get() as { count: number }
    database.close()
    expect(count.count).toBe(1)
    expect(ctx.developmentTasks.list({ limit: 10 })).toHaveLength(3)
  })

  it('restores Task events and inherited context while storing every event separately', async () => {
    const first = await boot()
    const owner = participant('owner')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const rootTask = await first.developmentTasks.create({
      origin: { kind: 'root' },
      objective: 'Persist Task DAG',
      scope: 'storage',
      createdBy: owner,
    })
    await first.developmentTasks.publishContext({
      taskId: rootTask.id, participantId: owner, text: 'Published context survives',
    })
    const head = first.developmentTasks.get({ taskId: rootTask.id })
    const fork = await first.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: head.id, revision: head.revision } },
      objective: 'Persist child',
      scope: 'lineage',
      createdBy: owner,
    })

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    const eventTable = tables.find(table => table.name === 'u_development_context_tasks_events')
    expect(eventTable).toBeDefined()
    const count = database.prepare(`SELECT COUNT(*) AS count FROM "${eventTable!.name}"`).get() as { count: number }
    expect(count.count).toBe(3)
    database.close()

    const second = await boot()
    const restored = second.developmentTasks.get({ taskId: fork.id })
    expect(restored).toMatchObject({ id: fork.id, origin: { kind: 'fork' }, runtime: 'ready' })
    expect(second.developmentRooms.log().filter(entry => entry.change.kind === 'room-created')).toHaveLength(2)
    expect(second.developmentTasks.contextView(fork.id).inherited?.sources[0]?.context)
      .toEqual([expect.objectContaining({ text: 'Published context survives' })])
  })

  it('prunes context blocks older than the grace period when no Task event references them', async () => {
    const first = await boot(1)
    const sources: DevelopmentTaskContextBlock['sources'] = [{
      parent: { taskId: task('task-orphan'), revision: 1 },
      objective: 'Orphaned parent',
      scope: 'cleanup',
      context: [],
    }]
    const serialized = JSON.stringify({ version: 1, sources })
    const block = {
      id: `context-${createHash('sha256').update(serialized).digest('hex')}`,
      createdAt: 0,
      sources,
    } as DevelopmentTaskContextBlock
    await first.parallel('development-task/context-persist', block)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    await boot(1)
    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const count = database.prepare('SELECT COUNT(*) AS count FROM u_development_context_tasks_context_blocks').get() as { count: number }
    database.close()
    expect(count.count).toBe(0)
  })

  it('rejects a Task domain stamped with a different format version', async () => {
    const first = await boot()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    database.prepare('UPDATE units SET version = 99 WHERE name = ?').run('development_context_tasks')
    database.close()

    await expect(boot()).rejects.toThrow(/version 99/u)
  })
})
