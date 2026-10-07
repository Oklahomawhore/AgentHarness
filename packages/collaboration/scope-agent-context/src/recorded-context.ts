/** Text-free metadata derived from the current logged shared-context message. */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ScopeAgentBinding, ScopeAgentRecordedContext } from './types.ts'

/**
 * Observe one current shared snapshot without changing the Session or checking remote authorization.
 * @param session - live or detached Session with validated source events and surface replacements.
 * @param binding - current eligible, locally active binding; null hides ineligible or terminal observations.
 * @returns exact recorded metadata, or null without one unambiguous matching remote snapshot.
 */
export function recordedScopeContext(session: Session, binding: ScopeAgentBinding | null): ScopeAgentRecordedContext | null {
  if (binding === null || binding.kind === 'local-task') return null
  const snapshots = session.surface.nodes.flatMap((seq) => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message' && event.data.source.kind === 'scope-agent-context'
      && event.data.source.form === 'snapshot' ? [{ seq: event.seq, source: event.data.source, content: event.data.content }] : []
  })
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot === undefined) return null
  const source = snapshot.source
  const projection = source.projection
  const invitation = binding.invitation
  if (source.bindingId !== binding.id || source.subscriptionId !== binding.subscriptionId
    || projection.taskId !== invitation.taskId || projection.ownerPeerId !== invitation.ownerPeerId
    || projection.recipientPeerId !== invitation.recipientPeerId || projection.grantId !== invitation.grantId
    || projection.grantGeneration !== invitation.generation || projection.expiresAt !== invitation.expiresAt) return null
  const original = binding.originalCapture
  if (original === undefined ? source.version !== 1 : source.version !== 2
    || source.projection.peerCapture.captureId !== original.captureId
    || source.projection.peerCapture.captureGeneration !== original.captureGeneration) return null
  const omittedSourceCounts = { 'self-published': 0, budget: 0, unsupported: 0, superseded: 0, withdrawn: 0, 'recipient-irrelevant': 0 }
  for (const omitted of projection.omittedSources) omittedSourceCounts[omitted.reason]++
  return { contextSeq: snapshot.seq, bindingId: source.bindingId, subscriptionId: source.subscriptionId,
    sharedBytes: snapshot.content.reduce((bytes, block) => bytes + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0),
    taskRevision: projection.taskRevision, selectedSourceCount: projection.selectedSources.length, omittedSourceCounts }
}
