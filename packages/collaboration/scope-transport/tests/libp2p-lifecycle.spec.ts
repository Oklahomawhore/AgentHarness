/** Real node lifecycle with controlled registrar and credential transaction failures. */
import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLibp2p } from 'libp2p'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Transport, { type Config } from '../src/libp2p.ts'
import { identityKey } from '../src/identity.ts'
import type { ScopeTransportIdentity } from '../src/types.ts'

vi.mock('libp2p', async (importOriginal) => {
  const actual = await importOriginal<typeof import('libp2p')>()
  return { ...actual, createLibp2p: vi.fn(actual.createLibp2p) }
})

const config: Config = {
  listenAddresses: ['/ip4/127.0.0.1/tcp/0'], maxRequestBytes: 4096, maxResponseBytes: 4096,
  maxInboundRequests: 4, maxOutboundRequests: 4, maxConnections: 8,
  requestTimeoutMs: 5000, connectionTimeoutMs: 3000,
}
const protocol = '/agentharness/scope-lifecycle/1'
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
  vi.mocked(createLibp2p).mockClear()
})

async function credentials() {
  const path = await mkdtemp(join(tmpdir(), 'dsh-scope-lifecycle-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Credentials, { path: join(path, 'credentials.yml'), dshHome: path, watch: false })
  return { ctx, path }
}

async function boot() {
  const value = await credentials()
  await value.ctx.plugin(Transport, config)
  await value.ctx.scopeTransport.identity()
  const result = vi.mocked(createLibp2p).mock.results.at(-1)
  if (result?.type !== 'return') throw new Error('Transport did not create its libp2p node')
  return { ...value, node: await result.value }
}

function target(identity: ScopeTransportIdentity) {
  const address = identity.addresses[0]
  if (address === undefined) throw new Error('Transport did not bind its listener')
  return { peerId: identity.peerId, address }
}

describe('libp2p scope provider lifecycle', () => {
  it.each([
    { options: { listenAddresses: ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0'] }, message: 'duplicate listenAddresses' },
    { options: { maxConnections: Number.MAX_SAFE_INTEGER + 1 }, message: 'invalid maxConnections' },
  ])('rejects invalid admitted configuration before creating an identity: $message', async ({ options, message }) => {
    const { ctx, path } = await credentials()
    await expect(ctx.plugin(Transport, { ...config, ...options })).rejects.toThrow(message)
    await expect(readFile(join(path, 'credentials.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid and duplicate protocol registrations without replacing the live handler', async () => {
    const { ctx } = await boot()
    const peer = await boot()
    const handler = vi.fn(async () => 'original')
    const replacement = vi.fn(async () => 'replacement')
    for (const name of ['', 'missing-leading-slash', '/invalid\0protocol']) {
      expect(() => ctx.scopeTransport.register(name, replacement)).toThrow('scope-transport: invalid protocol name')
    }
    ctx.effect(() => ctx.scopeTransport.register(protocol, handler))
    expect(() => ctx.scopeTransport.register(protocol, replacement)).toThrow('protocol is already registered')
    expect(await peer.ctx.scopeTransport.request(target(await ctx.scopeTransport.identity()), protocol, null, new AbortController().signal))
      .toBe('original')
    expect(handler).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
  })

  it('keeps an old disposer idempotent after a replacement protocol is registered', async () => {
    const { ctx } = await boot()
    const peer = await boot()
    const unregister = ctx.scopeTransport.register(protocol, async () => 'original')
    ctx.effect(() => unregister)
    unregister()
    unregister()
    ctx.effect(() => ctx.scopeTransport.register(protocol, async () => 'replacement'))
    unregister()
    expect(await peer.ctx.scopeTransport.request(target(await ctx.scopeTransport.identity()), protocol, null, new AbortController().signal))
      .toBe('replacement')
  })

  it('retains the live identity after its persisted key is replaced and reports that restart is required', async () => {
    const { ctx } = await boot()
    const before = await ctx.scopeTransport.identity()
    const warning = vi.spyOn(ctx.logger, 'warn')
    const key = await generateKeyPair('Ed25519')
    await ctx.credentials.modifyRecord(identityKey, async () => ({ kind: 'grant', payload: {
      version: 1, privateKey: Buffer.from(privateKeyToProtobuf(key)).toString('base64'),
    } }))
    expect(await ctx.scopeTransport.identity()).toEqual(before)
    expect(warning).toHaveBeenCalledWith('scope-transport: identity credential changed; restart required')
  })

  it('rejects a waiting request when its real credential transaction fails during startup', async () => {
    const owner = await boot()
    const { ctx, path } = await credentials()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, update) => {
      if (key !== identityKey) return await modify(key, update)
      entered.resolve(undefined)
      await release.promise
      throw new Error('fixture credential transaction failed')
    })
    const startup = ctx.plugin(Transport, config)
    const failedStartup = expect(startup).rejects.toMatchObject({ code: 'scope-transport/unavailable' })
    try {
      await entered.promise
      const request = ctx.scopeTransport.request(
        target(await owner.ctx.scopeTransport.identity()), protocol, null, new AbortController().signal)
      const failedRequest = expect(request).rejects.toMatchObject({ code: 'scope-transport/unavailable' })
      release.resolve(undefined)
      await Promise.all([failedStartup, failedRequest])
      await expect(readFile(join(path, 'credentials.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release.resolve(undefined); await Promise.resolve(startup).catch(() => undefined) }
  })

  it('does not mount a protocol unregistered while credential creation still prevents node startup', async () => {
    const peer = await boot()
    const { ctx } = await credentials()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, update) => {
      if (key === identityKey) { entered.resolve(undefined); await release.promise }
      return await modify(key, update)
    })
    const nodesBefore = vi.mocked(createLibp2p).mock.calls.length
    const startup = ctx.plugin(Transport, config)
    try {
      await entered.promise
      expect(vi.mocked(createLibp2p)).toHaveBeenCalledTimes(nodesBefore)
      const service = ctx.scopeTransport
      const removed = vi.fn(async () => 'removed handler')
      const unregister = service.register(protocol, removed)
      ctx.effect(() => unregister)
      unregister()
      release.resolve(undefined)
      await startup
      const destination = target(await service.identity())
      await expect(peer.ctx.scopeTransport.request(destination, protocol, null, new AbortController().signal))
        .rejects.toMatchObject({ code: 'scope-transport/unavailable' })
      expect(removed).not.toHaveBeenCalled()
      ctx.effect(() => service.register(protocol, async () => 'replacement'))
      expect(await peer.ctx.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('replacement')
    } finally { release.resolve(undefined); await Promise.resolve(startup).catch(() => undefined) }
  })

  it('fails closed after the real node rejects protocol registration and preserves that reason through stop', async () => {
    const { ctx, node } = await boot()
    const peer = await boot()
    const service = ctx.scopeTransport
    const destination = target(await service.identity())
    vi.spyOn(node, 'handle').mockRejectedValueOnce(new Error('fixture registrar rejected the protocol'))
    ctx.effect(() => service.register(protocol, async () => null))
    await expect(service.request(destination, protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/registration-failed' })
    expect(() => service.limits()).toThrow('scope-transport/registration-failed')
    await expect(service.identity()).rejects.toMatchObject({ code: 'scope-transport/registration-failed' })
    await ctx.fiber.dispose()
    await expect(service.request(target(await peer.ctx.scopeTransport.identity()), protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/registration-failed' })
  })

  it('contains a registrar rejection that settles after the provider has stopped', async () => {
    const { ctx, node } = await boot()
    const service = ctx.scopeTransport
    const pending = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    cleanups.push(async () => { pending.resolve(undefined) })
    node.addEventListener('stop', () => { stopped.resolve(undefined) }, { once: true })
    vi.spyOn(node, 'handle').mockReturnValueOnce(pending.promise)
    ctx.effect(() => service.register(protocol, async () => null))
    const disposing = ctx.fiber.dispose()
    try {
      await stopped.promise
      pending.reject(new Error('late registrar failure'))
      await disposing
      expect(() => service.limits()).toThrow('scope-transport/stopped')
    } finally { pending.resolve(undefined); await disposing }
  })

  it('contains a real response-stream write failure without exposing handler details or replaying the command', async () => {
    const { ctx, node } = await boot()
    const peer = await boot()
    const handle = node.handle.bind(node)
    let injected = false
    vi.spyOn(node, 'handle').mockImplementationOnce((protocols, callback, options) => handle(protocols, async (stream, connection) => {
      const failure = injected ? undefined : vi.spyOn(stream, 'send').mockImplementationOnce(() => { throw new Error('write refused') })
      injected = true
      try { await callback(stream, connection) }
      finally { failure?.mockRestore() }
    }, options))
    const handler = vi.fn().mockRejectedValueOnce(new Error('private handler detail')).mockResolvedValue('bounded result')
    ctx.effect(() => ctx.scopeTransport.register(protocol, handler))
    const destination = target(await ctx.scopeTransport.identity())
    await expect(peer.ctx.scopeTransport.request(destination, protocol, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'scope-transport/unavailable', message: 'scope-transport/unavailable' })
    expect(handler).toHaveBeenCalledOnce()
    expect(await peer.ctx.scopeTransport.request(destination, protocol, null, new AbortController().signal)).toBe('bounded result')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('keeps provider disposal pending until an admitted handler finishes its cooperative cancellation', async () => {
    const { ctx } = await boot()
    const peer = await boot()
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    cleanups.push(async () => { released.resolve(undefined) })
    let settled = false
    const consumer = new Context()
    cleanups.push(() => consumer.fiber.dispose())
    consumer.effect(() => ctx.scopeTransport.register(protocol, async ({ signal }) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      aborted.resolve(undefined)
      await released.promise
      settled = true
      return null
    }))
    const request = peer.ctx.scopeTransport.request(
      target(await ctx.scopeTransport.identity()), protocol, null, new AbortController().signal)
    const rejected = expect(request).rejects.toBeDefined()
    await entered.promise
    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    try {
      await aborted.promise
      expect(disposed).toBe(false)
      expect(settled).toBe(false)
    } finally { released.resolve(undefined) }
    await Promise.all([disposing, rejected])
    expect(settled).toBe(true)
    expect(disposed).toBe(true)
  })
})
