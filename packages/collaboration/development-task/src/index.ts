/** Durable Task DAG, explicit shared context, and isolated Agent-session bindings. */

import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-development-room'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DevelopmentTaskAcknowledgeRequest,
  DevelopmentTaskAssignment,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskBindingId,
  DevelopmentTaskCheckoutRequest,
  DevelopmentTaskCheckoutResult,
  DevelopmentTaskClearRequest,
  DevelopmentTaskContextBlock,
  DevelopmentTaskContextBlockId,
  DevelopmentTaskContextPublication,
  DevelopmentTaskContextView,
  DevelopmentTaskCreateRequest,
  DevelopmentTaskCreateResult,
  DevelopmentTaskEventOrigin,
  DevelopmentTaskGetRequest,
  DevelopmentTaskId,
  DevelopmentTaskInheritedSource,
  DevelopmentTaskLineageRequest,
  DevelopmentTaskLineageSnapshot,
  DevelopmentTaskListRequest,
  DevelopmentTaskLogChange,
  DevelopmentTaskLogEntry,
  DevelopmentTaskOrigin,
  DevelopmentTaskParentRef,
  DevelopmentTaskPublishContextRequest,
  DevelopmentTaskSnapshot,
} from './types.ts'

export type {
  DevelopmentTaskId,
  DevelopmentTaskContextBlockId,
  DevelopmentTaskBindingId,
  DevelopmentTaskContextPublication,
  DevelopmentTaskParentRef,
  DevelopmentTaskOrigin,
  DevelopmentTaskInheritedSource,
  DevelopmentTaskContextBlock,
  DevelopmentTaskLogChange,
  DevelopmentTaskLogEntry,
  DevelopmentTaskSnapshot,
  DevelopmentTaskListRequest,
  DevelopmentTaskGetRequest,
  DevelopmentTaskLineageRequest,
  DevelopmentTaskLineageSnapshot,
  DevelopmentTaskCreateRequest,
  DevelopmentTaskCreateResult,
  DevelopmentTaskPublishContextRequest,
  DevelopmentTaskAssignment,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskCheckoutRequest,
  DevelopmentTaskClearRequest,
  DevelopmentTaskAcknowledgeRequest,
  DevelopmentTaskContextView,
  DevelopmentTaskCheckoutResult,
  DevelopmentTaskEventOrigin,
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomId,
} from './types.ts'

/** Retention and payload bounds for one Task runtime. */
export interface Config {
  /** Maximum Tasks retained by this Host. */
  readonly maxTasks: number
  /** Maximum events retained for one Task. */
  readonly maxEventsPerTask: number
  /** Maximum parent Tasks accepted by Merge. */
  readonly maxMergeParents: number
  /** Maximum serialized inherited-context block bytes. */
  readonly maxContextBlockBytes: number
  /** Maximum Tasks returned by a lineage query. */
  readonly maxLineageTasks: number
  /** Maximum UTF-8 bytes accepted for one text field. */
  readonly maxTextBytes: number
  /** Delay between best-effort retries for locally owned degraded Task Rooms. */
  readonly roomRetryIntervalMs: number
}

interface TaskRecord {
  id: DevelopmentTaskId
  ownerNodeId: DevelopmentNodeId
  revision: number
  origin: DevelopmentTaskOrigin
  hiddenRoomId: DevelopmentRoomId
  objective: string
  scope: string
  createdBy: DevelopmentParticipantId
  context: DevelopmentTaskContextPublication[]
  inheritedContextBlockId?: DevelopmentTaskContextBlockId
  events: DevelopmentTaskLogEntry[]
  createdAt: number
  updatedAt: number
}

interface TaskOwnerRouter {
  route(ownerNodeId: DevelopmentNodeId, command: {
    readonly method: 'publishContext'
    readonly request: unknown
  }): Promise<DevelopmentTaskSnapshot>
}

interface RoomOwnerRouter {
  join(request: { readonly roomId: DevelopmentRoomId; readonly participantId: DevelopmentParticipantId }): Promise<void>
  leave(request: { readonly roomId: DevelopmentRoomId; readonly participantId: DevelopmentParticipantId }): Promise<void>
}

type TaskErrorCode =
  | 'TASK_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'PARENT_REVISION_UNAVAILABLE'
  | 'PARTICIPANT_NOT_AVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'POLICY_REJECTED'
  | 'PERSISTENCE_FAILED'
  | 'REPLICA_CONFLICT'
  | 'INVALID_REQUEST'
  | 'LIMIT_EXCEEDED'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Task DAG, explicit context, and isolated Agent-session bindings. */
    developmentTasks: DevelopmentTaskService
    /** Remote-only facade for Agent-session Task binding operations. */
    developmentTaskAssignments: DevelopmentTaskAssignmentRemoteService
  }
}

/** Stable machine-routable failure from a Task operation. */
export class DevelopmentTaskError extends Error {
  /**
   * @param message - caller-visible failure description.
   * @param code - stable failure classification.
   * @param options - optional underlying failure for Host diagnostics.
   */
  constructor(message: string, readonly code: TaskErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DevelopmentTaskError'
  }
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`development-task: ${field} must be a positive safe integer`)
  }
  return value
}

/** Host service for immutable Task lineage, shared context, and Agent-session bindings. */
export class DevelopmentTaskService extends TypertRemoteService {
  static inject = ['developmentRooms']
  static Config: s<Config> = s.object({
    maxTasks: s.number().step(1).min(1).required(),
    maxEventsPerTask: s.number().step(1).min(1).required(),
    maxMergeParents: s.number().step(1).min(2).required(),
    maxContextBlockBytes: s.number().step(1).min(1).required(),
    maxLineageTasks: s.number().step(1).min(1).required(),
    maxTextBytes: s.number().step(1).min(1).required(),
    roomRetryIntervalMs: s.number().step(1).min(1).required(),
  })

  private readonly tasks = new Map<DevelopmentTaskId, TaskRecord>()
  private readonly children = new Map<DevelopmentTaskId, Set<DevelopmentTaskId>>()
  private readonly entries: DevelopmentTaskLogEntry[] = []
  private readonly lastSeqByNode = new Map<DevelopmentNodeId, number>()
  private readonly contextBlocks = new Map<DevelopmentTaskContextBlockId, DevelopmentTaskContextBlock>()
  private readonly assignments = new Map<DevelopmentTaskBindingId, DevelopmentTaskAssignment>()
  private readonly assignmentEntries: DevelopmentTaskAssignmentLogEntry[] = []
  private readonly lastAssignmentSeqByNode = new Map<DevelopmentNodeId, number>()
  private readonly config: Config
  private operationTail: Promise<void> = Promise.resolve()
  private roomReconcileTail: Promise<void> = Promise.resolve()
  private roomReconcileRunning = false

  /** Validate all deployment bounds before accepting Task state. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'developmentTasks')
    new DevelopmentTaskAssignmentRemoteService(ctx, this)
    this.config = {
      maxTasks: positive(config.maxTasks, 'maxTasks'),
      maxEventsPerTask: positive(config.maxEventsPerTask, 'maxEventsPerTask'),
      maxMergeParents: positive(config.maxMergeParents, 'maxMergeParents'),
      maxContextBlockBytes: positive(config.maxContextBlockBytes, 'maxContextBlockBytes'),
      maxLineageTasks: positive(config.maxLineageTasks, 'maxLineageTasks'),
      maxTextBytes: positive(config.maxTextBytes, 'maxTextBytes'),
      roomRetryIntervalMs: positive(config.roomRetryIntervalMs, 'roomRetryIntervalMs'),
    }
    if (this.config.maxMergeParents < 2) {
      throw new TypeError('development-task: maxMergeParents must be at least 2')
    }
    ctx.effect(() => {
      const timer = globalThis.setInterval(() => { this.scheduleDegradedRoomRetry() }, this.config.roomRetryIntervalMs)
      timer.unref()
      return async () => {
        globalThis.clearInterval(timer)
        await this.roomReconcileTail
      }
    }, 'development-task: hidden Room retry')
  }

  /**
   * Read bounded current Task projections ordered by recent activity.
   * @param request - optional participant filter plus result limit.
   * @returns detached Task projections.
   */
  @Remote('list')
  list(request: DevelopmentTaskListRequest): readonly DevelopmentTaskSnapshot[] {
    const limit = this.limit(request.limit, 200)
    return Object.freeze([...this.tasks.values()]
      .filter(task => request.participantId === undefined
        || task.createdBy === request.participantId
        || [...this.assignments.values()].some(binding => binding.participantId === request.participantId && binding.taskId === task.id))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(task => this.snapshot(task)))
  }

  /**
   * Read one current Task projection.
   * @param request - exact Task identity.
   * @returns detached current projection.
   */
  @Remote('get')
  get(request: DevelopmentTaskGetRequest): DevelopmentTaskSnapshot {
    return this.snapshot(this.requireTask(request.taskId))
  }

  /**
   * Read a bounded ancestor and descendant neighborhood.
   * @param request - focus Task, depths, and total result limit.
   * @returns graph Tasks and ids omitted at the requested boundary.
   */
  @Remote('lineage')
  lineage(request: DevelopmentTaskLineageRequest): DevelopmentTaskLineageSnapshot {
    this.requireTask(request.taskId)
    const ancestorDepth = this.depth(request.ancestorDepth, 4)
    const descendantDepth = this.depth(request.descendantDepth, 2)
    const limit = this.limit(request.limit, this.config.maxLineageTasks)
    const selected = new Set<DevelopmentTaskId>([request.taskId])
    const boundary = new Set<DevelopmentTaskId>()
    this.walkLineage(
      [request.taskId],
      ancestorDepth,
      selected,
      boundary,
      limit,
      taskId => this.parentRefs(this.requireTask(taskId)).map(ref => ref.taskId),
    )
    this.walkLineage([request.taskId], descendantDepth, selected, boundary, limit, taskId => [...(this.children.get(taskId) ?? [])])
    return Object.freeze({
      tasks: Object.freeze([...selected].map(id => this.snapshot(this.requireTask(id)))),
      boundaryTaskIds: Object.freeze([...boundary]),
    })
  }

  /**
   * Create one Root, Fork, or Merge Task and then materialize its hidden Room.
   * @param request - immutable parent relation and the new Task's context fields.
   * @returns committed Task; `runtime` is degraded when Room reconciliation fails.
   */
  create(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskSnapshot> {
    return this.enqueue(() => this.createNow(request))
  }

  /**
   * Create one Task through Remote and report hidden-Room materialization separately.
   * @param request - immutable parent relation and the new Task's context fields.
   * @returns committed Task and runtime state.
   */
  @Remote('create')
  async createRemote(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskCreateResult> {
    const task = await this.create(request)
    return Object.freeze({ task, runtime: task.runtime })
  }

  private async createNow(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskSnapshot> {
    if (this.tasks.size >= this.config.maxTasks) throw new DevelopmentTaskError('Task limit reached', 'LIMIT_EXCEEDED')
    this.requireKnownParticipant(request.createdBy)
    const origin = this.normalizeOrigin(request.origin)
    const block = this.createContextBlock(origin, request.excludedContextIds ?? [])
    if (block !== undefined) await this.persistContextBlock(block)
    const taskId = `task-${randomUUID()}` as DevelopmentTaskId
    const hiddenRoomId = this.hiddenRoomId(taskId)
    const created = await this.publish(taskId, hiddenRoomId, {
      kind: 'task-created',
      origin,
      objective: this.text(request.objective, 'objective'),
      scope: this.text(request.scope, 'scope'),
      createdBy: request.createdBy,
      ...(block === undefined ? {} : { inheritedContextBlockId: block.id }),
    })
    await this.reconcileTaskRoom(created.id).catch((error: unknown) => {
      this.ctx.logger.warn('development-task: hidden Room for %s remains degraded: %s', created.id, this.failureMessage(error))
    })
    return this.snapshot(this.requireTask(created.id))
  }

  /**
   * Publish explicit context that may be inherited by later Tasks.
   * @param request - Task, assigned participant, text, and optional artifact URI.
   * @returns updated Task projection.
   */
  @Remote('publishContext')
  publishContext(request: DevelopmentTaskPublishContextRequest): Promise<DevelopmentTaskSnapshot> {
    return this.enqueue(async () => {
      const task = this.requireTask(request.taskId)
      if (task.ownerNodeId !== this.nodeId()) return await this.routeOwner(task, { method: 'publishContext', request })
      this.requireKnownParticipant(request.participantId)
      const publication: DevelopmentTaskContextPublication = Object.freeze({
        id: `context-${randomUUID()}`,
        text: this.text(request.text, 'text'),
        ...(request.uri === undefined ? {} : { uri: this.text(request.uri, 'uri') }),
        publishedBy: request.participantId,
        publishedAt: Date.now(),
      })
      return await this.publish(task.id, task.hiddenRoomId, { kind: 'context-published', publication })
    })
  }

  /**
   * Read all current Agent assignments.
   * @returns detached assignments ordered by participant identity.
   */
  assignmentList(): readonly DevelopmentTaskAssignment[] {
    return Object.freeze([...this.assignments.values()]
      .sort((left, right) => left.participantId.localeCompare(right.participantId) || left.bindingId.localeCompare(right.bindingId))
      .map(item => Object.freeze({ ...item })))
  }

  /**
   * Bind one local online Agent session to a Task, then reconcile Rooms.
   * @param request - target Task, Agent participant, and optional existing session binding.
   * @returns committed session binding, Task context, and independent Room outcomes.
   */
  checkout(request: DevelopmentTaskCheckoutRequest): Promise<DevelopmentTaskCheckoutResult> {
    return this.enqueue(async () => {
      const task = this.requireTask(request.taskId)
      const participant = this.ctx.developmentRooms.list().participants.find(item => item.id === request.participantId)
      if (participant === undefined || participant.kind !== 'agent' || participant.presence !== 'online'
        || participant.nodeId !== this.nodeId()) {
        throw new DevelopmentTaskError('checkout requires an online Agent owned by this node', 'PARTICIPANT_NOT_AVAILABLE')
      }
      const bindingId = request.bindingId ?? `binding-${randomUUID()}` as DevelopmentTaskBindingId
      const previous = this.assignments.get(bindingId)
      if (previous !== undefined && previous.participantId !== request.participantId) {
        throw new DevelopmentTaskError('Task binding belongs to a different Agent participant', 'INVALID_REQUEST')
      }
      const assignment = await this.publishAssignment(bindingId, request.participantId, {
        kind: 'task-bound', taskId: task.id,
        ...(request.sessionLabel === undefined ? {} : { sessionLabel: this.text(request.sessionLabel, 'sessionLabel') }),
      })
      if (assignment === undefined) throw new DevelopmentTaskError('binding event did not create an assignment', 'INVALID_REQUEST')
      const warnings: string[] = []
      let targetJoined = false
      let previousLeft = previous === undefined || previous.taskId === task.id
      try {
        if (task.ownerNodeId === this.nodeId()) await this.reconcileTaskRoom(task.id)
        await this.joinRoom({ roomId: task.hiddenRoomId, participantId: request.participantId })
        targetJoined = true
      } catch (error) {
        warnings.push(`target Room reconciliation failed: ${this.failureMessage(error)}`)
      }
      if (previous !== undefined && previous.taskId !== task.id
        && !this.participantBoundToTask(request.participantId, previous.taskId, bindingId)) {
        try {
          const previousTask = this.requireTask(previous.taskId)
          await this.leaveRoom({ roomId: previousTask.hiddenRoomId, participantId: request.participantId })
          previousLeft = true
        } catch (error) {
          warnings.push(`previous Room reconciliation failed: ${this.failureMessage(error)}`)
        }
      }
      return Object.freeze({
        assignment,
        context: this.contextView(task.id),
        runtime: Object.freeze({ targetJoined, previousLeft, warnings: Object.freeze(warnings) }),
      })
    })
  }

  /**
   * Clear one local Agent session's Task binding.
   * @param request - binding identity and owning Agent participant.
   * @returns resolution after binding commit and best-effort Room leave.
   */
  clear(request: DevelopmentTaskClearRequest): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.assignments.get(request.bindingId)
      if (previous === undefined) return
      if (previous.participantId !== request.participantId) {
        throw new DevelopmentTaskError('Task binding belongs to a different Agent participant', 'INVALID_REQUEST')
      }
      await this.publishAssignment(request.bindingId, request.participantId, {
        kind: 'task-cleared', previousTaskId: previous.taskId,
      })
      const task = this.requireTask(previous.taskId)
      if (this.participantBoundToTask(request.participantId, task.id)) return
      await this.leaveRoom({ roomId: task.hiddenRoomId, participantId: request.participantId }).catch((error: unknown) => {
        this.ctx.logger.warn('development-task: clearing %s left a stale Room membership: %s', request.participantId, this.failureMessage(error))
      })
    })
  }

  /**
   * Record that one Agent session received a specific Task revision.
   * @param request - binding, Agent, Task, and delivered revision.
   * @returns updated session binding.
   */
  acknowledge(request: DevelopmentTaskAcknowledgeRequest): Promise<DevelopmentTaskAssignment> {
    return this.enqueue(async () => {
      const assignment = this.assignments.get(request.bindingId)
      const task = this.requireTask(request.taskId)
      if (assignment?.participantId !== request.participantId || assignment.taskId !== task.id
        || request.revision < 1 || request.revision > task.revision) {
        throw new DevelopmentTaskError('context acknowledgement does not match the Agent session binding', 'INVALID_REQUEST')
      }
      const acknowledged = await this.publishAssignment(request.bindingId, request.participantId, {
        kind: 'context-acknowledged', taskId: task.id, revision: request.revision,
      })
      if (acknowledged === undefined) {
        throw new DevelopmentTaskError('acknowledgement unexpectedly cleared the binding', 'INVALID_REQUEST')
      }
      return acknowledged
    })
  }

  /**
   * Read the current Task and inherited block for an assigned Agent or MCP response.
   * @param taskId - exact Task identity.
   * @returns detached bounded model-facing context.
   */
  contextView(taskId: DevelopmentTaskId): DevelopmentTaskContextView {
    const task = this.requireTask(taskId)
    const inherited = task.inheritedContextBlockId === undefined
      ? undefined
      : this.contextBlocks.get(task.inheritedContextBlockId)
    return Object.freeze({
      task: this.snapshot(task),
      ...(inherited === undefined ? {} : { inherited: this.freezeBlock(inherited) }),
    })
  }

  /**
   * Read the model-facing context for one Task through Remote.
   * @param request - exact Task identity.
   * @returns current Task plus its immutable inherited block when present.
   */
  @Remote('context')
  context(request: DevelopmentTaskGetRequest): DevelopmentTaskContextView {
    return this.contextView(request.taskId)
  }

  /**
   * Read the complete Task event set for storage and Mesh replication.
   * @returns immutable entries in local acceptance order.
   */
  log(): readonly DevelopmentTaskLogEntry[] { return Object.freeze([...this.entries]) }

  /**
   * Read the complete assignment event set for storage and Mesh replication.
   * @returns immutable entries in local acceptance order.
   */
  assignmentLog(): readonly DevelopmentTaskAssignmentLogEntry[] { return Object.freeze([...this.assignmentEntries]) }

  /**
   * Read all immutable context blocks for storage and Mesh replication.
   * @returns detached content-addressed blocks.
   */
  blocks(): readonly DevelopmentTaskContextBlock[] {
    return Object.freeze([...this.contextBlocks.values()].map(block => this.freezeBlock(block)))
  }

  /**
   * Restore context blocks before events that may reference them.
   * @param blocks - durable blocks whose digest must match their identity.
   */
  restoreContextBlocks(blocks: readonly DevelopmentTaskContextBlock[]): void {
    for (const block of blocks) this.acceptContextBlock(block, false)
  }

  /**
   * Restore a durable mixed-origin Task log without rewriting it.
   * Parent dependencies are resolved before child events.
   * @param candidates - validated persisted events.
   */
  restoreLog(candidates: readonly DevelopmentTaskLogEntry[]): void {
    const pending = candidates.map(entry => this.normalizeEntry(entry))
    while (pending.length > 0) {
      const index = pending.findIndex(entry => this.canRestore(entry))
      if (index < 0) throw new DevelopmentTaskError('durable Task events have unresolved lineage or sequence dependencies', 'REPLICA_CONFLICT')
      const [entry] = pending.splice(index, 1)
      if (entry === undefined) throw new DevelopmentTaskError('durable Task restore lost an event', 'REPLICA_CONFLICT')
      this.append(entry, { kind: 'restored', nodeId: entry.nodeId }, 'REPLICA_CONFLICT')
    }
  }

  /**
   * Restore durable assignment events without rewriting them.
   * @param entries - validated assignment events.
   */
  restoreAssignmentLog(entries: readonly DevelopmentTaskAssignmentLogEntry[]): void {
    const pending = [...entries]
    while (pending.length > 0) {
      const index = pending.findIndex(entry => entry.seq === (this.lastAssignmentSeqByNode.get(entry.nodeId) ?? 0) + 1)
      if (index < 0) throw new DevelopmentTaskError('durable assignment events have a sequence gap', 'REPLICA_CONFLICT')
      const [entry] = pending.splice(index, 1)
      if (entry === undefined) throw new DevelopmentTaskError('durable assignment restore lost an event', 'REPLICA_CONFLICT')
      this.appendAssignment(this.freezeAssignmentEntry(entry), { kind: 'restored', nodeId: entry.nodeId }, 'REPLICA_CONFLICT')
    }
  }

  /**
   * Persist and accept one authenticated peer context block idempotently.
   * @param block - wire-validated content-addressed block.
   * @returns resolution after durable acceptance.
   */
  async acceptContextReplica(block: DevelopmentTaskContextBlock): Promise<void> {
    const normalized = this.normalizeBlock(block)
    await this.ctx.parallel('development-task/context-persist', normalized)
    this.acceptContextBlock(normalized, true)
  }

  /**
   * Persist and append one authenticated peer Task event.
   * @param candidate - wire-validated event.
   * @param sourceNodeId - authenticated peer identity.
   * @returns current Task projection.
   */
  acceptLogReplica(candidate: DevelopmentTaskLogEntry, sourceNodeId: DevelopmentNodeId): Promise<DevelopmentTaskSnapshot> {
    return this.enqueue(async () => {
      const entry = this.normalizeEntry(candidate)
      if (entry.nodeId !== sourceNodeId || sourceNodeId === this.nodeId()) {
        throw new DevelopmentTaskError('replicated Task event does not match its authenticated peer', 'REPLICA_CONFLICT')
      }
      await this.persistEntry(entry)
      return this.append(entry, { kind: 'replica', nodeId: sourceNodeId }, 'REPLICA_CONFLICT')
    })
  }

  /**
   * Persist and append one authenticated peer assignment event.
   * @param candidate - wire-validated assignment event.
   * @param sourceNodeId - authenticated participant-home node.
   * @returns current assignment or undefined after clear.
   */
  acceptAssignmentReplica(
    candidate: DevelopmentTaskAssignmentLogEntry,
    sourceNodeId: DevelopmentNodeId,
  ): Promise<DevelopmentTaskAssignment | undefined> {
    return this.enqueue(async () => {
      const entry = this.freezeAssignmentEntry(candidate)
      if (entry.nodeId !== sourceNodeId || sourceNodeId === this.nodeId()) {
        throw new DevelopmentTaskError('replicated assignment event does not match its authenticated peer', 'REPLICA_CONFLICT')
      }
      await this.persistAssignment(entry)
      return this.appendAssignment(entry, { kind: 'replica', nodeId: sourceNodeId }, 'REPLICA_CONFLICT')
    })
  }

  /**
   * Ensure hidden Rooms exist for every locally owned restored Task.
   * @returns resolution after all independent reconciliations settle.
   */
  async reconcileAllRooms(): Promise<void> {
    await Promise.all([...this.tasks.values()]
      .filter(task => task.ownerNodeId === this.nodeId())
      .map(task => this.reconcileTaskRoom(task.id).catch((error: unknown) => {
        this.ctx.logger.warn('development-task: hidden Room for %s remains degraded: %s', task.id, this.failureMessage(error))
      })))
  }

  private scheduleDegradedRoomRetry(): void {
    if (this.roomReconcileRunning || ![...this.tasks.values()].some(task => task.ownerNodeId === this.nodeId()
      && this.ctx.developmentRooms.list().rooms.every(room => room.id !== task.hiddenRoomId))) return
    this.roomReconcileRunning = true
    this.roomReconcileTail = this.reconcileAllRooms()
      .catch((error: unknown) => {
        this.ctx.logger.warn('development-task: hidden Room retry failed: %s', this.failureMessage(error))
      })
      .finally(() => { this.roomReconcileRunning = false })
  }

  private async reconcileTaskRoom(taskId: DevelopmentTaskId): Promise<void> {
    const task = this.requireTask(taskId)
    if (task.ownerNodeId !== this.nodeId()) throw new DevelopmentTaskError('remote Task Room requires owner routing', 'RUNTIME_UNAVAILABLE')
    await this.ctx.developmentRooms.ensure({ roomId: task.hiddenRoomId, objective: `Task ${task.id}` })
    await this.ctx.developmentRooms.join({ roomId: task.hiddenRoomId, participantId: task.createdBy })
    const boundParticipants = new Set([...this.assignments.values()]
      .filter(binding => binding.taskId === task.id)
      .map(binding => binding.participantId))
    for (const participantId of boundParticipants) await this.ctx.developmentRooms.join({ roomId: task.hiddenRoomId, participantId })
  }

  private async publish(
    taskId: DevelopmentTaskId,
    hiddenRoomId: DevelopmentRoomId,
    change: DevelopmentTaskLogChange,
  ): Promise<DevelopmentTaskSnapshot> {
    const current = this.tasks.get(taskId)
    if (current !== undefined && current.events.length >= this.config.maxEventsPerTask) {
      throw new DevelopmentTaskError('Task event limit reached', 'LIMIT_EXCEEDED')
    }
    const entry = this.freezeEntry({
      nodeId: this.nodeId(),
      seq: (this.lastSeqByNode.get(this.nodeId()) ?? 0) + 1,
      at: Date.now(),
      taskId,
      revision: (current?.revision ?? 0) + 1,
      hiddenRoomId,
      change,
    })
    this.prepare(entry, 'INVALID_REQUEST')
    await this.persistEntry(entry)
    return this.append(entry, { kind: 'local', nodeId: entry.nodeId }, 'INVALID_REQUEST')
  }

  private async persistEntry(entry: DevelopmentTaskLogEntry): Promise<void> {
    try {
      await this.ctx.parallel('development-task/persist', entry)
    } catch (error) {
      throw new DevelopmentTaskError(`Task persistence failed: ${this.failureMessage(error)}`, 'PERSISTENCE_FAILED', { cause: error })
    }
  }

  private append(
    entry: DevelopmentTaskLogEntry,
    origin: DevelopmentTaskEventOrigin,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): DevelopmentTaskSnapshot {
    const lastSeq = this.lastSeqByNode.get(entry.nodeId) ?? 0
    if (entry.seq <= lastSeq) {
      const retained = this.entries.find(item => item.nodeId === entry.nodeId && item.seq === entry.seq)
      if (retained === undefined || JSON.stringify(retained) !== JSON.stringify(entry)) {
        throw new DevelopmentTaskError('same Task event identity carries different content', 'REPLICA_CONFLICT')
      }
      return this.snapshot(this.requireTask(entry.taskId))
    }
    const task = this.prepare(entry, code)
    task.events.push(entry)
    task.revision = entry.revision
    task.updatedAt = entry.at
    this.entries.push(entry)
    this.lastSeqByNode.set(entry.nodeId, entry.seq)
    this.tasks.set(task.id, task)
    if (entry.change.kind === 'task-created') {
      for (const parent of this.parentRefs(task)) {
        const children = this.children.get(parent.taskId) ?? new Set<DevelopmentTaskId>()
        children.add(task.id)
        this.children.set(parent.taskId, children)
      }
    }
    const snapshot = this.snapshot(task)
    this.ctx.emit('development-task/changed', snapshot, entry, origin)
    return snapshot
  }

  private prepare(entry: DevelopmentTaskLogEntry, code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT'): TaskRecord {
    const expectedSeq = (this.lastSeqByNode.get(entry.nodeId) ?? 0) + 1
    if (entry.seq !== expectedSeq) throw new DevelopmentTaskError(`Task event expected node sequence ${String(expectedSeq)}`, code)
    const current = this.tasks.get(entry.taskId)
    if (entry.revision !== (current?.revision ?? 0) + 1) {
      throw new DevelopmentTaskError('Task revision is not the exact next revision', code)
    }
    return this.projectEntry(current, entry, code)
  }

  private projectEntry(
    current: TaskRecord | undefined,
    entry: DevelopmentTaskLogEntry,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): TaskRecord {
    switch (entry.change.kind) {
      case 'task-created': {
        if (current !== undefined) throw new DevelopmentTaskError('Task already exists', code)
        this.validateOriginReferences(entry.change.origin, code)
        if (entry.change.inheritedContextBlockId !== undefined
          && !this.contextBlocks.has(entry.change.inheritedContextBlockId)) {
          throw new DevelopmentTaskError('Task references an unavailable inherited-context block', 'PARENT_REVISION_UNAVAILABLE')
        }
        return {
          id: entry.taskId,
          ownerNodeId: entry.nodeId,
          revision: 0,
          origin: entry.change.origin,
          hiddenRoomId: entry.hiddenRoomId,
          objective: entry.change.objective,
          scope: entry.change.scope,
          createdBy: entry.change.createdBy,
          context: [],
          ...(entry.change.inheritedContextBlockId === undefined ? {} : {
            inheritedContextBlockId: entry.change.inheritedContextBlockId,
          }),
          events: [],
          createdAt: entry.at,
          updatedAt: entry.at,
        }
      }
      case 'context-published': {
        const task = this.requireProjectedTask(current, entry, code)
        return { ...task, context: [...task.context, entry.change.publication], events: [...task.events] }
      }
      default: return this.assertNever(entry.change)
    }
  }

  private requireProjectedTask(
    task: TaskRecord | undefined,
    entry: DevelopmentTaskLogEntry,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): TaskRecord {
    if (task === undefined) throw new DevelopmentTaskError('Task event mutates a Task before creation', code)
    if (task.ownerNodeId !== entry.nodeId || task.hiddenRoomId !== entry.hiddenRoomId) {
      throw new DevelopmentTaskError('Task event owner or hidden Room changed', code)
    }
    if (entry.at < task.updatedAt) throw new DevelopmentTaskError('Task event timestamp moved backwards', code)
    return task
  }

  private normalizeOrigin(origin: DevelopmentTaskOrigin): DevelopmentTaskOrigin {
    switch (origin.kind) {
      case 'root': return Object.freeze({ kind: 'root' })
      case 'fork': return Object.freeze({ kind: 'fork', parent: this.normalizeParent(origin.parent) })
      case 'merge': {
        if (origin.parents.length < 2) throw new DevelopmentTaskError('Merge requires at least two parents', 'INVALID_REQUEST')
        if (origin.parents.length > this.config.maxMergeParents) {
          throw new DevelopmentTaskError('Merge parent limit reached', 'LIMIT_EXCEEDED')
        }
        const parents = origin.parents.map(parent => this.normalizeParent(parent))
        if (new Set(parents.map(parent => parent.taskId)).size !== parents.length) {
          throw new DevelopmentTaskError('Merge parents must be unique', 'INVALID_REQUEST')
        }
        return Object.freeze({ kind: 'merge', parents: Object.freeze(parents) })
      }
      default: return this.assertNever(origin)
    }
  }

  private normalizeParent(parent: DevelopmentTaskParentRef): DevelopmentTaskParentRef {
    if (!Number.isSafeInteger(parent.revision) || parent.revision < 1) {
      throw new DevelopmentTaskError('parent revision must be a positive safe integer', 'INVALID_REQUEST')
    }
    const task = this.requireTask(parent.taskId)
    if (parent.revision > task.revision) throw new DevelopmentTaskError('parent revision is unavailable', 'REVISION_NOT_FOUND')
    return Object.freeze({ ...parent })
  }

  private validateOriginReferences(
    origin: DevelopmentTaskOrigin,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): void {
    for (const parent of origin.kind === 'root' ? [] : origin.kind === 'fork' ? [origin.parent] : origin.parents) {
      const task = this.tasks.get(parent.taskId)
      if (task === undefined || parent.revision > task.revision) {
        throw new DevelopmentTaskError(
          'parent Task revision is unavailable',
          code === 'INVALID_REQUEST' ? 'PARENT_REVISION_UNAVAILABLE' : code,
        )
      }
    }
  }

  private createContextBlock(
    origin: DevelopmentTaskOrigin,
    excludedContextIds: readonly string[],
  ): DevelopmentTaskContextBlock | undefined {
    const parents = origin.kind === 'root' ? [] : origin.kind === 'fork' ? [origin.parent] : origin.parents
    if (parents.length === 0) {
      if (excludedContextIds.length > 0) {
        throw new DevelopmentTaskError('Root Task has no parent context to exclude', 'INVALID_REQUEST')
      }
      return undefined
    }
    const excluded = new Set(excludedContextIds)
    if (excluded.size !== excludedContextIds.length) {
      throw new DevelopmentTaskError('excluded context publication ids must be unique', 'INVALID_REQUEST')
    }
    const complete = parents.map(parent => this.inheritedSource(parent))
    const available = new Set(complete.flatMap(source => source.context.map(item => item.id)))
    if ([...excluded].some(id => !available.has(id))) {
      throw new DevelopmentTaskError('excluded context publication does not belong to a selected parent revision', 'INVALID_REQUEST')
    }
    const sources = complete.map(source => Object.freeze({
      ...source,
      context: Object.freeze(source.context.filter(item => !excluded.has(item.id))),
    }))
    const serialized = JSON.stringify({ version: 1, sources })
    if (Buffer.byteLength(serialized, 'utf8') > this.config.maxContextBlockBytes) {
      throw new DevelopmentTaskError('inherited context exceeds maxContextBlockBytes', 'LIMIT_EXCEEDED')
    }
    const id = `context-${createHash('sha256').update(serialized).digest('hex')}` as DevelopmentTaskContextBlockId
    return this.freezeBlock({ id, createdAt: Date.now(), sources })
  }

  private inheritedSource(parent: DevelopmentTaskParentRef): DevelopmentTaskInheritedSource {
    const projection = this.projectionAt(this.requireTask(parent.taskId), parent.revision)
    return Object.freeze({
      parent,
      objective: projection.objective,
      scope: projection.scope,
      context: Object.freeze([...projection.context]),
    })
  }

  private projectionAt(task: TaskRecord, revision: number): TaskRecord {
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > task.revision) {
      throw new DevelopmentTaskError('Task revision is unavailable', 'REVISION_NOT_FOUND')
    }
    let projection: TaskRecord | undefined
    for (const entry of task.events.slice(0, revision)) {
      projection = this.projectEntry(projection, entry, 'INVALID_REQUEST')
      projection.events.push(entry)
      projection.revision = entry.revision
      projection.updatedAt = entry.at
    }
    if (projection === undefined) throw new DevelopmentTaskError('Task revision is unavailable', 'REVISION_NOT_FOUND')
    return projection
  }

  private async persistContextBlock(block: DevelopmentTaskContextBlock): Promise<void> {
    try {
      await this.ctx.parallel('development-task/context-persist', block)
    } catch (error) {
      throw new DevelopmentTaskError(`context block persistence failed: ${this.failureMessage(error)}`, 'PERSISTENCE_FAILED', { cause: error })
    }
    this.acceptContextBlock(block, false)
  }

  private acceptContextBlock(block: DevelopmentTaskContextBlock, replica: boolean): void {
    const normalized = this.normalizeBlock(block)
    const retained = this.contextBlocks.get(normalized.id)
    if (retained !== undefined && JSON.stringify(retained.sources) !== JSON.stringify(normalized.sources)) {
      throw new DevelopmentTaskError('same context block id carries different content', 'REPLICA_CONFLICT')
    }
    if (retained === undefined) this.contextBlocks.set(normalized.id, normalized)
    if (replica) this.ctx.logger.debug('development-task: accepted context block %s', normalized.id)
  }

  private normalizeBlock(block: DevelopmentTaskContextBlock): DevelopmentTaskContextBlock {
    const serialized = JSON.stringify({ version: 1, sources: block.sources })
    const expected = `context-${createHash('sha256').update(serialized).digest('hex')}`
    if (block.id !== expected || Buffer.byteLength(serialized, 'utf8') > this.config.maxContextBlockBytes) {
      throw new DevelopmentTaskError('context block digest or size is invalid', 'REPLICA_CONFLICT')
    }
    return this.freezeBlock(block)
  }

  private freezeBlock(block: DevelopmentTaskContextBlock): DevelopmentTaskContextBlock {
    return Object.freeze({
      ...block,
      sources: Object.freeze(block.sources.map(source => Object.freeze({
        ...source,
        parent: Object.freeze({ ...source.parent }),
        context: Object.freeze([...source.context]),
      }))),
    })
  }

  private async publishAssignment(
    bindingId: DevelopmentTaskBindingId,
    participantId: DevelopmentParticipantId,
    change: DevelopmentTaskAssignmentLogEntry['change'],
  ): Promise<DevelopmentTaskAssignment | undefined> {
    const entry = this.freezeAssignmentEntry({
      nodeId: this.nodeId(),
      seq: (this.lastAssignmentSeqByNode.get(this.nodeId()) ?? 0) + 1,
      at: Date.now(),
      bindingId,
      participantId,
      change,
    })
    await this.persistAssignment(entry)
    return this.appendAssignment(entry, { kind: 'local', nodeId: entry.nodeId }, 'INVALID_REQUEST')
  }

  private async persistAssignment(entry: DevelopmentTaskAssignmentLogEntry): Promise<void> {
    try {
      await this.ctx.parallel('development-task/assignment-persist', entry)
    } catch (error) {
      throw new DevelopmentTaskError(`assignment persistence failed: ${this.failureMessage(error)}`, 'PERSISTENCE_FAILED', { cause: error })
    }
  }

  private appendAssignment(
    entry: DevelopmentTaskAssignmentLogEntry,
    origin: DevelopmentTaskEventOrigin,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): DevelopmentTaskAssignment | undefined {
    const lastSeq = this.lastAssignmentSeqByNode.get(entry.nodeId) ?? 0
    if (entry.seq <= lastSeq) {
      const retained = this.assignmentEntries.find(item => item.nodeId === entry.nodeId && item.seq === entry.seq)
      if (retained === undefined || JSON.stringify(retained) !== JSON.stringify(entry)) {
        throw new DevelopmentTaskError('same assignment event identity carries different content', 'REPLICA_CONFLICT')
      }
      return this.assignments.get(entry.bindingId)
    }
    if (entry.seq !== lastSeq + 1) throw new DevelopmentTaskError('assignment event sequence has a gap', code)
    const participant = this.ctx.developmentRooms.list().participants.find(item => item.id === entry.participantId)
    if (participant !== undefined && participant.nodeId !== entry.nodeId) {
      throw new DevelopmentTaskError('assignment event is not authored by the participant home node', code)
    }
    const current = this.assignments.get(entry.bindingId)
    if (current !== undefined && current.participantId !== entry.participantId) {
      throw new DevelopmentTaskError('Task binding participant changed', code)
    }
    let assignment: DevelopmentTaskAssignment | undefined
    switch (entry.change.kind) {
      case 'task-bound':
        this.requireTask(entry.change.taskId)
        assignment = Object.freeze({
          bindingId: entry.bindingId,
          participantId: entry.participantId,
          taskId: entry.change.taskId,
          ...(entry.change.sessionLabel === undefined ? {} : { sessionLabel: entry.change.sessionLabel }),
          assignedAt: entry.at,
        })
        this.assignments.set(entry.bindingId, assignment)
        break
      case 'task-cleared':
        if (current?.taskId !== entry.change.previousTaskId) throw new DevelopmentTaskError('assignment clear does not match current Task', code)
        this.assignments.delete(entry.bindingId)
        break
      case 'context-acknowledged':
        if (current?.taskId !== entry.change.taskId || entry.change.revision < (current.acknowledgedRevision ?? 0)) {
          throw new DevelopmentTaskError('context acknowledgement does not match current assignment', code)
        }
        assignment = Object.freeze({ ...current, acknowledgedRevision: entry.change.revision })
        this.assignments.set(entry.bindingId, assignment)
        break
      default: return this.assertNever(entry.change)
    }
    this.assignmentEntries.push(entry)
    this.lastAssignmentSeqByNode.set(entry.nodeId, entry.seq)
    this.ctx.emit('development-task/assignment-changed', assignment, entry, origin)
    return assignment
  }

  private snapshot(task: TaskRecord): DevelopmentTaskSnapshot {
    const room = this.ctx.developmentRooms.list().rooms.find(item => item.id === task.hiddenRoomId)
    return Object.freeze({
      id: task.id,
      ownerNodeId: task.ownerNodeId,
      revision: task.revision,
      origin: task.origin,
      hiddenRoomId: task.hiddenRoomId,
      runtime: room === undefined ? 'degraded' : 'ready',
      objective: task.objective,
      scope: task.scope,
      createdBy: task.createdBy,
      context: Object.freeze([...task.context]),
      ...(task.inheritedContextBlockId === undefined ? {} : { inheritedContextBlockId: task.inheritedContextBlockId }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })
  }

  private requireTask(id: DevelopmentTaskId): TaskRecord {
    const task = this.tasks.get(id)
    if (task === undefined) throw new DevelopmentTaskError('Task not found', 'TASK_NOT_FOUND')
    return task
  }

  private async routeOwner(
    task: TaskRecord,
    command: Parameters<TaskOwnerRouter['route']>[1],
  ): Promise<DevelopmentTaskSnapshot> {
    const router = this.ctx.get('developmentTaskMesh') as TaskOwnerRouter | undefined
    if (router === undefined) throw new DevelopmentTaskError('remote Task owner is unavailable for mutation', 'RUNTIME_UNAVAILABLE')
    try { return await router.route(task.ownerNodeId, command) } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string') throw new DevelopmentTaskError(this.failureMessage(error), code as TaskErrorCode, { cause: error })
      throw new DevelopmentTaskError(this.failureMessage(error), 'RUNTIME_UNAVAILABLE', { cause: error })
    }
  }

  private async joinRoom(request: Parameters<RoomOwnerRouter['join']>[0]): Promise<void> {
    const router = this.ctx.get('developmentRoomMesh') as RoomOwnerRouter | undefined
    if (router === undefined) await this.ctx.developmentRooms.join(request)
    else await router.join(request)
  }

  private async leaveRoom(request: Parameters<RoomOwnerRouter['leave']>[0]): Promise<void> {
    const router = this.ctx.get('developmentRoomMesh') as RoomOwnerRouter | undefined
    if (router === undefined) await this.ctx.developmentRooms.leave(request)
    else await router.leave(request)
  }

  private requireKnownParticipant(id: DevelopmentParticipantId): void {
    if (!this.ctx.developmentRooms.list().participants.some(participant => participant.id === id)) {
      throw new DevelopmentTaskError('Task participant is not announced', 'PARTICIPANT_NOT_AVAILABLE')
    }
  }

  private participantBoundToTask(
    participantId: DevelopmentParticipantId,
    taskId: DevelopmentTaskId,
    excludedBindingId?: DevelopmentTaskBindingId,
  ): boolean {
    return [...this.assignments.values()].some(binding => binding.bindingId !== excludedBindingId
      && binding.participantId === participantId && binding.taskId === taskId)
  }

  private canRestore(entry: DevelopmentTaskLogEntry): boolean {
    if (entry.seq !== (this.lastSeqByNode.get(entry.nodeId) ?? 0) + 1) return false
    if (entry.change.kind !== 'task-created') return this.tasks.has(entry.taskId)
    if (entry.change.inheritedContextBlockId !== undefined && !this.contextBlocks.has(entry.change.inheritedContextBlockId)) return false
    return this.parentRefsFromOrigin(entry.change.origin).every((parent) => {
      const task = this.tasks.get(parent.taskId)
      return task !== undefined && task.revision >= parent.revision
    })
  }

  private normalizeEntry(entry: DevelopmentTaskLogEntry): DevelopmentTaskLogEntry {
    if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || !Number.isSafeInteger(entry.at) || entry.at < 0) {
      throw new DevelopmentTaskError('Task event sequence, revision, or timestamp is invalid', 'REPLICA_CONFLICT')
    }
    return this.freezeEntry(entry)
  }

  private freezeEntry(entry: DevelopmentTaskLogEntry): DevelopmentTaskLogEntry {
    return Object.freeze({ ...entry, change: Object.freeze({ ...entry.change }) })
  }

  private freezeAssignmentEntry(entry: DevelopmentTaskAssignmentLogEntry): DevelopmentTaskAssignmentLogEntry {
    if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || !Number.isSafeInteger(entry.at) || entry.at < 0) {
      throw new DevelopmentTaskError('assignment event sequence or timestamp is invalid', 'REPLICA_CONFLICT')
    }
    if (entry.bindingId.trim() === '') throw new DevelopmentTaskError('binding id must not be blank', 'REPLICA_CONFLICT')
    return Object.freeze({ ...entry, change: Object.freeze({ ...entry.change }) })
  }

  private hiddenRoomId(taskId: DevelopmentTaskId): DevelopmentRoomId {
    return `room-${taskId.slice('task-'.length)}` as DevelopmentRoomId
  }

  private parentRefs(task: TaskRecord): readonly DevelopmentTaskParentRef[] { return this.parentRefsFromOrigin(task.origin) }

  private parentRefsFromOrigin(origin: DevelopmentTaskOrigin): readonly DevelopmentTaskParentRef[] {
    return origin.kind === 'root' ? [] : origin.kind === 'fork' ? [origin.parent] : origin.parents
  }

  private nodeId(): DevelopmentNodeId { return this.ctx.developmentRooms.list().nodeId }

  private text(value: string, field: string): string {
    const result = value.trim()
    if (result.length === 0) throw new DevelopmentTaskError(`${field} must not be blank`, 'INVALID_REQUEST')
    if (Buffer.byteLength(result, 'utf8') > this.config.maxTextBytes) {
      throw new DevelopmentTaskError(`${field} exceeds maxTextBytes`, 'LIMIT_EXCEEDED')
    }
    return result
  }

  private limit(value: number | undefined, fallback: number): number {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > this.config.maxLineageTasks) {
      throw new DevelopmentTaskError(`limit must be between 1 and ${String(this.config.maxLineageTasks)}`, 'INVALID_REQUEST')
    }
    return resolved
  }

  private depth(value: number | undefined, fallback: number): number {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 32) {
      throw new DevelopmentTaskError('lineage depth must be an integer between 0 and 32', 'INVALID_REQUEST')
    }
    return resolved
  }

  private walkLineage(
    start: readonly DevelopmentTaskId[],
    depth: number,
    selected: Set<DevelopmentTaskId>,
    boundary: Set<DevelopmentTaskId>,
    limit: number,
    next: (taskId: DevelopmentTaskId) => readonly DevelopmentTaskId[],
  ): void {
    let frontier = [...start]
    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const following: DevelopmentTaskId[] = []
      for (const taskId of frontier) {
        for (const candidate of next(taskId)) {
          if (selected.has(candidate)) continue
          if (selected.size >= limit) boundary.add(candidate)
          else {
            selected.add(candidate)
            following.push(candidate)
          }
        }
      }
      frontier = following
    }
    for (const taskId of frontier) for (const candidate of next(taskId)) if (!selected.has(candidate)) boundary.add(candidate)
  }

  private enqueue<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private failureMessage(error: unknown): string {
    if (error instanceof AggregateError) return error.errors.map(item => this.failureMessage(item)).join('; ')
    if (error instanceof Error) return error.message
    return String(error)
  }

  private assertNever(value: never): never {
    throw new DevelopmentTaskError(`unsupported Task discriminant: ${JSON.stringify(value)}`, 'INVALID_REQUEST')
  }
}

/** Typed Remote facade that keeps assignment endpoints separate from Task projections. */
export class DevelopmentTaskAssignmentRemoteService extends TypertRemoteService {
  /**
   * Bind assignment RPC methods to an existing authoritative Task service.
   * @param ctx - Host Cordis context.
   * @param tasks - authoritative Task and assignment service.
   */
  constructor(ctx: Context, private readonly tasks: DevelopmentTaskService) {
    super(ctx, 'developmentTaskAssignments')
  }

  /**
   * Read the authoritative Agent-session Task bindings.
   * @returns all current bindings ordered by participant and binding identity.
   */
  @Remote('list')
  list(): readonly DevelopmentTaskAssignment[] { return this.tasks.assignmentList() }

  /**
   * Commit one Agent session's Task before best-effort Room reconciliation.
   * @param request - target Task, local online Agent, and optional binding identity.
   * @returns assignment, context, and independent Room outcomes.
   */
  @Remote('checkout')
  checkout(request: DevelopmentTaskCheckoutRequest): Promise<DevelopmentTaskCheckoutResult> {
    return this.tasks.checkout(request)
  }

  /**
   * Clear one Agent session's Task binding.
   * @param request - binding and owning Agent participant.
   * @returns resolution after durable assignment commit.
   */
  @Remote('clear')
  clear(request: DevelopmentTaskClearRequest): Promise<void> { return this.tasks.clear(request) }

  /**
   * Record context delivery for one Agent-session binding.
   * @param request - binding, Agent, Task, and delivered revision.
   * @returns updated assignment.
   */
  @Remote('acknowledge')
  acknowledge(request: DevelopmentTaskAcknowledgeRequest): Promise<DevelopmentTaskAssignment> {
    return this.tasks.acknowledge(request)
  }
}

export default DevelopmentTaskService
