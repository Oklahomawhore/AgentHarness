/** Explicit direct TCP provider with persistent Ed25519 identity, Noise encryption, and bounded JSON streams. */
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import ScopeTransport, { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { identityKey, loadIdentity } from './identity.ts'
import type { ScopePeerId, ScopeTransportHandler, ScopeTransportIdentity, ScopeTransportLimits, ScopeTransportTarget } from './types.ts'
import {
  encode, failureEnvelope, minimumRequestBytes, minimumResponseBytes,
  readJson, requestPayload, responsePayload, writeJson, type RpcStream,
} from './wire.ts'

/** Explicit listener, concurrency, byte, and time budgets for one device transport. */
export interface Config {
  /** Direct ip4/ip6 TCP listeners, without a peer suffix; port zero delegates allocation to the OS. */
  readonly listenAddresses: string[]
  /** Maximum complete request envelope, including framing, in UTF-8 bytes. */
  readonly maxRequestBytes: number
  /** Maximum complete response envelope, including framing, in UTF-8 bytes. */
  readonly maxResponseBytes: number
  /** Maximum admitted inbound requests across all peers and protocols. */
  readonly maxInboundRequests: number
  /** Maximum concurrent outbound requests, including dialing. */
  readonly maxOutboundRequests: number
  /** Maximum established connections before the library prunes excess connections. */
  readonly maxConnections: number
  /** Deadline covering each inbound handler or complete outbound operation. */
  readonly requestTimeoutMs: number
  /** Deadline for TCP/Noise establishment and library connection shutdown. */
  readonly connectionTimeoutMs: number
}

interface Registration {
  readonly handler: ScopeTransportHandler
  readonly lifetime: AbortController
}

type Connection = ReturnType<Libp2p['getConnections']>[number]

function directAddress(value: string, peerId?: ScopePeerId): Multiaddr {
  try {
    const address = multiaddr(value)
    const parts = address.getComponents()
    const host = parts[0]
    const port = parts[1]
    if ((host?.name !== 'ip4' && host?.name !== 'ip6') || port?.name !== 'tcp') throw new Error()
    if (peerId === undefined) {
      if (parts.length !== 2) throw new Error()
    } else {
      if (parts.length !== 3 || parts[2]?.name !== 'p2p' || parts[2].value !== peerId || port.value === '0') throw new Error()
      if (peerIdFromString(peerId).toString() !== peerId) throw new Error()
    }
    return address
  } catch {
    throw new ScopeTransportError('scope-transport/invalid-target')
  }
}

function positive(value: number, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`scope-transport: invalid ${name}`)
  return value
}

function deadline(parentSignals: AbortSignal[], duration: number): { signal: AbortSignal; timeout: AbortSignal; close: () => void } {
  const timerController = new AbortController()
  const timer = setTimeout(() => { timerController.abort(new ScopeTransportError('scope-transport/timeout')) }, duration)
  return {
    signal: AbortSignal.any([...parentSignals, timerController.signal]),
    timeout: timerController.signal,
    close: () => { clearTimeout(timer) },
  }
}

/** libp2p authenticates device identity; each registered consumer authorizes its own request payloads. */
export default class Libp2pScopeTransport extends ScopeTransport {
  static inject = ['credentials']
  static Config: s<Config> = s.object({
    listenAddresses: s.array(s.string()).min(1).required(),
    maxRequestBytes: s.number().step(1).min(minimumRequestBytes).required(),
    maxResponseBytes: s.number().step(1).min(minimumResponseBytes).required(),
    maxInboundRequests: s.number().step(1).min(1).required(),
    maxOutboundRequests: s.number().step(1).min(1).required(),
    maxConnections: s.number().step(1).min(1).required(),
    requestTimeoutMs: s.number().step(1).min(1).max(2_147_483_647).required(),
    connectionTimeoutMs: s.number().step(1).min(1).max(2_147_483_647).required(),
  })

  private readonly config: Config
  private readonly lifetime = new AbortController()
  private readonly ready = Promise.withResolvers<Libp2p>()
  private readonly registrations = new Map<string, Registration>()
  private readonly owned = new Set<Promise<unknown>>()
  private node: Libp2p | undefined
  private inbound = 0
  private outbound = 0
  private registrationFailure: ScopeTransportError | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (config.listenAddresses.length === 0) throw new TypeError('scope-transport: listenAddresses must not be empty')
    const listenAddresses = config.listenAddresses.map(address => directAddress(address).toString())
    if (new Set(listenAddresses).size !== listenAddresses.length) throw new TypeError('scope-transport: duplicate listenAddresses')
    this.config = {
      listenAddresses,
      maxRequestBytes: positive(config.maxRequestBytes, 'maxRequestBytes', minimumRequestBytes),
      maxResponseBytes: positive(config.maxResponseBytes, 'maxResponseBytes', minimumResponseBytes),
      maxInboundRequests: positive(config.maxInboundRequests, 'maxInboundRequests'),
      maxOutboundRequests: positive(config.maxOutboundRequests, 'maxOutboundRequests'),
      maxConnections: positive(config.maxConnections, 'maxConnections'),
      requestTimeoutMs: positive(config.requestTimeoutMs, 'requestTimeoutMs', 1, 2_147_483_647),
      connectionTimeoutMs: positive(config.connectionTimeoutMs, 'connectionTimeoutMs', 1, 2_147_483_647),
    }
    void this.ready.promise.catch(() => { /* Plugin startup reports failure; identity callers also receive it. */ })
    ctx.on('credentials/record-updated', (key) => {
      if (key === identityKey && this.node !== undefined && !this.lifetime.signal.aborted) {
        ctx.logger.warn('scope-transport: identity credential changed; restart required')
      }
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new ScopeTransportError('scope-transport/stopped'))
      for (const registration of this.registrations.values()) registration.lifetime.abort(this.lifetime.signal.reason)
      this.registrations.clear()
      await this.ready.promise.catch(() => undefined)
      await this.node?.stop()
      await Promise.allSettled([...this.owned])
    }, 'scope-transport: abort, drain, and stop')
  }

  protected async [Service.init](): Promise<void> {
    try {
      const privateKey = await loadIdentity(this.ctx.credentials, this.lifetime.signal)
      this.lifetime.signal.throwIfAborted()
      const node = await createLibp2p({
        privateKey, start: false,
        addresses: { listen: this.config.listenAddresses },
        transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
        peerDiscovery: [], peerRouters: [], contentRouters: [], services: {},
        connectionMonitor: { enabled: false },
        connectionManager: {
          maxConnections: this.config.maxConnections,
          maxIncomingPendingConnections: this.config.maxConnections,
          maxParallelDials: this.config.maxOutboundRequests,
          maxDialQueueLength: this.config.maxOutboundRequests,
          maxPeerAddrsToDial: 1,
          dialTimeout: this.config.connectionTimeoutMs,
          addressDialTimeout: this.config.connectionTimeoutMs,
          connectionCloseTimeout: this.config.connectionTimeoutMs,
          inboundUpgradeTimeout: this.config.connectionTimeoutMs,
          inboundStreamProtocolNegotiationTimeout: this.config.connectionTimeoutMs,
          outboundStreamProtocolNegotiationTimeout: this.config.connectionTimeoutMs,
          reconnectRetries: 0, resolvers: {},
        },
        connectionGater: {
          denyInboundRelayReservation: () => true,
          denyOutboundRelayedConnection: () => true,
          denyInboundRelayedConnection: () => true,
        },
      })
      this.node = node
      this.lifetime.signal.throwIfAborted()
      for (const [protocol, registration] of this.registrations) this.mount(protocol, registration)
      await node.start()
      this.assertOpen()
      this.ready.resolve(node)
    } catch (error) {
      const failure = this.normalize(error)
      this.ready.reject(failure)
      throw failure
    }
  }

  override async identity(): Promise<ScopeTransportIdentity> {
    this.assertOpen()
    const node = await this.ready.promise
    this.assertOpen()
    return Object.freeze({
      peerId: node.peerId.toString() as ScopePeerId,
      addresses: Object.freeze(node.getMultiaddrs().map(address => address.toString())),
    })
  }

  override limits(): ScopeTransportLimits {
    this.assertOpen()
    return Object.freeze({ maxInboundRequests: this.config.maxInboundRequests,
      maxOutboundRequests: this.config.maxOutboundRequests, requestTimeoutMs: this.config.requestTimeoutMs })
  }

  override register(protocol: string, handler: ScopeTransportHandler): () => void {
    this.assertOpen()
    if (!protocol.startsWith('/') || protocol.includes('\0')) throw new TypeError('scope-transport: invalid protocol name')
    if (this.registrations.has(protocol)) throw new TypeError('scope-transport: protocol is already registered')
    const registration = { handler, lifetime: new AbortController() }
    this.registrations.set(protocol, registration)
    this.mount(protocol, registration)
    return () => {
      if (this.registrations.get(protocol) !== registration) return
      this.registrations.delete(protocol)
      registration.lifetime.abort(new ScopeTransportError('scope-transport/cancelled'))
      if (this.node !== undefined) this.registrationWork(this.node.unhandle(protocol))
    }
  }

  override request(target: ScopeTransportTarget, protocol: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      this.assertOpen()
      if (signal.aborted) throw new ScopeTransportError('scope-transport/cancelled')
      const address = directAddress(target.address, target.peerId)
      const bytes = encode({ version: 1, payload }, this.config.maxRequestBytes, 'scope-transport/request-too-large')
      if (this.outbound >= this.config.maxOutboundRequests) throw new ScopeTransportError('scope-transport/capacity')
      this.outbound++
      return this.track(this.send(target.peerId, address, protocol, bytes, signal).finally(() => { this.outbound-- }))
    } catch (error) {
      return Promise.reject(this.normalize(error))
    }
  }

  private async send(peerId: ScopePeerId, address: Multiaddr, protocol: string, bytes: Uint8Array, caller: AbortSignal): Promise<unknown> {
    const operation = deadline([this.lifetime.signal, caller], this.config.requestTimeoutMs)
    let stream: RpcStream | undefined
    const abort = (): void => { stream?.abort(this.normalize(operation.signal.reason, caller, operation.timeout)) }
    operation.signal.addEventListener('abort', abort, { once: true })
    try {
      const node = await this.waitUntilReady(operation.signal)
      operation.signal.throwIfAborted()
      const connection = await node.dial(address, { signal: operation.signal })
      if (connection.remotePeer.toString() !== peerId || connection.encryption !== '/noise') throw new ScopeTransportError('scope-transport/invalid-target')
      stream = await connection.newStream(protocol, { signal: operation.signal, maxOutboundStreams: this.config.maxOutboundRequests })
      stream.maxReadBufferLength = this.config.maxResponseBytes
      stream.maxWriteBufferLength = this.config.maxRequestBytes
      stream.inactivityTimeout = this.config.requestTimeoutMs
      operation.signal.throwIfAborted()
      await writeJson(stream, bytes, operation.signal)
      const response = responsePayload(await readJson(stream, this.config.maxResponseBytes, 'scope-transport/response-too-large', operation.signal))
      operation.signal.throwIfAborted()
      return response
    } catch (error) {
      const failure = this.normalize(error, caller, operation.timeout)
      stream?.abort(failure)
      throw failure
    } finally {
      operation.close()
      operation.signal.removeEventListener('abort', abort)
    }
  }

  private mount(protocol: string, registration: Registration): void {
    if (this.node === undefined) return
    this.registrationWork(this.node.handle(protocol, (stream, connection) => {
      if (this.lifetime.signal.aborted || registration.lifetime.signal.aborted || this.inbound >= this.config.maxInboundRequests) {
        stream.abort(new ScopeTransportError('scope-transport/capacity'))
        return
      }
      this.inbound++
      const pending = this.receive(stream, connection, registration).finally(() => { this.inbound-- })
      return this.track(pending)
    }, { maxInboundStreams: this.config.maxInboundRequests, maxOutboundStreams: this.config.maxOutboundRequests }))
  }

  private async receive(stream: RpcStream, connection: Connection, registration: Registration): Promise<void> {
    const remote = new AbortController()
    const operation = deadline([this.lifetime.signal, registration.lifetime.signal, remote.signal], this.config.requestTimeoutMs)
    const abort = (): void => { stream.abort(this.normalize(operation.signal.reason, undefined, operation.timeout)) }
    const closed = (): void => { remote.abort(new ScopeTransportError('scope-transport/cancelled')) }
    operation.signal.addEventListener('abort', abort, { once: true })
    stream.addEventListener('close', closed, { once: true })
    stream.maxReadBufferLength = this.config.maxRequestBytes
    stream.maxWriteBufferLength = this.config.maxResponseBytes
    stream.inactivityTimeout = this.config.requestTimeoutMs
    try {
      if (connection.encryption !== '/noise') throw new ScopeTransportError('scope-transport/invalid-target')
      const payload = requestPayload(await readJson(stream, this.config.maxRequestBytes, 'scope-transport/request-too-large', operation.signal))
      operation.signal.throwIfAborted()
      const result = await registration.handler({
        peerId: connection.remotePeer.toString() as ScopePeerId, payload, signal: operation.signal,
      })
      operation.signal.throwIfAborted()
      const bytes = encode({ version: 1, ok: true, payload: result }, this.config.maxResponseBytes, 'scope-transport/response-too-large')
      await writeJson(stream, bytes, operation.signal)
    } catch (error) {
      if (operation.signal.aborted) stream.abort(this.normalize(error, undefined, operation.timeout))
      else {
        try {
          const bytes = encode(failureEnvelope(error), this.config.maxResponseBytes, 'scope-transport/response-too-large')
          await writeJson(stream, bytes, operation.signal)
        } catch {
          // Peer closure or a full write buffer can prevent delivery of the fixed failure envelope.
          stream.abort(new ScopeTransportError('scope-transport/unavailable'))
        }
      }
    } finally {
      operation.close()
      operation.signal.removeEventListener('abort', abort)
      stream.removeEventListener('close', closed)
    }
  }

  private registrationWork(pending: Promise<unknown>): void {
    void this.track(pending.catch(() => {
      if (this.lifetime.signal.aborted) return
      this.registrationFailure = new ScopeTransportError('scope-transport/registration-failed')
      this.lifetime.abort(this.registrationFailure)
      this.ctx.logger.error('scope-transport: protocol registration failed')
    }))
  }

  private waitUntilReady(signal: AbortSignal): Promise<Libp2p> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        reject(this.normalize(signal.reason))
      }
      signal.addEventListener('abort', abort, { once: true })
      void this.ready.promise.then((node) => {
        signal.removeEventListener('abort', abort)
        resolve(node)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(this.normalize(error))
      })
    })
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.owned.add(pending)
    void pending.then(() => { this.owned.delete(pending) }, () => { this.owned.delete(pending) })
    return pending
  }

  private assertOpen(): void {
    if (this.registrationFailure !== undefined) throw this.registrationFailure
    if (this.lifetime.signal.aborted) throw new ScopeTransportError('scope-transport/stopped')
  }

  private normalize(error: unknown, caller?: AbortSignal, timeout?: AbortSignal): ScopeTransportError {
    if (this.registrationFailure !== undefined) return this.registrationFailure
    if (this.lifetime.signal.aborted) return new ScopeTransportError('scope-transport/stopped')
    if (caller?.aborted) return new ScopeTransportError('scope-transport/cancelled')
    if (timeout?.aborted) return new ScopeTransportError('scope-transport/timeout')
    return error instanceof ScopeTransportError ? error : new ScopeTransportError('scope-transport/unavailable')
  }
}
