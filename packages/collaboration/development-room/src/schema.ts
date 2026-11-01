/** Room change payload parsing shared by Mesh and durable-log consumers. */
import { z } from 'zod'

/** Strict change fields; the Room service validates identifiers, text limits, and log relationships. */
export const developmentRoomChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('room-created'), objective: z.string() }),
  z.strictObject({ kind: z.literal('participant-joined'), participantId: z.string() }),
  z.strictObject({ kind: z.literal('participant-left'), participantId: z.string() }),
])
