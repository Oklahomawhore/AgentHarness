/** MCP setup activation owns the real descriptor publication and its lease. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provideBrowserCredentials } from '../../../client/connection/tests/browser-credentials.ts'
import McpClientSetupService, { type Config, type McpClientSetupOptions } from '../src/index.ts'

const publication = vi.hoisted(() => ({ beforeCommit: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (typeof args[1] === 'string') await publication.beforeCommit?.(args[1])
    return actual.rename(...args)
  } }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  publication.beforeCommit = undefined
  if (failures.length !== 0) throw new AggregateError(failures, 'MCP readiness fixture cleanup failed')
})

describe.skipIf(process.platform === 'win32')('MCP descriptor startup', () => {
  it('lists and configures clients through the descriptor-owning Host service with isolated client failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-service-setup-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const home = join(directory, 'home')
    const bin = join(directory, 'bin')
    const applications = join(directory, 'Applications')
    await Promise.all([mkdir(home), mkdir(bin), mkdir(join(applications, 'Cursor.app'), { recursive: true }),
      mkdir(join(applications, 'WorkBuddy.app'), { recursive: true })])
    const blocked = join(home, '.workbuddy')
    await writeFile(blocked, 'preserved local settings\n')
    class FixtureSetup extends McpClientSetupService {
      constructor(context: Context, config: Config) {
        const options: McpClientSetupOptions = { ...config, home, path: bin, applicationRoots: [applications],
          username: 'Service fixture', environment: { HOME: home, PATH: bin } }
        super(context, options)
      }
    }
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    provideBrowserCredentials(ctx)
    await ctx.plugin(Connection)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const descriptorPath = join(directory, 'private', 'connection.json')
    const fiber = ctx.plugin(FixtureSetup, { nodePath: process.execPath, dshPath: join(directory, 'dsh.js'),
      nodeArgs: [], commandTimeoutMs: 10_000, descriptorPath, harnessHome: directory })
    await fiber
    const descriptor = await readFile(descriptorPath, 'utf8')
    const listed = await ctx.mcpClientSetup.list()
    expect(listed.clients.find(client => client.id === 'cursor')).toMatchObject({ state: 'not-configured', canSetup: true })
    expect(listed.clients.find(client => client.id === 'workbuddy')).toMatchObject({ state: 'failed', canSetup: false })
    const result = await ctx.mcpClientSetup.setup({ clientId: 'cursor', displayName: 'Colleague / client' })
    expect(result).toMatchObject({ outcome: 'configured', client: { displayName: 'Colleague / client', state: 'configured' } })
    const path = join(home, '.cursor', 'mcp.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ mcpServers: { agentharness: {
      command: process.execPath, env: { DSH_HOME: directory },
      args: [join(directory, 'dsh.js'), '--profile', 'mcp', '--connection', descriptorPath,
        '--participant-id', result.client.participantId, '--display-name', 'Colleague / client'],
    } } })
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(blocked, 'utf8')).toBe('preserved local settings\n')
    expect(await readFile(descriptorPath, 'utf8')).toBe(descriptor)
    await fiber.dispose()
    await expect(lstat(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps activation pending until the complete private descriptor is committed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-descriptor-readiness-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    provideBrowserCredentials(ctx)
    await ctx.plugin(Connection)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const descriptorPath = join(directory, 'private', 'connection.json')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    publication.beforeCommit = async (path) => {
      if (path !== descriptorPath) return
      entered.resolve(undefined)
      await release.promise
    }
    const fiber = ctx.plugin(McpClientSetupService, {
      nodePath: process.execPath, dshPath: join(directory, 'dsh.js'), nodeArgs: [],
      commandTimeoutMs: 10_000,
      descriptorPath, harnessHome: directory,
    })
    const mounted = Promise.resolve(fiber)
    void mounted.catch(() => {}) // The assertion below observes activation failure after releasing publication.
    let completed = false
    void mounted.then(() => { completed = true }, () => {})
    await entered.promise
    expect(fiber.state).toBe(FiberState.LOADING)
    expect(completed).toBe(false)
    await expect(lstat(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    release.resolve(undefined)
    await mounted
    expect(fiber.state).toBe(FiberState.ACTIVE)
    const descriptor: unknown = JSON.parse(await readFile(descriptorPath, 'utf8'))
    expect(descriptor).toMatchObject({ version: 1, launchUrl: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`) })
    expect((await lstat(descriptorPath)).mode & 0o777).toBe(0o600)
    await fiber.dispose()
    await expect(lstat(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
