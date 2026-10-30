/** Durable storage-domain declaration for one locally authored room log. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { developmentRoomChangeSchema } from '@deepseek-ai/dsh-development-room/schema'
import type {
  DevelopmentNodeId,
  DevelopmentRoomLogEntry,
} from '@deepseek-ai/dsh-development-room'
import { z } from 'zod'

/** Stable storage-domain and backend-unit name for development rooms. */
export const DEVELOPMENT_ROOM_DOMAIN_NAME = 'development_rooms'

const entrySchema = z.strictObject({
  nodeId: z.string(),
  seq: z.number().int().min(1),
  at: z.number().int().nonnegative(),
  roomId: z.string(),
  change: developmentRoomChangeSchema,
})

/** One atomically stored append-only room log. */
export interface DevelopmentRoomLogRecord {
  readonly entries: readonly DevelopmentRoomLogEntry[]
}

const logRecordSchema = z.strictObject({ entries: z.array(entrySchema).min(1) })

/** Versioned domain spec; version changes reject older on-disk records during pre-release. */
export const developmentRoomDomainSpec = defineDomain({
  name: DEVELOPMENT_ROOM_DOMAIN_NAME,
  version: 8,
  tables: {
    logs: domainTable<DevelopmentNodeId, DevelopmentRoomLogRecord>(
      // Zod validates opaque ids as strings; the room service re-establishes
      // branded identity and all sequence relationships during restore.
      logRecordSchema as unknown as z.ZodType<DevelopmentRoomLogRecord>,
    ),
  },
})
