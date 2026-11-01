/** Explicit Claude-work prompt authorization and original contribution outbox rows. */
import { z } from 'zod'
import { claudeWorkPeerContributionSampleSchema, peerContributionAdmissionReceiptSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerContributionResult } from '@deepseek-ai/dsh-development-task/types'
import type { ClaudeScopeContributionProposal, ClaudeScopeSessionKey } from './types.ts'

interface WorkIdentity {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly captureId: ClaudeScopeContributionProposal['captureId']
  readonly captureGeneration: ClaudeScopeContributionProposal['captureGeneration']
}
interface WorkOutbox {
  readonly sample?: Omit<DevelopmentTaskPeerContributionRequest, 'grant'> | undefined
  readonly receipt?: DevelopmentTaskPeerContributionResult['receipt'] | undefined
}

/** Prompt authorization is current-only; tool and Stop rows preserve exact report retry identity. */
export type ScopeWorkLease = WorkIdentity & ({
  readonly kind: 'prompt'
  readonly promptId: string
} | ({
  readonly kind: 'tool'
  readonly toolUseId: string
  readonly toolName: 'Write' | 'Edit' | 'Bash'
  readonly argumentDigest: string
  readonly authorizedInputDigest: string
  readonly terminal?: 'PostToolUse' | 'PostToolUseFailure' | undefined
  readonly completionDigest?: string | undefined
} & WorkOutbox) | ({
  readonly kind: 'stop-report'
  readonly promptId: string
  readonly textDigest: string
  readonly stopHookActive: boolean
  readonly sample: Omit<DevelopmentTaskPeerContributionRequest, 'grant'>
} & WorkOutbox))

const opaque = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = {
  sessionKey: z.string().min(1).transform(value => value as ClaudeScopeSessionKey),
  captureId: opaque.transform(value => value as ClaudeScopeContributionProposal['captureId']),
  captureGeneration: opaque.transform(value => value as ClaudeScopeContributionProposal['captureGeneration']),
}
const outbox = { sample: claudeWorkPeerContributionSampleSchema.optional(), receipt: peerContributionAdmissionReceiptSchema.optional() }

/** New rows never reinterpret a native tool identifier as a prompt or Stop identifier. */
export const workLeaseSchema: z.ZodType<ScopeWorkLease> = z.discriminatedUnion('kind', [
  z.strictObject({ ...identity, kind: z.literal('prompt'), promptId: opaque }),
  z.strictObject({ ...identity, ...outbox, kind: z.literal('tool'), toolUseId: opaque, toolName: z.enum(['Write', 'Edit', 'Bash']),
    argumentDigest: digest, authorizedInputDigest: digest, terminal: z.enum(['PostToolUse', 'PostToolUseFailure']).optional(),
    completionDigest: digest.optional() }),
  z.strictObject({ ...identity, ...outbox, kind: z.literal('stop-report'), promptId: opaque, textDigest: digest,
    stopHookActive: z.boolean(), sample: claudeWorkPeerContributionSampleSchema }),
])
