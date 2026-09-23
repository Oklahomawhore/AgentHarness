/** Durable storage for one Host's append-only shared-room context log. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-development-room-context'
import type { DevelopmentRoomContextEntry } from '@deepseek-ai/dsh-development-room-context/types'
import {
  DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME,
  developmentRoomContextDomainSpec,
  type DevelopmentRoomContextLogRecord,
} from './schema.ts'

export { DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME, developmentRoomContextDomainSpec } from './schema.ts'

/** Cordis plugin name. */
export const name = 'development-room-context-storage-domain'
/** Context state and the routed storage-domain facility must be ready before recovery begins. */
export const inject = ['developmentRoomContexts', 'storageDomain']

/**
 * Restore the local context log, then persist each candidate before publication.
 * @param ctx - plugin context containing shared room context and storage-domain services.
 * @returns resolution after recovery and persistence listener installation.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(developmentRoomContextDomainSpec)
  try {
    const logs = domain.table('logs')
    const nodeId = ctx.developmentRoomContexts.list().nodeId
    const records = [...logs.entries()]
    if (records.some(([key]) => key !== nodeId)) {
      throw new Error('development-room-context storage: durable log belongs to another node')
    }
    let record: DevelopmentRoomContextLogRecord | undefined = logs.get(nodeId)
    if (record !== undefined) ctx.developmentRoomContexts.restoreLocalLog(record.entries)

    const stop = ctx.on('development-room-context/persist', async (entry: DevelopmentRoomContextEntry) => {
      if (entry.nodeId !== nodeId) {
        throw new Error(`development-room-context storage: cannot persist foreign entry "${entry.nodeId}:${String(entry.seq)}"`)
      }
      const next = { entries: Object.freeze([...(record?.entries ?? []), entry]) }
      await logs.put(nodeId, next)
      record = next
    })
    ctx.effect(() => async () => {
      stop()
      await domain.close()
    }, `${DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME} persistence`)
  } catch (error) {
    await domain.close()
    throw error
  }
}
