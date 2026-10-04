/** Durable Task DAG, explicit shared context, and isolated Agent-session bindings. */

import { createHash, randomUUID } from 'node:crypto'
import { localContributionId, localContributionPayloadDigest, localContributionPublicationId, freezeLocalGrant, localPublication, localPublicationRequest, localWithdrawal } from './local.ts'
export { localContributionId, localContributionPayloadDigest, localContributionPublicationId } from './local.ts'
import { isDeepStrictEqual } from 'node:util'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { freezePeerGrant, peerPublication, peerPublicationRequest, peerWithdrawals, peerContributionPayloadDigest, peerContributionPublicationId } from './peer.ts'
export { peerContributionPayloadDigest, peerContributionPublicationId, peerContributionArtifactId } from './peer.ts'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-development-room'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { freezePublication, observationChainKey, observationHeads, observedIntervalId } from './observation.ts'
import { developmentTaskOpenApiObservationSchema, peerContributionGrantSchema, peerContributionRequestSchema,
  localContributionGrantSchema, localContributionRequestSchema } from './schema.ts'
export { observedIntervalId } from './observation.ts'
import type {
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionId, DevelopmentTaskLocalContribution,
  DevelopmentTaskLocalContributionReceipt, DevelopmentTaskLocalContributionRequest, DevelopmentTaskLocalContributionResult,
  DevelopmentTaskEndLocalContributionRequest,
  DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContribution, DevelopmentTaskPeerContributionReceipt,
  DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerContributionResult, DevelopmentTaskEndPeerContributionRequest,
  DevelopmentTaskContributionGrantId, DevelopmentTaskContributionEndReason,
  DevelopmentTaskAcknowledgeRequest,
  DevelopmentTaskAdmitObservedContextRequest,
  DevelopmentTaskAdmitObservedContextResult,
  DevelopmentTaskRevokeObservedArtifactRequest,
  DevelopmentTaskOpenApiObservation,
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
  DevelopmentTaskObservedIntervalId,
  DevelopmentTaskObservedIntervalIdentity,
  DevelopmentTaskObservedInterval,
  DevelopmentTaskObservedReceipt,
  DevelopmentTaskApproveObservedIntervalRequest,
  DevelopmentTaskEndObservedIntervalRequest,
  DevelopmentTaskAdmitRemoteObservedContextRequest,
  DevelopmentTaskAdmitRemoteObservedContextResult,
  DevelopmentTaskOwnerCommand,
  DevelopmentTaskOwnerCommandResult,
  DevelopmentTaskObservedSourceId,
  DevelopmentTaskObservedCandidate,
} from './types.ts'

export type {
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionId, DevelopmentTaskLocalContribution,
  DevelopmentTaskLocalContributionReceipt, DevelopmentTaskLocalContributionRequest, DevelopmentTaskLocalContributionResult,
  DevelopmentTaskEndLocalContributionRequest, DevelopmentTaskLocalContributionAdmissionReceipt,
  DevelopmentTaskLocalContributionMetadata, DevelopmentTaskLocalToolObservation,
  DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContribution, DevelopmentTaskPeerContributionReceipt,
  DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerContributionResult, DevelopmentTaskEndPeerContributionRequest,
  DevelopmentTaskContributionGrantId, DevelopmentTaskContributionEndReason,
  DevelopmentTaskContributionGeneration, DevelopmentTaskCaptureId, DevelopmentTaskCaptureGeneration,
  DevelopmentTaskContributionSource, DevelopmentTaskOpenApiContributionSource, DevelopmentTaskToolObservationSource,
  DevelopmentTaskToolObservationResult, DevelopmentTaskPeerToolObservation, DevelopmentTaskPeerOpenApiObservation,
  DevelopmentTaskPeerContributionMetadata,
  DevelopmentTaskPeerContributionAdmissionReceipt,
  DevelopmentTaskId,
  DevelopmentTaskContextBlockId,
  DevelopmentTaskBindingId,
  DevelopmentTaskObservedSourceId,
  DevelopmentTaskArtifactId,
  DevelopmentTaskArtifactGrantId,
  DevelopmentTaskOpenApiFacts,
  DevelopmentTaskOpenApiObservationIdentity,
  DevelopmentTaskOpenApiObservationResult,
  DevelopmentTaskOpenApiObservationInput,
  DevelopmentTaskOpenApiObservation,
  DevelopmentTaskRevokeObservedArtifactRequest,
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
  DevelopmentTaskAdmitObservedContextRequest,
  DevelopmentTaskAdmitObservedContextResult,
  DevelopmentTaskAssignment,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskCheckoutRequest,
  DevelopmentTaskClearRequest,
  DevelopmentTaskAcknowledgeRequest,
  DevelopmentTaskContextView,
  DevelopmentTaskCheckoutResult,
  DevelopmentTaskEventOrigin,
  DevelopmentTaskObservedIntervalId,
  DevelopmentTaskObservedCandidate,
  DevelopmentTaskObservedIntervalIdentity,
  DevelopmentTaskObservedInterval,
  DevelopmentTaskObservedReceipt,
  DevelopmentTaskApproveObservedIntervalRequest,
  DevelopmentTaskEndObservedIntervalRequest,
  DevelopmentTaskAdmitRemoteObservedContextRequest,
  DevelopmentTaskAdmitRemoteObservedContextResult,
  DevelopmentTaskOwnerCommand,
  DevelopmentTaskOwnerCommandResult,
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentRoomId,
} from './types.ts'

/** Retention and payload bounds for one Task runtime. */
export interface Config {
  /** Maximum Tasks retained by this Host. */
  readonly maxTasks: number
  /** Maximum retained events plus reserved retirement for live artifact grants, remote intervals, peer grants, and local captures. */
  readonly maxEventsPerTask: number
  /** Maximum parent Tasks accepted by Merge. */
  readonly maxMergeParents: number
  /** Maximum serialized inherited-context block bytes. */
  readonly maxContextBlockBytes: number
  /** Maximum Tasks returned by a lineage query. */
  readonly maxLineageTasks: number
  /** Maximum UTF-8 bytes per text field and, separately, per complete observation JSON. */
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
  intervals: ReadonlyMap<DevelopmentTaskObservedIntervalId, DevelopmentTaskObservedInterval>
  contributions: ReadonlyMap<DevelopmentTaskContributionGrantId, DevelopmentTaskPeerContribution>
  localContributions: ReadonlyMap<DevelopmentTaskLocalContributionId, DevelopmentTaskLocalContribution>
  inheritedContextBlockId?: DevelopmentTaskContextBlockId
  events: DevelopmentTaskLogEntry[]
  createdAt: number
  updatedAt: number
}

interface TaskOwnerRouter {
  route<C extends DevelopmentTaskOwnerCommand>(ownerNodeId: DevelopmentNodeId, command: C): Promise<DevelopmentTaskOwnerCommandResult<C>>
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
   * Approve one exact remote binding on its Task owner; Mesh membership alone grants no observation interval.
   * This approval attests the named source identity, not a read of its private files or its current assignment replica.
   * @param request - remote Agent identity and binding epoch explicitly selected by the local owner.
   * @returns original approval or a newly committed active interval; ended identities cannot reopen.
   */
  @Remote('approveObservedInterval')
  approveObservedInterval(request: DevelopmentTaskApproveObservedIntervalRequest): Promise<DevelopmentTaskObservedInterval> {
    return this.enqueue(async () => {
      const task = this.requireOwnedTask(request.taskId)
      const identity = this.intervalIdentity(request)
      const id = observedIntervalId(identity)
      const retained = task.intervals.get(id)
      if (retained?.state === 'ended') throw new DevelopmentTaskError('observed interval was permanently ended', 'POLICY_REJECTED')
      if (retained !== undefined) return retained
      const participant = this.ctx.developmentRooms.list().participants.find(item => item.id === identity.participantId)
      if (participant?.kind !== 'agent' || participant.nodeId !== identity.sourceNodeId) {
        throw new DevelopmentTaskError('observed interval requires a known Agent on the named source node', 'PARTICIPANT_NOT_AVAILABLE')
      }
      this.text(this.intervalNoticeText(id), 'interval withdrawal')
      await this.publish(task.id, task.hiddenRoomId, { kind: 'observed-interval-opened', interval: identity })
      return this.requireInterval(this.requireTask(task.id), id)
    })
  }

  /**
   * Read authoritative observation approvals and terminal receipts, including on a remote Task owner.
   * @param request - Task whose source intervals are requested.
   * @returns committed intervals; the trusted Mesh still exposes all Task context to its members.
   */
  @Remote('observedIntervals')
  async observedIntervals(request: DevelopmentTaskGetRequest): Promise<readonly DevelopmentTaskObservedInterval[]> {
    const task = this.requireTask(request.taskId)
    if (task.ownerNodeId !== this.nodeId()) return await this.routeOwner(task, { method: 'observedIntervals', request })
    return Object.freeze([...task.intervals.values()])
  }

  /**
   * List replicated remote Agent bindings that the local Task owner may explicitly approve.
   * A candidate identifies a binding, not a verified Claude request or private-file permission.
   * @param request - locally owned Task whose current remote assignments are inspected.
   * @returns source identities with their replicated session labels; replication can delay discovery.
   */
  @Remote('observedCandidates')
  observedCandidates(request: DevelopmentTaskGetRequest): readonly DevelopmentTaskObservedCandidate[] {
    this.requireOwnedTask(request.taskId)
    return Object.freeze([...this.assignments.values()].flatMap((assignment) => {
      if (assignment.taskId !== request.taskId) return []
      const bound = this.assignmentEntries.findLast(entry => entry.bindingId === assignment.bindingId && entry.change.kind === 'task-bound')
      const participant = this.ctx.developmentRooms.list().participants.find(item => item.id === assignment.participantId)
      if (bound === undefined || bound.nodeId === this.nodeId() || participant?.kind !== 'agent' || participant.nodeId !== bound.nodeId) return []
      return [Object.freeze({
        taskId: request.taskId, sourceNodeId: bound.nodeId, participantId: assignment.participantId,
        bindingId: assignment.bindingId, expectedBindingEpoch: Object.freeze({ nodeId: bound.nodeId, seq: bound.seq }),
        ...(assignment.sessionLabel === undefined ? {} : { sessionLabel: assignment.sessionLabel }),
      })]
    }))
  }

  /**
   * Route a filtered local observation to the remote Task owner using the current Host's Mesh identity.
   * The caller checks local capture authorization and binding currency; the owner checks its approved interval.
   * @param request - exact approved interval, source digest, and locally authorized content.
   * @returns the publication and receipt of its original durable owner admission.
   */
  async admitObservedRemote(
    request: DevelopmentTaskAdmitRemoteObservedContextRequest,
  ): Promise<DevelopmentTaskAdmitRemoteObservedContextResult> {
    const task = this.requireTask(request.taskId)
    if (task.ownerNodeId === this.nodeId()) return await this.acceptObservedRemote(request, this.nodeId())
    return await this.routeOwner(task, { method: 'admitObservedRemote', request })
  }

  /**
   * Admit a Mesh observation using transport-owned identity; this Host method exposes no Remote endpoint.
   * @param request - wire-validated observation and owner approval reference.
   * @param sourceNodeId - peer supplied by the Mesh dispatcher, never by the request JSON.
   * @returns the original durable receipt for a matching retry, including after interval termination.
   */
  acceptObservedRemote(
    request: DevelopmentTaskAdmitRemoteObservedContextRequest, sourceNodeId: DevelopmentNodeId,
  ): Promise<DevelopmentTaskAdmitRemoteObservedContextResult> {
    return this.enqueue(async () => {
      const task = this.requireOwnedTask(request.taskId)
      const interval = this.requireInterval(task, request.intervalId)
      if (sourceNodeId !== interval.sourceNodeId || request.participantId !== interval.participantId
        || request.bindingId !== interval.bindingId || request.expectedBindingEpoch.nodeId !== interval.expectedBindingEpoch.nodeId
        || request.expectedBindingEpoch.seq !== interval.expectedBindingEpoch.seq) {
        throw new DevelopmentTaskError('remote observation does not match its approved source and binding', 'POLICY_REJECTED')
      }
      const publication = this.observedPublication(request, sourceNodeId, request.intervalId)
      if (publication.observation?.state === 'revoked') {
        throw new DevelopmentTaskError('remote artifact retirement requires interval termination', 'INVALID_REQUEST')
      }
      const retained = task.context.find(item => item.id === publication.id)
      if (retained !== undefined) {
        this.requireSameObservation(retained, publication)
        return this.remoteAdmission(task, interval.id, retained, 'reused')
      }
      if (interval.state !== 'active') throw new DevelopmentTaskError('observed interval was permanently ended', 'POLICY_REJECTED')
      const observation = publication.observation
      if (observation !== undefined) {
        if (observation.sequence >= Number.MAX_SAFE_INTEGER) {
          throw new DevelopmentTaskError('remote artifact sequence must reserve its terminal successor', 'LIMIT_EXCEEDED')
        }
        const withdrawal = this.withdrawal(publication, interval.id, publication.publishedAt)
        if (Buffer.byteLength(JSON.stringify(withdrawal.observation), 'utf8') > this.config.maxTextBytes) {
          throw new DevelopmentTaskError('remote artifact must fit its complete terminal observation', 'LIMIT_EXCEEDED')
        }
      }
      await this.publish(task.id, task.hiddenRoomId, { kind: 'context-published', publication })
      return this.remoteAdmission(this.requireTask(task.id), interval.id, publication, 'published')
    })
  }

  /**
   * End one source interval on its owner, including before an approval arrives.
   * @param request - complete source identity retained before local capture stops.
   * @returns receipt for the original terminal owner event; transport failure does not prove rejection.
   */
  @Remote('endObservedInterval')
  async endObservedInterval(request: DevelopmentTaskEndObservedIntervalRequest): Promise<DevelopmentTaskObservedReceipt> {
    const task = this.requireTask(request.taskId)
    if (task.ownerNodeId !== this.nodeId()) return await this.routeOwner(task, { method: 'endObservedInterval', request })
    return await this.acceptObservedIntervalEnd(request, this.nodeId())
  }

  /**
   * Persist one terminal interval transition and its derived withdrawals using transport-owned source identity.
   * @param request - exact interval identity; a source may end it before the owner approves it.
   * @param sourceNodeId - authenticated source peer or the local Task owner.
   * @returns stable terminal receipt after persistence; late samples cannot reopen this identity.
   */
  acceptObservedIntervalEnd(
    request: DevelopmentTaskEndObservedIntervalRequest, sourceNodeId: DevelopmentNodeId,
  ): Promise<DevelopmentTaskObservedReceipt> {
    return this.enqueue(async () => {
      const task = this.requireOwnedTask(request.taskId)
      const identity = this.intervalIdentity(request)
      if (sourceNodeId !== identity.sourceNodeId && sourceNodeId !== task.ownerNodeId) {
        throw new DevelopmentTaskError('only the approved source or Task owner can end an observed interval', 'POLICY_REJECTED')
      }
      const id = observedIntervalId(identity)
      const retained = task.intervals.get(id)
      if (retained?.state === 'ended') return retained.endReceipt
      this.text(this.intervalNoticeText(id), 'interval withdrawal')
      await this.publish(task.id, task.hiddenRoomId, { kind: 'observed-interval-ended', interval: identity })
      const ended = this.requireInterval(this.requireTask(task.id), id)
      if (ended.state !== 'ended') throw new Error('terminal Task event did not end its interval')
      return ended.endReceipt
    })
  }

  /**
   * Open explicitly authorized tool collection for one current owner-local Agent assignment.
   * @param grant - exact capture, binding epoch, tools, and finite limits retained by the source adapter.
   * @returns original durable local authority; ended captures cannot reopen.
   */
  openLocalContribution(grant: DevelopmentTaskLocalContributionGrant): Promise<DevelopmentTaskLocalContribution> {
    return this.enqueue(async () => {
      const selected = this.parseLocalGrant(grant)
      let task = this.requirePeerTask(selected.taskId)
      const id = localContributionId(selected)
      const prior = task.localContributions.get(id)
      if (prior !== undefined) {
        this.requireSameLocalGrant(prior.grant, selected)
        await this.expireLocalTaskNow(task)
        task = this.requireTask(task.id)
        const current = task.localContributions.get(id)
        if (current?.state !== 'active') throw new DevelopmentTaskError('local capture has permanently ended', 'POLICY_REJECTED')
        this.requireLocalBinding(selected)
        return current
      }
      this.requireLocalBinding(selected)
      this.localGrantBounds(selected)
      if (selected.expiresAt <= Date.now()) throw new DevelopmentTaskError('local capture expiry must be in the future', 'INVALID_REQUEST')
      await this.publish(task.id, task.hiddenRoomId, { kind: 'local-contribution-opened', grant: selected })
      const opened = this.requireTask(task.id).localContributions.get(id)
      if (opened === undefined) throw new Error('local approval event did not retain its grant')
      return opened
    })
  }

  /**
   * Inspect original local capture authority after committing due expiry or binding withdrawal.
   * @param request - exact original local capture permission.
   * @returns current durable authority, never a replacement capture.
   */
  localContributionStatus(request: { readonly grant: DevelopmentTaskLocalContributionGrant }): Promise<DevelopmentTaskLocalContribution> {
    return this.enqueue(async () => {
      const grant = this.parseLocalGrant(request.grant)
      const task = this.requirePeerTask(grant.taskId)
      const prior = task.localContributions.get(localContributionId(grant))
      if (prior === undefined) throw new DevelopmentTaskError('local capture has not been opened', 'POLICY_REJECTED')
      this.requireSameLocalGrant(prior.grant, grant)
      await this.expireLocalTaskNow(task)
      const current = this.requireTask(task.id).localContributions.get(localContributionId(grant))
      if (current === undefined) throw new Error('local capture disappeared after expiry')
      return current
    })
  }

  /**
   * Admit one persisted report for an explicitly authorized local capture.
   * @param request - original structured outbox sample; Task generates text and attribution.
   * @returns its original commit for exact retries, including after termination.
   */
  admitLocalContribution(request: DevelopmentTaskLocalContributionRequest): Promise<DevelopmentTaskLocalContributionResult> {
    return this.enqueue(async () => {
      const parsed = localContributionRequestSchema.safeParse(request)
      if (!parsed.success) throw new DevelopmentTaskError('invalid local tool sample', 'INVALID_REQUEST')
      const sample = parsed.data
      let task = this.requirePeerTask(sample.grant.taskId)
      const id = localContributionId(sample.grant)
      const authority = task.localContributions.get(id)
      if (authority === undefined) throw new DevelopmentTaskError('local capture has not been opened', 'POLICY_REJECTED')
      this.requireSameLocalGrant(authority.grant, sample.grant)
      const previous = task.context.find(item => item.id === localContributionPublicationId(sample))
      if (previous !== undefined) {
        if (localContributionPayloadDigest(localPublicationRequest(previous)) !== localContributionPayloadDigest(sample)) {
          throw new DevelopmentTaskError('local source already carries different content', 'INVALID_REQUEST')
        }
        return this.localAdmission(task, previous, 'reused')
      }
      await this.expireLocalTaskNow(task)
      task = this.requireTask(task.id)
      if (task.localContributions.get(id)?.state !== 'active') throw new DevelopmentTaskError('local capture has permanently ended', 'POLICY_REJECTED')
      this.requireLocalBinding(sample.grant)
      this.localSampleBounds(sample)
      const publication = freezePublication(localPublication(sample, Date.now()))
      this.text(publication.text, 'local report')
      await this.publish(task.id, task.hiddenRoomId, { kind: 'context-published', publication })
      return this.localAdmission(this.requireTask(task.id), publication, 'published')
    })
  }

  /**
   * Permanently withdraw a local capture without requiring a live or still-bound source Agent.
   * @param request - original grant and explicit terminal reason; unknown captures receive a tombstone.
   * @returns original durable end receipt; no pending approval can reopen the same capture.
   */
  endLocalContribution(request: DevelopmentTaskEndLocalContributionRequest): Promise<DevelopmentTaskLocalContributionReceipt> {
    return this.enqueue(async () => {
      const grant = this.parseLocalGrant(request.grant)
      const task = this.requirePeerTask(grant.taskId)
      this.requireLocalOrigin(grant)
      return await this.endLocalNow(task, grant, request.reason)
    })
  }

  private parseLocalGrant(input: DevelopmentTaskLocalContributionGrant): DevelopmentTaskLocalContributionGrant {
    const result = localContributionGrantSchema.safeParse(input)
    if (!result.success) throw new DevelopmentTaskError('invalid local capture permission', 'INVALID_REQUEST')
    return freezeLocalGrant(result.data)
  }

  private requireSameLocalGrant(left: DevelopmentTaskLocalContributionGrant, right: DevelopmentTaskLocalContributionGrant): void {
    if (!isDeepStrictEqual(left, right)) throw new DevelopmentTaskError('local capture identity carries different permission', 'INVALID_REQUEST')
  }

  private requireLocalOrigin(grant: DevelopmentTaskLocalContributionGrant): void {
    const bound = this.assignmentEntries.find(entry => entry.nodeId === grant.expectedBindingEpoch.nodeId
      && entry.seq === grant.expectedBindingEpoch.seq && entry.bindingId === grant.bindingId
      && entry.participantId === grant.participantId && entry.change.kind === 'task-bound' && entry.change.taskId === grant.taskId)
    if (bound === undefined || bound.nodeId !== this.nodeId()) {
      throw new DevelopmentTaskError('local capture requires its actual owner binding epoch', 'INVALID_REQUEST')
    }
  }

  private localBindingCurrent(grant: DevelopmentTaskLocalContributionGrant): boolean {
    const assignment = this.assignments.get(grant.bindingId)
    const bound = this.assignmentEntries.findLast(entry => entry.bindingId === grant.bindingId && entry.change.kind === 'task-bound')
    return assignment?.participantId === grant.participantId && assignment.taskId === grant.taskId
      && bound?.nodeId === grant.expectedBindingEpoch.nodeId && bound.seq === grant.expectedBindingEpoch.seq
  }

  private requireLocalBinding(grant: DevelopmentTaskLocalContributionGrant): void {
    this.requireLocalOrigin(grant)
    const participant = this.ctx.developmentRooms.list().participants.find(item => item.id === grant.participantId)
    if (participant?.kind !== 'agent' || participant.nodeId !== this.nodeId() || participant.presence !== 'online'
      || !this.localBindingCurrent(grant)) throw new DevelopmentTaskError('local capture requires its current online Agent binding', 'POLICY_REJECTED')
  }

  private localGrantBounds(grant: DevelopmentTaskLocalContributionGrant): void {
    if (Buffer.byteLength(JSON.stringify(grant), 'utf8') > this.config.maxTextBytes) {
      throw new DevelopmentTaskError('local capture permission exceeds maxTextBytes', 'LIMIT_EXCEEDED')
    }
    this.text(localWithdrawal(grant, 'expired', 0).text, 'local withdrawal')
  }

  private localSampleBounds(request: DevelopmentTaskLocalContributionRequest): void {
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > Math.min(request.grant.maxSampleBytes, this.config.maxTextBytes)) {
      throw new DevelopmentTaskError('complete local sample exceeds its byte limit', 'LIMIT_EXCEEDED')
    }
  }

  private async expireLocalTaskNow(task: TaskRecord): Promise<void> {
    for (const item of task.localContributions.values()) if (item.state === 'active') {
      const reason = item.grant.expiresAt <= Date.now() ? 'expired' : !this.localBindingCurrent(item.grant) ? 'revoked' : undefined
      if (reason !== undefined) await this.endLocalNow(this.requireTask(task.id), item.grant, reason)
    }
  }

  private async endLocalBindingNow(bindingId: DevelopmentTaskBindingId): Promise<void> {
    for (const task of this.tasks.values()) if (task.ownerNodeId === this.nodeId()) {
      for (const item of task.localContributions.values()) if (item.state === 'active' && item.grant.bindingId === bindingId) {
        await this.endLocalNow(this.requireTask(task.id), item.grant, 'revoked')
      }
    }
  }

  private async endLocalNow(task: TaskRecord, grant: DevelopmentTaskLocalContributionGrant,
    reason: DevelopmentTaskContributionEndReason): Promise<DevelopmentTaskLocalContributionReceipt> {
    const prior = task.localContributions.get(localContributionId(grant))
    if (prior !== undefined) {
      this.requireSameLocalGrant(prior.grant, grant)
      if (prior.state === 'ended') return prior.endReceipt
    } else this.localGrantBounds(grant)
    await this.publish(task.id, task.hiddenRoomId, { kind: 'local-contribution-ended', grant, reason })
    const ended = this.requireTask(task.id).localContributions.get(localContributionId(grant))
    if (ended?.state !== 'ended') throw new Error('local end event did not end its capture')
    return ended.endReceipt
  }

  private localReceipt(entry: DevelopmentTaskLogEntry,
    grant: DevelopmentTaskLocalContributionGrant): DevelopmentTaskLocalContributionReceipt {
    const kind = entry.change.kind
    if (kind !== 'local-contribution-opened' && kind !== 'local-contribution-ended' && kind !== 'context-published') {
      throw new Error('local receipt requires an original contribution event')
    }
    return Object.freeze({ taskId: grant.taskId, ownerNodeId: entry.nodeId, intervalId: localContributionId(grant),
      participantId: grant.participantId, bindingId: grant.bindingId, expectedBindingEpoch: grant.expectedBindingEpoch,
      captureId: grant.captureId, captureGeneration: grant.captureGeneration, revision: entry.revision,
      event: Object.freeze({ nodeId: entry.nodeId, seq: entry.seq, kind }) })
  }

  private localAdmission(task: TaskRecord, publication: DevelopmentTaskContextPublication,
    outcome: 'published' | 'reused'): DevelopmentTaskLocalContributionResult {
    const entry = task.events.find(item => item.change.kind === 'context-published' && item.change.publication.id === publication.id)
    if (entry === undefined) throw new Error('local publication has no owner admission event')
    const sample = localPublicationRequest(publication)
    return Object.freeze({ outcome, publication, receipt: Object.freeze({ ...this.localReceipt(entry, sample.grant),
      sourceId: sample.sourceId, sequence: sample.sequence,
      payloadDigest: localContributionPayloadDigest(sample), publicationId: publication.id }) })
  }

  /**
   * Approve one independent peer's exact capture and source on a local Root Task.
   * @param grant - immutable authorization supplied by the authenticated local owner facade.
   * @returns original durable approval; a terminal grant or capture generation cannot reopen.
   */
  openPeerContribution(grant: DevelopmentTaskPeerContributionGrant): Promise<DevelopmentTaskPeerContribution> {
    return this.enqueue(async () => {
      const approved = this.parsePeerGrant(grant)
      const task = this.requirePeerTask(approved.taskId)
      const prior = task.contributions.get(approved.grantId)
      if (prior !== undefined) {
        this.requireSamePeerGrant(prior.grant, approved)
        if (prior.state === 'ended') throw new DevelopmentTaskError('peer contribution has permanently ended', 'POLICY_REJECTED')
        if (approved.expiresAt <= Date.now()) {
          await this.endPeerNow(task, approved, 'expired')
          throw new DevelopmentTaskError('peer contribution has expired', 'POLICY_REJECTED')
        }
        return prior
      }
      this.peerGrantBounds(approved)
      if (approved.expiresAt <= Date.now()) throw new DevelopmentTaskError('peer contribution expiry must be in the future', 'INVALID_REQUEST')
      await this.publish(task.id, task.hiddenRoomId, { kind: 'peer-contribution-opened', grant: approved })
      const opened = this.requireTask(task.id).contributions.get(approved.grantId)
      if (opened === undefined) throw new Error('peer approval event did not retain its grant')
      return opened
    })
  }

  /**
   * Inspect local owner contribution authority without implying current online peer authorization.
   * @param request - optional local Root Task; omitted selects only locally owned Tasks.
   * @returns immutable authority derived from Task commits; callers reconcile expiry before use.
   */
  peerContributions(request: { readonly taskId?: DevelopmentTaskId }): readonly DevelopmentTaskPeerContribution[] {
    const tasks = request.taskId === undefined
      ? [...this.tasks.values()].filter(task => task.ownerNodeId === this.nodeId()) : [this.requirePeerTask(request.taskId)]
    return Object.freeze(tasks.flatMap(task => [...task.contributions.values()]))
  }

  /**
   * End all due local contribution grants through the same queue as admission.
   * @param request - optional locally owned Task of any origin; omitted never mutates Mesh replicas.
   * @returns after every due terminal event is durable; read consumers await this before projection.
   */
  expirePeerContributions(request: { readonly taskId?: DevelopmentTaskId }): Promise<void> {
    return this.enqueue(async () => {
      const tasks = request.taskId === undefined
        ? [...this.tasks.values()].filter(task => task.ownerNodeId === this.nodeId()) : [this.requireOwnedTask(request.taskId)]
      for (const task of tasks) await this.expirePeerTaskNow(task)
    })
  }

  private async expirePeerTaskNow(task: TaskRecord): Promise<void> {
    for (const item of task.contributions.values()) {
      if (item.state === 'active' && item.grant.expiresAt <= Date.now()) {
        await this.endPeerNow(this.requireTask(task.id), item.grant, 'expired')
      }
    }
  }

  /**
   * Accept one exact sample from an authenticated contributor without Room membership.
   * @param request - persisted outbox sample; text and provenance remain owner-controlled.
   * @param authenticatedPeerId - transport-owned peer identity, never a JSON assertion.
   * @returns original receipt for identical retries, including after termination; new terminal samples fail.
   */
  admitPeerContribution(
    request: DevelopmentTaskPeerContributionRequest, authenticatedPeerId: ScopePeerId,
  ): Promise<DevelopmentTaskPeerContributionResult> {
    return this.enqueue(async () => {
      const parsed = peerContributionRequestSchema.safeParse(request)
      if (!parsed.success) throw new DevelopmentTaskError('invalid peer contribution sample', 'INVALID_REQUEST')
      const sample = parsed.data
      let task = this.requirePeerTask(sample.grant.taskId)
      const retained = task.contributions.get(sample.grant.grantId)
      if (retained === undefined || sample.grant.contributorPeerId !== authenticatedPeerId) {
        throw new DevelopmentTaskError('peer contribution is not authorized for this sender', 'POLICY_REJECTED')
      }
      this.requireSamePeerGrant(retained.grant, sample.grant)
      const previous = task.context.find(item => item.id === peerContributionPublicationId(sample))
      if (previous !== undefined) {
        if (peerContributionPayloadDigest(peerPublicationRequest(previous)) !== peerContributionPayloadDigest(sample)) {
          throw new DevelopmentTaskError('peer source already carries different content', 'INVALID_REQUEST')
        }
        return this.peerAdmission(task, previous, 'reused')
      }
      if (retained.state === 'active' && retained.grant.expiresAt <= Date.now()) {
        await this.endPeerNow(task, retained.grant, 'expired')
        task = this.requireTask(task.id)
      }
      if (task.contributions.get(sample.grant.grantId)?.state !== 'active') {
        throw new DevelopmentTaskError('peer contribution has permanently ended', 'POLICY_REJECTED')
      }
      this.peerSampleBounds(sample)
      const publication = freezePublication(peerPublication(sample, Date.now()))
      this.text(publication.text, 'peer report')
      this.peerTerminalBounds(sample.grant, publication)
      await this.publish(task.id, task.hiddenRoomId, { kind: 'context-published', publication })
      return this.peerAdmission(this.requireTask(task.id), publication, 'published')
    })
  }

  /**
   * End source evidence, including a delayed approval identified by its complete grant.
   * @param request - exact grant; only its owner may revoke, while its contributor may leave.
   * @param authenticatedPeerId - local owner identity or transport-authenticated source.
   * @returns original terminal receipt; repeated termination does not advance Task revision.
   */
  endPeerContribution(
    request: DevelopmentTaskEndPeerContributionRequest, authenticatedPeerId: ScopePeerId,
  ): Promise<DevelopmentTaskPeerContributionReceipt> {
    return this.enqueue(async () => {
      const grant = this.parsePeerGrant(request.grant)
      const task = this.requirePeerTask(grant.taskId)
      if (authenticatedPeerId !== grant.ownerPeerId
        && (authenticatedPeerId !== grant.contributorPeerId || request.reason !== 'left')) {
        throw new DevelopmentTaskError('only the authorized contributor or owner can end this grant', 'POLICY_REJECTED')
      }
      const retained = task.contributions.get(grant.grantId)
      if (retained !== undefined) {
        this.requireSamePeerGrant(retained.grant, grant)
        if (retained.state === 'ended') return retained.endReceipt
      }
      this.peerGrantBounds(grant)
      return await this.endPeerNow(task, grant, request.reason)
    })
  }

  private peerSampleBounds(sample: DevelopmentTaskPeerContributionRequest): void {
    if (Buffer.byteLength(JSON.stringify(sample), 'utf8') > Math.min(sample.grant.maxSampleBytes, this.config.maxTextBytes)) {
      throw new DevelopmentTaskError('complete peer sample exceeds its byte limit', 'LIMIT_EXCEEDED')
    }
  }

  private peerTerminalBounds(grant: DevelopmentTaskPeerContributionGrant, previous?: DevelopmentTaskContextPublication): void {
    for (const item of peerWithdrawals(grant, previous, 'expired', 0)) {
      this.text(item.text, 'peer withdrawal')
      if (item.peerObservation !== undefined && Buffer.byteLength(JSON.stringify(item.peerObservation), 'utf8') > this.config.maxTextBytes) {
        throw new DevelopmentTaskError('peer withdrawal exceeds maxTextBytes', 'LIMIT_EXCEEDED')
      }
    }
  }

  private async endPeerNow(
    task: TaskRecord, grant: DevelopmentTaskPeerContributionGrant, reason: DevelopmentTaskContributionEndReason,
  ): Promise<DevelopmentTaskPeerContributionReceipt> {
    const retained = task.contributions.get(grant.grantId)
    if (retained !== undefined) {
      this.requireSamePeerGrant(retained.grant, grant)
      if (retained.state === 'ended') return retained.endReceipt
    }
    await this.publish(task.id, task.hiddenRoomId, { kind: 'peer-contribution-ended', grant, reason })
    const ended = this.requireTask(task.id).contributions.get(grant.grantId)
    if (ended?.state !== 'ended') throw new Error('peer terminal event did not end its grant')
    return ended.endReceipt
  }

  private peerReceipt(entry: DevelopmentTaskLogEntry, grant: DevelopmentTaskPeerContributionGrant): DevelopmentTaskPeerContributionReceipt {
    const kind = entry.change.kind
    if (kind !== 'peer-contribution-opened' && kind !== 'peer-contribution-ended' && kind !== 'context-published') {
      throw new Error('peer receipt requires an original contribution event')
    }
    return Object.freeze({ taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
      grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration,
      revision: entry.revision, event: Object.freeze({ nodeId: entry.nodeId, seq: entry.seq, kind }),
    })
  }

  private peerAdmission(
    task: TaskRecord, publication: DevelopmentTaskContextPublication, outcome: 'published' | 'reused',
  ): DevelopmentTaskPeerContributionResult {
    const entry = task.events.find(item => item.change.kind === 'context-published' && item.change.publication.id === publication.id)
    if (entry === undefined) throw new Error('peer publication has no owner admission event')
    const sample = peerPublicationRequest(publication)
    return Object.freeze({ outcome, publication, receipt: Object.freeze({ ...this.peerReceipt(entry, sample.grant),
      sourceId: sample.sourceId, sequence: sample.sequence, payloadDigest: peerContributionPayloadDigest(sample),
      publicationId: publication.id,
    }) })
  }

  private requirePeerTask(id: DevelopmentTaskId): TaskRecord {
    const task = this.requireOwnedTask(id)
    if (task.origin.kind !== 'root') throw new DevelopmentTaskError('peer contribution requires a Root Task', 'POLICY_REJECTED')
    return task
  }

  private parsePeerGrant(input: DevelopmentTaskPeerContributionGrant): DevelopmentTaskPeerContributionGrant {
    const result = peerContributionGrantSchema.safeParse(input)
    if (!result.success || result.data.ownerPeerId === result.data.contributorPeerId) {
      throw new DevelopmentTaskError('peer contribution grant is invalid', 'INVALID_REQUEST')
    }
    return freezePeerGrant(result.data)
  }

  private peerGrantBounds(grant: DevelopmentTaskPeerContributionGrant): void {
    if (Buffer.byteLength(JSON.stringify(grant), 'utf8') > this.config.maxTextBytes) {
      throw new DevelopmentTaskError('peer grant exceeds maxTextBytes', 'LIMIT_EXCEEDED')
    }
    this.peerTerminalBounds(grant)
  }

  private requireSamePeerGrant(retained: DevelopmentTaskPeerContributionGrant, candidate: DevelopmentTaskPeerContributionGrant): void {
    if (!isDeepStrictEqual(retained, candidate)) {
      throw new DevelopmentTaskError('peer grant identity carries different authorization', 'INVALID_REQUEST')
    }
  }

  /**
   * Admit a caller-authorized observation for a still-current local binding.
   * The serialized operation checks ownership and binding before looking up prior admission.
   * Callers own capture permission and source identity; this Host method exposes no Remote endpoint.
   * @param request - local Task, Agent binding interval, source digest, filtered text, and optional reader evidence.
   * @returns current Task and the original publication, after persistence for a new source.
   * @throws for a nonlocal Task, unavailable local Agent, stale binding, invalid digest, conflicting source, or publication limits.
   */
  admitObservedContext(request: DevelopmentTaskAdmitObservedContextRequest): Promise<DevelopmentTaskAdmitObservedContextResult> {
    return this.enqueue(() => this.admitObservedNow(request, false))
  }

  /**
   * Revoke a previously admitted artifact chain without requiring its Agent to remain online or bound.
   * This Host-only method proves the original publisher, binding interval, artifact, and grant from Task history.
   * @param request - terminal observation and the binding identity used by its earlier samples.
   * @returns original or newly persisted revocation publication.
   * @throws when the chain is absent, mismatched, already ended by another source, or cannot fit its reserved event.
   */
  revokeObservedArtifact(request: DevelopmentTaskRevokeObservedArtifactRequest): Promise<DevelopmentTaskAdmitObservedContextResult> {
    return this.enqueue(() => this.admitObservedNow(request, true))
  }

  private async admitObservedNow(
    request: DevelopmentTaskAdmitObservedContextRequest | DevelopmentTaskRevokeObservedArtifactRequest,
    revoking: boolean,
  ): Promise<DevelopmentTaskAdmitObservedContextResult> {
    const task = this.requireTask(request.taskId)
    if (task.ownerNodeId !== this.nodeId()) {
      throw new DevelopmentTaskError('observed context requires a locally owned Task', 'POLICY_REJECTED')
    }
    if (!revoking) {
      const participant = this.ctx.developmentRooms.list().participants.find(item => item.id === request.participantId)
      if (participant === undefined || participant.kind !== 'agent' || participant.nodeId !== this.nodeId()) {
        throw new DevelopmentTaskError('observed context requires an Agent owned by this node', 'PARTICIPANT_NOT_AVAILABLE')
      }
      const assignment = this.assignments.get(request.bindingId)
      if (assignment?.participantId !== request.participantId || assignment.taskId !== task.id) {
        throw new DevelopmentTaskError('observed context does not match the Agent session binding', 'INVALID_REQUEST')
      }
      this.requireBindingEpoch(request.bindingId, request.expectedBindingEpoch)
    }
    const publication = this.observedPublication(request, this.nodeId())
    if ((publication.observation?.state === 'revoked') !== revoking) {
      throw new DevelopmentTaskError('artifact revocation requires its dedicated Host admission method', 'INVALID_REQUEST')
    }
    const retained = task.context.find(item => item.id === publication.id)
    if (retained !== undefined) {
      this.requireSameObservation(retained, publication)
      return Object.freeze({ outcome: 'reused', task: this.snapshot(task), publication: freezePublication(retained) })
    }
    const snapshot = await this.publish(task.id, task.hiddenRoomId, { kind: 'context-published', publication })
    return Object.freeze({ outcome: 'published', task: snapshot, publication })
  }

  private stampObservation(
    request: DevelopmentTaskAdmitObservedContextRequest | DevelopmentTaskRevokeObservedArtifactRequest,
    observerNodeId: DevelopmentNodeId,
  ): DevelopmentTaskOpenApiObservation {
    const parsed = developmentTaskOpenApiObservationSchema.safeParse({
      ...request.observation, observerNodeId, sourceId: request.sourceId,
      binding: { id: request.bindingId, epoch: request.expectedBindingEpoch },
    })
    if (!parsed.success) throw new DevelopmentTaskError('artifact observation fields are invalid', 'INVALID_REQUEST')
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > this.config.maxTextBytes) {
      throw new DevelopmentTaskError('artifact observation exceeds maxTextBytes', 'LIMIT_EXCEEDED')
    }
    return parsed.data
  }

  private observedPublication(
    request: DevelopmentTaskAdmitObservedContextRequest | DevelopmentTaskRevokeObservedArtifactRequest,
    observerNodeId: DevelopmentNodeId,
    observedIntervalId?: DevelopmentTaskObservedIntervalId,
  ): DevelopmentTaskContextPublication {
    if (!/^[a-f0-9]{64}$/.test(request.sourceId)) {
      throw new DevelopmentTaskError('observed context sourceId must be a lowercase SHA-256 digest', 'INVALID_REQUEST')
    }
    return freezePublication({
      id: `context-observation-${request.sourceId}`, text: this.text(request.text, 'text'),
      publishedBy: request.participantId, publishedAt: Date.now(),
      ...(observedIntervalId === undefined ? {} : { observedIntervalId }),
      ...(request.observation === undefined ? {} : { observation: this.stampObservation(request, observerNodeId) }),
    })
  }

  private requireSameObservation(retained: DevelopmentTaskContextPublication, candidate: DevelopmentTaskContextPublication): void {
    if (retained.text !== candidate.text || retained.publishedBy !== candidate.publishedBy || retained.uri !== undefined
      || retained.observedIntervalId !== candidate.observedIntervalId || retained.observedIntervalEnded !== candidate.observedIntervalEnded
      || JSON.stringify(retained.observation) !== JSON.stringify(candidate.observation)) {
      throw new DevelopmentTaskError('observed context sourceId already carries different content', 'INVALID_REQUEST')
    }
  }

  private remoteAdmission(
    task: TaskRecord, intervalId: DevelopmentTaskObservedIntervalId, publication: DevelopmentTaskContextPublication,
    outcome: DevelopmentTaskAdmitRemoteObservedContextResult['outcome'],
  ): DevelopmentTaskAdmitRemoteObservedContextResult {
    const entry = task.events.find(item => item.change.kind === 'context-published' && item.change.publication.id === publication.id)
    if (entry === undefined) throw new Error('observed publication has no committed admission event')
    return Object.freeze({ outcome, publication,
      receipt: Object.freeze({ ...this.receipt(entry, intervalId),
        sourceId: publication.id.slice('context-observation-'.length) as DevelopmentTaskObservedSourceId,
        publicationId: publication.id,
      }),
    })
  }

  private receipt(entry: DevelopmentTaskLogEntry, intervalId: DevelopmentTaskObservedIntervalId): DevelopmentTaskObservedReceipt {
    return Object.freeze({ taskId: entry.taskId, ownerNodeId: entry.nodeId, intervalId, revision: entry.revision,
      event: Object.freeze({ nodeId: entry.nodeId, seq: entry.seq }),
    })
  }

  private intervalIdentity(request: DevelopmentTaskObservedIntervalIdentity): DevelopmentTaskObservedIntervalIdentity {
    if (request.sourceNodeId === this.nodeId() || request.expectedBindingEpoch.nodeId !== request.sourceNodeId
      || !Number.isSafeInteger(request.expectedBindingEpoch.seq) || request.expectedBindingEpoch.seq < 1) {
      throw new DevelopmentTaskError('observed interval requires a remote source and its exact binding epoch', 'INVALID_REQUEST')
    }
    const identity = this.freezeIntervalIdentity(request)
    if ([identity.taskId, identity.sourceNodeId, identity.participantId, identity.bindingId].some(value => value.trim() === '')
      || Buffer.byteLength(JSON.stringify(identity), 'utf8') > this.config.maxTextBytes) {
      throw new DevelopmentTaskError('observed interval identity is empty or exceeds maxTextBytes', 'INVALID_REQUEST')
    }
    return identity
  }

  private freezeIntervalIdentity(request: DevelopmentTaskObservedIntervalIdentity): DevelopmentTaskObservedIntervalIdentity {
    return Object.freeze({ taskId: request.taskId, sourceNodeId: request.sourceNodeId, participantId: request.participantId,
      bindingId: request.bindingId, expectedBindingEpoch: Object.freeze({ ...request.expectedBindingEpoch }),
    })
  }

  private requireOwnedTask(taskId: DevelopmentTaskId): TaskRecord {
    const task = this.requireTask(taskId)
    if (task.ownerNodeId !== this.nodeId()) throw new DevelopmentTaskError('operation requires the local Task owner', 'POLICY_REJECTED')
    return task
  }

  private requireInterval(task: TaskRecord, id: DevelopmentTaskObservedIntervalId): DevelopmentTaskObservedInterval {
    const interval = task.intervals.get(id)
    if (interval === undefined) throw new DevelopmentTaskError('observed interval has not been approved', 'POLICY_REJECTED')
    return interval
  }

  private intervalNoticeText(id: DevelopmentTaskObservedIntervalId): string {
    return `Observed source interval ${id} ended. Earlier observations from this interval do not establish current facts.`
  }

  private withdrawal(
    publication: DevelopmentTaskContextPublication, intervalId: DevelopmentTaskObservedIntervalId, at: number,
  ): DevelopmentTaskContextPublication {
    const previous = publication.observation
    if (previous === undefined) throw new Error('artifact withdrawal requires an observed chain')
    const sourceId = createHash('sha256').update(JSON.stringify([intervalId, 'ended', observationChainKey(previous)]))
      .digest('hex') as DevelopmentTaskObservedSourceId
    return freezePublication({
      id: `context-interval-withdrawal-${sourceId}`, publishedBy: publication.publishedBy, publishedAt: at,
      observedIntervalId: intervalId, text: this.intervalNoticeText(intervalId),
      observation: {
        kind: previous.kind, version: previous.version, artifactId: previous.artifactId, sourceName: previous.sourceName,
        grantId: previous.grantId, sequence: previous.sequence + 1, operation: previous.operation,
        observerNodeId: previous.observerNodeId, sourceId, binding: previous.binding, state: 'revoked', reason: 'grant-ended',
      },
    })
  }

  private retirementReservations(task: TaskRecord): number {
    const local = [...observationHeads(task.context).values()]
      .filter(item => item.observedIntervalId === undefined && item.observation?.state !== 'revoked').length
    return local + [...task.intervals.values()].filter(interval => interval.state === 'active').length
      + [...task.contributions.values()].filter(item => item.state === 'active').length
      + [...task.localContributions.values()].filter(item => item.state === 'active').length
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
      await this.endLocalBindingNow(bindingId)
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
   * @param request - binding identity, owning Agent participant, and optional exact checkout epoch.
   * @returns resolution after binding commit and best-effort Room leave.
   */
  clear(request: DevelopmentTaskClearRequest): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.assignments.get(request.bindingId)
      if (previous === undefined) return
      if (previous.participantId !== request.participantId) {
        throw new DevelopmentTaskError('Task binding belongs to a different Agent participant', 'INVALID_REQUEST')
      }
      if (request.expectedBindingEpoch !== undefined) this.requireBindingEpoch(request.bindingId, request.expectedBindingEpoch)
      await this.endLocalBindingNow(request.bindingId)
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
      if (request.expectedBindingEpoch !== undefined) {
        this.requireBindingEpoch(request.bindingId, request.expectedBindingEpoch)
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
   * Capture context only after local peer expiry is durable, without changing frozen inherited history.
   * @param taskId - local Task or a replica containing no active direct peer evidence.
   * @returns a detached context view captured in the owner-operation queue.
   * @throws RUNTIME_UNAVAILABLE for active direct peer evidence in a nonowner replica; its owner must authorize the read.
   */
  currentContextView(taskId: DevelopmentTaskId): Promise<DevelopmentTaskContextView> {
    return this.enqueue(async () => {
      const task = this.requireTask(taskId)
      if (task.ownerNodeId === this.nodeId()) {
        await this.expirePeerTaskNow(task)
        await this.expireLocalTaskNow(this.requireTask(task.id))
      }
      else if (task.context.some(publication => publication.peerContribution !== undefined
        && task.contributions.get(publication.peerContribution.grant.grantId)?.state === 'active'
        || publication.localContribution !== undefined
        && task.localContributions.get(localContributionId(publication.localContribution.grant))?.state === 'active')) {
        throw new DevelopmentTaskError('active peer evidence requires an authoritative owner context read', 'RUNTIME_UNAVAILABLE')
      }
      return this.contextView(taskId)
    })
  }

  /**
   * Capture the stored Task snapshot and frozen inherited block without checking current authorization.
   * @param taskId - exact Task identity.
   * @returns detached stored context; model consumers use currentContextView for current peer evidence.
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
   * Inspect stored context for one Task through the authenticated local Remote.
   * @param request - exact Task identity.
   * @returns stored Task plus its immutable inherited block; this is not a current peer authorization check.
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
   * Configured capacity must retain every local live artifact grant's revocation reservation.
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
    for (const task of this.tasks.values()) {
      if (task.ownerNodeId !== this.nodeId()) continue
      for (const item of task.contributions.values()) if (item.state === 'active') {
        this.peerGrantBounds(this.parsePeerGrant(item.grant))
        this.peerTerminalBounds(item.grant, task.context.filter(publication =>
          publication.peerContribution?.grant.grantId === item.grant.grantId
          && (publication.peerObservation !== undefined || publication.peerToolObservation !== undefined)).at(-1))
      }
      for (const item of task.localContributions.values()) if (item.state === 'active') this.localGrantBounds(this.parseLocalGrant(item.grant))
      const reserved = this.retirementReservations(task)
      if (reserved > 0 && task.events.length + reserved > this.config.maxEventsPerTask) {
        throw new DevelopmentTaskError('maxEventsPerTask cannot cover restored artifact revocations', 'LIMIT_EXCEEDED')
      }
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
      if (entry.seq > (this.lastSeqByNode.get(entry.nodeId) ?? 0)) this.prepare(entry, 'REPLICA_CONFLICT')
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
    const entry = this.freezeEntry({
      nodeId: this.nodeId(),
      seq: (this.lastSeqByNode.get(this.nodeId()) ?? 0) + 1,
      at: Date.now(),
      taskId,
      revision: (current?.revision ?? 0) + 1,
      hiddenRoomId,
      change,
    })
    const projected = this.prepare(entry, 'INVALID_REQUEST')
    const reserved = this.retirementReservations(projected)
    if ((current?.events.length ?? 0) + 1 + reserved > this.config.maxEventsPerTask) {
      throw new DevelopmentTaskError('Task event limit includes reserved artifact revocations', 'LIMIT_EXCEEDED')
    }
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
          intervals: new Map(),
          contributions: new Map(),
          localContributions: new Map(),
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
        const publication = entry.change.publication
        if (publication.peerContribution !== undefined) this.validatePeerPublication(task, publication, entry, code)
        if (publication.localContribution !== undefined) this.validateLocalPublication(task, publication, entry, code)
        if (publication.observedIntervalEnded !== undefined) {
          throw new DevelopmentTaskError('interval withdrawal requires its terminal owner event', code)
        }
        if (publication.observedIntervalId !== undefined) {
          const interval = task.intervals.get(publication.observedIntervalId)
          if (interval?.state !== 'active' || interval.participantId !== publication.publishedBy) {
            throw new DevelopmentTaskError('publication requires its active owner-approved interval', code)
          }
        }
        this.validateObservationAdvance(task, entry.change.publication, entry.nodeId, code)
        return { ...task, context: [...task.context, entry.change.publication], events: [...task.events] }
      }
      case 'local-contribution-opened':
      case 'local-contribution-ended': {
        const task = this.requireProjectedTask(current, entry, code)
        const grant = entry.change.grant
        const id = localContributionId(grant)
        if (task.origin.kind !== 'root' || grant.taskId !== task.id || grant.expectedBindingEpoch.nodeId !== task.ownerNodeId) {
          throw new DevelopmentTaskError('local capture does not match its owner Root Task', code)
        }
        const previous = task.localContributions.get(id)
        if (previous !== undefined && (!isDeepStrictEqual(previous.grant, grant) || previous.state === 'ended'
          || entry.change.kind === 'local-contribution-opened')) {
          throw new DevelopmentTaskError('local capture repeats, changes, or reopens a terminal identity', code)
        }
        const localContributions = new Map(task.localContributions)
        if (entry.change.kind === 'local-contribution-opened') {
          if (grant.expiresAt <= entry.at || [...localContributions.values()].some(item =>
            item.grant.participantId === grant.participantId && item.grant.captureId === grant.captureId
            && item.grant.captureGeneration === grant.captureGeneration)) {
            throw new DevelopmentTaskError('local capture generation is already authorized or expired', code)
          }
          localContributions.set(id, Object.freeze({ grant, state: 'active', openReceipt: this.localReceipt(entry, grant) }))
          return { ...task, localContributions, events: [...task.events] }
        }
        if (entry.change.reason === 'expired' && grant.expiresAt > entry.at) {
          throw new DevelopmentTaskError('local capture expires after its terminal event', code)
        }
        localContributions.set(id, Object.freeze({ grant, state: 'ended', reason: entry.change.reason,
          endReceipt: this.localReceipt(entry, grant), ...(previous === undefined ? {} : { openReceipt: previous.openReceipt }) }))
        return { ...task, localContributions,
          context: [...task.context, freezePublication(localWithdrawal(grant, entry.change.reason, entry.at))], events: [...task.events] }
      }
      case 'peer-contribution-opened':
      case 'peer-contribution-ended': {
        const task = this.requireProjectedTask(current, entry, code)
        const grant = entry.change.grant
        if (task.origin.kind !== 'root' || grant.taskId !== task.id || grant.ownerPeerId === grant.contributorPeerId) {
          throw new DevelopmentTaskError('peer grant does not match its Root Task', code)
        }
        const previous = task.contributions.get(grant.grantId)
        if (previous !== undefined && (!isDeepStrictEqual(previous.grant, grant)
          || previous.state === 'ended' || entry.change.kind === 'peer-contribution-opened')) {
          throw new DevelopmentTaskError('peer grant repeats, changes, or reopens a terminal identity', code)
        }
        const contributions = new Map(task.contributions)
        if (entry.change.kind === 'peer-contribution-opened') {
          if (grant.expiresAt <= entry.at || [...contributions.values()].some(item =>
            item.grant.contributorPeerId === grant.contributorPeerId && item.grant.captureId === grant.captureId
            && item.grant.captureGeneration === grant.captureGeneration)) {
            throw new DevelopmentTaskError('peer capture generation is already authorized or expired', code)
          }
          contributions.set(grant.grantId, Object.freeze({ grant, state: 'active', openReceipt: this.peerReceipt(entry, grant) }))
          return { ...task, contributions, events: [...task.events] }
        }
        if (entry.change.reason === 'expired' && grant.expiresAt > entry.at) {
          throw new DevelopmentTaskError('peer grant expires after its terminal event', code)
        }
        contributions.set(grant.grantId, Object.freeze({ grant, state: 'ended', reason: entry.change.reason,
          endReceipt: this.peerReceipt(entry, grant), ...(previous === undefined ? {} : { openReceipt: previous.openReceipt }),
        }))
        const latest = task.context.filter(item => item.peerContribution?.grant.grantId === grant.grantId
          && (item.peerObservation !== undefined || item.peerToolObservation !== undefined)).at(-1)
        return { ...task, contributions, context: [...task.context,
          ...peerWithdrawals(grant, latest, entry.change.reason, entry.at).map(freezePublication)], events: [...task.events] }
      }
      case 'observed-interval-opened':
      case 'observed-interval-ended': {
        const task = this.requireProjectedTask(current, entry, code)
        const identity = entry.change.interval
        if (identity.taskId !== task.id || identity.sourceNodeId === task.ownerNodeId
          || identity.expectedBindingEpoch.nodeId !== identity.sourceNodeId
          || !Number.isSafeInteger(identity.expectedBindingEpoch.seq) || identity.expectedBindingEpoch.seq < 1) {
          throw new DevelopmentTaskError('observed interval does not match its Task and source epoch', code)
        }
        const id = observedIntervalId(identity)
        const previous = task.intervals.get(id)
        if (previous?.state === 'ended' || (previous !== undefined && entry.change.kind === 'observed-interval-opened')) {
          throw new DevelopmentTaskError('observed interval repeats an approval or reopens a terminal identity', code)
        }
        const intervals = new Map(task.intervals)
        const context = [...task.context]
        if (entry.change.kind === 'observed-interval-opened') {
          intervals.set(id, Object.freeze({ ...identity, id, state: 'active', approvalReceipt: this.receipt(entry, id) }))
        } else {
          intervals.set(id, Object.freeze({ ...identity, id, state: 'ended', endReceipt: this.receipt(entry, id),
            ...(previous === undefined ? {} : { approvalReceipt: previous.approvalReceipt }),
          }))
          for (const publication of observationHeads(task.context).values()) {
            if (publication.observedIntervalId === id && publication.observation?.state !== 'revoked') {
              context.push(this.withdrawal(publication, id, entry.at))
            }
          }
          context.push(freezePublication({ id: `context-interval-ended-${id}`, observedIntervalId: id, observedIntervalEnded: true,
            text: this.intervalNoticeText(id), publishedBy: identity.participantId, publishedAt: entry.at,
          }))
        }
        return { ...task, intervals, context, events: [...task.events] }
      }
      default: return this.assertNever(entry.change)
    }
  }

  private validateLocalPublication(task: TaskRecord, publication: DevelopmentTaskContextPublication,
    entry: DevelopmentTaskLogEntry, code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT'): void {
    if (publication.localContribution?.ended !== undefined || publication.localToolObservation === undefined) {
      throw new DevelopmentTaskError('local withdrawal requires its terminal owner event', code)
    }
    const parsed = localContributionRequestSchema.safeParse(localPublicationRequest(publication))
    if (!parsed.success) throw new DevelopmentTaskError('local report changes its permitted tools', code)
    const sample = parsed.data
    const id = localContributionId(sample.grant)
    const authority = task.localContributions.get(id)
    if (authority?.state !== 'active' || !isDeepStrictEqual(authority.grant, sample.grant) || sample.grant.expiresAt <= entry.at
      || publication.publishedBy !== sample.grant.participantId || publication.publishedAt > entry.at
      || !isDeepStrictEqual(publication, localPublication(sample, publication.publishedAt))) {
      throw new DevelopmentTaskError('local report lacks its current canonical owner authorization', code)
    }
    const prior = task.context.filter(item => item.localContribution !== undefined
      && localContributionId(item.localContribution.grant) === id && item.localToolObservation !== undefined)
    if (prior.length >= sample.grant.maxSamples || sample.sequence > sample.grant.maxSamples) {
      throw new DevelopmentTaskError('local report exceeds its sample limit', code === 'INVALID_REQUEST' ? 'LIMIT_EXCEEDED' : code)
    }
    if (prior.some(item => item.id === publication.id || (item.localToolObservation?.sequence ?? 0) >= sample.sequence)) {
      throw new DevelopmentTaskError('local report sequence or source does not advance', code)
    }
    if (Buffer.byteLength(JSON.stringify(sample), 'utf8') > sample.grant.maxSampleBytes) {
      throw new DevelopmentTaskError('local report exceeds its authorized byte limit', code)
    }
  }

  private validatePeerPublication(
    task: TaskRecord, publication: DevelopmentTaskContextPublication, entry: DevelopmentTaskLogEntry,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): void {
    const metadata = publication.peerContribution
    if (metadata === undefined || metadata.ended !== undefined || publication.peerObservation?.state === 'revoked'
      || (publication.peerObservation === undefined && publication.peerToolObservation === undefined)) throw new DevelopmentTaskError('peer withdrawal requires its terminal owner event', code)
    const parsed = peerContributionRequestSchema.safeParse(peerPublicationRequest(publication))
    if (!parsed.success) throw new DevelopmentTaskError('peer sample does not match its permitted source and tools', code)
    const sample = parsed.data
    const authority = task.contributions.get(sample.grant.grantId)
    if (authority?.state !== 'active' || !isDeepStrictEqual(authority.grant, sample.grant) || sample.grant.expiresAt <= entry.at
      || !isDeepStrictEqual(publication, peerPublication(sample, publication.publishedAt)) || publication.publishedAt > entry.at) {
      throw new DevelopmentTaskError('peer publication does not match current owner authorization', code)
    }
    const samples = task.context.filter(item => item.peerContribution?.grant.grantId === sample.grant.grantId
      && (item.peerObservation !== undefined || item.peerToolObservation !== undefined))
    if (samples.length >= sample.grant.maxSamples) throw new DevelopmentTaskError('peer contribution sample capacity reached', 'LIMIT_EXCEEDED')
    const previous = samples.at(-1)?.peerObservation ?? samples.at(-1)?.peerToolObservation
    if (!Number.isSafeInteger(sample.sequence) || sample.sequence < 1 || sample.sequence >= Number.MAX_SAFE_INTEGER
      || (previous !== undefined && sample.sequence <= previous.sequence)
      || task.context.some(item => item.id === publication.id)) {
      throw new DevelopmentTaskError('peer sample must advance its chain without repeating a source', code)
    }
    if (Buffer.byteLength(JSON.stringify(sample), 'utf8') > sample.grant.maxSampleBytes) {
      throw new DevelopmentTaskError('peer sample exceeds its authorized byte limit', code)
    }
  }

  private validateObservationAdvance(
    task: TaskRecord,
    publication: DevelopmentTaskContextPublication,
    nodeId: DevelopmentNodeId,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT',
  ): void {
    const observation = publication.observation
    if (observation === undefined) return
    const interval = publication.observedIntervalId === undefined ? undefined : task.intervals.get(publication.observedIntervalId)
    const sourceNodeId = interval?.sourceNodeId ?? nodeId
    if (observation.observerNodeId !== sourceNodeId || observation.binding.epoch.nodeId !== sourceNodeId
      || publication.id !== `context-observation-${observation.sourceId}`) {
      throw new DevelopmentTaskError('artifact observation does not match its admitting node or source', code)
    }
    if (interval !== undefined && (observation.binding.id !== interval.bindingId
      || observation.binding.epoch.seq !== interval.expectedBindingEpoch.seq || observation.state === 'revoked'
      || observation.sequence >= Number.MAX_SAFE_INTEGER)) {
      throw new DevelopmentTaskError('remote artifact does not match its approved binding or reserved terminal sequence', code)
    }
    const previous = observationHeads(task.context).get(observationChainKey(observation))
    const prior = previous?.observation
    if (prior === undefined) {
      if (observation.state === 'revoked') throw new DevelopmentTaskError('artifact revocation has no admitted chain', code)
      return
    }
    if (prior.state === 'revoked' || observation.sequence <= prior.sequence) {
      throw new DevelopmentTaskError('artifact sequence must advance an active observation chain', code)
    }
    if (previous?.publishedBy !== publication.publishedBy || prior.sourceName !== observation.sourceName
      || JSON.stringify(prior.operation) !== JSON.stringify(observation.operation)
      || JSON.stringify(prior.binding) !== JSON.stringify(observation.binding)
      || previous.observedIntervalId !== publication.observedIntervalId) {
      throw new DevelopmentTaskError('artifact chain publisher, operation, or binding interval changed', code)
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
        context: Object.freeze(source.context.map(freezePublication)),
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
    this.ctx.emit('development-task/assignment-changed', assignment ?? null, entry, origin)
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
      context: Object.freeze(task.context.map(freezePublication)),
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

  private async routeOwner<C extends DevelopmentTaskOwnerCommand>(
    task: TaskRecord,
    command: C,
  ): Promise<DevelopmentTaskOwnerCommandResult<C>> {
    const router = this.ctx.get('developmentTaskMesh') as TaskOwnerRouter | undefined
    if (router === undefined) throw new DevelopmentTaskError('remote Task owner is unavailable for mutation', 'RUNTIME_UNAVAILABLE')
    try { return await router.route(task.ownerNodeId, command) } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string') throw new DevelopmentTaskError(this.failureMessage(error), code as TaskErrorCode, { cause: error })
      throw error
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

  private requireBindingEpoch(
    bindingId: DevelopmentTaskBindingId,
    expected: { readonly nodeId: DevelopmentNodeId; readonly seq: number },
  ): void {
    const bound = this.assignmentEntries.findLast(entry => entry.bindingId === bindingId && entry.change.kind === 'task-bound')
    if (bound?.nodeId !== expected.nodeId || bound.seq !== expected.seq) {
      throw new DevelopmentTaskError('Task binding belongs to a different binding interval', 'INVALID_REQUEST')
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
    return Object.freeze({ ...entry, change: Object.freeze(entry.change.kind === 'context-published'
      ? { ...entry.change, publication: freezePublication(entry.change.publication) }
      : entry.change.kind === 'observed-interval-opened' || entry.change.kind === 'observed-interval-ended'
        ? { ...entry.change, interval: this.freezeIntervalIdentity(entry.change.interval) }
        : entry.change.kind === 'peer-contribution-opened' || entry.change.kind === 'peer-contribution-ended'
          ? { ...entry.change, grant: freezePeerGrant(entry.change.grant) }
          : entry.change.kind === 'local-contribution-opened' || entry.change.kind === 'local-contribution-ended'
            ? { ...entry.change, grant: freezeLocalGrant(entry.change.grant) }
            : { ...entry.change }) })
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
