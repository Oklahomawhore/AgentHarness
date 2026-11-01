/** Coverage requirements for automatic work and explicit recipient-evidence failures. */

import type { ScopeAgentReadProjection } from './types.ts'

/**
 * Require current publication coverage before automatic work; historical omissions remain visible metadata.
 * @param projection - exact authorized local or remote projection, including legacy exact records.
 * @param automatic - whether the projection will support automatic work.
 * @returns whether coverage requires withdrawal instead of using the projection for this request.
 */
export function blocksCurrentCoverage(projection: ScopeAgentReadProjection, automatic: boolean): boolean {
  if ('kind' in projection && projection.kind === 'local-task-scope') {
    return blocksCurrentCoverage(projection.local, automatic) || blocksCurrentCoverage(projection.remote, automatic)
  }
  if (('kind' in projection || projection.version === 2 || projection.version === 3) && projection.activation.kind === 'recipient-evidence'
    && projection.activation.coverage === 'blocked-current') return true
  return automatic && projection.omittedSources.some(({ source, reason }) => reason === 'budget'
    && source.kind === 'publication' && source.taskId === projection.taskId && source.revision === projection.taskRevision)
}
