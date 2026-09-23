/** Client-safe authenticated Mesh status and channel contracts. */

import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'

/** Per-origin monotonic cursors advertised by one Mesh channel. */
export type DevelopmentMeshHeads = Readonly<Record<string, number>>

/** One channel contribution over authenticated peer links. */
export interface DevelopmentMeshChannel {
  /** Return the channel's current per-origin cursors. */
  heads(): DevelopmentMeshHeads | Promise<DevelopmentMeshHeads>
  /** Read events strictly newer than the supplied peer cursors. */
  read(after: DevelopmentMeshHeads): readonly unknown[] | Promise<readonly unknown[]>
  /** Validate, persist, and apply authenticated peer events. */
  receive(events: readonly unknown[], sourceNodeId: DevelopmentNodeId): void | Promise<void>
  /** Execute an owner-routed command. */
  command?(payload: unknown, sourceNodeId: DevelopmentNodeId): unknown
  /** Reconcile transient state when one peer becomes unavailable. */
  peerOffline?(nodeId: DevelopmentNodeId): void | Promise<void>
}

/** Current lifecycle state of one authenticated peer. */
export interface DevelopmentMeshPeerSnapshot {
  readonly nodeId: DevelopmentNodeId
  readonly direction: 'dial' | 'accept'
  readonly state: 'connecting' | 'online' | 'offline' | 'isolated'
  readonly lastSeenAt?: number
  readonly lastError?: string
  readonly pendingSync: number
  readonly conflicts: number
}

/** Current local authenticated Mesh status with no secret material. */
export interface DevelopmentMeshSnapshot {
  readonly nodeId: DevelopmentNodeId
  readonly clusterId: string
  readonly secretFingerprint: string
  readonly peers: readonly DevelopmentMeshPeerSnapshot[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A channel became available for synchronization.
     * @param name - stable channel protocol name.
     * @mode emit
     */
    'development-mesh/channel-registered'(name: string): void
    /**
     * A known authenticated peer changed connection state.
     * @param snapshot - detached state without credentials or signatures.
     * @mode emit
     */
    'development-mesh/peer-changed'(snapshot: DevelopmentMeshPeerSnapshot): void
  }
}
