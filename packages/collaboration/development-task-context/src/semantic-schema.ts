/** Strict model and durable records for the semantic context provider. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DevelopmentTaskId, DevelopmentParticipantId } from '@deepseek-ai/dsh-development-task/types'

/** Canonical object-key ordering for stable audit identities.
 * @param value - JSON value.
 * @returns Canonical JSON.
 */
export function semanticJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
}

/** Hash exact normalized request fields.
 * @param value - JSON fields.
 * @returns SHA-256 identity.
 */
export function semanticDigest(value: unknown): string {
  return createHash('sha256').update(semanticJson(value)).digest('hex')
}

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: z.string().min(1).transform(brandString<DevelopmentTaskId>),
    revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('publication'), taskId: z.string().min(1).transform(brandString<DevelopmentTaskId>),
    revision: z.number().int().positive(), publicationId: z.string().min(1) }).strict(),
])

/** Versioned response JSON; source correspondence and quotes are checked against the captured input. */
export const semanticReplySchema = z.object({
  version: z.literal(1),
  decisions: z.array(z.object({ sourceId: digest, relevant: z.boolean() }).strict()),
  updates: z.array(z.object({ text: z.string().trim().min(1), sources: z.array(z.object({
    sourceId: digest, quote: z.string().min(1).refine(value => value.trim().length > 0),
  }).strict()).min(1) }).strict()),
}).strict()

/** Parsed natural-language updates and explicit per-source decisions. */
export type SemanticReply = z.infer<typeof semanticReplySchema>

/** Exact durable projection; this provider never claims semantic activation equivalence. */
export const semanticProjectionSchema = z.object({
  activation: z.object({ kind: z.literal('exact') }).strict(), text: z.string(),
  selectedSources: z.array(source), omittedSources: z.array(z.object({ source,
    reason: z.enum(['self-published', 'budget', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant']),
  }).strict()),
}).strict()

/** Complete captured prompt JSON, sufficient to reconstruct and check a cached projection without a model call. */
export const semanticCapturedInputSchema = z.object({
  task: z.object({ id: z.string().min(1).transform(brandString<DevelopmentTaskId>), revision: z.number().int().positive(),
    objective: z.string(), scope: z.string(), origin: z.json() }).strict(),
  recipient: z.object({ participantId: z.string().min(1).transform(brandString<DevelopmentParticipantId>),
    sessionLabel: z.string().optional() }).strict(),
  inherited: z.array(z.object({ parent: z.object({ taskId: z.string().min(1), revision: z.number().int().positive() }).strict(),
    objective: z.string(), scope: z.string() }).strict()),
  sources: z.array(z.object({ sourceId: digest, source, body: z.string(), attribution: z.json() }).strict()),
  mandatory: z.array(z.json()),
  coverage: semanticProjectionSchema.pick({ selectedSources: true, omittedSources: true }),
}).strict()

const call = z.object({ provider: z.string().min(1), model: z.string().min(1),
  maxTokens: z.number().int().positive(), temperature: z.number().optional(),
  reasoningEffort: z.string().min(1).optional(), stop: z.array(z.string()).optional(),
}).strict()
const userMessage = z.object({ id: z.string().min(1).transform(MessageId), role: z.literal('user'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()).length(1),
  source: z.object({ kind: z.literal('plugin'), plugin: z.literal('dsh-development-task-context/semantic') }).strict(),
}).strict()

/** Persisted reservation and exact effective request before adapter dispatch. */
export const semanticRequestSchema = z.object({
  version: z.literal(1), key: digest, ordinal: z.number().int().positive(),
  backend: z.object({ id: z.literal('semantic'), revision: digest }).strict(),
  call, system: z.string(), messages: z.array(userMessage).length(1),
  purpose: z.literal('context-summary'), maxContextBytes: z.number().int().positive(),
}).strict()

/** Durable request record; each record consumes one deployment call reservation, including interrupted attempts. */
export type SemanticRequestRecord = z.infer<typeof semanticRequestSchema>

const usage = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative().optional(), cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(), reasoningTokens: z.number().nonnegative().optional(),
}).strict()

/** Completed or failed result, retaining bounded raw blocks and explicitly unknown usage. */
export const semanticResultSchema = z.object({
  version: z.literal(1), key: digest, requestSeq: z.number().int().nonnegative(),
  status: z.enum(['completed', 'failed']), rawOutput: z.array(z.json()), finish: z.json().nullable(),
  usage: usage.nullable(), elapsedMs: z.number().nonnegative(), error: z.string().nullable(),
  rejectedChunk: z.object({ bytes: z.number().int().positive(), sha256: digest }).strict().nullable(),
  projection: semanticProjectionSchema.nullable(),
}).strict().superRefine((record, ctx) => {
  if (record.status === 'completed' ? record.projection === null || record.error !== null
    : record.projection !== null || record.error === null) {
    ctx.addIssue({ code: 'custom', message: 'semantic result status disagrees with its projection/error' })
  }
  if (record.status === 'completed' && record.rejectedChunk !== null) {
    ctx.addIssue({ code: 'custom', message: 'completed semantic result cannot omit a chunk' })
  }
})

/** Persisted outcome for exactly one reserved request. */
export type SemanticResultRecord = z.infer<typeof semanticResultSchema>

/** Request identity excludes the generated message ID and attempt ordinal.
 * @param request - Request fields.
 * @returns Stable cache key.
 */
export function semanticRequestKey(request: Omit<SemanticRequestRecord, 'key' | 'ordinal' | 'version' | 'purpose'>): string {
  return semanticDigest({ backend: request.backend, call: request.call, system: request.system,
    input: request.messages[0]?.content, maxContextBytes: request.maxContextBytes })
}
