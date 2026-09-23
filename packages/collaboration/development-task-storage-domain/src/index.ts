/** Per-item durable storage for Task events, inherited blocks, and Agent assignments. */

import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-development-room-storage-domain'
import type {} from '@deepseek-ai/dsh-development-task'
import type {
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskContextBlock,
  DevelopmentTaskLogEntry,
} from '@deepseek-ai/dsh-development-task/types'
import { DEVELOPMENT_TASK_DOMAIN_NAME, developmentTaskDomainSpec } from './schema.ts'

export { DEVELOPMENT_TASK_DOMAIN_NAME, developmentTaskDomainSpec } from './schema.ts'

export const name = 'development-task-storage-domain'
export const inject = ['developmentTasks', 'developmentRoomStorageReady', 'storageDomain']

/** Storage maintenance bounds. */
export interface Config {
  /** Minimum age before an unreferenced context block may be removed at startup. */
  readonly orphanGraceMs: number
}

export const Config: s<Config> = s.object({
  orphanGraceMs: s.number().step(1).min(1).required(),
})

function eventKey(entry: DevelopmentTaskLogEntry): string { return `${entry.nodeId}:${String(entry.seq)}` }
function assignmentKey(entry: DevelopmentTaskAssignmentLogEntry): string { return `${entry.nodeId}:${String(entry.seq)}` }

/**
 * Restore all Task records, prune old orphan blocks, then persist each new item before publication.
 * @param ctx - Host context carrying Task and storage-domain services.
 * @param config - orphan cleanup grace period.
 * @returns resolution after the domain owns its lifecycle effects.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(developmentTaskDomainSpec)
  try {
    const events = domain.table('events')
    const blocks = domain.table('context_blocks')
    const assignments = domain.table('assignments')
    ctx.developmentTasks.restoreContextBlocks([...blocks.entries()].map(([, block]) => block))
    ctx.developmentTasks.restoreLog([...events.entries()].map(([, entry]) => entry))
    ctx.developmentTasks.restoreAssignmentLog([...assignments.entries()].map(([, entry]) => entry))

    const referenced = new Set(ctx.developmentTasks.log().flatMap(entry =>
      entry.change.kind === 'task-created' && entry.change.inheritedContextBlockId !== undefined
        ? [entry.change.inheritedContextBlockId]
        : []))
    const cutoff = Date.now() - config.orphanGraceMs
    for (const [id, block] of blocks.entries()) {
      if (!referenced.has(block.id) && block.createdAt < cutoff) await blocks.delete(id)
    }

    const stopBlock = ctx.on('development-task/context-persist', async (block: DevelopmentTaskContextBlock) => {
      const retained = blocks.get(block.id)
      if (retained !== undefined && JSON.stringify(retained.sources) !== JSON.stringify(block.sources)) {
        throw new Error(`development-task storage: context block conflict at "${block.id}"`)
      }
      if (retained === undefined) await blocks.put(block.id, block)
    })
    const stopEvent = ctx.on('development-task/persist', async (entry: DevelopmentTaskLogEntry) => {
      const key = eventKey(entry)
      const retained = events.get(key)
      if (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(entry)) {
        throw new Error(`development-task storage: event conflict at "${key}"`)
      }
      if (retained === undefined) await events.put(key, entry)
    })
    const stopAssignment = ctx.on('development-task/assignment-persist', async (entry: DevelopmentTaskAssignmentLogEntry) => {
      const key = assignmentKey(entry)
      const retained = assignments.get(key)
      if (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(entry)) {
        throw new Error(`development-task storage: assignment conflict at "${key}"`)
      }
      if (retained === undefined) await assignments.put(key, entry)
    })
    await ctx.developmentTasks.reconcileAllRooms()
    ctx.effect(() => async () => {
      stopAssignment()
      stopEvent()
      stopBlock()
      await domain.close()
    }, `${DEVELOPMENT_TASK_DOMAIN_NAME} persistence`)
  } catch (error) {
    await domain.close()
    throw error
  }
}
