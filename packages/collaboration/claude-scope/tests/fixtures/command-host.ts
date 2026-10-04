import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Rooms from '@deepseek-ai/dsh-development-room'
import * as RoomStorage from '@deepseek-ai/dsh-development-room-storage-domain'
import Tasks from '@deepseek-ai/dsh-development-task'
import * as TaskStorage from '@deepseek-ai/dsh-development-task-storage-domain'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import FactsBackend from '@deepseek-ai/dsh-development-task-context/facts'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import Typert from '@deepseek-ai/dsh-typert-registry'
import ClaudeScope from '../../src/index.ts'
import type { ClaudeScopeDescriptor } from '../../src/types.ts'

export interface CommandHost {
  readonly ctx: Context
  readonly directory: string
  readonly descriptorPath: string
  readonly descriptor: ClaudeScopeDescriptor
  readonly exitCodes: number[]
  dispose(): Promise<void>
}

async function descriptorWhenPublished(path: string, start: () => void, failed: Promise<never>): Promise<ClaudeScopeDescriptor> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('Host did not publish its descriptor')) }, 20_000)
  async function inspect(): Promise<ClaudeScopeDescriptor> {
    while (true) {
      controller.signal.throwIfAborted()
      try { return JSON.parse(await readFile(path, 'utf8')) as ClaudeScopeDescriptor } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await delay(25, undefined, { signal: controller.signal })
    }
  }
  const pending = inspect()
  try {
    start()
    return await Promise.race([pending, failed])
  } finally {
    clearTimeout(timer)
    controller.abort()
    await pending.catch(() => {}) // The raced outcome above owns failure reporting.
  }
}

export async function commandHost(invalidDomainVersion = false, backend: 'text' | 'facts' = 'text'): Promise<CommandHost> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-scope-command-'))
  await chmod(directory, 0o700)
  const descriptorPath = join(directory, 'connection.json')
  const ctx = new Context()
  const exitCodes: number[] = []
  const failed = Promise.withResolvers<never>()
  void failed.promise.catch(() => {}) // The readiness wait consumes startup failures.
  const listeners = new Set<() => void>()
  let ready = false
  provideCmdline(ctx, { args: [], exit: (code) => { exitCodes.push(code); failed.reject(new Error(`Host requested exit ${String(code)}`)) }, ready: {
    onReady(listener) {
      if (ready) listener()
      else listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } })
  const dispose = async (): Promise<void> => {
    await ctx.fiber.dispose()
    if (invalidDomainVersion) {
      let remains = true
      try { await access(descriptorPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        remains = false
      }
      if (remains) throw new Error('failed Host left its descriptor after disposal')
    }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const storagePath = invalidDomainVersion ? join(directory, 'state.sqlite') : ':memory:'
    if (invalidDomainVersion) {
      const database = new DatabaseSync(storagePath)
      try {
        database.exec('CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT')
        database.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run('claude_scope', 99)
      } finally { database.close() }
    }
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-credentials-local', Credentials],
      ['@deepseek-ai/dsh-client-connection', Connection],
      ['@deepseek-ai/dsh-api-gateway', Gateway],
      ['@deepseek-ai/dsh-typert-registry', Typert],
      ['@deepseek-ai/dsh-storage', Storage],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain],
      ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
      ['@deepseek-ai/dsh-development-room', Rooms],
      ['@deepseek-ai/dsh-development-room-storage-domain', RoomStorage],
      ['@deepseek-ai/dsh-development-task', Tasks],
      ['@deepseek-ai/dsh-development-task-storage-domain', TaskStorage],
      ['@deepseek-ai/dsh-development-task-context/text', TextBackend],
      ['@deepseek-ai/dsh-development-task-context/facts', FactsBackend],
      ['@deepseek-ai/dsh-claude-scope', ClaudeScope],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    const entries = [
      { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(directory, 'credentials.yml'), dshHome: directory, watch: false } },
      { name: '@deepseek-ai/dsh-client-connection', config: { maxRequestBodyBytes: 65536 } },
      { name: '@deepseek-ai/dsh-typert-registry' },
      { name: '@deepseek-ai/dsh-api-gateway' },
      { name: '@deepseek-ai/dsh-storage' },
      { name: '@deepseek-ai/dsh-storage-sqlite', config: { path: storagePath, journalMode: 'wal' } },
      { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'sqlite' } },
      { name: '@deepseek-ai/dsh-development-room', config: {
        nodeId: 'command-host', presenceTtlMs: 10000, maxParticipants: 32, maxRooms: 32, maxTextBytes: 4096,
      } },
      { name: '@deepseek-ai/dsh-development-room-storage-domain' },
      { name: '@deepseek-ai/dsh-development-task', config: {
        maxTasks: 32, maxEventsPerTask: 128, maxMergeParents: 8, maxContextBlockBytes: 65536,
        maxLineageTasks: 64, maxTextBytes: 4096, roomRetryIntervalMs: 10000,
      } },
      { name: '@deepseek-ai/dsh-development-task-storage-domain', config: { orphanGraceMs: 86400000 } },
      backend === 'text' ? { name: '@deepseek-ai/dsh-development-task-context/text' } : {
        name: '@deepseek-ai/dsh-development-task-context/facts', config: {
          routes: [
            { responsibility: 'frontend', fields: ['requiredRequestFields', 'requestBodyRequired'] },
            { responsibility: 'qa', fields: ['responseStatuses', 'deprecated'] },
          ], unmatchedFields: [],
        },
      },
      { name: '@deepseek-ai/dsh-claude-scope', config: {
        descriptorPath, maxSessions: 32, maxLeases: 32, maxProjections: 128,
        setup: {
          home: join(directory, 'home'), profileName: 'claude-hook', launchCommand: process.execPath,
          launchArgs: [resolve('apps/cli/lib/bin.js')], launchCwd: process.cwd(),
          maxRequestBytes: 262144, maxResponseBytes: 32768, timeoutMs: 10000, hookTimeoutSeconds: 30, maxSettingsBytes: 1048576,
        },
        maxContextBytes: 9000, maxObservationBytes: 4096, maxArtifactReadBytes: 65536,
        maxOpenApiSourcesPerSession: 4, contributionPollIntervalMs: 1000,
      } },
    ]
    const configPath = join(directory, 'cordis.yml')
    await writeFile(configPath, JSON.stringify(entries))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const missing = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    if (missing.length !== 0) throw new Error('Claude scope command Host did not load every configured entry')
    // The product helper reuses the composing frontend's route; this fixture owns that seat.
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: (request, response) => {
      if (!ctx.connection.authorizeIndex(request, response)) return
      response.end('fixture frontend')
    } }), 'command fixture: frontend authorization')
    const descriptor = await descriptorWhenPublished(descriptorPath, () => {
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    }, failed.promise)
    return { ctx, directory, descriptorPath, descriptor, exitCodes, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
