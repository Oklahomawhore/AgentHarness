/** Transient room-presence lease owned by one running MCP bridge process. */

import { AgentHarnessRpcClient } from './rpc.ts'
import type { AgentHarnessBridgeOptions } from './index.ts'

const DEFAULT_TTL_MS = 15_000
const DEFAULT_RETRY_MS = 2_000
const MIN_HEARTBEAT_MS = 500
const MAX_HEARTBEAT_MS = 30_000

interface DirectoryLease {
  readonly presenceTtlMs?: number
}

/** Optional retry policy for controlled tests and future deployments. */
export interface AgentHarnessBridgePresenceOptions extends AgentHarnessBridgeOptions {
  readonly retryMs?: number
}

function boundedDelay(ttl: number | undefined): number {
  const resolved = Number.isFinite(ttl) && (ttl as number) > 0 ? ttl as number : DEFAULT_TTL_MS
  return Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, Math.floor(resolved / 3)))
}

/**
 * Announce immediately, renew while alive, recover after Host restarts, and
 * withdraw after all in-flight work settles.
 */
export class AgentHarnessBridgePresenceLease {
  private readonly rpc: AgentHarnessRpcClient
  private readonly retryMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private current: Promise<void> | undefined
  private started = false
  private disposed = false
  private announced = false

  constructor(private readonly options: AgentHarnessBridgePresenceOptions) {
    this.rpc = new AgentHarnessRpcClient(options.url, options.fetch)
    this.retryMs = Number.isSafeInteger(options.retryMs) && (options.retryMs as number) > 0
      ? options.retryMs as number
      : DEFAULT_RETRY_MS
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  /** Attempt the initial announcement without making MCP startup depend on Host availability. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true
      this.current = this.cycle()
    }
    return this.current ?? Promise.resolve()
  }

  private async cycle(): Promise<void> {
    if (this.disposed) return
    let delay = this.retryMs
    try {
      let directory: DirectoryLease
      if (this.announced) {
        directory = await this.rpc.call<DirectoryLease>('developmentRooms/heartbeat', {
          request: { participantId: this.options.participantId },
        })
      } else {
        directory = await this.rpc.call<DirectoryLease>('developmentRooms/announce', {
          request: {
            id: this.options.participantId,
            kind: 'agent',
            displayName: this.options.displayName,
          },
        })
      }
      this.announced = true
      delay = boundedDelay(directory.presenceTtlMs)
    } catch {
      // Harness can start after its client. The next cycle re-announces rather
      // than leaving the MCP transport failed or extending a stale lease.
      this.announced = false
    }
    // Disposal may run while the announce or heartbeat request is in flight.
    if (this.isDisposed()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.current = this.cycle()
    }, delay)
  }

  /** Stop future renewals, join the active request, then end the retained lease. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.current
    if (!this.announced) return
    try {
      await this.rpc.call('developmentRooms/withdraw', {
        request: { participantId: this.options.participantId },
      })
    } catch {
      // A lost Host already makes the lease unreachable; its TTL remains the
      // independent crash fallback when a clean withdrawal cannot arrive.
    } finally {
      this.announced = false
    }
  }
}
