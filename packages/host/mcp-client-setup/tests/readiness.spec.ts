/** MCP setup activation owns the real descriptor publication and its lease. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provideBrowserCredentials } from '../../../client/connection/tests/browser-credentials.ts'
import McpClientSetupService from '../src/index.ts'

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
