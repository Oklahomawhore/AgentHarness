/** Strict application wire, source recovery, and owner decision records. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { peerContributionGrantSchema, peerContributionReceiptSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeContributionApplicationResult, ScopeContributionEntry, ScopeContributionLimits, ScopeContributionProposal, ScopeInvitation } from './types.ts'
import { invitationSchema } from './invitation-schema.ts'
import { contributionEntrySchema, contributionInvitationSchema, contributionLimitsSchema, contributionProposalSchema } from './contribution-schema.ts'

/** Durable owner intent is separate from the Task event that authorizes publication. */
export interface ApplicationRecord {
  readonly entry: ScopeContributionEntry
  readonly proposal: ScopeContributionProposal | null
  readonly limits: ScopeContributionLimits | null
  readonly decision: 'open' | 'pending' | 'approved' | 'cancelled' | 'rejected' | 'expired'
  readonly grant: DevelopmentTaskPeerContributionGrant | null
  readonly readInvitation?: ScopeInvitation
}

/** Parser for the owner's retained single-capture application record. */
export const applicationRecordSchema: z.ZodType<ApplicationRecord> = z.object({
  entry: contributionEntrySchema, proposal: contributionProposalSchema.nullable(), limits: contributionLimitsSchema.nullable(),
  decision: z.enum(['open', 'pending', 'approved', 'cancelled', 'rejected', 'expired']), grant: peerContributionGrantSchema.nullable(),
  readInvitation: invitationSchema.optional(),
}).strict().superRefine((record, context) => {
  const { entry, proposal, limits, grant, decision, readInvitation } = record
  if ((decision === 'open' && (proposal !== null || limits !== null || grant !== null))
    || ((decision === 'pending' || decision === 'approved') && (proposal === null || limits === null))
    || (decision === 'approved' && grant === null) || (grant !== null && (proposal === null || limits === null))) {
    context.addIssue({ code: 'custom', message: 'Application decision lacks its original selection' })
  }
  if ((entry.kind === 'scope-join-entry' && grant !== null) !== (readInvitation !== undefined)
    || (readInvitation !== undefined && grant !== null && (readInvitation.ownerPeerId !== grant.ownerPeerId
      || readInvitation.taskId !== grant.taskId || readInvitation.recipientPeerId !== grant.contributorPeerId
      || readInvitation.expiresAt !== grant.expiresAt))) {
    context.addIssue({ code: 'custom', message: 'Joint application must retain its separately approved read grant' })
  }
  if (proposal !== null && (entry.sourceKind === 'tool-observations') !== (proposal.source.kind === 'tool-observations')) {
    context.addIssue({ code: 'custom', message: 'Application source differs from the entry permission' })
  }
  if (grant !== null && proposal !== null && limits !== null
    && (grant.taskId !== entry.taskId || grant.ownerPeerId !== entry.ownerPeerId
      || grant.contributorPeerId !== proposal.contributorPeerId || grant.captureId !== proposal.captureId
      || grant.captureGeneration !== proposal.captureGeneration || !isDeepStrictEqual(grant.source, proposal.source)
      || grant.expiresAt > limits.expiresAt || grant.maxSamples > limits.maxSamples || grant.maxSampleBytes > limits.maxSampleBytes)) {
    context.addIssue({ code: 'custom', message: 'Application grant exceeds or changes source consent' })
  }
}).transform(({ readInvitation, ...record }) => readInvitation === undefined ? record : { ...record, readInvitation })

const readFields = { readInvitation: invitationSchema.optional(), readState: z.enum(['active', 'revoked', 'expired']).optional() }

/** Original contribution receipts and separately observed joint read authority accompany returned grants. */
export const contributionApplicationResultSchema: z.ZodType<ScopeContributionApplicationResult> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('approved'), invitation: contributionInvitationSchema, ...readFields,
    receipt: peerContributionReceiptSchema.refine(value => value.event.kind === 'peer-contribution-opened') }).strict(),
  z.object({ status: z.literal('ended'), invitation: contributionInvitationSchema, ...readFields, reason: z.enum(['left', 'revoked', 'expired']),
    receipt: peerContributionReceiptSchema.refine(value => value.event.kind === 'peer-contribution-ended') }).strict(),
  z.object({ status: z.enum(['rejected', 'cancelled', 'expired', 'denied', 'capacity', 'unavailable']) }).strict(),
]).superRefine((result, context) => {
  if (result.status !== 'approved' && result.status !== 'ended') return
  const read = result.readInvitation
  const grant = result.invitation.grant
  if ((read === undefined) !== (result.readState === undefined)
    || (read !== undefined && (grant.source.kind !== 'tool-observations' || read.ownerPeerId !== grant.ownerPeerId
      || read.recipientPeerId !== grant.contributorPeerId || read.taskId !== grant.taskId || read.expiresAt !== grant.expiresAt))) {
    context.addIssue({ code: 'custom', message: 'Joint read permission differs from the original application' })
  }
}).transform((result) => {
  if (result.status !== 'approved' && result.status !== 'ended') return result
  const { readInvitation, readState, ...retained } = result
  return readInvitation === undefined || readState === undefined ? retained : { ...retained, readInvitation, readState }
})

const common = z.object({ version: z.literal(1), requestId: z.uuid(), entry: contributionEntrySchema,
  proposal: contributionProposalSchema }).strict()
/** Peer identity is authenticated by transport, not by any of these request fields. */
export const applicationRequestSchema = z.discriminatedUnion('op', [
  common.extend({ op: z.literal('apply'), limits: contributionLimitsSchema }),
  common.extend({ op: z.literal('status') }), common.extend({ op: z.literal('cancel') }),
]).refine(value => (value.entry.sourceKind === 'tool-observations') === (value.proposal.source.kind === 'tool-observations'))
/** Responses are tied to the exact submitted operation and request identity. */
export const applicationResponseSchema = z.object({ version: z.literal(1), requestId: z.uuid(),
  op: z.enum(['apply', 'status', 'cancel']), result: contributionApplicationResultSchema }).strict()
