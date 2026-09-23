/** Hostile-input schemas shared by Task storage and Mesh adapters. */

import { z } from 'zod'
import type {
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskContextBlock,
  DevelopmentTaskLogEntry,
} from './types.ts'

const participant = z.string()
const publication = z.strictObject({
  id: z.string(), text: z.string(), uri: z.string().optional(), publishedBy: participant, publishedAt: z.number().int().nonnegative(),
})
const parent = z.strictObject({ taskId: z.string(), revision: z.number().int().min(1) })
const origin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('fork'), parent }),
  z.strictObject({ kind: z.literal('merge'), parents: z.array(parent).min(2) }),
])
const change = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task-created'), origin, objective: z.string(), scope: z.string(),
    createdBy: participant, inheritedContextBlockId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('context-published'), publication }),
])

/** Exact Task event accepted from SQLite or an authenticated Mesh peer. */
export const developmentTaskEventSchema = z.strictObject({
  nodeId: z.string(), seq: z.number().int().min(1), at: z.number().int().nonnegative(), taskId: z.string(),
  revision: z.number().int().min(1), hiddenRoomId: z.string(), change,
}) as unknown as z.ZodType<DevelopmentTaskLogEntry>

const inheritedSource = z.strictObject({
  parent, objective: z.string(), scope: z.string(), context: z.array(publication),
})

/** Exact content-addressed Task block accepted from SQLite or Mesh. */
export const developmentTaskContextBlockSchema = z.strictObject({
  id: z.string(), createdAt: z.number().int().nonnegative(), sources: z.array(inheritedSource).min(1),
}) as unknown as z.ZodType<DevelopmentTaskContextBlock>

const assignmentChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task-bound'), taskId: z.string(), sessionLabel: z.string().optional() }),
  z.strictObject({ kind: z.literal('task-cleared'), previousTaskId: z.string() }),
  z.strictObject({ kind: z.literal('context-acknowledged'), taskId: z.string(), revision: z.number().int().min(1) }),
])

/** Exact Agent session-binding event accepted from SQLite or Mesh. */
export const developmentTaskAssignmentEventSchema = z.strictObject({
  nodeId: z.string(), seq: z.number().int().min(1), at: z.number().int().nonnegative(), bindingId: z.string(),
  participantId: z.string(), change: assignmentChange,
}) as unknown as z.ZodType<DevelopmentTaskAssignmentLogEntry>
