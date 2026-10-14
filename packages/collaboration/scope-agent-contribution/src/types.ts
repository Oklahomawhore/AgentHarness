/** Explicit native Session source permission and local management observations. */
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { DevelopmentParticipantId, DevelopmentTaskCommandSelector, DevelopmentTaskLocalContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import type {
  ScopeContributionEntry, ScopeContributionInvitation, ScopeContributionLimits, ScopeContributionProposal, ScopeInvitation,
} from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { ScopeAgentAutomaticPolicy, ScopeAgentJoinReadId, ScopeAgentLocalTaskTarget } from '@deepseek-ai/dsh-scope-agent-context/types'

/** One source capture identity, never reused after termination. */
export type ScopeAgentContributionSelection = Pick<ScopeContributionProposal, 'captureId' | 'captureGeneration'>

/** Editable, uncommitted defaults for one live Session; no collection or receiving permission. */
export interface ScopeAgentContributionPermissionDraft {
  readonly agentId: SessionId
  /** Only the current Session's absolute working directory; empty when it is unavailable. */
  readonly roots: string[]
  /** File-tool names currently visible to this Agent; actual collection still requires native mutation evidence. */
  readonly tools: ('write' | 'edit')[]
  readonly durationHours: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}

/** Common peer application and optional receiving consent, independent of the chosen source. */
export interface ScopeAgentContributionRequestBase {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection | null
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  /** Explicit receiving consent for a single-use joint or reusable group entry; automatic work requires its own finite local policy. */
  readonly receive?: {
    readonly expectedReadStateSeq: SessionSeqCursor
    /** Exact existing local assignment retained by this additional scope permission. */
    readonly localTask?: ScopeAgentLocalTaskTarget
    /** Absent preserves passive receiving; this policy is never sent to the Task owner. */
    readonly automatic?: ScopeAgentAutomaticPolicy
  }
}

/** Explicit native file and command selection; omitted sourceKind preserves existing tool requests. */
export interface ScopeAgentToolContributionPermission {
  readonly sourceKind?: 'tool-observations'
  readonly roots: string[]
  readonly tools: ('write' | 'edit')[]
  readonly commands?: readonly DevelopmentTaskCommandSelector[]
  readonly fileContent?: 'completed-native-file'
  readonly completedTurns?: never
}

/** Share only new, completed user-origin final answers; no file or history permission is implied. */
export interface ScopeAgentTurnContributionPermission {
  readonly sourceKind: 'completed-turn-outcomes'
  readonly roots?: never
  readonly tools?: never
  readonly commands?: never
  readonly fileContent?: never
  readonly initialization?: never
  readonly completedTurns?: never
}

/** One explicit permission for selected file operations, exact commands and completed answers from the same Session. */
export interface ScopeAgentNativeWorkContributionPermission {
  readonly sourceKind: 'native-work'
  readonly roots: string[]
  readonly tools: ('write' | 'edit')[]
  readonly commands: readonly DevelopmentTaskCommandSelector[]
  readonly completedTurns: boolean
  readonly fileContent?: 'completed-native-file'
  readonly initialization?: never
}

/** One explicitly selected source for a peer contribution application. */
export type ScopeAgentContributionRequest = ScopeAgentContributionRequestBase & (ScopeAgentTurnContributionPermission
  | ScopeAgentNativeWorkContributionPermission
  | (ScopeAgentToolContributionPermission & { readonly initialization?: ScopeAgentContributionInitializationRequest }))

/** Update only the original capture's owner address, including retained termination for a cold Session. */
export interface ScopeAgentContributionRecoverRouteRequest {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection
  /** Previously displayed address; an already adopted identical new address is also accepted. */
  readonly expectedOwnerAddress: string
  /** Monotonic route command revision shown with the original capture or continuation. */
  readonly expectedRouteRevision: number
  readonly entry: ScopeContributionEntry
  /** Explicitly recover the original joint read binding against this observed management state. */
  readonly receive?: { readonly expectedReadStateSeq: SessionSeqCursor }
}

/** Local Task assignment shown by the Host, including its exact durable epoch. */
export type ScopeAgentLocalContributionBinding = Pick<DevelopmentTaskLocalContributionGrant,
  'taskId' | 'bindingId' | 'expectedBindingEpoch'>

/** Existing owner-local Root Task assignment and finite source permission. */
export interface ScopeAgentLocalContributionRequestBase extends ScopeAgentLocalContributionBinding {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection | null
  readonly limits: ScopeContributionLimits
}

/** One explicitly selected source for the existing owner-local Task assignment. */
export type ScopeAgentLocalContributionRequest = ScopeAgentLocalContributionRequestBase
  & (ScopeAgentToolContributionPermission | ScopeAgentTurnContributionPermission | ScopeAgentNativeWorkContributionPermission)

/** One explicit historical export selection, independent of local recording and remote reading permission. */
export interface ScopeAgentContributionInitializationRequest {
  readonly kind: 'recorded-local-tools'
  readonly expectedLocalCapture: ScopeAgentContributionSelection
  readonly localTask: ScopeAgentLocalContributionBinding
}

/** Current retained local observations; recording capacity exhaustion does not remove initialization eligibility. */
export interface ScopeAgentContributionInitializationSource {
  readonly eligible: boolean
  readonly recordedSamples: number
  readonly unconfirmedSamples: number
}

/** Frozen initialization covers recorded observations, not current file contents or every past execution. */
export interface ScopeAgentContributionInitialization {
  readonly state: 'pending' | 'frozen' | 'unavailable'
  readonly request: ScopeAgentContributionInitializationRequest
  readonly cutoff: { readonly localSequence: number; readonly sessionSeq: SessionSeqCursor } | null
  readonly coverage: {
    readonly recorded: number
    readonly selected: number
    readonly omitted: number
    readonly unconfirmed: number
    /** In-progress mutations or settled completions not yet persisted at the cutoff. */
    readonly inFlight: number
    /** Owner-confirmed seed receipts; selected records alone do not establish delivery. */
    readonly acknowledged: number
  }
  readonly reason: 'source-unavailable' | 'source-changed' | 'coverage-invalid' | 'capacity' | null
}

/** Durable local Task permission, independent of receiving context or authorizing idle work. */
export interface ScopeAgentLocalContributionCaptureBase {
  readonly selection: ScopeAgentContributionSelection
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly state: 'opening' | 'active' | 'ending'
  readonly collecting: boolean
  readonly pendingSamples: number
  readonly issue: 'owner-unavailable' | 'capacity' | 'rejected' | null
  readonly collectionIssue: ScopeAgentContributionCapture['collectionIssue']
}

/** Actual source permission, never empty file fields standing in for answer-sharing consent. */
export type ScopeAgentContributionSourcePermission = {
  readonly sourceKind: 'tool-observations'
  readonly roots: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly commands?: readonly DevelopmentTaskCommandSelector[]
} | {
  readonly sourceKind: 'completed-turn-outcomes'
  readonly roots?: never
  readonly tools?: never
  readonly commands?: never
} | {
  readonly sourceKind: 'native-work'
  readonly roots: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly commands: readonly DevelopmentTaskCommandSelector[]
  readonly completedTurns: boolean
}

/** Durable owner-local permission with the explicitly selected source. */
export type ScopeAgentLocalContributionCapture = ScopeAgentLocalContributionCaptureBase & ScopeAgentContributionSourcePermission

/** Live local assignment and committed source consent; no implicit checkout or collection. */
export interface ScopeAgentLocalContributionStatus {
  readonly agentId: SessionId
  readonly participantId: DevelopmentParticipantId | null
  readonly eligibility: 'not-live' | 'eligible' | 'delegated' | 'fork' | 'no-local-task'
  readonly assignment: ScopeAgentLocalContributionBinding | null
  readonly revision: number
  readonly capture: ScopeAgentLocalContributionCapture | null
  readonly initialization: ScopeAgentContributionInitializationSource
}

/** Select the exact local or remote capture accepted by the called stop method. */
export interface ScopeAgentContributionStopRequest {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection
}

/** Local adoption of a joint entry's separate read permission; active describes a retained local binding. */
export interface ScopeAgentContributionReceiving {
  /** Original local assignment retained by this join; absence selects an unbound Session. */
  readonly localTask?: ScopeAgentLocalTaskTarget
  /** Original local consent; current mode and consumed budget belong to scopeAgentContext status. */
  readonly automatic?: ScopeAgentAutomaticPolicy
  readonly adoptionId: ScopeAgentJoinReadId
  readonly state: 'waiting' | 'adopting' | 'active' | 'ended' | 'superseded' | 'failed'
  readonly invitation: ScopeInvitation | null
}

/** Read work retained after contribution terminates, still owned by the original local join. */
export interface ScopeAgentContributionReceivingContinuation {
  readonly routeRevision: number
  readonly selection: ScopeAgentContributionSelection
  readonly entry: ScopeContributionEntry
  readonly receiving: ScopeAgentContributionReceiving
  readonly intent: 'adopt' | 'cancel-pending' | 'leave'
}

/** Durable source consent and pending work; contains no captured report content. */
export interface ScopeAgentContributionCaptureBase {
  readonly routeRevision: number
  readonly selection: ScopeAgentContributionSelection
  readonly proposal: ScopeContributionProposal
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly invitation: ScopeContributionInvitation | null
  readonly receiving: ScopeAgentContributionReceiving | null
  readonly receivingIntent?: 'adopt' | 'cancel-pending' | 'leave'
  readonly state: 'prepared' | 'active' | 'ending'
  /** True only while this live Agent instance has current local collection permission. */
  readonly collecting: boolean
  readonly application: 'applying' | 'waiting' | 'cancelling' | 'rejected' | 'expired' | null
  readonly issue: 'owner-unavailable' | 'capacity' | 'rejected' | null
  /** Separately approved recorded-tool initialization and receipt-derived delivery progress. */
  readonly initialization?: ScopeAgentContributionInitialization
  /** Source-local collection or persistence problem; independent of the owner's response. */
  readonly collectionIssue: 'retention-limit' | 'sample-limit' | 'attribution-budget'
    | 'durability-unavailable' | 'durability-failed' | null
  readonly pendingSamples: number
}

/** Durable peer permission with the explicitly selected source. */
export type ScopeAgentContributionCapture = ScopeAgentContributionCaptureBase & ScopeAgentContributionSourcePermission

/** Read-only live eligibility and one durable-domain revision; never an online authorization or model-adoption claim. */
export interface ScopeAgentContributionStatus {
  readonly agentId: SessionId
  readonly eligibility: 'not-live' | 'eligible' | 'delegated' | 'fork'
  readonly revision: number
  readonly capture: ScopeAgentContributionCapture | null
  readonly receivingContinuation?: ScopeAgentContributionReceivingContinuation
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'scope-agent-contribution/not-live': { readonly agentId: SessionId }
    'scope-agent-contribution/ineligible': { readonly agentId: SessionId; readonly reason: 'delegated' | 'fork' }
    'scope-agent-contribution/stale-capture': {
      readonly agentId: SessionId
      readonly expectedCapture: ScopeAgentContributionSelection | null
      readonly actualCapture: ScopeAgentContributionSelection | null
    }
    'scope-agent-contribution/invalid-permission': { readonly agentId: SessionId }
    'scope-agent-contribution/unavailable': { readonly agentId: SessionId }
    'scope-agent-contribution/superseded': { readonly agentId: SessionId }
    'scope-agent-contribution/stale-route': { readonly agentId: SessionId }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Local contribution state committed or live collection eligibility changed.
     * @param agentId - Session whose management status must be reread.
     * @param revision - current durable-domain revision; it does not prove model adoption.
     * @mode emit
     */
    'scope-agent-contribution/changed'(agentId: SessionId, revision: number): void
  }
}
