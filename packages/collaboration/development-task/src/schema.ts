/** Hostile-input schemas shared by Task storage and Mesh adapters. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionRequest, DevelopmentTaskLocalContributionReceipt,
  DevelopmentTaskLocalContributionAdmissionReceipt, DevelopmentTaskLocalContributionResult, DevelopmentTaskLocalContribution,
  DevelopmentTaskEndLocalContributionRequest, DevelopmentTaskCommandObservationResult,
  DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerContributionReceipt,
  DevelopmentTaskPeerContributionResult, DevelopmentTaskPeerContribution, DevelopmentTaskEndPeerContributionRequest,
  DevelopmentTaskPeerContributionAdmissionReceipt, DevelopmentTaskToolObservationResult,
  DevelopmentTaskRecordedToolObservationResult, DevelopmentTaskPeerToolObservationResult,
  DevelopmentTaskCompletedFileToolObservationResult, DevelopmentTaskLocalToolObservationResult,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskContextBlock,
  DevelopmentTaskLogEntry,
  DevelopmentTaskOpenApiObservation,
  DevelopmentTaskOpenApiObservationInput,
  DevelopmentTaskObservedIntervalIdentity,
  DevelopmentTaskAdmitRemoteObservedContextRequest,
  DevelopmentTaskAdmitRemoteObservedContextResult,
  DevelopmentTaskObservedInterval,
  DevelopmentTaskObservedReceipt,
} from './types.ts'

const participant = z.string()
const observationCommon = {
  kind: z.literal('openapi-artifact'), version: z.literal(1), artifactId: z.string().min(1), sourceName: z.string().min(1),
  grantId: z.string().min(1), sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  operation: z.strictObject({ method: z.enum(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']), path: z.string().startsWith('/') }),
}
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const observationVariants = [
  z.strictObject({ ...observationCommon, state: z.literal('valid'), sha256: digest, facts: z.strictObject({
    operationId: z.string().optional(), requestBodyRequired: z.boolean(), requiredRequestFields: z.array(z.string()),
    responseStatuses: z.array(z.string()), deprecated: z.boolean(),
  }) }),
  z.strictObject({ ...observationCommon, state: z.literal('invalid'), sha256: digest,
    reason: z.enum(['invalid-json', 'unsupported-document', 'unsupported-operation', 'operation-missing']) }),
  z.strictObject({ ...observationCommon, state: z.literal('unavailable'),
    reason: z.enum(['missing-file', 'not-readable', 'changed-during-read', 'too-large']) }),
  z.strictObject({ ...observationCommon, state: z.literal('revoked'), reason: z.literal('grant-ended') }),
] as const

/** Reader evidence accepted from a durable pending-admission record, including revocation. */
export const openApiObservationInputSchema = z.discriminatedUnion('state', observationVariants) as unknown as
  z.ZodType<DevelopmentTaskOpenApiObservationInput>

const admission = {
  observerNodeId: z.string().min(1), sourceId: digest,
  binding: z.strictObject({ id: z.string().min(1), epoch: z.strictObject({
    nodeId: z.string().min(1), seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }) }),
}

/** Strict artifact evidence accepted at queued admission, durable restore, and Mesh ingress. */
export const developmentTaskOpenApiObservationSchema = z.discriminatedUnion('state', [
  observationVariants[0].extend(admission), observationVariants[1].extend(admission),
  observationVariants[2].extend(admission), observationVariants[3].extend(admission),
]) as unknown as z.ZodType<DevelopmentTaskOpenApiObservation>

const legacyPublication = z.strictObject({
  id: z.string(), text: z.string(), uri: z.string().optional(), publishedBy: participant, publishedAt: z.number().int().nonnegative(),
  observation: developmentTaskOpenApiObservationSchema.optional(),
  observedIntervalId: digest.optional(),
  observedIntervalEnded: z.literal(true).optional(),
})
const opaque = z.string().min(1).max(256).refine(value => value.trim().length > 0)
const natural = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const toolSource = z.strictObject({ kind: z.literal('tool-observations'), name: opaque,
  tools: z.array(z.enum(['Write', 'Edit'])).min(1).max(2).refine(values => new Set(values).size === values.length) })
const recordedToolSource = toolSource.extend({ version: z.literal(2), initialization: z.literal('recorded-local-tools') })
const completedFileToolSource = toolSource.extend({ version: z.literal(3), fileContent: z.literal('completed-native-file') })
/** Exact command text and the sender's explicitly selected working-directory root. */
export const commandSelectorSchema = z.strictObject({
  command: z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0')),
  rootIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const commandToolSource = z.strictObject({ kind: z.literal('tool-observations'), name: opaque,
  tools: z.array(z.enum(['Write', 'Edit'])).max(2).refine(values => new Set(values).size === values.length), version: z.literal(4),
  commands: z.array(commandSelectorSchema).min(1).refine(values =>
    new Set(values.map(value => JSON.stringify([value.command, value.rootIndex]))).size === values.length),
  fileContent: z.literal('completed-native-file').optional(),
}).refine(value => value.fileContent === undefined || value.tools.length > 0)

const peerGrant = z.strictObject({
  version: z.literal(1), taskId: opaque, grantId: opaque, generation: opaque, ownerPeerId: opaque, contributorPeerId: opaque,
  captureId: opaque, captureGeneration: opaque,
  source: z.union([
    z.strictObject({ name: opaque, method: z.enum(['post', 'put', 'patch']), path: z.string().startsWith('/').max(2048) }),
    toolSource, recordedToolSource, completedFileToolSource, commandToolSource,
  ]),
  expiresAt: natural, maxSamples: natural, maxSampleBytes: natural,
})
const toolFields = {
  rootIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  path: z.string().min(1).max(2048).refine(value => !/[\\:\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')),
  error: z.string().optional(),
}
const toolCommon = { kind: z.literal('tool-observation'), version: z.literal(1), reportedStatus: z.enum(['success', 'failure']),
  omissions: z.array(z.enum(['content', 'oldString', 'newString', 'error'])).max(4),
}
const toolObjects = [
  z.strictObject({ ...toolCommon, tool: z.literal('Write'), fields: z.strictObject({ ...toolFields, content: z.string().optional() }) }),
  z.strictObject({ ...toolCommon, tool: z.literal('Edit'), fields: z.strictObject({ ...toolFields,
    oldString: z.string().optional(), newString: z.string().optional(), replaceAll: z.boolean() }) }),
] as const
const toolResult = z.discriminatedUnion('tool', toolObjects)
function toolResultValid(value: Pick<z.infer<typeof toolResult>, 'tool' | 'fields' | 'omissions' | 'reportedStatus'>): boolean {
  const body = value.tool === 'Write' ? ['content'] : ['oldString', 'newString']
  const present = new Set(Object.keys(value.fields))
  return new Set(value.omissions).size === value.omissions.length
    && body.every(field => present.has(field) !== value.omissions.some(item => item === field))
    && value.omissions.every(field => (body.includes(field) || field === 'error') && !present.has(field))
    && (value.reportedStatus === 'success'
      ? !present.has('error') && !value.omissions.includes('error')
      : body.every(field => !present.has(field)))
}
/** Strict Write/Edit report, with relative paths and explicit omitted input text. */
export const toolObservationResultSchema = toolResult.refine(toolResultValid) as unknown as z.ZodType<DevelopmentTaskToolObservationResult>
const recordedOrigin = z.strictObject({ kind: z.literal('recorded-local-tools'), planDigest: digest, executionDigest: digest })
const recordedToolObjects = [
  toolObjects[0].extend({ version: z.literal(2), origin: recordedOrigin }),
  toolObjects[1].extend({ version: z.literal(2), origin: recordedOrigin }),
] as const
const recordedToolResult = z.discriminatedUnion('tool', recordedToolObjects).refine(toolResultValid)
/** Prior recorded report accepted only with explicit historical-sharing authorization. */
export const recordedToolObservationResultSchema = recordedToolResult as unknown as z.ZodType<DevelopmentTaskRecordedToolObservationResult>
const completedFile = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('included'), content: z.string().refine(value => !value.includes('\r') && value.isWellFormed()), sha256: digest })
    .refine(value => createHash('sha256').update(value.content).digest('hex') === value.sha256),
  z.strictObject({ state: z.literal('omitted'), reason: z.enum(['tool-failed', 'budget', 'unavailable']) }),
])
const completedFileToolObjects = [
  toolObjects[0].extend({ version: z.literal(3), completedFile }),
  toolObjects[1].extend({ version: z.literal(3), completedFile }),
] as const
function completedFileToolValid(value: z.infer<typeof completedFileToolObjects[number]>): boolean {
  return toolResultValid(value) && (value.reportedStatus === 'failure'
    ? value.completedFile.state === 'omitted' && value.completedFile.reason === 'tool-failed'
    : value.completedFile.state === 'included' || value.completedFile.reason !== 'tool-failed')
}
/** Strict native completion text, digest, and explicit omission under version-three permission. */
export const completedFileToolObservationResultSchema = z.discriminatedUnion('tool', completedFileToolObjects)
  .refine(completedFileToolValid) as unknown as z.ZodType<DevelopmentTaskCompletedFileToolObservationResult>
const commandOutput = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('included'), text: z.string(), truncated: z.boolean() }),
  z.strictObject({ state: z.literal('omitted'), reason: z.literal('budget'), truncated: z.boolean() }),
])
const commandCommon = { kind: z.literal('command-observation'), version: z.literal(4), tool: z.literal('Bash'),
  fields: commandSelectorSchema }
const commandObjects = [
  z.strictObject({ ...commandCommon, state: z.literal('completed'),
    exitCode: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    signal: z.string().min(1).nullable(), timedOut: z.boolean(), aborted: z.boolean(), timeoutMs: natural,
    stdout: commandOutput, stderr: commandOutput }),
  z.strictObject({ ...commandCommon, state: z.literal('unavailable'), reason: z.enum(['tool-failed', 'completion-unavailable']) }),
] as const
/** Explicit foreground outcome or unavailable evidence, without inferred exit status or output truncation. */
export const commandObservationResultSchema = z.discriminatedUnion('state', commandObjects) as
  z.ZodType<DevelopmentTaskCommandObservationResult>
/** Local observations distinguish ordinary parameters from explicitly permitted completed-file text. */
export const localToolObservationResultSchema = z.union([
  toolObservationResultSchema, completedFileToolObservationResultSchema, commandObservationResultSchema,
]) as z.ZodType<DevelopmentTaskLocalToolObservationResult>
/** Peer variants preserve their original live, historical, or native completed-file representation. */
export const peerToolObservationResultSchema = z.union([
  toolObservationResultSchema, recordedToolObservationResultSchema,
  completedFileToolObservationResultSchema, commandObservationResultSchema,
]) as z.ZodType<DevelopmentTaskPeerToolObservationResult>

function toolPermissionMatches(
  source: z.infer<typeof toolSource | typeof recordedToolSource | typeof completedFileToolSource | typeof commandToolSource>,
  result: {
    readonly kind: 'tool-observation'
    readonly tool: 'Write' | 'Edit'
    readonly version: number
    readonly fields: { readonly rootIndex: number }
  } | {
    readonly kind: 'command-observation'
    readonly tool: 'Bash'
    readonly version: 4
    readonly fields: { readonly rootIndex: number; readonly command: string }
  },
): boolean {
  const version = 'version' in source ? source.version : 1
  if (result.kind === 'command-observation') {
    return 'version' in source && source.version === 4 && source.commands.some(selector => selector.command === result.fields.command
      && selector.rootIndex === result.fields.rootIndex)
  }
  if (!source.tools.includes(result.tool)) return false
  if ('version' in source && source.version === 4) return result.version === (source.fileContent === undefined ? 1 : 3)
  return version === 3 ? result.version === 3 : result.version === 1 || (version === 2 && result.version === 2)
}


const openApiPeerResult = z.discriminatedUnion('state', [
  observationVariants[0].pick({ state: true, sha256: true, facts: true }),
  observationVariants[1].pick({ state: true, sha256: true, reason: true }),
  observationVariants[2].pick({ state: true, reason: true }),
])
const peerRequest = z.strictObject({ grant: peerGrant, sourceId: digest,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  result: z.union([openApiPeerResult, peerToolObservationResultSchema]),
})
const peerAdmission = { observerPeerId: opaque, sourceId: digest,
  capture: z.strictObject({ id: opaque, generation: opaque }),
}
const peerObservation = z.discriminatedUnion('state', [
  observationVariants[0].extend(peerAdmission), observationVariants[1].extend(peerAdmission),
  observationVariants[2].extend(peerAdmission), observationVariants[3].extend(peerAdmission),
])
const peerToolAdmission = { sourceName: opaque, grantId: opaque, sequence: natural, ...peerAdmission }
const peerToolObservation = z.union([
  z.discriminatedUnion('state', [commandObjects[0].extend(peerToolAdmission), commandObjects[1].extend(peerToolAdmission)]),
  z.discriminatedUnion('tool', [toolObjects[0].extend(peerToolAdmission), toolObjects[1].extend(peerToolAdmission)]).refine(toolResultValid),
  z.discriminatedUnion('tool', [recordedToolObjects[0].extend(peerToolAdmission), recordedToolObjects[1].extend(peerToolAdmission)]).refine(toolResultValid),
  z.discriminatedUnion('tool', [completedFileToolObjects[0].extend(peerToolAdmission), completedFileToolObjects[1].extend(peerToolAdmission)])
    .refine(completedFileToolValid),
])
const peerEndReason = z.enum(['left', 'revoked', 'expired'])
const peerPublication = z.strictObject({
  id: z.string(), text: z.string(), uri: z.string().optional(), publishedAt: z.number().int().nonnegative(),
  peerContribution: z.strictObject({ version: z.literal(1), grant: peerGrant, ended: peerEndReason.optional() }),
  peerObservation: peerObservation.optional(), peerToolObservation: peerToolObservation.optional(),
}).refine(value => (value.peerObservation === undefined || value.peerToolObservation === undefined)
  && (value.peerToolObservation === undefined || ('kind' in value.peerContribution.grant.source
    && toolPermissionMatches(value.peerContribution.grant.source, value.peerToolObservation))))
const localGrant = z.strictObject({
  version: z.literal(1), taskId: opaque, participantId: opaque, bindingId: opaque,
  expectedBindingEpoch: z.strictObject({ nodeId: opaque, seq: natural }), captureId: opaque, captureGeneration: opaque,
  source: z.union([toolSource, completedFileToolSource, commandToolSource]),
  expiresAt: natural, maxSamples: natural, maxSampleBytes: natural,
})
const localSample = z.strictObject({ sourceId: digest, sequence: natural, result: localToolObservationResultSchema })
const localRequest = localSample.extend({ grant: localGrant }).refine(value => toolPermissionMatches(value.grant.source, value.result))
const localTool = z.union([
  z.discriminatedUnion('state', [commandObjects[0].extend({ sourceId: digest, sequence: natural }),
    commandObjects[1].extend({ sourceId: digest, sequence: natural })]),
  z.discriminatedUnion('tool', [toolObjects[0].extend({ sourceId: digest, sequence: natural }),
    toolObjects[1].extend({ sourceId: digest, sequence: natural })]).refine(toolResultValid),
  z.discriminatedUnion('tool', [completedFileToolObjects[0].extend({ sourceId: digest, sequence: natural }),
    completedFileToolObjects[1].extend({ sourceId: digest, sequence: natural })]).refine(completedFileToolValid),
])
const localPublication = z.strictObject({
  id: z.string(), text: z.string(), uri: z.string().optional(), publishedBy: participant, publishedAt: z.number().int().nonnegative(),
  localContribution: z.strictObject({ version: z.literal(1), grant: localGrant, ended: peerEndReason.optional() }),
  localToolObservation: localTool.optional(),
}).refine(value => value.localToolObservation === undefined
  || toolPermissionMatches(value.localContribution.grant.source, value.localToolObservation))
const localReceipt = z.strictObject({ taskId: opaque, ownerNodeId: opaque, intervalId: digest, participantId: opaque,
  bindingId: opaque, expectedBindingEpoch: z.strictObject({ nodeId: opaque, seq: natural }), captureId: opaque,
  captureGeneration: opaque, revision: natural, event: z.strictObject({ nodeId: opaque, seq: natural,
    kind: z.enum(['local-contribution-opened', 'context-published', 'local-contribution-ended']) }),
})
const localSampleReceipt = localReceipt.extend({ event: localReceipt.shape.event.extend({ kind: z.literal('context-published') }),
  sourceId: digest, sequence: natural, payloadDigest: digest, publicationId: opaque })
/** Explicit local source permission parsed at queued admission and durable restore. */
export const localContributionGrantSchema = localGrant as unknown as z.ZodType<DevelopmentTaskLocalContributionGrant>
/** Original durable local outbox fields; its capture retains the grant separately. */
export const localContributionSampleSchema = localSample as unknown as z.ZodType<Omit<DevelopmentTaskLocalContributionRequest, 'grant'>>
/** Exact structured local report restricted to tools in its original permission. */
export const localContributionRequestSchema = localRequest as unknown as z.ZodType<DevelopmentTaskLocalContributionRequest>
/** Original local open, sample, or end event identity. */
export const localContributionReceiptSchema = localReceipt as unknown as z.ZodType<DevelopmentTaskLocalContributionReceipt>
/** Original local sample receipt, including full payload correlation. */
export const localContributionAdmissionReceiptSchema = localSampleReceipt as unknown as
  z.ZodType<DevelopmentTaskLocalContributionAdmissionReceipt>
/** Bounded local admission response without unrelated Task history. */
export const localContributionResultSchema = z.strictObject({ outcome: z.enum(['published', 'reused']), publication: localPublication,
  receipt: localSampleReceipt }) as unknown as z.ZodType<DevelopmentTaskLocalContributionResult>
/** Authoritative local capture state, including permanently ended intervals. */
export const localContributionStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ grant: localGrant, state: z.literal('active'),
    openReceipt: localReceipt.extend({ event: localReceipt.shape.event.extend({ kind: z.literal('local-contribution-opened') }) }) }),
  z.strictObject({ grant: localGrant, state: z.literal('ended'), reason: peerEndReason,
    openReceipt: localReceipt.extend({ event: localReceipt.shape.event.extend({ kind: z.literal('local-contribution-opened') }) }).optional(),
    endReceipt: localReceipt.extend({ event: localReceipt.shape.event.extend({ kind: z.literal('local-contribution-ended') }) }) }),
]) as unknown as z.ZodType<DevelopmentTaskLocalContribution>
/** Local stop or owner revocation, retaining the exact original permission. */
export const endLocalContributionRequestSchema = z.strictObject({ grant: localGrant, reason: z.enum(['left', 'revoked']) }) as unknown as
  z.ZodType<DevelopmentTaskEndLocalContributionRequest>
export { localContributionId, localContributionPayloadDigest, localContributionPublicationId } from './local.ts'
const publication = z.union([legacyPublication, peerPublication, localPublication])
const peerReceipt = z.strictObject({
  taskId: opaque, ownerPeerId: opaque, contributorPeerId: opaque, grantId: opaque, generation: opaque,
  captureId: opaque, captureGeneration: opaque, revision: natural, event: z.strictObject({ nodeId: opaque, seq: natural, kind: z.enum(['peer-contribution-opened', 'context-published', 'peer-contribution-ended']) }),
})
const peerSampleReceipt = peerReceipt.extend({ event: peerReceipt.shape.event.extend({ kind: z.literal('context-published') }), sourceId: digest, sequence: natural, payloadDigest: digest, publicationId: opaque })

/** Owner-issued independent contribution authorization persisted in Task events. */
export const peerContributionGrantSchema = peerGrant as unknown as z.ZodType<DevelopmentTaskPeerContributionGrant>
/** Transferable capture selection without local paths, owner authority, or sample data. */
export const peerContributionProposalSchema = peerGrant.pick({
  contributorPeerId: true, captureId: true, captureGeneration: true, source: true,
}) as unknown as z.ZodType<Pick<DevelopmentTaskPeerContributionGrant,
  'contributorPeerId' | 'captureId' | 'captureGeneration' | 'source'>>
/** Exact durable sample and wire request; callers cannot choose owner attribution or text. */
export const peerContributionRequestSchema = peerRequest.refine(value => 'kind' in value.grant.source
  ? 'kind' in value.result && toolPermissionMatches(value.grant.source, value.result)
  : !('kind' in value.result)) as unknown as z.ZodType<DevelopmentTaskPeerContributionRequest>
/** Exact sampler outbox fields, with its grant retained by the owning capture binding. */
export const peerContributionSampleSchema = peerRequest.omit({ grant: true }) as unknown as z.ZodType<Omit<DevelopmentTaskPeerContributionRequest, 'grant'>>
/** Version-1 transport samples exclude recorded-work origins. */
export const legacyPeerContributionSampleSchema = peerRequest.omit({ grant: true }).extend({
  result: z.union([openApiPeerResult, toolObservationResultSchema]),
}) as unknown as z.ZodType<Omit<DevelopmentTaskPeerContributionRequest, 'grant'>>
/** Version-2 transport samples carry exactly one recorded-work observation. */
export const recordedPeerContributionSampleSchema = peerRequest.omit({ grant: true }).extend({
  result: recordedToolObservationResultSchema,
}) as unknown as z.ZodType<Omit<DevelopmentTaskPeerContributionRequest, 'grant'>>

/** Version-3 transport samples carry exactly one explicitly authorized native completed-file observation. */
export const completedFilePeerContributionSampleSchema = peerRequest.omit({ grant: true }).extend({
  result: completedFileToolObservationResultSchema,
}) as unknown as z.ZodType<Omit<DevelopmentTaskPeerContributionRequest, 'grant'>>

/** Version-4 transport samples include command outcomes and the same grant's permitted live file reports. */
export const commandPeerContributionSampleSchema = peerRequest.omit({ grant: true }).extend({
  result: z.union([toolObservationResultSchema, completedFileToolObservationResultSchema, commandObservationResultSchema]),
}) as unknown as z.ZodType<Omit<DevelopmentTaskPeerContributionRequest, 'grant'>>

/** Original open or terminal owner commit. */
export const peerContributionReceiptSchema = peerReceipt as unknown as z.ZodType<DevelopmentTaskPeerContributionReceipt>
/** Original sample commit checked against the sender's durable outbox. */
export const peerContributionAdmissionReceiptSchema = peerSampleReceipt as unknown as
  z.ZodType<DevelopmentTaskPeerContributionAdmissionReceipt>
/** Exact admission output without unrelated Task history. */
export const peerContributionResultSchema = z.strictObject({ outcome: z.enum(['published', 'reused']), publication: peerPublication,
  receipt: peerSampleReceipt }) as unknown as z.ZodType<DevelopmentTaskPeerContributionResult>
/** Owner-side authority, including irreversible terminal tombstones. */
export const peerContributionStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ grant: peerGrant, state: z.literal('active'), openReceipt: peerReceipt.extend({ event: peerReceipt.shape.event.extend({ kind: z.literal('peer-contribution-opened') }) }) }),
  z.strictObject({ grant: peerGrant, state: z.literal('ended'), reason: peerEndReason,
    openReceipt: peerReceipt.extend({ event: peerReceipt.shape.event.extend({ kind: z.literal('peer-contribution-opened') }) }).optional(),
    endReceipt: peerReceipt.extend({ event: peerReceipt.shape.event.extend({ kind: z.literal('peer-contribution-ended') }) }) }),
]) as unknown as z.ZodType<DevelopmentTaskPeerContribution>
/** Explicit source withdrawal or owner revocation. */
export const endPeerContributionRequestSchema = z.strictObject({ grant: peerGrant, reason: z.enum(['left', 'revoked']) }) as unknown as
  z.ZodType<DevelopmentTaskEndPeerContributionRequest>

export { peerContributionPayloadDigest, peerContributionPublicationId, peerContributionArtifactId } from './peer.ts'

const bindingEpoch = z.strictObject({ nodeId: z.string().min(1), seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
const intervalIdentity = z.strictObject({
  taskId: z.string().min(1), sourceNodeId: z.string().min(1), participantId: z.string().min(1),
  bindingId: z.string().min(1), expectedBindingEpoch: bindingEpoch,
})

/** Exact owner-approved identity accepted from durable events and Mesh commands. */
export const developmentTaskObservedIntervalIdentitySchema = intervalIdentity as unknown as
  z.ZodType<DevelopmentTaskObservedIntervalIdentity>

/** Remote observations carry an interval reference but cannot supply their trusted source node. */
export const developmentTaskAdmitRemoteObservedContextRequestSchema = z.strictObject({
  taskId: z.string().min(1), participantId: z.string().min(1), bindingId: z.string().min(1),
  expectedBindingEpoch: bindingEpoch, sourceId: digest, text: z.string(), intervalId: digest,
  observation: openApiObservationInputSchema.optional(),
}) as unknown as z.ZodType<DevelopmentTaskAdmitRemoteObservedContextRequest>
const parent = z.strictObject({ taskId: z.string(), revision: z.number().int().min(1) })
const origin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('fork'), parent }),
  z.strictObject({ kind: z.literal('merge'), parents: z.array(parent).min(2) }),
])
const receipt = z.strictObject({
  taskId: z.string().min(1), ownerNodeId: z.string().min(1), intervalId: digest,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), event: bindingEpoch,
})

/** Original durable owner event returned by interval termination over Mesh. */
export const developmentTaskObservedReceiptSchema = receipt as unknown as z.ZodType<DevelopmentTaskObservedReceipt>

/** Owner-authoritative interval state returned over Mesh, including unapproved terminal identities. */
export const developmentTaskObservedIntervalSchema = z.discriminatedUnion('state', [
  intervalIdentity.extend({ id: digest, state: z.literal('active'), approvalReceipt: receipt }),
  intervalIdentity.extend({ id: digest, state: z.literal('ended'), approvalReceipt: receipt.optional(), endReceipt: receipt }),
]) as unknown as z.ZodType<DevelopmentTaskObservedInterval>

/** Remote admission result validated before an adapter can acknowledge its durable outbox. */
export const developmentTaskAdmitRemoteObservedContextResultSchema = z.strictObject({
  outcome: z.enum(['published', 'reused']), publication,
  receipt: receipt.extend({ sourceId: digest, publicationId: z.string().min(1) }),
}) as unknown as z.ZodType<DevelopmentTaskAdmitRemoteObservedContextResult>

const change = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task-created'), origin, objective: z.string(), scope: z.string(),
    createdBy: participant, inheritedContextBlockId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('context-published'), publication }),
  z.strictObject({ kind: z.literal('observed-interval-opened'), interval: intervalIdentity }),
  z.strictObject({ kind: z.literal('observed-interval-ended'), interval: intervalIdentity }),
  z.strictObject({ kind: z.literal('local-contribution-opened'), grant: localGrant }),
  z.strictObject({ kind: z.literal('local-contribution-ended'), grant: localGrant, reason: peerEndReason }),
  z.strictObject({ kind: z.literal('peer-contribution-opened'), grant: peerGrant }),
  z.strictObject({ kind: z.literal('peer-contribution-ended'), grant: peerGrant, reason: peerEndReason }),
])

/** Exact Task event accepted from SQLite or an authenticated Mesh peer. */
export const developmentTaskEventSchema = z.strictObject({
  nodeId: z.string(), seq: z.number().int().min(1), at: z.number().int().nonnegative(), taskId: z.string(),
  revision: z.number().int().min(1), hiddenRoomId: z.string(), change,
}) as unknown as z.ZodType<DevelopmentTaskLogEntry>

const inheritedSource = z.strictObject({
  parent, objective: z.string(), scope: z.string(), context: z.array(publication),
})

/** Exact content-addressed Task block accepted from SQLite or Mesh. */
export const developmentTaskContextBlockSchema = z.strictObject({
  id: z.string(), createdAt: z.number().int().nonnegative(), sources: z.array(inheritedSource).min(1),
}) as unknown as z.ZodType<DevelopmentTaskContextBlock>

const assignmentChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task-bound'), taskId: z.string(), sessionLabel: z.string().optional() }),
  z.strictObject({ kind: z.literal('task-cleared'), previousTaskId: z.string() }),
  z.strictObject({ kind: z.literal('context-acknowledged'), taskId: z.string(), revision: z.number().int().min(1) }),
])

/** Exact Agent session-binding event accepted from SQLite or Mesh. */
export const developmentTaskAssignmentEventSchema = z.strictObject({
  nodeId: z.string(), seq: z.number().int().min(1), at: z.number().int().nonnegative(), bindingId: z.string(),
  participantId: z.string(), change: assignmentChange,
}) as unknown as z.ZodType<DevelopmentTaskAssignmentLogEntry>
