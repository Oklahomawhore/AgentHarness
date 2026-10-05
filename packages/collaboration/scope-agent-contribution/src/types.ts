/** Explicit native Session tool-sharing permission and local management observations. */
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { DevelopmentParticipantId, DevelopmentTaskLocalContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import type {
  ScopeContributionEntry, ScopeContributionInvitation, ScopeContributionLimits, ScopeContributionProposal, ScopeInvitation,
} from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { ScopeAgentAutomaticPolicy, ScopeAgentJoinReadId } from '@deepseek-ai/dsh-scope-agent-context/types'

/** One source capture identity, never reused after termination. */
export type ScopeAgentContributionSelection = Pick<ScopeContributionProposal, 'captureId' | 'captureGeneration'>

/** Explicit permission to collect this Session's allowed tools and activate an equal or narrower owner approval. */
export interface ScopeAgentContributionRequest {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection | null
  readonly entry: ScopeContributionEntry
  readonly roots: string[]
  readonly tools: ('write' | 'edit')[]
  readonly limits: ScopeContributionLimits
  /** Explicit receiving consent for a joint entry; automatic work requires its own finite local policy. */
  readonly receive?: {
    readonly expectedReadStateSeq: SessionSeqCursor
    /** Absent preserves passive receiving; this policy is never sent to the Task owner. */
    readonly automatic?: ScopeAgentAutomaticPolicy
  }
}

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

/** Explicit file permission for the selected Agent's current owner-local Root Task. */
export interface ScopeAgentLocalContributionRequest extends ScopeAgentLocalContributionBinding {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection | null
  readonly roots: string[]
  readonly tools: ('write' | 'edit')[]
  readonly limits: ScopeContributionLimits
}

/** Durable local Task permission, independent of receiving context or authorizing idle work. */
export interface ScopeAgentLocalContributionCapture {
  readonly selection: ScopeAgentContributionSelection
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly roots: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly state: 'opening' | 'active' | 'ending'
  readonly collecting: boolean
  readonly pendingSamples: number
  readonly issue: 'owner-unavailable' | 'capacity' | 'rejected' | null
  readonly collectionIssue: ScopeAgentContributionCapture['collectionIssue']
}

/** Live local assignment and committed source consent; no implicit checkout or collection. */
export interface ScopeAgentLocalContributionStatus {
  readonly agentId: SessionId
  readonly participantId: DevelopmentParticipantId | null
  readonly eligibility: 'not-live' | 'eligible' | 'delegated' | 'fork' | 'no-local-task' | 'remote-capture'
  readonly assignment: ScopeAgentLocalContributionBinding | null
  readonly revision: number
  readonly capture: ScopeAgentLocalContributionCapture | null
}

/** Stop sharing and pending read/automatic adoption; preserve already adopted reading and its execution policy. */
export interface ScopeAgentContributionStopRequest {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection
}

/** Local adoption of a joint entry's separate read permission; active describes a retained local binding. */
export interface ScopeAgentContributionReceiving {
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

/** Durable source consent and pending work; contains no captured tool content. */
export interface ScopeAgentContributionCapture {
  readonly routeRevision: number
  readonly selection: ScopeAgentContributionSelection
  readonly proposal: ScopeContributionProposal
  readonly roots: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
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
  /** Source-local collection or persistence problem; independent of the owner's response. */
  readonly collectionIssue: 'retention-limit' | 'sample-limit' | 'attribution-budget'
    | 'durability-unavailable' | 'durability-failed' | null
  readonly pendingSamples: number
}

/** Read-only live eligibility and one durable-domain revision; never an online authorization or model-adoption claim. */
export interface ScopeAgentContributionStatus {
  readonly agentId: SessionId
  readonly eligibility: 'not-live' | 'eligible' | 'delegated' | 'fork' | 'task-conflict'
  readonly revision: number
  readonly capture: ScopeAgentContributionCapture | null
  readonly receivingContinuation?: ScopeAgentContributionReceivingContinuation
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'scope-agent-contribution/not-live': { readonly agentId: SessionId }
    'scope-agent-contribution/ineligible': { readonly agentId: SessionId; readonly reason: 'delegated' | 'fork' }
    'scope-agent-contribution/task-conflict': { readonly agentId: SessionId }
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
