/** Task, context-block, session-binding, and owner-command consumer over the generic Mesh. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { DevelopmentMeshHeads } from '@deepseek-ai/dsh-development-mesh'
import type {} from '@deepseek-ai/dsh-development-mesh'
import {
  developmentTaskAssignmentEventSchema,
  developmentTaskContextBlockSchema,
  developmentTaskEventSchema,
} from '@deepseek-ai/dsh-development-task/schema'
import type {} from '@deepseek-ai/dsh-development-task'
import type {} from '@deepseek-ai/dsh-development-room'
import type {
  DevelopmentNodeId,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskLogEntry,
  DevelopmentTaskPublishContextRequest,
  DevelopmentTaskSnapshot,
} from '@deepseek-ai/dsh-development-task'
import { z } from 'zod'

const CHANNEL = 'development-task/v1'
const itemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('context-block'), block: developmentTaskContextBlockSchema }),
  z.strictObject({ kind: z.literal('task-event'), entry: developmentTaskEventSchema }),
  z.strictObject({ kind: z.literal('assignment-event'), entry: developmentTaskAssignmentEventSchema }),
])
const commandSchema = z.strictObject({
  method: z.literal('publishContext'),
  request: z.strictObject({ taskId: z.string(), participantId: z.string(), text: z.string(), uri: z.string().optional() }),
})

/** Mutations that must execute on the Task owner node. */
export type DevelopmentTaskMeshCommand =
  | { readonly method: 'publishContext'; readonly request: DevelopmentTaskPublishContextRequest }

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
   * @returns updated Task projection from the owner.
   */
  async route(ownerNodeId: DevelopmentNodeId, command: DevelopmentTaskMeshCommand): Promise<DevelopmentTaskSnapshot> {
    return await this.ctx.developmentMesh.command(ownerNodeId, CHANNEL, command) as DevelopmentTaskSnapshot
  }

  /** Register Task delta and command behavior on the generic Mesh. */
  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.developmentMesh.register(CHANNEL, {
      heads: () => this.heads(),
      read: after => this.read(after),
      receive: (items, sourceNodeId) => this.receive(items, sourceNodeId),
      command: payload => this.execute(commandSchema.parse(payload) as DevelopmentTaskMeshCommand),
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

  private async execute(command: DevelopmentTaskMeshCommand): Promise<DevelopmentTaskSnapshot> {
    return await this.ctx.developmentTasks.publishContext(command.request)
  }
}

export default DevelopmentTaskMeshService
