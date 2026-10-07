/** Owner-local source records retain exact Task permission without a peer invitation or network identity. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  localContributionGrantSchema, localContributionSampleSchema, localContributionRequestSchema,
  localContributionAdmissionReceiptSchema, localContributionId, localContributionPayloadDigest, localContributionPublicationId,
} from '@deepseek-ai/dsh-development-task/schema'
import type {
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionRequest,
  DevelopmentTaskLocalContributionReceipt, DevelopmentTaskLocalContributionAdmissionReceipt,
} from '@deepseek-ai/dsh-development-task/types'
import { nativeDigest, type NativeSample } from './state.ts'

/** Source-side intent; Task events remain the only local contribution authority. */
export interface LocalCapture {
  readonly grant: DevelopmentTaskLocalContributionGrant
  readonly roots: readonly string[]
  readonly rootUrls: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly state: 'opening' | 'active' | 'ending'
  readonly sequence: number
  readonly issue?: 'owner-unavailable' | 'capacity' | 'rejected' | undefined
}

/** The shared collector's durable execution coordinates with a local Task sample and receipt. */
export interface LocalSample extends Omit<NativeSample, 'sample' | 'receipt'> {
  readonly sample: Omit<DevelopmentTaskLocalContributionRequest, 'grant'>
  readonly receipt?: DevelopmentTaskLocalContributionAdmissionReceipt | undefined
}

/** One source Session's atomic local sequence allocation and immutable outbox. */
export interface LocalSourceRecord {
  readonly agentId: SessionId
  readonly revision: number
  readonly capture: LocalCapture | null
  readonly samples: readonly LocalSample[]
}

/**
 * Check restored local receipts against their complete authority and original retained sample.
 * @param grant - immutable source permission.
 * @param receipt - original owner event.
 * @param sample - exact sample for admission receipts; absent for opening or termination.
 */
export function validateLocalReceipt(grant: DevelopmentTaskLocalContributionGrant,
  receipt: DevelopmentTaskLocalContributionReceipt, sample?: LocalSample['sample']): void {
  if (receipt.taskId !== grant.taskId || receipt.intervalId !== localContributionId(grant)
    || receipt.ownerNodeId !== grant.expectedBindingEpoch.nodeId || receipt.event.nodeId !== receipt.ownerNodeId
    || receipt.participantId !== grant.participantId || receipt.bindingId !== grant.bindingId
    || !isDeepStrictEqual(receipt.expectedBindingEpoch, grant.expectedBindingEpoch)
    || receipt.captureId !== grant.captureId || receipt.captureGeneration !== grant.captureGeneration) {
    throw new Error('native local contribution receipt belongs to another permission')
  }
  if (sample !== undefined) {
    const admitted = localContributionAdmissionReceiptSchema.parse(receipt)
    const request = { grant, ...sample }
    if (admitted.event.kind !== 'context-published' || admitted.sourceId !== sample.sourceId || admitted.sequence !== sample.sequence
      || admitted.payloadDigest !== localContributionPayloadDigest(request)
      || admitted.publicationId !== localContributionPublicationId(request)) {
      throw new Error('native local contribution receipt belongs to another sample')
    }
  }
}

const captureSchema: z.ZodType<LocalCapture> = z.object({
  grant: localContributionGrantSchema, roots: z.array(z.string().min(1)).min(1),
  rootUrls: z.array(z.string().startsWith('file:')).min(1), tools: z.array(z.enum(['write', 'edit'])).min(1).max(2),
  state: z.enum(['opening', 'active', 'ending']), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  issue: z.enum(['owner-unavailable', 'capacity', 'rejected']).optional(),
}).strict().superRefine((capture, ctx) => {
  if (capture.roots.length !== capture.rootUrls.length || new Set(capture.rootUrls).size !== capture.rootUrls.length
    || new Set(capture.tools).size !== capture.tools.length || capture.grant.source.name !== 'session-work'
    || !isDeepStrictEqual(capture.grant.source.tools, capture.tools.map(tool => tool === 'write' ? 'Write' : 'Edit'))
    || capture.sequence > capture.grant.maxSamples) {
    ctx.addIssue({ code: 'custom', message: 'native local contribution differs from the retained permission' })
  }
})
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const sampleSchema: z.ZodType<LocalSample> = z.object({
  id: digest,
  callSeq: z.number().int().positive().transform(value => value as NativeSample['callSeq']),
  resultSeq: z.number().int().positive().transform(value => value as NativeSample['resultSeq']),
  callId: z.string().min(1), rootCallId: z.string().min(1), argumentDigest: digest, completionDigest: digest,
  captureId: z.string().min(1).transform(value => value as LocalCapture['grant']['captureId']),
  captureGeneration: z.string().min(1).transform(value => value as LocalCapture['grant']['captureGeneration']),
  sample: localContributionSampleSchema,
  receipt: localContributionAdmissionReceiptSchema.optional(),
}).strict()
const recordSchema: z.ZodType<LocalSourceRecord> = z.object({
  agentId: z.string().min(1).transform(value => value as SessionId),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  capture: captureSchema.nullable(), samples: z.array(sampleSchema),
}).strict().superRefine((record, ctx) => {
  const capture = record.capture
  const seen = new Set<number>()
  try {
    if (capture === null && record.samples.length !== 0) throw new Error('local samples have no capture')
    for (const item of record.samples) {
      if (capture === null) throw new Error('local sample has no capture')
      const id = nativeDigest(['native-local-tool', record.agentId, capture.grant.captureId, capture.grant.captureGeneration,
        item.callSeq, item.resultSeq])
      if (item.id !== id || item.captureId !== capture.grant.captureId || item.captureGeneration !== capture.grant.captureGeneration
        || item.callSeq >= item.resultSeq || item.sample.sourceId !== nativeDigest([id, item.sample.sequence])
        || item.sample.sequence > capture.sequence || seen.has(item.sample.sequence)
        || !capture.grant.source.tools.includes(item.sample.result.tool)) throw new Error('local sample has different execution coordinates')
      localContributionRequestSchema.parse({ grant: capture.grant, ...item.sample })
      seen.add(item.sample.sequence)
      if (item.receipt !== undefined) validateLocalReceipt(capture.grant, item.receipt, item.sample)
    }
  } catch (error) { ctx.addIssue({ code: 'custom', message: String(error) }) }
})

/** Separate additive authority preserves the existing remote domain and its version-one rows unchanged. */
export const nativeLocalContributionDomain = defineDomain({
  name: 'scope_agent_local_contributions', version: 1,
  tables: { sessions: domainTable<SessionId, LocalSourceRecord>(recordSchema) },
})

/** Durable local source inventory, independent of the remote source domain's layout. */
export type NativeLocalContributionDomain = Domain<typeof nativeLocalContributionDomain>
