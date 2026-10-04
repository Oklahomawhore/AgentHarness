/** Durable tool outbox admission; remote receipts survive missing local Task replicas. */

import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { observedIntervalId } from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskAdmitRemoteObservedContextResult, DevelopmentTaskOpenApiObservationInput } from '@deepseek-ai/dsh-development-task/types'
import { scopeDigest } from './projection.ts'
import type { ScopeCompletionSample, ScopeDomain, ScopeGrant, ScopeSession } from './state.ts'

function requireReceipt(
  session: ScopeSession, grant: ScopeGrant, sample: ScopeCompletionSample,
  receipt: DevelopmentTaskAdmitRemoteObservedContextResult['receipt'],
): void {
  const remote = grant.remote
  const intervalId = observedIntervalId({ taskId: grant.taskId, sourceNodeId: grant.epoch.nodeId,
    participantId: session.participantId, bindingId: session.bindingId, expectedBindingEpoch: grant.epoch,
  })
  if (remote === undefined || receipt.taskId !== grant.taskId || receipt.ownerNodeId !== remote.ownerNodeId
    || receipt.intervalId !== remote.intervalId || receipt.intervalId !== intervalId || receipt.sourceId !== sample.sourceId
    || receipt.publicationId !== `context-observation-${sample.sourceId}` || receipt.event.nodeId !== remote.ownerNodeId) {
    throw new Error('claude-scope: admission receipt does not match its source interval and publication')
  }
}

/**
 * Submit exact persisted evidence to its local authority or explicitly approved remote owner.
 * @param ctx - Task service with owner routing.
 * @param session - source identity owned by this Host.
 * @param grant - original binding and collection permission.
 * @param sample - original bounded evidence, with a receipt when an earlier attempt completed.
 * @returns committed outcome and a remote receipt checked against the persisted source and returned publication.
 */
export async function admitScopeObservation(
  ctx: Context, session: ScopeSession, grant: ScopeGrant,
  sample: ScopeCompletionSample & { readonly observation?: DevelopmentTaskOpenApiObservationInput },
): Promise<{ readonly outcome: 'published' | 'reused'; readonly receipt?: DevelopmentTaskAdmitRemoteObservedContextResult['receipt'] }> {
  if (sample.receipt !== undefined) {
    requireReceipt(session, grant, sample, sample.receipt)
    return { outcome: 'reused', receipt: sample.receipt }
  }
  const observation = sample.observation
  if (observation?.state === 'revoked') throw new Error('claude-scope: a tool sample cannot revoke a source grant')
  const request = {
    taskId: grant.taskId, participantId: session.participantId, bindingId: session.bindingId,
    expectedBindingEpoch: grant.epoch, sourceId: sample.sourceId, text: sample.text,
    ...(observation === undefined ? {} : { observation }),
  }
  if (grant.remote === undefined) return ctx.developmentTasks.admitObservedContext(request)
  if (grant.remote.intervalId === undefined) throw new Error('claude-scope: remote source approval is pending')
  const admitted = await ctx.developmentTasks.admitObservedRemote({ ...request, intervalId: grant.remote.intervalId })
  requireReceipt(session, grant, sample, admitted.receipt)
  const expectedObservation = observation === undefined ? undefined : {
    ...observation, observerNodeId: grant.epoch.nodeId, sourceId: sample.sourceId,
    binding: { id: session.bindingId, epoch: grant.epoch },
  }
  const publication = admitted.publication
  if (publication.id !== admitted.receipt.publicationId || publication.publishedBy !== session.participantId
    || publication.observedIntervalId !== grant.remote.intervalId || publication.observedIntervalEnded !== undefined
    || publication.uri !== undefined || publication.text !== sample.text.trim()
    || !isDeepStrictEqual(publication.observation, expectedObservation)) {
    throw new Error('claude-scope: remote publication does not match its pending observation')
  }
  return { outcome: admitted.outcome, receipt: admitted.receipt }
}

/**
 * Retry persisted tool completions without requiring another external completion or reading fresh bytes.
 * @param ctx - authoritative Task admission service.
 * @param domain - records accessed under the adapter mutation queue.
 * @param session - original local source identity.
 * @param grant - current authorization interval.
 * @param signal - operation cancellation.
 * @param current - authorization recheck after each asynchronous operation.
 * @returns false when the caller must stop admission for an obsolete interval.
 */
export async function flushCompletionSamples(
  ctx: Context, domain: ScopeDomain, session: ScopeSession, grant: ScopeGrant, signal: AbortSignal, current: () => boolean,
): Promise<boolean> {
  for (const [key, lease] of domain.table('leases').entries()) {
    if (lease.sessionKey !== session.sessionKey || lease.policyRevision !== grant.policy.revision
      || lease.completion === undefined || lease.completionAdmitted) continue
    if (lease.taskId !== grant.taskId || lease.epoch.nodeId !== grant.epoch.nodeId || lease.epoch.seq !== grant.epoch.seq
      || lease.terminal === undefined || lease.terminal.textDigest !== scopeDigest([lease.completion.text])
      || lease.completion.sourceId !== scopeDigest([
        domain.global.get().installationId, session.sessionId, lease.toolUseId, lease.terminal.event, grant.epoch,
      ])) {
      throw new Error('claude-scope: pending completion does not match its original Task interval')
    }
    signal.throwIfAborted()
    if (!current()) return false
    const admitted = await admitScopeObservation(ctx, session, grant, lease.completion)
    await domain.table('leases').put(key, {
      ...lease, completion: { ...lease.completion, ...(admitted.receipt === undefined ? {} : { receipt: admitted.receipt }) },
      completionAdmitted: true,
    })
    signal.throwIfAborted()
    if (!current()) return false
  }
  return current()
}
