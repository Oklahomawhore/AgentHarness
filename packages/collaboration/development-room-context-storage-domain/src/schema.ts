/** Durable storage-domain declaration for one local shared-context log. */

import type {
  DevelopmentRoomContextEntry,
} from '@deepseek-ai/dsh-development-room-context/types'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Stable storage-domain and backend-unit name for shared room context. */
export const DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME = 'development_room_context'

const entrySchema = z.strictObject({
  nodeId: z.string(),
  seq: z.number().int().min(1),
  at: z.number().int().nonnegative(),
  roomId: z.string(),
  participantId: z.string(),
  text: z.string(),
})

/** One atomically stored append-only shared-context log. */
export interface DevelopmentRoomContextLogRecord {
  readonly entries: readonly DevelopmentRoomContextEntry[]
}

const logRecordSchema = z.strictObject({ entries: z.array(entrySchema).min(1) })

/** Versioned domain spec; incompatible pre-release records fail startup. */
export const developmentRoomContextDomainSpec = defineDomain({
  name: DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME,
  version: 1,
  tables: {
    logs: domainTable<DevelopmentNodeId, DevelopmentRoomContextLogRecord>(
      logRecordSchema as unknown as z.ZodType<DevelopmentRoomContextLogRecord>,
    ),
  },
})
