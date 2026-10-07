/** Local Claude session identity, authorized capture, and command-hook transport data. */

export type {} from '@deepseek-ai/cordis'

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ScopeInvitation, ScopeSubscriptionId, ScopeContributionInvitation, ScopeContributionProposal, ScopeContributionEntry, ScopeContributionLimits } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { DevelopmentTaskId, DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'

/** Installation-scoped digest; the raw external session id is never a shared source identity. */
export type ClaudeScopeSessionKey = Branded<'ClaudeScopeSessionKey'>

/** One source user's joint receiving consent, independent of capture lifetime. */
export type ClaudeScopeJointId = Branded<'ClaudeScopeJointId'>

/** Explicit deployment inputs for project-local hook installation. */
export interface ClaudeScopeSetupConfig {
  /** Absolute Harness home used for the shared profile and the hook's DSH_HOME. */
  readonly home: string
  /** Custom startup-only profile name; shipped and reserved application names are rejected. */
  readonly profileName: string
  /** Absolute executable used to invoke the current dsh installation. */
  readonly launchCommand: string
  /** Arguments before --profile: retain Node startup flags followed by the dsh CLI entry. */
  readonly launchArgs: string[]
  /** Absolute launcher directory retained so source-mode imports resolve at hook startup. */
  readonly launchCwd: string
  /** Maximum bytes for Hook stdin, descriptor reads, and the complete serialized RPC request. */
  readonly maxRequestBytes: number
  /** Maximum bytes for the RPC response and complete Hook stdout JSON, including its newline. */
  readonly maxResponseBytes: number
  /** Command deadline in milliseconds, from application readiness through completed stdout. */
  readonly timeoutMs: number
  /** Claude hook timeout in seconds, at most 60; must exceed the command deadline to allow dsh startup. */
  readonly hookTimeoutSeconds: number
  /** Maximum bytes per configuration file read or complete write, including shared profile files. */
  readonly maxSettingsBytes: number
}

/** One explicitly selected existing project; setup never grants scope membership. */
export interface ClaudeScopeSetupRequest {
  readonly projectPath: string
}

/** Verified configuration files, without a claim that Claude loaded or executed them. */
export interface ClaudeScopeSetupResult {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly outcome: 'configured' | 'already-configured'
}

/** Read-only comparison of the project's hooks and the shared command profile. */
export interface ClaudeScopeProjectSetupResult {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly state: 'configured' | 'not-configured' | 'conflict'
  readonly detail?: string
}

/** Removing project hooks retains the shared profile and existing session grants. */
export interface ClaudeScopeRemoveSetupResult {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly outcome: 'removed' | 'already-removed'
}

/** One explicit collection grant; revision changes whenever its policy is replaced. */
export interface ClaudeScopePolicy {
  readonly roots: readonly string[]
  readonly bashCommands: readonly string[]
  readonly revision: string
}

/** Explicit permission to read one local API document for one logical scope artifact. */
export interface ClaudeScopeOpenApiSource {
  /** Shared logical name; equal names and operations in a Task deliberately identify the same API. */
  readonly name: string
  /** Existing local file, resolved to its canonical path when the grant is created. */
  readonly filePath: string
  readonly method: 'post' | 'put' | 'patch'
  /** Exact, case-sensitive OpenAPI path key. */
  readonly path: string
}

/** Local administrator selection of a known session and its collection policy. */
export interface ClaudeScopeJoinRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly taskId: DevelopmentTaskId
  readonly responsibility: string
  readonly roots: readonly string[]
  readonly bashCommands: readonly string[]
  /** Omission grants no file reads; tool-field collection alone never authorizes sampling. */
  readonly openApiSources?: readonly ClaudeScopeOpenApiSource[]
}

/** Select one read invitation for an observed external session, without granting capture. */
export interface ClaudeScopeReceiveRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly invitation: ScopeInvitation
}

/** Explicit local collection permission; tool reports never authorize transcript or file reads. */
export type ClaudeScopeContributionSource = ClaudeScopeOpenApiSource | {
  readonly kind: 'tool-observations'
  readonly tools: readonly ('Write' | 'Edit')[]
}

/** Authorize local collection for a known session before requesting remote contribution permission. */
export interface ClaudeScopePrepareContributionRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  /** Null requires no retained capture; an existing capture requires its exact identity. */
  readonly expectedCapture: ClaudeScopeContributionSelection | null
  readonly roots: readonly string[]
  readonly source: ClaudeScopeContributionSource
}

/** Persist local collection permission and consent to activate the matching online approval within these limits. */
export interface ClaudeScopeRequestContributionRequest extends ClaudeScopePrepareContributionRequest {
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  /** Required for joint entries; grants passive receiving only at the displayed local read revision. */
  readonly receive?: { readonly expectedReadRevision: number }
}

/** Durable online application intent; active grants retain their invitation instead of this waiting state. */
export interface ClaudeScopeContributionApplication {
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly state: 'applying' | 'waiting' | 'cancelling' | 'rejected' | 'expired'
}

/** Public approval request; local paths, tool content, and external session identifiers are excluded. */
export type ClaudeScopeContributionProposal = ScopeContributionProposal

/** Exact local capture generation shown when a management action was selected. */
export type ClaudeScopeContributionSelection = Pick<ClaudeScopeContributionProposal, 'captureId' | 'captureGeneration'>

/** Persisted local capture identity to hand to the Task owner for separate approval. */
export interface ClaudeScopeContributionPreparation {
  readonly session: ClaudeScopeSessionSummary
  readonly proposal: ClaudeScopeContributionProposal
  /** Versioned, path-free approval request; copying it does not grant publication. */
  readonly proposalText: string
}

/** Activate only an invitation matching the session's previously authorized file and capture identity. */
export interface ClaudeScopeActivateContributionRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly expectedCapture: ClaudeScopeContributionSelection
  readonly invitation: ScopeContributionInvitation
}

/** Stop only the capture generation the local user selected, retaining independent receiving. */
export interface ClaudeScopeContributionLeaveRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly expectedCapture: ClaudeScopeContributionSelection
  /** Optional replacement address for the identical retained grant; only termination is retried. */
  readonly invitation?: ScopeContributionInvitation
}

/** Receiving retained by one joint application; active means local adoption, not model admission. */
export interface ClaudeScopeJointSummary {
  readonly id: ClaudeScopeJointId
  readonly capture: ClaudeScopeContributionSelection
  /** Original consent revision, reused unchanged when retrying a pending application. */
  readonly expectedReadRevision: number
  readonly state: 'waiting' | 'adopting' | 'active' | 'ended' | 'superseded' | 'failed'
  readonly intent: 'adopt' | 'cancel-pending' | 'leave'
  /** Either original permission still has locally retained termination work. */
  readonly cleanupPending: boolean
  readonly subscriptionId?: ScopeSubscriptionId
}

/** Withdraw only the receiving and contribution identities owned by this joint application. */
export interface ClaudeScopeLeaveJointRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly jointId: ClaudeScopeJointId
}

/** Change only the address of this joint application's retained grants; never reopen stopped work. */
export interface ClaudeScopeRecoverJointRequest extends ClaudeScopeLeaveJointRequest {
  readonly expectedReadRevision: number
  readonly ownerAddress: string
}

/** Inspect one observed session without sampling files or checking remote permission. */
export interface ClaudeScopeContributionDetailRequest {
  readonly sessionKey: ClaudeScopeSessionKey
}

/** Current local capture records; paths remain private to the authenticated source Host. */
export interface ClaudeScopeContributionDetail {
  readonly session: ClaudeScopeSessionSummary
  readonly capture: {
    readonly selection: ClaudeScopeContributionSelection
    readonly proposal: ClaudeScopeContributionProposal
    readonly proposalText: string
    readonly roots: readonly string[]
    readonly source: ClaudeScopeContributionSource
    readonly invitation: ScopeContributionInvitation | null
    readonly application: ClaudeScopeContributionApplication | null
  } | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'claude-scope/stale-capture': {
      readonly sessionKey: ClaudeScopeSessionKey
      readonly expectedCapture: ClaudeScopeContributionSelection | null
      readonly actualCapture: ClaudeScopeContributionSelection | null
    }
    'claude-scope/session-unavailable': { readonly sessionKey: ClaudeScopeSessionKey }
    'claude-scope/local-permission-invalid': { readonly sessionKey: ClaudeScopeSessionKey }
    'claude-scope/source-conflict': { readonly sessionKey: ClaudeScopeSessionKey }
    'claude-scope/invitation-mismatch': { readonly sessionKey: ClaudeScopeSessionKey }
    'claude-scope/grant-ended': { readonly sessionKey: ClaudeScopeSessionKey }
    'claude-scope/contribution-unavailable': { readonly sessionKey: ClaudeScopeSessionKey }
    'claude-scope/contribution-superseded': { readonly sessionKey: ClaudeScopeSessionKey }
  }
}

/** Latest authorization result; pending means no request-time projection has been prepared. */
export type ClaudeScopeReceiveStatus = 'pending' | 'active' | 'revoked' | 'expired' | 'unavailable' | 'left'

/** Withdraw one external session's current scope. */
export interface ClaudeScopeLeaveRequest {
  readonly sessionKey: ClaudeScopeSessionKey
}

/** Local chooser state; raw sessionId and cwd are not published into the scope. */
export interface ClaudeScopeSessionSummary {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly sessionId: string
  readonly cwd?: string
  readonly observedAt: number
  readonly ended: boolean
  /** Monotonic local receive-management revision; unrelated Hook observations do not advance it. */
  readonly readRevision: number
  /** Latest joint operation remains visible after its contribution stops. */
  readonly joint?: ClaudeScopeJointSummary
  readonly taskId?: DevelopmentTaskId
  readonly responsibility?: string
  /** Omitted when sharing has stopped and no owner confirmation remains pending. */
  readonly sharingState?: 'awaiting-approval' | 'active' | 'withdrawal-pending'
  /** Task whose source withdrawal still requires owner confirmation; local capture is stopped. */
  readonly withdrawalTaskId?: DevelopmentTaskId
  /** Independent read selection; receiving state reports preparation, not model adoption. */
  readonly receiveSubscriptionId?: ScopeSubscriptionId
  readonly receiveTaskId?: DevelopmentTaskId
  readonly receiveOwnerPeerId?: ScopePeerId
  readonly receiveState?: ClaudeScopeReceiveStatus
  /** Stable retry state; protocol details and remote diagnostics remain Host-local. */
  readonly sharingIssue?: 'owner-unavailable' | 'capacity' | 'rejected'
  /** Independent local capture permit; withdrawal-pending stops sampling before remote confirmation. */
  readonly contributionState?: 'prepared' | 'active' | 'withdrawal-pending'
  /** Pending background approval never authorizes sampling. */
  readonly contributionApplicationState?: ClaudeScopeContributionApplication['state']
  readonly contributionTaskId?: DevelopmentTaskId
  readonly contributionOwnerPeerId?: ScopePeerId
  /** Prepared remains inert when activation cannot be confirmed; retained samples are never silently discarded. */
  readonly contributionIssue?: 'owner-unavailable' | 'capacity' | 'rejected'
}

/** Main-session events participating in capture or request-time delivery. */
export type ClaudeScopeHookEvent =
  | 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'UserPromptSubmit' | 'PostToolBatch' | 'SessionEnd' | 'ignored'

/** Tool input requiring authorization and supported-field parsing before collection. */
export interface ClaudeScopeHookTool {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly response?: unknown
  readonly error?: string
}

/** Hook identity with prompt, transcript, and batch payloads deliberately absent. */
export interface ClaudeScopeHookInput {
  readonly sessionId: string
  readonly event: ClaudeScopeHookEvent
  readonly cwd?: string
  readonly agentId?: string
  readonly tool?: ClaudeScopeHookTool
}

/** Supported fields retained without reading the underlying file or conversation. */
export interface ClaudeScopePreparedInput {
  readonly kind: 'eligible'
  readonly inputDigest: string
  readonly toolName: 'Edit' | 'Write' | 'Bash'
  readonly fields: Readonly<Record<string, string | number | boolean>>
}

/** Collection was skipped without changing the tool's own permission decision. */
export interface ClaudeScopeOmission {
  readonly kind: 'omitted'
  readonly reason: string
}

/** Bounded source text suitable for durable Task deduplication. */
export interface ClaudeScopeObservation {
  readonly kind: 'observation'
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly text: string
}

/** Hidden request context or an empty result, with no permission or blocking fields. */
export interface ClaudeScopeHookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'UserPromptSubmit' | 'PostToolBatch'
    readonly additionalContext: string
  }
}

/** Local processing evidence; projected means prepared output, not model admission. */
export interface ClaudeScopeHookReceipt {
  readonly status: 'observed' | 'left' | 'leased' | 'published' | 'reused' | 'projected' | 'withdrawn' | 'omitted'
  readonly reason?: string
  readonly projectionId?: string
}

/** Authenticated command request checked against the current descriptor generation. */
export interface ClaudeScopeHookRequest {
  readonly generation: string
  readonly input: JsonValue
}

/** The command writes only output to stdout; receipt never represents host admission. */
export interface ClaudeScopeHookResult {
  readonly output: ClaudeScopeHookOutput
  readonly receipt: ClaudeScopeHookReceipt
}

/** Private launch capability; its bearer URL must not reach logs or model context. */
export interface ClaudeScopeDescriptor {
  readonly version: 1
  readonly generation: string
  readonly launchUrl: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A locally observed session's durable management state changed after commit.
     * @param sessionKey - local session whose authenticated inventory can be refreshed.
     * @mode emit
     */
    'claude-scope/session-changed'(sessionKey: ClaudeScopeSessionKey): void
  }
}
