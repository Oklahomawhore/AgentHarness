/** Durable native source permission and exact samples; Session logs remain the authority for tool execution. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import { contributionRecordSchema } from '@deepseek-ai/dsh-scope-access/contribution'
import type { ContributionRecord, ContributionOutboxItem } from '@deepseek-ai/dsh-scope-access/contribution'
import { contributionEntrySchema, contributionLimitsSchema, invitationSchema, validateContributionReceipt } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeContributionEntry, ScopeContributionLimits } from '@deepseek-ai/dsh-scope-access/types'
import { scopeAgentAutomaticPolicySchema } from '@deepseek-ai/dsh-scope-agent-context'
import type { ScopeAgentLocalTaskTarget } from '@deepseek-ai/dsh-scope-agent-context/types'
import { peerContributionSampleSchema, peerContributionAdmissionReceiptSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'

import type { ScopeAgentContributionReceiving } from './types.ts'
import { initializationSchema, executionDigest } from './initialization.ts'
import type { NativeInitialization } from './initialization.ts'

/** Original local receiving/execution consent and independently recoverable departure intent. */
export interface NativeReceiving extends ScopeAgentContributionReceiving {
  /** Version 2 associates new consent with its original capture; absent historical markers are never upgraded. */
  readonly version?: 2
  readonly expectedReadStateSeq: SessionSeqCursor
  readonly leaveAdopted: boolean
  readonly intent?: 'adopt' | 'cancel-pending' | 'leave' | undefined
  readonly routeRecovery?: { readonly ownerAddress: string; readonly expectedReadStateSeq: SessionSeqCursor } | undefined
}

/** Last committed route command; exact retry never changes its retained read consent. */
export interface NativeRouteCommand {
  readonly expectedRouteRevision: number
  readonly expectedOwnerAddress: string
  readonly ownerAddress: string
  readonly receive?: { readonly expectedReadStateSeq: SessionSeqCursor } | undefined
}

/** Durable address generation; absent fields belong to an unchanged historical route. */
export interface NativeRouteState {
  readonly routeRevision?: number | undefined
  readonly lastRoute?: NativeRouteCommand | undefined
}

/** Immutable local file selection and original consent retained after owner activation. */
export interface NativeCapture extends ContributionRecord, NativeRouteState {
  readonly roots: readonly string[]
  readonly rootUrls: readonly string[]
  readonly tools: readonly ('write' | 'edit')[]
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly receiving?: NativeReceiving | undefined
  readonly initialization?: NativeInitialization | undefined
}

/** Detached read work has no file permission; its original live Agent is checked separately. */
export interface NativeReceivingContinuation extends NativeRouteState {
  readonly proposal: NativeCapture['proposal']
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly receiving: NativeReceiving
}

/** One actual file-tool completion, linked to the source Session's persisted start and settlement. */
export interface NativeSample extends ContributionOutboxItem {
  readonly callSeq: SessionSeq
  readonly resultSeq: SessionSeq
  readonly callId: string
  readonly rootCallId: string
  readonly argumentDigest: string
  readonly completionDigest: string
  readonly captureId: NativeCapture['proposal']['captureId']
  readonly captureGeneration: NativeCapture['proposal']['captureGeneration']
  readonly sample: NonNullable<ContributionOutboxItem['sample']>
}

/** One atomic row owns sequence allocation, source samples, and management revisions. */
export interface NativeSourceRecord {
  readonly version?: 2
  readonly agentId: SessionId
  readonly revision: number
  readonly capture: NativeCapture | null
  readonly samples: readonly NativeSample[]
  readonly receivingContinuation?: NativeReceivingContinuation | undefined
}

export { nativeDigest } from './identity.ts'
import { nativeDigest } from './identity.ts'

const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeq)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const routeState = {
  routeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  lastRoute: z.object({
    expectedRouteRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedOwnerAddress: z.string().min(1).max(2048), ownerAddress: z.string().min(1).max(2048),
    receive: z.object({
      expectedReadStateSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor),
    }).strict().optional(),
  }).strict().optional(),
}
function consistentRoute(value: NativeRouteState & { readonly entry: ScopeContributionEntry }): boolean {
  if (value.lastRoute === undefined) return (value.routeRevision ?? 0) === 0
  return value.routeRevision === value.lastRoute.expectedRouteRevision + 1 && value.lastRoute.ownerAddress === value.entry.ownerAddress
}
const localTaskSchema = z.strictObject({
  taskId: z.string().min(1), taskBindingId: z.string().min(1),
  expectedBindingEpoch: z.strictObject({ nodeId: z.string().min(1), seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
}).transform(value => value as ScopeAgentLocalTaskTarget)
const receivingFields = {
  localTask: localTaskSchema.optional(),
  automatic: scopeAgentAutomaticPolicySchema.optional(),
  adoptionId: z.uuid().transform(value => value as NativeReceiving['adoptionId']),
  expectedReadStateSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor),
  state: z.enum(['waiting', 'adopting', 'active', 'ended', 'superseded', 'failed']),
  invitation: invitationSchema.nullable(), leaveAdopted: z.boolean(),
  intent: z.enum(['adopt', 'cancel-pending', 'leave']).optional(),
  routeRecovery: z.object({ ownerAddress: z.string().min(1).max(2048),
    expectedReadStateSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).transform(value => value as SessionSeqCursor),
  }).strict().optional(),
}
const receivingSchema = z.union([
  z.object(receivingFields).strict(),
  z.object({ ...receivingFields, version: z.literal(2) }).strict(),
]).refine(value => value.intent === undefined || value.leaveAdopted === (value.intent === 'leave'),
  { message: 'receiving departure intent disagrees' })
  .transform(({ automatic, localTask, ...receiving }) => ({ ...receiving,
    ...(automatic === undefined ? {} : { automatic }), ...(localTask === undefined ? {} : { localTask }),
  }))
const captureSchema = contributionRecordSchema.safeExtend({
  ...routeState,
  roots: z.array(z.string().min(1)).min(1), rootUrls: z.array(z.string().startsWith('file:')).min(1),
  tools: z.array(z.enum(['write', 'edit'])).min(1).max(2),
  entry: contributionEntrySchema, limits: contributionLimitsSchema,
  receiving: receivingSchema.optional(), initialization: initializationSchema.optional(),
}).superRefine((capture, ctx) => {
  const source = capture.proposal.source
  const tools = capture.tools.map(tool => tool === 'write' ? 'Write' : 'Edit')
  const grant = capture.invitation?.grant
  const receiving = capture.receiving
  const read = receiving?.invitation
  if (!consistentRoute(capture)
    || (capture.entry.kind === 'scope-join-entry' || capture.entry.kind === 'scope-group-entry') !== (receiving !== undefined)
    || (receiving !== undefined && ((receiving.state === 'adopting' || receiving.state === 'active') && read == null))
    || (read != null && (read.taskId !== capture.entry.taskId || read.ownerPeerId !== capture.entry.ownerPeerId
      || read.recipientPeerId !== capture.proposal.contributorPeerId || read.expiresAt > capture.limits.expiresAt
      || (grant !== undefined && read.expiresAt !== grant.expiresAt)))
    || (receiving?.routeRecovery !== undefined && receiving.routeRecovery.ownerAddress !== capture.entry.ownerAddress)
    || capture.roots.length !== capture.rootUrls.length || new Set(capture.rootUrls).size !== capture.rootUrls.length
    || new Set(capture.tools).size !== capture.tools.length || source.kind !== 'tool-observations'
    || JSON.stringify(source.tools) !== JSON.stringify(tools) || source.name !== 'session-work'
    || (source.version === 2) !== (capture.initialization !== undefined)
    || (grant !== undefined && (grant.ownerPeerId !== capture.entry.ownerPeerId || grant.taskId !== capture.entry.taskId
      || grant.expiresAt > capture.limits.expiresAt || grant.maxSamples > capture.limits.maxSamples
      || grant.maxSampleBytes > capture.limits.maxSampleBytes))) {
    ctx.addIssue({ code: 'custom', message: 'native contribution source differs from the retained local consent' })
  }
})
const sampleSchema: z.ZodType<NativeSample> = z.object({
  id: digest, callSeq: sequence, resultSeq: sequence,
  callId: z.string().min(1), rootCallId: z.string().min(1), argumentDigest: digest, completionDigest: digest,
  captureId: z.string().min(1).transform(value => value as NativeCapture['proposal']['captureId']),
  captureGeneration: z.string().min(1).transform(value => value as NativeCapture['proposal']['captureGeneration']),
  sample: peerContributionSampleSchema, receipt: peerContributionAdmissionReceiptSchema.optional(),
}).strict()
const continuationSchema = z.object({
  ...routeState,
  proposal: contributionRecordSchema.shape.proposal, entry: contributionEntrySchema, limits: contributionLimitsSchema,
  receiving: receivingSchema,
}).strict().refine(value => consistentRoute(value) && (value.entry.kind === 'scope-join-entry' || value.entry.kind === 'scope-group-entry')
  && value.proposal.source.kind === 'tool-observations'
  && value.receiving.intent !== undefined
  && (value.receiving.routeRecovery === undefined || value.receiving.routeRecovery.ownerAddress === value.entry.ownerAddress)
  && (value.receiving.invitation === null ? value.receiving.intent !== 'adopt'
    : value.receiving.invitation.ownerPeerId === value.entry.ownerPeerId
      && value.receiving.invitation.taskId === value.entry.taskId
      && value.receiving.invitation.recipientPeerId === value.proposal.contributorPeerId
      && value.receiving.invitation.expiresAt <= value.limits.expiresAt),
{ message: 'detached receiving differs from original consent' })
const recordFields = {
  agentId: z.string().min(1).transform(value => value as SessionId),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  capture: captureSchema.nullable(), samples: z.array(sampleSchema), receivingContinuation: continuationSchema.optional(),
}
const legacyRecord = z.strictObject(recordFields).refine(record => record.capture?.initialization === undefined
  && !(record.capture?.proposal.source.kind === 'tool-observations' && record.capture.proposal.source.version === 3)
  && !(record.receivingContinuation !== undefined && 'version' in record.receivingContinuation.proposal.source)
  && record.samples.every(item => !('kind' in item.sample.result) || item.sample.result.version === 1),
'historical native source rows cannot acquire initialization')
const recordSchema: z.ZodType<NativeSourceRecord> = z.union([legacyRecord,
  z.strictObject({ ...recordFields, version: z.literal(2) }),
]).superRefine((record, ctx) => {
  if (record.capture !== null && record.receivingContinuation !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'capture and detached receiving cannot coexist' })
  }
  const seen = new Set<number>()
  try {
    if (record.capture === null && record.samples.length !== 0) throw new Error('samples have no source permission')
    for (const sample of record.samples) {
      if (record.capture === null) throw new Error('sample has no capture')
      validateNativeSample(record.agentId, sample, record.capture)
      if (seen.has(sample.sample.sequence)) throw new Error('sample sequence is duplicated')
      seen.add(sample.sample.sequence)
    }
    const plan = record.capture?.initialization?.plan
    if (plan != null
      && record.samples.filter(item => 'kind' in item.sample.result && item.sample.result.version === 2).length !== plan.sources.length) {
      throw new Error('initialization plan lacks its complete original outbox')
    }
  } catch (error) { ctx.addIssue({ code: 'custom', message: String(error) }) }
})

/**
 * Check durable sample attribution and exact receipts before restoring or retransmitting.
 * @param agentId - source Session owning the row.
 * @param item - original retained observation.
 * @param capture - immutable local selection and owner grant.
 */
export function validateNativeSample(agentId: SessionId, item: NativeSample, capture: NativeCapture): void {
  const id = nativeDigest(['native-tool', agentId, capture.proposal.captureId, capture.proposal.captureGeneration, item.callSeq, item.resultSeq])
  if (item.id !== id || item.captureId !== capture.proposal.captureId || item.captureGeneration !== capture.proposal.captureGeneration
    || item.callSeq >= item.resultSeq || item.sample.sourceId !== nativeDigest([id, item.sample.sequence])
    || item.sample.sequence > capture.sequence || capture.invitation === undefined
    || !('kind' in item.sample.result) || !capture.tools.includes(item.sample.result.tool === 'Write' ? 'write' : 'edit')) {
    throw new Error('native contribution sample has different source coordinates')
  }
  peerContributionRequestSchema.parse({ grant: capture.invitation.grant, ...item.sample })
  const report = item.sample.result
  if ('kind' in report && report.version === 2) {
    const initialization = capture.initialization
    const index = initialization?.plan?.sources.findIndex(value => value.callSeq === item.callSeq
      && value.resultSeq === item.resultSeq) ?? -1
    const proof = initialization?.plan?.sources[index]
    if (initialization?.state !== 'frozen' || initialization.plan === null || proof === undefined
      || report.origin.planDigest !== initialization.plan.digest
      || report.origin.executionDigest !== executionDigest(initialization.request, proof)
      || proof.callId !== item.callId || proof.rootCallId !== item.rootCallId
      || proof.argumentDigest !== item.argumentDigest || proof.completionDigest !== item.completionDigest
      || item.sample.sequence !== index + 1) {
      throw new Error('recorded sample differs from its frozen initialization evidence')
    }
  }
  if (report.version === 1 && item.sample.sequence <= (capture.initialization?.plan?.sources.length ?? 0)) {
    throw new Error('live sample precedes its fixed initialization sequence')
  }
  if (item.receipt !== undefined) validateContributionReceipt(capture.invitation, item.receipt, item.sample)
}

/** Bounded source authority; restart never grants a new live instance collection permission. */
export const nativeContributionDomain = defineDomain({
  name: 'scope_agent_contributions', version: 1,
  global: { schema: z.object({ version: z.literal(1) }).strict(), initial: { version: 1 as const } },
  tables: { sessions: domainTable<SessionId, NativeSourceRecord>(recordSchema) },
})

/** The single native source durable authority. */
export type NativeContributionDomain = Domain<typeof nativeContributionDomain>
