/** Joint consent uses real scope subscriptions with controlled queued management changes. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { contributionProposalSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import { claudeScopeDomainSpec, type ScopeSession } from '../src/state.ts'
import type { ScopeJoint } from '../src/joint-state.ts'
import type { ScopeContribution } from '../src/contribution-state.ts'
import {
  advanceReadSelection, jointNeedsWork, nextReadRevision, ownsJointCapture, ownsJointRead,
  prepareJoint, reconcileJoint, recoverJointRoute, selectJointApproval, validateJointRequest, type JointQueue,
} from '../src/joint.ts'

const ownerPeer = peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy')
const signal = () => new AbortController().signal
const releases: Array<() => void> = []
const pending: Promise<unknown>[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  await cleanup()
})

async function fixture() {
  const owner = await host('joint-unit-owner', undefined, {}, [], ownerPeer)
  const source = await host('joint-unit-source')
  const task = await owner.createTask('Independent external-session collaboration')
  const ownerAddress = (await owner.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address is missing')
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 4, maxSampleBytes: 4096 }
  const entry = (await owner.access.createGroupEntry({ taskId: task.id, ownerAddress,
    expiresAt: limits.expiresAt, maxMembers: 4 })).entry
  const proposal = contributionProposalSchema.parse({ contributorPeerId: source.transport.peerId,
    captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const capture: ScopeContribution = { proposal, policy: { roots: ['/work'], bashCommands: [], revision: 'files-1' },
    source: { kind: 'tool-observations', tools: ['Write'] }, state: 'prepared', sequence: 0,
    application: { entry, limits, state: 'waiting' } }
  const original: ScopeSession = { sessionKey: 'external-session' as ScopeSession['sessionKey'], sessionId: 'claude-session',
    participantId: 'external-participant' as ScopeSession['participantId'], bindingId: 'external-binding' as ScopeSession['bindingId'],
    observedAt: 1, ended: false, contribution: capture }
  const request = { sessionKey: original.sessionKey, expectedCapture: null, roots: ['/work'], source: capture.source,
    entry, limits, receive: { expectedReadRevision: 0 } }
  const prepared = prepareJoint(original, request, capture)
  if (prepared.version !== 2) throw new Error('Joint preparation did not retain a version-2 record')
  await source.access.applyContribution({ entry, proposal, limits }, signal())
  const member = (await owner.access.groupApplications({ entryId: entry.entryId })).entries[0]
  if (member === undefined) throw new Error('Application is missing')
  await owner.access.approveContributionApplication({ entryId: entry.entryId, applicationId: member.applicationId,
    expectedProposal: proposal, limits, ownerAddress, read: { responsibility: 'Maintain the external client' } })
  const approval = await source.access.contributionApplicationStatus({ entry, proposal }, signal())
  if (approval.status !== 'approved' || approval.readInvitation === undefined) throw new Error('Approval is missing')
  const read = approval.readInvitation
  const selected = selectJointApproval(prepared, capture, approval)
  if (selected.version !== 2 || selected.joint?.subscription === undefined) throw new Error('Subscription plan is missing')
  const joint = selected.joint
  const plan = selected.joint.subscription
  const activeCapture: ScopeContribution = { ...capture, application: undefined, state: 'active', invitation: approval.invitation }
  const session: Extract<ScopeSession, { readonly version: 2 }> = { ...selected, contribution: activeCapture }
  const domain = await source.ctx.storageDomain.open(claudeScopeDomainSpec)
  source.ctx.effect(() => () => domain.close())
  const sessions = domain.table('sessions')
  await sessions.put(session.sessionKey, session)
  const enqueue: JointQueue = operation => Promise.resolve(operation(domain))
  const current = () => {
    const value = sessions.get(session.sessionKey)
    if (value === undefined) throw new Error('Fixture session is missing')
    return value
  }
  const put = async (value: ScopeSession) => sessions.put(session.sessionKey, value)
  const run = (operationSignal = signal(), queue = enqueue) => reconcileJoint(source.ctx, queue, session.sessionKey, operationSignal)
  const route = (value: ScopeSession, address = `/ip4/127.0.0.1/tcp/2/p2p/${ownerPeer}`) => recoverJointRoute(value,
    { sessionKey: session.sessionKey, jointId: joint.id, expectedReadRevision: value.readRevision ?? 0, ownerAddress: address })
  return { owner, source, task, entry, limits, capture, activeCapture, original, request, prepared, approval, read,
    session, joint, plan, domain, sessions, current, put, enqueue, run, route }
}

async function heldEnsure(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const ensure = f.source.access.ensureSubscription.bind(f.source.access)
  vi.spyOn(f.source.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
    const result = await ensure(plan)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const work = f.run()
  pending.push(Promise.allSettled([work]))
  await Promise.race([entered.promise, work])
  return { finish: async () => { release.resolve(undefined); await work } }
}

it('keeps legacy records unbound and counts every explicit read selection without wrapping revisions', async () => {
  const f = await fixture()
  expect(nextReadRevision(f.original)).toBe(1)
  expect(() => nextReadRevision({ ...f.original, version: 2, readRevision: Number.MAX_SAFE_INTEGER })).toThrow('revision exhausted')
  const stopped = advanceReadSelection(f.original)
  expect(stopped).toMatchObject({ version: 2, readRevision: 1 })
  expect(stopped.joint).toBeUndefined()
  expect(jointNeedsWork(undefined)).toBe(false)
  expect(jointNeedsWork(stopped)).toBe(false)
  expect(ownsJointCapture(undefined, f.joint)).toBe(false)
  expect(ownsJointRead(f.original, f.joint)).toBe(false)
})

it('requires the original read consent for application retries and permits a new operation only after clean termination', async () => {
  const f = await fixture()
  expect(() => { validateJointRequest(f.prepared, { ...f.request, receive: { expectedReadRevision: 1 } }) }).toThrow('stale')
  for (const state of ['waiting', 'adopting', 'failed'] as const) {
    expect(() => { validateJointRequest({ ...f.prepared, contribution: undefined, joint: { ...f.joint, state } }, f.request) })
      .toThrow('stale')
  }
  expect(() => {
    validateJointRequest({ ...f.prepared, contribution: undefined,
      joint: { ...f.joint, state: 'ended' as const, intent: 'leave' as const, cleanupPending: true } }, f.request)
  }).toThrow('stale')
  for (const state of ['ended', 'superseded'] as const) {
    expect(() => {
      validateJointRequest({ ...f.prepared, contribution: undefined,
        joint: { ...f.joint, state, intent: 'adopt' as const } }, f.request)
    }).not.toThrow()
  }
  expect(prepareJoint(f.prepared, f.request, f.capture)).toBe(f.prepared)
  const { receive: _receive, ...contributionOnly } = f.request
  expect(prepareJoint(f.original, contributionOnly, f.capture)).toBe(f.original)
})

it('rejects an unrelated owner read permission and does not revise a selected read grant on a delayed response', async () => {
  const f = await fixture()
  expect(() => selectJointApproval(f.original, f.capture, f.approval)).toThrow('stale')
  const { readInvitation: _invitation, readState: _state, ...withoutRead } = f.approval
  expect(selectJointApproval(f.original, f.capture, withoutRead)).toBe(f.original)
  expect(() => selectJointApproval(f.prepared, f.capture, withoutRead)).toThrow('stale')
  const otherTask = await f.owner.createTask('Separate responsibility')
  const other = await f.owner.access.invite({ ...f.read, taskId: otherTask.id,
    responsibility: 'Unrelated read permission' })
  expect(() => selectJointApproval(f.prepared, f.capture, { ...f.approval, readInvitation: other })).toThrow('stale')
  const replacement = await f.owner.access.invite({ ...f.read, responsibility: 'Another explicit invitation' })
  expect(() => selectJointApproval(f.session, f.capture, { ...f.approval, readInvitation: replacement })).toThrow('stale')
  const ended = selectJointApproval(f.prepared, f.capture, { ...f.approval, readState: 'revoked' })
  expect(ended.joint?.state).toBe('ended')
  expect(jointNeedsWork(ended)).toBe(false)
})

it('recovers a waiting application without manufacturing a selected grant and rejects unrelated or completed operations', async () => {
  const f = await fixture()
  const recovered = f.route(f.prepared)
  expect(recovered.joint?.subscription).toBeUndefined()
  expect(recovered.contribution?.invitation).toBeUndefined()
  expect(recovered.joint?.authorizedReadRevision).toBe(1)
  expect(() => recoverJointRoute(f.session, { sessionKey: f.session.sessionKey,
    jointId: randomUUID() as ScopeJoint['id'], expectedReadRevision: 0, ownerAddress: f.entry.ownerAddress })).toThrow('stale')
  expect(() => f.route({ ...f.session, joint: { ...f.joint, state: 'ended' as const } })).toThrow('stale')
  expect(() => f.route({ ...f.session, joint: { ...f.joint, routeRevision: Number.MAX_SAFE_INTEGER } }))
    .toThrow('route revision exhausted')
  const readOnly = f.route({ ...f.session, contribution: undefined })
  expect(readOnly.contribution).toBeUndefined()
  expect(readOnly.joint?.subscription?.id).toBe(f.plan.id)
})

it('retains an adopted read route while preserving a later unrelated capture', async () => {
  const f = await fixture()
  await f.run()
  const otherCapture: ScopeContribution = { ...f.capture, application: undefined,
    proposal: { ...f.capture.proposal, captureId: randomUUID() as ScopeContribution['proposal']['captureId'] } }
  const recovered = f.route({ ...f.current(), contribution: otherCapture })
  expect(recovered.contribution).toEqual(otherCapture)
  expect(recovered.joint?.adoptedReadRevision).toBe(recovered.readRevision)
  if (recovered.joint === undefined) throw new Error('Recovered joint is missing')
  expect(ownsJointRead(recovered, recovered.joint)).toBe(true)
})

it('does no work for missing or already adopted sessions and reports missing access before creating a subscription', async () => {
  const f = await fixture()
  await f.run()
  const ensure = vi.spyOn(f.source.access, 'ensureSubscription')
  await f.run()
  expect(ensure).not.toHaveBeenCalled()
  await f.sessions.delete(f.session.sessionKey)
  await f.run()
  await f.put(f.session)
  const empty = new Context()
  try { await expect(reconcileJoint(empty, f.enqueue, f.session.sessionKey, signal())).rejects.toThrow('requires independent scope access') }
  finally { await empty.fiber.dispose() }
})

it.each([false, true])('ends an expired selected plan with an existing subscription: %s', async (existing) => {
  const f = await fixture()
  if (existing) await f.source.access.ensureSubscription(f.plan)
  vi.spyOn(Date, 'now').mockReturnValue(f.plan.invitation.expiresAt)
  await f.run()
  expect(f.current().joint).toMatchObject({ state: 'ended', routePending: false })
  expect(f.current().receive).toBeUndefined()
  expect((await f.source.access.list()).subscriptions.find(value => value.id === f.plan.id)?.state).toBe(existing ? 'left' : undefined)
})

it.each(['new-joint', 'new-route'] as const)('does not overwrite %s selected while expired-plan lookup waits', async (change) => {
  const f = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(f.plan.invitation.expiresAt)
  const list = f.source.access.list.bind(f.source.access)
  vi.spyOn(f.source.access, 'list').mockImplementationOnce(async () => {
    await f.put(change === 'new-joint' ? { ...f.session, joint: { ...f.joint, id: randomUUID() as ScopeJoint['id'] } }
      : f.route(f.session))
    return list()
  })
  await f.run()
  expect(f.current().joint?.state).toBe('adopting')
})

it.each(['replacement', 'resumed'] as const)('does not clear a %s selection while an old subscription cleanup awaits', async (change) => {
  const f = await fixture()
  await f.source.access.ensureSubscription(f.plan)
  await f.put(advanceReadSelection(f.session))
  const leave = f.source.access.leave.bind(f.source.access)
  vi.spyOn(f.source.access, 'leave').mockImplementationOnce(async (request) => {
    await f.put(change === 'resumed' ? f.session : { ...advanceReadSelection(f.session),
      joint: { ...f.joint, id: randomUUID() as ScopeJoint['id'], intent: 'leave' as const, cleanupPending: true } })
    return leave(request)
  })
  await f.run()
  expect(f.current().joint?.state).toBe('adopting')
})

it.each(['capture-ended', 'new-capture', 'new-revision'] as const)(
  'does not adopt a subscription after %s while ensuring it', async (change) => {
    const f = await fixture()
    const held = await heldEnsure(f)
    await f.put(change === 'new-revision' ? { ...f.session, readRevision: 1 }
      : { ...f.session, contribution: { ...f.activeCapture, ...(change === 'capture-ended'
        ? { state: 'ending' as const } : { proposal: { ...f.capture.proposal,
          captureId: randomUUID() as ScopeContribution['proposal']['captureId'] } }) } })
    await held.finish()
    expect(f.current().receive).toBeUndefined()
    expect((await f.source.access.list()).subscriptions.find(value => value.id === f.plan.id)?.state).toBe('left')
  },
)

it('does not reopen a terminal subscription during delayed adoption', async () => {
  const f = await fixture()
  await f.source.access.ensureSubscription(f.plan)
  await f.source.access.leave({ subscriptionId: f.plan.id })
  await f.run()
  expect(f.current().joint?.state).toBe('ended')
  expect(f.current().receive).toBeUndefined()
})

it('checks permission expiry again after subscription creation returns', async () => {
  const f = await fixture()
  const held = await heldEnsure(f)
  vi.spyOn(Date, 'now').mockReturnValue(f.plan.invitation.expiresAt)
  await held.finish()
  expect(f.current().joint?.state).toBe('ended')
  expect(f.current().receive).toBeUndefined()
})

it('allows the newer route to finish the same immutable subscription after an older ensure returns', async () => {
  const f = await fixture()
  const held = await heldEnsure(f)
  await f.put(f.route(f.current()))
  await held.finish()
  expect((await f.source.access.list()).subscriptions.find(value => value.id === f.plan.id)?.state).toBe('active')
  await f.run()
  expect(f.current().joint).toMatchObject({ state: 'active', routePending: false })
  expect((await f.source.access.list()).subscriptions.find(value => value.id === f.plan.id)?.invitation.ownerAddress)
    .toBe(f.current().joint?.entry.ownerAddress)
})

it.each(['ended', 'aborted'] as const)('does not adopt after the source lifetime is %s', async (change) => {
  const f = await fixture()
  const controller = new AbortController()
  const ensure = f.source.access.ensureSubscription.bind(f.source.access)
  vi.spyOn(f.source.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
    const created = await ensure(plan)
    if (change === 'ended') await f.put({ ...f.session, ended: true })
    else controller.abort()
    return created
  })
  await f.run(controller.signal)
  expect(f.current().receive).toBeUndefined()
  const retained = (await f.source.access.list()).subscriptions.find(value => value.id === f.plan.id)
  expect(retained?.state).toBe(change === 'aborted' ? 'active' : 'left')
})

it('clears a cancelled durable plan that never created a subscription', async () => {
  const f = await fixture()
  await f.put(advanceReadSelection(f.session))
  const leave = vi.spyOn(f.source.access, 'leave')
  await f.run()
  expect(leave).not.toHaveBeenCalled()
  expect((await f.source.access.list()).subscriptions).toEqual([])
  expect(f.current().joint).toMatchObject({ state: 'superseded', intent: 'leave', cleanupPending: false })
  expect(jointNeedsWork(f.current())).toBe(false)
})
