/** Durable local Claude grants, tool leases, and exact recipient projections. */

import { isDeepStrictEqual } from 'node:util'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  DevelopmentParticipantId, DevelopmentTaskBindingId, DevelopmentTaskId, DevelopmentNodeId,
  DevelopmentTaskObservedIntervalId, DevelopmentTaskObservedIntervalIdentity, DevelopmentTaskObservedReceipt,
  DevelopmentTaskAdmitRemoteObservedContextResult,
  DevelopmentTaskArtifactGrantId, DevelopmentTaskArtifactId, DevelopmentTaskObservedSourceId, DevelopmentTaskOpenApiObservationInput,
} from '@deepseek-ai/dsh-development-task'
import { developmentTaskObservedIntervalIdentitySchema, openApiObservationInputSchema } from '@deepseek-ai/dsh-development-task/schema'
import type {
  DevelopmentTaskBindingEpoch,
  DevelopmentTaskContextProjection,
} from '@deepseek-ai/dsh-development-task-context/types'
import type { ScopeSubscriptionId, ScopeGeneration, ScopeGrantId } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { z } from 'zod'
import type { ClaudeScopeOpenApiSource, ClaudeScopePolicy, ClaudeScopeSessionKey, ClaudeScopeReceiveStatus } from './types.ts'
import { jointSchema, type ScopeJoint } from './joint-state.ts'
import { contributionSchema, jointContributionSchema, contributionLeaseSchema, type ScopeContribution, type ScopeContributionLease } from './contribution-state.ts'

/** Local recipient interval and the exact independently granted scope. */
export interface ScopeReceive {
  readonly subscriptionId: ScopeSubscriptionId
  readonly generation: ScopeGeneration
  readonly taskId: DevelopmentTaskId
  readonly ownerPeerId: ScopePeerId
  readonly grantId: ScopeGrantId
  readonly grantGeneration: ScopeGeneration
  readonly expiresAt: number
  readonly status: ClaudeScopeReceiveStatus
}

/** One explicitly authorized interval; clearing it revokes future adapter admission. */
export interface ScopeGrant {
  readonly taskId: DevelopmentTaskId
  readonly epoch: DevelopmentTaskBindingEpoch
  readonly policy: ClaudeScopePolicy
  readonly responsibility: string
  readonly openApiSources: readonly ClaudeScopeOpenApiSource[]
  readonly remote?: {
    readonly ownerNodeId: DevelopmentNodeId
    readonly intervalId?: DevelopmentTaskObservedIntervalId | undefined
  } | undefined
}

/** Exact completion retained before an owner admission, including its durable receipt when known. */
export interface ScopeCompletionSample {
  readonly sourceId: DevelopmentTaskObservedSourceId
  readonly text: string
  readonly receipt?: DevelopmentTaskAdmitRemoteObservedContextResult['receipt'] | undefined
}

/** Original sampled bytes are represented by their digest and extracted declarations before Task admission. */
export interface ScopeArtifactSample extends ScopeCompletionSample {
  readonly observation: DevelopmentTaskOpenApiObservationInput
}

/** One live read grant; sequence allocation and pending withdrawal survive a process restart. */
export interface ScopeArtifactChain {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly taskId: DevelopmentTaskId
  readonly epoch: DevelopmentTaskBindingEpoch
  readonly policyRevision: string
  readonly source: ClaudeScopeOpenApiSource
  readonly artifactId: DevelopmentTaskArtifactId
  readonly grantId: DevelopmentTaskArtifactGrantId
  readonly sequence: number
  readonly revocation?: ScopeArtifactSample | undefined
}

/** Local-only observed identity and its current authorization, if any. */
export type ScopeSession = {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly sessionId: string
  readonly participantId: DevelopmentParticipantId
  readonly bindingId: DevelopmentTaskBindingId
  readonly cwd?: string | undefined
  readonly observedAt: number
  readonly ended: boolean
  readonly receive?: ScopeReceive | undefined
  readonly contribution?: ScopeContribution | undefined
  readonly grant?: ScopeGrant | undefined
  readonly lastProjectionId?: string | undefined
  readonly pendingEnd?: {
    readonly identity: DevelopmentTaskObservedIntervalIdentity
    readonly ownerNodeId: DevelopmentNodeId
    readonly receipt?: DevelopmentTaskObservedReceipt | undefined
  } | undefined
  readonly sharingIssue?: 'owner-unavailable' | 'capacity' | 'rejected' | undefined
} & ({
  readonly version?: undefined
  readonly readRevision?: undefined
  readonly joint?: undefined
} | {
  readonly version: 2
  readonly readRevision: number
  readonly joint?: ScopeJoint | undefined
})

/** PreToolUse attribution retained until its authorization interval ends. */
export interface ScopeToolLease {
  readonly sessionKey: ClaudeScopeSessionKey
  readonly toolUseId: string
  readonly toolName: string
  readonly taskId: DevelopmentTaskId
  readonly epoch: DevelopmentTaskBindingEpoch
  readonly policyRevision: string
  readonly inputDigest: string
  readonly artifactTrigger?: { readonly filePath: string; readonly argumentDigest: string } | undefined
  readonly terminal?: { readonly event: 'PostToolUse' | 'PostToolUseFailure'; readonly textDigest: string } | undefined
  readonly artifactSamples?: readonly ScopeArtifactSample[] | undefined
  readonly artifactsAdmitted?: boolean | undefined
  readonly completion?: ScopeCompletionSample | undefined
  readonly completionAdmitted?: boolean | undefined
}

/** Exact external-host text; persistence and RPC return do not establish model admission. */
export interface ScopeProjection extends Omit<DevelopmentTaskContextProjection, 'activation'> {
  readonly projectionId: string
  readonly sessionKey: ClaudeScopeSessionKey
  readonly kind: 'snapshot' | 'withdrawal' | 'received' | 'suspended'
  readonly receive?: ScopeReceive | undefined
  readonly cacheKey: string
  readonly maxContextBytes: number
  readonly previousProjectionId?: string | undefined
  readonly taskId?: DevelopmentTaskId | undefined
  readonly epoch?: DevelopmentTaskBindingEpoch | undefined
  readonly taskRevision?: number | undefined
  readonly backend?: { readonly id: string; readonly revision: string } | undefined
}

const sessionKey = z.string().min(1).transform(value => value as ClaudeScopeSessionKey)
const taskId = z.string().min(1).transform(value => value as DevelopmentTaskId)
const epoch = z.object({
  nodeId: z.string().min(1).transform(value => value as DevelopmentTaskBindingEpoch['nodeId']),
  seq: z.number().int().positive(),
}).strict()
const policy = z.object({
  roots: z.array(z.string().min(1)),
  bashCommands: z.array(z.string()),
  revision: z.string().min(1),
}).strict()
const openApiSource = z.object({
  name: z.string().min(1), filePath: z.string().min(1), method: z.enum(['post', 'put', 'patch']), path: z.string().startsWith('/'),
}).strict()
const nodeId = z.string().min(1).transform(value => value as DevelopmentNodeId)
const intervalId = z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskObservedIntervalId)
const receipt = z.object({
  taskId, ownerNodeId: nodeId, intervalId, revision: z.number().int().positive(), event: epoch,
}).strict()
const admissionReceipt = receipt.extend({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskObservedSourceId),
  publicationId: z.string().min(1),
})
const completionSample: z.ZodType<ScopeCompletionSample> = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskObservedSourceId),
  text: z.string().min(1), receipt: admissionReceipt.optional(),
}).strict()
const artifactSample: z.ZodType<ScopeArtifactSample> = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as DevelopmentTaskObservedSourceId),
  text: z.string().min(1), observation: openApiObservationInputSchema, receipt: admissionReceipt.optional(),
}).strict()
const artifactChain: z.ZodType<ScopeArtifactChain> = z.object({
  sessionKey, taskId, epoch, policyRevision: z.string().min(1), source: openApiSource,
  artifactId: z.string().min(1).transform(value => value as DevelopmentTaskArtifactId),
  grantId: z.string().min(1).transform(value => value as DevelopmentTaskArtifactGrantId),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revocation: artifactSample.optional(),
}).strict()
const receiveSchema: z.ZodType<ScopeReceive> = z.object({
  subscriptionId: z.string().min(1).transform(value => value as ScopeSubscriptionId),
  generation: z.string().min(1).transform(value => value as ScopeGeneration),
  taskId,
  ownerPeerId: z.string().min(1).transform(value => value as ScopePeerId),
  grantId: z.string().min(1).transform(value => value as ScopeGrantId),
  grantGeneration: z.string().min(1).transform(value => value as ScopeGeneration),
  expiresAt: z.number().int().positive(),
  status: z.enum(['pending', 'active', 'revoked', 'expired', 'unavailable', 'left']),
}).strict()
const legacySessionSchema = z.object({
  sessionKey,
  sessionId: z.string().min(1),
  participantId: z.string().min(1).transform(value => value as DevelopmentParticipantId),
  bindingId: z.string().min(1).transform(value => value as DevelopmentTaskBindingId),
  cwd: z.string().optional(),
  observedAt: z.number().nonnegative(),
  ended: z.boolean(),
  receive: receiveSchema.optional(),
  contribution: contributionSchema.optional(),
  grant: z.object({
    taskId, epoch, policy, responsibility: z.string().min(1),
    // Existing grants authorized tool fields only; normalization cannot add file-read permission.
    openApiSources: z.array(openApiSource).default([]),
    remote: z.object({ ownerNodeId: nodeId, intervalId: intervalId.optional() }).strict().optional(),
  }).strict().optional(),
  lastProjectionId: z.string().optional(),
  pendingEnd: z.object({
    identity: developmentTaskObservedIntervalIdentitySchema, ownerNodeId: nodeId, receipt: receipt.optional(),
  }).strict().optional(),
  sharingIssue: z.enum(['owner-unavailable', 'capacity', 'rejected']).optional(),
}).strict()
const sessionSchema: z.ZodType<ScopeSession> = z.union([legacySessionSchema, legacySessionSchema.extend({
  version: z.literal(2), readRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  joint: jointSchema.optional(), contribution: jointContributionSchema.optional(),
}).strict().superRefine((session, context) => {
  const joint = session.joint
  const capture = session.contribution
  if ((capture?.application?.entry.kind === 'scope-group-entry' && joint === undefined)
    || (joint !== undefined && (joint.authorizedReadRevision > session.readRevision
      || (joint.adoptedReadRevision !== undefined && joint.adoptedReadRevision > session.readRevision)
      || (capture?.proposal.captureId === joint.proposal.captureId
        && (capture.proposal.captureGeneration !== joint.proposal.captureGeneration
          || !isDeepStrictEqual(capture.proposal, joint.proposal)))
      || (capture?.application !== undefined && capture.application.entry.kind === 'scope-group-entry'
        && (capture.proposal.captureId !== joint.proposal.captureId
          || !isDeepStrictEqual(capture.application.entry, joint.entry)))
      || (session.receive?.subscriptionId === joint.subscription?.id
        && session.receive !== undefined && joint.subscription !== undefined
        && (session.receive.generation !== joint.subscription.generation
          || session.receive.taskId !== joint.subscription.invitation.taskId
          || session.receive.ownerPeerId !== joint.subscription.invitation.ownerPeerId
          || session.receive.grantId !== joint.subscription.invitation.grantId
          || session.receive.grantGeneration !== joint.subscription.invitation.generation
          || session.receive.expiresAt !== joint.subscription.invitation.expiresAt))))) {
    context.addIssue({ code: 'custom', message: 'joint operation does not belong to its retained Session selection' })
  }
})])
const leaseSchema: z.ZodType<ScopeToolLease> = z.object({
  sessionKey,
  toolUseId: z.string().min(1),
  toolName: z.string().min(1),
  taskId,
  epoch,
  policyRevision: z.string().min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactTrigger: z.object({ filePath: z.string().min(1), argumentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  terminal: z.object({
    event: z.enum(['PostToolUse', 'PostToolUseFailure']), textDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  artifactSamples: z.array(artifactSample).optional(),
  artifactsAdmitted: z.boolean().optional(),
  completion: completionSample.optional(),
  completionAdmitted: z.boolean().optional(),
}).strict()
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId, revision: z.number().int().positive() }).strict(),
  z.object({
    kind: z.literal('publication'), taskId, revision: z.number().int().positive(), publicationId: z.string().min(1),
  }).strict(),
])
const projectionSchema: z.ZodType<ScopeProjection> = z.object({
  projectionId: z.string().min(1),
  sessionKey,
  kind: z.enum(['snapshot', 'withdrawal', 'received', 'suspended']),
  receive: receiveSchema.optional(),
  cacheKey: z.string().min(1),
  maxContextBytes: z.number().int().positive().max(10_000),
  previousProjectionId: z.string().optional(),
  taskId: taskId.optional(),
  epoch: epoch.optional(),
  taskRevision: z.number().int().positive().optional(),
  backend: z.object({ id: z.string().min(1), revision: z.string().min(1) }).strict().optional(),
  text: z.string(),
  selectedSources: z.array(source),
  omittedSources: z.array(z.object({ source, reason: z.enum(['self-published', 'budget', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant']) }).strict()),
}).strict().superRefine((record, context) => {
  if (record.kind === 'snapshot'
    && (record.taskId === undefined || record.epoch === undefined || record.taskRevision === undefined || record.backend === undefined)) {
    context.addIssue({ code: 'custom', message: 'snapshot projection requires its Task, epoch, revision, and backend' })
  }
  if ((record.kind === 'received' || record.kind === 'suspended') && record.receive === undefined) {
    context.addIssue({ code: 'custom', message: 'independent projection requires its receiving interval' })
  }
  if (record.kind === 'received' && (record.receive?.status !== 'active' || record.taskId !== record.receive.taskId
    || record.taskRevision === undefined || record.backend === undefined)) {
    context.addIssue({ code: 'custom', message: 'received projection requires its active Task revision and backend' })
  }
  if (Buffer.byteLength(record.text, 'utf8') > record.maxContextBytes) {
    context.addIssue({ code: 'custom', message: 'projection text exceeds its recorded budget' })
  }
})

/** Authoritative local records, validated strictly on restart rather than discarded as cache. */
export const claudeScopeDomainSpec = defineDomain({
  name: 'claude_scope',
  version: 1,
  global: {
    schema: z.object({ installationId: z.string().nullable() }).strict(),
    initial: { installationId: null },
  },
  tables: {
    sessions: domainTable<ClaudeScopeSessionKey, ScopeSession>(sessionSchema),
    leases: domainTable<string, ScopeToolLease>(leaseSchema),
    projections: domainTable<string, ScopeProjection>(projectionSchema),
    artifacts: domainTable<DevelopmentTaskArtifactGrantId, ScopeArtifactChain>(artifactChain),
    contribution_leases: domainTable<string, ScopeContributionLease>(contributionLeaseSchema),
  },
})

/** Open local adapter records shared by serialized capture and revocation operations. */
export type ScopeDomain = import('@deepseek-ai/dsh-storage-domain').Domain<typeof claudeScopeDomainSpec>
