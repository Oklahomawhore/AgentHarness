/** Strict application wire, source recovery, and owner decision records. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { peerContributionGrantSchema, peerContributionReceiptSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeContributionApplicationResult, ScopeContributionEntry, ScopeSingleContributionEntry,
  ScopeGroupEntry, ScopeGroupApplicationId, ScopeContributionLimits, ScopeContributionProposal, ScopeInvitation } from './types.ts'
import { invitationSchema } from './invitation-schema.ts'
import { singleContributionEntrySchema, groupEntrySchema, contributionInvitationSchema,
  contributionLimitsSchema, contributionProposalSchema } from './contribution-schema.ts'

interface ApplicationFields {
  readonly proposal: ScopeContributionProposal | null
  readonly limits: ScopeContributionLimits | null
  readonly decision: 'open' | 'pending' | 'approved' | 'cancelled' | 'rejected' | 'expired'
  readonly grant: DevelopmentTaskPeerContributionGrant | null
  readonly readInvitation?: ScopeInvitation
}

/** Legacy owner records remain single-capture and never accept reusable entries. */
export interface ApplicationRecord extends ApplicationFields {
  readonly entry: ScopeSingleContributionEntry
}

/** Independent durable applicant identity; cancellation can precede its limits-bearing apply. */
export interface GroupMemberRecord extends ApplicationFields {
  readonly applicationId: ScopeGroupApplicationId
  readonly proposal: ScopeContributionProposal
  readonly decision: Exclude<ApplicationFields['decision'], 'open'>
}

/** One atomic reusable entrance and its bounded retained applicant decisions. */
export interface GroupRecord {
  readonly version: 1
  readonly entry: ScopeGroupEntry
  readonly closed: boolean
  readonly members: readonly GroupMemberRecord[]
}

/** The same independent grant lifecycle applies to legacy and explicitly selected group applicants. */
export type ManagedApplicationRecord = ApplicationRecord | (GroupMemberRecord & { readonly entry: ScopeGroupEntry })

const fields = { proposal: contributionProposalSchema.nullable(), limits: contributionLimitsSchema.nullable(),
  decision: z.enum(['open', 'pending', 'approved', 'cancelled', 'rejected', 'expired']), grant: peerContributionGrantSchema.nullable(),
  readInvitation: invitationSchema.optional() }

function validateApplication(record: Omit<ApplicationFields, 'readInvitation'> & {
  readonly entry: ScopeContributionEntry
  readonly readInvitation?: ScopeInvitation | undefined
}, context: z.RefinementCtx): void {
  const { entry, proposal, limits, grant, decision, readInvitation } = record
  if ((decision === 'open' && (proposal !== null || limits !== null || grant !== null))
    || ((decision === 'pending' || decision === 'approved') && (proposal === null || limits === null))
    || (decision === 'approved' && grant === null) || (grant !== null && (proposal === null || limits === null))) {
    context.addIssue({ code: 'custom', message: 'Application decision lacks its original selection' })
  }
  if (((entry.kind === 'scope-join-entry' || entry.kind === 'scope-group-entry') && grant !== null) !== (readInvitation !== undefined)
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
}

/** Parser for the owner's retained single-capture application record. */
export const applicationRecordSchema: z.ZodType<ApplicationRecord> = z.object({ entry: singleContributionEntrySchema, ...fields })
  .strict().superRefine(validateApplication)
  .transform(({ readInvitation, ...record }) => readInvitation === undefined ? record : { ...record, readInvitation })

const memberSchema: z.ZodType<GroupMemberRecord> = z.object({ ...fields,
  applicationId: z.uuid().transform(value => value as ScopeGroupApplicationId), proposal: contributionProposalSchema,
  decision: z.enum(['pending', 'approved', 'cancelled', 'rejected', 'expired']),
}).strict().transform(({ readInvitation, ...record }) => readInvitation === undefined ? record : { ...record, readInvitation })

/** The new domain owns whole-entry atomic admission and per-member authority without widening old records. */
export const groupRecordSchema: z.ZodType<GroupRecord> = z.object({ version: z.literal(1), entry: groupEntrySchema,
  closed: z.boolean(), members: z.array(memberSchema) }).strict().superRefine((record, context) => {
  const identities = record.members.map(member => JSON.stringify([member.proposal.contributorPeerId,
    member.proposal.captureId, member.proposal.captureGeneration]))
  if (record.members.length > record.entry.maxMembers || new Set(identities).size !== identities.length
    || new Set(record.members.map(member => member.applicationId)).size !== record.members.length) {
    context.addIssue({ code: 'custom', message: 'Group applicants exceed capacity or repeat a retained identity' })
  }
  for (const member of record.members) {
    validateApplication({ ...member, entry: record.entry }, context)
    if (member.proposal.contributorPeerId === record.entry.ownerPeerId) {
      context.addIssue({ code: 'custom', message: 'A group source cannot be the owning peer' })
    }
  }
})

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

const common = z.object({ version: z.literal(1), requestId: z.uuid(), entry: singleContributionEntrySchema,
  proposal: contributionProposalSchema }).strict()
/** Peer identity is authenticated by transport, not by any of these request fields. */
export const applicationRequestSchema = z.discriminatedUnion('op', [
  common.extend({ op: z.literal('apply'), limits: contributionLimitsSchema }),
  common.extend({ op: z.literal('status') }), common.extend({ op: z.literal('cancel') }),
]).refine(value => (value.entry.sourceKind === 'tool-observations') === (value.proposal.source.kind === 'tool-observations'))
/** Responses are tied to the exact submitted operation and request identity. */
export const applicationResponseSchema = z.object({ version: z.literal(1), requestId: z.uuid(),
  op: z.enum(['apply', 'status', 'cancel']), result: contributionApplicationResultSchema }).strict()

const groupCommon = z.object({ version: z.literal(2), requestId: z.uuid(), entry: groupEntrySchema,
  proposal: contributionProposalSchema }).strict()
/** Reusable entries have a separate protocol version; legacy requests remain single-capture. */
export const groupApplicationRequestSchema = z.discriminatedUnion('op', [
  groupCommon.extend({ op: z.literal('apply'), limits: contributionLimitsSchema }),
  groupCommon.extend({ op: z.literal('status') }), groupCommon.extend({ op: z.literal('cancel') }),
]).refine(value => value.proposal.source.kind === 'tool-observations')
/** Group replies preserve the independently correlated applicant operation. */
export const groupApplicationResponseSchema = applicationResponseSchema.extend({ version: z.literal(2) })

/** Reserve every retained member's longest terminal decision without changing its authority fields.
 * @param record - complete atomic group record, including all currently retained plans.
 * @returns UTF-8 storage bytes sufficient for closing the entry and terminating every member.
 */
export function groupReservedBytes(record: GroupRecord): number {
  return Buffer.byteLength(JSON.stringify({ ...record, closed: false,
    members: record.members.map(member => ({ ...member, decision: 'cancelled' })) }), 'utf8')
}
