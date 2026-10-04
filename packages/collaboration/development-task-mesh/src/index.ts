/** Task, context-block, session-binding, and owner-command consumer over the generic Mesh. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { DevelopmentMeshHeads } from '@deepseek-ai/dsh-development-mesh'
import type {} from '@deepseek-ai/dsh-development-mesh'
import {
  developmentTaskAssignmentEventSchema,
  developmentTaskContextBlockSchema,
  developmentTaskEventSchema,
  developmentTaskObservedIntervalIdentitySchema,
  developmentTaskAdmitRemoteObservedContextRequestSchema,
  developmentTaskAdmitRemoteObservedContextResultSchema,
  developmentTaskObservedIntervalSchema,
  developmentTaskObservedReceiptSchema,
} from '@deepseek-ai/dsh-development-task/schema'
import type {} from '@deepseek-ai/dsh-development-task'
import { DevelopmentTaskError, observedIntervalId } from '@deepseek-ai/dsh-development-task'
import type {} from '@deepseek-ai/dsh-development-room'
import type {
  DevelopmentNodeId,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskLogEntry,
  DevelopmentTaskOwnerCommand,
  DevelopmentTaskOwnerCommandResult,
  DevelopmentTaskObservedInterval,
  DevelopmentTaskObservedReceipt,
} from '@deepseek-ai/dsh-development-task'
import { z } from 'zod'

const CHANNEL = 'development-task/v1'
const itemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('context-block'), block: developmentTaskContextBlockSchema }),
  z.strictObject({ kind: z.literal('task-event'), entry: developmentTaskEventSchema }),
  z.strictObject({ kind: z.literal('assignment-event'), entry: developmentTaskAssignmentEventSchema }),
])
const commandSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('publishContext'),
    request: z.strictObject({ taskId: z.string(), participantId: z.string(), text: z.string(), uri: z.string().optional() }),
  }),
  z.strictObject({ method: z.literal('observedIntervals'), request: z.strictObject({ taskId: z.string() }) }),
  z.strictObject({ method: z.literal('admitObservedRemote'), request: developmentTaskAdmitRemoteObservedContextRequestSchema }),
  z.strictObject({ method: z.literal('endObservedInterval'), request: developmentTaskObservedIntervalIdentitySchema }),
])

/** Mutations that must execute on the Task owner node. */
export type DevelopmentTaskMeshCommand = DevelopmentTaskOwnerCommand

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Task-specific replication and owner-command adapter. */
    developmentTaskMesh: DevelopmentTaskMeshService
  }
}

/** Replicate Task state and route mutations to each Task owner. */
export class DevelopmentTaskMeshService extends Service {
  static inject = ['developmentMesh', 'developmentRooms', 'developmentTasks']
  private readonly pendingTasks = new Map<string, DevelopmentTaskLogEntry>()
  private readonly pendingAssignments = new Map<string, DevelopmentTaskAssignmentLogEntry>()

  constructor(ctx: Context) { super(ctx, 'developmentTaskMesh') }

  /**
   * Route one Task mutation to its authoritative owner.
   * @param ownerNodeId - node that authored the Task creation event.
   * @param command - Task mutation and validated request.
   * @returns the command-specific owner result after its required durable commit.
   */
  async route<C extends DevelopmentTaskOwnerCommand>(
    ownerNodeId: DevelopmentNodeId, command: C,
  ): Promise<DevelopmentTaskOwnerCommandResult<C>> {
    let result: unknown = await this.ctx.developmentMesh.command(ownerNodeId, CHANNEL, command)
    switch (command.method) {
      case 'publishContext': break
      case 'observedIntervals': {
        const intervals = z.array(developmentTaskObservedIntervalSchema).parse(result)
        for (const interval of intervals) {
          if (interval.taskId !== command.request.taskId || interval.id !== observedIntervalId(interval)) {
            throw new DevelopmentTaskError('owner interval response does not match its Task query and source identity', 'INVALID_REQUEST')
          }
          switch (interval.state) {
            case 'active': this.requireIntervalReceipt(interval, interval.approvalReceipt, ownerNodeId); break
            case 'ended':
              this.requireIntervalReceipt(interval, interval.endReceipt, ownerNodeId)
              if (interval.approvalReceipt !== undefined) this.requireIntervalReceipt(interval, interval.approvalReceipt, ownerNodeId)
              break
            default: this.assertNever(interval)
          }
        }
        result = intervals
        break
      }
      case 'admitObservedRemote': result = developmentTaskAdmitRemoteObservedContextResultSchema.parse(result); break
      case 'endObservedInterval': result = developmentTaskObservedReceiptSchema.parse(result); break
      default: return this.assertNever(command)
    }
    return result as DevelopmentTaskOwnerCommandResult<C>
  }

  private requireIntervalReceipt(
    interval: DevelopmentTaskObservedInterval, receipt: DevelopmentTaskObservedReceipt, ownerNodeId: DevelopmentNodeId,
  ): void {
    if (receipt.taskId !== interval.taskId || receipt.intervalId !== interval.id
      || receipt.ownerNodeId !== ownerNodeId || receipt.event.nodeId !== ownerNodeId) {
      throw new DevelopmentTaskError('owner interval receipt does not match its Task, source interval, and owner', 'INVALID_REQUEST')
    }
  }

  /** Register Task delta and command behavior on the generic Mesh. */
  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.developmentMesh.register(CHANNEL, {
      heads: () => this.heads(),
      read: after => this.read(after),
      receive: (items, sourceNodeId) => this.receive(items, sourceNodeId),
      command: (payload, sourceNodeId) => this.execute(commandSchema.parse(payload) as DevelopmentTaskMeshCommand, sourceNodeId),
    }), 'development Task Mesh channel')
    this.ctx.on('development-task/changed', (_task, _entry, origin) => { if (origin.kind === 'local') this.ctx.developmentMesh.publish(CHANNEL) })
    this.ctx.on('development-task/assignment-changed', (_assignment, _entry, origin) => { if (origin.kind === 'local') this.ctx.developmentMesh.publish(CHANNEL) })
  }

  private heads(): DevelopmentMeshHeads {
    const heads: Record<string, number> = {}
    for (const entry of this.ctx.developmentTasks.log()) heads[`task:${entry.nodeId}`] = Math.max(heads[`task:${entry.nodeId}`] ?? 0, entry.seq)
    for (const entry of this.ctx.developmentTasks.assignmentLog()) heads[`assignment:${entry.nodeId}`] = Math.max(heads[`assignment:${entry.nodeId}`] ?? 0, entry.seq)
    return Object.freeze(heads)
  }

  private read(after: DevelopmentMeshHeads): readonly unknown[] {
    const nodeId = this.ctx.developmentRooms.list().nodeId
    const taskEvents = this.ctx.developmentTasks.log()
      .filter(entry => entry.nodeId === nodeId && entry.seq > (after[`task:${nodeId}`] ?? 0))
    const blockIds = new Set(taskEvents.flatMap(entry => entry.change.kind === 'task-created' && entry.change.inheritedContextBlockId !== undefined
      ? [entry.change.inheritedContextBlockId] : []))
    const blocks = this.ctx.developmentTasks.blocks()
      .filter(block => blockIds.has(block.id))
      .map(block => ({ kind: 'context-block' as const, block }))
    const assignments = this.ctx.developmentTasks.assignmentLog()
      .filter(entry => entry.nodeId === nodeId && entry.seq > (after[`assignment:${nodeId}`] ?? 0))
      .map(entry => ({ kind: 'assignment-event' as const, entry }))
    return Object.freeze([
      ...blocks,
      ...taskEvents.map(entry => ({ kind: 'task-event' as const, entry })),
      ...assignments,
    ])
  }

  private async receive(values: readonly unknown[], sourceNodeId: DevelopmentNodeId): Promise<void> {
    const items = z.array(itemSchema).parse(values)
    for (const item of items) {
      if (item.kind === 'context-block') await this.ctx.developmentTasks.acceptContextReplica(item.block)
      else if (item.kind === 'task-event') this.retainTask(item.entry, sourceNodeId)
      else this.retainAssignment(item.entry, sourceNodeId)
    }
    await this.drain()
  }

  private retainTask(entry: DevelopmentTaskLogEntry, sourceNodeId: DevelopmentNodeId): void {
    if (entry.nodeId !== sourceNodeId) throw Object.assign(new Error('Task event origin does not match authenticated peer'), { code: 'REPLICA_CONFLICT' })
    const key = `${entry.nodeId}:${String(entry.seq)}`
    const committed = this.ctx.developmentTasks.log().find(candidate => candidate.nodeId === entry.nodeId && candidate.seq === entry.seq)
    if (committed !== undefined) {
      if (JSON.stringify(committed) !== JSON.stringify(entry)) throw Object.assign(new Error('same Task event identity carries different content'), { code: 'REPLICA_CONFLICT' })
      return
    }
    const retained = this.pendingTasks.get(key)
    if (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(entry)) throw Object.assign(new Error('same Task event identity carries different content'), { code: 'REPLICA_CONFLICT' })
    this.pendingTasks.set(key, entry)
  }

  private retainAssignment(entry: DevelopmentTaskAssignmentLogEntry, sourceNodeId: DevelopmentNodeId): void {
    if (entry.nodeId !== sourceNodeId) throw Object.assign(new Error('assignment origin does not match authenticated peer'), { code: 'REPLICA_CONFLICT' })
    const key = `${entry.nodeId}:${String(entry.seq)}`
    const committed = this.ctx.developmentTasks.assignmentLog()
      .find(candidate => candidate.nodeId === entry.nodeId && candidate.seq === entry.seq)
    if (committed !== undefined) {
      if (JSON.stringify(committed) !== JSON.stringify(entry)) throw Object.assign(new Error('same assignment event identity carries different content'), { code: 'REPLICA_CONFLICT' })
      return
    }
    const retained = this.pendingAssignments.get(key)
    if (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(entry)) throw Object.assign(new Error('same assignment event identity carries different content'), { code: 'REPLICA_CONFLICT' })
    this.pendingAssignments.set(key, entry)
  }

  private async drain(): Promise<void> {
    let progressed = true
    while (progressed) {
      progressed = false
      const sources = new Set<DevelopmentNodeId>([
        ...[...this.pendingTasks.values()].map(entry => entry.nodeId),
        ...[...this.pendingAssignments.values()].map(entry => entry.nodeId),
      ])
      for (const sourceNodeId of sources) {
        const taskHead = this.ctx.developmentTasks.log().filter(entry => entry.nodeId === sourceNodeId).at(-1)?.seq ?? 0
        const task = this.pendingTasks.get(`${sourceNodeId}:${String(taskHead + 1)}`)
        if (task !== undefined && this.dependenciesAvailable(task)) {
          await this.ctx.developmentTasks.acceptLogReplica(task, sourceNodeId)
          this.pendingTasks.delete(`${sourceNodeId}:${String(task.seq)}`)
          progressed = true
        }
        const assignmentHead = this.ctx.developmentTasks.assignmentLog().filter(entry => entry.nodeId === sourceNodeId).at(-1)?.seq ?? 0
        const assignment = this.pendingAssignments.get(`${sourceNodeId}:${String(assignmentHead + 1)}`)
        if (assignment !== undefined) {
          await this.ctx.developmentTasks.acceptAssignmentReplica(assignment, sourceNodeId)
          this.pendingAssignments.delete(`${sourceNodeId}:${String(assignment.seq)}`)
          progressed = true
        }
      }
    }
    if (this.pendingTasks.size + this.pendingAssignments.size > 20_000) throw Object.assign(new Error('Task Mesh dependency queue exceeded its bound'), { code: 'LIMIT_EXCEEDED' })
  }

  private dependenciesAvailable(entry: DevelopmentTaskLogEntry): boolean {
    const change = entry.change
    if (change.kind !== 'task-created') {
      try { return this.ctx.developmentTasks.get({ taskId: entry.taskId }).revision + 1 === entry.revision } catch { return false }
    }
    if (change.inheritedContextBlockId !== undefined
      && !this.ctx.developmentTasks.blocks().some(block => block.id === change.inheritedContextBlockId)) return false
    const parents = change.origin.kind === 'root' ? [] : change.origin.kind === 'fork'
      ? [change.origin.parent] : change.origin.parents
    return parents.every((parent) => {
      try { return this.ctx.developmentTasks.get({ taskId: parent.taskId }).revision >= parent.revision } catch { return false }
    })
  }

  private execute(command: DevelopmentTaskMeshCommand, sourceNodeId: DevelopmentNodeId): Promise<unknown> {
    switch (command.method) {
      case 'publishContext': return this.ctx.developmentTasks.publishContext(command.request)
      case 'observedIntervals': return this.ctx.developmentTasks.observedIntervals(command.request)
      case 'admitObservedRemote': return this.ctx.developmentTasks.acceptObservedRemote(command.request, sourceNodeId)
      case 'endObservedInterval': return this.ctx.developmentTasks.acceptObservedIntervalEnd(command.request, sourceNodeId)
      default: return this.assertNever(command)
    }
  }

  private assertNever(value: never): never {
    throw new Error(`unsupported Task Mesh command: ${JSON.stringify(value)}`)
  }
}

export default DevelopmentTaskMeshService
