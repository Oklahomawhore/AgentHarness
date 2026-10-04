/** Explicit native-session scope authorization, durable scheduling, and message attribution. */

import type { DevelopmentTaskLocalContextProjection, DevelopmentTaskLocalContextTarget } from '@deepseek-ai/dsh-development-task-context/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { ScopeAccessProjection, ScopeInvitation, ScopeSubscription, ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'

/** One native-session binding interval, independent of a remote grant's lifetime. */
export type ScopeAgentBindingId = Branded<'ScopeAgentBindingId'>
/** One source-owned joint-join operation, retained independently of later manual bindings. */
export type ScopeAgentJoinReadId = Branded<'ScopeAgentJoinReadId'>

/** Adopt one joint operation's read permission into an initially unbound live Session. */
export interface ScopeAgentJoinReadRequest {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly invitation: ScopeInvitation
}

/** Replace only the route of an existing native read binding at its observed management cursor. */
export interface ScopeAgentUpdateRouteRequest {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly ownerAddress: string
}

/** Recover one joint operation's original read without adopting a later manual binding. */
export interface ScopeAgentUpdateJoinReadRouteRequest {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly ownerAddress: string
}

/** Route persistence does not attest owner availability or renew authorization. */
export interface ScopeAgentUpdateRouteResult {
  readonly status: 'updated' | 'ended' | 'superseded'
}

/** Durable route intent preserves the exact subscription, binding, and execution permission. */
export interface ScopeAgentRouteEvent {
  readonly version: 1
  readonly agentId: SessionId
  readonly bindingId: ScopeAgentBindingId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly previousOwnerAddress: string
  readonly subscription: ScopeSubscription & { readonly state: 'active'; readonly routeRevision: number }
}

/** Cancel pending adoption, optionally leaving only the binding this operation actually adopted. */
export interface ScopeAgentCancelJoinReadRequest {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
  readonly leaveAdopted: boolean
}

/** Local adoption only; adopted does not attest online authorization or model use. */
export interface ScopeAgentJoinReadResult {
  readonly status: 'adopted' | 'ended' | 'superseded'
}

/** Original durable operation inputs and receiver identities; retries cannot replace them. */
export interface ScopeAgentJoinReadPlan {
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly subscription: ScopeSubscription & { readonly state: 'active' }
  readonly bindingId: ScopeAgentBindingId
}

/** Non-ignorable local read adoption history; an adopted event atomically installs its passive binding. */
export type ScopeAgentJoinReadEvent = {
  readonly version: 1
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
} & (
  | { readonly phase: 'planned'; readonly plan: ScopeAgentJoinReadPlan }
  | { readonly phase: 'adopted'; readonly plan: ScopeAgentJoinReadPlan }
  | { readonly phase: 'ended'; readonly plan: ScopeAgentJoinReadPlan | null; readonly leaveAdopted: boolean }
  | { readonly phase: 'superseded'; readonly plan: ScopeAgentJoinReadPlan | null; readonly leaveAdopted: boolean }
)

/** One durably reserved automatic activation. */
export type ScopeAgentActivationId = Branded<'ScopeAgentActivationId'>

/** Local permission to start a bounded number of turns without a new user message. */
export interface ScopeAgentAutomaticPolicy {
  readonly goal: string
  /** Absolute lifetime reservation limit for this Session, including cancelled reservations. */
  readonly activationLimit: number
  readonly maxStepsPerTurn: number
  readonly minIntervalMs: number
}

/** Attach an already live ordinary Agent to its own independent read subscription. */
export interface ScopeAgentBindRequest {
  readonly agentId: SessionId
  readonly invitation: ScopeInvitation
  /** Current binding observed by the caller; null requires an unbound Session. */
  readonly expectedBindingId: ScopeAgentBindingId | null
  /** Null enables request-time reads without authorizing idle turns. */
  readonly automatic: ScopeAgentAutomaticPolicy | null
}

/** Exact existing Task assignment selected for local scheduling or departure. */
export interface ScopeAgentLocalTaskTarget {
  readonly taskId: DevelopmentTaskLocalContextTarget['taskId']
  readonly taskBindingId: DevelopmentTaskLocalContextTarget['taskBindingId']
  readonly expectedBindingEpoch: DevelopmentTaskLocalContextTarget['bindingEpoch']
}

/** Authorize bounded local scheduling without creating a Task assignment or a capture grant. */
export interface ScopeAgentBindLocalRequest extends ScopeAgentLocalTaskTarget {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId | null
  readonly automatic: ScopeAgentAutomaticPolicy | null
}

/** Leave only the exact Task assignment that the caller observed, ending its local captures. */
export interface ScopeAgentLeaveLocalTaskRequest extends ScopeAgentLocalTaskTarget {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId | null
}

/** Existing remote read binding; its persisted representation remains unchanged. */
export interface ScopeAgentRemoteBinding {
  readonly kind?: never
  readonly id: ScopeAgentBindingId
  readonly subscriptionId: ScopeSubscriptionId
  readonly invitation: ScopeInvitation
}

/** Scheduling permission for an existing owner-local Task assignment. */
export interface ScopeAgentLocalBinding {
  readonly kind: 'local-task'
  readonly id: ScopeAgentBindingId
  readonly target: DevelopmentTaskLocalContextTarget
}

/** One local execution interval selects either local Task authority or a remote subscription. */
export type ScopeAgentBinding = ScopeAgentRemoteBinding | ScopeAgentLocalBinding

/** Exact local or remote projection used by the shared scheduler. */
export type ScopeAgentReadProjection = ScopeAccessProjection | DevelopmentTaskLocalContextProjection

/** Why automatic turns require renewed explicit permission. */
export type ScopeAgentPauseReason = 'user' | 'restored' | 'cancelled' | 'turn-ended' | 'step-limit' | 'budget' | 'conflict' | 'unavailable' | 'terminal' | 'failed' | 'coverage'

/** Whole durable scheduling state. It records reservations, never model adoption. */
export interface ScopeAgentBindingStatus {
  readonly version: 1 | 2
  readonly agentId: SessionId
  readonly binding: ScopeAgentBinding | null
  readonly automatic: ScopeAgentAutomaticPolicy | null
  readonly mode: 'passive' | 'enabled' | 'paused' | 'left'
  readonly pauseReason: ScopeAgentPauseReason | null
  readonly usedBudget: number
  readonly lastActivationAt: number | null
  readonly pendingActivation: { readonly id: ScopeAgentActivationId; readonly bindingId: ScopeAgentBindingId } | null
}

/** Compare one existing binding before changing its local execution permission. */
export interface ScopeAgentBindingRequest {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId
}

/** Replace automatic permission for the caller's exact binding interval. */
export interface ScopeAgentResumeRequest extends ScopeAgentBindingRequest {
  readonly automatic: ScopeAgentAutomaticPolicy
}

/** Local receiving intent, without claiming a current remote authorization check. */
export type ScopeAgentSubscriptionState = 'unbound' | 'active' | 'left' | 'revoked' | 'expired' | 'missing'

/** A read-only live-Agent observation and its consistent Session projection watermark. */
export type ScopeAgentStatusResult =
  | { readonly agentId: SessionId; readonly eligibility: 'not-live' }
  | {
    readonly agentId: SessionId
    readonly eligibility: 'eligible' | 'delegated' | 'fork' | 'task-conflict'
    readonly state: ScopeAgentBindingStatus
    readonly asOfSeq: SessionSeqCursor
    /** Last reading-management event, or -1; ordinary chat and tools do not advance it. */
    readonly readStateSeq: SessionSeqCursor
    readonly subscriptionState: ScopeAgentSubscriptionState
    readonly localTask: ScopeAgentLocalTaskTarget | null
  }

/** Logged native context is sufficient to reconstruct the exact request without a network read. */
export type ScopeAgentContextSource =
  | { readonly kind: 'scope-agent-context'; readonly version: 1; readonly form: 'snapshot'; readonly bindingId: ScopeAgentBindingId; readonly subscriptionId: ScopeSubscriptionId; readonly projection: ScopeAccessProjection }
  | { readonly kind: 'scope-agent-context'; readonly version: 1; readonly form: 'withdrawn'; readonly reason: 'left' | 'revoked' | 'expired' | 'unavailable' | 'conflict' | 'failed' }

/** Locally authorized scheduling input; remote facts are fetched separately at admission. */
export interface ScopeAgentPulseSource {
  readonly kind: 'scope-agent-pulse'
  readonly version: 1
  readonly bindingId: ScopeAgentBindingId
  readonly activationId: ScopeAgentActivationId
}

/** Identity of the explicitly authorized local goal, independent of scheduling limits. */
export type ScopeAgentGoalDigest = Branded<'ScopeAgentGoalDigest'>

/** Online scheduling decision with the exact projection that was evaluated. */
export interface ScopeAgentEvaluation {
  readonly version: 1 | 2
  readonly decision: 'activate' | 'suppress-unchanged' | 'blocked-current' | 'suppress-reserved'
  readonly bindingId: ScopeAgentBindingId
  readonly goalDigest: ScopeAgentGoalDigest
  readonly projection: ScopeAgentReadProjection
  readonly maxContextBytes: number
  readonly activationId: ScopeAgentActivationId | null
  readonly baseline: { readonly requestSeq: SessionSeq; readonly turnEndSeq: SessionSeq } | null
}

/** Actual loop-built frozen request containing the authorized pulse and exact logged scope snapshot. */
export interface ScopeAgentRequestEvidence {
  readonly version: 1 | 2
  readonly turn: number
  readonly step: number
  readonly bindingId: ScopeAgentBindingId
  readonly activationId: ScopeAgentActivationId
  readonly goalDigest: ScopeAgentGoalDigest
  readonly projection: ScopeAgentReadProjection
  readonly contextSeq: SessionSeq
  readonly maxContextBytes: number
}

/** Successful automatic request whose entire turn completed without interruption. */
export interface ScopeAgentCompletedEvidence {
  readonly request: ScopeAgentRequestEvidence
  readonly requestSeq: SessionSeq
  readonly assistantSeq: SessionSeq
  readonly turnEndSeq: SessionSeq
}

/** Bounded Host-only evidence fold preserving both remote and owner-local request attribution. */
export interface ScopeAgentEvidenceState {
  readonly version: 1
  readonly activeTurn: number | null
  readonly reservation: ScopeAgentEvaluation | null
  readonly dispatched: {
    readonly request: ScopeAgentRequestEvidence
    readonly requestSeq: SessionSeq
    readonly assistantSeq: SessionSeq | null
  } | null
  readonly completed: ScopeAgentCompletedEvidence | null
  readonly lastEvaluation: ScopeAgentEvaluation | null
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'scope-agent-context': ScopeAgentContextSource
    'scope-agent-pulse': ScopeAgentPulseSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete local scope scheduling state; reservation consumption survives cancellation and restart. */
    'scope-agent-context/state': ScopeAgentBindingStatus
    /** Durable joint adoption plan, atomic passive binding, or irreversible cancellation. */
    'scope-agent-context/join-read': ScopeAgentJoinReadEvent
    /** Durable same-grant address change; scheduling permission and receiver identity remain unchanged. */
    'scope-agent-context/route': ScopeAgentRouteEvent
    /** Exact online decision; suppression consumes neither a pulse nor a reservation. */
    'scope-agent-context/evaluation': ScopeAgentEvaluation
    /** Dispatch-time association to actual model input; completion is derived from subsequent assistant and turn events. */
    'scope-agent-context/request': ScopeAgentRequestEvidence
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    scopeAgentContext: ScopeAgentBindingStatus
  }
  interface SessionProjectionStateMap {
    scopeAgentEvidence: ScopeAgentEvidenceState
    scopeAgentContext: ScopeAgentBindingStatus
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'scope-agent/invalid-route': { readonly agentId: SessionId }
    'scope-agent/not-live': { readonly agentId: SessionId }
    'scope-agent/ineligible': { readonly agentId: SessionId; readonly reason: 'delegated' | 'fork' }
    'scope-agent/task-conflict': { readonly agentId: SessionId }
    'scope-agent/stale-task': { readonly agentId: SessionId }
    'scope-agent/stale-binding': { readonly agentId: SessionId; readonly expectedBindingId: ScopeAgentBindingId | null; readonly actualBindingId: ScopeAgentBindingId | null }
    'scope-agent/terminal-subscription': { readonly agentId: SessionId; readonly state: 'left' | 'revoked' | 'expired' | 'missing' }
    'scope-agent/budget-exhausted': { readonly agentId: SessionId; readonly usedBudget: number }
    'scope-agent/superseded': { readonly agentId: SessionId }
  }
}
