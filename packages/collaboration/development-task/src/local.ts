/** Canonical owner-local capture identities, reports, and terminal notices. */
import { createHash } from 'node:crypto'
import type {
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionId, DevelopmentTaskLocalContributionRequest,
  DevelopmentTaskContextPublication, DevelopmentTaskContributionEndReason, DevelopmentTaskLocalToolObservation,
} from './types.ts'

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/**
 * Identify one local capture independently of peer grants and object property order.
 * @param grant - immutable local permission including its original assignment epoch.
 * @returns original capture interval identity; changed limits do not create a new capture generation.
 */
export function localContributionId(grant: DevelopmentTaskLocalContributionGrant): DevelopmentTaskLocalContributionId {
  return digest(['local-capture:1', grant.taskId, grant.participantId, grant.bindingId,
    grant.expectedBindingEpoch.nodeId, grant.expectedBindingEpoch.seq, grant.captureId, grant.captureGeneration,
  ]) as DevelopmentTaskLocalContributionId
}

/**
 * Copy local permission without retaining mutable tool or binding metadata.
 * @param grant - validated local permission.
 * @returns detached immutable permission.
 */
export function freezeLocalGrant(grant: DevelopmentTaskLocalContributionGrant): DevelopmentTaskLocalContributionGrant {
  return Object.freeze({ version: grant.version, taskId: grant.taskId, participantId: grant.participantId, bindingId: grant.bindingId,
    expectedBindingEpoch: Object.freeze({ nodeId: grant.expectedBindingEpoch.nodeId, seq: grant.expectedBindingEpoch.seq }),
    captureId: grant.captureId, captureGeneration: grant.captureGeneration,
    source: Object.freeze({ kind: grant.source.kind, name: grant.source.name, tools: Object.freeze([...grant.source.tools]),
      ...(grant.source.version === 3 ? { version: 3 as const, fileContent: grant.source.fileContent } : {}) }),
    expiresAt: grant.expiresAt, maxSamples: grant.maxSamples, maxSampleBytes: grant.maxSampleBytes })
}

/**
 * Correlate a local receipt with the complete effective sample and authorization.
 * @param request - exact original source outbox sample.
 * @returns canonical payload digest independent of object property order.
 */
export function localContributionPayloadDigest(request: DevelopmentTaskLocalContributionRequest): string {
  const { grant, result } = request
  return digest([localContributionId(grant), grant.version, grant.source.kind, grant.source.name, grant.source.tools,
    grant.expiresAt, grant.maxSamples, grant.maxSampleBytes, request.sourceId, request.sequence,
    result.kind, result.version, result.tool, result.reportedStatus, result.fields.rootIndex, result.fields.path,
    ...result.tool === 'Write' ? [result.fields.content ?? null] : [result.fields.oldString ?? null, result.fields.newString ?? null, result.fields.replaceAll],
    result.fields.error ?? null, result.omissions,
    ...result.version === 3 ? [grant.source.version, grant.source.fileContent, result.completedFile.state,
      ...result.completedFile.state === 'included' ? [result.completedFile.content, result.completedFile.sha256] : [result.completedFile.reason]] : []])
}

/**
 * Identify one exact local observation inside its capture interval.
 * @param request - retained local sample.
 * @returns stable publication identity across retries.
 */
export function localContributionPublicationId(request: DevelopmentTaskLocalContributionRequest): string {
  return `context-local-observation-${digest([localContributionId(request.grant), request.sourceId])}`
}

/**
 * Normalize local report fields for content-addressed context blocks and detached replay.
 * @param tool - validated structured local observation.
 * @returns deeply frozen report with canonical property order.
 */
export function freezeLocalToolObservation(tool: DevelopmentTaskLocalToolObservation): DevelopmentTaskLocalToolObservation {
  const common = { kind: tool.kind,
    ...(tool.version === 3 ? { version: 3 as const, completedFile: Object.freeze({ ...tool.completedFile }) } : { version: 1 as const }),
    reportedStatus: tool.reportedStatus, omissions: Object.freeze([...tool.omissions]) }
  const location = { rootIndex: tool.fields.rootIndex, path: tool.fields.path }
  const error = tool.fields.error === undefined ? {} : { error: tool.fields.error }
  const source = { sourceId: tool.sourceId, sequence: tool.sequence }
  return tool.tool === 'Write'
    ? Object.freeze({ ...common, tool: 'Write', fields: Object.freeze({ ...location,
      ...(tool.fields.content === undefined ? {} : { content: tool.fields.content }), ...error }), ...source })
    : Object.freeze({ ...common, tool: 'Edit', fields: Object.freeze({ ...location,
      ...(tool.fields.oldString === undefined ? {} : { oldString: tool.fields.oldString }),
      ...(tool.fields.newString === undefined ? {} : { newString: tool.fields.newString }),
      replaceAll: tool.fields.replaceAll, ...error }), ...source })
}

/**
 * Render local tool evidence using Task-owned attribution.
 * @param request - validated local sample; no caller-written attribution is accepted.
 * @param at - original owner event time.
 * @returns a canonical publication preserving the reported event rather than asserting current file contents.
 */
export function localPublication(request: DevelopmentTaskLocalContributionRequest, at: number): DevelopmentTaskContextPublication {
  const observation = freezeLocalToolObservation({ ...request.result, sourceId: request.sourceId, sequence: request.sequence })
  return { id: localContributionPublicationId(request), publishedAt: at, publishedBy: request.grant.participantId,
    localContribution: { version: 1, grant: request.grant }, localToolObservation: observation,
    text: `Local Agent tool observation. This is a reported event, not a current file snapshot.\n${JSON.stringify(observation)}` }
}

/**
 * Recover the exact submitted local report from its owner publication.
 * @param publication - local sample publication, excluding terminal notices.
 * @returns its original grant and sample fields.
 */
export function localPublicationRequest(publication: DevelopmentTaskContextPublication): DevelopmentTaskLocalContributionRequest {
  const grant = publication.localContribution?.grant
  const tool = publication.localToolObservation
  if (grant === undefined || tool === undefined) throw new Error('local sample publication is required')
  return { grant, sourceId: tool.sourceId, sequence: tool.sequence, result: {
    kind: tool.kind, ...(tool.version === 3 ? { version: 3, completedFile: tool.completedFile } : { version: 1 }),
    reportedStatus: tool.reportedStatus, omissions: tool.omissions,
    ...tool.tool === 'Write' ? { tool: 'Write', fields: tool.fields } : { tool: 'Edit', fields: tool.fields },
  } }
}

/**
 * Produce a terminal notice without copying earlier report contents.
 * @param grant - original local permission.
 * @param reason - first committed terminal reason.
 * @param at - original terminal event time.
 * @returns the notice shared by current-context backends and replay.
 */
export function localWithdrawal(grant: DevelopmentTaskLocalContributionGrant, reason: DevelopmentTaskContributionEndReason,
  at: number): DevelopmentTaskContextPublication {
  const id = localContributionId(grant)
  return { id: `context-local-ended-${id}`, publishedAt: at, publishedBy: grant.participantId,
    localContribution: { version: 1, grant, ended: reason },
    text: `Local contribution ${id} ended (${reason}). Earlier reports from this capture do not establish current facts.` }
}
