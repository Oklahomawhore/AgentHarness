/** Client-safe request, log, and projection types for realtime topic rooms. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one collaboration room. */
export type DevelopmentRoomId = Branded<'DevelopmentRoomId'>

/** Stable identity of one Harness node participating in room replication. */
export type DevelopmentNodeId = Branded<'DevelopmentNodeId'>

/** Stable identity of one human or agent across rooms. */
export type DevelopmentParticipantId = Branded<'DevelopmentParticipantId'>

/** Participant implementation category. */
export type DevelopmentParticipantKind = 'human' | 'agent'

/** Public participant profile plus its current lease state. */
export interface DevelopmentParticipantSnapshot {
  readonly id: DevelopmentParticipantId
  readonly nodeId: DevelopmentNodeId
  readonly kind: DevelopmentParticipantKind
  readonly displayName: string
  readonly presence: 'online' | 'offline'
  readonly lastSeenAt: number
}

/** One immutable room-link change. */
export type DevelopmentRoomLogChange =
  | { readonly kind: 'room-created'; readonly objective: string }
  | { readonly kind: 'participant-joined'; readonly participantId: DevelopmentParticipantId }
  | { readonly kind: 'participant-left'; readonly participantId: DevelopmentParticipantId }

/** One entry in the room service's append-only log. */
export interface DevelopmentRoomLogEntry {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
  readonly at: number
  readonly roomId: DevelopmentRoomId
  readonly change: DevelopmentRoomLogChange
}

/** Current room projection derived only from the append-only room log. */
export interface DevelopmentRoomSnapshot {
  readonly id: DevelopmentRoomId
  readonly creationNodeId: DevelopmentNodeId
  readonly objective: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly participantIds: readonly DevelopmentParticipantId[]
  /** Current transient profiles for retained room participants known to this Host. */
  readonly participants: readonly DevelopmentParticipantSnapshot[]
}

/** Current global roster and discoverable room directory. */
export interface DevelopmentRoomDirectorySnapshot {
  readonly nodeId: DevelopmentNodeId
  readonly presenceTtlMs: number
  readonly participants: readonly DevelopmentParticipantSnapshot[]
  readonly rooms: readonly DevelopmentRoomSnapshot[]
}

/** Announce or replace one participant profile and renew its online lease. */
export interface DevelopmentParticipantAnnounceRequest {
  readonly id: DevelopmentParticipantId
  readonly kind: DevelopmentParticipantKind
  readonly displayName: string
}

/** Renew one participant lease. */
export interface DevelopmentParticipantHeartbeatRequest {
  readonly participantId: DevelopmentParticipantId
}

/** End one participant's online lease without deleting its retained profile. */
export interface DevelopmentParticipantWithdrawRequest {
  readonly participantId: DevelopmentParticipantId
}

/** Create one discoverable collaboration topic. */
export interface DevelopmentRoomCreateRequest {
  readonly objective: string
}

/** Idempotently materialize an internally owned room with a deterministic identity. */
export interface DevelopmentRoomEnsureRequest extends DevelopmentRoomCreateRequest {
  readonly roomId: DevelopmentRoomId
}

/** Add one announced participant to a room. */
export interface DevelopmentRoomJoinRequest {
  readonly roomId: DevelopmentRoomId
  readonly participantId: DevelopmentParticipantId
}

/** Remove one current participant from a room without changing global presence. */
export interface DevelopmentRoomLeaveRequest {
  readonly roomId: DevelopmentRoomId
  readonly participantId: DevelopmentParticipantId
}

/** Origin of one room or presence event after local commit, replica acceptance, or durable restore. */
export type DevelopmentRoomEventOrigin =
  | { readonly kind: 'local'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'replica'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'restored'; readonly nodeId: DevelopmentNodeId }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Persist one locally authored log entry before it becomes observable.
     * A rejecting listener aborts publication; listeners must not mutate the entry.
     * @param entry - exact next local log entry proposed for append.
     * @mode parallel
     */
    'development-room/persist'(entry: DevelopmentRoomLogEntry): Promise<void> | void
    /**
     * One participant renewed or ended its transient online lease.
     * @param snapshot - current participant profile and derived presence.
     * @param origin - local commit or replica source.
     * @mode emit
     */
    'development-room/presence-changed'(
      snapshot: DevelopmentParticipantSnapshot,
      origin: DevelopmentRoomEventOrigin,
    ): void
    /**
     * One room-log entry committed and changed its derived room projection.
     * @param snapshot - immutable room projection after the append.
     * @param entry - exact immutable log entry that produced the projection.
     * @param origin - local append, accepted replica source, or durable restore.
     * @mode emit
     */
    'development-room/changed'(
      snapshot: DevelopmentRoomSnapshot,
      entry: DevelopmentRoomLogEntry,
      origin: DevelopmentRoomEventOrigin,
    ): void
  }
}
