/** Default-browser startup over a real Loader tree and listening Web server. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { AppReady } from '@deepseek-ai/dsh-cmdline'
import { apply, internals } from '../src/index.ts'

const contexts: Context[] = []
const tempRoots: string[] = []
const originalResolveDistIndex = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser

beforeEach(() => {
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  internals.resolveDistIndex = originalResolveDistIndex
  internals.openBrowser = originalOpenBrowser
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, '__dshWebAppApply')
  Reflect.deleteProperty(globalThis, '__dshWebServer')
  Reflect.deleteProperty(globalThis, '__dshConnection')
})

/** Mount the Web bundle through a real Loader with optional launcher readiness. */
async function bootWeb(ready?: AppReady, printUrl = false): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-browser-open-'))
  tempRoots.push(root)
  const dist = join(root, 'dist')
  mkdirSync(dist)
  const index = join(dist, 'index.html')
  writeFileSync(index, '<!doctype html><title>ready</title>')
  internals.resolveDistIndex = () => index

  const webserverModule = join(root, 'webserver.mjs')
  const connectionModule = join(root, 'connection.mjs')
  const webAppModule = join(root, 'web-app.mjs')
  writeFileSync(webserverModule, 'export default globalThis.__dshWebServer\n')
  writeFileSync(connectionModule, [
    "export const inject = ['webServer']",
    "export const apply = ctx => ctx.provide('connection', globalThis.__dshConnection)",
    '',
  ].join('\n'))
  writeFileSync(webAppModule, [
    "export const name = 'fixture-web-app'",
    "export const inject = ['webServer']",
    'export const apply = (ctx, config) => globalThis.__dshWebAppApply(ctx, config)',
    '',
  ].join('\n'))
  const config = join(root, 'cordis.yml')
  writeFileSync(config, [
    '- id: webserver',
    `  name: ${pathToFileURL(webserverModule).href}`,
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: connection',
    `  name: ${pathToFileURL(connectionModule).href}`,
    '- id: web-app',
    `  name: ${pathToFileURL(webAppModule).href}`,
    '  config:',
    '    openBrowser: true',
    `    printUrl: ${String(printUrl)}`,
    '    surfaceContext: false',
    '    trustedHosts: []',
    '',
  ].join('\n'))

  const globals = globalThis as unknown as {
    __dshWebAppApply: typeof apply
    __dshWebServer: typeof WebServer
    __dshConnection: {
      authenticatedUrl(baseUrl: string): string
      authorizeIndex(): boolean
      requestRejection(): undefined
      rpc: object
    }
  }
  globals.__dshWebAppApply = apply
  globals.__dshWebServer = WebServer
  globals.__dshConnection = {
    authenticatedUrl: (baseUrl) => {
      const url = new URL(baseUrl)
      url.searchParams.set('token', 'fixture-token')
      return url.href
    },
    authorizeIndex: () => true,
    requestRejection: () => undefined,
    rpc: {},
  }

  const ctx = new Context()
  contexts.push(ctx)
  if (ready !== undefined) ctx.provide('appReady', ready)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(config).href },
  })
  await ctx.loader.await()
  return ctx
}

/** One-shot launcher readiness, committed independently of Loader settlement. */
function startupReadiness(): { service: AppReady; commit(): void; listeners: Set<() => void> } {
  const listeners = new Set<() => void>()
  let committed = false
  return {
    service: {
      onReady(listener) {
        if (committed) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (committed) return
      committed = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
    listeners,
  }
}

describe('web app browser startup', () => {
  it('opens the canonical URL only after the complete page is reachable', async () => {
    let openedUrl: string | undefined
    let openedStatus: number | undefined
    let resolveOpened!: () => void
    const opened = new Promise<void>((resolve) => { resolveOpened = resolve })
    internals.openBrowser = async (url) => {
      openedUrl = url
      const response = await fetch(url)
      openedStatus = response.status
      await response.arrayBuffer()
      resolveOpened()
    }
    const ctx = await bootWeb()
    await opened

    expect(openedUrl).toBe(`http://127.0.0.1:${String(ctx.webServer.port)}/?token=fixture-token`)
    expect(openedStatus).toBe(200)
  })

  it('waits for launcher readiness after the Loader settles before announcing a reachable URL', async () => {
    const ready = startupReadiness()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    const ctx = await bootWeb(ready.service, true)

    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    ready.commit()
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}/?token=fixture-token`
    expect(log.mock.calls).toEqual([
      [`dsh web: ${url}`],
      ['dsh web: opening the default browser; pass --no-open to disable'],
    ])
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(url)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    ready.commit()
    expect(log).toHaveBeenCalledTimes(2)
    expect(openBrowser).toHaveBeenCalledTimes(1)
  })

  it('stays silent and cancels its announcement when startup is disposed before readiness', async () => {
    const ready = startupReadiness()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    const ctx = await bootWeb(ready.service, true)

    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    expect(ready.listeners.size).toBe(1)
    await ctx.fiber.dispose()
    expect(ready.listeners.size).toBe(0)
    ready.commit()
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
  })
})
