/** Durable owner-local context validation; old passive records retain their original parser. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentTaskBindingId, DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import type { DevelopmentTaskContextEvidenceId, DevelopmentTaskContextSource, DevelopmentTaskLocalContextProjection,
  DevelopmentTaskLocalContextProjectionId, DevelopmentTaskLocalContextTarget } from './types.ts'

const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const taskId = z.string().min(1).transform(value => value as DevelopmentTaskId)
const nodeId = z.string().min(1).transform(value => value as DevelopmentNodeId)
const targetFields = {
  taskId, participantId: z.string().min(1).transform(value => value as DevelopmentParticipantId),
  taskBindingId: z.string().min(1).transform(value => value as DevelopmentTaskBindingId),
  bindingEpoch: z.strictObject({ nodeId, seq: integer }),
}

/** Strict local assignment identity retained in scheduling state and remote management input. */
export const localContextTargetSchema: z.ZodType<DevelopmentTaskLocalContextTarget> = z.strictObject(targetFields)

const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), taskId, revision: integer }),
  z.strictObject({ kind: z.literal('publication'), taskId, revision: integer, publicationId: z.string().min(1) }),
])
const activation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exact') }),
  z.strictObject({ kind: z.literal('recipient-evidence'), version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskContextEvidenceId),
    coverage: z.enum(['complete', 'blocked-current']) }),
])

/** Exact local projection validated when durable scheduling or context records are read. */
export const localContextProjectionSchema: z.ZodType<DevelopmentTaskLocalContextProjection> = z.strictObject({
  ...targetFields, kind: z.literal('local-task'), version: z.literal(1),
  projectionId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskLocalContextProjectionId),
  taskRevision: integer, ownerNodeId: nodeId,
  backend: z.strictObject({ id: z.string().min(1), revision: z.string().min(1) }), maxContextBytes: integer,
  text: z.string(), activation, selectedSources: z.array(source),
  omittedSources: z.array(z.strictObject({ source,
    reason: z.enum(['self-published', 'budget', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant']) })),
}).superRefine((value, ctx) => {
  const sources = [...value.selectedSources, ...value.omittedSources.map(item => item.source)]
  if (sources.some(item => item.taskId !== value.taskId || item.revision !== value.taskRevision)
    || new Set(sources.map(item => JSON.stringify(item))).size !== sources.length
    || Buffer.byteLength(value.text, 'utf8') > value.maxContextBytes
    || localContextProjectionDigest(value) !== value.projectionId) {
    ctx.addIssue({ code: 'custom', message: 'local projection identity, coverage, or byte budget is invalid' })
  }
})

/**
 * Identify the full projection without depending on object property insertion order.
 * @param projection - exact local result, excluding its self-referential digest.
 * @returns stable complete projection identity.
 */
export function localContextProjectionDigest(projection: Omit<DevelopmentTaskLocalContextProjection, 'projectionId'>): DevelopmentTaskLocalContextProjectionId {
  const ref = (item: DevelopmentTaskLocalContextProjection['selectedSources'][number]) =>
    [item.kind, item.taskId, item.revision, item.kind === 'publication' ? item.publicationId : null]
  const value = projection.activation
  return createHash('sha256').update(JSON.stringify(['local-task', 1, projection.taskId, projection.taskRevision,
    projection.ownerNodeId, projection.participantId, projection.taskBindingId, projection.bindingEpoch.nodeId, projection.bindingEpoch.seq,
    projection.backend.id, projection.backend.revision, projection.maxContextBytes, projection.text,
    projection.selectedSources.map(ref), projection.omittedSources.map(item => [ref(item.source), item.reason]),
    value.kind === 'exact' ? ['exact'] : ['recipient-evidence', value.version, value.digest, value.coverage],
  ])).digest('hex') as DevelopmentTaskLocalContextProjectionId
}

const sourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), taskId: z.string().transform(value => value as DevelopmentTaskId), revision: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('publication'), taskId: z.string().transform(value => value as DevelopmentTaskId), revision: z.number().int().min(1), publicationId: z.string() }),
])
/** Current and historical passive Task message sources, including exact managed local projections. */
export const localTaskContextSourceSchema: z.ZodType<DevelopmentTaskContextSource> = z.union([
  z.strictObject({ kind: z.literal('development-task-context'), form: z.literal('withdrawn'), version: z.literal(3),
    reason: z.enum(['left', 'revoked', 'expired', 'unavailable', 'conflict', 'failed']) }),
  z.strictObject({ kind: z.literal('development-task-context'), form: z.literal('snapshot'),
    version: z.literal(3), projection: localContextProjectionSchema }),
  z.strictObject({
    kind: z.literal('development-task-context'),
    form: z.literal('snapshot'),
    version: z.literal(2),
    taskId: z.string().transform(value => value as DevelopmentTaskId),
    revision: z.number().int().min(1),
    bindingId: z.string().transform(value => value as DevelopmentTaskBindingId),
    bindingEpoch: z.strictObject({ nodeId: z.string().transform(value => value as DevelopmentNodeId), seq: z.number().int().min(1) }),
    backend: z.strictObject({ id: z.string(), revision: z.string() }),
    maxContextBytes: z.number().int().min(1),
    selectedSources: z.array(sourceRefSchema),
    omittedSources: z.array(z.strictObject({
      source: sourceRefSchema, reason: z.enum(['self-published', 'budget', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant']),
    })),
  }),
  z.strictObject({
    kind: z.literal('development-task-context'),
    form: z.literal('snapshot'),
    version: z.literal(1),
    taskId: z.string().transform(value => value as DevelopmentTaskId),
    revision: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('development-task-context'),
    form: z.literal('retired'),
    version: z.literal(1),
    activeTaskId: z.string().transform(value => value as DevelopmentTaskId),
    activeRevision: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('development-task-context'),
    form: z.literal('disconnected'),
    version: z.literal(1),
  }),
])
