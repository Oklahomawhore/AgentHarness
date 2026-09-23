/** Client-safe Task lineage, shared-context, and session-binding contracts. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentRoomId } from '@deepseek-ai/dsh-development-room'

export type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentRoomId } from '@deepseek-ai/dsh-development-room'

/** Stable identity of one shared-context Task. */
export type DevelopmentTaskId = Branded<'DevelopmentTaskId'>

/** Content-addressed identity of one immutable inherited-context block. */
export type DevelopmentTaskContextBlockId = Branded<'DevelopmentTaskContextBlockId'>

/** Opaque identity that scopes one Agent session's selected Task. */
export type DevelopmentTaskBindingId = Branded<'DevelopmentTaskBindingId'>

/** One explicit context publication eligible for later Task inheritance. */
export interface DevelopmentTaskContextPublication {
  readonly id: string
  readonly text: string
  readonly uri?: string
  readonly publishedBy: DevelopmentParticipantId
  readonly publishedAt: number
}

/** Immutable reference to one parent Task revision. */
export interface DevelopmentTaskParentRef {
  readonly taskId: DevelopmentTaskId
  readonly revision: number
}

/** Creation relation for one immutable Task DAG node. */
export type DevelopmentTaskOrigin =
  | { readonly kind: 'root' }
  | { readonly kind: 'fork'; readonly parent: DevelopmentTaskParentRef }
  | { readonly kind: 'merge'; readonly parents: readonly DevelopmentTaskParentRef[] }

/** Frozen parent context retained by a Fork or Merge. */
export interface DevelopmentTaskInheritedSource {
  readonly parent: DevelopmentTaskParentRef
  readonly objective: string
  readonly scope: string
  readonly context: readonly DevelopmentTaskContextPublication[]
}

/** Content-addressed inherited context committed before its child Task event. */
export interface DevelopmentTaskContextBlock {
  readonly id: DevelopmentTaskContextBlockId
  readonly createdAt: number
  readonly sources: readonly DevelopmentTaskInheritedSource[]
}

/** One append-only change used to replicate and rebuild Task context. */
export type DevelopmentTaskLogChange =
  | {
    readonly kind: 'task-created'
    readonly origin: DevelopmentTaskOrigin
    readonly objective: string
    readonly scope: string
    readonly createdBy: DevelopmentParticipantId
    readonly inheritedContextBlockId?: DevelopmentTaskContextBlockId
  }
  | { readonly kind: 'context-published'; readonly publication: DevelopmentTaskContextPublication }

/** One durable Task event; `seq` is monotonic per authoring node. */
export interface DevelopmentTaskLogEntry {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
  readonly at: number
  readonly taskId: DevelopmentTaskId
  readonly revision: number
  readonly hiddenRoomId: DevelopmentRoomId
  readonly change: DevelopmentTaskLogChange
}

/** Current Task projection derived only from its append-only context events. */
export interface DevelopmentTaskSnapshot {
  readonly id: DevelopmentTaskId
  readonly ownerNodeId: DevelopmentNodeId
  readonly revision: number
  readonly origin: DevelopmentTaskOrigin
  readonly hiddenRoomId: DevelopmentRoomId
  readonly runtime: 'ready' | 'degraded'
  readonly objective: string
  readonly scope: string
  readonly createdBy: DevelopmentParticipantId
  readonly context: readonly DevelopmentTaskContextPublication[]
  readonly inheritedContextBlockId?: DevelopmentTaskContextBlockId
  readonly createdAt: number
  readonly updatedAt: number
}

/** Bounded Task list filter. */
export interface DevelopmentTaskListRequest {
  /** Include Tasks created by or currently bound to this participant. */
  readonly participantId?: DevelopmentParticipantId
  readonly limit?: number
}

/** Exact Task lookup. */
export interface DevelopmentTaskGetRequest { readonly taskId: DevelopmentTaskId }

/** Bounded lineage neighborhood around one Task. */
export interface DevelopmentTaskLineageRequest {
  readonly taskId: DevelopmentTaskId
  readonly ancestorDepth?: number
  readonly descendantDepth?: number
  readonly limit?: number
}

/** Task projections and truncated boundary ids for one graph view. */
export interface DevelopmentTaskLineageSnapshot {
  readonly tasks: readonly DevelopmentTaskSnapshot[]
  readonly boundaryTaskIds: readonly DevelopmentTaskId[]
}

/** Create a Root, Fork, or Merge shared-context Task. */
export interface DevelopmentTaskCreateRequest {
  readonly origin: DevelopmentTaskOrigin
  readonly objective: string
  readonly scope: string
  readonly createdBy: DevelopmentParticipantId
  /** Explicit parent context publications omitted from this child's immutable inherited block. */
  readonly excludedContextIds?: readonly string[]
}

/** Committed Task and its independently reconciled hidden-Room state. */
export interface DevelopmentTaskCreateResult {
  readonly task: DevelopmentTaskSnapshot
  readonly runtime: DevelopmentTaskSnapshot['runtime']
}

/** Publish explicit Task context eligible for inheritance. */
export interface DevelopmentTaskPublishContextRequest {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  readonly text: string
  readonly uri?: string
}

/** Current Task binding for exactly one Agent session. */
export interface DevelopmentTaskAssignment {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  readonly taskId: DevelopmentTaskId
  readonly sessionLabel?: string
  readonly assignedAt: number
  readonly acknowledgedRevision?: number
}

/** Durable session-binding change authored by the participant's node. */
export interface DevelopmentTaskAssignmentLogEntry {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
  readonly at: number
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  readonly change:
    | { readonly kind: 'task-bound'; readonly taskId: DevelopmentTaskId; readonly sessionLabel?: string }
    | { readonly kind: 'task-cleared'; readonly previousTaskId: DevelopmentTaskId }
    | { readonly kind: 'context-acknowledged'; readonly taskId: DevelopmentTaskId; readonly revision: number }
}

/** Bind one Agent session to exactly one Task. */
export interface DevelopmentTaskCheckoutRequest {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  /** Existing binding to switch, or omitted to create an isolated session binding. */
  readonly bindingId?: DevelopmentTaskBindingId
  readonly sessionLabel?: string
}

/** Clear one Agent session's current Task binding. */
export interface DevelopmentTaskClearRequest {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
}

/** Acknowledge that one Agent session received a Task revision. */
export interface DevelopmentTaskAcknowledgeRequest {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  readonly taskId: DevelopmentTaskId
  readonly revision: number
}

/** Bounded model-facing view of one Task and its inherited sources. */
export interface DevelopmentTaskContextView {
  readonly task: DevelopmentTaskSnapshot
  readonly inherited?: DevelopmentTaskContextBlock
}

/** Independent Room reconciliation status returned after session binding. */
export interface DevelopmentTaskCheckoutResult {
  readonly assignment: DevelopmentTaskAssignment
  readonly context: DevelopmentTaskContextView
  readonly runtime: {
    readonly targetJoined: boolean
    readonly previousLeft: boolean
    readonly warnings: readonly string[]
  }
}

/** Origin of Task and session-binding events after commit, replication, or restore. */
export type DevelopmentTaskEventOrigin =
  | { readonly kind: 'local'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'replica'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'restored'; readonly nodeId: DevelopmentNodeId }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Persist one immutable context block before a Task event may reference it.
     * @param block - content-addressed block proposed for idempotent storage.
     * @mode parallel
     */
    'development-task/context-persist'(block: DevelopmentTaskContextBlock): Promise<void> | void
    /**
     * Persist one Task event before it becomes observable.
     * @param entry - exact next event proposed for append.
     * @mode parallel
     */
    'development-task/persist'(entry: DevelopmentTaskLogEntry): Promise<void> | void
    /**
     * Persist one Agent session-binding event before it becomes observable.
     * @param entry - exact next binding event proposed for append.
     * @mode parallel
     */
    'development-task/assignment-persist'(entry: DevelopmentTaskAssignmentLogEntry): Promise<void> | void
    /**
     * One committed Task context event changed a projection.
     * @param snapshot - immutable Task projection after the append.
     * @param entry - exact event that produced the projection.
     * @param origin - local, replica, or restored source.
     * @mode emit
     */
    'development-task/changed'(
      snapshot: DevelopmentTaskSnapshot,
      entry: DevelopmentTaskLogEntry,
      origin: DevelopmentTaskEventOrigin,
    ): void
    /**
     * One committed binding event changed an Agent session's selected Task.
     * @param assignment - current binding, or undefined after clear.
     * @param entry - exact event that produced the binding state.
     * @param origin - local, replica, or restored source.
     * @mode emit
     */
    'development-task/assignment-changed'(
      assignment: DevelopmentTaskAssignment | undefined,
      entry: DevelopmentTaskAssignmentLogEntry,
      origin: DevelopmentTaskEventOrigin,
    ): void
  }
}
