# Development collaboration

English | [中文](development-room.zh.md)

The Web product presents the Emergence Center: humans and Agents share explicit context through an immutable Root/Fork/Merge Task DAG, while one deterministic hidden Room per Task coordinates runtime membership. Task workflow has no lifecycle, evidence, completion, or audit controls; observation grants have separate owner controls. Room failure degrades and retries without changing durable Task context.

The [Task README](../../packages/collaboration/development-task/README.md), [Task storage README](../../packages/collaboration/development-task-storage-domain/README.md), [Task context README](../../packages/collaboration/development-task-context/README.md), [Mesh README](../../packages/collaboration/development-mesh/README.md), [WebSocket provider README](../../packages/collaboration/development-mesh-websocket/README.md), [Room Mesh README](../../packages/collaboration/development-room-mesh/README.md), [Task Mesh README](../../packages/collaboration/development-task-mesh/README.md), [Task-lineage decision](../../.agents/notes/implemented/architecture/2026-08-27-emergence-center-task-lineage.md), and [context-atom decision](../../.agents/notes/implemented/architecture/2026-08-28-task-context-atoms-and-session-bindings.md) own the detailed contracts.

Source: [`packages/collaboration/development-room/src/index.ts`](../../packages/collaboration/development-room/src/index.ts), [`packages/collaboration/development-task/src/index.ts`](../../packages/collaboration/development-task/src/index.ts), [`packages/collaboration/development-task-storage-domain/src/index.ts`](../../packages/collaboration/development-task-storage-domain/src/index.ts), [`packages/collaboration/development-task-context/src/index.ts`](../../packages/collaboration/development-task-context/src/index.ts), [`packages/collaboration/development-mesh/src/index.ts`](../../packages/collaboration/development-mesh/src/index.ts), [`packages/collaboration/development-mesh-websocket/src/index.ts`](../../packages/collaboration/development-mesh-websocket/src/index.ts), [`packages/collaboration/development-room-mesh/src/index.ts`](../../packages/collaboration/development-room-mesh/src/index.ts), and [`packages/collaboration/development-task-mesh/src/index.ts`](../../packages/collaboration/development-task-mesh/src/index.ts)

## Task state

Task ids, context block ids, session binding ids, participant ids, Room ids, and node ids are opaque. Task creation commits an immutable origin and optional content-addressed parent snapshot. Only the Task name, initial shared context, and admitted publications are inheritable; a capture adapter’s authorization does not extend to complete private Sessions or internal reasoning. SQLite persists each event, session binding, and context block as an independent row and rebuilds the bounded in-memory DAG projection at startup.

Each Agent session owns an explicit Task binding. Several sessions from one Codex, Cursor, or Claude participant may connect to different Tasks; switching or clearing one binding does not affect the others. Native Agents receive connected Task context as a replayable user-role Session event at pre-step. An external MCP conversation calls `agentharness_task_connect`, retains its returned binding id, and receives context delta on later Task calls.

## Claude scope hooks

The Claude adapter links external main sessions, explicit collection grants, tool-start leases, and exact recipient projections in its own durable records. It creates no Harness Session and does not treat output receipts as model admission; the [package README](../../packages/collaboration/claude-scope/README.md) owns installation, authorization, and delivery limits.

Source: [`types.ts`](../../packages/collaboration/claude-scope/src/types.ts), [`state.ts`](../../packages/collaboration/claude-scope/src/state.ts)

```ts type-equiv
/** Installation-scoped digest; the raw external session id is never a shared source identity. */
type ClaudeScopeSessionKey = Branded<'ClaudeScopeSessionKey'>
```

```ts type-equiv
/** One source user's joint receiving consent, independent of capture lifetime. */
type ClaudeScopeJointId = Branded<'ClaudeScopeJointId'>
```

```ts type-equiv
/** Receiving retained by one joint application; active means local adoption, not model admission. */
interface ClaudeScopeJointSummary {
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
```

```ts type-equiv
/** Withdraw only the receiving and contribution identities owned by this joint application. */
interface ClaudeScopeLeaveJointRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly jointId: ClaudeScopeJointId
}
```

```ts type-equiv
/** Change only the address of this joint application's retained grants; never reopen stopped work. */
interface ClaudeScopeRecoverJointRequest extends ClaudeScopeLeaveJointRequest {
  readonly expectedReadRevision: number
  readonly ownerAddress: string
}
```

```ts type-equiv
/** Explicit deployment inputs for project-local hook installation. */
interface ClaudeScopeSetupConfig {
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
```

```ts type-equiv
/** One explicitly selected existing project; setup never grants scope membership. */
interface ClaudeScopeSetupRequest {
  readonly projectPath: string
}
```

```ts type-equiv
/** Verified configuration files, without a claim that Claude loaded or executed them. */
interface ClaudeScopeSetupResult {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly outcome: 'configured' | 'already-configured'
}
```

```ts type-equiv
/** Read-only comparison of the project's hooks and the shared command profile. */
interface ClaudeScopeProjectSetupResult {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly state: 'configured' | 'not-configured' | 'conflict'
  readonly detail?: string
}
```

```ts type-equiv
/** Removing project hooks retains the shared profile and existing session grants. */
interface ClaudeScopeRemoveSetupResult {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly outcome: 'removed' | 'already-removed'
}
```

```ts type-equiv
/** One explicit collection grant; revision changes whenever its policy is replaced. */
interface ClaudeScopePolicy {
  readonly roots: readonly string[]
  readonly bashCommands: readonly string[]
  readonly revision: string
}
```

```ts type-equiv
/** Explicit permission to read one local API document for one logical scope artifact. */
interface ClaudeScopeOpenApiSource {
  /** Shared logical name; equal names and operations in a Task deliberately identify the same API. */
  readonly name: string
  /** Existing local file, resolved to its canonical path when the grant is created. */
  readonly filePath: string
  readonly method: 'post' | 'put' | 'patch'
  /** Exact, case-sensitive OpenAPI path key. */
  readonly path: string
}
```

```ts type-equiv
/** Local administrator selection of a known session and its collection policy. */
interface ClaudeScopeJoinRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly taskId: DevelopmentTaskId
  readonly responsibility: string
  readonly roots: readonly string[]
  readonly bashCommands: readonly string[]
  /** Omission grants no file reads; tool-field collection alone never authorizes sampling. */
  readonly openApiSources?: readonly ClaudeScopeOpenApiSource[]
}
```

```ts type-equiv
/** Withdraw one external session's current scope. */
interface ClaudeScopeLeaveRequest {
  readonly sessionKey: ClaudeScopeSessionKey
}
```

```ts type-equiv
/** Local chooser state; raw sessionId and cwd are not published into the scope. */
interface ClaudeScopeSessionSummary {
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
```

```ts type-equiv
/** Main-session events participating in capture or request-time delivery. */
type ClaudeScopeHookEvent =
  | 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'UserPromptSubmit' | 'PostToolBatch' | 'SessionEnd' | 'ignored'
```

```ts type-equiv
/** Tool input requiring authorization and supported-field parsing before collection. */
interface ClaudeScopeHookTool {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly response?: unknown
  readonly error?: string
}
```

```ts type-equiv
/** Hook identity with prompt, transcript, and batch payloads deliberately absent. */
interface ClaudeScopeHookInput {
  readonly sessionId: string
  readonly event: ClaudeScopeHookEvent
  readonly cwd?: string
  readonly agentId?: string
  readonly tool?: ClaudeScopeHookTool
}
```

```ts type-equiv
/** Supported fields retained without reading the underlying file or conversation. */
interface ClaudeScopePreparedInput {
  readonly kind: 'eligible'
  readonly inputDigest: string
  readonly toolName: 'Edit' | 'Write' | 'Bash'
  readonly fields: Readonly<Record<string, string | number | boolean>>
}
```

```ts type-equiv
/** Collection was skipped without changing the tool's own permission decision. */
interface ClaudeScopeOmission {
  readonly kind: 'omitted'
  readonly reason: string
}
```

```ts type-equiv
/** Bounded source text suitable for durable Task deduplication. */
interface ClaudeScopeObservation {
  readonly kind: 'observation'
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly text: string
}
```

```ts type-equiv
/** Hidden request context or an empty result, with no permission or blocking fields. */
interface ClaudeScopeHookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'UserPromptSubmit' | 'PostToolBatch'
    readonly additionalContext: string
  }
}
```

```ts type-equiv
/** Local processing evidence; projected means prepared output, not model admission. */
interface ClaudeScopeHookReceipt {
  readonly status: 'observed' | 'left' | 'leased' | 'published' | 'reused' | 'projected' | 'withdrawn' | 'omitted'
  readonly reason?: string
  readonly projectionId?: string
}
```

```ts type-equiv
/** Authenticated command request checked against the current descriptor generation. */
interface ClaudeScopeHookRequest {
  readonly generation: string
  readonly input: JsonValue
}
```

```ts type-equiv
/** The command writes only output to stdout; receipt never represents host admission. */
interface ClaudeScopeHookResult {
  readonly output: ClaudeScopeHookOutput
  readonly receipt: ClaudeScopeHookReceipt
}
```

```ts type-equiv
/** Private launch capability; its bearer URL must not reach logs or model context. */
interface ClaudeScopeDescriptor {
  readonly version: 1
  readonly generation: string
  readonly launchUrl: string
}
```

```ts type-equiv
/** One explicitly authorized interval; clearing it revokes future adapter admission. */
interface ScopeGrant {
  readonly taskId: DevelopmentTaskId
  readonly epoch: DevelopmentTaskBindingEpoch
  readonly policy: ClaudeScopePolicy
  readonly responsibility: string
  readonly openApiSources: readonly ClaudeScopeOpenApiSource[]
  readonly remote?: {
    readonly ownerNodeId: DevelopmentNodeId
    readonly intervalId?: DevelopmentTaskObservedIntervalId | undefined
  } | undefined
}
```

```ts type-equiv
/** Exact completion retained before an owner admission, including its durable receipt when known. */
interface ScopeCompletionSample {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly text: string
  readonly receipt?: DevelopmentTaskAdmitRemoteObservedContextResult['receipt'] | undefined
}
```

```ts type-equiv
/** Original sampled bytes are represented by their digest and extracted declarations before Task admission. */
interface ScopeArtifactSample extends ScopeCompletionSample {
  readonly observation: DevelopmentTaskOpenApiObservationInput
}
```

```ts type-equiv
/** One live read grant; sequence allocation and pending withdrawal survive a process restart. */
interface ScopeArtifactChain {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly taskId: DevelopmentTaskId
  readonly epoch: DevelopmentTaskBindingEpoch
  readonly policyRevision: string
  readonly source: ClaudeScopeOpenApiSource
  readonly artifactId: DevelopmentTaskArtifactId
  readonly grantId: DevelopmentTaskArtifactGrantId
  readonly sequence: number
  readonly revocation?: ScopeArtifactSample | undefined
}
```

```ts type-equiv
/** Local-only observed identity and its current authorization, if any. */
type ScopeSession = {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly sessionId: string
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  readonly cwd?: string | undefined
  readonly observedAt: number
  readonly ended: boolean
  readonly receive?: ScopeReceive | undefined
  readonly contribution?: ScopeContribution | undefined
  readonly grant?: ScopeGrant | undefined
  readonly lastProjectionId?: string | undefined
  readonly pendingEnd?: {
    readonly identity: DevelopmentTaskObservedIntervalIdentity
    readonly ownerNodeId: DevelopmentNodeId
    readonly receipt?: DevelopmentTaskObservedReceipt | undefined
  } | undefined
  readonly sharingIssue?: 'owner-unavailable' | 'capacity' | 'rejected' | undefined
} & ({
  readonly version?: undefined
  readonly readRevision?: undefined
  readonly joint?: undefined
} | {
  readonly version: 2
  readonly readRevision: number
  readonly joint?: ScopeJoint | undefined
})
```

```ts type-equiv
/** Original authorization plus independently retryable receiving and route work. */
interface ScopeJoint {
  readonly id: ClaudeScopeJointId
  readonly proposal: ClaudeScopeContributionProposal
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly expectedReadRevision: number
  readonly authorizedReadRevision: number
  readonly cleanupPending: boolean
  readonly state: ClaudeScopeJointSummary['state']
  readonly intent: ClaudeScopeJointSummary['intent']
  /** Set only after the exact contribution grant is verified active or its terminal receipt is accepted. */
  readonly ready: boolean
  readonly subscription?: ScopeCaptureSubscription | undefined
  readonly contributionInvitation?: ScopeContributionInvitation | undefined
  readonly adoptedReadRevision?: number | undefined
  readonly routeRevision: number
  readonly routePending: boolean
  /** The last explicit route selection permits an exact retry after its management reply is lost. */
  readonly routeRequest?: {
    readonly expectedReadRevision: number
    readonly appliedReadRevision: number
    readonly ownerAddress: string
  } | undefined
}
```

```ts type-equiv
/** PreToolUse attribution retained until its authorization interval ends. */
interface ScopeToolLease {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly toolUseId: string
  readonly toolName: string
  readonly taskId: DevelopmentTaskId
  readonly epoch: DevelopmentTaskBindingEpoch
  readonly policyRevision: string
  readonly inputDigest: string
  readonly artifactTrigger?: { readonly filePath: string; readonly argumentDigest: string } | undefined
  readonly terminal?: { readonly event: 'PostToolUse' | 'PostToolUseFailure'; readonly textDigest: string } | undefined
  readonly artifactSamples?: readonly ScopeArtifactSample[] | undefined
  readonly artifactsAdmitted?: boolean | undefined
  readonly completion?: ScopeCompletionSample | undefined
  readonly completionAdmitted?: boolean | undefined
}
```

```ts type-equiv
/** Exact external-host text; persistence and RPC return do not establish model admission. */
interface ScopeProjection extends Omit<DevelopmentTaskContextProjection, 'activation'> {
  readonly projectionId: string
  readonly sessionKey: ClaudeScopeSessionKey
  readonly kind: 'snapshot' | 'withdrawal' | 'received' | 'suspended'
  readonly receive?: ScopeReceive | undefined
  readonly cacheKey: string
  readonly maxContextBytes: number
  readonly previousProjectionId?: string | undefined
  readonly taskId?: DevelopmentTaskId | undefined
  readonly epoch?: DevelopmentTaskBindingEpoch | undefined
  readonly taskRevision?: number | undefined
  readonly backend?: { readonly id: string; readonly revision: string } | undefined
}
```

## Observed context admission

The Host admission request carries a caller-filtered observation and the original binding interval. The result identifies its publication. The [Task README](../../packages/collaboration/development-task/README.md) owns admission requirements.

Source: [`packages/collaboration/development-task/src/types.ts`](../../packages/collaboration/development-task/src/types.ts)

```ts type-equiv
/** Lowercase SHA-256 digest of a caller's observation identity, including its binding interval. */
type DevelopmentTaskObservedSourceId = Branded<'DevelopmentTaskObservedSourceId'>
```

```ts type-equiv
/** Task-scoped identity of one explicitly configured artifact and operation. */
type DevelopmentTaskArtifactId = Branded<'DevelopmentTaskArtifactId'>
```

```ts type-equiv
/** Identity of one artifact collection authorization interval. */
type DevelopmentTaskArtifactGrantId = Branded<'DevelopmentTaskArtifactGrantId'>
```

```ts type-equiv
/** Complete supported fields extracted from one OpenAPI operation. */
interface DevelopmentTaskOpenApiFacts {
  readonly operationId?: string
  readonly requestBodyRequired: boolean
  readonly requiredRequestFields: readonly string[]
  readonly responseStatuses: readonly string[]
  readonly deprecated: boolean
}
```

```ts type-equiv
/** Reader-owned identity and order of a complete artifact sampling attempt. */
interface DevelopmentTaskOpenApiObservationIdentity {
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
```

```ts type-equiv
/** Complete sampling result; absence of verified facts never asserts their negation. */
type DevelopmentTaskOpenApiObservationResult =
  | { readonly state: 'valid'; readonly sha256: string; readonly facts: DevelopmentTaskOpenApiFacts }
  | { readonly state: 'invalid'; readonly sha256: string; readonly reason: 'invalid-json' | 'unsupported-document' | 'unsupported-operation' | 'operation-missing' }
  | { readonly state: 'unavailable'; readonly reason: 'missing-file' | 'not-readable' | 'changed-during-read' | 'too-large' }
  | { readonly state: 'revoked'; readonly reason: 'grant-ended' }
```

```ts type-equiv
/** Host reader's observation before Task admission stamps its binding and author. */
type DevelopmentTaskOpenApiObservationInput = DevelopmentTaskOpenApiObservationIdentity & DevelopmentTaskOpenApiObservationResult
```

```ts type-equiv
/** Durable artifact observation stamped only by the Host Task admission methods. */
type DevelopmentTaskOpenApiObservation = DevelopmentTaskOpenApiObservationInput & {
  readonly observerNodeId: DevelopmentNodeId
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly binding: {
    readonly id: DevelopmentTaskBindingId
    readonly epoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
  }
}
```

```ts type-equiv
/** One explicit or admitted context publication eligible for later Task inheritance. */
type DevelopmentTaskContextPublication = {
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
```

```ts type-equiv
/** Admit one authorized observation while its original local Agent binding remains current. */
interface DevelopmentTaskAdmitObservedContextRequest {
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
```

```ts type-equiv
/** End previously admitted artifact evidence, including after its binding was cleared. */
interface DevelopmentTaskRevokeObservedArtifactRequest extends Omit<DevelopmentTaskAdmitObservedContextRequest, 'observation'> {
  readonly observation: DevelopmentTaskOpenApiObservationIdentity & { readonly state: 'revoked'; readonly reason: 'grant-ended' }
}
```

```ts type-equiv
/** Current Task and original publication; reuse appends no event and preserves publication time. */
interface DevelopmentTaskAdmitObservedContextResult {
  readonly outcome: 'published' | 'reused'
  readonly task: DevelopmentTaskSnapshot
  readonly publication: DevelopmentTaskContextPublication
}
```

```ts type-equiv
/** Deterministic identity of one remotely owned Agent binding approved by a Task owner. */
type DevelopmentTaskObservedIntervalId = Branded<'DevelopmentTaskObservedIntervalId'>
```

```ts type-equiv
/** Exact source identity to approve or permanently end; no file-read permission is implied. */
interface DevelopmentTaskObservedIntervalIdentity {
  readonly taskId: DevelopmentTaskId
  readonly sourceNodeId: DevelopmentNodeId
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  readonly expectedBindingEpoch: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}
```

```ts type-equiv
/** Local Task-owner approval of the named remote binding interval. */
type DevelopmentTaskApproveObservedIntervalRequest = DevelopmentTaskObservedIntervalIdentity
```

```ts type-equiv
/** Source or owner withdrawal, including before an approval has arrived. */
type DevelopmentTaskEndObservedIntervalRequest = DevelopmentTaskObservedIntervalIdentity
```

```ts type-equiv
/** Replicated remote Agent binding available for explicit owner approval, not proof of a Claude request. */
interface DevelopmentTaskObservedCandidate extends DevelopmentTaskObservedIntervalIdentity {
  readonly sessionLabel?: string
}
```

```ts type-equiv
/** Receipt derived from the original committed owner event, never the latest Task revision. */
interface DevelopmentTaskObservedReceipt {
  readonly taskId: DevelopmentTaskId
  readonly ownerNodeId: DevelopmentNodeId
  readonly intervalId: DevelopmentTaskObservedIntervalId
  readonly revision: number
  readonly event: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}
```

```ts type-equiv
/** Owner authority for one source interval; an ended interval can never be approved again. */
type DevelopmentTaskObservedInterval = DevelopmentTaskObservedIntervalIdentity & {
  readonly id: DevelopmentTaskObservedIntervalId
} & (
  | { readonly state: 'active'; readonly approvalReceipt: DevelopmentTaskObservedReceipt }
  | { readonly state: 'ended'; readonly approvalReceipt?: DevelopmentTaskObservedReceipt; readonly endReceipt: DevelopmentTaskObservedReceipt }
)
```

```ts type-equiv
/** Remote observation requiring the named owner-approved interval and the exact local binding identity. */
interface DevelopmentTaskAdmitRemoteObservedContextRequest extends DevelopmentTaskAdmitObservedContextRequest {
  readonly intervalId: DevelopmentTaskObservedIntervalId
}
```

```ts type-equiv
/** Exact remote publication and its original durable admission receipt. */
interface DevelopmentTaskAdmitRemoteObservedContextResult {
  readonly outcome: 'published' | 'reused'
  readonly publication: DevelopmentTaskContextPublication
  readonly receipt: DevelopmentTaskObservedReceipt & {
    readonly sourceId: DevelopmentTaskObservedSourceId
    readonly publicationId: string
  }
}
```

```ts type-equiv
/** Task-specific mutations and reads routed over the trusted Mesh to the authoritative owner. */
type DevelopmentTaskOwnerCommand =
  | { readonly method: 'publishContext'; readonly request: DevelopmentTaskPublishContextRequest }
  | { readonly method: 'observedIntervals'; readonly request: DevelopmentTaskGetRequest }
  | { readonly method: 'admitObservedRemote'; readonly request: DevelopmentTaskAdmitRemoteObservedContextRequest }
  | { readonly method: 'endObservedInterval'; readonly request: DevelopmentTaskEndObservedIntervalRequest }
```

```ts type-equiv
/** Return value selected by a Task owner command's discriminant. */
type DevelopmentTaskOwnerCommandResult<C extends DevelopmentTaskOwnerCommand> =
  C extends { readonly method: 'publishContext' } ? DevelopmentTaskSnapshot
    : C extends { readonly method: 'observedIntervals' } ? readonly DevelopmentTaskObservedInterval[]
      : C extends { readonly method: 'admitObservedRemote' } ? DevelopmentTaskAdmitRemoteObservedContextResult
        : DevelopmentTaskObservedReceipt
```

## Recipient context backend

The backend input identifies a captured Task revision, recipient binding interval, and delivery budget. Its output records exact text and source coverage. The [Task context README](../../packages/collaboration/development-task-context/README.md) owns provider configuration and admission semantics.

Source: [`packages/collaboration/development-task-context/src/types.ts`](../../packages/collaboration/development-task-context/src/types.ts)

```ts type-equiv
/** Exact owner-authorized source interval of the recipient's original joint capture. */
type DevelopmentTaskContextPeerCapture = Pick<DevelopmentTaskPeerContributionGrant,
  'ownerPeerId' | 'contributorPeerId' | 'taskId' | 'grantId' | 'generation' | 'captureId' | 'captureGeneration'>
```

```ts type-equiv
/** Durable identity of the task-bound event that began one binding interval. */
interface DevelopmentTaskBindingEpoch {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
}
```

```ts type-equiv
/** Exact Task creation context or publication retained in a captured revision. */
type DevelopmentTaskContextSourceRef =
  | { readonly kind: 'task'; readonly taskId: DevelopmentTaskId; readonly revision: number }
  | { readonly kind: 'publication'; readonly taskId: DevelopmentTaskId; readonly revision: number; readonly publicationId: string }
```

```ts type-equiv
/** One source deliberately excluded from the delivered text. */
interface DevelopmentTaskContextOmission {
  readonly source: DevelopmentTaskContextSourceRef
  readonly reason: 'self-published' | 'budget' | 'unsupported' | 'superseded' | 'withdrawn' | 'recipient-irrelevant'
}
```

```ts type-equiv
/** Captured computation inputs; providers must not mutate the Task or recipient. */
interface DevelopmentTaskContextInput {
  readonly view: DevelopmentTaskContextView
  readonly recipient: {
    readonly participantId: DevelopmentParticipantId
    /** Routing inputs only; the consumer owns authorization and delivery identity. */
    readonly sessionLabel?: string
    /** Original joint capture verified by the consumer; omission identifies authorship, not retained model memory. */
    readonly peerCapture?: DevelopmentTaskContextPeerCapture
  }
  /** Maximum UTF-8 bytes of the complete model-visible text, including framing. */
  readonly maxContextBytes: number
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Provider-defined identity of the current evidence relevant to this recipient. */
type DevelopmentTaskContextEvidenceId = Branded<'DevelopmentTaskContextEvidenceId'>
```

```ts type-equiv
/** Scheduling comparison only; it never replaces exact text, coverage, or live authorization. */
type DevelopmentTaskContextActivation =
  | { readonly kind: 'exact' }
  | {
    readonly kind: 'recipient-evidence'
    readonly version: 1
    readonly digest: DevelopmentTaskContextEvidenceId
    /** A missing current evidence group cannot establish a completed comparison baseline. */
    readonly coverage: 'complete' | 'blocked-current'
  }
```

```ts type-equiv
/** Exact backend output retained by its consumer instead of recomputed during replay. */
interface DevelopmentTaskContextProjection {
  readonly activation: DevelopmentTaskContextActivation
  readonly text: string
  /** Sources represented in this text; not an assertion that the captured revision's other facts are consumed. */
  readonly selectedSources: readonly DevelopmentTaskContextSourceRef[]
  /** Captured sources excluded from the text, with explicit reasons. */
  readonly omittedSources: readonly DevelopmentTaskContextOmission[]
}
```

```ts type-equiv
/** Exact owner-local Task assignment; a scheduling binding does not replace this authority. */
interface DevelopmentTaskLocalContextTarget {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  readonly taskBindingId: DevelopmentTaskBindingId
  readonly bindingEpoch: DevelopmentTaskBindingEpoch
}
```

```ts type-equiv
/** Digest of complete local context bytes, attribution, and authority. */
type DevelopmentTaskLocalContextProjectionId = Branded<'DevelopmentTaskLocalContextProjectionId'>
```

```ts type-equiv
/** Exact owner-local projection retained for request replay and automatic completion evidence. */
interface DevelopmentTaskLocalContextProjection extends DevelopmentTaskContextProjection, DevelopmentTaskLocalContextTarget {
  readonly version: 1
  readonly kind: 'local-task'
  readonly projectionId: DevelopmentTaskLocalContextProjectionId
  readonly taskRevision: number
  readonly ownerNodeId: DevelopmentNodeId
  readonly backend: { readonly id: string; readonly revision: string }
  readonly maxContextBytes: number
}
```

```ts type-equiv
/** Cleared, rebound, nonlocal, and nonroot assignments cannot produce a current local projection. */
type DevelopmentTaskLocalContextReadResult =
  | { readonly status: 'active'; readonly projection: DevelopmentTaskLocalContextProjection }
  | { readonly status: 'left' }
```

```ts type-equiv
/** Why a managed local receiver cannot provide current Task facts. */
type DevelopmentTaskLocalContextWithdrawalReason = 'left' | 'revoked' | 'expired' | 'unavailable' | 'conflict' | 'failed'
```

```ts type-equiv
/** Source metadata for a connected Task snapshot or a durable withdrawal marker. */
type DevelopmentTaskContextSource =
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
```

```ts type-equiv
/** Live Task injector instance; unloading permanently aborts its signal and removes the service. */
interface DevelopmentTaskContextAdmissionCapability {
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Task admission after other pre-step listeners return, before any Task computation or injection. */
interface DevelopmentTaskContextAdmission {
  readonly agent: Agent
  readonly decision: Extract<PreStepDecision, { kind: 'enter' }>
  /** Actual inbox claims from the turn, excluding context synthesized by pre-step listeners. */
  readonly claimed: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}
```

### OpenAPI field selection

Source: [`facts.ts`](../../packages/collaboration/development-task-context/src/facts.ts). Deployment configuration is listed in the [configuration catalog](../config-catalog.md#deepseek-aidsh-development-task-contextfacts).

```ts type-equiv
/** OpenAPI declaration fields eligible for explicit recipient selection. */
type OpenApiFactField = 'operationId' | 'requestBodyRequired' | 'requiredRequestFields' | 'responseStatuses' | 'deprecated'
```

```ts type-equiv
/** Exact responsibility match and selected declaration fields; conflicts always retain all fields. */
interface OpenApiFactRoute {
  /** Complete session label to match exactly; whitespace-only labels are invalid. */
  readonly responsibility: string
  /** Declaration fields for a matching label; duplicate fields are invalid. */
  readonly fields: OpenApiFactField[]
}
```

## Mesh and Room runtime

The generic Mesh registers versioned delta channels. Its WebSocket provider requires a shared credential and authenticates discovery, handshakes, and every envelope with HMAC-SHA256; sequence and nonce rules reject replay. The Room consumer replicates hidden membership state, while the Task consumer sends blocks before dependent Task events, queues out-of-order dependencies, persists remote read caches, and routes mutations to the owner node.

Presence remains a transient lease outside durable logs. Room creation, join, and leave remain idempotent runtime operations, but no user-facing Room Remote, MCP tool, or Web panel is part of the Task-first composition. The legacy explicit Room-context packages remain available to other compositions and are not mounted by the Web bundle.

## Independent device read scopes

[Scope access](../../packages/collaboration/scope-access/README.md) authorizes and computes a single Root Task projection on its owner; [transport](../../packages/collaboration/scope-transport/README.md) authenticates device identity. Receivers retain invitations and exact projections without replicating Task or Room logs. Read protocol version 4 separates complete wire and decoded-response limits from model text budgets; lossless encoding preserves exact projection text and source coverage. The package README owns encoding and protocol-version behavior.

```ts type-equiv
/** Immutable original source selected by a joint receiving operation, never inferred from its peer. */
type ScopeOriginalCapture = Pick<DevelopmentTaskPeerContributionGrant, 'captureId' | 'captureGeneration'>
```

```ts type-equiv
interface ScopeSubscriptionFields {
  /** Monotonic receiver route intent; omitted historical rows denote revision zero. */
  readonly routeRevision?: number
  readonly id: ScopeSubscriptionId
  readonly generation: ScopeGeneration
  readonly invitation: ScopeInvitation
  readonly state: 'active' | 'left' | 'revoked' | 'expired'
}
```

```ts type-equiv
/** Historical or manual receiving intent without a source-association claim. */
interface ScopePlainSubscription extends ScopeSubscriptionFields {
  readonly version?: never
  readonly originalCapture?: never
}
```

```ts type-equiv
/** Joint receiving intent whose original capture cannot change across retries or route recovery. */
interface ScopeCaptureSubscription extends ScopeSubscriptionFields {
  readonly version: 2
  readonly originalCapture: ScopeOriginalCapture
}
```

```ts type-equiv
/** Exact owner-verified original source included in both projection attribution and its digest. */
interface ScopeAccessCaptureProjection extends ScopeAccessProjectionContent {
  readonly version: 3
  readonly activation: DevelopmentTaskContextActivation
  readonly peerCapture: DevelopmentTaskContextPeerCapture
}
```

```ts type-equiv
/** Owner-issued read authorization identity, never reused after revocation. */
type ScopeGrantId = Branded<'ScopeGrantId'>
```

```ts type-equiv
/** Receiver-local connection identity, independent of Task assignment. */
type ScopeSubscriptionId = Branded<'ScopeSubscriptionId'>
```

```ts type-equiv
/** Non-reusable grant or local subscription generation. */
type ScopeGeneration = Branded<'ScopeGeneration'>
```

```ts type-equiv
/** Digest of exact owner text, coverage, and authorization attribution. */
type ScopeProjectionId = Branded<'ScopeProjectionId'>
```

```ts type-equiv
/** Invitation data pins both transport principals; possession alone grants no access. */
interface ScopeInvitation {
  readonly version: 1
  readonly ownerPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly recipientPeerId: ScopePeerId
  readonly taskId: DevelopmentTaskId
  readonly grantId: ScopeGrantId
  readonly generation: ScopeGeneration
  readonly expiresAt: number
  readonly responsibility: string
}
```

```ts type-equiv
/** Local owner authorization; revoked grants remain durable tombstones. */
interface ScopeReadGrant {
  readonly invitation: ScopeInvitation
  readonly state: 'active' | 'revoked'
}
```

```ts type-equiv
/** Active means locally enabled, not remotely verified; only version 2 identifies the original joint source. */
type ScopeSubscription = ScopePlainSubscription | ScopeCaptureSubscription
```

```ts type-equiv
/** Local owner inputs; responsibility routes context but does not narrow read permission. */
interface ScopeInviteRequest {
  readonly taskId: DevelopmentTaskId
  readonly recipientPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly expiresAt: number
  readonly responsibility: string
}
```

```ts type-equiv
/** Consumer-selected backend text allowance; callers reserve model framing and other context separately. */
interface ScopeRetrieveWithinBudgetRequest {
  readonly subscriptionId: ScopeSubscriptionId
  /** Positive safe-integer UTF-8 byte ceiling, further narrowed by both Hosts' configured limits. */
  readonly maxContextBytes: number
}
```

```ts type-equiv
/** Online authorization outcome; unavailable never permits reuse of an earlier projection. */
type ScopeRetrieveResult =
  | { readonly status: 'active'; readonly projection: ScopeAccessProjection }
  | { readonly status: 'revoked' | 'expired' | 'unavailable' | 'left' }
```

```ts type-equiv
/** Local management inventory; no peer protocol exposes this list. */
interface ScopeAccessList {
  readonly grants: readonly ScopeReadGrant[]
  readonly subscriptions: readonly ScopeSubscription[]
}
```

```ts type-equiv
/** Transport identity exposed locally for recipient-pinned invitations. */
type ScopeAccessIdentity = ScopeTransportIdentity
```

```ts type-equiv
/** Public peer identifier derived from the persistent device key. */
type ScopePeerId = Branded<'ScopePeerId'>
```

```ts type-equiv
/** Public identity and currently bound direct addresses; never credential material. */
interface ScopeTransportIdentity {
  readonly peerId: ScopePeerId
  readonly addresses: readonly string[]
}
```

```ts type-equiv
/** Explicit destination whose address must identify the same authenticated peer. */
interface ScopeTransportTarget {
  readonly peerId: ScopePeerId
  readonly address: string
}
```

```ts type-equiv
/** One decoded request; peerId comes from the encrypted connection, never the payload. */
interface ScopeTransportRequest {
  readonly peerId: ScopePeerId
  readonly payload: unknown
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * Authorize and process a request. Payloads and results must be lossless JSON values.
 * Implementations must settle after signal cancellation; transport disposal awaits them.
 * @param request - authenticated sender, untrusted payload, and stream lifetime.
 * @returns protocol-owned JSON; thrown errors become a fixed remote-failed response without their text.
 */
type ScopeTransportHandler = (request: ScopeTransportRequest) => Promise<unknown>
```

```ts type-equiv
/** Select one read invitation for an observed external session, without granting capture. */
interface ClaudeScopeReceiveRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly invitation: ScopeInvitation
}
```

```ts type-equiv
/** Latest authorization result; pending means no request-time projection has been prepared. */
type ClaudeScopeReceiveStatus = 'pending' | 'active' | 'revoked' | 'expired' | 'unavailable' | 'left'
```

```ts type-equiv
/** Local recipient interval and the exact independently granted scope. */
interface ScopeReceive {
  readonly subscriptionId: ScopeSubscriptionId
  readonly generation: ScopeGeneration
  readonly taskId: DevelopmentTaskId
  readonly ownerPeerId: ScopePeerId
  readonly grantId: ScopeGrantId
  readonly grantGeneration: ScopeGeneration
  readonly expiresAt: number
  readonly status: ClaudeScopeReceiveStatus
}
```

```ts type-equiv
/** Exact text and attribution shared by persisted projection representations. */
interface ScopeAccessProjectionContent extends Omit<DevelopmentTaskContextProjection, 'activation'> {
  readonly projectionId: ScopeProjectionId
  readonly taskId: DevelopmentTaskId
  readonly taskRevision: number
  readonly ownerPeerId: ScopePeerId
  readonly recipientPeerId: ScopePeerId
  readonly grantId: ScopeGrantId
  readonly grantGeneration: ScopeGeneration
  readonly expiresAt: number
  readonly backend: { readonly id: string; readonly revision: string }
  readonly maxContextBytes: number
}
```

```ts type-equiv
/** Persisted representation without a provider activation comparison; retains its original digest. */
interface ScopeAccessLegacyProjection extends ScopeAccessProjectionContent {
  readonly version?: never
  readonly activation?: never
}
```

```ts type-equiv
/** Exact current representation binds provider scheduling evidence into the projection identity. */
interface ScopeAccessCurrentProjection extends ScopeAccessProjectionContent {
  readonly version: 2
  readonly activation: DevelopmentTaskContextActivation
}
```

```ts type-equiv
/** Strict historical replay and current owner-produced projections, including explicit joint-source attribution. */
type ScopeAccessProjection = ScopeAccessLegacyProjection | ScopeAccessCurrentProjection | ScopeAccessCaptureProjection
```

## Native work contribution

[Native source contribution](../../packages/collaboration/scope-agent-contribution/README.md) collects permitted file-tool completions and explicitly selected foreground command outcomes from one existing ordinary Agent after explicit local consent and independent owner approval. Its authenticated management methods return local durable state without exposing captured content. Mutations compare capture identity; change events invalidate Client observations, and neither collecting state nor revision proves model adoption.

```ts type-equiv
/** One source capture identity, never reused after termination. */
type ScopeAgentContributionSelection = Pick<ScopeContributionProposal, 'captureId' | 'captureGeneration'>
```

```ts type-equiv
/** One explicit historical export selection, independent of local recording and remote reading permission. */
interface ScopeAgentContributionInitializationRequest {
  readonly kind: 'recorded-local-tools'
  readonly expectedLocalCapture: ScopeAgentContributionSelection
  readonly localTask: ScopeAgentLocalContributionBinding
}
```

```ts type-equiv
/** Current retained local observations; recording capacity exhaustion does not remove initialization eligibility. */
interface ScopeAgentContributionInitializationSource {
  readonly eligible: boolean
  readonly recordedSamples: number
  readonly unconfirmedSamples: number
}
```

```ts type-equiv
/** Frozen initialization covers recorded observations, not current file contents or every past execution. */
interface ScopeAgentContributionInitialization {
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
```

```ts type-equiv
/** Editable, uncommitted defaults for one live Session; no collection or receiving permission. */
interface ScopeAgentContributionPermissionDraft {
  readonly agentId: SessionId
  /** Only the current Session's absolute working directory; empty when it is unavailable. */
  readonly roots: string[]
  /** File-tool names currently visible to this Agent; actual collection still requires native mutation evidence. */
  readonly tools: ('write' | 'edit')[]
  readonly durationHours: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}
```

```ts type-equiv
/** Explicit permission to collect this Session's allowed tools and activate an equal or narrower owner approval. */
interface ScopeAgentContributionRequest {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection | null
  readonly entry: ScopeContributionEntry
  readonly roots: string[]
  readonly tools: ('write' | 'edit')[]
  /** Exact foreground commands and directory ordinals whose execution results may be shared; absent grants no command sharing. */
  readonly commands?: readonly DevelopmentTaskCommandSelector[]
  /** Explicitly share complete text produced by permitted native tools, including unchanged file contents; absent shares inputs only. */
  readonly fileContent?: 'completed-native-file'
  readonly limits: ScopeContributionLimits
  /** Explicit historical export from this Session’s exact existing local capture; current join roots, tools, and limits also apply. */
  readonly initialization?: ScopeAgentContributionInitializationRequest
  /** Explicit receiving consent for a single-use joint or reusable group entry; automatic work requires its own finite local policy. */
  readonly receive?: {
    readonly expectedReadStateSeq: SessionSeqCursor
    /** Exact existing local assignment retained by this additional scope permission. */
    readonly localTask?: ScopeAgentLocalTaskTarget
    /** Absent preserves passive receiving; this policy is never sent to the Task owner. */
    readonly automatic?: ScopeAgentAutomaticPolicy
  }
}
```

```ts type-equiv
/** Update only the original capture's owner address, including retained termination for a cold Session. */
interface ScopeAgentContributionRecoverRouteRequest {
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
```

```ts type-equiv
/** Select the exact local or remote capture accepted by the called stop method. */
interface ScopeAgentContributionStopRequest {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection
}
```

```ts type-equiv
/** Durable source consent and pending work; contains no captured tool content. */
interface ScopeAgentContributionCapture {
  readonly routeRevision: number
  readonly selection: ScopeAgentContributionSelection
  readonly proposal: ScopeContributionProposal
  readonly roots: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly commands?: readonly DevelopmentTaskCommandSelector[]
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
```

```ts type-equiv
/** Read-only live eligibility and one durable-domain revision; never an online authorization or model-adoption claim. */
interface ScopeAgentContributionStatus {
  readonly agentId: SessionId
  readonly eligibility: 'not-live' | 'eligible' | 'delegated' | 'fork'
  readonly revision: number
  readonly capture: ScopeAgentContributionCapture | null
  readonly receivingContinuation?: ScopeAgentContributionReceivingContinuation
}
```

```ts type-equiv
/** Local adoption of a joint entry's separate read permission; active describes a retained local binding. */
interface ScopeAgentContributionReceiving {
  /** Original local assignment retained by this join; absence selects an unbound Session. */
  readonly localTask?: ScopeAgentLocalTaskTarget
  /** Original local consent; current mode and consumed budget belong to scopeAgentContext status. */
  readonly automatic?: ScopeAgentAutomaticPolicy
  readonly adoptionId: ScopeAgentJoinReadId
  readonly state: 'waiting' | 'adopting' | 'active' | 'ended' | 'superseded' | 'failed'
  readonly invitation: ScopeInvitation | null
}
```

```ts type-equiv
/** Read work retained after contribution terminates, still owned by the original local join. */
interface ScopeAgentContributionReceivingContinuation {
  readonly routeRevision: number
  readonly selection: ScopeAgentContributionSelection
  readonly entry: ScopeContributionEntry
  readonly receiving: ScopeAgentContributionReceiving
  readonly intent: 'adopt' | 'cancel-pending' | 'leave'
}
```

## Independent scope receipt in native Sessions

[The native consumer](../../packages/collaboration/scope-agent-context/README.md) binds an independent read invitation to one live ordinary Agent, optionally retaining its explicitly confirmed local Task assignment under one context budget and scheduler. Change hints contain no facts; pre-step reads online and logs the exact projection in the Session. Passive mode waits for ordinary work, while automatic mode requires a local goal and finite budget; restored automatic execution is paused.

```ts type-equiv
/** Opaque change comparison tied to one subscription and authorized owner state; not a read lease. */
type ScopeChangeCursor = Branded<'ScopeChangeCursor'>
```

```ts type-equiv
/** Change hints contain no facts; retrieve must verify authorization before supplying context. */
type ScopeWaitResult =
  | { readonly status: 'changed' | 'unchanged'; readonly cursor: ScopeChangeCursor }
  | { readonly status: 'revoked' | 'expired' | 'left' | 'unavailable' }
```

```ts type-equiv
/** Local deployment limits; these values do not describe or reserve a remote peer's capacity. */
interface ScopeTransportLimits {
  /** Maximum admitted inbound requests across all local protocols. */
  readonly maxInboundRequests: number
  /** Maximum local outbound requests, including dialing. */
  readonly maxOutboundRequests: number
  /** Complete local request or handler deadline in milliseconds. */
  readonly requestTimeoutMs: number
}
```

```ts type-equiv
/** Durable route intent preserves the exact subscription, binding, and execution permission. */
interface ScopeAgentRouteFields {
  readonly agentId: SessionId
  readonly bindingId: ScopeAgentBindingId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly previousOwnerAddress: string
}
```

```ts type-equiv
/** Exact source identity is carried only by the original joint subscription and its immutable plan. */
type ScopeAgentCaptureJoinReadPlan = {
  readonly subscription: ScopeCaptureSubscription & { readonly state: 'active' }
  readonly automatic: ScopeAgentAutomaticPolicy | null
} & (
  | (Omit<ScopeAgentJoinReadPlan, 'subscription'> & { readonly kind: 'scope' })
  | (Omit<ScopeAgentCompositeJoinReadPlan, 'subscription'> & { readonly kind: 'local-task-scope' })
)
```

```ts type-equiv
/** One native-session binding interval, independent of a remote grant's lifetime. */
type ScopeAgentBindingId = Branded<'ScopeAgentBindingId'>
```

```ts type-equiv
/** One source-owned joint-join operation, retained independently of later manual bindings. */
type ScopeAgentJoinReadId = Branded<'ScopeAgentJoinReadId'>
```

```ts type-equiv
/** Adopt one joint operation’s read permission while retaining an explicitly selected local responsibility. */
interface ScopeAgentJoinReadRequest {
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
```

```ts type-equiv
/** Replace only the route of an existing native read binding at its observed management cursor. */
interface ScopeAgentUpdateRouteRequest {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly ownerAddress: string
}
```

```ts type-equiv
/** Recover one joint operation's original read without adopting a later manual binding. */
interface ScopeAgentUpdateJoinReadRouteRequest {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly ownerAddress: string
}
```

```ts type-equiv
/** Route persistence does not attest owner availability or renew authorization. */
interface ScopeAgentUpdateRouteResult {
  readonly status: 'updated' | 'ended' | 'superseded'
}
```

```ts type-equiv
/** Same-authority route intent preserves a legacy subscription or its original capture association. */
type ScopeAgentRouteEvent = ScopeAgentRouteFields & (
  | { readonly version: 1; readonly subscription: Exclude<ScopeSubscription, ScopeCaptureSubscription> & { readonly state: 'active'; readonly routeRevision: number } }
  | { readonly version: 2; readonly subscription: ScopeCaptureSubscription & { readonly state: 'active'; readonly routeRevision: number } }
)
```

```ts type-equiv
/** Cancel pending adoption, optionally leaving only the binding this operation actually adopted. */
interface ScopeAgentCancelJoinReadRequest {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
  readonly leaveAdopted: boolean
}
```

```ts type-equiv
/** Local adoption only; adopted does not attest online authorization or model use. */
interface ScopeAgentJoinReadResult {
  readonly status: 'adopted' | 'ended' | 'superseded'
}
```

```ts type-equiv
/** Original durable operation inputs and receiver identities; retries cannot replace them. */
interface ScopeAgentJoinReadPlan {
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly subscription: Exclude<ScopeSubscription, ScopeCaptureSubscription> & { readonly state: 'active' }
  readonly bindingId: ScopeAgentBindingId
}
```

```ts type-equiv
/** Original joint plan with an explicit finite execution permission from the receiving Session's user. */
interface ScopeAgentAutomaticJoinReadPlan extends ScopeAgentJoinReadPlan {
  readonly automatic: ScopeAgentAutomaticPolicy
}
```

```ts type-equiv
type JoinReadTransition<Plan> =
  | { readonly phase: 'planned'; readonly plan: Plan }
  | { readonly phase: 'adopted'; readonly plan: Plan }
  | { readonly phase: 'ended'; readonly plan: Plan | null; readonly leaveAdopted: boolean }
  | { readonly phase: 'superseded'; readonly plan: Plan | null; readonly leaveAdopted: boolean }
```

```ts type-equiv
/** Non-ignorable adoption history retains passive v1, automatic v2, composite v3, and exact-capture v4 plans. */
type ScopeAgentJoinReadEvent = {
  readonly agentId: SessionId
  readonly adoptionId: ScopeAgentJoinReadId
} & (
  | ({ readonly version: 1 } & JoinReadTransition<ScopeAgentJoinReadPlan>)
  | ({ readonly version: 2 } & JoinReadTransition<ScopeAgentAutomaticJoinReadPlan>)
  | ({ readonly version: 3 } & JoinReadTransition<ScopeAgentCompositeJoinReadPlan>)
  | ({ readonly version: 4 } & JoinReadTransition<ScopeAgentCaptureJoinReadPlan>)
)
```

```ts type-equiv
/** One durably reserved automatic activation. */
type ScopeAgentActivationId = Branded<'ScopeAgentActivationId'>
```

```ts type-equiv
/** Local permission to start a bounded number of turns without a new user message. */
interface ScopeAgentAutomaticPolicy {
  readonly goal: string
  /** Absolute lifetime reservation limit for this Session, including cancelled reservations. */
  readonly activationLimit: number
  readonly maxStepsPerTurn: number
  readonly minIntervalMs: number
}
```

```ts type-equiv
/** Attach an already live ordinary Agent to its own independent read subscription. */
interface ScopeAgentBindRequest {
  readonly agentId: SessionId
  readonly invitation: ScopeInvitation
  /** Current scheduling binding observed by the caller; null requires no scheduling binding. */
  readonly expectedBindingId: ScopeAgentBindingId | null
  /** Required when retaining an existing local Root Task assignment. */
  readonly localTask?: ScopeAgentLocalTaskTarget
  /** Null enables request-time reads without authorizing idle turns. */
  readonly automatic: ScopeAgentAutomaticPolicy | null
}
```

```ts type-equiv
/** Exact existing Task assignment selected for local scheduling or departure. */
interface ScopeAgentLocalTaskTarget {
  readonly taskId: DevelopmentTaskLocalContextTarget['taskId']
  readonly taskBindingId: DevelopmentTaskLocalContextTarget['taskBindingId']
  readonly expectedBindingEpoch: DevelopmentTaskLocalContextTarget['bindingEpoch']
}
```

```ts type-equiv
/** Authorize bounded local scheduling without creating a Task assignment or a capture grant. */
interface ScopeAgentBindLocalRequest extends ScopeAgentLocalTaskTarget {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId | null
  readonly automatic: ScopeAgentAutomaticPolicy | null
}
```

```ts type-equiv
/** Leave only the exact Task assignment that the caller observed, ending its local captures. */
interface ScopeAgentLeaveLocalTaskRequest extends ScopeAgentLocalTaskTarget {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId | null
}
```

```ts type-equiv
/** Existing remote read binding; its persisted representation remains unchanged. */
interface ScopeAgentRemoteBinding {
  readonly kind?: never
  readonly id: ScopeAgentBindingId
  readonly subscriptionId: ScopeSubscriptionId
  readonly invitation: ScopeInvitation
  /** Present only for a version-4 state adopted by the original source Session. */
  readonly originalCapture?: ScopeOriginalCapture
}
```

```ts type-equiv
/** Scheduling permission for an existing owner-local Task assignment. */
interface ScopeAgentLocalBinding {
  readonly kind: 'local-task'
  readonly id: ScopeAgentBindingId
  readonly target: DevelopmentTaskLocalContextTarget
}
```

```ts type-equiv
/** Local scheduling permission restored as a new paused interval after remote departure. */
interface ScopeAgentRetainedLocal {
  readonly bindingId: ScopeAgentBindingId
  readonly automatic: ScopeAgentAutomaticPolicy | null
}
```

```ts type-equiv
/** One additional remote read preserves the exact local responsibility and its prior permission. */
interface ScopeAgentCompositeBinding {
  readonly kind: 'local-task-scope'
  readonly id: ScopeAgentBindingId
  readonly target: DevelopmentTaskLocalContextTarget
  readonly subscriptionId: ScopeSubscriptionId
  readonly invitation: ScopeInvitation
  readonly retainedLocal: ScopeAgentRetainedLocal
  /** Present only for a version-4 state adopted by the original source Session. */
  readonly originalCapture?: ScopeOriginalCapture
}
```

```ts type-equiv
/** Both exact inputs admitted under a single complete UTF-8 message budget. */
interface ScopeAgentCompositeProjection {
  readonly kind: 'local-task-scope'
  readonly version: 1
  readonly local: DevelopmentTaskLocalContextProjection
  readonly remote: ScopeAccessProjection
  readonly maxContextBytes: number
  readonly projectionId: ScopeAccessProjection['projectionId']
  /** Remote revision; local.taskRevision remains independently attributable. */
  readonly taskRevision: ScopeAccessProjection['taskRevision']
}
```

```ts type-equiv
/** A joint operation captures the original local responsibility and scheduling interval. */
interface ScopeAgentCompositeJoinReadPlan extends ScopeAgentJoinReadPlan {
  readonly expectedBindingId: ScopeAgentBindingId | null
  readonly target: DevelopmentTaskLocalContextTarget
  readonly retainedLocal: ScopeAgentRetainedLocal
  readonly automatic: ScopeAgentAutomaticPolicy | null
}
```

```ts type-equiv
/** Exact local or remote projection used by the shared scheduler. */
type ScopeAgentReadProjection = ScopeAccessProjection | DevelopmentTaskLocalContextProjection | ScopeAgentCompositeProjection
```

```ts type-equiv
/** One execution interval owns one policy and either or both explicitly selected information sources. */
type ScopeAgentBinding = ScopeAgentRemoteBinding | ScopeAgentLocalBinding | ScopeAgentCompositeBinding
```

```ts type-equiv
/** Why automatic turns require renewed explicit permission. */
type ScopeAgentPauseReason = 'user' | 'restored' | 'cancelled' | 'turn-ended' | 'step-limit' | 'budget' | 'conflict' | 'unavailable' | 'terminal' | 'failed' | 'coverage'
```

```ts type-equiv
/** Whole durable scheduling state. It records reservations, never model adoption. */
interface ScopeAgentBindingStatus {
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
```

```ts type-equiv
/** Compare one existing binding before changing its local execution permission. */
interface ScopeAgentBindingRequest {
  readonly agentId: SessionId
  readonly expectedBindingId: ScopeAgentBindingId
}
```

```ts type-equiv
/** Replace automatic permission for the caller's exact binding interval. */
interface ScopeAgentResumeRequest extends ScopeAgentBindingRequest {
  readonly automatic: ScopeAgentAutomaticPolicy
}
```

```ts type-equiv
/** Local receiving intent, without claiming a current remote authorization check. */
type ScopeAgentSubscriptionState = 'unbound' | 'active' | 'left' | 'revoked' | 'expired' | 'missing'
```

```ts type-equiv
/** Current recorded shared snapshot metadata; neither request dispatch nor current remote authorization. */
interface ScopeAgentRecordedContext {
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
```

```ts type-equiv
/** A read-only live-Agent observation and its consistent Session projection watermark. */
type ScopeAgentStatusResult =
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
```

```ts type-equiv
/** Logged native context is sufficient to reconstruct the exact request without a network read. */
type ScopeAgentContextSource =
  | { readonly kind: 'scope-agent-context'; readonly version: 1; readonly form: 'snapshot'; readonly bindingId: ScopeAgentBindingId; readonly subscriptionId: ScopeSubscriptionId; readonly projection: Exclude<ScopeAccessProjection, ScopeAccessCaptureProjection> }
  | { readonly kind: 'scope-agent-context'; readonly version: 2; readonly form: 'snapshot'; readonly bindingId: ScopeAgentBindingId; readonly subscriptionId: ScopeSubscriptionId; readonly projection: ScopeAccessCaptureProjection }
  | { readonly kind: 'scope-agent-context'; readonly version: 1; readonly form: 'withdrawn'; readonly reason: 'left' | 'revoked' | 'expired' | 'unavailable' | 'conflict' | 'failed' }
```

```ts type-equiv
/** Locally authorized scheduling input; remote facts are fetched separately at admission. */
interface ScopeAgentPulseSource {
  readonly kind: 'scope-agent-pulse'
  readonly version: 1
  readonly bindingId: ScopeAgentBindingId
  readonly activationId: ScopeAgentActivationId
}
```

```ts type-equiv
/** Identity of the explicitly authorized local goal, independent of scheduling limits. */
type ScopeAgentGoalDigest = Branded<'ScopeAgentGoalDigest'>
```

```ts type-equiv
/** Online scheduling decision with the exact projection that was evaluated. */
interface ScopeAgentEvaluation {
  readonly version: 1 | 2 | 3 | 4
  readonly decision: 'activate' | 'suppress-unchanged' | 'blocked-current' | 'suppress-reserved'
  readonly bindingId: ScopeAgentBindingId
  readonly goalDigest: ScopeAgentGoalDigest
  readonly projection: ScopeAgentReadProjection
  readonly maxContextBytes: number
  readonly activationId: ScopeAgentActivationId | null
  readonly baseline: { readonly requestSeq: SessionSeq; readonly turnEndSeq: SessionSeq } | null
}
```

```ts type-equiv
/** Actual loop-built frozen request containing the authorized pulse and exact logged scope snapshot. */
interface ScopeAgentRequestEvidence {
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
```

```ts type-equiv
/** Successful automatic request whose entire turn completed without interruption. */
interface ScopeAgentCompletedEvidence {
  readonly request: ScopeAgentRequestEvidence
  readonly requestSeq: SessionSeq
  readonly assistantSeq: SessionSeq
  readonly turnEndSeq: SessionSeq
}
```

```ts type-equiv
/** Recorded projection identity without shared text, source bodies, or the goal text. */
interface ScopeAgentActivityIdentity {
  readonly bindingId: ScopeAgentBindingId
  readonly goalDigest: ScopeAgentGoalDigest
  readonly taskRevision: ScopeAgentReadProjection['taskRevision']
  /** Local revision when the projection combines independent local and remote Tasks. */
  readonly localTaskRevision?: ScopeAgentReadProjection['taskRevision']
  readonly projectionId: ScopeAgentReadProjection['projectionId']
}
```

```ts type-equiv
/** An actual automatic request retained by the current turn; absence does not mean no earlier request. */
interface ScopeAgentActivityRequest extends ScopeAgentActivityIdentity {
  readonly activationId: ScopeAgentActivationId
  readonly requestSeq: SessionSeq
  readonly contextSeq: SessionSeq
  readonly localContextSeq?: SessionSeq
  readonly turn: number
  readonly step: number
}
```

```ts type-equiv
/** Most recent successfully completed automatic turn for this recorded projection. */
interface ScopeAgentActivityCompleted extends ScopeAgentActivityRequest {
  readonly assistantSeq: SessionSeq
  readonly turnEndSeq: SessionSeq
}
```

```ts type-equiv
/** Most recent recorded scheduling decision; activation does not attest a dispatched request. */
interface ScopeAgentActivityEvaluation extends ScopeAgentActivityIdentity {
  readonly decision: ScopeAgentEvaluation['decision']
  readonly activationId: ScopeAgentActivationId | null
}
```

```ts type-equiv
/** Cropped wire evidence. Status filters it by current eligibility, binding, and local goal. */
interface ScopeAgentActivity {
  readonly request: ScopeAgentActivityRequest | null
  readonly completed: ScopeAgentActivityCompleted | null
  readonly evaluation: ScopeAgentActivityEvaluation | null
}
```

```ts type-equiv
/** Complete Host evidence fold; its wire view exposes only ScopeAgentActivity metadata. */
interface ScopeAgentEvidenceState {
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
```

```ts type-equiv
/** Stable identity of one shared-context Task. */
type DevelopmentTaskId = Branded<'DevelopmentTaskId'>
```

```ts type-equiv
/** Content-addressed identity of one immutable inherited-context block. */
type DevelopmentTaskContextBlockId = Branded<'DevelopmentTaskContextBlockId'>
```

```ts type-equiv
/** Opaque identity that scopes one Agent session's selected Task. */
type DevelopmentTaskBindingId = Branded<'DevelopmentTaskBindingId'>
```

```ts type-equiv
/** Identity of one independently authorized peer contribution. */
type DevelopmentTaskContributionGrantId = Branded<'DevelopmentTaskContributionGrantId'>
```

```ts type-equiv
/** Immutable generation of an owner-issued contribution grant. */
type DevelopmentTaskContributionGeneration = Branded<'DevelopmentTaskContributionGeneration'>
```

```ts type-equiv
/** Sender-owned identity of one local capture binding. */
type DevelopmentTaskCaptureId = Branded<'DevelopmentTaskCaptureId'>
```

```ts type-equiv
/** Sender-owned generation that cannot be reused after local capture ends. */
type DevelopmentTaskCaptureGeneration = Branded<'DevelopmentTaskCaptureGeneration'>
```

```ts type-equiv
/** Immutable source permission without local filesystem roots or session identifiers. */
type DevelopmentTaskContributionSource = DevelopmentTaskOpenApiContributionSource
  | DevelopmentTaskToolObservationSource | DevelopmentTaskRecordedToolObservationSource
  | DevelopmentTaskCompletedFileToolObservationSource | DevelopmentTaskCommandToolObservationSource
```

```ts type-equiv
/** Owner authorization for one peer, capture generation, and exact source permission. */
interface DevelopmentTaskPeerContributionGrant {
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
```

```ts type-equiv
/** Original owner commit; transport peer identity differs from the Task event's node identity. */
interface DevelopmentTaskPeerContributionReceipt {
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
```

```ts type-equiv
/** Permanent reason why this grant no longer provides current evidence. */
type DevelopmentTaskContributionEndReason = 'left' | 'revoked' | 'expired'
```

```ts type-equiv
/** Authority reconstructed from Task events; ended grants never reopen. */
type DevelopmentTaskPeerContribution = { readonly grant: DevelopmentTaskPeerContributionGrant } & (
  | { readonly state: 'active'; readonly openReceipt: DevelopmentTaskPeerContributionReceipt }
  | {
    readonly state: 'ended'
    readonly reason: DevelopmentTaskContributionEndReason
    readonly openReceipt?: DevelopmentTaskPeerContributionReceipt
    readonly endReceipt: DevelopmentTaskPeerContributionReceipt
  }
)
```

```ts type-equiv
/** Exact outbox sample; the owner supplies source attribution and canonical publication text. */
interface DevelopmentTaskPeerContributionRequest {
  readonly grant: DevelopmentTaskPeerContributionGrant
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly result: Exclude<DevelopmentTaskOpenApiObservationResult, { readonly state: 'revoked' }> | DevelopmentTaskPeerToolObservationResult
}
```

```ts type-equiv
/** Source and owner can end a known grant; only the owner may revoke it. */
interface DevelopmentTaskEndPeerContributionRequest {
  readonly grant: DevelopmentTaskPeerContributionGrant
  readonly reason: 'left' | 'revoked'
}
```

```ts type-equiv
/** OpenAPI evidence attributed to an independent peer instead of a Room participant. */
type DevelopmentTaskPeerOpenApiObservation = Omit<DevelopmentTaskOpenApiObservationIdentity, 'grantId'> &
  DevelopmentTaskOpenApiObservationResult & {
    readonly grantId: DevelopmentTaskContributionGrantId
    readonly observerPeerId: ScopePeerId
    readonly sourceId: DevelopmentTaskObservedSourceId
    readonly capture: { readonly id: DevelopmentTaskCaptureId; readonly generation: DevelopmentTaskCaptureGeneration }
  }
```

```ts type-equiv
/** Owner-stamped peer provenance; ended appears only on the canonical terminal notice. */
interface DevelopmentTaskPeerContributionMetadata {
  readonly version: 1
  readonly grant: DevelopmentTaskPeerContributionGrant
  readonly ended?: DevelopmentTaskContributionEndReason
}
```

```ts type-equiv
/** Receipt for one original sample commit, including its complete payload identity. */
interface DevelopmentTaskPeerContributionAdmissionReceipt extends DevelopmentTaskPeerContributionReceipt {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly payloadDigest: string
  readonly publicationId: string
}
```

```ts type-equiv
/** Bounded admission response derived from the original publication event. */
interface DevelopmentTaskPeerContributionResult {
  readonly outcome: 'published' | 'reused'
  readonly publication: DevelopmentTaskContextPublication
  readonly receipt: DevelopmentTaskPeerContributionAdmissionReceipt
}
```

```ts type-equiv
/** Immutable reference to one parent Task revision. */
interface DevelopmentTaskParentRef {
  readonly taskId: DevelopmentTaskId
  readonly revision: number
}
```

```ts type-equiv
/** Creation relation for one immutable Task DAG node. */
type DevelopmentTaskOrigin =
  | { readonly kind: 'root' }
  | { readonly kind: 'fork'; readonly parent: DevelopmentTaskParentRef }
  | { readonly kind: 'merge'; readonly parents: readonly DevelopmentTaskParentRef[] }
```

```ts type-equiv
/** Frozen parent context retained by a Fork or Merge. */
interface DevelopmentTaskInheritedSource {
  readonly parent: DevelopmentTaskParentRef
  readonly objective: string
  readonly scope: string
  readonly context: readonly DevelopmentTaskContextPublication[]
}
```

```ts type-equiv
/** Content-addressed inherited context committed before its child Task event. */
interface DevelopmentTaskContextBlock {
  readonly id: DevelopmentTaskContextBlockId
  readonly createdAt: number
  readonly sources: readonly DevelopmentTaskInheritedSource[]
}
```

```ts type-equiv
/** One append-only change used to replicate and rebuild Task context. */
type DevelopmentTaskLogChange =
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
```

```ts type-equiv
/** One durable Task event; `seq` is monotonic per authoring node. */
interface DevelopmentTaskLogEntry {
  readonly nodeId: DevelopmentNodeId
  readonly seq: number
  readonly at: number
  readonly taskId: DevelopmentTaskId
  readonly revision: number
  readonly hiddenRoomId: DevelopmentRoomId
  readonly change: DevelopmentTaskLogChange
}
```

```ts type-equiv
/** Current Task projection derived only from its append-only context events. */
interface DevelopmentTaskSnapshot {
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
```

```ts type-equiv
/** Bounded Task list filter. */
interface DevelopmentTaskListRequest {
  /** Include Tasks created by or currently bound to this participant. */
  readonly participantId?: DevelopmentParticipantId
  readonly limit?: number
}
```

```ts type-equiv
/** Exact Task lookup. */
interface DevelopmentTaskGetRequest { readonly taskId: DevelopmentTaskId }
```

```ts type-equiv
/** Bounded lineage neighborhood around one Task. */
interface DevelopmentTaskLineageRequest {
  readonly taskId: DevelopmentTaskId
  readonly ancestorDepth?: number
  readonly descendantDepth?: number
  readonly limit?: number
}
```

```ts type-equiv
/** Task projections and truncated boundary ids for one graph view. */
interface DevelopmentTaskLineageSnapshot {
  readonly tasks: readonly DevelopmentTaskSnapshot[]
  readonly boundaryTaskIds: readonly DevelopmentTaskId[]
}
```

```ts type-equiv
/** Create a Root, Fork, or Merge shared-context Task. */
interface DevelopmentTaskCreateRequest {
  readonly origin: DevelopmentTaskOrigin
  readonly objective: string
  readonly scope: string
  readonly createdBy: DevelopmentParticipantId
  /** Explicit parent context publications omitted from this child's immutable inherited block. */
  readonly excludedContextIds?: readonly string[]
}
```

```ts type-equiv
/** Committed Task and its independently reconciled hidden-Room state. */
interface DevelopmentTaskCreateResult {
  readonly task: DevelopmentTaskSnapshot
  readonly runtime: DevelopmentTaskSnapshot['runtime']
}
```

```ts type-equiv
/** Publish explicit Task context eligible for inheritance. */
interface DevelopmentTaskPublishContextRequest {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  readonly text: string
  readonly uri?: string
}
```

```ts type-equiv
/** Current Task binding for exactly one Agent session. */
interface DevelopmentTaskAssignment {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  readonly taskId: DevelopmentTaskId
  readonly sessionLabel?: string
  readonly assignedAt: number
  readonly acknowledgedRevision?: number
}
```

```ts type-equiv
/** Durable session-binding change authored by the participant's node. */
interface DevelopmentTaskAssignmentLogEntry {
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
```

```ts type-equiv
/** Bind one Agent session to exactly one Task. */
interface DevelopmentTaskCheckoutRequest {
  readonly taskId: DevelopmentTaskId
  readonly participantId: DevelopmentParticipantId
  /** Existing binding to switch, or omitted to create an isolated session binding. */
  readonly bindingId?: DevelopmentTaskBindingId
  readonly sessionLabel?: string
}
```

```ts type-equiv
/** Clear one Agent session's current Task binding. */
interface DevelopmentTaskClearRequest {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  /** Reject a stale leave command after any new checkout on this binding. */
  readonly expectedBindingEpoch?: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}
```

```ts type-equiv
/** Acknowledge that one Agent session received a Task revision. */
interface DevelopmentTaskAcknowledgeRequest {
  readonly bindingId: DevelopmentTaskBindingId
  readonly participantId: DevelopmentParticipantId
  readonly taskId: DevelopmentTaskId
  readonly revision: number
  /** Reject adoption from an abandoned binding interval, including Task A → B → A. */
  readonly expectedBindingEpoch?: { readonly nodeId: DevelopmentNodeId; readonly seq: number }
}
```

```ts type-equiv
/** Bounded model-facing view of one Task and its inherited sources. */
interface DevelopmentTaskContextView {
  readonly task: DevelopmentTaskSnapshot
  readonly inherited?: DevelopmentTaskContextBlock
}
```

```ts type-equiv
/** Independent Room reconciliation status returned after session binding. */
interface DevelopmentTaskCheckoutResult {
  readonly assignment: DevelopmentTaskAssignment
  readonly context: DevelopmentTaskContextView
  readonly runtime: {
    readonly targetJoined: boolean
    readonly previousLeft: boolean
    readonly warnings: readonly string[]
  }
}
```

```ts type-equiv
/** Origin of Task and session-binding events after commit, replication, or restore. */
type DevelopmentTaskEventOrigin =
  | { readonly kind: 'local'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'replica'; readonly nodeId: DevelopmentNodeId }
  | { readonly kind: 'restored'; readonly nodeId: DevelopmentNodeId }
```

```ts type-equiv
/** Authorize local collection for a known session before requesting remote contribution permission. */
interface ClaudeScopePrepareContributionRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  /** Null requires no retained capture; an existing capture requires its exact identity. */
  readonly expectedCapture: ClaudeScopeContributionSelection | null
  readonly roots: readonly string[]
  readonly source: ClaudeScopeContributionSource
}
```

```ts type-equiv
/** Public approval request; local paths, tool content, and external session identifiers are excluded. */
type ClaudeScopeContributionProposal = ScopeContributionProposal
```

```ts type-equiv
/** Exact local capture generation shown when a management action was selected. */
type ClaudeScopeContributionSelection = Pick<ClaudeScopeContributionProposal, 'captureId' | 'captureGeneration'>
```

```ts type-equiv
/** Stop only the capture generation the local user selected, retaining independent receiving. */
interface ClaudeScopeContributionLeaveRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly expectedCapture: ClaudeScopeContributionSelection
  /** Optional replacement address for the identical retained grant; only termination is retried. */
  readonly invitation?: ScopeContributionInvitation
}
```

```ts type-equiv
/** Inspect one observed session without sampling files or checking remote permission. */
interface ClaudeScopeContributionDetailRequest {
  readonly sessionKey: ClaudeScopeSessionKey
}
```

```ts type-equiv
/** Current local capture records; paths remain private to the authenticated source Host. */
interface ClaudeScopeContributionDetail {
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
```

```ts type-equiv
/** Persisted local capture identity to hand to the Task owner for separate approval. */
interface ClaudeScopeContributionPreparation {
  readonly session: ClaudeScopeSessionSummary
  readonly proposal: ClaudeScopeContributionProposal
  /** Versioned, path-free approval request; copying it does not grant publication. */
  readonly proposalText: string
}
```

```ts type-equiv
/** Activate only an invitation matching the session's previously authorized file and capture identity. */
interface ClaudeScopeActivateContributionRequest {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly expectedCapture: ClaudeScopeContributionSelection
  readonly invitation: ScopeContributionInvitation
}
```

```ts type-equiv
/** Open local adapter records shared by serialized capture and revocation operations. */
type ScopeDomain = import('@deepseek-ai/dsh-storage-domain').Domain<typeof claudeScopeDomainSpec>
```

```ts type-equiv
/** Transferable capture selection; local paths, external session identifiers, and tool content are excluded. */
type ScopeContributionProposal = Pick<DevelopmentTaskPeerContributionGrant,
  'contributorPeerId' | 'captureId' | 'captureGeneration' | 'source'>
```

```ts type-equiv
/** Versioned text representations that an authenticated local UI can preview before granting permission. */
type ScopeContributionTransfer =
  | { readonly version: 1; readonly kind: 'openapi-contribution-request' | 'tool-contribution-request'; readonly proposal: ScopeContributionProposal }
  | ScopeContributionInvitation
  | ScopeContributionEntry
```

```ts type-equiv
/** Owner approval of one capture with immutable source, expiry, and sample limits. */
interface ScopeContributionApproveRequest {
  readonly taskId: DevelopmentTaskId
  readonly ownerAddress: string
  readonly proposal: ScopeContributionProposal
  readonly expiresAt: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}
```

```ts type-equiv
/** Page through one Task's persistent grant identities; a refresh starts without a cursor. */
interface ScopeContributionInventoryRequest {
  readonly taskId: DevelopmentTaskId
  readonly afterGrantId?: DevelopmentTaskContributionGrantId
}
```

```ts type-equiv
/** Byte-bounded local authority page; terminal records remain visible and pages are not a frozen snapshot. */
interface ScopeContributionInventory {
  readonly entries: readonly DevelopmentTaskPeerContribution[]
  readonly nextGrantId: DevelopmentTaskContributionGrantId | null
}
```

```ts type-equiv
/** Select a durable grant and confirm the owner's current advertised connection address. */
interface ScopeContributionRecoverRequest {
  readonly taskId: DevelopmentTaskId
  readonly grantId: DevelopmentTaskContributionGrantId
  readonly generation: DevelopmentTaskContributionGeneration
  readonly ownerAddress: string
}
```

```ts type-equiv
/** Original immutable grant with the currently confirmed address and its canonical transferable text. */
interface ScopeContributionApproval {
  readonly invitation: ScopeContributionInvitation
  readonly text: string
}
```

```ts type-equiv
/** Local management errors; callers localize these codes rather than parsing message text. */
type ScopeContributionManagementErrorCode =
  | 'scope-contribution/invalid-text'
  | 'scope-contribution/invalid-permission'
  | 'scope-contribution/source-conflict'
  | 'scope-contribution/grant-ended'
  | 'scope-contribution/stale-selection'
  | 'scope-contribution/capacity'
  | 'scope-contribution/unavailable'
```

```ts type-equiv
/** Separate write invitation; a read invitation cannot be promoted into contribution authority. */
interface ScopeContributionInvitation {
  readonly version: 1
  readonly kind: 'openapi-contribution' | 'tool-contribution'
  readonly ownerAddress: string
  readonly grant: DevelopmentTaskPeerContributionGrant
}
```

```ts type-equiv
/** Exact producer-owned sample, retained before transmission and reused without rebuilding it. */
type ScopeContributionSample = Omit<
  DevelopmentTaskPeerContributionRequest, 'grant'
>
```

```ts type-equiv
/** Authenticated owner refusal or temporary failure, containing no Task metadata. */
type ScopeContributionFailure = { readonly status: 'denied' | 'capacity' | 'unavailable' }
```

```ts type-equiv
/** Durable terminal contribution interval; evidence is withdrawn but its history remains. */
interface ScopeContributionEnded {
  readonly status: 'ended'
  readonly reason: DevelopmentTaskContributionEndReason
  readonly receipt: DevelopmentTaskPeerContributionReceipt
}
```

```ts type-equiv
/** Online contribution permission, independent of read authorization and local file permission. */
type ScopeContributionStatusResult =
  | { readonly status: 'active'; readonly receipt: DevelopmentTaskPeerContributionReceipt }
  | ScopeContributionEnded | ScopeContributionFailure
```

```ts type-equiv
/** Original durable sample receipt, including after a lost response or interval termination. */
type ScopeContributionSubmitResult =
  | { readonly status: 'accepted' | 'reused'; readonly receipt: DevelopmentTaskPeerContributionResult['receipt'] }
  | ScopeContributionEnded | ScopeContributionFailure
```

```ts type-equiv
/** Ending is confirmed only by an exact durable owner receipt. */
type ScopeContributionEndResult = ScopeContributionEnded | ScopeContributionFailure
```

### Online contribution applications

Single-capture entries retain one authenticated application. A reusable group entry retains independently selected applicants for the same owned Task; closing admission preserves their existing permissions. The source retains local file and automatic-response consent, while the owner controls contribution and reading. The [online approval decision](../../.agents/notes/implemented/architecture/2026-10-03-online-contribution-approval.md) and [group-entry decision](../../.agents/notes/implemented/feature/2026-10-07-reusable-scope-group-entry.md) explain authorization, retained capacity and recovery.

```ts type-equiv
/** Owner-issued application entrance identity; possession grants no Task access. */
type ScopeContributionEntryId = Branded<'ScopeContributionEntryId'>
```

```ts type-equiv
/** Addressed application entry, distinct from read and contribution grants. */
type ScopeSingleContributionEntry = {
  readonly version: 1
  readonly entryId: ScopeContributionEntryId
  readonly taskId: DevelopmentTaskId
  readonly ownerPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly expiresAt: number
} & (
  | { readonly kind: 'openapi-contribution-entry'; readonly sourceKind?: never }
  | { readonly kind: 'contribution-entry'; readonly sourceKind: 'openapi' | 'tool-observations' }
  | { readonly kind: 'scope-join-entry'; readonly sourceKind: 'tool-observations' }
)
```

```ts type-equiv
/** Reusable application entrance; each source receives independently approved grants. */
interface ScopeGroupEntry {
  readonly version: 2
  readonly kind: 'scope-group-entry'
  readonly sourceKind: 'tool-observations'
  readonly entryId: ScopeContributionEntryId
  readonly taskId: DevelopmentTaskId
  readonly ownerPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly expiresAt: number
  /** Retained applicants, including cancelled, rejected, and expired members. */
  readonly maxMembers: number
}
```

```ts type-equiv
/** Owner-assigned durable identity of one exact group applicant. */
type ScopeGroupApplicationId = Branded<'ScopeGroupApplicationId'>
```

```ts type-equiv
/** Explicitly create a reusable entry for one owned Root Task. */
interface ScopeGroupEntryRequest {
  readonly taskId: DevelopmentTaskId
  readonly ownerAddress: string
  readonly expiresAt: number
  readonly maxMembers: number
}
```

```ts type-equiv
/** Shared entry text without any member's permission. */
interface ScopeGroupEntryResult {
  readonly entry: ScopeGroupEntry
  readonly text: string
}
```

```ts type-equiv
/** Closing an entry blocks new applicants while retained applicants keep their independent permissions. */
interface ScopeGroupEntryStatus extends ScopeGroupEntryResult {
  readonly state: 'open' | 'closed' | 'expired'
  readonly applicationCount: number
}
```

```ts type-equiv
/** Select an owner-local reusable entry; closure is irreversible. */
interface ScopeGroupEntrySelection {
  readonly entryId: ScopeContributionEntryId
}
```

```ts type-equiv
/** Stable entry-identity pagination within one owned Task. */
interface ScopeGroupEntriesRequest {
  readonly taskId: DevelopmentTaskId
  readonly afterEntryId?: ScopeContributionEntryId
}
```

```ts type-equiv
/** Complete UTF-8-bounded page of retained reusable entries. */
interface ScopeGroupEntries {
  readonly entries: readonly ScopeGroupEntryStatus[]
  readonly nextEntryId: ScopeContributionEntryId | null
}
```

```ts type-equiv
/** One independently selected applicant; entry text remains common to the group. */
interface ScopeGroupApplication extends ScopeContributionApplication {
  readonly entry: ScopeGroupEntry
  readonly applicationId: ScopeGroupApplicationId
  readonly proposal: ScopeContributionProposal
  readonly result: ScopeContributionApplicationResult
}
```

```ts type-equiv
/** Stable applicant-identity pagination within one reusable entry. */
interface ScopeGroupApplicationsRequest extends ScopeGroupEntrySelection {
  readonly afterApplicationId?: ScopeGroupApplicationId
}
```

```ts type-equiv
/** Complete UTF-8-bounded page; an applicant cursor never selects a different entry. */
interface ScopeGroupApplications {
  readonly entries: readonly ScopeGroupApplication[]
  readonly nextApplicationId: ScopeGroupApplicationId | null
}
```

```ts type-equiv
/** Single-capture entries retain version one; reusable groups require an explicit version-two entry. */
type ScopeContributionEntry = ScopeSingleContributionEntry | ScopeGroupEntry
```

```ts type-equiv
/** Inspect one addressed entry before granting any local collection permission. */
interface ScopeContributionEntryProbeRequest {
  readonly entry: ScopeContributionEntry
}
```

```ts type-equiv
/** A momentary owner observation, not an application, reservation, or authorization. */
interface ScopeContributionEntryProbeResult {
  /** An available group stays ready until full or closed; single-capture claims are claimed and decisions are closed. */
  readonly status: 'ready' | 'claimed' | 'closed' | 'expired' | 'denied' | 'capacity' | 'unavailable'
}
```

```ts type-equiv
/** Source consent ceiling; owner approval may narrow but cannot exceed any field. */
interface ScopeContributionLimits {
  readonly expiresAt: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}
```

```ts type-equiv
/** Exact online application identity; local paths remain in the source adapter. */
interface ScopeContributionApplicationRequest {
  readonly entry: ScopeContributionEntry
  readonly proposal: ScopeContributionProposal
}
```

```ts type-equiv
/** Initial application retains the source's complete limits for retries and approval. */
interface ScopeContributionApplyRequest extends ScopeContributionApplicationRequest {
  readonly limits: ScopeContributionLimits
}
```

```ts type-equiv
/** Online approval is backed by the original Task event, never only an application row. */
type ScopeContributionApplicationResult =
  | { readonly status: 'pending' }
  | {
    readonly status: 'approved'
    readonly invitation: ScopeContributionInvitation
    readonly receipt: DevelopmentTaskPeerContributionReceipt
    readonly readInvitation?: ScopeInvitation
    readonly readState?: 'active' | 'revoked' | 'expired'
  }
  | ({
    readonly invitation: ScopeContributionInvitation
    readonly readInvitation?: ScopeInvitation
    readonly readState?: 'active' | 'revoked' | 'expired'
  } & ScopeContributionEnded)
  | { readonly status: 'rejected' | 'cancelled' | 'expired' | 'denied' | 'capacity' | 'unavailable' }
```

```ts type-equiv
/** Owner-local application observation; terminal records remain available for recovery. */
interface ScopeContributionApplication {
  readonly entry: ScopeContributionEntry
  readonly text: string
  readonly proposal: ScopeContributionProposal | null
  readonly limits: ScopeContributionLimits | null
  readonly result: { readonly status: 'open' } | ScopeContributionApplicationResult
}
```

```ts type-equiv
/** Create one entry for an owned Root Task without granting contribution permission. */
interface ScopeContributionEntryRequest {
  /** Join offers separately approved passive Root Task reading; omission requests contribution only. */
  readonly participation?: 'join' | 'contribution'
  readonly sourceKind: 'openapi' | 'tool-observations'
  readonly taskId: DevelopmentTaskId
  readonly ownerAddress: string
  readonly expiresAt: number
}
```

```ts type-equiv
/** Canonical invitation text is generated by the Host for copying and recovery. */
interface ScopeContributionEntryResult {
  readonly entry: ScopeContributionEntry
  readonly text: string
}
```

```ts type-equiv
/** Byte-bounded application inventory, ordered by retained entry identity. */
interface ScopeContributionApplications {
  readonly entries: readonly ScopeContributionApplication[]
  readonly nextEntryId: ScopeContributionEntryId | null
}
```

```ts type-equiv
/** A cursor selects an existing entry on this Task; refresh starts without one. */
interface ScopeContributionApplicationsRequest {
  readonly taskId: DevelopmentTaskId
  readonly afterEntryId?: ScopeContributionEntryId
}
```

```ts type-equiv
/** Approval names the exact displayed claimant and an equal or narrower permission. */
interface ScopeContributionApplicationApprovalRequest {
  /** Required for a group member and forbidden for a single-capture entry. */
  readonly applicationId?: ScopeGroupApplicationId
  /** Required only for a joint entry; read expiry equals the approved contribution expiry. */
  readonly read?: { readonly responsibility: string }
  readonly entryId: ScopeContributionEntryId
  readonly expectedProposal: ScopeContributionProposal
  readonly limits: ScopeContributionLimits
  readonly ownerAddress: string
}
```

```ts type-equiv
/** Rejection cannot accidentally stop another capture; null selects an unclaimed entry. */
interface ScopeContributionApplicationRejectRequest {
  /** Select only this group member; group entry closure uses closeGroupEntry instead. */
  readonly applicationId?: ScopeGroupApplicationId
  readonly entryId: ScopeContributionEntryId
  readonly expectedProposal: ScopeContributionProposal | null
}
```

```ts type-equiv
/** Reissue the same application entry through a currently advertised owner address. */
interface ScopeContributionEntryRecoverRequest {
  readonly entryId: ScopeContributionEntryId
  readonly ownerAddress: string
}
```

```ts type-equiv
/** Persist local collection permission and consent to activate the matching online approval within these limits. */
interface ClaudeScopeRequestContributionRequest extends ClaudeScopePrepareContributionRequest {
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  /** Required for joint entries; grants passive receiving only at the displayed local read revision. */
  readonly receive?: { readonly expectedReadRevision: number }
}
```

```ts type-equiv
/** Durable online application intent; active grants retain their invitation instead of this waiting state. */
interface ClaudeScopeContributionApplication {
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly state: 'applying' | 'waiting' | 'cancelling' | 'rejected' | 'expired'
}
```

```ts type-equiv
/** One logical OpenAPI source; existing records retain their untagged representation. */
interface DevelopmentTaskOpenApiContributionSource {
  readonly kind?: never
  readonly name: string
  readonly method: 'post' | 'put' | 'patch'
  readonly path: string
}
```

```ts type-equiv
/** Tools approved for observations from a locally permitted collection of files. */
interface DevelopmentTaskToolObservationSource {
  readonly kind: 'tool-observations'
  readonly version?: never
  readonly initialization?: never
  readonly fileContent?: never
  readonly name: string
  readonly tools: readonly ('Write' | 'Edit')[]
}
```

```ts type-equiv
/** Bounded tool report; omitted text is explicit and never establishes current file contents. */
type DevelopmentTaskToolObservationResult = {
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
```

```ts type-equiv
/** Explicit approval for prior recorded observations as well as subsequent live reports. */
type DevelopmentTaskRecordedToolObservationSource = Omit<DevelopmentTaskToolObservationSource, 'version' | 'initialization'> & {
  readonly version: 2
  readonly initialization: 'recorded-local-tools'
}
```

```ts type-equiv
/** Prior recorded tool report; digests identify source evidence without disclosing local Session or directory identifiers. */
type DevelopmentTaskRecordedToolObservationResult = (
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
```

```ts type-equiv
/** Explicit permission to share the LF text produced by future native file operations. */
type DevelopmentTaskCompletedFileToolObservationSource = Omit<DevelopmentTaskToolObservationSource, 'version' | 'fileContent'> & {
  readonly version: 3
  readonly fileContent: 'completed-native-file'
}
```

```ts type-equiv
/** Native completion text is a separate whole-field disclosure from the original tool arguments. */
type DevelopmentTaskCompletedFileToolObservationResult = (
  | Omit<Extract<DevelopmentTaskToolObservationResult, { readonly tool: 'Write' }>, 'version'>
  | Omit<Extract<DevelopmentTaskToolObservationResult, { readonly tool: 'Edit' }>, 'version'>
) & {
  readonly version: 3
  readonly completedFile:
    | { readonly state: 'included'; readonly content: string; readonly sha256: string }
    | { readonly state: 'omitted'; readonly reason: 'tool-failed' | 'budget' | 'unavailable' }
}
```

Command outcomes preserve independent exit, signal, timeout and abort facts. Included output retains the provider’s truncation flag; a sharing-budget omission removes the whole output field. These observations describe a completed execution, not a verification claim about current code.

```ts type-equiv
/** One exact foreground command and its explicitly selected local working-directory root. */
interface DevelopmentTaskCommandSelector {
  readonly command: string
  readonly rootIndex: number
}
```

```ts type-equiv
/** Explicit command-outcome permission, optionally combined with future file observations. */
interface DevelopmentTaskCommandToolObservationSource {
  readonly kind: 'tool-observations'
  readonly version: 4
  readonly name: string
  readonly tools: readonly ('Write' | 'Edit')[]
  readonly commands: readonly DevelopmentTaskCommandSelector[]
  readonly fileContent?: 'completed-native-file'
  readonly initialization?: never
}
```

```ts type-equiv
/** One complete provider-returned output field, or explicit whole-field omission for the sharing budget. */
type DevelopmentTaskCommandOutput =
  | { readonly state: 'included'; readonly text: string; readonly truncated: boolean }
  | { readonly state: 'omitted'; readonly reason: 'budget'; readonly truncated: boolean }
```

```ts type-equiv
/** Foreground execution evidence; a completed report does not assert that current code passes verification. */
type DevelopmentTaskCommandObservationResult = {
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
```

```ts type-equiv
/** Local reports require explicit permission before carrying a native completion's full text. */
type DevelopmentTaskLocalToolObservationResult =
  | DevelopmentTaskToolObservationResult
  | DevelopmentTaskCompletedFileToolObservationResult
  | DevelopmentTaskCommandObservationResult
```

```ts type-equiv
/** Peer reports preserve separate live, recorded-work, and completed-file permissions. */
type DevelopmentTaskPeerToolObservationResult =
  | DevelopmentTaskLocalToolObservationResult
  | DevelopmentTaskRecordedToolObservationResult
```

```ts type-equiv
/** Owner-attributed ordered tool event, distinct from a replaceable OpenAPI artifact sample. */
type DevelopmentTaskPeerToolObservation = DevelopmentTaskPeerToolObservationResult & {
  readonly sourceName: string
  readonly grantId: DevelopmentTaskContributionGrantId
  readonly sequence: number
  readonly observerPeerId: ScopePeerId
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly capture: { readonly id: DevelopmentTaskCaptureId; readonly generation: DevelopmentTaskCaptureGeneration }
}
```

```ts type-equiv
/** Explicit local collection permission; tool reports never authorize transcript or file reads. */
type ClaudeScopeContributionSource = ClaudeScopeOpenApiSource | {
  readonly kind: 'tool-observations'
  readonly tools: readonly ('Write' | 'Edit')[]
}
```

## Owner-local contribution

[The native source consumer](../../packages/collaboration/scope-agent-contribution/README.md) binds explicit file-collection permission to the current local Root Task assignment. The creator adopts other sources through the existing Task receiving path on the next request; stopping collection preserves receiving.

```ts type-equiv
/** Identity of one owner-local capture interval; it is never a transport peer identity. */
type DevelopmentTaskLocalContributionId = Branded<'DevelopmentTaskLocalContributionId'>
```

```ts type-equiv
/** Explicit local tool permission tied to one actual Agent assignment interval. */
interface DevelopmentTaskLocalContributionGrant {
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
```

```ts type-equiv
/** Original owner event for a local capture, including its exact assignment and capture identity. */
interface DevelopmentTaskLocalContributionReceipt {
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
```

```ts type-equiv
/** Local authority reconstructed from durable Task events; terminal intervals never reopen. */
type DevelopmentTaskLocalContribution = { readonly grant: DevelopmentTaskLocalContributionGrant } & (
  | { readonly state: 'active'; readonly openReceipt: DevelopmentTaskLocalContributionReceipt }
  | { readonly state: 'ended'
    readonly reason: DevelopmentTaskContributionEndReason
    readonly openReceipt?: DevelopmentTaskLocalContributionReceipt
    readonly endReceipt: DevelopmentTaskLocalContributionReceipt }
)
```

```ts type-equiv
/** Exact locally retained report; Task generates attribution and publication text. */
interface DevelopmentTaskLocalContributionRequest {
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly result: DevelopmentTaskLocalToolObservationResult
}
```

```ts type-equiv
/** Irreversible local capture withdrawal using its original permission. */
interface DevelopmentTaskEndLocalContributionRequest {
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly reason: 'left' | 'revoked'
}
```

```ts type-equiv
/** Original local sample commit, correlated with every retained payload field. */
interface DevelopmentTaskLocalContributionAdmissionReceipt extends DevelopmentTaskLocalContributionReceipt {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
  readonly payloadDigest: string
  readonly publicationId: string
}
```

```ts type-equiv
/** Exact local admission result without unrelated Task history. */
interface DevelopmentTaskLocalContributionResult {
  readonly outcome: 'published' | 'reused'
  readonly publication: DevelopmentTaskContextPublication
  readonly receipt: DevelopmentTaskLocalContributionAdmissionReceipt
}
```

```ts type-equiv
/** Owner-stamped local permission; terminal notices contain no previous report body. */
interface DevelopmentTaskLocalContributionMetadata {
  readonly version: 1
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly ended?: DevelopmentTaskContributionEndReason
}
```

```ts type-equiv
/** Ordered local tool evidence; source Session execution remains the original execution authority. */
type DevelopmentTaskLocalToolObservation = DevelopmentTaskLocalToolObservationResult & {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly sequence: number
}
```

```ts type-equiv
/** Local Task assignment shown by the Host, including its exact durable epoch. */
type ScopeAgentLocalContributionBinding = Pick<DevelopmentTaskLocalContributionGrant,
  'taskId' | 'bindingId' | 'expectedBindingEpoch'>
```

```ts type-equiv
/** Explicit native file and command sharing permission for the selected Agent's current owner-local Root Task. */
interface ScopeAgentLocalContributionRequest extends ScopeAgentLocalContributionBinding {
  readonly agentId: SessionId
  readonly expectedCapture: ScopeAgentContributionSelection | null
  readonly roots: string[]
  readonly tools: ('write' | 'edit')[]
  /** Exact foreground commands and directory ordinals whose execution results may be shared; absent grants no command sharing. */
  readonly commands?: readonly DevelopmentTaskCommandSelector[]
  /** Explicitly share complete text produced by permitted native tools, including unchanged file contents; absent shares inputs only. */
  readonly fileContent?: 'completed-native-file'
  readonly limits: ScopeContributionLimits
}
```

```ts type-equiv
/** Durable local Task permission, independent of receiving context or authorizing idle work. */
interface ScopeAgentLocalContributionCapture {
  readonly selection: ScopeAgentContributionSelection
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly roots: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly commands?: readonly DevelopmentTaskCommandSelector[]
  readonly state: 'opening' | 'active' | 'ending'
  readonly collecting: boolean
  readonly pendingSamples: number
  readonly issue: 'owner-unavailable' | 'capacity' | 'rejected' | null
  readonly collectionIssue: ScopeAgentContributionCapture['collectionIssue']
}
```

```ts type-equiv
/** Live local assignment and committed source consent; no implicit checkout or collection. */
interface ScopeAgentLocalContributionStatus {
  readonly agentId: SessionId
  readonly participantId: DevelopmentParticipantId | null
  readonly eligibility: 'not-live' | 'eligible' | 'delegated' | 'fork' | 'no-local-task'
  readonly assignment: ScopeAgentLocalContributionBinding | null
  readonly revision: number
  readonly capture: ScopeAgentLocalContributionCapture | null
  readonly initialization: ScopeAgentContributionInitializationSource
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclaudescope--claudescopeservice"></a>

### `ctx.claudeScope` — `ClaudeScopeService`

Local authenticated management and command-hook service; no external Session is fabricated.

```ts cordis-catalog
/**
 * List locally observed main sessions without joining them automatically.
 * @returns local identities and their current explicit Task selection.
 */
@Remote('sessions') async sessions(): Promise<readonly ClaudeScopeSessionSummary[]>

/**
 * Inspect project-local hook configuration without creating files or joining sessions.
 * @param request - the project selected by the local user.
 * @returns verified file state, separate from actual hook execution.
 */
@Remote('projectSetup') projectSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeProjectSetupResult>

/**
 * Install project hooks and the same-home command profile without granting collection.
 * @param request - the existing project explicitly selected by the local user.
 * @returns configuration confirmed on disk, not proof of Claude execution.
 */
@Remote('setup') setup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeSetupResult>

/**
 * Remove this installation's project hooks while retaining the shared profile and grants.
 * @param request - the project whose generated hook entries should be removed.
 * @returns whether project configuration changed; leave separately revokes session grants.
 */
@Remote('removeSetup') removeSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeRemoveSetupResult>

/**
 * Authorize a known main session and create a new Task binding interval.
 * @param request - observed identity, Task, responsibility, roots, and exact Bash allowlist.
 * @returns the committed local session selection.
 */
@Remote('join') join(request: ClaudeScopeJoinRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Read retained local contribution details without sampling, remote verification, or recovery writes.
 * @param request - observed session selected on this authenticated source Host.
 * @returns current summary and original capture request, including private local paths only here.
 */
@Remote('contributionDetail') async contributionDetail(request: ClaudeScopeContributionDetailRequest): Promise<ClaudeScopeContributionDetail>

/**
 * Persist local collection permission without granting remote publication or starting collection.
 * @param request - observed session, expected capture, collection roots, and a typed tool or API source.
 * @returns stable path-free approval text and local session state; recover a lost reply through contributionDetail.
 */
@Remote('prepareContribution') prepareContribution(request: ClaudeScopePrepareContributionRequest): Promise<ClaudeScopeContributionPreparation>

/**
 * Retain local file permission and bounded consent, then reconcile the owner application without blocking other sessions.
 * @param request - exact local selection, owner entry, optional passive joint consent, and accepted automatic-activation limits.
 * @returns committed local intent; session-changed notifications report later waiting, active, or cancellation state.
 */
@Remote('requestContribution') requestContribution(request: ClaudeScopeRequestContributionRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Activate a separately approved owner grant matching the original local capture identity.
 * @param request - observed session, expected capture, and owner invitation; only its address may change after selection.
 * @returns active state or retained inert state when the owner cannot confirm permission.
 */
@Remote('activateContribution') activateContribution(request: ClaudeScopeActivateContributionRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Stop only the selected contribution locally, retaining the independent read subscription.
 * @param request - observed session, exact capture generation, and optional updated address for its identical retained grant.
 * @returns local stop state; withdrawal remains pending until the owner confirms it. Read details after a lost reply.
 */
@Remote('contributionLeave') contributionLeave(request: ClaudeScopeContributionLeaveRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Stop only the contribution and receiving interval created by the selected joint operation.
 * @param request - original joint identity; later manual reading and later captures remain independent.
 * @returns durable local stop state while exact remote cleanup continues in the background.
 */
@Remote('leaveJoint') async leaveJoint(request: ClaudeScopeLeaveJointRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Retain one replacement owner address for both permissions of the original joint operation.
 * @param request - displayed joint and read revision; only an identical lost-response retry bypasses the current revision.
 * @returns committed route intent; background adoption preserves all grant and capture identities.
 */
@Remote('recoverJoint') async recoverJoint(request: ClaudeScopeRecoverJointRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Join a device-bound read invitation without collecting tools or creating a Task replica.
 * @param request - explicitly selected observed session and owner invitation.
 * @returns the persisted receiving interval; hooks revalidate authorization before every projection.
 */
@Remote('receive') receive(request: ClaudeScopeReceiveRequest): Promise<ClaudeScopeSessionSummary>

/**
 * End local receipt of an independently authorized scope.
 * @param request - observed recipient to disconnect.
 * @returns the persisted local stop state.
 */
@Remote('receiveLeave') receiveLeave(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Stop capture and clear the local binding; remote withdrawal remains pending until its owner commits.
 * Already-issued Task admission may commit before this serialized clear.
 * @param request - observed session whose current grant must end.
 * @returns local stop state and any pending remote withdrawal; an unavailable owner does not resume capture.
 */
@Remote('leave') leave(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary>

/**
 * Process one authenticated Hook; projections are prepared output, not model admission.
 * Scope may change after RPC return; a later withdrawal cannot erase Claude history.
 * @param request - current descriptor generation and raw official Hook JSON.
 * @param signal - cancellation of this command request.
 * @returns Hook stdout JSON plus local processing evidence.
 */
@Remote('hook') async hook(request: ClaudeScopeHookRequest, signal: AbortSignal): Promise<ClaudeScopeHookResult>
```

Source: [`packages/collaboration/claude-scope/src/index.ts`](../../packages/collaboration/claude-scope/src/index.ts)

<a id="ctxdevelopmentevidence--developmentevidenceservice"></a>

### `ctx.developmentEvidence` — `DevelopmentEvidenceService`

Service Definition for explicit, source-attributed development evidence retrieval.

```ts cordis-catalog
/**
 * Register one provider for its plugin lifetime.
 * @param provider - unique provider implementation.
 * @returns disposer that unregisters the provider.
 */
registerProvider(provider: DevelopmentEvidenceProvider): () => void

/**
 * Read the current provider directory in deterministic order.
 * @returns detached provider registrations sorted by id.
 */
listProviders(): readonly DevelopmentEvidenceProviderRegistration[]

/**
 * Query every selected provider while preserving empty, denied, and failed outcomes.
 * @param request - query, optional provider allowlist, and optional per-provider limit.
 * @param signal - optional caller cancellation.
 * @returns deterministic provider results with all citation fields bounded.
 */
async query(request: DevelopmentEvidenceQueryRequest, signal?: AbortSignal): Promise<DevelopmentEvidenceQuerySnapshot>
```

Source: [`packages/collaboration/development-evidence/src/index.ts`](../../packages/collaboration/development-evidence/src/index.ts)

<a id="ctxdevelopmentmesh--developmentmeshservice-abstract-seam"></a>

### `ctx.developmentMesh` — `DevelopmentMeshService` (abstract seam)

Provider-neutral registry and transport operations for development channels.

```ts cordis-catalog
/**
 * Register one versioned replication channel.
 * @param name - stable protocol name such as `development-task/v1`.
 * @param channel - heads, delta, receive, and optional command handlers.
 * @returns disposer that removes exactly this registration.
 */
register(name: string, channel: DevelopmentMeshChannel): () => void

/**
 * Read one registered channel for a transport provider.
 * @param name - exact protocol name.
 * @returns registered handler or undefined.
 */
channel(name: string): DevelopmentMeshChannel | undefined

/**
 * Return the current registered protocol names.
 * @returns sorted immutable channel names.
 */
channelNames(): readonly string[]

/**
 * Read safe connection, cluster, and conflict status.
 * @returns current provider and peer status without credential material.
 */
abstract list(): DevelopmentMeshSnapshot

/**
 * Notify peers that one channel has newly committed local state.
 * @param channel - exact registered channel name.
 */
abstract publish(channel: string): void

/**
 * Route one command to its authoritative node.
 * @param ownerNodeId - authenticated destination node.
 * @param channel - exact registered channel name.
 * @param payload - channel-owned wire value.
 * @returns channel-owned response after local or remote execution.
 */
abstract command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown>
```

Source: [`packages/collaboration/development-mesh/src/index.ts`](../../packages/collaboration/development-mesh/src/index.ts)

<a id="ctxdevelopmentroomcontexts--developmentroomcontextservice"></a>

### `ctx.developmentRoomContexts` — `DevelopmentRoomContextService`

Append-only room context plus request-time selection for live Agent members.

```ts cordis-catalog
/**
 * Read the complete append-only context log.
 * @returns detached entries in append order.
 */
@Remote('list') list(): DevelopmentRoomContextSnapshot

/**
 * Read the complete append-only context log for persistence and composition.
 * @returns immutable entries in append order.
 */
log(): readonly DevelopmentRoomContextEntry[]

/**
 * Append one current room member's explicit text publication.
 * @param request - room, publisher, and bounded plain text.
 * @returns committed immutable entry.
 */
@Remote('share') share(request: DevelopmentRoomContextShareRequest): Promise<DevelopmentRoomContextEntry>

/**
 * Restore locally authored entries without writing them again.
 * Existing positions must be byte-equivalent and restore never overwrites divergence.
 * @param entries - validated durable log whose entries originate on this node.
 */
restoreLocalLog(entries: readonly DevelopmentRoomContextEntry[]): void
```

Source: [`packages/collaboration/development-room-context/src/index.ts`](../../packages/collaboration/development-room-context/src/index.ts)

<a id="ctxdevelopmentroommesh--developmentroommeshservice"></a>

### `ctx.developmentRoomMesh` — `DevelopmentRoomMeshService`

Replicate Room events/presence and route hidden membership changes.

```ts cordis-catalog
/**
 * Join through the Room creation node.
 * @param request - hidden Room and participant identity.
 */
async join(request: DevelopmentRoomJoinRequest): Promise<void>

/**
 * Leave through the Room creation node.
 * @param request - hidden Room and participant identity.
 */
async leave(request: DevelopmentRoomLeaveRequest): Promise<void>
```

Source: [`packages/collaboration/development-room-mesh/src/index.ts`](../../packages/collaboration/development-room-mesh/src/index.ts)

<a id="ctxdevelopmentrooms--developmentroomservice"></a>

### `ctx.developmentRooms` — `DevelopmentRoomService`

Host service for room links, their append-only log, and transient collaborator presence.

```ts cordis-catalog
/**
 * Read the roster and every discoverable room.
 * @returns detached projections at the current lease time.
 */
@Remote('list') list(): DevelopmentRoomDirectorySnapshot

/**
 * Read the complete append-only room log in local append order.
 * @returns immutable entries; callers cannot mutate retained state.
 */
log(): readonly DevelopmentRoomLogEntry[]

/**
 * Announce or update one participant and renew its online lease.
 * @param request - stable identity, participant kind, and display name.
 * @returns directory snapshot after the announcement.
 */
@Remote('announce') announce(request: DevelopmentParticipantAnnounceRequest): Promise<DevelopmentRoomDirectorySnapshot>

/**
 * Renew one participant lease.
 * @param request - participant identity whose lease is renewed.
 * @returns directory snapshot after the lease update.
 */
@Remote('heartbeat') heartbeat(request: DevelopmentParticipantHeartbeatRequest): Promise<DevelopmentRoomDirectorySnapshot>

/**
 * End one participant's online lease.
 * @param request - participant identity whose retained profile becomes offline.
 * @returns directory snapshot after the lease ends.
 */
@Remote('withdraw') withdraw(request: DevelopmentParticipantWithdrawRequest): Promise<DevelopmentRoomDirectorySnapshot>

/**
 * Create one discoverable collaboration topic with no implicit member.
 * @param request - bounded room topic.
 * @returns room projection after the creation entry commits.
 */
@Remote('create') create(request: DevelopmentRoomCreateRequest): Promise<DevelopmentRoomSnapshot>

/**
 * Idempotently materialize an internally owned room with a deterministic identity.
 * An existing room must have the same creation node and objective.
 * @param request - deterministic room identity and bounded internal topic.
 * @returns the existing or newly committed room projection.
 */
ensure(request: DevelopmentRoomEnsureRequest): Promise<DevelopmentRoomSnapshot>

/**
 * Add one announced participant to a room.
 * @param request - room and participant identities.
 * @returns room projection after the append, or the current projection when already joined.
 */
@Remote('join') join(request: DevelopmentRoomJoinRequest): Promise<DevelopmentRoomSnapshot>

/**
 * Leave one room without changing the participant's global online lease.
 * @param request - room and current participant identities.
 * @returns room projection after the append, or the current projection when already absent.
 */
@Remote('leave') leave(request: DevelopmentRoomLeaveRequest): Promise<DevelopmentRoomSnapshot>

/**
 * Restore locally authored entries in sequence without writing them again.
 * Existing entries must be byte-equivalent; restore never overwrites divergence.
 * @param entries - validated durable log whose entries all originate on this node.
 */
restoreLocalLog(entries: readonly DevelopmentRoomLogEntry[]): void

/**
 * Accept one peer's current participant lease.
 * @param snapshot - validated participant profile from the peer.
 * @param sourceNodeId - configured peer identity, which must match the profile node.
 * @returns current local lease projection after acceptance.
 */
acceptPresenceReplica( snapshot: DevelopmentParticipantSnapshot, sourceNodeId: DevelopmentNodeId, ): Promise<DevelopmentParticipantSnapshot>

/**
 * Append one configured peer's room-log entry idempotently.
 * @param candidate - wire-validated immutable room-link entry.
 * @param sourceNodeId - configured peer identity, which must originate the entry.
 * @returns current projection of the entry's room.
 */
acceptLogReplica( candidate: DevelopmentRoomLogEntry, sourceNodeId: DevelopmentNodeId, ): Promise<DevelopmentRoomSnapshot>
```

Source: [`packages/collaboration/development-room/src/index.ts`](../../packages/collaboration/development-room/src/index.ts)

<a id="ctxdevelopmentroomstorageready--developmentroomstorageready"></a>

### `ctx.developmentRoomStorageReady` — `DevelopmentRoomStorageReady`

Startup barrier published only after the local Room log and persistence listener are ready.

Source: [`packages/collaboration/development-room-storage-domain/src/index.ts`](../../packages/collaboration/development-room-storage-domain/src/index.ts)

<a id="ctxdevelopmenttaskassignments--developmenttaskassignmentremoteservice"></a>

### `ctx.developmentTaskAssignments` — `DevelopmentTaskAssignmentRemoteService`

Typed Remote facade that keeps assignment endpoints separate from Task projections.

```ts cordis-catalog
/**
 * Read the authoritative Agent-session Task bindings.
 * @returns all current bindings ordered by participant and binding identity.
 */
@Remote('list') list(): readonly DevelopmentTaskAssignment[]

/**
 * Commit one Agent session's Task before best-effort Room reconciliation.
 * @param request - target Task, local online Agent, and optional binding identity.
 * @returns assignment, context, and independent Room outcomes.
 */
@Remote('checkout') checkout(request: DevelopmentTaskCheckoutRequest): Promise<DevelopmentTaskCheckoutResult>

/**
 * Clear one Agent session's Task binding.
 * @param request - binding and owning Agent participant.
 * @returns resolution after durable assignment commit.
 */
@Remote('clear') clear(request: DevelopmentTaskClearRequest): Promise<void>

/**
 * Record context delivery for one Agent-session binding.
 * @param request - binding, Agent, Task, and delivered revision.
 * @returns updated assignment.
 */
@Remote('acknowledge') acknowledge(request: DevelopmentTaskAcknowledgeRequest): Promise<DevelopmentTaskAssignment>
```

Source: [`packages/collaboration/development-task/src/index.ts`](../../packages/collaboration/development-task/src/index.ts)

<a id="ctxdevelopmenttaskcontextadmission--developmenttaskcontextadmissioncapability"></a>

### `ctx.developmentTaskContextAdmission` — `DevelopmentTaskContextAdmissionCapability`

Live Task injector instance; unloading permanently aborts its signal and removes the service.

Source: [`packages/collaboration/development-task-context/src/admission.ts`](../../packages/collaboration/development-task-context/src/admission.ts)

<a id="ctxdevelopmenttaskcontextbackend--developmenttaskcontextbackend-abstract-seam"></a>

### `ctx.developmentTaskContextBackend` — `DevelopmentTaskContextBackend` (abstract seam)

Computes context without changing Task bindings, recipient Session history, or delivery state. A provider may retain its own audit log.

```ts cordis-catalog
/**
 * Produce bounded text, exact source coverage, and a scheduling comparison for one captured Task revision.
 * @param input - immutable authorized source view, recipient routing, complete text budget, and cancellation.
 * @returns exact text and activation evidence; comparisons never authorize delivery or replace coverage.
 * Throws when mandatory context cannot fit or computation fails.
 */
abstract compute(input: DevelopmentTaskContextInput): Promise<DevelopmentTaskContextProjection>
```

Source: [`packages/collaboration/development-task-context/src/backend.ts`](../../packages/collaboration/development-task-context/src/backend.ts)

<a id="ctxdevelopmenttaskmesh--developmenttaskmeshservice"></a>

### `ctx.developmentTaskMesh` — `DevelopmentTaskMeshService`

Replicate Task state and route mutations to each Task owner.

```ts cordis-catalog
/**
 * Route one Task mutation to its authoritative owner.
 * @param ownerNodeId - node that authored the Task creation event.
 * @param command - Task mutation and validated request.
 * @returns the command-specific owner result after its required durable commit.
 */
async route<C extends DevelopmentTaskOwnerCommand>( ownerNodeId: DevelopmentNodeId, command: C, ): Promise<DevelopmentTaskOwnerCommandResult<C>>
```

Source: [`packages/collaboration/development-task-mesh/src/index.ts`](../../packages/collaboration/development-task-mesh/src/index.ts)

<a id="ctxdevelopmenttasks--developmenttaskservice"></a>

### `ctx.developmentTasks` — `DevelopmentTaskService`

Host service for immutable Task lineage, shared context, and Agent-session bindings.

```ts cordis-catalog
/**
 * Read bounded current Task projections ordered by recent activity.
 * @param request - optional participant filter plus result limit.
 * @returns detached Task projections.
 */
@Remote('list') list(request: DevelopmentTaskListRequest): readonly DevelopmentTaskSnapshot[]

/**
 * Read one current Task projection.
 * @param request - exact Task identity.
 * @returns detached current projection.
 */
@Remote('get') get(request: DevelopmentTaskGetRequest): DevelopmentTaskSnapshot

/**
 * Read a bounded ancestor and descendant neighborhood.
 * @param request - focus Task, depths, and total result limit.
 * @returns graph Tasks and ids omitted at the requested boundary.
 */
@Remote('lineage') lineage(request: DevelopmentTaskLineageRequest): DevelopmentTaskLineageSnapshot

/**
 * Create one Root, Fork, or Merge Task and then materialize its hidden Room.
 * @param request - immutable parent relation and the new Task's context fields.
 * @returns committed Task; `runtime` is degraded when Room reconciliation fails.
 */
create(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskSnapshot>

/**
 * Create one Task through Remote and report hidden-Room materialization separately.
 * @param request - immutable parent relation and the new Task's context fields.
 * @returns committed Task and runtime state.
 */
@Remote('create') async createRemote(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskCreateResult>

/**
 * Publish explicit context that may be inherited by later Tasks.
 * @param request - Task, assigned participant, text, and optional artifact URI.
 * @returns updated Task projection.
 */
@Remote('publishContext') publishContext(request: DevelopmentTaskPublishContextRequest): Promise<DevelopmentTaskSnapshot>

/**
 * Approve one exact remote binding on its Task owner; Mesh membership alone grants no observation interval.
 * This approval attests the named source identity, not a read of its private files or its current assignment replica.
 * @param request - remote Agent identity and binding epoch explicitly selected by the local owner.
 * @returns original approval or a newly committed active interval; ended identities cannot reopen.
 */
@Remote('approveObservedInterval') approveObservedInterval(request: DevelopmentTaskApproveObservedIntervalRequest): Promise<DevelopmentTaskObservedInterval>

/**
 * Read authoritative observation approvals and terminal receipts, including on a remote Task owner.
 * @param request - Task whose source intervals are requested.
 * @returns committed intervals; the trusted Mesh still exposes all Task context to its members.
 */
@Remote('observedIntervals') async observedIntervals(request: DevelopmentTaskGetRequest): Promise<readonly DevelopmentTaskObservedInterval[]>

/**
 * List replicated remote Agent bindings that the local Task owner may explicitly approve.
 * A candidate identifies a binding, not a verified Claude request or private-file permission.
 * @param request - locally owned Task whose current remote assignments are inspected.
 * @returns source identities with their replicated session labels; replication can delay discovery.
 */
@Remote('observedCandidates') observedCandidates(request: DevelopmentTaskGetRequest): readonly DevelopmentTaskObservedCandidate[]

/**
 * Route a filtered local observation to the remote Task owner using the current Host's Mesh identity.
 * The caller checks local capture authorization and binding currency; the owner checks its approved interval.
 * @param request - exact approved interval, source digest, and locally authorized content.
 * @returns the publication and receipt of its original durable owner admission.
 */
async admitObservedRemote( request: DevelopmentTaskAdmitRemoteObservedContextRequest, ): Promise<DevelopmentTaskAdmitRemoteObservedContextResult>

/**
 * Admit a Mesh observation using transport-owned identity; this Host method exposes no Remote endpoint.
 * @param request - wire-validated observation and owner approval reference.
 * @param sourceNodeId - peer supplied by the Mesh dispatcher, never by the request JSON.
 * @returns the original durable receipt for a matching retry, including after interval termination.
 */
acceptObservedRemote( request: DevelopmentTaskAdmitRemoteObservedContextRequest, sourceNodeId: DevelopmentNodeId, ): Promise<DevelopmentTaskAdmitRemoteObservedContextResult>

/**
 * End one source interval on its owner, including before an approval arrives.
 * @param request - complete source identity retained before local capture stops.
 * @returns receipt for the original terminal owner event; transport failure does not prove rejection.
 */
@Remote('endObservedInterval') async endObservedInterval(request: DevelopmentTaskEndObservedIntervalRequest): Promise<DevelopmentTaskObservedReceipt>

/**
 * Persist one terminal interval transition and its derived withdrawals using transport-owned source identity.
 * @param request - exact interval identity; a source may end it before the owner approves it.
 * @param sourceNodeId - authenticated source peer or the local Task owner.
 * @returns stable terminal receipt after persistence; late samples cannot reopen this identity.
 */
acceptObservedIntervalEnd( request: DevelopmentTaskEndObservedIntervalRequest, sourceNodeId: DevelopmentNodeId, ): Promise<DevelopmentTaskObservedReceipt>

/**
 * Open explicitly authorized tool collection for one current owner-local Agent assignment.
 * @param grant - exact capture, binding epoch, tools, and finite limits retained by the source adapter.
 * @returns original durable local authority; ended captures cannot reopen.
 */
openLocalContribution(grant: DevelopmentTaskLocalContributionGrant): Promise<DevelopmentTaskLocalContribution>

/**
 * Inspect original local capture authority after committing due expiry or binding withdrawal.
 * @param request - exact original local capture permission.
 * @returns current durable authority, never a replacement capture.
 */
localContributionStatus(request: { readonly grant: DevelopmentTaskLocalContributionGrant }): Promise<DevelopmentTaskLocalContribution>

/**
 * Admit one persisted report for an explicitly authorized local capture.
 * @param request - original structured outbox sample; Task generates text and attribution.
 * @returns its original commit for exact retries, including after termination.
 */
admitLocalContribution(request: DevelopmentTaskLocalContributionRequest): Promise<DevelopmentTaskLocalContributionResult>

/**
 * Permanently withdraw a local capture without requiring a live or still-bound source Agent.
 * @param request - original grant and explicit terminal reason; unknown captures receive a tombstone.
 * @returns original durable end receipt; no pending approval can reopen the same capture.
 */
endLocalContribution(request: DevelopmentTaskEndLocalContributionRequest): Promise<DevelopmentTaskLocalContributionReceipt>

/**
 * Approve one independent peer's exact capture and source on a local Root Task.
 * @param grant - immutable authorization supplied by the authenticated local owner facade.
 * @returns original durable approval; a terminal grant or capture generation cannot reopen.
 */
openPeerContribution(grant: DevelopmentTaskPeerContributionGrant): Promise<DevelopmentTaskPeerContribution>

/**
 * Inspect local owner contribution authority without implying current online peer authorization.
 * @param request - optional local Root Task; omitted selects only locally owned Tasks.
 * @returns immutable authority derived from Task commits; callers reconcile expiry before use.
 */
peerContributions(request: { readonly taskId?: DevelopmentTaskId }): readonly DevelopmentTaskPeerContribution[]

/**
 * End all due local contribution grants through the same queue as admission.
 * @param request - optional locally owned Task of any origin; omitted never mutates Mesh replicas.
 * @returns after every due terminal event is durable; read consumers await this before projection.
 */
expirePeerContributions(request: { readonly taskId?: DevelopmentTaskId }): Promise<void>

/**
 * Accept one exact sample from an authenticated contributor without Room membership.
 * @param request - persisted outbox sample; text and provenance remain owner-controlled.
 * @param authenticatedPeerId - transport-owned peer identity, never a JSON assertion.
 * @returns original receipt for identical retries, including after termination; new terminal samples fail.
 */
admitPeerContribution( request: DevelopmentTaskPeerContributionRequest, authenticatedPeerId: ScopePeerId, ): Promise<DevelopmentTaskPeerContributionResult>

/**
 * End source evidence, including a delayed approval identified by its complete grant.
 * @param request - exact grant; only its owner may revoke, while its contributor may leave.
 * @param authenticatedPeerId - local owner identity or transport-authenticated source.
 * @returns original terminal receipt; repeated termination does not advance Task revision.
 */
endPeerContribution( request: DevelopmentTaskEndPeerContributionRequest, authenticatedPeerId: ScopePeerId, ): Promise<DevelopmentTaskPeerContributionReceipt>

/**
 * Admit a caller-authorized observation for a still-current local binding.
 * The serialized operation checks ownership and binding before looking up prior admission.
 * Callers own capture permission and source identity; this Host method exposes no Remote endpoint.
 * @param request - local Task, Agent binding interval, source digest, filtered text, and optional reader evidence.
 * @returns current Task and the original publication, after persistence for a new source.
 * @throws for a nonlocal Task, unavailable local Agent, stale binding, invalid digest, conflicting source, or publication limits.
 */
admitObservedContext(request: DevelopmentTaskAdmitObservedContextRequest): Promise<DevelopmentTaskAdmitObservedContextResult>

/**
 * Revoke a previously admitted artifact chain without requiring its Agent to remain online or bound.
 * This Host-only method proves the original publisher, binding interval, artifact, and grant from Task history.
 * @param request - terminal observation and the binding identity used by its earlier samples.
 * @returns original or newly persisted revocation publication.
 * @throws when the chain is absent, mismatched, already ended by another source, or cannot fit its reserved event.
 */
revokeObservedArtifact(request: DevelopmentTaskRevokeObservedArtifactRequest): Promise<DevelopmentTaskAdmitObservedContextResult>

/**
 * Read all current Agent assignments.
 * @returns detached assignments ordered by participant identity.
 */
assignmentList(): readonly DevelopmentTaskAssignment[]

/**
 * Bind one local online Agent session to a Task, then reconcile Rooms.
 * @param request - target Task, Agent participant, and optional existing session binding.
 * @returns committed session binding, Task context, and independent Room outcomes.
 */
checkout(request: DevelopmentTaskCheckoutRequest): Promise<DevelopmentTaskCheckoutResult>

/**
 * Clear one local Agent session's Task binding.
 * @param request - binding identity, owning Agent participant, and optional exact checkout epoch.
 * @returns resolution after binding commit and best-effort Room leave.
 */
clear(request: DevelopmentTaskClearRequest): Promise<void>

/**
 * Record that one Agent session received a specific Task revision.
 * @param request - binding, Agent, Task, and delivered revision.
 * @returns updated session binding.
 */
acknowledge(request: DevelopmentTaskAcknowledgeRequest): Promise<DevelopmentTaskAssignment>

/**
 * Capture context only after local peer expiry is durable, without changing frozen inherited history.
 * @param taskId - local Task or a replica containing no active direct peer evidence.
 * @returns a detached context view captured in the owner-operation queue.
 * @throws RUNTIME_UNAVAILABLE for active direct peer evidence in a nonowner replica; its owner must authorize the read.
 */
currentContextView(taskId: DevelopmentTaskId): Promise<DevelopmentTaskContextView>

/**
 * Capture the stored Task snapshot and frozen inherited block without checking current authorization.
 * @param taskId - exact Task identity.
 * @returns detached stored context; model consumers use currentContextView for current peer evidence.
 */
contextView(taskId: DevelopmentTaskId): DevelopmentTaskContextView

/**
 * Inspect stored context for one Task through the authenticated local Remote.
 * @param request - exact Task identity.
 * @returns stored Task plus its immutable inherited block; this is not a current peer authorization check.
 */
@Remote('context') context(request: DevelopmentTaskGetRequest): DevelopmentTaskContextView

/**
 * Read the complete Task event set for storage and Mesh replication.
 * @returns immutable entries in local acceptance order.
 */
log(): readonly DevelopmentTaskLogEntry[]

/**
 * Read the complete assignment event set for storage and Mesh replication.
 * @returns immutable entries in local acceptance order.
 */
assignmentLog(): readonly DevelopmentTaskAssignmentLogEntry[]

/**
 * Read all immutable context blocks for storage and Mesh replication.
 * @returns detached content-addressed blocks.
 */
blocks(): readonly DevelopmentTaskContextBlock[]

/**
 * Restore context blocks before events that may reference them.
 * @param blocks - durable blocks whose digest must match their identity.
 */
restoreContextBlocks(blocks: readonly DevelopmentTaskContextBlock[]): void

/**
 * Restore a durable mixed-origin Task log without rewriting it.
 * Parent dependencies are resolved before child events.
 * Configured capacity must retain every local live artifact grant's revocation reservation.
 * @param candidates - validated persisted events.
 */
restoreLog(candidates: readonly DevelopmentTaskLogEntry[]): void

/**
 * Restore durable assignment events without rewriting them.
 * @param entries - validated assignment events.
 */
restoreAssignmentLog(entries: readonly DevelopmentTaskAssignmentLogEntry[]): void

/**
 * Persist and accept one authenticated peer context block idempotently.
 * @param block - wire-validated content-addressed block.
 * @returns resolution after durable acceptance.
 */
async acceptContextReplica(block: DevelopmentTaskContextBlock): Promise<void>

/**
 * Persist and append one authenticated peer Task event.
 * @param candidate - wire-validated event.
 * @param sourceNodeId - authenticated peer identity.
 * @returns current Task projection.
 */
acceptLogReplica(candidate: DevelopmentTaskLogEntry, sourceNodeId: DevelopmentNodeId): Promise<DevelopmentTaskSnapshot>

/**
 * Persist and append one authenticated peer assignment event.
 * @param candidate - wire-validated assignment event.
 * @param sourceNodeId - authenticated participant-home node.
 * @returns current assignment or undefined after clear.
 */
acceptAssignmentReplica( candidate: DevelopmentTaskAssignmentLogEntry, sourceNodeId: DevelopmentNodeId, ): Promise<DevelopmentTaskAssignment | undefined>

/**
 * Ensure hidden Rooms exist for every locally owned restored Task.
 * @returns resolution after all independent reconciliations settle.
 */
async reconcileAllRooms(): Promise<void>
```

Source: [`packages/collaboration/development-task/src/index.ts`](../../packages/collaboration/development-task/src/index.ts)

<a id="ctxscopeaccess--scopeaccessservice"></a>

### `ctx.scopeAccess` — `ScopeAccessService`

Local management and peer reads share durable authority, without exposing Task replicas.

```ts cordis-catalog
/**
 * Read the public identity used for recipient-pinned invitations.
 * @returns the local authenticated peer identity and advertised addresses.
 */
@Remote('identity') async identity(): Promise<ScopeAccessIdentity>

/**
 * Issue a read grant for one locally owned Root Task and one peer.
 * @param request - local Task, recipient key, advertised owner address, expiry, and recipient responsibility.
 * @returns invitation after durable authorization; it conveys no write or capture permission.
 */
@Remote('invite') async invite(request: ScopeInviteRequest): Promise<ScopeInvitation>

/**
 * Permanently revoke a grant without waiting for backend computation.
 * @param request - locally issued grant identity.
 * @returns after the revoked tombstone is durable; already transmitted bytes cannot be recalled.
 */
@Remote('revoke') async revoke(request: { readonly grantId: ScopeGrantId }): Promise<void>

/**
 * Retain explicit local receiving intent without claiming remote authorization.
 * @param request - invitation pinned to this Host's transport identity.
 * @returns durable local subscription; retrieve performs online verification on every request.
 */
@Remote('join') async join(request: { readonly invitation: ScopeInvitation }): Promise<ScopeSubscription>

/**
 * Adopt one preallocated receiving identity without reopening any terminal subscription.
 * @param plan - original active subscription plan persisted by the receiving consumer before this call.
 * @returns the exact existing subscription, or the newly persisted one; expiry and terminal states remain terminal.
 */
async ensureSubscription(plan: ScopeSubscription): Promise<ScopeSubscription>

/**
 * Apply a consumer's durable route intent without creating or reopening a subscription.
 * @param plan - unchanged receiver and grant identities plus a monotonic route revision.
 * @returns the retained subscription; terminal and newer route revisions win over delayed retries.
 */
async updateSubscriptionRoute(plan: ScopeSubscription & { readonly routeRevision: number }): Promise<ScopeSubscription>

/**
 * Stop a local subscription and reject its delayed responses.
 * @param request - local receiving identity.
 * @returns after durable local withdrawal, without changing the owner's read grant.
 */
@Remote('leave') async leave(request: { readonly subscriptionId: ScopeSubscriptionId }): Promise<void>

/**
 * Read local authorization and receiving intent for authenticated management.
 * @returns local grants and receiving intents; no remote peer can call this inventory.
 */
@Remote('list') async list(): Promise<ScopeAccessList>

/**
 * Inspect the addressed owner's entry before local collection consent, without applying or granting permission.
 * @param request - complete entry; only its direct address may differ from the owner's retained entry.
 * @returns momentary entry availability, never a reservation; disposal rejects and apply still checks authority.
 */
@Remote('probeContributionEntry') probeContributionEntry(request: ScopeContributionEntryProbeRequest): Promise<ScopeContributionEntryProbeResult>

/**
 * Validate pasted contribution text for authenticated local review without changing permission.
 * @param request - complete versioned proposal or contribution invitation text.
 * @returns exact preview fields; successful parsing does not attest owner approval or local file permission.
 */
@Remote('previewContributionText') previewContributionText(request: { readonly text: string }): Promise<ScopeContributionTransfer>

/**
 * Approve one exact capture on a local Root Task without client-generated authority identities.
 * @param request - capture selection, current advertised address, expiry, and immutable limits.
 * @returns original durable grant on identical retries; changed or terminal captures require a new preparation.
 */
@Remote('approveContribution') approveContribution(request: ScopeContributionApproveRequest): Promise<ScopeContributionApproval>

/**
 * Page through original local grants and durable terminal reasons after reconciling expiry.
 * @param request - local Root Task and optional previously returned grant cursor.
 * @returns a complete-byte-bounded page in grant identity order; no cross-page snapshot is implied.
 */
@Remote('contributionInventory') contributionInventory(request: ScopeContributionInventoryRequest): Promise<ScopeContributionInventory>

/**
 * Recover an original grant using a currently confirmed owner address, including terminal withdrawal retries.
 * @param request - exact inventory grant generation and advertised connection address.
 * @returns original immutable grant and canonical text; terminal grants remain terminal and historical address bytes are not restored.
 */
@Remote('recoverContributionInvitation') recoverContributionInvitation(request: ScopeContributionRecoverRequest): Promise<ScopeContributionApproval>

/**
 * Authorize one independent contributor through the Task owner's durable queue.
 * @param request - retained complete grant and an advertised local owner address; retries reuse the grant identity.
 * @returns the separate write invitation after the owner commit; no read or local file permission is conveyed.
 */
@Remote('inviteContribution') inviteContribution(request: { readonly ownerAddress: string; readonly grant: DevelopmentTaskPeerContributionGrant }) : Promise<ScopeContributionInvitation>

/**
 * Permanently stop one contribution and withdraw its current evidence.
 * @param request - exact locally issued contribution grant.
 * @returns the original durable terminal receipt, including on retry.
 */
@Remote('revokeContribution') revokeContribution(request: { readonly grant: DevelopmentTaskPeerContributionGrant }): Promise<ScopeContributionEndResult>

/** Create one Session's contribution or joint read-and-contribution entry without granting Task access.
 * @param request - owned Root Task, source mode, participation, advertised address, and application deadline.
 * @returns durable entry and canonical copyable text.
 */
@Remote('createContributionEntry') createContributionEntry(request: ScopeContributionEntryRequest): Promise<ScopeContributionEntryResult>

/** Create a reusable target entrance with independent owner approval for each applicant.
 * @param request - owned Task, explicit route, deadline, and retained member limit.
 * @returns version-two entry text after durability; no grant is issued by creation.
 */
@Remote('createGroupEntry') createGroupEntry(request: ScopeGroupEntryRequest): Promise<ScopeGroupEntryResult>

/** List reusable entrances separately from their independent member decisions.
 * @param request - owned Task and optional stable entry cursor.
 * @returns a complete byte-bounded page, including closed and expired entrances.
 */
@Remote('groupEntries') groupEntries(request: ScopeGroupEntriesRequest): Promise<ScopeGroupEntries>

/** List one group's independently retained applicants and reconciled Task grants.
 * @param request - exact entrance and optional applicant cursor belonging to it.
 * @returns a complete byte-bounded page of member decisions.
 */
@Remote('groupApplications') groupApplications(request: ScopeGroupApplicationsRequest): Promise<ScopeGroupApplications>

/** Permanently stop new applicants without revoking members or cancelling existing pending applications.
 * @param request - exact retained reusable entrance.
 * @returns durable closure; pending approval still obeys the original deadline.
 */
@Remote('closeGroupEntry') closeGroupEntry(request: ScopeGroupEntrySelection): Promise<ScopeGroupEntryStatus>

/** Recover an original entry through a current owner address without reopening it.
 * @param request - retained entry and explicitly confirmed advertised address.
 * @returns original entry identity and canonical text with the selected route.
 */
@Remote('recoverContributionEntry') recoverContributionEntry(request: ScopeContributionEntryRecoverRequest): Promise<ScopeContributionEntryResult>

/** Read a bounded page of applications and their original Task authority.
 * @param request - selected local Task and optional retained entry cursor.
 * @returns current observations; pages do not form a frozen snapshot.
 */
@Remote('contributionApplications') contributionApplications(request: ScopeContributionApplicationsRequest): Promise<ScopeContributionApplications>

/** Approve one displayed application within its source's retained consent limits.
 * @param request - entry, exact claimant, contribution limits, separate joint read approval, and owner address.
 * @returns the original immutable Task grant, including after a lost reply.
 */
@Remote('approveContributionApplication') approveContributionApplication(request: ScopeContributionApplicationApprovalRequest): Promise<ScopeContributionApproval>

/** Reject one displayed application and end any grant already created from it.
 * @param request - entry and exact displayed claimant; null selects an unclaimed entry.
 * @returns a terminal observation only after associated Task authority is ended.
 */
@Remote('rejectContributionApplication') rejectContributionApplication(request: ScopeContributionApplicationRejectRequest): Promise<ScopeContributionApplication>

/** Apply through an addressed owner entry without publishing any source evidence.
 * @param request - original entry, exact local capture proposal, and explicit consent limits.
 * @param signal - cancellation of this source operation, not withdrawal of already committed intent.
 * @returns correlated approval or pending, terminal, refusal, and temporary failure states.
 */
applyContribution(request: ScopeContributionApplyRequest, signal: AbortSignal): Promise<ScopeContributionApplicationResult>

/** Retrieve only this authenticated capture's retained application outcome.
 * @param request - original entry and capture proposal; a same-owner route update is permitted.
 * @param signal - cancellation of the current query.
 * @returns original Task authorization or a pending, terminal, or unavailable result.
 */
contributionApplicationStatus(request: ScopeContributionApplicationRequest, signal: AbortSignal) : Promise<ScopeContributionApplicationResult>

/** Cancel an application, retaining intent before ending its contribution and any jointly approved reading.
 * @param request - addressed entry and exact capture, including when its apply reply was lost.
 * @param signal - cancellation of the current attempt; callers retain pending withdrawal until confirmation.
 * @returns terminal confirmation or refusal, capacity, and temporary unavailability.
 */
cancelContributionApplication(request: ScopeContributionApplicationRequest, signal: AbortSignal) : Promise<ScopeContributionApplicationResult>

/**
 * Verify a contribution invitation online before enabling its separately authorized local capture.
 * @param request - distinct contribution invitation pinned to this contributor Host.
 * @param signal - consumer cancellation; unavailable does not prove owner termination.
 * @returns active or terminal owner receipt, refusal, or temporary failure.
 */
contributionStatus(request: { readonly invitation: ScopeContributionInvitation }, signal: AbortSignal) : Promise<ScopeContributionStatusResult>

/**
 * Submit a complete durable sample on its explicit protocol version; recorded history requires separate source permission.
 * @param request - pinned invitation and exact retained outbox sample; callers must not rebuild a retry.
 * @param signal - consumer cancellation; a failed response does not prove that admission failed.
 * @returns a matched original receipt or explicit refusal, terminal, or temporary status.
 */
contribute(request: { readonly invitation: ScopeContributionInvitation; readonly sample: ScopeContributionSample }, signal: AbortSignal): Promise<ScopeContributionSubmitResult>

/**
 * End a contribution through reserved request capacity without modifying any read subscription.
 * @param request - exact invitation whose local capture has already stopped durably.
 * @param signal - consumer cancellation; callers retain pending end until the owner receipt arrives.
 * @returns a matched durable terminal receipt or a failure that does not confirm termination.
 */
endContribution(request: { readonly invitation: ScopeContributionInvitation }, signal: AbortSignal): Promise<ScopeContributionEndResult>

/**
 * Verify current owner authorization and persist exact text before returning it.
 * @param subscriptionId - local receive binding identity; no Task assignment is created.
 * @param signal - consumer cancellation, combined with service disposal and the configured deadline.
 * @returns current projection or an explicit inactive/unknown state; never an offline cached projection.
 */
retrieve(subscriptionId: ScopeSubscriptionId, signal: AbortSignal): Promise<ScopeRetrieveResult>

/**
 * Retrieve freshly authorized text within a consumer-selected allowance, without falling back to a legacy read protocol.
 * @param request - subscription and positive backend text allowance, excluding consumer-owned model framing.
 * @param signal - consumer cancellation, combined with service disposal and the configured deadline.
 * @returns exact persisted projection using the smaller allowance on both Hosts, or explicit inactive/unknown status.
 */
async retrieveWithinBudget(request: ScopeRetrieveWithinBudgetRequest, signal: AbortSignal): Promise<ScopeRetrieveResult>

/**
 * Wait online for a bounded change hint without retrieving facts or occupying the mutation queue.
 * @param subscriptionId - local receiving identity; a new wait cancels its previous wait.
 * @param cursor - opaque previous hint, or undefined for immediate current-state alignment.
 * @param signal - caller cancellation; cancellation and replacement reject without ending the subscription.
 * @returns changed or unchanged with a comparison cursor, or durable terminal/unknown status; hints are not read leases.
 */
waitForChange(subscriptionId: ScopeSubscriptionId, cursor: ScopeChangeCursor | undefined, signal: AbortSignal): Promise<ScopeWaitResult>
```

Source: [`packages/collaboration/scope-access/src/index.ts`](../../packages/collaboration/scope-access/src/index.ts)

<a id="ctxscopeagentcontext--scopeagentcontextservice"></a>

### `ctx.scopeAgentContext` — `ScopeAgentContextService`

Explicit management is local authenticated RPC; remote content never starts work by itself.

```ts cordis-catalog
/**
 * Adopt a source-owned joint read plan once, using only the receiving Session's explicit automatic permission.
 * @param request - live Session, original operation, exact read-state cursor, invitation, and optional local execution policy.
 * @returns the original adopted, ended, or superseded outcome after Session durability.
 */
adoptJoinRead(request: ScopeAgentJoinReadRequest): Promise<ScopeAgentJoinReadResult>

/**
 * Durably cancel an original join, including a cold Session, without ending a later manual binding.
 * @param request - original operation; false preserves an already adopted read, true leaves only its owned binding.
 * @returns retained adoption outcome after local cancellation and owned subscription cleanup.
 */
cancelJoinRead(request: ScopeAgentCancelJoinReadRequest): Promise<ScopeAgentJoinReadResult>

/**
 * Replace the connection address of one existing live read without changing its permission.
 * @param request - exact binding and read-state cursor observed before route consent.
 * @returns unchanged scheduling permission with the durably selected owner address.
 */
@Remote('updateRoute') async updateRoute(request: ScopeAgentUpdateRouteRequest): Promise<ScopeAgentBindingStatus>

/**
 * Recover the route owned by a joint operation, including an existing cold Session.
 * @param request - original adoption and a fixed current read-state comparison.
 * @returns updated only while that operation still owns the unchanged read permission.
 */
updateJoinReadRoute(request: ScopeAgentUpdateJoinReadRouteRequest): Promise<ScopeAgentUpdateRouteResult>

/**
 * Bind one live ordinary Session after stopping its previous automatic activity; unsubmitted user claims are retained.
 * @param request - Session, pinned invitation, and optional explicit automatic policy.
 * @returns persisted local state; binding does not attest a model request or adoption.
 */
@Remote('bind') async bind(request: ScopeAgentBindRequest): Promise<ScopeAgentBindingStatus>

/**
 * Authorize the current owner-local Root Task without changing its assignment or file permissions.
 * @param request - exact Task epoch, observed scheduling binding, and explicit local policy.
 * @returns durable scheduling state with the Session's lifetime reservations retained.
 */
@Remote('bindLocal') async bindLocal(request: ScopeAgentBindLocalRequest): Promise<ScopeAgentBindingStatus>

/**
 * Stop owned automatic work and clear only the selected Task epoch; Task clear terminates its local captures.
 * @param request - exact current Task assignment and observed scheduling binding, including an unbound scheduler.
 * @returns unbound scheduling state after Task clear commits; failure retains a paused binding for reconciliation.
 */
@Remote('leaveLocalTask') async leaveLocalTask(request: ScopeAgentLeaveLocalTaskRequest): Promise<ScopeAgentBindingStatus>

/**
 * Stop the current automatic activity and queued pulses; unsubmitted user claims are returned without replaying sent work.
 * @param request - live Session and its observed binding interval.
 * @returns persisted state; normal user requests retain online scope reads.
 */
@Remote('pause') async pause(request: ScopeAgentBindingRequest): Promise<ScopeAgentBindingStatus>

/**
 * Renew automatic permission after the previous automatic activity settles, retaining reservations and rejecting terminal subscriptions.
 * @param request - exact live binding and replacement absolute policy.
 * @returns persisted scheduling state; local active intent is not a remote authorization check.
 */
@Remote('resume') async resume(request: ScopeAgentResumeRequest): Promise<ScopeAgentBindingStatus>

/**
 * Stop bound automatic work and end its subscription, or discard a stale local binding after its Task is cleared.
 * @param request - live Session and its observed binding interval.
 * @returns unbound remote-only state, or a fresh local interval with retained permission paused and lifetime reservations unchanged.
 */
@Remote('leave') async leave(request: ScopeAgentBindingRequest): Promise<ScopeAgentBindingStatus>

/**
 * Observe live eligibility, exact Session state, recorded context and automatic activity, and local subscription intent.
 * @param request - Session identity; lookup never starts or restores a cold Agent.
 * @returns a consistent projection watermark or not-live; no remote authorization is performed.
 */
@Remote('status') async status(request: { readonly agentId: SessionId }): Promise<ScopeAgentStatusResult>
```

Types: [SessionId](core.md)

Source: [`packages/collaboration/scope-agent-context/src/index.ts`](../../packages/collaboration/scope-agent-context/src/index.ts)

<a id="ctxscopeagentcontributions--scopeagentcontributions"></a>

### `ctx.scopeAgentContributions` — `ScopeAgentContributions`

Actual native execution observations become durable original reports, then the existing owner protocol delivers them.

```ts cordis-catalog
/**
 * Observe local source state without starting an Agent, sampling, or contacting the owner.
 * @param request - exact Session selected by the user.
 * @returns one committed source-domain revision and current live eligibility.
 */
@Remote('status') async status(request: { readonly agentId: SessionId }): Promise<ScopeAgentContributionStatus>

/**
 * Suggest editable file permission from this Session's directory, visible tools, and configured limits.
 * @param request - exact live ordinary Session selected by the user.
 * @returns an uncommitted draft, or null when this deployment provides no defaults; no files or peer are read.
 */
@Remote('permissionDraft') async permissionDraft(request: { readonly agentId: SessionId }): Promise<ScopeAgentContributionPermissionDraft | null>

/**
 * Persist one Session's explicit file and command sharing permission and request automatic activation of an equal or narrower owner approval.
 * @param request - exact capture expectation, owner entry, file and command selections, limits, and optional recorded-local-tool export consent.
 * @returns durable local intent; later changed notifications describe owner reconciliation.
 */
@Remote('request') request(request: ScopeAgentContributionRequest): Promise<ScopeAgentContributionStatus>

/**
 * Persist an explicitly confirmed address for the same contribution without renewing collection permission.
 * Cold Sessions, expired permission, and pending cancellation retain their original state and retry work.
 * @param request - original capture, previously observed address, and the same entry with only its address changed.
 * @returns committed local state; peer confirmation and explicitly selected joint reading recover asynchronously.
 */
@Remote('recoverRoute') recoverRoute(request: ScopeAgentContributionRecoverRouteRequest): Promise<ScopeAgentContributionStatus>

/**
 * Stop only remote collection immediately and retain owner cancellation until it is confirmed; local capture remains active.
 * @param request - exact displayed capture, including for an inactive source Session.
 * @returns durable sharing termination and pending-read cancellation; already adopted reading is retained.
 */
@Remote('stop') stop(request: ScopeAgentContributionStopRequest): Promise<ScopeAgentContributionStatus>

/**
 * End the selected joint contribution and the receiving operation that belongs to the same local consent.
 * @param request - exact displayed joint capture; unrelated or later bindings are retained.
 * @returns durable departure intent or confirmed cleanup; failed cleanup remains retryable.
 */
@Remote('leaveJoin') leaveJoin(request: ScopeAgentContributionStopRequest): Promise<ScopeAgentContributionStatus>

/**
 * Stop only the selected owner-local capture and withdraw its reports from the original Task.
 * @param request - exact displayed local capture, including for an inactive source Session.
 * @returns durable local termination; unrelated remote sharing and receiving remain unchanged.
 */
@Remote('stopLocal') stopLocal(request: ScopeAgentContributionStopRequest): Promise<ScopeAgentLocalContributionStatus>

/**
 * Inspect the live Agent's local Task binding without changing assignment or consent.
 * @param request - existing Session selected by the local user.
 * @returns exact assignment epoch and retained local source permission.
 */
@Remote('localStatus') async localStatus(request: { readonly agentId: SessionId }): Promise<ScopeAgentLocalContributionStatus>

/**
 * Authorize native file and foreground command reports for the selected Agent's current owner-local Root Task.
 * @param request - exact assignment and capture expectations, local roots, file tools, commands, and finite limits.
 * @returns durable opening intent; collection starts only after Task commits the same permission.
 */
@Remote('requestLocal') requestLocal(request: ScopeAgentLocalContributionRequest): Promise<ScopeAgentLocalContributionStatus>
```

Types: [SessionId](core.md)

Source: [`packages/collaboration/scope-agent-contribution/src/index.ts`](../../packages/collaboration/scope-agent-contribution/src/index.ts)

<a id="ctxscopetransport--scopetransport-abstract-seam"></a>

### `ctx.scopeTransport` — `ScopeTransport` (abstract seam)

Transport supplies authenticated identity and cancellation, not application read or write grants.

```ts cordis-catalog
/**
 * Wait for startup and read public connection information.
 * @returns persistent peer identity and direct addresses; rejects after disposal or failed startup.
 */
abstract identity(): Promise<ScopeTransportIdentity>

/**
 * Read the local provider's concurrency and request deadline configuration.
 * @returns local limits so consumers can reserve capacity for ordinary requests; no remote capacity claim.
 */
abstract limits(): ScopeTransportLimits

/**
 * Register one versioned protocol. The consumer must own the returned disposer with ctx.effect.
 * @param protocol - unique negotiated protocol name.
 * @param handler - authorizes each authenticated sender; must settle when its signal aborts.
 * @returns idempotent disposer that rejects new requests and cancels this registration's admitted work.
 */
abstract register(protocol: string, handler: ScopeTransportHandler): () => void

/**
 * Send one bounded JSON request over a fresh stream; transport errors never expose remote handler text.
 * @param target - explicit address containing the expected authenticated peer identity.
 * @param protocol - remote negotiated protocol name.
 * @param payload - lossless JSON value, copied before the first await.
 * @param signal - cancellation for dialing, exchange, and response admission.
 * @returns decoded protocol-owned JSON; rejects on cancellation, timeout, size, connection, or remote failure.
 */
abstract request(target: ScopeTransportTarget, protocol: string, payload: unknown, signal: AbortSignal): Promise<unknown>
```

Source: [`packages/collaboration/scope-transport/src/index.ts`](../../packages/collaboration/scope-transport/src/index.ts)

<a id="claude-scope-events"></a>

### `claude-scope/*` events

<a id="claude-scopesession-changed--emit"></a>

#### `claude-scope/session-changed` — emit

A locally observed session's durable management state changed after commit.

```ts cordis-catalog
/**
 * A locally observed session's durable management state changed after commit.
 * @param sessionKey - local session whose authenticated inventory can be refreshed.
 * @mode emit
 */
'claude-scope/session-changed'(sessionKey: ClaudeScopeSessionKey): void
```

Source: [`packages/collaboration/claude-scope/src/types.ts`](../../packages/collaboration/claude-scope/src/types.ts)

<a id="development-evidence-events"></a>

### `development-evidence/*` events

<a id="development-evidenceprovider-changed--emit"></a>

#### `development-evidence/provider-changed` — emit

One evidence provider entered or left the runtime registry.

```ts cordis-catalog
/**
 * One evidence provider entered or left the runtime registry.
 * @param provider - stable provider identity and display label.
 * @param state - whether the provider is now registered or unregistered.
 * @mode emit
 */
'development-evidence/provider-changed'( provider: DevelopmentEvidenceProviderRegistration, state: 'registered' | 'unregistered', ): void
```

Source: [`packages/collaboration/development-evidence/src/types.ts`](../../packages/collaboration/development-evidence/src/types.ts)

<a id="development-mesh-events"></a>

### `development-mesh/*` events

<a id="development-meshchannel-registered--emit"></a>

#### `development-mesh/channel-registered` — emit

A channel became available for synchronization.

```ts cordis-catalog
/**
 * A channel became available for synchronization.
 * @param name - stable channel protocol name.
 * @mode emit
 */
'development-mesh/channel-registered'(name: string): void
```

Source: [`packages/collaboration/development-mesh/src/types.ts`](../../packages/collaboration/development-mesh/src/types.ts)

<a id="development-meshpeer-changed--emit"></a>

#### `development-mesh/peer-changed` — emit

A known authenticated peer changed connection state.

```ts cordis-catalog
/**
 * A known authenticated peer changed connection state.
 * @param snapshot - detached state without credentials or signatures.
 * @mode emit
 */
'development-mesh/peer-changed'(snapshot: DevelopmentMeshPeerSnapshot): void
```

Source: [`packages/collaboration/development-mesh/src/types.ts`](../../packages/collaboration/development-mesh/src/types.ts)

<a id="development-room-events"></a>

### `development-room/*` events

<a id="development-roomchanged--emit"></a>

#### `development-room/changed` — emit

One room-log entry committed and changed its derived room projection.

```ts cordis-catalog
/**
 * One room-log entry committed and changed its derived room projection.
 * @param snapshot - immutable room projection after the append.
 * @param entry - exact immutable log entry that produced the projection.
 * @param origin - local append, accepted replica source, or durable restore.
 * @mode emit
 */
'development-room/changed'( snapshot: DevelopmentRoomSnapshot, entry: DevelopmentRoomLogEntry, origin: DevelopmentRoomEventOrigin, ): void
```

Source: [`packages/collaboration/development-room/src/types.ts`](../../packages/collaboration/development-room/src/types.ts)

<a id="development-roompersist--parallel"></a>

#### `development-room/persist` — parallel

Persist one locally authored log entry before it becomes observable. A rejecting listener aborts publication; listeners must not mutate the entry.

```ts cordis-catalog
/**
 * Persist one locally authored log entry before it becomes observable.
 * A rejecting listener aborts publication; listeners must not mutate the entry.
 * @param entry - exact next local log entry proposed for append.
 * @mode parallel
 */
'development-room/persist'(entry: DevelopmentRoomLogEntry): Promise<void> | void
```

Source: [`packages/collaboration/development-room/src/types.ts`](../../packages/collaboration/development-room/src/types.ts)

<a id="development-roompresence-changed--emit"></a>

#### `development-room/presence-changed` — emit

One participant renewed or ended its transient online lease.

```ts cordis-catalog
/**
 * One participant renewed or ended its transient online lease.
 * @param snapshot - current participant profile and derived presence.
 * @param origin - local commit or replica source.
 * @mode emit
 */
'development-room/presence-changed'( snapshot: DevelopmentParticipantSnapshot, origin: DevelopmentRoomEventOrigin, ): void
```

Source: [`packages/collaboration/development-room/src/types.ts`](../../packages/collaboration/development-room/src/types.ts)

<a id="development-room-context-events"></a>

### `development-room-context/*` events

<a id="development-room-contextchanged--emit"></a>

#### `development-room-context/changed` — emit

One shared context entry committed to the append-only log.

```ts cordis-catalog
/**
 * One shared context entry committed to the append-only log.
 * @param entry - exact immutable entry that committed.
 * @param origin - local publication or durable restore.
 * @mode emit
 */
'development-room-context/changed'( entry: DevelopmentRoomContextEntry, origin: DevelopmentRoomContextEventOrigin, ): void
```

Source: [`packages/collaboration/development-room-context/src/types.ts`](../../packages/collaboration/development-room-context/src/types.ts)

<a id="development-room-contextpersist--parallel"></a>

#### `development-room-context/persist` — parallel

Persist one local context entry before it becomes observable. A rejecting listener aborts publication.

```ts cordis-catalog
/**
 * Persist one local context entry before it becomes observable.
 * A rejecting listener aborts publication.
 * @param entry - exact next local entry proposed for append.
 * @mode parallel
 */
'development-room-context/persist'(entry: DevelopmentRoomContextEntry): Promise<void> | void
```

Source: [`packages/collaboration/development-room-context/src/types.ts`](../../packages/collaboration/development-room-context/src/types.ts)

<a id="development-task-events"></a>

### `development-task/*` events

<a id="development-taskassignment-changed--emit"></a>

#### `development-task/assignment-changed` — emit

One committed binding event changed an Agent session's selected Task.

```ts cordis-catalog
/**
 * One committed binding event changed an Agent session's selected Task.
 * @param assignment - current binding, or null after clear for lossless JSON forwarding.
 * @param entry - exact event that produced the binding state.
 * @param origin - local, replica, or restored source.
 * @mode emit
 */
'development-task/assignment-changed'( assignment: DevelopmentTaskAssignment | null, entry: DevelopmentTaskAssignmentLogEntry, origin: DevelopmentTaskEventOrigin, ): void
```

Source: [`packages/collaboration/development-task/src/types.ts`](../../packages/collaboration/development-task/src/types.ts)

<a id="development-taskassignment-persist--parallel"></a>

#### `development-task/assignment-persist` — parallel

Persist one Agent session-binding event before it becomes observable.

```ts cordis-catalog
/**
 * Persist one Agent session-binding event before it becomes observable.
 * @param entry - exact next binding event proposed for append.
 * @mode parallel
 */
'development-task/assignment-persist'(entry: DevelopmentTaskAssignmentLogEntry): Promise<void> | void
```

Source: [`packages/collaboration/development-task/src/types.ts`](../../packages/collaboration/development-task/src/types.ts)

<a id="development-taskchanged--emit"></a>

#### `development-task/changed` — emit

One committed Task context event changed a projection.

```ts cordis-catalog
/**
 * One committed Task context event changed a projection.
 * @param snapshot - immutable Task projection after the append.
 * @param entry - exact event that produced the projection.
 * @param origin - local, replica, or restored source.
 * @mode emit
 */
'development-task/changed'( snapshot: DevelopmentTaskSnapshot, entry: DevelopmentTaskLogEntry, origin: DevelopmentTaskEventOrigin, ): void
```

Source: [`packages/collaboration/development-task/src/types.ts`](../../packages/collaboration/development-task/src/types.ts)

<a id="development-taskcontext-persist--parallel"></a>

#### `development-task/context-persist` — parallel

Persist one immutable context block before a Task event may reference it.

```ts cordis-catalog
/**
 * Persist one immutable context block before a Task event may reference it.
 * @param block - content-addressed block proposed for idempotent storage.
 * @mode parallel
 */
'development-task/context-persist'(block: DevelopmentTaskContextBlock): Promise<void> | void
```

Source: [`packages/collaboration/development-task/src/types.ts`](../../packages/collaboration/development-task/src/types.ts)

<a id="development-taskpersist--parallel"></a>

#### `development-task/persist` — parallel

Persist one Task event before it becomes observable.

```ts cordis-catalog
/**
 * Persist one Task event before it becomes observable.
 * @param entry - exact next event proposed for append.
 * @mode parallel
 */
'development-task/persist'(entry: DevelopmentTaskLogEntry): Promise<void> | void
```

Source: [`packages/collaboration/development-task/src/types.ts`](../../packages/collaboration/development-task/src/types.ts)

<a id="development-task-context-events"></a>

### `development-task-context/*` events

<a id="development-task-contextadmit--waterfall"></a>

#### `development-task-context/admit` — waterfall

Delegate Task admission to one managed local receiver; unhandled requests use passive injection. A managing listener owns the decision without calling next; other listeners must delegate.

```ts cordis-catalog
/**
 * Delegate Task admission to one managed local receiver; unhandled requests use passive injection.
 * A managing listener owns the decision without calling next; other listeners must delegate.
 * @param input - actual claims, accepted pre-step decision, Agent, and cancellation.
 * @param next - continue to another listener or the original passive Task consumer.
 * @mode waterfall
 */
'development-task-context/admit'(input: DevelopmentTaskContextAdmission, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

Types: [PreStepDecision](core.md)

Source: [`packages/collaboration/development-task-context/src/admission.ts`](../../packages/collaboration/development-task-context/src/admission.ts)

<a id="scope-access-events"></a>

### `scope-access/*` events

<a id="scope-accesscontribution-application-changed--emit"></a>

#### `scope-access/contribution-application-changed` — emit

A durable application or associated Task authorization changed.

```ts cordis-catalog
/**
 * A durable application or associated Task authorization changed.
 * @param selection - local Task whose application inventory must be reread.
 * @mode emit
 */
'scope-access/contribution-application-changed'(selection: { readonly taskId: DevelopmentTaskId }): void
```

Source: [`packages/collaboration/scope-access/src/types.ts`](../../packages/collaboration/scope-access/src/types.ts)

<a id="scope-agent-contribution-events"></a>

### `scope-agent-contribution/*` events

<a id="scope-agent-contributionchanged--emit"></a>

#### `scope-agent-contribution/changed` — emit

Local contribution state committed or live collection eligibility changed.

```ts cordis-catalog
/**
 * Local contribution state committed or live collection eligibility changed.
 * @param agentId - Session whose management status must be reread.
 * @param revision - current durable-domain revision; it does not prove model adoption.
 * @mode emit
 */
'scope-agent-contribution/changed'(agentId: SessionId, revision: number): void
```

Types: [SessionId](core.md)

Source: [`packages/collaboration/scope-agent-contribution/src/types.ts`](../../packages/collaboration/scope-agent-contribution/src/types.ts)
<!-- END GENERATED cordis-surface -->
