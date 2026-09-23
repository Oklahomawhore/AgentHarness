# Development collaboration

English | [中文](development-room.zh.md)

The Web product presents the Emergence Center: humans and Agents share explicit context through an immutable Root/Fork/Merge Task DAG, while one deterministic hidden Room per Task coordinates runtime membership. A Task is a context atom without lifecycle, evidence, approval, completion, or audit controls. Room failure degrades and retries without changing durable Task context.

The [Task README](../../packages/collaboration/development-task/README.md), [Task storage README](../../packages/collaboration/development-task-storage-domain/README.md), [Task context README](../../packages/collaboration/development-task-context/README.md), [Mesh README](../../packages/collaboration/development-mesh/README.md), [WebSocket provider README](../../packages/collaboration/development-mesh-websocket/README.md), [Room Mesh README](../../packages/collaboration/development-room-mesh/README.md), [Task Mesh README](../../packages/collaboration/development-task-mesh/README.md), [Task-lineage decision](../../.agents/notes/implemented/architecture/2026-08-27-emergence-center-task-lineage.md), and [context-atom decision](../../.agents/notes/implemented/architecture/2026-08-28-task-context-atoms-and-session-bindings.md) own the detailed contracts.

Source: [`packages/collaboration/development-room/src/index.ts`](../../packages/collaboration/development-room/src/index.ts), [`packages/collaboration/development-task/src/index.ts`](../../packages/collaboration/development-task/src/index.ts), [`packages/collaboration/development-task-storage-domain/src/index.ts`](../../packages/collaboration/development-task-storage-domain/src/index.ts), [`packages/collaboration/development-task-context/src/index.ts`](../../packages/collaboration/development-task-context/src/index.ts), [`packages/collaboration/development-mesh/src/index.ts`](../../packages/collaboration/development-mesh/src/index.ts), [`packages/collaboration/development-mesh-websocket/src/index.ts`](../../packages/collaboration/development-mesh-websocket/src/index.ts), [`packages/collaboration/development-room-mesh/src/index.ts`](../../packages/collaboration/development-room-mesh/src/index.ts), and [`packages/collaboration/development-task-mesh/src/index.ts`](../../packages/collaboration/development-task-mesh/src/index.ts)

## Task state

Task ids, context block ids, session binding ids, participant ids, Room ids, and node ids are opaque. Task creation commits an immutable origin and optional content-addressed parent snapshot. Only the Task name, initial shared context, and explicit publications are inheritable; private chats, complete Sessions, tool history, and internal reasoning are excluded. SQLite persists each event, session binding, and context block as an independent row and rebuilds the bounded in-memory DAG projection at startup.

Each Agent session owns an explicit Task binding. Several sessions from one Codex, Cursor, or Claude participant may connect to different Tasks; switching or clearing one binding does not affect the others. Native Agents receive connected Task context as a replayable user-role Session event at pre-step. An external MCP conversation calls `agentharness_task_connect`, retains its returned binding id, and receives context delta on later Task calls.

## Mesh and Room runtime

The generic Mesh registers versioned delta channels. Its WebSocket provider requires a shared credential and authenticates discovery, handshakes, and every envelope with HMAC-SHA256; sequence and nonce rules reject replay. The Room consumer replicates hidden membership state, while the Task consumer sends blocks before dependent Task events, queues out-of-order dependencies, persists remote read caches, and routes mutations to the owner node.

Presence remains a transient lease outside durable logs. Room creation, join, and leave remain idempotent runtime operations, but no user-facing Room Remote, MCP tool, or Web panel is part of the Task-first composition. The legacy explicit Room-context packages remain available to other compositions and are not mounted by the Web bundle.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

<a id="ctxdevelopmenttaskmesh--developmenttaskmeshservice"></a>

### `ctx.developmentTaskMesh` — `DevelopmentTaskMeshService`

Replicate Task state and route mutations to each Task owner.

```ts cordis-catalog
/**
 * Route one Task mutation to its authoritative owner.
 * @param ownerNodeId - node that authored the Task creation event.
 * @param command - Task mutation and validated request.
 * @returns updated Task projection from the owner.
 */
async route(ownerNodeId: DevelopmentNodeId, command: DevelopmentTaskMeshCommand): Promise<DevelopmentTaskSnapshot>
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
 * @param request - binding identity and owning Agent participant.
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
 * Read the current Task and inherited block for an assigned Agent or MCP response.
 * @param taskId - exact Task identity.
 * @returns detached bounded model-facing context.
 */
contextView(taskId: DevelopmentTaskId): DevelopmentTaskContextView

/**
 * Read the model-facing context for one Task through Remote.
 * @param request - exact Task identity.
 * @returns current Task plus its immutable inherited block when present.
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
 * @param assignment - current binding, or undefined after clear.
 * @param entry - exact event that produced the binding state.
 * @param origin - local, replica, or restored source.
 * @mode emit
 */
'development-task/assignment-changed'( assignment: DevelopmentTaskAssignment | undefined, entry: DevelopmentTaskAssignmentLogEntry, origin: DevelopmentTaskEventOrigin, ): void
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
<!-- END GENERATED cordis-surface -->
