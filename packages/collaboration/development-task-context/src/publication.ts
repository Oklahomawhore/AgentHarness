/** Source-interval identity shared by context projection backends. */

import { localContributionId } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskContextPublication, DevelopmentTaskPeerContributionGrant,
  DevelopmentTaskOpenApiObservation, DevelopmentTaskPeerOpenApiObservation } from '@deepseek-ai/dsh-development-task/types'

/**
 * Identify a terminal notice without treating an ordinary revoked sample as the notice.
 * @param publication - Owner-admitted current or inherited publication.
 * @returns Whether this publication closes its source interval.
 */
export function isTerminalPublication(publication: DevelopmentTaskContextPublication): boolean {
  return publication.observedIntervalEnded === true || publication.peerContribution?.ended !== undefined
    || publication.localContribution?.ended !== undefined
}

/**
 * Keep Mesh intervals, independent peer grants, and owner-local captures in distinct withdrawal namespaces.
 * @param publication - Owner-admitted current or inherited publication.
 * @returns Its source interval key, or undefined for an explicit publication.
 */
export function publicationInterval(publication: DevelopmentTaskContextPublication): string | undefined {
  if (publication.localContribution !== undefined) return JSON.stringify(['local', localContributionId(publication.localContribution.grant)])
  if (publication.peerContribution !== undefined) {
    return peerContributionInterval(publication.peerContribution.grant)
  }
  return publication.observedIntervalId === undefined ? undefined : JSON.stringify(['mesh', publication.observedIntervalId])
}

/**
 * Identify exactly one owner-authorized peer capture generation.
 * @param grant - Immutable owner-stamped contribution authorization.
 * @returns The source-interval key shared by its observations and terminal notice.
 */
export function peerContributionInterval(grant: DevelopmentTaskPeerContributionGrant): string {
  return JSON.stringify(['peer', grant.ownerPeerId, grant.contributorPeerId, grant.taskId,
    grant.grantId, grant.generation, grant.captureId, grant.captureGeneration])
}

/**
 * Read one typed sample and its observer/grant chain without merging peer and Mesh identities.
 * @param publication - Owner-admitted publication whose metadata matches its source authorization.
 * @returns The typed observation and chain key, or undefined for an untyped publication; callers also partition by artifact and snapshot.
 */
export function publicationObservation(publication: DevelopmentTaskContextPublication): {
  readonly observation: DevelopmentTaskOpenApiObservation | DevelopmentTaskPeerOpenApiObservation
  readonly chain: string
} | undefined {
  if (publication.peerContribution !== undefined) {
    const observation = publication.peerObservation
    return observation === undefined ? undefined : { observation, chain: peerContributionInterval(publication.peerContribution.grant) }
  }
  const observation = publication.observation
  return observation === undefined ? undefined : {
    observation, chain: JSON.stringify([observation.observerNodeId, observation.grantId]),
  }
}
