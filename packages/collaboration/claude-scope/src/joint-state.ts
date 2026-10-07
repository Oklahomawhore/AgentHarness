/** Durable passive receiving consent owned by one external-session contribution application. */

import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { peerContributionProposalSchema } from '@deepseek-ai/dsh-development-task/schema'
import { contributionEntrySchema, contributionInvitationSchema, contributionLimitsSchema,
  captureSubscriptionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeCaptureSubscription, ScopeContributionEntry, ScopeContributionInvitation, ScopeContributionLimits } from '@deepseek-ai/dsh-scope-access/types'
import type { ClaudeScopeJointId, ClaudeScopeJointSummary, ClaudeScopeContributionProposal } from './types.ts'

/** Original authorization plus independently retryable receiving and route work. */
export interface ScopeJoint {
  readonly id: ClaudeScopeJointId
  readonly proposal: ClaudeScopeContributionProposal
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly expectedReadRevision: number
  readonly authorizedReadRevision: number
  readonly cleanupPending: boolean
  readonly state: ClaudeScopeJointSummary['state']
  readonly intent: ClaudeScopeJointSummary['intent']
  /** Set only after the exact contribution grant is verified active or its terminal receipt is accepted. */
  readonly ready: boolean
  readonly subscription?: ScopeCaptureSubscription | undefined
  readonly contributionInvitation?: ScopeContributionInvitation | undefined
  readonly adoptedReadRevision?: number | undefined
  readonly routeRevision: number
  readonly routePending: boolean
  /** The last explicit route selection permits an exact retry after its management reply is lost. */
  readonly routeRequest?: {
    readonly expectedReadRevision: number
    readonly appliedReadRevision: number
    readonly ownerAddress: string
  } | undefined
}

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Strict new consent; a legacy record never acquires joint receiving by normalization. */
export const jointSchema: z.ZodType<ScopeJoint> = z.object({
  id: z.string().min(1).transform(value => value as ClaudeScopeJointId),
  proposal: peerContributionProposalSchema, entry: contributionEntrySchema, limits: contributionLimitsSchema,
  expectedReadRevision: revision, authorizedReadRevision: revision, cleanupPending: z.boolean(),
  state: z.enum(['waiting', 'adopting', 'active', 'ended', 'superseded', 'failed']),
  intent: z.enum(['adopt', 'cancel-pending', 'leave']), ready: z.boolean(),
  subscription: captureSubscriptionSchema.extend({ state: z.literal('active'), routeRevision: revision }).optional(), contributionInvitation: contributionInvitationSchema.optional(),
  adoptedReadRevision: revision.optional(), routeRevision: revision, routePending: z.boolean(),
  routeRequest: z.object({
    expectedReadRevision: revision, appliedReadRevision: revision, ownerAddress: z.string().min(1),
  }).strict().optional(),
}).strict().superRefine((joint, context) => {
  const subscription = joint.subscription
  const invitation = joint.contributionInvitation
  const grant = invitation?.grant
  const read = subscription?.invitation
  if (joint.authorizedReadRevision < joint.expectedReadRevision
    || (joint.entry.kind !== 'scope-join-entry' && joint.entry.kind !== 'scope-group-entry')
    || (subscription === undefined) !== (invitation === undefined)
    || (joint.ready && subscription === undefined)
    || (joint.state === 'active' && (subscription === undefined || joint.adoptedReadRevision === undefined))
    || (joint.cleanupPending && (joint.intent === 'adopt' || subscription === undefined))
    || (joint.adoptedReadRevision !== undefined && joint.adoptedReadRevision <= joint.expectedReadRevision)
    || (subscription !== undefined && (subscription.originalCapture.captureId !== joint.proposal.captureId
      || subscription.originalCapture.captureGeneration !== joint.proposal.captureGeneration
      || subscription.routeRevision !== joint.routeRevision))
    || (grant !== undefined && (grant.ownerPeerId !== joint.entry.ownerPeerId || grant.taskId !== joint.entry.taskId
      || grant.contributorPeerId !== joint.proposal.contributorPeerId || grant.captureId !== joint.proposal.captureId
      || grant.captureGeneration !== joint.proposal.captureGeneration || !isDeepStrictEqual(grant.source, joint.proposal.source)
      || grant.expiresAt > joint.limits.expiresAt || grant.maxSamples > joint.limits.maxSamples
      || grant.maxSampleBytes > joint.limits.maxSampleBytes))
    || (read !== undefined && (read.ownerPeerId !== joint.entry.ownerPeerId || read.taskId !== joint.entry.taskId
      || read.recipientPeerId !== joint.proposal.contributorPeerId || read.expiresAt !== grant?.expiresAt
      || read.ownerAddress !== joint.entry.ownerAddress || invitation?.ownerAddress !== joint.entry.ownerAddress))) {
    context.addIssue({ code: 'custom', message: 'joint consent, original capture, and selected permissions disagree' })
  }
})
