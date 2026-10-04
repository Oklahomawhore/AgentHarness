import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import Transport, { type Config } from '../src/libp2p.ts'
import type { ScopeTransportIdentity, ScopeTransportTarget } from '../src/types.ts'
import { identityKey } from '../src/identity.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    scopeTransportFixture: { directory: string; credentialsPath: string; transport: Config }
  }
}

const protocol = '/agentharness/scope-transport-test/1'
const cleanups: Array<() => Promise<unknown>> = []
const config: Config = {
  listenAddresses: ['/ip4/127.0.0.1/tcp/0'], maxRequestBytes: 4096, maxResponseBytes: 4096,
  maxInboundRequests: 4, maxOutboundRequests: 4, maxConnections: 8,
  requestTimeoutMs: 5000, connectionTimeoutMs: 3000,
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-scope-transport-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function credentials(path: string): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Credentials, { path: join(path, 'credentials.yml'), dshHome: path, watch: false })
  return ctx
}

async function boot(options: Partial<Config> = {}, path?: string): Promise<Context> {
  const ctx = await credentials(path ?? await directory())
  await ctx.plugin(Transport, { ...config, ...options })
  await ctx.scopeTransport.identity()
  return ctx
}

async function loaderBoot(): Promise<Context> {
  const path = await directory()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('scopeTransportFixture', { directory: path, credentialsPath: join(path, 'credentials.yml'), transport: config })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', Credentials],
    ['@deepseek-ai/dsh-scope-transport/libp2p', Transport],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected test import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } })
  await ctx.loader.await()
  await ctx.scopeTransport.identity()
  return ctx
}

function target(identity: ScopeTransportIdentity): ScopeTransportTarget {
  return { peerId: identity.peerId, address: identity.addresses[0]! }
}

function register(ctx: Context, handler: Parameters<Context['scopeTransport']['register']>[1]): () => Promise<void> {
  return ctx.effect(() => ctx.scopeTransport.register(protocol, handler))
}

function waitForAbort(signal: AbortSignal): Promise<undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve(undefined) }, { once: true }) })
}

describe('direct authenticated scope transport', () => {
  it('boots the Loader composition and gives handlers Noise identity instead of payload identity', async () => {
    const owner = await loaderBoot()
    const peer = await loaderBoot()
    const outsider = await boot()
    const ownerIdentity = await owner.scopeTransport.identity()
    const peerIdentity = await peer.scopeTransport.identity()
    expect(ownerIdentity.peerId).not.toBe(peerIdentity.peerId)
    expect(Object.keys(ownerIdentity).sort()).toEqual(['addresses', 'peerId'])
    expect(owner.scopeTransport.limits()).toEqual({ maxInboundRequests: config.maxInboundRequests,
      maxOutboundRequests: config.maxOutboundRequests, requestTimeoutMs: config.requestTimeoutMs })
    expect(ownerIdentity.addresses.every(address => address.startsWith('/ip4/127.0.0.1/tcp/'))).toBe(true)
    register(owner, async request => request.peerId === peerIdentity.peerId
      ? { allowed: true, sender: request.peerId, payload: request.payload }
      : { allowed: false })
    const payload = { peerId: ownerIdentity.peerId, text: '独立会话 🧭' }
    expect(await peer.scopeTransport.request(target(ownerIdentity), protocol, payload, new AbortController().signal))
      .toEqual({ allowed: true, sender: peerIdentity.peerId, payload })
    expect(await outsider.scopeTransport.request(target(ownerIdentity), protocol, payload, new AbortController().signal))
      .toEqual({ allowed: false })
  })

  it('refuses address/identity mismatches and a wrong Noise target before a later successful request', async () => {
    const owner = await boot()
    const peer = await boot()
    const stranger = await boot()
    const destination = target(await owner.scopeTransport.identity())
    const strangerId = (await stranger.scopeTransport.identity()).peerId
    let calls = 0
    register(owner, async () => { calls++; return 'allowed' })
    await expect(peer.scopeTransport.request({ ...destination, peerId: strangerId }, protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/invalid-target' })
    const wrongIdentity = { peerId: strangerId, address: destination.address.replace(destination.peerId, strangerId) }
    await expect(peer.scopeTransport.request(wrongIdentity, protocol, null, new AbortController().signal)).rejects.toMatchObject({ code: 'scope-transport/unavailable' })
    expect(calls).toBe(0)
    expect(await peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('allowed')
    expect(calls).toBe(1)
  })

  it('reuses one atomically committed key across concurrent starts and restart', async () => {
    const path = await directory()
    const [first, concurrent] = await Promise.all([boot({}, path), boot({}, path)])
    const identity = await first.scopeTransport.identity()
    expect((await concurrent.scopeTransport.identity()).peerId).toBe(identity.peerId)
    const before = await readFile(join(path, 'credentials.yml'), 'utf8')
    await Promise.all([first.fiber.dispose(), concurrent.fiber.dispose()])
    const restarted = await boot({}, path)
    expect((await restarted.scopeTransport.identity()).peerId).toBe(identity.peerId)
    expect(await readFile(join(path, 'credentials.yml'), 'utf8')).toBe(before)
  })

  it('admits a protocol registered during identity startup without a readiness delay', async () => {
    const owner = await credentials(await directory())
    const peer = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const modify = owner.credentials.modifyRecord.bind(owner.credentials)
    vi.spyOn(owner.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      entered.resolve(undefined)
      await release.promise
      return await modify(key, mutate)
    })
    const startup = owner.plugin(Transport, config)
    await entered.promise
    register(owner, () => Promise.resolve('ready'))
    const identity = owner.scopeTransport.identity()
    release.resolve(undefined)
    await startup
    expect(await peer.scopeTransport.request(target(await identity), protocol, null, new AbortController().signal)).toBe('ready')
  })

  it('settles disposal while credential initialization is still in flight', async () => {
    const path = await directory()
    const owner = await credentials(path)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const modify = owner.credentials.modifyRecord.bind(owner.credentials)
    vi.spyOn(owner.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      entered.resolve(undefined)
      await release.promise
      return await modify(key, mutate)
    })
    const startup = owner.plugin(Transport, config)
    // Dependency removal can fail the credential operation before this provider's disposer runs.
    const rejected = expect(startup).rejects.toMatchObject({ name: 'ScopeTransportError' })
    await entered.promise
    const service = owner.scopeTransport
    const disposing = owner.fiber.dispose()
    release.resolve(undefined)
    await disposing
    await rejected
    await expect(service.identity()).rejects.toMatchObject({ code: 'scope-transport/stopped' })
    await expect(readFile(join(path, 'credentials.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors the request deadline while identity startup is blocked, then handles a later request', async () => {
    const owner = await boot()
    const peer = await credentials(await directory())
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const modify = peer.credentials.modifyRecord.bind(peer.credentials)
    vi.spyOn(peer.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      entered.resolve(undefined)
      await release.promise
      return await modify(key, mutate)
    })
    const startup = peer.plugin(Transport, { ...config, requestTimeoutMs: 100 })
    await entered.promise
    let calls = 0
    register(owner, async () => { calls++; return 'ready' })
    const destination = target(await owner.scopeTransport.identity())
    try {
      await expect(peer.scopeTransport.request(destination, protocol, null, new AbortController().signal))
        .rejects.toMatchObject({ code: 'scope-transport/timeout' })
      expect(calls).toBe(0)
    } finally {
      release.resolve(undefined)
      await startup
    }
    expect(await peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('ready')
  })

  it.each<CredentialRecord>([
    { kind: 'api-key', key: 'not-a-transport-key' },
    { kind: 'grant', payload: { version: 2, privateKey: 'invalid' } },
    { kind: 'grant', payload: { version: 1, privateKey: 'invalid' } },
  ])('refuses malformed identity records without replacing them: %j', async (record) => {
    const ctx = await credentials(await directory())
    await ctx.credentials.modifyRecord(identityKey, () => Promise.resolve(record))
    await expect(ctx.plugin(Transport, config)).rejects.toMatchObject({ code: 'scope-transport/identity-invalid' })
    expect(await ctx.credentials.readRecord(identityKey)).toEqual(record)
  })

  it('rejects a stored key whose public half does not match its signing key', async () => {
    const ctx = await credentials(await directory())
    const bytes = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    const record = { kind: 'grant', payload: { version: 1, privateKey: Buffer.from(bytes).toString('base64') } } as const
    await ctx.credentials.modifyRecord(identityKey, () => Promise.resolve(record))
    await expect(ctx.plugin(Transport, config)).rejects.toMatchObject({ code: 'scope-transport/identity-invalid' })
    expect(await ctx.credentials.readRecord(identityKey)).toEqual(record)
  })

  it('keeps a live identity fixed when its credential is removed and creates a new identity only at restart', async () => {
    const path = await directory()
    const ctx = await boot({}, path)
    const original = await ctx.scopeTransport.identity()
    await ctx.credentials.deleteRecord(identityKey)
    expect((await ctx.scopeTransport.identity()).peerId).toBe(original.peerId)
    await ctx.fiber.dispose()
    const restarted = await boot({}, path)
    expect((await restarted.scopeTransport.identity()).peerId).not.toBe(original.peerId)
  })

  it('bounds complete UTF-8 envelopes and snapshots payload before any asynchronous work', async () => {
    const exact = { text: '🧭' }
    const maxRequestBytes = Buffer.byteLength(JSON.stringify({ version: 1, payload: exact }))
    const owner = await boot()
    const peer = await boot({ maxRequestBytes })
    register(owner, request => Promise.resolve(request.payload))
    const destination = target(await owner.scopeTransport.identity())
    const pending = peer.scopeTransport.request(destination, protocol, exact, new AbortController().signal)
    exact.text = 'changed'
    expect(await pending).toEqual({ text: '🧭' })
    await expect(peer.scopeTransport.request(destination, protocol, { text: '🧭x' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/request-too-large' })
    await expect(peer.scopeTransport.request(destination, protocol, { absent: undefined }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/invalid-json' })
  })

  it('contains handler failures and oversized results, then accepts another request', async () => {
    const owner = await boot({ maxResponseBytes: 128 })
    const peer = await boot()
    register(owner, async ({ payload }) => {
      if (payload === 'throw') throw new Error('private-handler-detail-must-not-travel')
      return payload === 'large' ? '🧭'.repeat(128) : { ok: true }
    })
    const destination = target(await owner.scopeTransport.identity())
    await expect(peer.scopeTransport.request(destination, protocol, 'throw', new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/remote-failed', message: 'scope-transport/remote-failed' })
    await expect(peer.scopeTransport.request(destination, protocol, 'large', new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/response-too-large' })
    expect(await peer.scopeTransport.request(destination, protocol, 'valid', new AbortController().signal)).toEqual({ ok: true })
  })

  it('cancels an admitted handler when the requesting peer aborts', async () => {
    const owner = await boot()
    const peer = await boot()
    const entered = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    register(owner, async ({ signal }) => {
      entered.resolve(undefined)
      await waitForAbort(signal)
      settled.resolve(undefined)
      return 'late result'
    })
    const cancellation = new AbortController()
    const pending = peer.scopeTransport.request(target(await owner.scopeTransport.identity()), protocol, null, cancellation.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'scope-transport/cancelled' })
    await entered.promise
    cancellation.abort()
    await rejected
    await settled.promise
  })

  it('cancels timed out work and reuses capacity for the next request', async () => {
    const owner = await boot()
    const peer = await boot({ requestTimeoutMs: 100, maxOutboundRequests: 1 })
    const settled = Promise.withResolvers<undefined>()
    register(owner, async ({ payload, signal }) => {
      if (payload === 'wait') {
        await waitForAbort(signal)
        settled.resolve(undefined)
      }
      return 'done'
    })
    const destination = target(await owner.scopeTransport.identity())
    await expect(peer.scopeTransport.request(destination, protocol, 'wait', new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/timeout' })
    await settled.promise
    expect(await peer.scopeTransport.request(destination, protocol, 'next', new AbortController().signal)).toBe('done')
  })

  it('enforces provider-wide outbound and inbound admission while another request is pending', async () => {
    const owner = await boot({ maxInboundRequests: 1 })
    const first = await boot({ maxOutboundRequests: 1 })
    const second = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let calls = 0
    register(owner, async ({ signal }) => {
      calls++
      entered.resolve(undefined)
      await Promise.race([release.promise, waitForAbort(signal)])
      return 'done'
    })
    const destination = target(await owner.scopeTransport.identity())
    const pending = first.scopeTransport.request(destination, protocol, null, new AbortController().signal)
    await entered.promise
    await expect(first.scopeTransport.request(destination, protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/capacity' })
    await expect(second.scopeTransport.request(destination, protocol, null, new AbortController().signal)).rejects.toBeDefined()
    expect(calls).toBe(1)
    release.resolve(undefined)
    expect(await pending).toBe('done')
    expect(await second.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('done')
    expect(calls).toBe(2)
  })

  it('unregisters an admitted handler, waits for cancellation, and permits a replacement registration', async () => {
    const owner = await boot()
    const peer = await boot()
    const entered = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    const dispose = register(owner, async ({ signal }) => {
      entered.resolve(undefined)
      await waitForAbort(signal)
      settled.resolve(undefined)
      return null
    })
    const destination = target(await owner.scopeTransport.identity())
    const pending = peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)
    const rejected = expect(pending).rejects.toBeDefined()
    await entered.promise
    await dispose()
    await rejected
    await settled.promise
    register(owner, () => Promise.resolve('replacement'))
    expect(await peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('replacement')
  })

  it('disposes to quiescence, closes its listener, and rejects methods on a captured service', async () => {
    const owner = await boot()
    const peer = await boot()
    const service = owner.scopeTransport
    const destination = target(await service.identity())
    const entered = Promise.withResolvers<undefined>()
    let settled = false
    register(owner, async ({ signal }) => {
      entered.resolve(undefined)
      await waitForAbort(signal)
      settled = true
      return null
    })
    const pending = peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)
    const rejected = expect(pending).rejects.toBeDefined()
    await entered.promise
    await owner.fiber.dispose()
    await rejected
    expect(settled).toBe(true)
    await expect(service.identity()).rejects.toMatchObject({ code: 'scope-transport/stopped' })
    await expect(service.request(destination, protocol, null, new AbortController().signal)).rejects.toMatchObject({ code: 'scope-transport/stopped' })
    expect(() => service.register(protocol, () => Promise.resolve(null))).toThrow('scope-transport/stopped')
    expect(() => service.limits()).toThrow('scope-transport/stopped')
    const port = Number(multiaddr(destination.address).getComponents()[1]!.value)
    const closed = new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); reject(new Error('listener remained open')) })
      socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code!) })
    })
    expect(await closed).toBe('ECONNREFUSED')
  })

  it('rejects malformed wire JSON before a handler and survives the bad stream', async () => {
    const owner = await boot()
    const peer = await boot()
    const raw = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] }, transports: [tcp()],
      connectionEncrypters: [noise()], streamMuxers: [yamux()],
      peerDiscovery: [], services: {}, connectionMonitor: { enabled: false },
    })
    cleanups.push(async () => { await raw.stop() })
    let calls = 0
    register(owner, async () => { calls++; return 'valid' })
    const destination = target(await owner.scopeTransport.identity())
    const stream = await raw.dialProtocol(multiaddr(destination.address), protocol)
    stream.send(Buffer.from('{'))
    await stream.close()
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk.subarray())
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ version: 1, ok: false, code: 'invalid-json' })
    expect(calls).toBe(0)
    expect(await peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('valid')
  })

  it('rejects invalid UTF-8 and receiver-side request overflow without admitting a handler', async () => {
    const owner = await boot({ maxRequestBytes: 64 })
    const peer = await boot()
    const raw = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] }, transports: [tcp()],
      connectionEncrypters: [noise()], streamMuxers: [yamux()],
      peerDiscovery: [], services: {}, connectionMonitor: { enabled: false },
    })
    cleanups.push(async () => { await raw.stop() })
    let calls = 0
    register(owner, async () => { calls++; return 'valid' })
    const destination = target(await owner.scopeTransport.identity())
    const stream = await raw.dialProtocol(multiaddr(destination.address), protocol)
    stream.send(Buffer.from([0xff]))
    await stream.close()
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk.subarray())
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ version: 1, ok: false, code: 'invalid-json' })
    await expect(peer.scopeTransport.request(destination, protocol, 'x'.repeat(512), new AbortController().signal)).rejects.toBeDefined()
    expect(calls).toBe(0)
    expect(await peer.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('valid')
  })

  it('rejects malformed and oversized peer responses then accepts a bounded complete response', async () => {
    const peer = await boot({ maxResponseBytes: 128 })
    const raw = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] }, transports: [tcp()],
      connectionEncrypters: [noise()], streamMuxers: [yamux()],
      peerDiscovery: [], services: {}, connectionMonitor: { enabled: false },
    })
    cleanups.push(async () => { await raw.stop() })
    let response = Buffer.from(JSON.stringify({ version: 1, ok: true, payload: 'x'.repeat(512) }))
    await raw.handle(protocol, async (stream) => {
      for await (const _chunk of stream) { /* Drain the bounded test request before sending the selected response. */ }
      stream.send(response)
      await stream.close()
    })
    const identity = { peerId: raw.peerId.toString() as ScopeTransportIdentity['peerId'], addresses: raw.getMultiaddrs().map(address => address.toString()) }
    await expect(peer.scopeTransport.request(target(identity), protocol, null, new AbortController().signal)).rejects.toBeDefined()
    response = Buffer.from(JSON.stringify({ version: 1, ok: ['true'], payload: null }))
    await expect(peer.scopeTransport.request(target(identity), protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/invalid-json' })
    response = Buffer.from([0xff])
    await expect(peer.scopeTransport.request(target(identity), protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/invalid-json' })
    response = Buffer.from(JSON.stringify({ version: 1, ok: true, payload: '🧭' }))
    expect(await peer.scopeTransport.request(target(identity), protocol, null, new AbortController().signal)).toBe('🧭')
  })

  it('rejects a cancelled call before dialing or invoking its handler', async () => {
    const owner = await boot()
    const peer = await boot()
    let calls = 0
    register(owner, async () => { calls++; return null })
    await expect(peer.scopeTransport.request(target(await owner.scopeTransport.identity()), protocol, null, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'scope-transport/cancelled' })
    expect(calls).toBe(0)
  })

  it.each([
    { listenAddresses: ['/dns4/example.test/tcp/1234'] },
    { listenAddresses: ['/ip4/127.0.0.1/tcp/0/p2p-circuit'] },
    { requestTimeoutMs: 2_147_483_648 },
    { maxResponseBytes: 1 },
  ])('rejects unsupported listeners and invalid bounds: %j', async (invalid) => {
    const ctx = await credentials(await directory())
    await expect(ctx.plugin(Transport, { ...config, ...invalid })).rejects.toThrow()
  })
})
