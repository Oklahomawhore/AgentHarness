/** Source-interval identity shared by context projection backends. */

import { localContributionId } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskContextPublication,
  DevelopmentTaskOpenApiObservation, DevelopmentTaskPeerOpenApiObservation } from '@deepseek-ai/dsh-development-task/types'
import type { DevelopmentTaskContextInput } from './types.ts'

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
export function peerContributionInterval(grant: NonNullable<DevelopmentTaskContextInput['recipient']['peerCapture']>): string {
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

/**
 * Partition one snapshot's generic tool reports and retire history before its last complete reported Write.
 * @param context - Publications from exactly one current Task or frozen parent snapshot.
 * @returns Per-publication file chain and supersession; terminal and non-tool publications have no tool chain.
 */
export function publicationToolHistory(context: readonly DevelopmentTaskContextPublication[]): readonly ({
  readonly chain: string
  readonly superseded: boolean
} | undefined)[] {
  const checkpoints = new Map<string, number>()
  const samples = context.map((publication) => {
    const tool = publication.peerToolObservation ?? publication.localToolObservation
    const source = publication.peerContribution?.grant.source ?? publication.localContribution?.grant.source
    const interval = publicationInterval(publication)
    if (tool === undefined || source?.kind !== 'tool-observations' || interval === undefined
      || isTerminalPublication(publication)) return undefined
    const chain = JSON.stringify([interval, source.name, [...source.tools].sort(), tool.fields.rootIndex, tool.fields.path])
    if (tool.tool === 'Write' && tool.reportedStatus === 'success' && tool.fields.content !== undefined) {
      checkpoints.set(chain, Math.max(checkpoints.get(chain) ?? 0, tool.sequence))
    }
    return { chain, sequence: tool.sequence }
  })
  return samples.map((sample) => {
    if (sample === undefined) return undefined
    const checkpoint = checkpoints.get(sample.chain)
    return { chain: sample.chain, superseded: checkpoint !== undefined && sample.sequence < checkpoint }
  })
}

/**
 * Omit authored reports only for the exact recipient or verified peer capture interval; withdrawals remain visible.
 * @param publication - Owner-admitted publication.
 * @param recipient - Authorized recipient and optional original joint capture.
 * @returns Whether ordinary report text belongs to this recipient's own source interval.
 */
export function isSelfPublished(publication: DevelopmentTaskContextPublication,
  recipient: DevelopmentTaskContextInput['recipient']): boolean {
  if (isTerminalPublication(publication)) return false
  if (publication.publishedBy === recipient.participantId) return true
  const grant = publication.peerContribution?.grant
  return publication.peerToolObservation !== undefined && grant !== undefined && recipient.peerCapture !== undefined
    && peerContributionInterval(grant) === peerContributionInterval(recipient.peerCapture)
}
