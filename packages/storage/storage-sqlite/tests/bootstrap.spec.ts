import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { MemoryMediaPool, MemoryStorageBackend } from '../../storage-domain/tests/helpers/memory-backend.ts'
import * as StorageSqlite from '../src/index.ts'
import { Config, SqliteStorageBackend } from '../src/index.ts'

const descriptor: KvUnitDescriptor = { name: 'specimen', version: 1, tables: ['records'], hasGlobal: true }
const disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-bootstrap-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'data.sqlite')
  const pool = new MemoryMediaPool()
  const source = new MemoryStorageBackend(pool)
  disposers.push(() => source.close())
  const unit = await source.kv.open(descriptor)
  await unit.putRecord('records', 'first', { n: 1 })
  await unit.putRecord('records', 'second', { n: 2 })
  await unit.setGlobal({ selected: 'first' })
  await unit.close()
  const open = (facet: KvFacet = source.kv) => {
    const backend = new SqliteStorageBackend(new Config({ path, bootstrapFrom: 'source' }), facet)
    disposers.push(() => backend.close())
    return backend
  }
  return { path, source, open }
}

it('copies a new unit once and never resurrects deleted destination records', async () => {
  const { open, source } = await fixture()
  const backend = open()
  const unit = await backend.kv.open(descriptor)
  expect(await unit.loadAll()).toEqual({ tables: { records: { first: { n: 1 }, second: { n: 2 } } }, global: { selected: 'first' } })
  await unit.deleteRecord('records', 'first')
  await unit.deleteRecord('records', 'second')
  await unit.setGlobal(null)
  await backend.close()
  const retained = await source.kv.open(descriptor)
  expect((await retained.loadAll()).tables['records']).toEqual({ first: { n: 1 }, second: { n: 2 } })
  await retained.close()
  const reopened = open({ open: async () => { throw new Error('source must not be consulted again') } })
  expect(await (await reopened.kv.open(descriptor)).loadAll()).toEqual({ tables: { records: {} }, global: null })
})

it('leaves a unit unstamped after an unreadable source and permits a repaired retry', async () => {
  const { open, path, source } = await fixture()
  const backend = open({ open: async () => { throw new Error('source unreadable') } })
  await expect(backend.kv.open(descriptor)).rejects.toThrow('source unreadable')
  await backend.close()
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT * FROM units').all()).toEqual([]) }
  finally { db.close() }
  const retry = open(source.kv)
  expect((await (await retry.kv.open(descriptor)).loadAll()).tables['records']).toHaveProperty('second')
})

it('uses the destination committed by another connection during the source read', async () => {
  const { open, source } = await fixture()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const first = open({ open: async (spec) => {
    const unit = await source.kv.open(spec)
    const snapshot = await unit.loadAll()
    await unit.close()
    entered()
    await barrier
    return {
      loadAll: async () => snapshot,
      close: async () => {},
      putRecord: async () => { throw new Error('unexpected source write') },
      deleteRecord: async () => { throw new Error('unexpected source delete') },
      setGlobal: async () => { throw new Error('unexpected source global write') },
    }
  } })
  const pending = first.kv.open(descriptor)
  try {
    await reading
    const second = open()
    const current = await second.kv.open(descriptor)
    await current.putRecord('records', 'first', { n: 3 })
    await second.close()
  } finally { release() }
  expect((await (await pending).loadAll()).tables['records']!['first']).toEqual({ n: 3 })
})

it('requires a resolved source facet and rejects a self-referential bootstrap', async () => {
  expect(() => new SqliteStorageBackend(new Config({ path: ':memory:', bootstrapFrom: 'source' })))
    .toThrow('has no resolved kv facet')
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  expect(() => StorageSqlite.apply(ctx, new Config({ path: ':memory:', bootstrapFrom: 'sqlite' })))
    .toThrow('cannot bootstrap from itself')
})

it('registers with its configured source and unregisters when the source provider disappears', async () => {
  const { path, source } = await fixture()
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const provider = ctx.plugin({ inject: ['storage'], apply(sourceCtx: Context) {
    sourceCtx.effect(() => sourceCtx.storage.backend.register('source', source))
    sourceCtx.provide(storageBackendServiceKey('source'), source)
  },
  })
  await provider
  await ctx.plugin(StorageSqlite, { path, bootstrapFrom: 'source' })
  const sqlite = ctx.storage.backend.get('sqlite')
  expect((await (await sqlite.kv!.open(descriptor)).loadAll()).tables['records']).toHaveProperty('first')
  await provider.dispose()
  expect(ctx.storage.backend.names()).toEqual([])
  await expect(sqlite.kv!.open(descriptor)).rejects.toMatchObject({ code: 'closed' })
})

it('rolls back all imported rows and the unit stamp when a later insert fails', async () => {
  const { open, path } = await fixture()
  const setup = new DatabaseSync(path)
  try {
    setup.exec(`CREATE TABLE u_specimen_records (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TRIGGER reject_second BEFORE INSERT ON u_specimen_records WHEN NEW.key = 'second'
      BEGIN SELECT RAISE(ABORT, 'import interrupted'); END;`)
  } finally { setup.close() }
  const broken = open()
  await expect(broken.kv.open(descriptor)).rejects.toThrow('import interrupted')
  await broken.close()
  const repair = new DatabaseSync(path)
  try {
    expect(repair.prepare('SELECT * FROM units').all()).toEqual([])
    expect(repair.prepare('SELECT * FROM u_specimen_records').all()).toEqual([])
    repair.exec('DROP TRIGGER reject_second')
  } finally { repair.close() }
  const retry = open()
  expect((await (await retry.kv.open(descriptor)).loadAll()).tables['records']).toHaveProperty('second')
})
