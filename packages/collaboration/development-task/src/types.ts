/** Client-safe Task lineage, shared-context, and session-binding contracts. */

// Retain Cordis loading before Events augmentation in emitted declarations;
// an empty type import is erased and can lose augmentation through its re-exports.
export type {} from '@deepseek-ai/cordis'

import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentRoomId } from '@deepseek-ai/dsh-development-room/types'

export type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentRoomId } from '@deepseek-ai/dsh-development-room/types'

/** Stable identity of one shared-context Task. */
export type DevelopmentTaskId = Branded<'DevelopmentTaskId'>

/** Content-addressed identity of one immutable inherited-context block. */
export type DevelopmentTaskContextBlockId = Branded<'DevelopmentTaskContextBlockId'>

/** Opaque identity that scopes one Agent session's selected Task. */
export type DevelopmentTaskBindingId = Branded<'DevelopmentTaskBindingId'>

/** Lowercase SHA-256 digest of a caller's observation identity, including its binding interval. */
export type DevelopmentTaskObservedSourceId = Branded<'DevelopmentTaskObservedSourceId'>

/** Task-scoped identity of one explicitly configured artifact and operation. */
export type DevelopmentTaskArtifactId = Branded<'DevelopmentTaskArtifactId'>

/** Identity of one artifact collection authorization interval. */
export type DevelopmentTaskArtifactGrantId = Branded<'DevelopmentTaskArtifactGrantId'>

/** Complete supported fields extracted from one OpenAPI operation. */
export interface DevelopmentTaskOpenApiFacts {
  readonly operationId?: string
  readonly requestBodyRequired: boolean
  readonly requiredRequestFields: readonly string[]
  readonly responseStatuses: readonly string[]
  readonly deprecated: boolean
}

/** Reader-owned identity and order of a complete artifact sampling attempt. */
export interface DevelopmentTaskOpenApiObservationIdentity {
  readonly kind: 'openapi-artifact'
  readonly version: 1
  readonly artifactId: DevelopmentTaskArtifactId
  readonly sourceName: string
  readonly grantId: DevelopmentTaskArtifactGrantId
  /** Monotonic within one observer, artifact, and grant; gaps are allowed. */
  readonly sequence: number
  readonly operation: {
    readonly method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'
    readonly path: string
  }
}

/** Complete sampling result; absence of verified facts never asserts their negation. */
export type DevelopmentTaskOpenApiObservationResult =
  | { readonly state: 'valid'; readonly sha256: string; readonly facts: DevelopmentTaskOpenApiFacts }
  | { readonly state: 'invalid'; readonly sha256: string; readonly reason: 'invalid-json' | 'unsupported-document' | 'unsupported-operation' | 'operation-missing' }
  | { readonly state: 'unavailable'; readonly reason: 'missing-file' | 'not-readable' | 'changed-during-read' | 'too-large' }
  | { readonly state: 'revoked'; readonly reason: 'grant-ended' }

/** Host reader's observation before Task admission stamps its binding and author. */
export type DevelopmentTaskOpenApiObservationInput = DevelopmentTaskOpenApiObservationIdentity & DevelopmentTaskOpenApiObservationResult

/** Durable artifact observation stamped only by the Host Task admission methods. */
export type DevelopmentTaskOpenApiObservation = DevelopmentTaskOpenApiObservationInput & {
  readonly observerNodeId: DevelopmentNodeId
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly binding: {
    readonly id: DevelopmentTaskBindingId
    readonly epoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
  }
}

/** Identity of one independently authorized peer contribution. */
export type DevelopmentTaskContributionGrantId = Branded<'DevelopmentTaskContributionGrantId'>
/** Immutable generation of an owner-issued contribution grant. */
export type DevelopmentTaskContributionGeneration = Branded<'DevelopmentTaskContributionGeneration'>
/** Sender-owned identity of one local capture binding. */
export type DevelopmentTaskCaptureId = Branded<'DevelopmentTaskCaptureId'>
/** Sender-owned generation that cannot be reused after local capture ends. */
export type DevelopmentTaskCaptureGeneration = Branded<'DevelopmentTaskCaptureGeneration'>

/** One logical OpenAPI source; existing records retain their untagged representation. */
export interface DevelopmentTaskOpenApiContributionSource {
  readonly kind?: never
  readonly name: string
  readonly method: 'post' | 'put' | 'patch'
  readonly path: string
}

/** Tools approved for observations from a locally permitted collection of files. */
export interface DevelopmentTaskToolObservationSource {
  readonly kind: 'tool-observations'
  readonly version?: never
  readonly initialization?: never
  readonly fileContent?: never
  readonly name: string
  readonly tools: readonly ('Write' | 'Edit')[]
}

/** Explicit approval for prior recorded observations as well as subsequent live reports. */
export type DevelopmentTaskRecordedToolObservationSource = Omit<DevelopmentTaskToolObservationSource, 'version' | 'initialization'> & {
  readonly version: 2
  readonly initialization: 'recorded-local-tools'
}

/** Explicit permission to share the LF text produced by future native file operations. */
export type DevelopmentTaskCompletedFileToolObservationSource = Omit<DevelopmentTaskToolObservationSource, 'version' | 'fileContent'> & {
  readonly version: 3
  readonly fileContent: 'completed-native-file'
}

/** One exact foreground command and its explicitly selected local working-directory root. */
export interface DevelopmentTaskCommandSelector {
  readonly command: string
  readonly rootIndex: number
}

/** Explicit command-outcome permission, optionally combined with future file observations. */
export interface DevelopmentTaskCommandToolObservationSource {
  readonly kind: 'tool-observations'
  readonly version: 4
  readonly name: string
  readonly tools: readonly ('Write' | 'Edit')[]
  readonly commands: readonly DevelopmentTaskCommandSelector[]
  readonly fileContent?: 'completed-native-file'
  readonly initialization?: never
}

/** Immutable source permission without local filesystem roots or session identifiers. */
export type DevelopmentTaskContributionSource = DevelopmentTaskOpenApiContributionSource
  | DevelopmentTaskToolObservationSource | DevelopmentTaskRecordedToolObservationSource
  | DevelopmentTaskCompletedFileToolObservationSource | DevelopmentTaskCommandToolObservationSource

/** Bounded tool report; omitted text is explicit and never establishes current file contents. */
export type DevelopmentTaskToolObservationResult = {
  readonly kind: 'tool-observation'
  readonly version: 1
  readonly reportedStatus: 'success' | 'failure'
  readonly omissions: readonly ('content' | 'oldString' | 'newString' | 'error')[]
} & (
  | {
    readonly tool: 'Write'
    readonly fields: { readonly rootIndex: number; readonly path: string; readonly content?: string; readonly error?: string }
  }
  | {
    readonly tool: 'Edit'
    readonly fields: {
      readonly rootIndex: number
      readonly path: string
      readonly oldString?: string
      readonly newString?: string
      readonly replaceAll: boolean
      readonly error?: string
    }
  }
)

/** Prior recorded tool report; digests identify source evidence without disclosing local Session or directory identifiers. */
export type DevelopmentTaskRecordedToolObservationResult = (
  | Omit<Extract<DevelopmentTaskToolObservationResult, { readonly tool: 'Write' }>, 'version'>
  | Omit<Extract<DevelopmentTaskToolObservationResult, { readonly tool: 'Edit' }>, 'version'>
) & {
  readonly version: 2
  readonly origin: {
    readonly kind: 'recorded-local-tools'
    readonly planDigest: string
    readonly executionDigest: string
  }
}

/** Native completion text is a separate whole-field disclosure from the original tool arguments. */
export type DevelopmentTaskCompletedFileToolObservationResult = (
  | Omit<Extract<DevelopmentTaskToolObservationResult, { readonly tool: 'Write' }>, 'version'>
  | Omit<Extract<DevelopmentTaskToolObservationResult, { readonly tool: 'Edit' }>, 'version'>
) & {
  readonly version: 3
  readonly completedFile:
    | { readonly state: 'included'; readonly content: string; readonly sha256: string }
    | { readonly state: 'omitted'; readonly reason: 'tool-failed' | 'budget' | 'unavailable' }
}

/** One complete provider-returned output field, or explicit whole-field omission for the sharing budget. */
export type DevelopmentTaskCommandOutput =
  | { readonly state: 'included'; readonly text: string; readonly truncated: boolean }
  | { readonly state: 'omitted'; readonly reason: 'budget'; readonly truncated: boolean }

/** Foreground execution evidence; a completed report does not assert that current code passes verification. */
export type DevelopmentTaskCommandObservationResult = {
  readonly kind: 'command-observation'
  readonly version: 4
  readonly tool: 'Bash'
  readonly fields: DevelopmentTaskCommandSelector
} & (
  | {
    readonly state: 'completed'
    readonly exitCode: number | null
    readonly signal: string | null
    readonly timedOut: boolean
    readonly aborted: boolean
    readonly timeoutMs: number
    readonly stdout: DevelopmentTaskCommandOutput
    readonly stderr: DevelopmentTaskCommandOutput
  }
  | { readonly state: 'unavailable'; readonly reason: 'tool-failed' | 'completion-unavailable' }
)

/** Local reports require explicit permission before carrying a native completion's full text. */
export type DevelopmentTaskLocalToolObservationResult =
  | DevelopmentTaskToolObservationResult
  | DevelopmentTaskCompletedFileToolObservationResult
  | DevelopmentTaskCommandObservationResult

/** Peer reports preserve separate live, recorded-work, and completed-file permissions. */
export type DevelopmentTaskPeerToolObservationResult =
  | DevelopmentTaskLocalToolObservationResult
  | DevelopmentTaskRecordedToolObservationResult

/** Identity of one owner-local capture interval; it is never a transport peer identity. */
export type DevelopmentTaskLocalContributionId = Branded<'DevelopmentTaskLocalContributionId'>

/** Explicit local tool permission tied to one actual Agent assignment interval. */
export interface DevelopmentTaskLocalContributionGrant {
  readonly version: 1
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  readonly expectedBindingEpoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
  readonly captureId: DevelopmentTaskCaptureId
  readonly captureGeneration: DevelopmentTaskCaptureGeneration
  readonly source: DevelopmentTaskToolObservationSource | DevelopmentTaskCompletedFileToolObservationSource
    | DevelopmentTaskCommandToolObservationSource
  readonly expiresAt: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}

/** Original owner event for a local capture, including its exact assignment and capture identity. */
export interface DevelopmentTaskLocalContributionReceipt {
  readonly taskId: DevelopmentTaskId
  readonly ownerNodeId: DevelopmentNodeId
  readonly intervalId: DevelopmentTaskLocalContributionId
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  readonly expectedBindingEpoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
  readonly captureId: DevelopmentTaskCaptureId
  readonly captureGeneration: DevelopmentTaskCaptureGeneration
  readonly revision: number
  readonly event: {
    readonly nodeId: DevelopmentNodeId
    readonly seq: number
    readonly kind: 'local-contribution-opened' | 'context-published' | 'local-contribution-ended'
  }
}

/** Local authority reconstructed from durable Task events; terminal intervals never reopen. */
export type DevelopmentTaskLocalContribution = { readonly grant: DevelopmentTaskLocalContributionGrant } & (
  | { readonly state: 'active'; readonly openReceipt: DevelopmentTaskLocalContributionReceipt }
  | { readonly state: 'ended'
    readonly reason: DevelopmentTaskContributionEndReason
    readonly openReceipt?: DevelopmentTaskLocalContributionReceipt
    readonly endReceipt: DevelopmentTaskLocalContributionReceipt }
)

/** Exact locally retained report; Task generates attribution and publication text. */
export interface DevelopmentTaskLocalContributionRequest {
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly result: DevelopmentTaskLocalToolObservationResult
}

/** Irreversible local capture withdrawal using its original permission. */
export interface DevelopmentTaskEndLocalContributionRequest {
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly reason: 'left' | 'revoked'
}

/** Original local sample commit, correlated with every retained payload field. */
export interface DevelopmentTaskLocalContributionAdmissionReceipt extends DevelopmentTaskLocalContributionReceipt {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly payloadDigest: string
  readonly publicationId: string
}

/** Exact local admission result without unrelated Task history. */
export interface DevelopmentTaskLocalContributionResult {
  readonly outcome: 'published' | 'reused'
  readonly publication: DevelopmentTaskContextPublication
  readonly receipt: DevelopmentTaskLocalContributionAdmissionReceipt
}

/** Owner-stamped local permission; terminal notices contain no previous report body. */
export interface DevelopmentTaskLocalContributionMetadata {
  readonly version: 1
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly ended?: DevelopmentTaskContributionEndReason
}

/** Ordered local tool evidence; source Session execution remains the original execution authority. */
export type DevelopmentTaskLocalToolObservation = DevelopmentTaskLocalToolObservationResult & {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
}

/** Owner authorization for one peer, capture generation, and exact source permission. */
export interface DevelopmentTaskPeerContributionGrant {
  readonly version: 1
  readonly taskId: DevelopmentTaskId
  readonly grantId: DevelopmentTaskContributionGrantId
  readonly generation: DevelopmentTaskContributionGeneration
  readonly ownerPeerId: ScopePeerId
  readonly contributorPeerId: ScopePeerId
  readonly captureId: DevelopmentTaskCaptureId
  readonly captureGeneration: DevelopmentTaskCaptureGeneration
  readonly source: DevelopmentTaskContributionSource
  readonly expiresAt: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}

/** Original owner commit; transport peer identity differs from the Task event's node identity. */
export interface DevelopmentTaskPeerContributionReceipt {
  readonly taskId: DevelopmentTaskId
  readonly ownerPeerId: ScopePeerId
  readonly contributorPeerId: ScopePeerId
  readonly grantId: DevelopmentTaskContributionGrantId
  readonly generation: DevelopmentTaskContributionGeneration
  readonly captureId: DevelopmentTaskCaptureId
  readonly captureGeneration: DevelopmentTaskCaptureGeneration
  readonly revision: number
  readonly event: {
    readonly nodeId: DevelopmentNodeId
    readonly seq: number
    readonly kind: 'peer-contribution-opened' | 'context-published' | 'peer-contribution-ended'
  }
}

/** Permanent reason why this grant no longer provides current evidence. */
export type DevelopmentTaskContributionEndReason = 'left' | 'revoked' | 'expired'

/** Authority reconstructed from Task events; ended grants never reopen. */
export type DevelopmentTaskPeerContribution = { readonly grant: DevelopmentTaskPeerContributionGrant } & (
  | { readonly state: 'active'; readonly openReceipt: DevelopmentTaskPeerContributionReceipt }
  | {
    readonly state: 'ended'
    readonly reason: DevelopmentTaskContributionEndReason
    readonly openReceipt?: DevelopmentTaskPeerContributionReceipt
    readonly endReceipt: DevelopmentTaskPeerContributionReceipt
  }
)

/** Exact outbox sample; the owner supplies source attribution and canonical publication text. */
export interface DevelopmentTaskPeerContributionRequest {
  readonly grant: DevelopmentTaskPeerContributionGrant
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly result: Exclude<DevelopmentTaskOpenApiObservationResult, { readonly state: 'revoked' }> | DevelopmentTaskPeerToolObservationResult
}

/** Source and owner can end a known grant; only the owner may revoke it. */
export interface DevelopmentTaskEndPeerContributionRequest {
  readonly grant: DevelopmentTaskPeerContributionGrant
  readonly reason: 'left' | 'revoked'
}

/** OpenAPI evidence attributed to an independent peer instead of a Room participant. */
export type DevelopmentTaskPeerOpenApiObservation = Omit<DevelopmentTaskOpenApiObservationIdentity, 'grantId'> &
  DevelopmentTaskOpenApiObservationResult & {
    readonly grantId: DevelopmentTaskContributionGrantId
    readonly observerPeerId: ScopePeerId
    readonly sourceId: DevelopmentTaskObservedSourceId
    readonly capture: { readonly id: DevelopmentTaskCaptureId; readonly generation: DevelopmentTaskCaptureGeneration }
  }

/** Owner-attributed ordered tool event, distinct from a replaceable OpenAPI artifact sample. */
export type DevelopmentTaskPeerToolObservation = DevelopmentTaskPeerToolObservationResult & {
  readonly sourceName: string
  readonly grantId: DevelopmentTaskContributionGrantId
  readonly sequence: number
  readonly observerPeerId: ScopePeerId
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly capture: { readonly id: DevelopmentTaskCaptureId; readonly generation: DevelopmentTaskCaptureGeneration }
}

/** Owner-stamped peer provenance; ended appears only on the canonical terminal notice. */
export interface DevelopmentTaskPeerContributionMetadata {
  readonly version: 1
  readonly grant: DevelopmentTaskPeerContributionGrant
  readonly ended?: DevelopmentTaskContributionEndReason
}

/** One explicit or admitted context publication eligible for later Task inheritance. */
export type DevelopmentTaskContextPublication = {
  readonly id: string
  readonly text: string
  readonly uri?: string
  readonly publishedAt: number
} & (
  | {
    readonly publishedBy: DevelopmentParticipantId
    readonly observation?: DevelopmentTaskOpenApiObservation
    readonly observedIntervalId?: DevelopmentTaskObservedIntervalId
    readonly observedIntervalEnded?: true
    readonly peerContribution?: never
    readonly peerObservation?: never
    readonly peerToolObservation?: never
    readonly localContribution?: never
    readonly localToolObservation?: never
  }
  | {
    readonly publishedBy?: never
    readonly observation?: never
    readonly observedIntervalId?: never
    readonly observedIntervalEnded?: never
    readonly peerContribution: DevelopmentTaskPeerContributionMetadata
    readonly peerObservation?: DevelopmentTaskPeerOpenApiObservation
    readonly peerToolObservation?: DevelopmentTaskPeerToolObservation
    readonly localContribution?: never
    readonly localToolObservation?: never
  }
  | {
    readonly publishedBy: DevelopmentParticipantId
    readonly observation?: never
    readonly observedIntervalId?: never
    readonly observedIntervalEnded?: never
    readonly peerContribution?: never
    readonly peerObservation?: never
    readonly peerToolObservation?: never
    readonly localContribution: DevelopmentTaskLocalContributionMetadata
    readonly localToolObservation?: DevelopmentTaskLocalToolObservation
  }
)

/** Receipt for one original sample commit, including its complete payload identity. */
export interface DevelopmentTaskPeerContributionAdmissionReceipt extends DevelopmentTaskPeerContributionReceipt {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly payloadDigest: string
  readonly publicationId: string
}

/** Bounded admission response derived from the original publication event. */
export interface DevelopmentTaskPeerContributionResult {
  readonly outcome: 'published' | 'reused'
  readonly publication: DevelopmentTaskContextPublication
  readonly receipt: DevelopmentTaskPeerContributionAdmissionReceipt
}

/** Deterministic identity of one remotely owned Agent binding approved by a Task owner. */
export type DevelopmentTaskObservedIntervalId = Branded<'DevelopmentTaskObservedIntervalId'>

/** Exact source identity to approve or permanently end; no file-read permission is implied. */
export interface DevelopmentTaskObservedIntervalIdentity {
  readonly taskId: DevelopmentTaskId
  readonly sourceNodeId: DevelopmentNodeId
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  readonly expectedBindingEpoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}

/** Local Task-owner approval of the named remote binding interval. */
export type DevelopmentTaskApproveObservedIntervalRequest = DevelopmentTaskObservedIntervalIdentity

/** Source or owner withdrawal, including before an approval has arrived. */
export type DevelopmentTaskEndObservedIntervalRequest = DevelopmentTaskObservedIntervalIdentity

/** Replicated remote Agent binding available for explicit owner approval, not proof of a Claude request. */
export interface DevelopmentTaskObservedCandidate extends DevelopmentTaskObservedIntervalIdentity {
  readonly sessionLabel?: string
}

/** Receipt derived from the original committed owner event, never the latest Task revision. */
export interface DevelopmentTaskObservedReceipt {
  readonly taskId: DevelopmentTaskId
  readonly ownerNodeId: DevelopmentNodeId
  readonly intervalId: DevelopmentTaskObservedIntervalId
  readonly revision: number
  readonly event: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}

/** Owner authority for one source interval; an ended interval can never be approved again. */
export type DevelopmentTaskObservedInterval = DevelopmentTaskObservedIntervalIdentity & {
  readonly id: DevelopmentTaskObservedIntervalId
} & (
  | { readonly state: 'active'; readonly approvalReceipt: DevelopmentTaskObservedReceipt }
  | { readonly state: 'ended'; readonly approvalReceipt?: DevelopmentTaskObservedReceipt; readonly endReceipt: DevelopmentTaskObservedReceipt }
)

/** Remote observation requiring the named owner-approved interval and the exact local binding identity. */
export interface DevelopmentTaskAdmitRemoteObservedContextRequest extends DevelopmentTaskAdmitObservedContextRequest {
  readonly intervalId: DevelopmentTaskObservedIntervalId
}

/** Exact remote publication and its original durable admission receipt. */
export interface DevelopmentTaskAdmitRemoteObservedContextResult {
  readonly outcome: 'published' | 'reused'
  readonly publication: DevelopmentTaskContextPublication
  readonly receipt: DevelopmentTaskObservedReceipt & {
    readonly sourceId: DevelopmentTaskObservedSourceId
    readonly publicationId: string
  }
}

/** Task-specific mutations and reads routed over the trusted Mesh to the authoritative owner. */
export type DevelopmentTaskOwnerCommand =
  | { readonly method: 'publishContext'; readonly request: DevelopmentTaskPublishContextRequest }
  | { readonly method: 'observedIntervals'; readonly request: DevelopmentTaskGetRequest }
  | { readonly method: 'admitObservedRemote'; readonly request: DevelopmentTaskAdmitRemoteObservedContextRequest }
  | { readonly method: 'endObservedInterval'; readonly request: DevelopmentTaskEndObservedIntervalRequest }

/** Return value selected by a Task owner command's discriminant. */
export type DevelopmentTaskOwnerCommandResult<C extends DevelopmentTaskOwnerCommand> =
  C extends { readonly method: 'publishContext' } ? DevelopmentTaskSnapshot
    : C extends { readonly method: 'observedIntervals' } ? readonly DevelopmentTaskObservedInterval[]
      : C extends { readonly method: 'admitObservedRemote' } ? DevelopmentTaskAdmitRemoteObservedContextResult
        : DevelopmentTaskObservedReceipt

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
  | { readonly kind: 'observed-interval-opened'; readonly interval: DevelopmentTaskObservedIntervalIdentity }
  | { readonly kind: 'observed-interval-ended'; readonly interval: DevelopmentTaskObservedIntervalIdentity }
  | { readonly kind: 'local-contribution-opened'; readonly grant: DevelopmentTaskLocalContributionGrant }
  | { readonly kind: 'local-contribution-ended'; readonly grant: DevelopmentTaskLocalContributionGrant; readonly reason: DevelopmentTaskContributionEndReason }
  | { readonly kind: 'peer-contribution-opened'; readonly grant: DevelopmentTaskPeerContributionGrant }
  | { readonly kind: 'peer-contribution-ended'; readonly grant: DevelopmentTaskPeerContributionGrant; readonly reason: DevelopmentTaskContributionEndReason }

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

/** Admit one authorized observation while its original local Agent binding remains current. */
export interface DevelopmentTaskAdmitObservedContextRequest {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  /** The task-bound event captured when the observed operation started. */
  readonly expectedBindingEpoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
  readonly sourceId: DevelopmentTaskObservedSourceId
  /** Caller-filtered observation; the shared publication rules trim and bound this text. */
  readonly text: string
  /** Optional reader evidence; normal admission never accepts grant revocation. */
  readonly observation?: DevelopmentTaskOpenApiObservationIdentity & Exclude<DevelopmentTaskOpenApiObservationResult, { readonly state: 'revoked' }>
}

/** End previously admitted artifact evidence, including after its binding was cleared. */
export interface DevelopmentTaskRevokeObservedArtifactRequest extends Omit<DevelopmentTaskAdmitObservedContextRequest, 'observation'> {
  readonly observation: DevelopmentTaskOpenApiObservationIdentity & { readonly state: 'revoked'; readonly reason: 'grant-ended' }
}

/** Current Task and original publication; reuse appends no event and preserves publication time. */
export interface DevelopmentTaskAdmitObservedContextResult {
  readonly outcome: 'published' | 'reused'
  readonly task: DevelopmentTaskSnapshot
  readonly publication: DevelopmentTaskContextPublication
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
  /** Reject a stale leave command after any new checkout on this binding. */
  readonly expectedBindingEpoch?: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}

/** Acknowledge that one Agent session received a Task revision. */
export interface DevelopmentTaskAcknowledgeRequest {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  readonly taskId: DevelopmentTaskId
  readonly revision: number
  /** Reject adoption from an abandoned binding interval, including Task A → B → A. */
  readonly expectedBindingEpoch?: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
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
     * @param assignment - current binding, or null after clear for lossless JSON forwarding.
     * @param entry - exact event that produced the binding state.
     * @param origin - local, replica, or restored source.
     * @mode emit
     */
    'development-task/assignment-changed'(
      assignment: DevelopmentTaskAssignment | null,
      entry: DevelopmentTaskAssignmentLogEntry,
      origin: DevelopmentTaskEventOrigin,
    ): void
  }
}
