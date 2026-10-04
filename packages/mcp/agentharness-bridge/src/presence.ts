/** Transient room-presence lease owned by one running MCP bridge process. */

import { AgentHarnessRpcClient } from './rpc.ts'
import type { AgentHarnessBridgeOptions } from './index.ts'

interface DirectoryLease {
  readonly presenceTtlMs?: number
}

/** Explicit lease policy; request cancellation and byte limits remain shared with MCP calls. */
export interface AgentHarnessBridgePresenceOptions extends AgentHarnessBridgeOptions {
  /** Delay after a failed announcement or heartbeat. */
  readonly retryMs: number
  /** Host TTL used only when the response omits a valid TTL. */
  readonly fallbackTtlMs: number
  /** Lower bound for one-third-TTL renewal scheduling. */
  readonly minHeartbeatMs: number
  /** Upper bound for one-third-TTL renewal scheduling. */
  readonly maxHeartbeatMs: number
}

/** Announce, renew, and recover while alive; disposal aborts renewal and joins bounded withdrawal. */
export class AgentHarnessBridgePresenceLease {
  private readonly rpc: AgentHarnessRpcClient
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private current: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private started = false
  private mayBeAnnounced = false
  private announced = false

  constructor(private readonly options: AgentHarnessBridgePresenceOptions) {
    this.rpc = new AgentHarnessRpcClient(options)
  }

  /** Attempt initial presence; an unavailable Host is retried without failing MCP startup. */
  start(): Promise<void> {
    if (!this.started && this.closing === undefined) {
      this.started = true
      this.current = this.cycle()
    }
    return this.current ?? Promise.resolve()
  }

  private isStopped(): boolean {
    return this.lifetime.signal.aborted
  }

  private async cycle(): Promise<void> {
    if (this.isStopped()) return
    let delay = this.options.retryMs
    try {
      this.mayBeAnnounced = true
      const directory = await this.rpc.call<DirectoryLease>(
        this.announced ? 'developmentRooms/heartbeat' : 'developmentRooms/announce',
        { request: this.announced
          ? { participantId: this.options.participantId }
          : { id: this.options.participantId, kind: 'agent', displayName: this.options.displayName } },
        this.lifetime.signal,
      )
      this.announced = true
      const ttl = typeof directory.presenceTtlMs === 'number' && Number.isFinite(directory.presenceTtlMs)
        && directory.presenceTtlMs > 0 ? directory.presenceTtlMs : this.options.fallbackTtlMs
      delay = Math.min(this.options.maxHeartbeatMs, Math.max(this.options.minHeartbeatMs, Math.floor(ttl / 3)))
    } catch {
      // Bounded connection and RPC failures are retried; no remote error text reaches stdio.
      this.announced = false
    }
    if (this.isStopped()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.current = this.cycle()
    }, delay)
  }

  /** Stop renewals, settle the current request, and attempt withdrawal within its own deadline. */
  dispose(): Promise<void> {
    this.closing ??= this.close()
    return this.closing
  }

  private async close(): Promise<void> {
    this.lifetime.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.rpc.dispose()
    await this.current
    if (!this.mayBeAnnounced) return
    // A lost reply can hide a committed announcement; withdraw even when it was not acknowledged.
    const withdrawOptions = { ...this.options, signal: AbortSignal.any([]) }
    try {
      await new AgentHarnessRpcClient(withdrawOptions).call('developmentRooms/withdraw', {
        request: { participantId: this.options.participantId },
      })
    } catch {
      // Bounded withdrawal failures retain the Host TTL as the independent crash fallback.
    }
    this.announced = false
  }
}
