/** Real listener and durable-settings lifecycle; each case owns its home and sockets. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Settings from '@deepseek-ai/dsh-settings-file'
import { assertEntriesActivated } from '@deepseek-ai/dsh-app-boot'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { multiaddr } from '@multiformats/multiaddr'
import { afterEach, describe, expect, it } from 'vitest'
import Transport from '../src/libp2p-settings.ts'
import type { Config } from '../src/libp2p.ts'

const config: Config = {
  listenAddresses: ['/ip4/127.0.0.1/tcp/0'], maxRequestBytes: 4096, maxResponseBytes: 4096,
  maxInboundRequests: 4, maxOutboundRequests: 4, maxConnections: 8,
  requestTimeoutMs: 5000, connectionTimeoutMs: 3000,
}
const cleanups: Array<() => Promise<unknown>> = []
const protocol = '/agentharness/scope-network-test/1'

declare module '@deepseek-ai/cordis' {
  interface Context {
    scopeNetworkFixture: {
      directory: string
      credentialsPath: string
      settingsPath: string
      withSettings: boolean
      transport: Config
    }
  }
}

afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!() })

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-scope-network-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function boot(directory: string, options: Partial<Config> = {}, withSettings = true): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('scopeNetworkFixture', { directory, credentialsPath: join(directory, 'credentials.yml'),
    settingsPath: join(directory, 'settings.yml'), withSettings, transport: { ...config, ...options } })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['scope-test-credentials'] = Credentials
  ctx.loader.builtins['scope-test-settings'] = Settings
  ctx.loader.builtins['scope-test-transport'] = Transport
  const configPath = join(await mkdtemp(join(directory, 'boot-')), 'cordis.yml')
  await writeFile(configPath, await readFile(new URL('./fixtures/settings.cordis.yml', import.meta.url)))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await assertEntriesActivated(ctx, 'scope-network-test')
  await ctx.scopeTransport.identity()
  return ctx
}

function namespace(ctx: Context) {
  const result = ctx.settings.describe().find(value => value.ns === 'scope-network')
  if (result === undefined) throw new Error('scope-network registration is absent')
  return result
}

describe('persistent scope network listeners', () => {
  it('keeps current requests on the original listener until same-home restart applies saved settings with the same PeerId', async () => {
    const directory = await home()
    const first = await boot(directory)
    const original = await first.scopeTransport.identity()
    const address = original.addresses[0]
    if (address === undefined) throw new Error('transport did not bind a listener')
    const port = multiaddr(address).getComponents()[1]?.value
    if (port === undefined || port === '0') throw new Error('transport did not allocate its port')
    expect(namespace(first)).toMatchObject({ applies: 'restart', value: { listenAddresses: config.listenAddresses } })
    const next = [`/ip4/0.0.0.0/tcp/${port}`]
    await first.settings.update('scope-network', { listenAddresses: next }, namespace(first).revision)
    expect(namespace(first).value).toEqual({ listenAddresses: next })
    expect(await first.scopeTransport.identity()).toEqual(original)
    first.effect(() => first.scopeTransport.register(protocol, async request => request.payload))
    const peer = await boot(await home())
    await expect(peer.scopeTransport.request(
      { peerId: original.peerId, address }, protocol, { retained: true }, new AbortController().signal))
      .resolves.toEqual({ retained: true })
    expect(await readFile(join(directory, 'settings.yml'), 'utf8')).toContain(next[0])
    await first.fiber.dispose()

    // This is the originally bound port, retained across a real process-lifecycle equivalent restart, not a free-port scan.
    const restarted = await boot(directory)
    const actual = await restarted.scopeTransport.identity()
    expect(actual.peerId).toBe(original.peerId)
    expect(actual.addresses).toContain(`/ip4/127.0.0.1/tcp/${port}/p2p/${original.peerId}`)
    expect(actual.addresses.every(value => multiaddr(value).getComponents()[1]?.value === port)).toBe(true)
    restarted.effect(() => restarted.scopeTransport.register(protocol, async request => request.payload))
    await expect(peer.scopeTransport.request(
      { peerId: actual.peerId, address }, protocol, { restarted: true }, new AbortController().signal))
      .resolves.toEqual({ restarted: true })
  })

  it('refuses a missing settings provider through the actual launcher activation check', async () => {
    await expect(boot(await home(), {}, false)).rejects.toThrow(/waiting for service: settings/)
  })

  it.each([
    [], ['/dns4/example.test/tcp/1234'], ['/ip4/127.0.0.1/tcp/1234/p2p-circuit'],
    ['/ip4/127.0.0.1/tcp/1234', '/ip4/127.0.0.1/tcp/1234'],
    ['/ip4/0.0.0.0/tcp/0'], ['/ip6/::/tcp/0'], ['/ip4/192.0.2.1/tcp/0'],
  ].map(listenAddresses => ({ listenAddresses })))('rejects invalid managed settings without persisting or changing the listener: $listenAddresses', async ({ listenAddresses }) => {
    const directory = await home()
    const ctx = await boot(directory)
    await ctx.settings.update('scope-network', { listenAddresses: config.listenAddresses })
    const before = await readFile(join(directory, 'settings.yml'), 'utf8')
    const observed = namespace(ctx)
    const identity = await ctx.scopeTransport.identity()
    await expect(ctx.settings.update('scope-network', { listenAddresses }, observed.revision)).rejects.toThrow()
    expect(await readFile(join(directory, 'settings.yml'), 'utf8')).toBe(before)
    expect(namespace(ctx)).toEqual(observed)
    expect(await ctx.scopeTransport.identity()).toEqual(identity)
  })

  it('rejects a non-loopback ephemeral composition listener rather than giving base values a validation exception', async () => {
    await expect(boot(await home(), { listenAddresses: ['/ip4/0.0.0.0/tcp/0'] })).rejects.toThrow(/non-loopback.*nonzero/)
  })

  it('refuses invalid saved listener settings without replacing them or falling back to the composition', async () => {
    const directory = await home()
    const path = join(directory, 'settings.yml')
    const invalid = 'scope-network:\n  listenAddresses: ["/ip4/0.0.0.0/tcp/0"]\n'
    await writeFile(path, invalid)
    await expect(boot(directory)).rejects.toThrow(/non-loopback.*nonzero/)
    expect(await readFile(path, 'utf8')).toBe(invalid)
  })

  it('reports an occupied saved port as startup failure and can recover after that listener closes', async () => {
    const server = createServer()
    const close = async (): Promise<void> => {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    }
    cleanups.push(close)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test listener has no TCP address')
    const directory = await home()
    const path = join(directory, 'settings.yml')
    const retained = `scope-network:\n  listenAddresses: ["/ip4/127.0.0.1/tcp/${address.port}"]\n`
    await writeFile(path, retained)
    await expect(boot(directory)).rejects.toThrow(/scope-transport\/unavailable/)
    expect(await readFile(path, 'utf8')).toBe(retained)
    await close()
    const ctx = await boot(directory)
    expect((await ctx.scopeTransport.identity()).addresses.some(value => value.includes(`/tcp/${address.port}/`))).toBe(true)
  })

  it('removes its settings registration and rejects captured transport calls when the provider is unloaded', async () => {
    const ctx = await boot(await home())
    const transport = ctx.scopeTransport
    const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:scope-test-transport')
    if (entry?.fiber === undefined) throw new Error('test transport entry is absent')
    await entry.fiber.dispose()
    expect(ctx.settings.describe().some(value => value.ns === 'scope-network')).toBe(false)
    await expect(transport.identity()).rejects.toMatchObject({ code: 'scope-transport/stopped' })
  })
})
