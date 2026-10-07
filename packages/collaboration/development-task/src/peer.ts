/** Deterministic independent-peer evidence, receipt identity, and terminal publications. */

import { createHash } from 'node:crypto'
import type {
  DevelopmentTaskArtifactId, DevelopmentTaskContextPublication, DevelopmentTaskObservedSourceId,
  DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerOpenApiObservation,
  DevelopmentTaskContributionEndReason, DevelopmentTaskPeerToolObservation,
} from './types.ts'

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/**
 * Freeze authorization fields without retaining mutable source metadata.
 * @param grant - validated owner authorization.
 * @returns detached immutable authorization.
 */
export function freezePeerGrant(grant: DevelopmentTaskPeerContributionGrant): DevelopmentTaskPeerContributionGrant {
  return Object.freeze({ ...grant, source: Object.freeze({ ...grant.source,
    ...grant.source.kind === 'tool-observations' ? { tools: Object.freeze([...grant.source.tools]) } : {},
  }) })
}

/**
 * Derive the shared logical artifact without disclosing the sender's local path.
 * @param grant - owner-approved Task and source selector.
 * @returns Task-scoped artifact digest shared with local sampled sources.
 * @throws If the grant permits tool events rather than an OpenAPI artifact.
 */
export function peerContributionArtifactId(grant: DevelopmentTaskPeerContributionGrant): DevelopmentTaskArtifactId {
  if (grant.source.kind === 'tool-observations') throw new Error('tool observations do not identify a replaceable artifact')
  return digest([grant.taskId, grant.source.name, grant.source.method, grant.source.path]) as DevelopmentTaskArtifactId
}

/**
 * Identify one source within an immutable owner grant.
 * @param request - exact pending sample.
 * @returns publication identity independent of retries and arrival order.
 */
export function peerContributionPublicationId(request: DevelopmentTaskPeerContributionRequest): string {
  return `context-peer-observation-${digest([request.grant.taskId, request.grant.grantId, request.grant.generation, request.sourceId])}`
}

/**
 * Bind a receipt to every authorization and sample field, independent of object property order.
 * @param request - exact pending sample, preserving field-array order.
 * @returns lowercase SHA-256 digest of the complete effective payload.
 */
export function peerContributionPayloadDigest(request: DevelopmentTaskPeerContributionRequest): string {
  const { grant, result } = request
  const values = 'kind' in result
    ? [result.kind, result.version, result.tool, result.reportedStatus, result.fields.rootIndex, result.fields.path,
      ...result.tool === 'Write' ? [result.fields.content ?? null] : [result.fields.oldString ?? null, result.fields.newString ?? null, result.fields.replaceAll],
      result.fields.error ?? null, result.omissions,
      ...result.version === 2 ? [result.origin.kind, result.origin.planDigest, result.origin.executionDigest] : [],
      ...result.version === 3 ? [result.completedFile.state, ...result.completedFile.state === 'included'
        ? [result.completedFile.content, result.completedFile.sha256] : [result.completedFile.reason]] : []]
    : result.state === 'valid'
      ? [result.state, result.sha256, result.facts.operationId ?? null, result.facts.requestBodyRequired,
        result.facts.requiredRequestFields, result.facts.responseStatuses, result.facts.deprecated]
      : result.state === 'invalid' ? [result.state, result.sha256, result.reason] : [result.state, result.reason]
  return digest([grant.version, grant.taskId, grant.grantId, grant.generation, grant.ownerPeerId, grant.contributorPeerId,
    grant.captureId, grant.captureGeneration,
    ...grant.source.kind === 'tool-observations' ? [grant.source.kind, grant.source.name, grant.source.tools,
      ...grant.source.version === 2 ? [grant.source.version, grant.source.initialization] : [],
      ...grant.source.version === 3 ? [grant.source.version, grant.source.fileContent] : []]
      : [grant.source.name, grant.source.method, grant.source.path],
    grant.expiresAt, grant.maxSamples, grant.maxSampleBytes, request.sourceId, request.sequence, values])
}

/**
 * Build owner-attributed source evidence without accepting caller-written context.
 * @param request - validated pending sample.
 * @param at - owner commit timestamp.
 * @returns canonical publication; the peer report is not independent owner verification.
 */
export function peerPublication(request: DevelopmentTaskPeerContributionRequest, at: number): DevelopmentTaskContextPublication {
  const { grant } = request
  if ('kind' in request.result) {
    if (grant.source.kind !== 'tool-observations' || (grant.source.version === 3 ? request.result.version !== 3
      : request.result.version === 3 || (request.result.version === 2 && grant.source.version !== 2))) {
      throw new Error('tool report requires its matching live or recorded observation authorization')
    }
    const observation: DevelopmentTaskPeerToolObservation = {
      ...request.result, sourceName: grant.source.name, grantId: grant.grantId, sequence: request.sequence,
      observerPeerId: grant.contributorPeerId, sourceId: request.sourceId,
      capture: { id: grant.captureId, generation: grant.captureGeneration },
    }
    return { id: peerContributionPublicationId(request), publishedAt: at, peerContribution: { version: 1, grant },
      peerToolObservation: observation,
      text: `${request.result.version === 2 ? 'Previously recorded tool attempt shared with this scope. It was not re-executed or checked against the current file. Only selected completed records are shared; omitted or unfinished work is not included. ' : ''}Authenticated peer tool observation. This is a reported event, not a current file snapshot. The Task owner has not independently verified the tool execution or file contents.\n${JSON.stringify(observation)}`,
    }
  }
  if (grant.source.kind === 'tool-observations') throw new Error('artifact report requires OpenAPI authorization')
  const observation: DevelopmentTaskPeerOpenApiObservation = {
    kind: 'openapi-artifact', version: 1, artifactId: peerContributionArtifactId(grant), sourceName: grant.source.name,
    grantId: grant.grantId, sequence: request.sequence, operation: { method: grant.source.method, path: grant.source.path },
    ...request.result, observerPeerId: grant.contributorPeerId, sourceId: request.sourceId,
    capture: { id: grant.captureId, generation: grant.captureGeneration },
  }
  return {
    id: peerContributionPublicationId(request),
    text: `Authenticated peer report of sampled OpenAPI declarations. The Task owner has not independently verified the sender's tool execution or file contents.\n${JSON.stringify(observation)}`,
    publishedAt: at, peerContribution: { version: 1, grant }, peerObservation: observation,
  }
}

/**
 * Reconstruct the original pending sample for receipt verification and durable replay.
 * @param publication - a peer sample publication, excluding generated withdrawals.
 * @returns exact authorization and sample fields.
 */
export function peerPublicationRequest(publication: DevelopmentTaskContextPublication): DevelopmentTaskPeerContributionRequest {
  const observation = publication.peerObservation
  const grant = publication.peerContribution?.grant
  const tool = publication.peerToolObservation
  if (grant !== undefined && tool !== undefined) {
    return { grant, sourceId: tool.sourceId, sequence: tool.sequence, result: {
      kind: tool.kind, ...(tool.version === 2 ? { version: 2, origin: tool.origin }
        : tool.version === 3 ? { version: 3, completedFile: tool.completedFile } : { version: 1 }),
      reportedStatus: tool.reportedStatus, omissions: tool.omissions,
      ...tool.tool === 'Write' ? { tool: 'Write', fields: tool.fields } : { tool: 'Edit', fields: tool.fields },
    } }
  }
  if (grant === undefined || observation === undefined || observation.state === 'revoked') {
    throw new Error('peer sample publication is required')
  }
  const result = observation.state === 'valid' ? { state: observation.state, sha256: observation.sha256, facts: observation.facts }
    : observation.state === 'invalid' ? { state: observation.state, sha256: observation.sha256, reason: observation.reason }
      : { state: observation.state, reason: observation.reason }
  return { grant, sourceId: observation.sourceId, sequence: observation.sequence, result }
}

/**
 * End the latest sampled chain and emit a canonical notice, even for an empty grant.
 * @param grant - immutable authorization being ended.
 * @param previous - latest admitted sample, when any.
 * @param reason - owner-recorded terminal reason.
 * @param at - original terminal commit timestamp.
 * @returns deterministic derived publications, without mutating historical samples.
 */
export function peerWithdrawals(
  grant: DevelopmentTaskPeerContributionGrant, previous: DevelopmentTaskContextPublication | undefined,
  reason: DevelopmentTaskContributionEndReason, at: number,
): readonly DevelopmentTaskContextPublication[] {
  const id = digest([grant.taskId, grant.grantId, grant.generation, 'ended'])
  const text = `Peer contribution ${grant.grantId} ended (${reason}). Earlier reports from this grant do not establish current facts.`
  const observation = previous?.peerObservation
  const withdrawn: DevelopmentTaskContextPublication[] = []
  if (observation !== undefined) {
    withdrawn.push({ id: `context-peer-withdrawal-${id}`, publishedAt: at, text,
      peerContribution: { version: 1, grant }, peerObservation: {
        kind: observation.kind, version: observation.version, artifactId: observation.artifactId, sourceName: observation.sourceName,
        grantId: observation.grantId, sequence: observation.sequence + 1, operation: observation.operation,
        observerPeerId: observation.observerPeerId, capture: observation.capture,
        sourceId: id as DevelopmentTaskObservedSourceId, state: 'revoked', reason: 'grant-ended',
      },
    })
  }
  withdrawn.push({ id: `context-peer-ended-${id}`, publishedAt: at, text, peerContribution: { version: 1, grant, ended: reason } })
  return withdrawn
}
