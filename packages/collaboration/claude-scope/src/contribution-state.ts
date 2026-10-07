/** Independent local collection permission and exact owner-bound outbox records. */

import type {
  DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerContributionReceipt, DevelopmentTaskPeerContributionResult,
} from '@deepseek-ai/dsh-development-task/types'
import { peerContributionReceiptSchema, peerContributionAdmissionReceiptSchema, peerContributionSampleSchema, peerContributionProposalSchema } from '@deepseek-ai/dsh-development-task/schema'
import { contributionInvitationSchema, contributionEntrySchema, contributionLimitsSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeContributionInvitation } from '@deepseek-ai/dsh-scope-access/types'
import { z } from 'zod'
import { isAbsolute, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { contributionSourceSchema, contributionProposalSource, contributionEntryMatches } from './contribution-source.ts'
import type { ClaudeScopeContributionProposal, ClaudeScopeContributionSource, ClaudeScopePolicy, ClaudeScopeSessionKey, ClaudeScopeContributionApplication } from './types.ts'

/** One immutable local collection selection; ending retains its invitation until the owner confirms withdrawal. */
export interface ScopeContribution {
  readonly proposal: ClaudeScopeContributionProposal
  readonly policy: ClaudeScopePolicy
  readonly source: ClaudeScopeContributionSource
  readonly state: 'prepared' | 'active' | 'ending'
  readonly sequence: number
  readonly application?: ClaudeScopeContributionApplication | undefined
  readonly invitation?: ScopeContributionInvitation | undefined
  readonly endReceipt?: DevelopmentTaskPeerContributionReceipt | undefined
  readonly issue?: 'owner-unavailable' | 'capacity' | 'rejected' | undefined
}

/** One original Write/Edit lease; pending samples retain exact reports without absolute source paths. */
export interface ScopeContributionLease {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly captureId: ClaudeScopeContributionProposal['captureId']
  readonly captureGeneration: ClaudeScopeContributionProposal['captureGeneration']
  readonly toolUseId: string
  readonly toolName: 'Write' | 'Edit'
  readonly argumentDigest: string
  readonly authorizedInputDigest?: string | undefined
  readonly completionDigest?: string | undefined
  readonly terminal?: 'PostToolUse' | 'PostToolUseFailure' | undefined
  readonly sample?: Omit<DevelopmentTaskPeerContributionRequest, 'grant'> | undefined
  readonly receipt?: DevelopmentTaskPeerContributionResult['receipt'] | undefined
}

const opaque = z.string().min(1).max(256)
const proposal = peerContributionProposalSchema

/** Strict additive record; missing records in older adapter data grant no contribution permission. */
const contributionRecord = z.object({
  proposal,
  policy: z.object({ roots: z.array(z.string().min(1)), bashCommands: z.array(z.never()), revision: z.string().min(1) }).strict(),
  source: contributionSourceSchema,
  state: z.enum(['prepared', 'active', 'ending']),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  application: z.object({ entry: contributionEntrySchema, limits: contributionLimitsSchema,
    state: z.enum(['applying', 'waiting', 'cancelling', 'rejected', 'expired']) }).strict().optional(),
  invitation: contributionInvitationSchema.optional(),
  endReceipt: peerContributionReceiptSchema.optional(),
  issue: z.enum(['owner-unavailable', 'capacity', 'rejected']).optional(),
}).strict().superRefine((value, context) => {
  const source = value.source
  const allowed = 'kind' in source ? value.policy.roots.length > 0 && value.policy.roots.every(isAbsolute)
    : isAbsolute(source.filePath) && value.policy.roots.some((root) => {
      const suffix = relative(root, source.filePath)
      return isAbsolute(root) && suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
    })
  if ((value.application !== undefined && (value.state === 'active'
    || (value.state === 'ending') !== (value.application.state === 'cancelling')))
    || (value.state === 'active' && value.invitation === undefined)
    || (value.endReceipt !== undefined && (value.state !== 'ending' || value.invitation === undefined))
    || (value.application !== undefined && !contributionEntryMatches(value.application.entry, source))
    || !isDeepStrictEqual(contributionProposalSource(source), value.proposal.source) || !allowed) {
    context.addIssue({ code: 'custom', message: 'contribution permit and immutable source selection disagree' })
  }
})

/** Historical rows retain their original single-entry parser. */
export const contributionSchema: z.ZodType<ScopeContribution> = contributionRecord.superRefine((value, context) => {
  if (value.application?.entry.kind === 'scope-group-entry') {
    context.addIssue({ code: 'custom', message: 'legacy contribution does not support reusable joint entries' })
  }
})

/** Group entries require the containing version-2 Session's separately validated consent. */
export const jointContributionSchema: z.ZodType<ScopeContribution> = contributionRecord

/** Complete original sample is parsed without manufacturing a Task binding or node identity. */
export const contributionLeaseSchema: z.ZodType<ScopeContributionLease> = z.object({
  sessionKey: z.string().min(1).transform(value => value as ClaudeScopeSessionKey),
  captureId: opaque.transform(value => value as ClaudeScopeContributionProposal['captureId']),
  captureGeneration: opaque.transform(value => value as ClaudeScopeContributionProposal['captureGeneration']),
  toolUseId: z.string().min(1), toolName: z.enum(['Write', 'Edit']), argumentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorizedInputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  completionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  terminal: z.enum(['PostToolUse', 'PostToolUseFailure']).optional(),
  sample: peerContributionSampleSchema.optional(), receipt: peerContributionAdmissionReceiptSchema.optional(),
}).strict()
