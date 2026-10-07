/** Exact joint consent and passive subscription recovery for an external Claude session. */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import type { ScopeCaptureSubscription, ScopeContributionApplicationResult, ScopeGeneration, ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeSession, ScopeDomain, ScopeReceive } from './state.ts'
import type { ScopeContribution } from './contribution-state.ts'
import type { ScopeJoint } from './joint-state.ts'
import type { ClaudeScopeJointId, ClaudeScopeRequestContributionRequest, ClaudeScopeRecoverJointRequest, ClaudeScopeSessionKey } from './types.ts'

/** Serialized local records; external subscription operations run outside this queue. */
export type JointQueue = <T>(operation: (domain: ScopeDomain) => T | Promise<T>) => Promise<T>

/** Read management revisions count explicit selections, including leave while adoption is still pending.
 * @param session - retained source record.
 * @returns the next safe revision, refusing exhausted counters.
 */
export function nextReadRevision(session: ScopeSession): number {
  const revision = (session.readRevision ?? 0) + 1
  if (!Number.isSafeInteger(revision)) throw new Error('claude-scope: read revision exhausted')
  return revision
}

/** Compare the exact source generation rather than its peer or Task.
 * @param capture - current capture, when retained.
 * @param joint - original consent.
 * @returns whether contribution management still belongs to this operation.
 */
export function ownsJointCapture(capture: ScopeContribution | undefined, joint: ScopeJoint): boolean {
  return capture?.proposal.captureId === joint.proposal.captureId
    && capture.proposal.captureGeneration === joint.proposal.captureGeneration
}

/** Compare the exact receiving interval and its last accepted local revision.
 * @param session - latest retained session.
 * @param joint - original operation.
 * @returns whether joint leave may clear this receiving selection.
 */
export function ownsJointRead(session: ScopeSession, joint: ScopeJoint): boolean {
  return joint.subscription !== undefined && session.receive?.subscriptionId === joint.subscription.id
    && session.receive.generation === joint.subscription.generation && session.readRevision === joint.adoptedReadRevision
}

/** Persisting a read management action supersedes pending adoption even if no subscription exists yet.
 * @param session - record before the explicit local action.
 * @returns a versioned record with old joint adoption stopped; no remote call occurs.
 */
export function advanceReadSelection(session: ScopeSession): Extract<ScopeSession, { readonly version: 2 }> {
  const joint = session.joint
  return { ...session, version: 2, readRevision: nextReadRevision(session), ...(joint === undefined ? {} : {
    joint: { ...joint, intent: 'leave' as const, state: 'superseded' as const, cleanupPending: joint.subscription !== undefined },
  }) }
}

/** Validate original read consent before preparing any local capture.
 * @param session - current local selection.
 * @param request - explicit application and optional passive receiving consent.
 * @returns after rejecting conflicting or stale authorization.
 */
export function validateJointRequest(session: ScopeSession, request: ClaudeScopeRequestContributionRequest): void {
  const entry = request.entry
  const jointEntry = entry.kind === 'scope-join-entry' || entry.kind === 'scope-group-entry'
  if (jointEntry !== (request.receive !== undefined)) throw new RemoteError('claude-scope/local-permission-invalid',
    'Joint entries require explicit receiving consent; contribution-only entries cannot add it', { sessionKey: request.sessionKey })
  if (!jointEntry) return
  const joint = session.joint
  if (joint !== undefined && ownsJointCapture(session.contribution, joint) && session.contribution?.application !== undefined) {
    if (request.receive?.expectedReadRevision !== joint.expectedReadRevision) throw conflict(session)
    return
  }
  if (session.receive !== undefined || session.grant !== undefined || session.pendingEnd !== undefined
    || (joint !== undefined && (joint.cleanupPending || (joint.intent === 'adopt' && joint.state !== 'ended' && joint.state !== 'superseded')))
    || request.receive?.expectedReadRevision !== (session.readRevision ?? 0)) throw conflict(session)
}

/** Allocate a joint identity together with its original application; no receiving authority is inferred.
 * @param session - prepared capture record.
 * @param request - validated original application consent.
 * @param capture - prepared capture selected by the caller under the mutation queue.
 * @returns versioned session ready for one atomic application write.
 */
export function prepareJoint(session: ScopeSession, request: ClaudeScopeRequestContributionRequest,
  capture: ScopeContribution): ScopeSession {
  if (request.receive === undefined) return session
  if (session.joint !== undefined && ownsJointCapture(capture, session.joint) && capture.application !== undefined) {
    const previous = session.joint
    return previous.entry.ownerAddress === request.entry.ownerAddress ? session
      : recoverJointRoute(session, { sessionKey: session.sessionKey, jointId: previous.id,
        expectedReadRevision: session.readRevision, ownerAddress: request.entry.ownerAddress })
  }
  return { ...session, version: 2, readRevision: session.readRevision ?? 0, joint: {
    id: randomUUID() as ClaudeScopeJointId, proposal: capture.proposal, entry: request.entry, limits: request.limits,
    expectedReadRevision: request.receive.expectedReadRevision, authorizedReadRevision: request.receive.expectedReadRevision,
    state: 'waiting', intent: 'adopt', ready: false, cleanupPending: false, routeRevision: 0, routePending: false,
  } }
}

/** Select exact owner-approved reading without enabling it before contribution verification.
 * @param session - current application record.
 * @param capture - exact capture selected by the shared controller.
 * @param approval - response whose contribution receipt has already been validated.
 * @returns record retaining one immutable subscription plan for retries.
 */
export function selectJointApproval(session: ScopeSession, capture: ScopeContribution,
  approval: Extract<ScopeContributionApplicationResult, { status: 'approved' | 'ended' }>): ScopeSession {
  const joint = session.joint
  if (joint === undefined || !ownsJointCapture(capture, joint)) {
    if (approval.readInvitation !== undefined) throw conflict(session)
    return session
  }
  if (joint.intent !== 'adopt') return session
  const read = approval.readInvitation
  const grant = approval.invitation.grant
  if (read === undefined || approval.readState === undefined || read.ownerPeerId !== joint.entry.ownerPeerId
    || read.taskId !== joint.entry.taskId || read.recipientPeerId !== joint.proposal.contributorPeerId
    || read.expiresAt !== grant.expiresAt || read.expiresAt > joint.limits.expiresAt) throw conflict(session)
  const invitation = { ...read, ownerAddress: joint.entry.ownerAddress }
  const selected = joint.subscription
  if (selected !== undefined) {
    const { ownerAddress: _old, ...oldGrant } = selected.invitation
    const { ownerAddress: _new, ...newGrant } = invitation
    if (!isDeepStrictEqual(oldGrant, newGrant)) throw conflict(session)
  }
  return { ...session, joint: { ...joint,
    state: approval.readState === 'active' ? 'adopting' as const : 'ended' as const,
    ready: approval.status === 'ended',
    subscription: selected ?? { version: 2, id: randomUUID() as ScopeSubscriptionId, generation: randomUUID() as ScopeGeneration,
      invitation, state: 'active', originalCapture: { captureId: joint.proposal.captureId, captureGeneration: joint.proposal.captureGeneration },
      routeRevision: joint.routeRevision },
    contributionInvitation: { ...approval.invitation, ownerAddress: joint.entry.ownerAddress },
  } }
}

/** Determine whether durable joint work survives beyond the contribution's lifetime.
 * @param session - latest local record.
 * @returns whether adoption, exact cleanup, or route synchronization needs a worker.
 */
export function jointNeedsWork(session: ScopeSession | undefined):
  session is ScopeSession & { readonly joint: ScopeJoint & { readonly subscription: ScopeCaptureSubscription } } {
  const joint = session?.joint
  if (joint?.subscription === undefined) return false
  if (joint.cleanupPending) return true
  if (joint.intent !== 'adopt' || joint.state === 'ended' || joint.state === 'superseded') return false
  return (joint.routePending || joint.state !== 'active')
    && (joint.ready || (ownsJointCapture(session?.contribution, joint) && session?.contribution?.state === 'active'))
}

/** Retain one complete route update without widening any grant or reviving contribution.
 * @param session - exact current joint selection.
 * @param request - current management revision and replacement address.
 * @returns a single durable intent for both receiving and contribution recovery.
 */
export function recoverJointRoute(session: ScopeSession, request: ClaudeScopeRecoverJointRequest): ScopeSession {
  if (session.joint === undefined || session.joint.id !== request.jointId) throw conflict(session)
  const joint = session.joint
  const terminating = joint.cleanupPending || (ownsJointCapture(session.contribution, joint) && session.contribution?.state === 'ending')
  if (!terminating && (joint.intent !== 'adopt' || joint.state === 'ended' || joint.state === 'superseded')) throw conflict(session)
  const prior = joint.routeRequest
  if (prior?.expectedReadRevision === request.expectedReadRevision && prior.ownerAddress === request.ownerAddress
    && session.readRevision === prior.appliedReadRevision) return session
  if (session.readRevision !== request.expectedReadRevision
    || (joint.intent === 'adopt' && session.receive !== undefined && !ownsJointRead(session, joint))) throw conflict(session)
  directAddress(request.ownerAddress, joint.entry.ownerPeerId)
  const revision = nextReadRevision(session)
  const routeRevision = joint.routeRevision + 1
  if (!Number.isSafeInteger(routeRevision)) throw new Error('claude-scope: route revision exhausted')
  const capture = session.contribution
  const ownCapture = ownsJointCapture(capture, joint) ? capture : undefined
  return { ...session, version: 2, readRevision: revision,
    ...(ownCapture === undefined ? {} : { contribution: { ...ownCapture,
      ...(ownCapture.application === undefined ? {} : { application: { ...ownCapture.application,
        entry: { ...ownCapture.application.entry, ownerAddress: request.ownerAddress } } }),
      ...(ownCapture.invitation === undefined ? {} : { invitation: { ...ownCapture.invitation, ownerAddress: request.ownerAddress } }),
    } }),
    joint: { ...joint, entry: { ...joint.entry, ownerAddress: request.ownerAddress }, routeRevision,
      ...(joint.intent !== 'adopt' ? {} : { authorizedReadRevision: revision,
        ...(joint.adoptedReadRevision === undefined ? {} : { adoptedReadRevision: revision }) }),
      routePending: joint.intent === 'adopt' && joint.subscription !== undefined,
      routeRequest: { expectedReadRevision: request.expectedReadRevision, appliedReadRevision: revision,
        ownerAddress: request.ownerAddress },
      ...(joint.subscription === undefined ? {} : { subscription: { ...joint.subscription, routeRevision,
        invitation: { ...joint.subscription.invitation, ownerAddress: request.ownerAddress } } }),
      ...(joint.contributionInvitation === undefined ? {} : {
        contributionInvitation: { ...joint.contributionInvitation, ownerAddress: request.ownerAddress },
      }),
    } }
}

/** Reconcile one captured plan outside the local queue, then compare current consent before adoption.
 * @param ctx - local scope access and change notification services.
 * @param enqueue - short serialized record mutations.
 * @param key - original external session.
 * @param signal - owning service and worker lifetime.
 * @returns after adoption or cleanup commits, or throws while its exact plan remains retryable.
 */
export async function reconcileJoint(ctx: Context, enqueue: JointQueue, key: ClaudeScopeSessionKey, signal: AbortSignal): Promise<void> {
  const selected = await enqueue(domain => domain.table('sessions').get(key))
  if (!jointNeedsWork(selected)) return
  const joint = selected.joint
  const access = ctx.get('scopeAccess')
  if (access === undefined) throw new Error('claude-scope: joint receiving requires independent scope access')
  const plan = joint.subscription
  if (joint.cleanupPending || joint.intent !== 'adopt') {
    const existing = (await access.list()).subscriptions.find(item => item.id === plan.id)
    if (existing !== undefined) await access.leave({ subscriptionId: plan.id })
    await enqueue(async (domain) => {
      const session = domain.table('sessions').get(key)
      if (session?.version !== 2 || session.joint?.id !== joint.id || session.joint.intent === 'adopt') return
      await domain.table('sessions').put(key, { ...session, joint: { ...session.joint, cleanupPending: false,
        state: session.joint.state === 'superseded' ? 'superseded' as const : 'ended' as const } })
      ctx.emit('claude-scope/session-changed', key)
    })
    return
  }
  signal.throwIfAborted()
  if (plan.invitation.expiresAt <= Date.now()) {
    const existing = (await access.list()).subscriptions.find(item => item.id === plan.id)
    if (existing !== undefined) await access.leave({ subscriptionId: plan.id })
    await enqueue(async (domain) => {
      const session = domain.table('sessions').get(key)
      if (session?.version !== 2 || session.joint?.id !== joint.id || session.joint.routeRevision !== joint.routeRevision) return
      await domain.table('sessions').put(key, { ...session, joint: { ...session.joint, state: 'ended' as const, routePending: false } })
      ctx.emit('claude-scope/session-changed', key)
    })
    return
  }
  let subscription = await access.ensureSubscription(plan)
  if (joint.routePending && subscription.state === 'active') subscription = await access.updateSubscriptionRoute({ ...plan, routeRevision: joint.routeRevision })
  // The created subscription remains owned even if cancellation arrives while persistence is awaiting durability.
  const adopted = await enqueue(async (domain) => {
    const session = domain.table('sessions').get(key)
    const current = session?.joint
    if (session?.version !== 2 || current?.id !== joint.id || current.intent !== 'adopt'
      || current.routeRevision !== joint.routeRevision || session.ended || signal.aborted) return false
    const alreadyOwned = ownsJointRead(session, current)
    if ((!alreadyOwned && (session.receive !== undefined || session.readRevision !== current.authorizedReadRevision))
      || (!current.ready && (!ownsJointCapture(session.contribution, current) || session.contribution?.state !== 'active'))) return false
    if (subscription.state !== 'active' || subscription.invitation.expiresAt <= Date.now()) {
      await domain.table('sessions').put(key, { ...session, joint: { ...current, state: 'ended' as const, routePending: false } })
      ctx.emit('claude-scope/session-changed', key)
      return true
    }
    const read = subscription.invitation
    const receive: ScopeReceive = { subscriptionId: subscription.id, generation: subscription.generation,
      taskId: read.taskId, ownerPeerId: read.ownerPeerId, grantId: read.grantId,
      grantGeneration: read.generation, expiresAt: read.expiresAt, status: alreadyOwned && session.receive !== undefined ? session.receive.status : 'pending' }
    const revision = alreadyOwned ? session.readRevision : nextReadRevision(session)
    await domain.table('sessions').put(key, { ...session, version: 2, readRevision: revision, receive,
      joint: { ...current, state: 'active', ready: true, adoptedReadRevision: revision, authorizedReadRevision: revision, routePending: false,
        ...(current.routeRequest === undefined ? {} : { routeRequest: { ...current.routeRequest, appliedReadRevision: revision } }) } })
    ctx.emit('claude-scope/session-changed', key)
    return true
  })
  if (!adopted) {
    const current = await enqueue(domain => domain.table('sessions').get(key))
    // A newer route owns the same immutable plan; its retry must not find that subscription ended by an older operation.
    if (current?.joint?.id === joint.id && current.joint.intent === 'adopt' && !current.ended
      && !signal.aborted && current.joint.routeRevision !== joint.routeRevision) return
    if (!signal.aborted) await access.leave({ subscriptionId: plan.id })
  }
}

function conflict(session: ScopeSession): Error {
  return new RemoteError('claude-scope/source-conflict', 'The joint receiving selection is stale or conflicts with current local permission',
    { sessionKey: session.sessionKey })
}
