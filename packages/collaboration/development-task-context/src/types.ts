/** Durable attribution for Task context prepared for one recipient. */

export type {} from '@deepseek-ai/cordis'

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentTaskBindingId,
  DevelopmentTaskContextView,
  DevelopmentTaskId,
} from '@deepseek-ai/dsh-development-task/types'

/** Durable identity of the task-bound event that began one binding interval. */
export interface DevelopmentTaskBindingEpoch {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
}

/** Exact Task creation context or publication retained in a captured revision. */
export type DevelopmentTaskContextSourceRef =
  | { readonly kind: 'task'; readonly taskId: DevelopmentTaskId; readonly revision: number }
  | { readonly kind: 'publication'; readonly taskId: DevelopmentTaskId; readonly revision: number; readonly publicationId: string }

/** One source deliberately excluded from the delivered text. */
export interface DevelopmentTaskContextOmission {
  readonly source: DevelopmentTaskContextSourceRef
  readonly reason: 'self-published' | 'budget' | 'unsupported' | 'superseded' | 'withdrawn' | 'recipient-irrelevant'
}

/** Captured computation inputs; providers must not mutate the Task or recipient. */
export interface DevelopmentTaskContextInput {
  readonly view: DevelopmentTaskContextView
  readonly recipient: {
    readonly participantId: DevelopmentParticipantId
    /** Routing inputs only; the consumer owns authorization and delivery identity. */
    readonly sessionLabel?: string
  }
  /** Maximum UTF-8 bytes of the complete model-visible text, including framing. */
  readonly maxContextBytes: number
  readonly signal: AbortSignal
}

/** Provider-defined identity of the current evidence relevant to this recipient. */
export type DevelopmentTaskContextEvidenceId = Branded<'DevelopmentTaskContextEvidenceId'>

/** Scheduling comparison only; it never replaces exact text, coverage, or live authorization. */
export type DevelopmentTaskContextActivation =
  | { readonly kind: 'exact' }
  | {
    readonly kind: 'recipient-evidence'
    readonly version: 1
    readonly digest: DevelopmentTaskContextEvidenceId
    /** A missing current evidence group cannot establish a completed comparison baseline. */
    readonly coverage: 'complete' | 'blocked-current'
  }

/** Exact backend output retained by its consumer instead of recomputed during replay. */
export interface DevelopmentTaskContextProjection {
  readonly activation: DevelopmentTaskContextActivation
  readonly text: string
  /** Sources represented in this text; not an assertion that the captured revision's other facts are consumed. */
  readonly selectedSources: readonly DevelopmentTaskContextSourceRef[]
  /** Captured sources excluded from the text, with explicit reasons. */
  readonly omittedSources: readonly DevelopmentTaskContextOmission[]
}

/** Exact owner-local Task assignment; a scheduling binding does not replace this authority. */
export interface DevelopmentTaskLocalContextTarget {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  readonly taskBindingId: DevelopmentTaskBindingId
  readonly bindingEpoch: DevelopmentTaskBindingEpoch
}

/** Digest of complete local context bytes, attribution, and authority. */
export type DevelopmentTaskLocalContextProjectionId = Branded<'DevelopmentTaskLocalContextProjectionId'>

/** Exact owner-local projection retained for request replay and automatic completion evidence. */
export interface DevelopmentTaskLocalContextProjection extends DevelopmentTaskContextProjection, DevelopmentTaskLocalContextTarget {
  readonly version: 1
  readonly kind: 'local-task'
  readonly projectionId: DevelopmentTaskLocalContextProjectionId
  readonly taskRevision: number
  readonly ownerNodeId: DevelopmentNodeId
  readonly backend: { readonly id: string; readonly revision: string }
  readonly maxContextBytes: number
}

/** Cleared, rebound, nonlocal, and nonroot assignments cannot produce a current local projection. */
export type DevelopmentTaskLocalContextReadResult =
  | { readonly status: 'active'; readonly projection: DevelopmentTaskLocalContextProjection }
  | { readonly status: 'left' }

/** Why a managed local receiver cannot provide current Task facts. */
export type DevelopmentTaskLocalContextWithdrawalReason = 'left' | 'revoked' | 'expired' | 'unavailable' | 'conflict' | 'failed'

/** Source metadata for a connected Task snapshot or a durable withdrawal marker. */
export type DevelopmentTaskContextSource =
  | {
    readonly kind: 'development-task-context'
    readonly form: 'withdrawn'
    readonly version: 3
    readonly reason: DevelopmentTaskLocalContextWithdrawalReason
  }
  | {
    readonly kind: 'development-task-context'
    readonly form: 'snapshot'
    readonly version: 3
    readonly projection: DevelopmentTaskLocalContextProjection
  }
  | {
    readonly kind: 'development-task-context'
    readonly form: 'snapshot'
    readonly version: 2
    readonly taskId: DevelopmentTaskId
    readonly revision: number
    readonly bindingId: DevelopmentTaskBindingId
    readonly bindingEpoch: DevelopmentTaskBindingEpoch
    readonly backend: { readonly id: string; readonly revision: string }
    readonly maxContextBytes: number
    readonly selectedSources: readonly DevelopmentTaskContextSourceRef[]
    readonly omittedSources: readonly DevelopmentTaskContextOmission[]
  }
  | {
    readonly kind: 'development-task-context'
    readonly form: 'snapshot'
    readonly version: 1
    readonly taskId: DevelopmentTaskId
    readonly revision: number
  }
  | {
    readonly kind: 'development-task-context'
    readonly form: 'retired'
    readonly version: 1
    readonly activeTaskId: DevelopmentTaskId
    readonly activeRevision: number
  }
  | {
    readonly kind: 'development-task-context'
    readonly form: 'disconnected'
    readonly version: 1
  }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'development-task-context': DevelopmentTaskContextSource
  }
}
