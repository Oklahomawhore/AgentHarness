/** Durable storage for the locally authored append-only room log. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-development-room'
import type { DevelopmentNodeId, DevelopmentRoomLogEntry } from '@deepseek-ai/dsh-development-room'
import {
  DEVELOPMENT_ROOM_DOMAIN_NAME,
  developmentRoomDomainSpec,
  type DevelopmentRoomLogRecord,
} from './schema.ts'

export { DEVELOPMENT_ROOM_DOMAIN_NAME, developmentRoomDomainSpec } from './schema.ts'

export const name = 'development-room-storage-domain'
/** Room state and the routed storage-domain facility must be ready before recovery begins. */
export const inject = ['developmentRooms', 'storageDomain']

/** Startup barrier published only after the local Room log and persistence listener are ready. */
export interface DevelopmentRoomStorageReady {
  /** Local node whose append-only Room history has completed recovery. */
  readonly nodeId: DevelopmentNodeId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Signals that durable Room recovery finished before Task Room reconciliation starts. */
    developmentRoomStorageReady: DevelopmentRoomStorageReady
  }
}

/**
 * Restore the local room log, then durably append each local candidate before publication.
 * @param ctx - plugin context containing the room service and storage-domain facility.
 * @returns resolution after durable entries are validated, restored, and the write listener is installed.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(developmentRoomDomainSpec)
  try {
    const logs = domain.table('logs')
    const nodeId = ctx.developmentRooms.list().nodeId
    const records = [...logs.entries()]
    if (records.some(([key]) => key !== nodeId)) {
      throw new Error('development-room storage: durable log belongs to another node')
    }
    let record: DevelopmentRoomLogRecord | undefined = logs.get(nodeId)
    if (record !== undefined) ctx.developmentRooms.restoreLocalLog(record.entries)

    const stop = ctx.on('development-room/persist', async (entry: DevelopmentRoomLogEntry) => {
      if (entry.nodeId !== nodeId) {
        throw new Error(`development-room storage: cannot persist foreign log entry "${entry.nodeId}:${String(entry.seq)}"`)
      }
      const next = { entries: Object.freeze([...(record?.entries ?? []), entry]) }
      await logs.put(nodeId, next)
      record = next
    })
    ctx.effect(() => async () => {
      stop()
      await domain.close()
    }, `${DEVELOPMENT_ROOM_DOMAIN_NAME} persistence`)
    ctx.provide('developmentRoomStorageReady', Object.freeze({ nodeId }))
  } catch (error) {
    await domain.close()
    throw error
  }
}
