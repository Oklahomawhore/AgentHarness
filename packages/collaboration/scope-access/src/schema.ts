/** Strict invitation and exact-projection validation shared by wire and Session consumers. */

import { createHash } from 'node:crypto'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import type { DevelopmentTaskContextActivation, DevelopmentTaskContextEvidenceId } from '@deepseek-ai/dsh-development-task-context/types'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { z } from 'zod'
import type { ScopeGeneration, ScopeGrantId, ScopeAccessProjection, ScopeAccessLegacyProjection, ScopeAccessCurrentProjection, ScopeProjectionId } from './types.ts'

const peer = z.string().min(1).max(256).transform(value => value as ScopePeerId)
const task = z.string().min(1).max(256).transform(value => value as DevelopmentTaskId)
const grantId = z.uuid().transform(value => value as ScopeGrantId)
const generation = z.uuid().transform(value => value as ScopeGeneration)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export { invitationSchema, sameReadGrant } from './invitation-schema.ts'

const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: task, revision: integer.positive() }).strict(),
  z.object({ kind: z.literal('publication'), taskId: task, revision: integer.positive(), publicationId: z.string().min(1) }).strict(),
])

/** Provider-owned scheduling evidence, never a substitute for current read authority. */
export const activationSchema: z.ZodType<DevelopmentTaskContextActivation> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact') }).strict(),
  z.object({ kind: z.literal('recipient-evidence'), version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskContextEvidenceId),
    coverage: z.enum(['complete', 'blocked-current']),
  }).strict(),
])

const projectionContent = {
  projectionId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ScopeProjectionId),
  taskId: task, taskRevision: integer.positive(),
  ownerPeerId: peer, recipientPeerId: peer, grantId, grantGeneration: generation, expiresAt: integer,
  backend: z.object({ id: z.string().min(1), revision: z.string().min(1) }).strict(), maxContextBytes: integer.positive(),
  text: z.string(), selectedSources: z.array(source),
  omittedSources: z.array(z.object({
    source, reason: z.enum(['self-published', 'budget', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant']),
  }).strict()),
}

/** Exact bytes and bounded attribution validated before either Host persists a projection. */
export const projectionSchema: z.ZodType<ScopeAccessProjection> = z.union([
  z.object(projectionContent).strict(),
  z.object({ ...projectionContent, version: z.literal(2), activation: activationSchema }).strict(),
]).superRefine((value, ctx) => {
  const sources = [...value.selectedSources, ...value.omittedSources.map(item => item.source)]
  if (sources.some(item => item.taskId !== value.taskId || item.revision !== value.taskRevision)
    || new Set(sources.map(item => JSON.stringify(item))).size !== sources.length
    || Buffer.byteLength(value.text, 'utf8') > value.maxContextBytes
    || projectionDigest(value) !== value.projectionId) {
    ctx.addIssue({ code: 'custom', message: 'projection identity, source coverage, or byte budget is invalid' })
  }
})

/**
 * Identify exact projection bytes and authority without a self-referential digest.
 * @param projection - fields emitted in the public projection representation.
 * @returns SHA-256 digest of the ordered, complete projection fields.
 */
export function projectionDigest(projection: Omit<ScopeAccessLegacyProjection, 'projectionId'> | Omit<ScopeAccessCurrentProjection, 'projectionId'>): ScopeProjectionId {
  const sourceIdentity = (item: ScopeAccessProjection['selectedSources'][number]) =>
    [item.kind, item.taskId, item.revision, item.kind === 'publication' ? item.publicationId : null]
  const fields: unknown[] = [
    projection.taskId, projection.taskRevision, projection.ownerPeerId, projection.recipientPeerId,
    projection.grantId, projection.grantGeneration, projection.expiresAt, projection.backend.id, projection.backend.revision,
    projection.maxContextBytes, projection.text, projection.selectedSources.map(sourceIdentity),
    projection.omittedSources.map(item => [sourceIdentity(item.source), item.reason]),
  ]
  if (projection.version === 2) {
    const activation = projection.activation
    fields.push(['scope-access-projection', 2, activation.kind === 'exact'
      ? ['exact'] : ['recipient-evidence', activation.version, activation.digest, activation.coverage]])
  }
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex') as ScopeProjectionId
}

export { contributionInvitationSchema, contributionStatusSchema, contributionSubmitSchema, contributionEndSchema,
  validateContributionReceipt, contributionProposalSchema, decodeContributionText, encodeContributionProposal, encodeContributionInvitation } from './contribution-schema.ts'

export { contributionEntrySchema, contributionLimitsSchema } from './contribution-schema.ts'
export { contributionApplicationResultSchema } from './application-schema.ts'
