/** HMAC-authenticated WebSocket provider for generic development Mesh channels. */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import DevelopmentMeshService, {
  type DevelopmentMeshHeads,
  type DevelopmentMeshPeerSnapshot,
  type DevelopmentMeshSnapshot,
} from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import type {} from '@deepseek-ai/dsh-development-room'
import type {} from '@deepseek-ai/dsh-host-webserver'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { z } from 'zod'
import {
  isMulticastAddress,
  LanPeerDiscovery,
  ownsDial,
  type LanDiscoveredPeer,
  type LanDiscoveryConfig,
} from './discovery.ts'

export type * from '@deepseek-ai/dsh-development-mesh/types'
export type { LanDiscoveryConfig } from './discovery.ts'

const PROTOCOL_VERSION = 1
const NODE_PATTERN = /^[a-z][a-z0-9-]*$/u
const MAX_CLOCK_SKEW_MS = 30_000
const HEADER_NODE = 'x-dsh-mesh-node'
const HEADER_TARGET = 'x-dsh-mesh-target'
const HEADER_NONCE = 'x-dsh-mesh-nonce'
const HEADER_AT = 'x-dsh-mesh-at'
const HEADER_MAC = 'x-dsh-mesh-mac'

/** One configured peer and whether this node owns reconnection attempts. */
export interface PeerConfig {
  /** Stable remote node identity expected during authentication. */
  readonly nodeId: string
  /** HTTP(S) origin used to derive the Mesh WebSocket endpoint. */
  readonly url: string
  /** Whether this node owns outbound reconnect attempts for the pair. */
  readonly connect: boolean
}

/** Explicit authentication, topology, and resource bounds for one Mesh node. */
export interface Config {
  /** Absolute WebSocket upgrade path without a trailing slash. */
  readonly path: string
  /** Credential reference resolving the shared cluster secret. */
  readonly secretRef: string
  /** Explicit peer topology retained alongside discovery. */
  readonly peers: PeerConfig[]
  /** Authenticated IPv4 multicast discovery configuration. */
  readonly discovery: LanDiscoveryConfig
  /** First delay after an outbound connection failure. */
  readonly reconnectInitialDelayMs: number
  /** Maximum reconnect backoff delay. */
  readonly reconnectMaxDelayMs: number
  /** Deadline for one owner command response. */
  readonly commandTimeoutMs: number
  /** Maximum signed WebSocket envelope bytes. */
  readonly maxMessageBytes: number
  /** Maximum channel events carried by one delta frame. */
  readonly maxEventsPerFrame: number
}

interface ResolvedPeer {
  readonly nodeId: DevelopmentNodeId
  url: string
  readonly connect: boolean
  readonly source: 'configured' | 'lan'
}

type Body =
  | { readonly type: 'hello' }
  | { readonly type: 'pull'; readonly channel: string; readonly heads: DevelopmentMeshHeads }
  | { readonly type: 'events'; readonly channel: string; readonly events: readonly unknown[] }
  | { readonly type: 'ack'; readonly channel: string; readonly heads: DevelopmentMeshHeads }
  | { readonly type: 'command'; readonly commandId: string; readonly channel: string; readonly payload: unknown }
  | { readonly type: 'result'; readonly commandId: string; readonly ok: true; readonly value: unknown }
  | { readonly type: 'result'; readonly commandId: string; readonly ok: false; readonly code: string; readonly message: string }

interface SignedFrame {
  readonly version: 1
  readonly nodeId: string
  readonly targetNodeId: string
  readonly nonce: string
  readonly seq: number
  readonly at: number
  readonly body: Body
}

interface WireEnvelope { readonly payload: string; readonly mac: string }

interface PeerRuntime {
  config: ResolvedPeer
  socket: WebSocket | undefined
  state: DevelopmentMeshPeerSnapshot['state']
  direction: DevelopmentMeshPeerSnapshot['direction']
  lastSeenAt: number | undefined
  lastError: string | undefined
  reconnectDelayMs: number
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  removed: boolean
  sendSeq: number
  receiveSeq: number
  pendingSync: number
  conflicts: number
  readonly heads: Map<string, DevelopmentMeshHeads>
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const headsSchema = z.record(z.string(), z.number().int().nonnegative())
const bodySchema = z.union([
  z.strictObject({ type: z.literal('hello') }),
  z.strictObject({ type: z.literal('pull'), channel: z.string(), heads: headsSchema }),
  z.strictObject({ type: z.literal('events'), channel: z.string(), events: z.array(z.unknown()) }),
  z.strictObject({ type: z.literal('ack'), channel: z.string(), heads: headsSchema }),
  z.strictObject({ type: z.literal('command'), commandId: z.uuid(), channel: z.string(), payload: z.unknown() }),
  z.strictObject({ type: z.literal('result'), commandId: z.uuid(), ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ type: z.literal('result'), commandId: z.uuid(), ok: z.literal(false), code: z.string(), message: z.string() }),
])
const frameSchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  nodeId: z.string().regex(NODE_PATTERN),
  targetNodeId: z.string().regex(NODE_PATTERN),
  nonce: z.uuid(),
  seq: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  body: bodySchema,
})
const envelopeSchema = z.strictObject({ payload: z.string(), mac: z.string().regex(/^[a-f0-9]{64}$/u) })

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`development-mesh-websocket: ${field} must be a positive safe integer`)
  return value
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error === undefined) return 'undefined'
  return JSON.stringify(error)
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'INTERNAL'
}

function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** HMAC-authenticated incremental Mesh provider. */
export class DevelopmentMeshWebSocketService extends DevelopmentMeshService {
  static inject = ['webServer', 'developmentRooms', 'credentials']
  static Config: s<Config> = s.object({
    path: s.string().required(),
    secretRef: s.string().required(),
    peers: s.array(s.object({ nodeId: s.string().required(), url: s.string().required(), connect: s.boolean().required() })).required(),
    discovery: s.object({
      enabled: s.boolean().required(),
      cluster: s.string().required(),
      multicastAddress: s.string().required(),
      port: s.number().step(1).min(1).max(65_535).required(),
      announceIntervalMs: s.number().step(1).min(1).required(),
      peerTtlMs: s.number().step(1).min(1).required(),
      maxDatagramBytes: s.number().step(1).min(1).required(),
    }).required(),
    reconnectInitialDelayMs: s.number().step(1).min(1).required(),
    reconnectMaxDelayMs: s.number().step(1).min(1).required(),
    commandTimeoutMs: s.number().step(1).min(1).required(),
    maxMessageBytes: s.number().step(1).min(1).required(),
    maxEventsPerFrame: s.number().step(1).min(1).required(),
  })

  private readonly server = new WebSocketServer({ noServer: true })
  private readonly peers = new Map<DevelopmentNodeId, PeerRuntime>()
  private readonly pending = new Map<string, PendingCommand>()
  private readonly replayNonces = new Map<string, number>()
  private readonly config: Config
  private readonly nodeId: DevelopmentNodeId
  private secret = Buffer.alloc(0)
  private clusterId = 'uninitialized'
  private secretFingerprint = 'uninitialized'
  private discovery: LanPeerDiscovery | undefined
  private stopping = false

  /** Validate non-secret topology and bounds before resolving the credential at init. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.nodeId = ctx.developmentRooms.list().nodeId
    if (!config.path.startsWith('/') || config.path.endsWith('/')) throw new TypeError('development-mesh-websocket: path must be absolute without a trailing slash')
    credentialRef(config.secretRef)
    if (config.reconnectInitialDelayMs > config.reconnectMaxDelayMs) throw new TypeError('development-mesh-websocket: reconnect delay bounds are inverted')
    if (config.discovery.peerTtlMs <= config.discovery.announceIntervalMs) throw new TypeError('development-mesh-websocket: peerTtlMs must exceed announceIntervalMs')
    if (!isMulticastAddress(config.discovery.multicastAddress)) throw new TypeError('development-mesh-websocket: multicastAddress must be in 239.0.0.0/8')
    if (config.discovery.maxDatagramBytes > 65_507) throw new TypeError('development-mesh-websocket: discovery.maxDatagramBytes must not exceed 65507')
    const cluster = config.discovery.cluster.trim()
    if (cluster.length === 0 || Buffer.byteLength(cluster, 'utf8') > 128) throw new TypeError('development-mesh-websocket: cluster must be 1-128 UTF-8 bytes')
    this.config = {
      ...config,
      discovery: {
        ...config.discovery,
        cluster,
        port: positive(config.discovery.port, 'discovery.port'),
        announceIntervalMs: positive(config.discovery.announceIntervalMs, 'discovery.announceIntervalMs'),
        peerTtlMs: positive(config.discovery.peerTtlMs, 'discovery.peerTtlMs'),
        maxDatagramBytes: positive(config.discovery.maxDatagramBytes, 'discovery.maxDatagramBytes'),
      },
      reconnectInitialDelayMs: positive(config.reconnectInitialDelayMs, 'reconnectInitialDelayMs'),
      reconnectMaxDelayMs: positive(config.reconnectMaxDelayMs, 'reconnectMaxDelayMs'),
      commandTimeoutMs: positive(config.commandTimeoutMs, 'commandTimeoutMs'),
      maxMessageBytes: positive(config.maxMessageBytes, 'maxMessageBytes'),
      maxEventsPerFrame: positive(config.maxEventsPerFrame, 'maxEventsPerFrame'),
    }
    const peers = config.peers.map(peer => this.resolvePeer(peer, 'configured'))
    if (new Set(peers.map(peer => peer.nodeId)).size !== peers.length) throw new TypeError('development-mesh-websocket: peer node ids must be unique')
    if (peers.some(peer => peer.nodeId === this.nodeId)) throw new TypeError('development-mesh-websocket: a node cannot list itself as a peer')
    for (const peer of peers) this.peers.set(peer.nodeId, this.createPeer(peer))
  }

  /** Read safe cluster, fingerprint, peer, sync, and conflict status. */
  list(): DevelopmentMeshSnapshot {
    return Object.freeze({
      nodeId: this.nodeId,
      clusterId: this.clusterId,
      secretFingerprint: this.secretFingerprint,
      peers: Object.freeze([...this.peers.values()].map(peer => this.snapshot(peer))),
    })
  }

  /** Push a channel's committed delta to every online peer. */
  publish(channel: string): void {
    if (this.channel(channel) === undefined) throw new Error(`development-mesh-websocket: unknown channel "${channel}"`)
    for (const peer of this.peers.values()) if (peer.state === 'online') void this.sendDelta(peer, channel)
  }

  /**
   * Route one channel command to its authoritative node.
   * @param ownerNodeId - authoritative destination node.
   * @param channelName - registered versioned Mesh channel.
   * @param payload - wire-serializable channel command.
   * @returns command response from the owner channel.
   */
  async command(ownerNodeId: DevelopmentNodeId, channelName: string, payload: unknown): Promise<unknown> {
    const channel = this.channel(channelName)
    if (ownerNodeId === this.nodeId) {
      if (channel?.command === undefined) throw new Error(`development-mesh-websocket: channel "${channelName}" has no command handler`)
      return await channel.command(payload, this.nodeId)
    }
    const peer = this.peers.get(ownerNodeId)
    if (peer?.state !== 'online' || peer.socket?.readyState !== WebSocket.OPEN) throw Object.assign(new Error('Task owner node is offline'), { code: 'RUNTIME_UNAVAILABLE' })
    const commandId = randomUUID()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        reject(Object.assign(new Error('development Mesh command timed out'), { code: 'RUNTIME_UNAVAILABLE' }))
      }, this.config.commandTimeoutMs)
      this.pending.set(commandId, { resolve, reject, timer })
      void this.send(peer, { type: 'command', commandId, channel: channelName, payload }).catch((error: unknown) => {
        clearTimeout(timer)
        this.pending.delete(commandId)
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      })
    })
  }

  /** Resolve the mandatory secret, bind transport routes, and start peer lifecycle. */
  protected async [Service.init](): Promise<void> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.secretRef))
    if (resolved === undefined) throw new Error(`development-mesh-websocket: credential ${this.config.secretRef} is required while Mesh is enabled`)
    this.secret = Buffer.from(resolved.value, 'utf8')
    if (this.secret.byteLength < 32) throw new Error('development-mesh-websocket: shared secret must be at least 32 UTF-8 bytes')
    this.secretFingerprint = createHash('sha256').update(this.secret).digest('hex').slice(0, 16)
    this.clusterId = createHash('sha256').update(`agentharness:${this.config.discovery.cluster}:`).update(this.secret).digest('hex').slice(0, 16)
    this.ctx.effect(
      () => this.ctx.webServer.registerUpgrade({
        path: this.config.path,
        handler: (req, socket, head) => { this.accept(req, socket, head) },
      }),
      'development Mesh authenticated upgrade',
    )
    this.ctx.on('development-mesh/channel-registered', (name) => {
      for (const peer of this.peers.values()) {
        if (peer.state === 'online') {
          void this.requestChannel(peer, name)
          void this.sendDelta(peer, name)
        }
      }
    })
    for (const peer of this.peers.values()) if (peer.config.connect) this.connect(peer)
    if (this.config.discovery.enabled) {
      this.discovery = new LanPeerDiscovery(
        this.config.discovery,
        this.nodeId,
        this.ctx.webServer.port,
        this.config.path,
        this.clusterId,
        this.secret,
        {
          up: (peer) => { this.upsertDiscoveredPeer(peer) },
          down: (nodeId) => { this.removeDiscoveredPeer(nodeId) },
          collision: (nodeId) => { this.ctx.logger.error('development Mesh node id collision: %s', nodeId) },
          error: (error) => { this.ctx.logger.warn('development Mesh LAN discovery: %s', error.message) },
        },
      )
      await this.discovery.start()
    }
    this.ctx.effect(() => async () => { await this.close() }, 'development Mesh sockets')
  }

  private resolvePeer(peer: PeerConfig, source: ResolvedPeer['source']): ResolvedPeer {
    if (!NODE_PATTERN.test(peer.nodeId)) throw new TypeError('development-mesh-websocket: peer nodeId must use lower-kebab-case')
    const url = new URL(peer.url)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('development-mesh-websocket: peer url must use ws or wss')
    return { nodeId: peer.nodeId as DevelopmentNodeId, url: peer.url, connect: peer.connect, source }
  }

  private createPeer(config: ResolvedPeer): PeerRuntime {
    return {
      config,
      socket: undefined,
      state: 'offline',
      direction: config.connect ? 'dial' : 'accept',
      lastSeenAt: undefined,
      lastError: undefined,
      reconnectDelayMs: this.config.reconnectInitialDelayMs,
      reconnectTimer: undefined,
      removed: false,
      sendSeq: 0,
      receiveSeq: 0,
      pendingSync: 0,
      conflicts: 0,
      heads: new Map(),
    }
  }

  private upsertDiscoveredPeer(discovered: LanDiscoveredPeer): void {
    if (this.stopping) return
    const current = this.peers.get(discovered.nodeId)
    if (current?.config.source === 'configured') return
    const url = `ws://${discovered.address}:${String(discovered.port)}`
    if (current !== undefined) { current.config.url = url; return }
    const config = this.resolvePeer({ nodeId: discovered.nodeId, url, connect: ownsDial(this.nodeId, discovered.nodeId) }, 'lan')
    const peer = this.createPeer(config)
    this.peers.set(config.nodeId, peer)
    if (config.connect) this.connect(peer)
  }

  private removeDiscoveredPeer(nodeId: DevelopmentNodeId): void {
    const peer = this.peers.get(nodeId)
    if (peer === undefined || peer.config.source !== 'lan') return
    peer.removed = true
    if (peer.reconnectTimer !== undefined) clearTimeout(peer.reconnectTimer)
    this.peers.delete(nodeId)
    peer.socket?.terminate()
    void this.peerOffline(nodeId)
  }

  private accept(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const nodeId = this.header(req, HEADER_NODE)
    const peer = nodeId === undefined ? undefined : this.peers.get(nodeId as DevelopmentNodeId)
    if (peer === undefined || peer.config.connect || peer.socket !== undefined
      || !this.verifyUpgrade(req, peer.config.nodeId)) {
      this.reject(socket)
      return
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => { peer.direction = 'accept'; this.attach(peer, websocket) })
  }

  private connect(peer: PeerRuntime): void {
    if (this.stopping || peer.removed || !peer.config.connect || peer.socket !== undefined || peer.state === 'isolated') return
    this.setState(peer, 'connecting')
    try {
      const url = new URL(peer.config.url)
      url.pathname = this.config.path
      const at = Date.now()
      const nonce = randomUUID()
      const target = peer.config.nodeId
      const signature = this.hmac(`${this.nodeId}\n${target}\n${nonce}\n${String(at)}\n${this.config.path}`)
      const websocket = new WebSocket(url, { headers: {
        [HEADER_NODE]: this.nodeId,
        [HEADER_TARGET]: target,
        [HEADER_NONCE]: nonce,
        [HEADER_AT]: String(at),
        [HEADER_MAC]: signature,
      } })
      peer.direction = 'dial'
      this.attach(peer, websocket)
    } catch (error) { this.disconnected(peer, undefined, error) }
  }

  private attach(peer: PeerRuntime, socket: WebSocket): void {
    peer.socket = socket
    peer.sendSeq = 0
    peer.receiveSeq = 0
    peer.heads.clear()
    let introduced = false
    const introduce = (): void => {
      void this.send(peer, { type: 'hello' }).catch((error: unknown) => {
        socket.close(1011, errorMessage(error))
      })
    }
    if (socket.readyState === WebSocket.OPEN) introduce(); else socket.once('open', introduce)
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) { socket.close(1003, 'text frames only'); return }
      const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data)
      if (bytes.byteLength > this.config.maxMessageBytes) { socket.close(1009, 'frame too large'); return }
      let frame: SignedFrame
      try { frame = this.verifyEnvelope(bytes, peer) } catch (error) {
        peer.lastError = errorMessage(error)
        socket.close(1008, 'authentication failed')
        return
      }
      if (!introduced) {
        if (frame.body.type !== 'hello') { socket.close(1008, 'hello required'); return }
        introduced = true
        this.online(peer)
        return
      }
      if (frame.body.type === 'hello') { socket.close(1008, 'duplicate hello'); return }
      peer.lastSeenAt = Date.now()
      void this.receive(peer, frame.body).catch((error: unknown) => {
        peer.lastError = errorMessage(error)
        if (errorCode(error) === 'REPLICA_CONFLICT') this.isolate(peer, error)
        else socket.close(1011, 'frame failed')
      })
    })
    socket.once('close', (code, reason) => {
      this.disconnected(peer, socket, code === 1000 ? undefined : new Error(`WebSocket closed with ${String(code)}${reason.length === 0 ? '' : `: ${reason.toString()}`}`))
    })
    socket.once('error', (error) => { peer.lastError = error.message })
  }

  private online(peer: PeerRuntime): void {
    peer.reconnectDelayMs = this.config.reconnectInitialDelayMs
    peer.lastError = undefined
    peer.lastSeenAt = Date.now()
    this.setState(peer, 'online')
    for (const channel of this.channelNames()) { void this.requestChannel(peer, channel); void this.sendDelta(peer, channel) }
  }

  private async receive(peer: PeerRuntime, body: Exclude<Body, { type: 'hello' }>): Promise<void> {
    if (body.type === 'result') {
      const pending = this.pending.get(body.commandId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(body.commandId)
      if (body.ok) pending.resolve(body.value)
      else pending.reject(Object.assign(new Error(body.message), { code: body.code }))
      return
    }
    if (body.type === 'command') { await this.execute(peer, body); return }
    const channel = this.channel(body.channel)
    if (channel === undefined) return
    if (body.type === 'pull') {
      peer.heads.set(body.channel, Object.freeze({ ...body.heads }))
      await this.sendDelta(peer, body.channel)
      return
    }
    if (body.type === 'ack') { peer.heads.set(body.channel, Object.freeze({ ...body.heads })); return }
    await channel.receive(body.events, peer.config.nodeId)
    await this.send(peer, { type: 'ack', channel: body.channel, heads: await channel.heads() })
  }

  private async execute(peer: PeerRuntime, body: Extract<Body, { type: 'command' }>): Promise<void> {
    const channel = this.channel(body.channel)
    try {
      if (channel?.command === undefined) throw Object.assign(new Error('Mesh channel has no command handler'), { code: 'INVALID_REQUEST' })
      const value = await channel.command(body.payload, peer.config.nodeId)
      await this.send(peer, { type: 'result', commandId: body.commandId, ok: true, value: value ?? null })
    } catch (error) {
      await this.send(peer, { type: 'result', commandId: body.commandId, ok: false, code: errorCode(error), message: errorMessage(error) })
    }
  }

  private async requestChannel(peer: PeerRuntime, channelName: string): Promise<void> {
    const channel = this.channel(channelName)
    if (channel === undefined || peer.state !== 'online') return
    await this.send(peer, { type: 'pull', channel: channelName, heads: await channel.heads() })
  }

  private async sendDelta(peer: PeerRuntime, channelName: string): Promise<void> {
    const channel = this.channel(channelName)
    if (channel === undefined || peer.state !== 'online') return
    peer.pendingSync += 1
    this.emitPeer(peer)
    try {
      const events = await channel.read(peer.heads.get(channelName) ?? {})
      if (events.length > this.config.maxEventsPerFrame) throw new Error(`development-mesh-websocket: channel ${channelName} produced too many events for one frame`)
      if (events.length > 0) await this.send(peer, { type: 'events', channel: channelName, events })
    } finally {
      peer.pendingSync -= 1
      this.emitPeer(peer)
    }
  }

  private send(peer: PeerRuntime, body: Body): Promise<void> {
    const socket = peer.socket
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('development Mesh socket is not open'))
    const frame: SignedFrame = {
      version: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      targetNodeId: peer.config.nodeId,
      nonce: randomUUID(),
      seq: ++peer.sendSeq,
      at: Date.now(),
      body,
    }
    const payload = Buffer.from(JSON.stringify(frame)).toString('base64url')
    const envelope: WireEnvelope = { payload, mac: this.hmac(payload) }
    const bytes = JSON.stringify(envelope)
    if (Buffer.byteLength(bytes, 'utf8') > this.config.maxMessageBytes) {
      return Promise.reject(new Error('development Mesh frame exceeds maxMessageBytes'))
    }
    return new Promise((resolve, reject) => {
      socket.send(bytes, (error) => {
        if (error == null) resolve()
        else reject(error instanceof Error ? error : new Error(errorMessage(error)))
      })
    })
  }

  private verifyEnvelope(bytes: Buffer, peer: PeerRuntime): SignedFrame {
    const envelope = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (!equalHex(envelope.mac, this.hmac(envelope.payload))) throw new Error('invalid envelope HMAC')
    const decoded = Buffer.from(envelope.payload, 'base64url')
    const frame = frameSchema.parse(JSON.parse(decoded.toString('utf8'))) as SignedFrame
    if (frame.nodeId !== peer.config.nodeId || frame.targetNodeId !== this.nodeId) throw new Error('peer identity mismatch')
    if (Math.abs(Date.now() - frame.at) > MAX_CLOCK_SKEW_MS) throw new Error('stale envelope')
    if (frame.seq !== peer.receiveSeq + 1) throw new Error('replayed or out-of-order envelope')
    if (this.replayNonces.has(frame.nonce)) throw new Error('replayed envelope nonce')
    peer.receiveSeq = frame.seq
    this.replayNonces.set(frame.nonce, frame.at)
    const threshold = Date.now() - MAX_CLOCK_SKEW_MS
    for (const [nonce, at] of this.replayNonces) if (at < threshold) this.replayNonces.delete(nonce)
    return frame
  }

  private verifyUpgrade(req: IncomingMessage, peerNodeId: DevelopmentNodeId): boolean {
    const node = this.header(req, HEADER_NODE)
    const target = this.header(req, HEADER_TARGET)
    const nonce = this.header(req, HEADER_NONCE)
    const atText = this.header(req, HEADER_AT)
    const supplied = this.header(req, HEADER_MAC)
    if (node !== peerNodeId || target !== this.nodeId || nonce === undefined || atText === undefined || supplied === undefined) return false
    const at = Number(atText)
    if (!Number.isSafeInteger(at) || Math.abs(Date.now() - at) > MAX_CLOCK_SKEW_MS || this.replayNonces.has(nonce)) return false
    const expected = this.hmac(`${node}\n${target}\n${nonce}\n${atText}\n${this.config.path}`)
    if (!equalHex(supplied, expected)) return false
    this.replayNonces.set(nonce, at)
    return true
  }

  private header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name]
    return typeof value === 'string' ? value : undefined
  }

  private hmac(value: string): string { return createHmac('sha256', this.secret).update(value).digest('hex') }

  private reject(socket: Duplex): void { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') }

  private isolate(peer: PeerRuntime, error: unknown): void {
    peer.conflicts += 1
    peer.lastError = `REPLICA_CONFLICT: ${errorMessage(error)}`
    peer.socket?.close(1008, 'replica conflict')
    this.setState(peer, 'isolated')
  }

  private disconnected(peer: PeerRuntime, socket: WebSocket | undefined, error?: unknown): void {
    if (socket !== undefined && peer.socket !== socket) return
    peer.socket = undefined
    if (peer.removed || peer.state === 'isolated') return
    if (error !== undefined && peer.lastError === undefined) peer.lastError = errorMessage(error)
    void this.peerOffline(peer.config.nodeId)
    if (this.stopping) peer.state = 'offline'; else this.setState(peer, 'offline')
    if (!this.stopping && peer.config.connect) {
      peer.reconnectTimer = setTimeout(() => { peer.reconnectTimer = undefined; this.connect(peer) }, peer.reconnectDelayMs)
      peer.reconnectDelayMs = Math.min(peer.reconnectDelayMs * 2, this.config.reconnectMaxDelayMs)
    }
  }

  private async peerOffline(nodeId: DevelopmentNodeId): Promise<void> {
    for (const name of this.channelNames()) await this.channel(name)?.peerOffline?.(nodeId)
  }

  private setState(peer: PeerRuntime, state: DevelopmentMeshPeerSnapshot['state']): void {
    if (peer.state === state) return
    peer.state = state
    this.emitPeer(peer)
  }

  private emitPeer(peer: PeerRuntime): void { this.ctx.emit('development-mesh/peer-changed', this.snapshot(peer)) }

  private snapshot(peer: PeerRuntime): DevelopmentMeshPeerSnapshot {
    return Object.freeze({
      nodeId: peer.config.nodeId,
      direction: peer.direction,
      state: peer.state,
      ...(peer.lastSeenAt === undefined ? {} : { lastSeenAt: peer.lastSeenAt }),
      ...(peer.lastError === undefined ? {} : { lastError: peer.lastError }),
      pendingSync: peer.pendingSync,
      conflicts: peer.conflicts,
    })
  }

  private async close(): Promise<void> {
    this.stopping = true
    await this.discovery?.close()
    for (const peer of this.peers.values()) {
      if (peer.reconnectTimer !== undefined) clearTimeout(peer.reconnectTimer)
      peer.socket?.terminate()
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('development Mesh stopped')) }
    this.pending.clear()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}

export default DevelopmentMeshWebSocketService
