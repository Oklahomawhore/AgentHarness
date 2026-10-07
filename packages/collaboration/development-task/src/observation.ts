/** Immutable artifact evidence and its Task-local publication chains. */

import { createHash } from 'node:crypto'
import { freezePeerGrant } from './peer.ts'
import { freezeLocalGrant, freezeLocalToolObservation } from './local.ts'
import type {
  DevelopmentTaskContextPublication, DevelopmentTaskOpenApiObservation,
  DevelopmentTaskObservedIntervalIdentity, DevelopmentTaskObservedIntervalId,
} from './types.ts'

/**
 * Derive the owner approval identity and validate receipt attribution without depending on replica arrival.
 * @param identity - exact source Task, participant, binding, and epoch retained before submission.
 * @returns stable digest used by approval, admission, and terminal receipts.
 */
export function observedIntervalId(identity: DevelopmentTaskObservedIntervalIdentity): DevelopmentTaskObservedIntervalId {
  return createHash('sha256').update(JSON.stringify([
    identity.taskId, identity.sourceNodeId, identity.participantId, identity.bindingId,
    identity.expectedBindingEpoch.nodeId, identity.expectedBindingEpoch.seq,
  ])).digest('hex') as DevelopmentTaskObservedIntervalId
}

/**
 * Copy a publication without changing the serialized fields of legacy records.
 * @param publication - admitted or parser-validated publication.
 * @returns detached publication with all observation children frozen.
 */
export function freezePublication(publication: DevelopmentTaskContextPublication): DevelopmentTaskContextPublication {
  if (publication.localContribution !== undefined) {
    const tool = publication.localToolObservation
    return Object.freeze({ id: publication.id, text: publication.text,
      ...(publication.uri === undefined ? {} : { uri: publication.uri }), publishedBy: publication.publishedBy,
      publishedAt: publication.publishedAt, localContribution: Object.freeze({ version: 1 as const,
        grant: freezeLocalGrant(publication.localContribution.grant),
        ...(publication.localContribution.ended === undefined ? {} : { ended: publication.localContribution.ended }) }),
      ...(tool === undefined ? {} : { localToolObservation: freezeLocalToolObservation(tool) }),
    })
  }
  if (publication.peerContribution !== undefined) {
    const observation = publication.peerObservation
    const tool = publication.peerToolObservation
    const result = observation?.state === 'valid' ? { state: observation.state, sha256: observation.sha256, facts: Object.freeze({
      ...(observation.facts.operationId === undefined ? {} : { operationId: observation.facts.operationId }),
      requestBodyRequired: observation.facts.requestBodyRequired,
      requiredRequestFields: Object.freeze([...observation.facts.requiredRequestFields]),
      responseStatuses: Object.freeze([...observation.facts.responseStatuses]), deprecated: observation.facts.deprecated,
    }) } : observation?.state === 'invalid' ? { state: observation.state, sha256: observation.sha256, reason: observation.reason }
      : observation === undefined ? undefined : { state: observation.state, reason: observation.reason }
    return Object.freeze({ id: publication.id, text: publication.text,
      ...(publication.uri === undefined ? {} : { uri: publication.uri }), publishedAt: publication.publishedAt,
      peerContribution: Object.freeze({ version: 1 as const, grant: freezePeerGrant(publication.peerContribution.grant),
        ...(publication.peerContribution.ended === undefined ? {} : { ended: publication.peerContribution.ended }),
      }),
      ...(tool === undefined ? {} : { peerToolObservation: Object.freeze({ ...tool,
        ...(tool.version === 2 ? { origin: Object.freeze({ ...tool.origin }) } : {}),
        ...(tool.version === 3 ? { completedFile: Object.freeze({ ...tool.completedFile }) } : {}),
        fields: Object.freeze({ ...tool.fields }), omissions: Object.freeze([...tool.omissions]),
        capture: Object.freeze({ ...tool.capture }),
      }) as typeof tool }),
      ...(observation === undefined ? {} : { peerObservation: Object.freeze({ kind: observation.kind, version: observation.version,
        artifactId: observation.artifactId, sourceName: observation.sourceName, grantId: observation.grantId,
        sequence: observation.sequence, operation: Object.freeze({ ...observation.operation }), ...result,
        observerPeerId: observation.observerPeerId, sourceId: observation.sourceId, capture: Object.freeze({ ...observation.capture }),
      }) as typeof observation }),
    })
  }
  const observation = publication.observation
  if (observation === undefined) return Object.freeze({ ...publication })
  return Object.freeze({ ...publication, observation: Object.freeze({
    ...observation,
    operation: Object.freeze({ ...observation.operation }),
    binding: Object.freeze({ ...observation.binding, epoch: Object.freeze({ ...observation.binding.epoch }) }),
    ...observation.state === 'valid' ? { facts: Object.freeze({
      ...observation.facts,
      requiredRequestFields: Object.freeze([...observation.facts.requiredRequestFields]),
      responseStatuses: Object.freeze([...observation.facts.responseStatuses]),
    }) } : {},
  }) })
}

/**
 * Identify one observer's independently revocable artifact authorization.
 * @param observation - durable artifact evidence.
 * @returns collision-free identity independent of publication arrival order.
 */
export function observationChainKey(observation: DevelopmentTaskOpenApiObservation): string {
  return JSON.stringify([observation.observerNodeId, observation.artifactId, observation.grantId])
}

/**
 * Retain the greatest sample sequence for every artifact authorization.
 * @param context - direct publications of one Task.
 * @returns latest publication by observer, artifact, and grant identity.
 */
export function observationHeads(
  context: readonly DevelopmentTaskContextPublication[],
): ReadonlyMap<string, DevelopmentTaskContextPublication> {
  const heads = new Map<string, DevelopmentTaskContextPublication>()
  for (const publication of context) {
    const observation = publication.observation
    if (observation === undefined) continue
    const key = observationChainKey(observation)
    if ((heads.get(key)?.observation?.sequence ?? 0) < observation.sequence) heads.set(key, publication)
  }
  return heads
}
