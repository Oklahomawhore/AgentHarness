/** Explicit native-session scope authorization, durable scheduling, and message attribution. */

import type { DevelopmentTaskLocalContextProjection, DevelopmentTaskLocalContextTarget } from '@deepseek-ai/dsh-development-task-context/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { ScopeAccessProjection, ScopeInvitation, ScopeSubscription, ScopeSubscriptionId, ScopeOriginalCapture, ScopeCaptureSubscription, ScopeAccessCaptureProjection } from '@deepseek-ai/dsh-scope-access/types'

/** One native-session binding interval, independent of a remote grant's lifetime. */
export type ScopeAgentBindingId = Branded<'ScopeAgentBindingId'>
/** One source-owned joint-join operation, retained independently of later manual bindings. */
export type ScopeAgentJoinReadId = Branded<'ScopeAgentJoinReadId'>

/** Adopt one joint operation’s read permission while retaining an explicitly selected local responsibility. */
export interface ScopeAgentJoinReadRequest {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly invitation: ScopeInvitation
  /** Original source-owned capture; omitted historical operations retain their original full read. */
  readonly originalCapture?: ScopeOriginalCapture
  /** Exact existing local responsibility retained by this additional read permission. */
  readonly localTask?: ScopeAgentLocalTaskTarget
  /** Explicit permission from this Session's user; absence preserves passive adoption. */
  readonly automatic?: ScopeAgentAutomaticPolicy
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
interface ScopeAgentRouteFields {
  readonly agentId: SessionId
  readonly bindingId: ScopeAgentBindingId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly previousOwnerAddress: string
}

/** Same-authority route intent preserves a legacy subscription or its original capture association. */
export type ScopeAgentRouteEvent = ScopeAgentRouteFields & (
  | { readonly version: 1; readonly subscription: Exclude<ScopeSubscription, ScopeCaptureSubscription> & { readonly state: 'active'; readonly routeRevision: number } }
  | { readonly version: 2; readonly subscription: ScopeCaptureSubscription & { readonly state: 'active'; readonly routeRevision: number } }
)

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
  readonly subscription: Exclude<ScopeSubscription, ScopeCaptureSubscription> & { readonly state: 'active' }
  readonly bindingId: ScopeAgentBindingId
}

/** Original joint plan with an explicit finite execution permission from the receiving Session's user. */
export interface ScopeAgentAutomaticJoinReadPlan extends ScopeAgentJoinReadPlan {
  readonly automatic: ScopeAgentAutomaticPolicy
}

type JoinReadTransition<Plan> =
  | { readonly phase: 'planned'; readonly plan: Plan }
  | { readonly phase: 'adopted'; readonly plan: Plan }
  | { readonly phase: 'ended'; readonly plan: Plan | null; readonly leaveAdopted: boolean }
  | { readonly phase: 'superseded'; readonly plan: Plan | null; readonly leaveAdopted: boolean }

/** Non-ignorable adoption history retains passive v1, automatic v2, composite v3, and exact-capture v4 plans. */
export type ScopeAgentJoinReadEvent = {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
} & (
  | ({ readonly version: 1 } & JoinReadTransition<ScopeAgentJoinReadPlan>)
  | ({ readonly version: 2 } & JoinReadTransition<ScopeAgentAutomaticJoinReadPlan>)
  | ({ readonly version: 3 } & JoinReadTransition<ScopeAgentCompositeJoinReadPlan>)
  | ({ readonly version: 4 } & JoinReadTransition<ScopeAgentCaptureJoinReadPlan>)
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
  /** Current scheduling binding observed by the caller; null requires no scheduling binding. */
  readonly expectedBindingId: ScopeAgentBindingId | null
  /** Required when retaining an existing local Root Task assignment. */
  readonly localTask?: ScopeAgentLocalTaskTarget
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
  /** Present only for a version-4 state adopted by the original source Session. */
  readonly originalCapture?: ScopeOriginalCapture
}

/** Scheduling permission for an existing owner-local Task assignment. */
export interface ScopeAgentLocalBinding {
  readonly kind: 'local-task'
  readonly id: ScopeAgentBindingId
  readonly target: DevelopmentTaskLocalContextTarget
}

/** Local scheduling permission restored as a new paused interval after remote departure. */
export interface ScopeAgentRetainedLocal {
  readonly bindingId: ScopeAgentBindingId
  readonly automatic: ScopeAgentAutomaticPolicy | null
}

/** One additional remote read preserves the exact local responsibility and its prior permission. */
export interface ScopeAgentCompositeBinding {
  readonly kind: 'local-task-scope'
  readonly id: ScopeAgentBindingId
  readonly target: DevelopmentTaskLocalContextTarget
  readonly subscriptionId: ScopeSubscriptionId
  readonly invitation: ScopeInvitation
  readonly retainedLocal: ScopeAgentRetainedLocal
  /** Present only for a version-4 state adopted by the original source Session. */
  readonly originalCapture?: ScopeOriginalCapture
}

/** One execution interval owns one policy and either or both explicitly selected information sources. */
export type ScopeAgentBinding = ScopeAgentRemoteBinding | ScopeAgentLocalBinding | ScopeAgentCompositeBinding

/** Both exact inputs admitted under a single complete UTF-8 message budget. */
export interface ScopeAgentCompositeProjection {
  readonly kind: 'local-task-scope'
  readonly version: 1
  readonly local: DevelopmentTaskLocalContextProjection
  readonly remote: ScopeAccessProjection
  readonly maxContextBytes: number
  readonly projectionId: ScopeAccessProjection['projectionId']
  /** Remote revision; local.taskRevision remains independently attributable. */
  readonly taskRevision: ScopeAccessProjection['taskRevision']
}

/** A joint operation captures the original local responsibility and scheduling interval. */
export interface ScopeAgentCompositeJoinReadPlan extends ScopeAgentJoinReadPlan {
  readonly expectedBindingId: ScopeAgentBindingId | null
  readonly target: DevelopmentTaskLocalContextTarget
  readonly retainedLocal: ScopeAgentRetainedLocal
  readonly automatic: ScopeAgentAutomaticPolicy | null
}

/** Exact source identity is carried only by the original joint subscription and its immutable plan. */
export type ScopeAgentCaptureJoinReadPlan = {
  readonly subscription: ScopeCaptureSubscription & { readonly state: 'active' }
  readonly automatic: ScopeAgentAutomaticPolicy | null
} & (
  | (Omit<ScopeAgentJoinReadPlan, 'subscription'> & { readonly kind: 'scope' })
  | (Omit<ScopeAgentCompositeJoinReadPlan, 'subscription'> & { readonly kind: 'local-task-scope' })
)

/** Exact local or remote projection used by the shared scheduler. */
export type ScopeAgentReadProjection = ScopeAccessProjection | DevelopmentTaskLocalContextProjection | ScopeAgentCompositeProjection

/** Why automatic turns require renewed explicit permission. */
export type ScopeAgentPauseReason = 'user' | 'restored' | 'cancelled' | 'turn-ended' | 'step-limit' | 'budget' | 'conflict' | 'unavailable' | 'terminal' | 'failed' | 'coverage'

/** Whole durable scheduling state. It records reservations, never model adoption. */
export interface ScopeAgentBindingStatus {
  readonly version: 1 | 2 | 3 | 4
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

/** Current recorded shared snapshot metadata; neither request dispatch nor current remote authorization. */
export interface ScopeAgentRecordedContext {
  readonly contextSeq: SessionSeq
  readonly bindingId: ScopeAgentBindingId
  readonly subscriptionId: ScopeSubscriptionId
  /** UTF-8 bytes of this shared message’s text blocks, including consumer framing; excludes non-text payloads. */
  readonly sharedBytes: number
  readonly taskRevision: number
  /** Represented source references, not a count of facts, files, or understood material. */
  readonly selectedSourceCount: number
  readonly omittedSourceCounts: {
    readonly 'self-published': number
    readonly budget: number
    readonly unsupported: number
    readonly superseded: number
    readonly withdrawn: number
    readonly 'recipient-irrelevant': number
  }
}

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
    /** Recorded automatic activity for the current eligible binding and goal; never a current authorization check. */
    readonly activity: ScopeAgentActivity
    /** Current matching shared snapshot on the logged surface, or null after withdrawal or binding changes. */
    readonly recordedContext: ScopeAgentRecordedContext | null
  }

/** Logged native context is sufficient to reconstruct the exact request without a network read. */
export type ScopeAgentContextSource =
  | { readonly kind: 'scope-agent-context'; readonly version: 1; readonly form: 'snapshot'; readonly bindingId: ScopeAgentBindingId; readonly subscriptionId: ScopeSubscriptionId; readonly projection: Exclude<ScopeAccessProjection, ScopeAccessCaptureProjection> }
  | { readonly kind: 'scope-agent-context'; readonly version: 2; readonly form: 'snapshot'; readonly bindingId: ScopeAgentBindingId; readonly subscriptionId: ScopeSubscriptionId; readonly projection: ScopeAccessCaptureProjection }
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
  readonly version: 1 | 2 | 3 | 4
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
  readonly version: 1 | 2 | 3 | 4
  readonly turn: number
  readonly step: number
  readonly bindingId: ScopeAgentBindingId
  readonly activationId: ScopeAgentActivationId
  readonly goalDigest: ScopeAgentGoalDigest
  readonly projection: ScopeAgentReadProjection
  readonly contextSeq: SessionSeq
  /** Required for combined projections in versions 3 and 4; contextSeq identifies the remote snapshot. */
  readonly localContextSeq?: SessionSeq
  readonly maxContextBytes: number
}

/** Successful automatic request whose entire turn completed without interruption. */
export interface ScopeAgentCompletedEvidence {
  readonly request: ScopeAgentRequestEvidence
  readonly requestSeq: SessionSeq
  readonly assistantSeq: SessionSeq
  readonly turnEndSeq: SessionSeq
}

/** Recorded projection identity without shared text, source bodies, or the goal text. */
export interface ScopeAgentActivityIdentity {
  readonly bindingId: ScopeAgentBindingId
  readonly goalDigest: ScopeAgentGoalDigest
  readonly taskRevision: ScopeAgentReadProjection['taskRevision']
  /** Local revision when the projection combines independent local and remote Tasks. */
  readonly localTaskRevision?: ScopeAgentReadProjection['taskRevision']
  readonly projectionId: ScopeAgentReadProjection['projectionId']
}

/** An actual automatic request retained by the current turn; absence does not mean no earlier request. */
export interface ScopeAgentActivityRequest extends ScopeAgentActivityIdentity {
  readonly activationId: ScopeAgentActivationId
  readonly requestSeq: SessionSeq
  readonly contextSeq: SessionSeq
  readonly localContextSeq?: SessionSeq
  readonly turn: number
  readonly step: number
}

/** Most recent successfully completed automatic turn for this recorded projection. */
export interface ScopeAgentActivityCompleted extends ScopeAgentActivityRequest {
  readonly assistantSeq: SessionSeq
  readonly turnEndSeq: SessionSeq
}

/** Most recent recorded scheduling decision; activation does not attest a dispatched request. */
export interface ScopeAgentActivityEvaluation extends ScopeAgentActivityIdentity {
  readonly decision: ScopeAgentEvaluation['decision']
  readonly activationId: ScopeAgentActivationId | null
}

/** Cropped wire evidence. Status filters it by current eligibility, binding, and local goal. */
export interface ScopeAgentActivity {
  readonly request: ScopeAgentActivityRequest | null
  readonly completed: ScopeAgentActivityCompleted | null
  readonly evaluation: ScopeAgentActivityEvaluation | null
}

/** Complete Host evidence fold; its wire view exposes only ScopeAgentActivity metadata. */
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
    scopeAgentEvidence: ScopeAgentActivity
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
