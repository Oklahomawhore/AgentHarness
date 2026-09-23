/** HMAC-authenticated bounded IPv4 multicast discovery for development Mesh peers. */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import { z } from 'zod'

const PRODUCT = 'agentharness-mesh'
const DISCOVERY_VERSION = 1
const NODE_PATTERN = /^[a-z][a-z0-9-]*$/u
const MAX_CLOCK_SKEW_MS = 30_000

/** Required multicast and lease values for automatic LAN discovery. */
export interface LanDiscoveryConfig {
  /** Whether multicast discovery sockets and announcements are active. */
  readonly enabled: boolean
  /** Deployment cluster label authenticated inside announcements. */
  readonly cluster: string
  /** IPv4 multicast group in the administratively scoped range. */
  readonly multicastAddress: string
  /** Shared UDP discovery port. */
  readonly port: number
  /** Delay between online announcements. */
  readonly announceIntervalMs: number
  /** Silence interval after which a discovered peer expires. */
  readonly peerTtlMs: number
  /** Maximum accepted or emitted UDP datagram bytes. */
  readonly maxDatagramBytes: number
}

/** Reachable authenticated LAN peer. */
export interface LanDiscoveredPeer {
  readonly nodeId: DevelopmentNodeId
  readonly address: string
  readonly port: number
}

interface Announcement {
  readonly product: typeof PRODUCT
  readonly version: typeof DISCOVERY_VERSION
  readonly clusterId: string
  readonly instanceId: string
  readonly nodeId: string
  readonly port: number
  readonly path: string
  readonly state: 'online' | 'offline'
  readonly at: number
  readonly nonce: string
}

interface RetainedPeer extends LanDiscoveredPeer {
  readonly instanceId: string
  lastSeenAt: number
}

/** Discovery lifecycle callbacks owned by the transport. */
export interface LanDiscoveryCallbacks {
  readonly up: (peer: LanDiscoveredPeer) => void
  readonly down: (nodeId: DevelopmentNodeId) => void
  readonly collision: (nodeId: DevelopmentNodeId) => void
  readonly error: (error: Error) => void
}

const announcementSchema = z.strictObject({
  product: z.literal(PRODUCT),
  version: z.literal(DISCOVERY_VERSION),
  clusterId: z.string().min(8).max(64),
  instanceId: z.uuid(),
  nodeId: z.string().regex(NODE_PATTERN),
  port: z.number().int().min(1).max(65_535),
  path: z.string(),
  state: z.enum(['online', 'offline']),
  at: z.number().int().nonnegative(),
  nonce: z.uuid(),
})
const wireSchema = z.strictObject({ announcement: announcementSchema, mac: z.string().regex(/^[a-f0-9]{64}$/u) })

/**
 * Return whether an address belongs to the administratively scoped `239.0.0.0/8` range.
 * @param address - candidate IPv4 text.
 * @returns whether the address is a valid administrative multicast address.
 */
export function isMulticastAddress(address: string): boolean {
  if (!isIPv4(address)) return false
  return Number(address.slice(0, address.indexOf('.'))) === 239
}

/**
 * Return whether this node is the sole outbound dial owner for a peer pair.
 * @param localNodeId - stable identity of this node.
 * @param peerNodeId - stable identity of the discovered peer.
 * @returns whether the local node owns the one outbound connection.
 */
export function ownsDial(localNodeId: DevelopmentNodeId, peerNodeId: DevelopmentNodeId): boolean {
  return localNodeId < peerNodeId
}

function mac(secret: Buffer, announcement: Announcement): string {
  return createHmac('sha256', secret).update(JSON.stringify(announcement)).digest('hex')
}

function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Advertise one authenticated Mesh endpoint and lease matching peers. */
export class LanPeerDiscovery {
  private readonly instanceId = randomUUID()
  private readonly peers = new Map<DevelopmentNodeId, RetainedPeer>()
  private readonly nonces = new Map<string, number>()
  private socket: Socket | undefined
  private announceTimer: ReturnType<typeof setInterval> | undefined
  private expireTimer: ReturnType<typeof setInterval> | undefined
  private stopping = false

  constructor(
    private readonly config: LanDiscoveryConfig,
    private readonly nodeId: DevelopmentNodeId,
    private readonly webPort: number,
    private readonly path: string,
    private readonly clusterId: string,
    private readonly secret: Buffer,
    private readonly callbacks: LanDiscoveryCallbacks,
  ) {}

  /** Bind multicast, publish immediately, and start announcement and expiry timers. */
  async start(): Promise<void> {
    if (!this.config.enabled || this.socket !== undefined) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (bytes, remote) => { this.receive(bytes, remote) })
    socket.on('error', (error) => { this.callbacks.error(error) })
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { socket.off('listening', ready); reject(error) }
        const ready = (): void => {
          socket.off('error', failed)
          try {
            socket.addMembership(this.config.multicastAddress)
            socket.setMulticastLoopback(true)
            socket.setMulticastTTL(1)
            resolve()
          } catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
        }
        socket.once('error', failed)
        socket.once('listening', ready)
        socket.bind(this.config.port, '0.0.0.0')
      })
      await this.announce('online')
      this.announceTimer = setInterval(() => {
        void this.announce('online').catch((error: unknown) => {
          this.callbacks.error(error instanceof Error ? error : new Error(String(error)))
        })
      }, this.config.announceIntervalMs)
      this.expireTimer = setInterval(() => { this.expire() }, this.config.announceIntervalMs)
    } catch (error) {
      await this.closeSocket()
      throw error
    }
  }

  /** Send a best-effort authenticated goodbye, stop timers, and close the socket. */
  async close(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.announceTimer !== undefined) clearInterval(this.announceTimer)
    if (this.expireTimer !== undefined) clearInterval(this.expireTimer)
    if (this.socket !== undefined) {
      await this.announce('offline').catch(() => {})
      try { this.socket.dropMembership(this.config.multicastAddress) } catch {
        // A failed socket may never have joined the multicast group.
      }
    }
    await this.closeSocket()
    this.peers.clear()
    this.nonces.clear()
  }

  private receive(bytes: Buffer, remote: RemoteInfo): void {
    if (this.stopping || bytes.byteLength > this.config.maxDatagramBytes || !isIPv4(remote.address)) return
    let wire: z.infer<typeof wireSchema>
    try { wire = wireSchema.parse(JSON.parse(bytes.toString('utf8'))) } catch { return }
    const announcement = wire.announcement
    const now = Date.now()
    if (announcement.clusterId !== this.clusterId || announcement.path !== this.path) return
    if (Math.abs(now - announcement.at) > MAX_CLOCK_SKEW_MS || !equalHex(wire.mac, mac(this.secret, announcement))) return
    const nonceAt = this.nonces.get(announcement.nonce)
    if (nonceAt !== undefined) return
    this.nonces.set(announcement.nonce, now)
    for (const [nonce, at] of this.nonces) if (at < now - MAX_CLOCK_SKEW_MS) this.nonces.delete(nonce)
    if (announcement.instanceId === this.instanceId) return
    const nodeId = announcement.nodeId as DevelopmentNodeId
    if (nodeId === this.nodeId) { this.callbacks.collision(nodeId); return }
    const current = this.peers.get(nodeId)
    if (announcement.state === 'offline') {
      if (current?.instanceId === announcement.instanceId) { this.peers.delete(nodeId); this.callbacks.down(nodeId) }
      return
    }
    if (current !== undefined && current.instanceId !== announcement.instanceId) this.callbacks.collision(nodeId)
    const changed = current === undefined || current.instanceId !== announcement.instanceId
      || current.address !== remote.address || current.port !== announcement.port
    this.peers.set(nodeId, {
      nodeId,
      instanceId: announcement.instanceId,
      address: remote.address,
      port: announcement.port,
      lastSeenAt: now,
    })
    if (changed) this.callbacks.up({ nodeId, address: remote.address, port: announcement.port })
  }

  private expire(): void {
    const threshold = Date.now() - this.config.peerTtlMs
    for (const [nodeId, peer] of this.peers) {
      if (peer.lastSeenAt >= threshold) continue
      this.peers.delete(nodeId)
      this.callbacks.down(nodeId)
    }
  }

  private announce(state: Announcement['state']): Promise<void> {
    const socket = this.socket
    if (socket === undefined) return Promise.resolve()
    const announcement: Announcement = {
      product: PRODUCT,
      version: DISCOVERY_VERSION,
      clusterId: this.clusterId,
      instanceId: this.instanceId,
      nodeId: this.nodeId,
      port: this.webPort,
      path: this.path,
      state,
      at: Date.now(),
      nonce: randomUUID(),
    }
    const bytes = Buffer.from(JSON.stringify({ announcement, mac: mac(this.secret, announcement) }))
    if (bytes.byteLength > this.config.maxDatagramBytes) {
      return Promise.reject(new Error('development-mesh discovery announcement exceeds maxDatagramBytes'))
    }
    return new Promise((resolve, reject) => {
      socket.send(bytes, this.config.port, this.config.multicastAddress, (error) => { if (error === null) resolve(); else reject(error) })
    })
  }

  private closeSocket(): Promise<void> {
    const socket = this.socket
    this.socket = undefined
    if (socket === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      try { socket.close(() => { resolve() }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve()
        else throw error
      }
    })
  }
}
