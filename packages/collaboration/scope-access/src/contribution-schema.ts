/** Independent contribution invitations, correlated wire replies, and exact durable receipt associations. */
import { z } from 'zod'
import {
  peerContributionGrantSchema, peerContributionProposalSchema, legacyPeerContributionSampleSchema,
  recordedPeerContributionSampleSchema, completedFilePeerContributionSampleSchema, commandPeerContributionSampleSchema,
  completedTurnPeerContributionSampleSchema, nativeWorkPeerContributionSampleSchema,
  claudeWorkPeerContributionSampleSchema,
  peerContributionReceiptSchema,
  peerContributionAdmissionReceiptSchema, peerContributionPayloadDigest, peerContributionPublicationId,
} from '@deepseek-ai/dsh-development-task/schema'
import type {
  DevelopmentTaskPeerContributionReceipt, DevelopmentTaskPeerContributionAdmissionReceipt, DevelopmentTaskContributionSource,
} from '@deepseek-ai/dsh-development-task/types'
import type {
  ScopeContributionInvitation, ScopeContributionSample, ScopeContributionStatusResult,
  ScopeContributionSubmitResult, ScopeContributionEndResult, ScopeContributionProposal, ScopeContributionTransfer,
  ScopeContributionApproveRequest, ScopeContributionRecoverRequest, ScopeContributionEntry, ScopeSingleContributionEntry,
  ScopeGroupEntry, ScopeContributionLimits,
} from './types.ts'

/** Select the transfer discriminator for one exact contribution permission.
 * @param source - source authorized independently of other contribution kinds.
 * @returns the corresponding invitation kind without adding permissions.
 */
export function contributionKind(source: DevelopmentTaskContributionSource): ScopeContributionInvitation['kind'] {
  return source.kind === 'claude-work' ? 'claude-work-contribution'
    : source.kind === 'native-work' ? 'native-work-contribution'
      : source.kind === 'completed-turn-outcomes' ? 'turn-contribution'
        : source.kind === 'tool-observations' ? 'tool-contribution' : 'openapi-contribution'
}

/** Write invitations carry their own discriminator and never inherit read-invitation authority. */
export const contributionInvitationSchema: z.ZodType<ScopeContributionInvitation> = z.object({
  version: z.literal(1), kind: z.enum(['openapi-contribution', 'tool-contribution', 'turn-contribution', 'native-work-contribution', 'claude-work-contribution']),
  ownerAddress: z.string().min(1).max(2048), grant: peerContributionGrantSchema,
}).strict().refine(value => value.kind === contributionKind(value.grant.source))

/** Exact transferable capture selection, validated by the Task grant owner. */
export const contributionProposalSchema: z.ZodType<ScopeContributionProposal> = peerContributionProposalSchema

const entryFields = {
  version: z.literal(1), entryId: z.uuid(), taskId: z.string().min(1).max(256), ownerPeerId: z.string().min(1).max(256),
  ownerAddress: z.string().min(1).max(2048), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}
/** Single-capture application entrance; legacy entries permit only OpenAPI sources. */
export const singleContributionEntrySchema: z.ZodType<ScopeSingleContributionEntry> = z.discriminatedUnion('kind', [
  z.strictObject({ ...entryFields, kind: z.literal('openapi-contribution-entry') }),
  z.strictObject({ ...entryFields, kind: z.literal('contribution-entry'), sourceKind: z.enum(['openapi', 'tool-observations', 'completed-turn-outcomes', 'native-work', 'claude-work']) }),
  z.strictObject({ ...entryFields, kind: z.literal('scope-join-entry'), sourceKind: z.enum(['tool-observations', 'completed-turn-outcomes', 'native-work', 'claude-work']) }),
]).transform(value => ({ ...value, entryId: value.entryId as ScopeContributionEntry['entryId'],
  taskId: value.taskId as ScopeContributionEntry['taskId'], ownerPeerId: value.ownerPeerId as ScopeContributionEntry['ownerPeerId'] }))

/** Explicit version-two group entrance; legacy single-capture parsers never accept it. */
export const groupEntrySchema: z.ZodType<ScopeGroupEntry> = z.strictObject({
  ...entryFields, version: z.literal(2), kind: z.literal('scope-group-entry'), sourceKind: z.enum(['tool-observations', 'completed-turn-outcomes', 'native-work', 'claude-work']),
  maxMembers: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).transform(value => ({ ...value, entryId: value.entryId as ScopeGroupEntry['entryId'],
  taskId: value.taskId as ScopeGroupEntry['taskId'], ownerPeerId: value.ownerPeerId as ScopeGroupEntry['ownerPeerId'] }))

/** Transferable entrances preserve their explicitly selected single-capture or reusable semantics. */
export const contributionEntrySchema: z.ZodType<ScopeContributionEntry> = z.union([singleContributionEntrySchema, groupEntrySchema])


/** All source consent ceilings are positive, explicit, and immutable on retry. */
export const contributionLimitsSchema: z.ZodType<ScopeContributionLimits> = z.object({
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSamples: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSampleBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

const transferSchema: z.ZodType<ScopeContributionTransfer> = z.union([
  z.object({ version: z.literal(1), kind: z.enum(['openapi-contribution-request', 'tool-contribution-request', 'turn-contribution-request', 'native-work-contribution-request', 'claude-work-contribution-request']), proposal: contributionProposalSchema }).strict()
    .refine(value => value.kind === `${contributionKind(value.proposal.source)}-request`),
  contributionInvitationSchema, contributionEntrySchema,
])

/**
 * Decode a complete user-pasted transfer without granting or contacting any peer.
 * @param text - versioned JSON proposal or contribution invitation.
 * @param maxBytes - owning deployment's complete UTF-8 input limit, including whitespace.
 * @returns strictly validated transferable fields with no local file permission.
 */
export function decodeContributionText(text: string, maxBytes: number): ScopeContributionTransfer {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('scope contribution text exceeds its byte limit')
  return transferSchema.parse(JSON.parse(text))
}

/**
 * Encode a source-owned proposal for explicit transfer to an owner.
 * @param proposal - original capture identity and exact source selector.
 * @param maxBytes - owning deployment's complete UTF-8 transfer limit.
 * @returns canonical versioned JSON text; no owner permission is implied.
 */
export function encodeContributionProposal(proposal: ScopeContributionProposal, maxBytes: number): string {
  const text = JSON.stringify({ version: 1, kind: `${contributionKind(proposal.source)}-request`, proposal })
  return JSON.stringify(decodeContributionText(text, maxBytes))
}

/**
 * Encode an owner invitation for explicit transfer to its pinned contributor.
 * @param invitation - exact immutable grant and currently confirmed owner address.
 * @param maxBytes - owning deployment's complete UTF-8 transfer limit.
 * @returns canonical versioned JSON text, independently verified online on use.
 */
export function encodeContributionInvitation(invitation: ScopeContributionInvitation, maxBytes: number): string {
  const text = JSON.stringify(invitation)
  return JSON.stringify(decodeContributionText(text, maxBytes))
}

/** Authenticated approval fields; identities are assigned by the local owner. */
export const contributionApproveSchema: z.ZodType<ScopeContributionApproveRequest> = z.object({
  taskId: z.string().min(1).max(256), ownerAddress: z.string().min(1).max(2048), proposal: contributionProposalSchema,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSamples: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSampleBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().transform(value => ({ ...value, taskId: value.taskId as ScopeContributionApproveRequest['taskId'] }))

/** Recovery identifies original authority and never accepts replacement grant fields. */
export const contributionRecoverSchema: z.ZodType<ScopeContributionRecoverRequest> = z.object({
  taskId: z.string().min(1).max(256), grantId: z.string().min(1).max(256), generation: z.string().min(1).max(256),
  ownerAddress: z.string().min(1).max(2048),
}).strict().transform(value => ({ ...value, taskId: value.taskId as ScopeContributionRecoverRequest['taskId'],
  grantId: value.grantId as ScopeContributionRecoverRequest['grantId'], generation: value.generation as ScopeContributionRecoverRequest['generation'] }))

const failure = z.object({ status: z.enum(['denied', 'capacity', 'unavailable']) }).strict()
const ended = z.object({ status: z.literal('ended'), reason: z.enum(['left', 'revoked', 'expired']),
  receipt: peerContributionReceiptSchema.refine(value => value.event.kind === 'peer-contribution-ended') }).strict()

/** Strict online status; permission does not authorize local file reads. */
export const contributionStatusSchema: z.ZodType<ScopeContributionStatusResult> = z.union([
  z.object({ status: z.literal('active'), receipt: peerContributionReceiptSchema.refine(value => value.event.kind === 'peer-contribution-opened') }).strict(), ended, failure,
])
/** Strict admission result whose receipt still requires association with the exact local outbox. */
export const contributionSubmitSchema: z.ZodType<ScopeContributionSubmitResult> = z.union([
  z.object({ status: z.enum(['accepted', 'reused']), receipt: peerContributionAdmissionReceiptSchema }).strict(), ended, failure,
])
/** Strict end result; only a matched receipt permits clearing a pending local end. */
export const contributionEndSchema: z.ZodType<ScopeContributionEndResult> = z.union([ended, failure])

const legacyInvitation = contributionInvitationSchema.refine(value => value.grant.source.kind !== 'native-work'
  && value.grant.source.kind !== 'claude-work'
  && value.grant.source.kind !== 'completed-turn-outcomes'
  && (value.grant.source.kind !== 'tool-observations' || value.grant.source.version !== 4))
const request = z.object({ version: z.literal(1), requestId: z.uuid(), invitation: legacyInvitation }).strict()
/** Version-one peer requests accept only original samples and retain their status/end operations. */
export const contributionRequestSchema = z.discriminatedUnion('op', [
  request.extend({ op: z.literal('status') }),
  request.extend({ op: z.literal('sample'), sample: legacyPeerContributionSampleSchema }),
  request.extend({ op: z.literal('end') }),
])

/** Version-two contribution requests carry only explicitly attributed recorded-local-tool samples. */
export const recordedContributionRequestSchema = request.extend({
  version: z.literal(2), op: z.literal('sample'), sample: recordedPeerContributionSampleSchema,
})

/** Version-three requests carry only explicitly permitted native completed-file samples. */
export const completedFileContributionRequestSchema = request.extend({
  version: z.literal(3), op: z.literal('sample'), sample: completedFilePeerContributionSampleSchema,
})

const commandRequest = request.extend({ version: z.literal(4),
  invitation: contributionInvitationSchema.refine(value => value.grant.source.kind === 'tool-observations' && value.grant.source.version === 4),
})
/** Version-four command permissions retain their status, file/command samples, and terminal operations without downgrade. */
export const commandContributionRequestSchema = z.discriminatedUnion('op', [
  commandRequest.extend({ op: z.literal('status') }),
  commandRequest.extend({ op: z.literal('sample'), sample: commandPeerContributionSampleSchema }),
  commandRequest.extend({ op: z.literal('end') }),
])

const turnRequest = request.extend({ version: z.literal(5),
  invitation: contributionInvitationSchema.refine(value => value.grant.source.kind === 'completed-turn-outcomes'),
})
/** Version-five permissions admit complete turn reports and their own status/end operations without downgrade. */
export const completedTurnContributionRequestSchema = z.discriminatedUnion('op', [
  turnRequest.extend({ op: z.literal('status') }),
  turnRequest.extend({ op: z.literal('sample'), sample: completedTurnPeerContributionSampleSchema }),
  turnRequest.extend({ op: z.literal('end') }),
])

const nativeWorkRequest = request.extend({ version: z.literal(6),
  invitation: contributionInvitationSchema.refine(value => value.grant.source.kind === 'native-work'),
})
/** Version-six status, samples and end share one explicitly combined native permission. */
export const nativeWorkContributionRequestSchema = z.discriminatedUnion('op', [
  nativeWorkRequest.extend({ op: z.literal('status') }),
  nativeWorkRequest.extend({ op: z.literal('sample'), sample: nativeWorkPeerContributionSampleSchema }),
  nativeWorkRequest.extend({ op: z.literal('end') }),
])

const claudeWorkRequest = request.extend({ version: z.literal(7),
  invitation: contributionInvitationSchema.refine(value => value.grant.source.kind === 'claude-work'),
})
/** Version-seven operations preserve Claude permission even when the sample is a version-one file report. */
export const claudeWorkContributionRequestSchema = z.discriminatedUnion('op', [
  claudeWorkRequest.extend({ op: z.literal('status') }),
  claudeWorkRequest.extend({ op: z.literal('sample'), sample: claudeWorkPeerContributionSampleSchema }),
  claudeWorkRequest.extend({ op: z.literal('end') }),
])

const response = z.object({ version: z.literal(1), requestId: z.uuid() }).strict()
/** A response is correlated to the operation as well as the unique request identifier. */
export const contributionResponseSchema = z.discriminatedUnion('op', [
  response.extend({ op: z.literal('status'), result: contributionStatusSchema }),
  response.extend({ op: z.literal('sample'), result: contributionSubmitSchema }),
  response.extend({ op: z.literal('end'), result: contributionEndSchema }),
])

/** Version-two sample replies retain exact receipts and cannot acknowledge legacy operations. */
export const recordedContributionResponseSchema = response.extend({
  version: z.literal(2), op: z.literal('sample'), result: contributionSubmitSchema,
})

/** Version-three replies acknowledge only the exact completed-file sample operation. */
export const completedFileContributionResponseSchema = response.extend({
  version: z.literal(3), op: z.literal('sample'), result: contributionSubmitSchema,
})

/** Version-four replies correlate each operation under the exact command permission. */
export const commandContributionResponseSchema = z.discriminatedUnion('op', [
  response.extend({ version: z.literal(4), op: z.literal('status'), result: contributionStatusSchema }),
  response.extend({ version: z.literal(4), op: z.literal('sample'), result: contributionSubmitSchema }),
  response.extend({ version: z.literal(4), op: z.literal('end'), result: contributionEndSchema }),
])

/** Version-five replies correlate the operation under the independent completed-turn permission. */
export const completedTurnContributionResponseSchema = z.discriminatedUnion('op', [
  response.extend({ version: z.literal(5), op: z.literal('status'), result: contributionStatusSchema }),
  response.extend({ version: z.literal(5), op: z.literal('sample'), result: contributionSubmitSchema }),
  response.extend({ version: z.literal(5), op: z.literal('end'), result: contributionEndSchema }),
])

/** Version-six replies correlate every operation without downgrading combined permission. */
export const nativeWorkContributionResponseSchema = z.discriminatedUnion('op', [
  response.extend({ version: z.literal(6), op: z.literal('status'), result: contributionStatusSchema }),
  response.extend({ version: z.literal(6), op: z.literal('sample'), result: contributionSubmitSchema }),
  response.extend({ version: z.literal(6), op: z.literal('end'), result: contributionEndSchema }),
])

/** Version-seven replies correlate each operation under the original Claude work permission. */
export const claudeWorkContributionResponseSchema = z.discriminatedUnion('op', [
  response.extend({ version: z.literal(7), op: z.literal('status'), result: contributionStatusSchema }),
  response.extend({ version: z.literal(7), op: z.literal('sample'), result: contributionSubmitSchema }),
  response.extend({ version: z.literal(7), op: z.literal('end'), result: contributionEndSchema }),
])

/**
 * Validate a wire or restored receipt against the exact invitation and optional persisted sample.
 * @param invitation - pinned owner, contributor, Task, and capture generation.
 * @param receipt - parser-validated base or sample receipt retained by the consumer.
 * @param sample - exact outbox payload for an admission receipt; omit for open or terminal commits.
 * @param expectedKind - original open or terminal event kind required by a durable consumer.
 * @returns normally only when every caller-known identity and sample digest matches; otherwise throws.
 */
export function validateContributionReceipt(invitation: ScopeContributionInvitation,
  receipt: DevelopmentTaskPeerContributionReceipt | DevelopmentTaskPeerContributionAdmissionReceipt,
  sample?: ScopeContributionSample, expectedKind?: 'peer-contribution-opened' | 'peer-contribution-ended'): void {
  const grant = invitation.grant
  if (expectedKind !== undefined && receipt.event.kind !== expectedKind) {
    throw new Error('scope-access: contribution receipt records another operation')
  }
  if (receipt.taskId !== grant.taskId || receipt.ownerPeerId !== grant.ownerPeerId
    || receipt.contributorPeerId !== grant.contributorPeerId || receipt.grantId !== grant.grantId
    || receipt.generation !== grant.generation || receipt.captureId !== grant.captureId
    || receipt.captureGeneration !== grant.captureGeneration) {
    throw new Error('scope-access: contribution receipt does not match its invitation')
  }
  if (sample !== undefined) {
    const admitted = peerContributionAdmissionReceiptSchema.parse(receipt)
    const request = { grant, ...sample }
    if (admitted.sourceId !== sample.sourceId || admitted.sequence !== sample.sequence
      || admitted.payloadDigest !== peerContributionPayloadDigest(request)
      || admitted.publicationId !== peerContributionPublicationId(request)) {
      throw new Error('scope-access: contribution receipt does not match its sample')
    }
  }
}
