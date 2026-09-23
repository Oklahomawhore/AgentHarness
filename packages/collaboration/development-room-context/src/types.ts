/** Client-safe shared-room context records and durable message attribution. */

import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'

/** One explicit plain-text contribution to the shared context of a room. */
export interface DevelopmentRoomContextEntry {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
  readonly at: number
  readonly roomId: DevelopmentRoomId
  readonly participantId: DevelopmentParticipantId
  readonly text: string
}

/** Explicit publication by one current room member. */
export interface DevelopmentRoomContextShareRequest {
  readonly roomId: DevelopmentRoomId
  readonly participantId: DevelopmentParticipantId
  readonly text: string
}

/** Complete append-only context log known to this Host. */
export interface DevelopmentRoomContextSnapshot {
  readonly nodeId: DevelopmentNodeId
  readonly entries: readonly DevelopmentRoomContextEntry[]
}

/** Stable position of one shared entry already admitted into an Agent Session. */
export interface DevelopmentRoomContextReference {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
}

/** Durable source metadata used to avoid replaying an admitted entry after resume. */
export interface DevelopmentRoomContextSource {
  readonly kind: 'development-room-context'
  readonly form: 'snapshot'
  readonly version: 1
  readonly entries: readonly DevelopmentRoomContextReference[]
}

/** Origin of one context-log publication event. */
export type DevelopmentRoomContextEventOrigin =
  | { readonly kind: 'local'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'restored'; readonly nodeId: DevelopmentNodeId }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'development-room-context': DevelopmentRoomContextSource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Persist one local context entry before it becomes observable.
     * A rejecting listener aborts publication.
     * @param entry - exact next local entry proposed for append.
     * @mode parallel
     */
    'development-room-context/persist'(entry: DevelopmentRoomContextEntry): Promise<void> | void
    /**
     * One shared context entry committed to the append-only log.
     * @param entry - exact immutable entry that committed.
     * @param origin - local publication or durable restore.
     * @mode emit
     */
    'development-room-context/changed'(
      entry: DevelopmentRoomContextEntry,
      origin: DevelopmentRoomContextEventOrigin,
    ): void
  }
}
