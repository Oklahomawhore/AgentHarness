import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { peerContributionProposalSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { ContributionController, contributionRecordSchema } from '../src/contribution-client.ts'
import { contributionResponseSchema } from '../src/contribution-schema.ts'
import type { ContributionRecord, ContributionStore, ContributionOutboxItem, ContributionRun } from '../src/contribution-client.ts'
import type { ScopeContributionSample } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
interface LocalCapture extends ContributionRecord { readonly rootLabels: readonly string[] }

async function source() {
  const owner = await host('controller-owner')
  const source = await host('controller-source')
  const task = await owner.createTask()
  const [address] = (await owner.access.identity()).addresses
  if (address === undefined) throw new Error('owner address is missing')
  const { entry } = await owner.access.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress: address, expiresAt: Date.now() + 20_000 })
  const proposal = peerContributionProposalSchema.parse({ contributorPeerId: peer('controller-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } })
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096 }
  let capture: LocalCapture | undefined = { proposal, state: 'prepared', sequence: 0, rootLabels: ['private-local-root'],
    application: { entry, limits, state: 'applying' } }
  let ended = false
  let localOperation = false
  const outbox = new Map<string, ContributionOutboxItem>()
  const cleared: LocalCapture[] = []
  const store: ContributionStore<LocalCapture> = {
    current: () => ({ capture, ended }),
    save: (value) => { capture = value; return Promise.resolve() },
    clear: (value) => { cleared.push(value); capture = undefined; outbox.clear(); return Promise.resolve() },
    outbox: () => [...outbox.values()],
    validateOutbox: (item, selected) => {
      if (item.sample !== undefined && item.sample.sequence > selected.sequence) throw new Error('sample exceeds allocated sequence')
    },
    saveReceipt: (item, receipt) => { outbox.set(item.id, { ...item, receipt }); return Promise.resolve() },
    requireCompatible: () => {},
    error: (code, message) => Object.assign(new Error(message), { code }),
  }
  const run: ContributionRun<LocalCapture> = async (operation) => {
    expect(localOperation).toBe(false)
    localOperation = true
    try { return await operation(store) } finally { localOperation = false }
  }
  const controller = new ContributionController<LocalCapture>(() => source.access)
  const current = () => { if (capture === undefined) throw new Error('capture is absent'); return capture }
  const approve = () => owner.access.approveContributionApplication({ entryId: entry.entryId,
    expectedProposal: proposal, limits, ownerAddress: address })
  const sample: ScopeContributionSample = {
    sourceId: createHash('sha256').update('controller-original-observation').digest('hex') as DevelopmentTaskObservedSourceId,
    sequence: 1, result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'notes.txt', content: 'Use the corrected route' }, omissions: [] },
  }
  return { owner, source, task, entry, limits, store, controller, run, current, approve, sample, outbox, cleared,
    inLocalOperation: () => localOperation, endSession: () => { ended = true } }
}

it('shares application and exact sample recovery without persisting adapter-local fields at the owner', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  expect(value.current().application?.state).toBe('waiting')
  await value.approve()
  await value.controller.pollApplication(value.run, signal())
  expect(value.current()).toMatchObject({ state: 'active', rootLabels: ['private-local-root'] })
  expect(value.current().application).toBeUndefined()
  await value.store.save({ ...value.current(), sequence: 1 })
  value.outbox.set('original-lease', { id: 'original-lease', sample: value.sample })
  const original = value.source.access.contribute.bind(value.source.access)
  const requests = vi.spyOn(value.source.access, 'contribute').mockImplementation((request, sourceSignal) => {
    expect(value.inLocalOperation()).toBe(false)
    return original(request, sourceSignal)
  })
  value.source.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  expect(await value.controller.pollRecovery(value.run, signal())).toBe(false)
  const committed = value.owner.tasks.get({ taskId: value.task.id })
  expect(committed.context).toHaveLength(1)
  expect(JSON.stringify(committed)).not.toContain('private-local-root')
  expect(value.current().issue).toBe('owner-unavailable')
  expect(value.outbox.get('original-lease')?.receipt).toBeUndefined()
  value.source.transport.transform = undefined
  const restoredController = new ContributionController<LocalCapture>(() => value.source.access)
  expect(await restoredController.pollRecovery(value.run, signal())).toBe(true)
  expect(value.owner.tasks.get({ taskId: value.task.id }).revision).toBe(committed.revision)
  expect(value.outbox.get('original-lease')?.receipt?.sourceId).toBe(value.sample.sourceId)
  expect(requests.mock.calls.map(([request]) => request.sample)).toEqual([value.sample, value.sample])
  expect(value.current()).toMatchObject({ rootLabels: ['private-local-root'], sequence: 1 })
  expect(value.current().issue).toBeUndefined()
  expect(restoredController.needsWork(value.store)).toBe(false)
  await restoredController.markEnding(value.store)
  expect(value.current().state).toBe('ending')
  await restoredController.pollRecovery(value.run, signal())
  expect(value.store.current().capture).toBeUndefined()
  expect(value.cleared[0]?.endReceipt?.event.kind).toBe('peer-contribution-ended')
  expect(value.cleared[0]?.rootLabels).toEqual(['private-local-root'])
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
})

it('cancels a retained source application without opening a Task grant', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  value.endSession()
  await value.controller.markEnding(value.store)
  expect(value.current().application?.state).toBe('cancelling')
  await value.controller.pollApplication(value.run, signal())
  expect(value.store.current().capture).toBeUndefined()
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })).toEqual([])
  await expect(value.approve()).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
})

it('keeps common durable state strict while allowing an adapter to add its local fields', async () => {
  const value = await source()
  const extended = contributionRecordSchema.safeExtend({ rootLabels: z.array(z.string()) })
  expect(extended.parse(value.current()).rootLabels).toEqual(['private-local-root'])
  expect(contributionRecordSchema.safeParse(value.current()).success).toBe(false)
  expect(extended.safeParse({ ...value.current(), state: 'active' }).success).toBe(false)
  expect(extended.safeParse({ ...value.current(), state: 'ending' }).success).toBe(false)
  expect(extended.safeParse({ ...value.current(), sequence: -1 }).success).toBe(false)
})


it('requires a group receiving-consent adopter before activating an approved contribution', async () => {
  const value = await source()
  const retained = value.current()
  const application = retained.application
  if (application === undefined) throw new Error('Missing source application')
  const entry = (await value.owner.access.createGroupEntry({ taskId: value.task.id,
    ownerAddress: application.entry.ownerAddress, expiresAt: application.entry.expiresAt, maxMembers: 2 })).entry
  await value.store.save({ ...retained, application: { ...application, entry } })
  await value.controller.pollApplication(value.run, signal())
  const member = (await value.owner.access.groupApplications({ entryId: entry.entryId })).entries[0]
  if (member === undefined) throw new Error('Group application was not retained')
  await value.owner.access.approveContributionApplication({ entryId: entry.entryId, applicationId: member.applicationId,
    expectedProposal: member.proposal, limits: application.limits, ownerAddress: entry.ownerAddress, read: { responsibility: 'Frontend' } })
  await expect(value.controller.pollApplication(value.run, signal())).rejects.toMatchObject({ code: 'invitation-mismatch' })
  expect(value.current().state).toBe('prepared')
  expect(value.current().invitation).toBeUndefined()
  expect(value.current().application?.state).toBe('waiting')
  const selectApproval = vi.fn<NonNullable<ContributionStore<LocalCapture>['selectApproval']>>(async (capture, result) => {
    expect(capture.application?.entry).toEqual(entry)
    expect(result).toMatchObject({ status: 'approved', readInvitation: { recipientPeerId: retained.proposal.contributorPeerId },
      readState: 'active' })
    return capture
  })
  const supported: ContributionRun<LocalCapture> = async operation => operation({ ...value.store, selectApproval })
  await value.controller.pollApplication(supported, signal())
  expect(selectApproval).toHaveBeenCalledTimes(1)
  expect(value.current().state).toBe('active')
})

async function replacementCapture(value: Awaited<ReturnType<typeof source>>, active: boolean) {
  const original = value.current()
  const task = await value.owner.createTask('Replacement capture')
  const { entry } = await value.owner.access.createContributionEntry({ sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress: value.entry.ownerAddress, expiresAt: value.entry.expiresAt })
  const proposal = peerContributionProposalSchema.parse({ ...original.proposal, captureGeneration: randomUUID() })
  const capture: LocalCapture = { proposal, state: 'prepared', sequence: 0, rootLabels: ['replacement-local-root'],
    application: { entry, limits: value.limits, state: 'applying' } }
  if (!active) return { capture, task }
  expect(await value.source.access.applyContribution({ entry, proposal, limits: value.limits }, signal()))
    .toEqual({ status: 'pending' })
  const approval = await value.owner.access.approveContributionApplication({ entryId: entry.entryId,
    expectedProposal: proposal, limits: value.limits, ownerAddress: entry.ownerAddress })
  const selected: LocalCapture = { proposal, state: 'active', sequence: 1, invitation: approval.invitation,
    rootLabels: capture.rootLabels }
  return { capture: selected, task }
}

async function activeSource() {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  const approval = await value.approve()
  await value.controller.pollApplication(value.run, signal())
  expect(value.current().state).toBe('active')
  return { ...value, invitation: approval.invitation }
}

async function ownerDecidedSource(status: 'rejected' | 'expired') {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  if (status === 'rejected') await value.owner.access.rejectContributionApplication({ entryId: value.entry.entryId,
    expectedProposal: value.current().proposal })
  else {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(value.entry.expiresAt + 1)
  }
  return value
}

async function withOwnerReply<T>(value: Awaited<ReturnType<typeof source>>,
  operation: (signal: AbortSignal) => Promise<T>, change: () => Promise<void>, reply = 1): Promise<T> {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  const original = value.source.transport.transform
  let replies = 0
  value.source.transport.transform = async (response) => {
    if (++replies === reply) {
      entered.resolve(undefined)
      await release.promise
    }
    return original === undefined ? response : await original(response)
  }
  const pending = operation(lifetime.signal)
  const settled = pending.then(() => undefined, () => undefined)
  try {
    await Promise.race([entered.promise, settled.then(() => { throw new Error('Operation settled before the reply barrier') })])
    expect(value.source.transport.outbound).toBe(1)
    expect(value.owner.transport.inbound).toBe(1)
    expect(value.inLocalOperation()).toBe(false)
    await change()
    release.resolve(undefined)
    return await pending
  } finally {
    release.resolve(undefined)
    lifetime.abort()
    await settled
    value.source.transport.transform = original
    expect(value.source.transport.outbound).toBe(0)
    expect(value.owner.transport.inbound).toBe(0)
  }
}

it.each(['application', 'activation'] as const)('rejects an old %s reply after the capture generation changes', async (phase) => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  await value.approve()
  const replacement = await replacementCapture(value, false)
  await expect(withOwnerReply(value, signal => value.controller.pollApplication(value.run, signal),
    () => value.run(store => store.save(replacement.capture)), phase === 'application' ? 1 : 2))
    .rejects.toMatchObject({ code: 'stale-capture' })
  expect(value.current()).toEqual(replacement.capture)
  expect(value.current().invitation).toBeUndefined()
  expect(value.cleared).toEqual([])
  expect(value.outbox.size).toBe(0)
  expect(value.owner.tasks.peerContributions({ taskId: replacement.task.id })).toEqual([])
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('active')
})

it('does not attach an old sample receipt after the capture generation changes', async () => {
  const value = await activeSource()
  await value.store.save({ ...value.current(), sequence: 1 })
  const oldCapture = value.current()
  const oldItem = { id: 'original-lease', sample: value.sample }
  value.outbox.set(oldItem.id, oldItem)
  const replacement = await replacementCapture(value, true)
  let revision: number | undefined
  const result = await withOwnerReply(value, signal => value.controller.pollRecovery(value.run, signal), async () => {
    const committed = value.owner.tasks.get({ taskId: value.task.id })
    revision = committed.revision
    expect(committed.context).toHaveLength(1)
    expect(value.outbox.get(oldItem.id)?.receipt).toBeUndefined()
    expect(replacement.capture.proposal.captureId).toBe(oldCapture.proposal.captureId)
    expect(replacement.capture.proposal.captureGeneration).not.toBe(oldCapture.proposal.captureGeneration)
    await value.run(store => store.save(replacement.capture))
  })
  expect(result).toBe(false)
  expect(value.current()).toEqual(replacement.capture)
  expect(value.outbox.get(oldItem.id)).toEqual(oldItem)
  expect(value.outbox.size).toBe(1)
  expect(value.cleared).toEqual([])
  expect(value.owner.tasks.get({ taskId: value.task.id }).revision).toBe(revision)
  expect(value.owner.tasks.get({ taskId: replacement.task.id }).context).toEqual([])
})

it('keeps a concurrent successful activation when an older application reply arrives', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  await value.approve()
  await withOwnerReply(value, signal => value.controller.pollApplication(value.run, signal), async () => {
    await value.controller.pollApplication(value.run, signal())
    expect(value.current().state).toBe('active')
  })
  expect(value.current().state).toBe('active')
  expect(value.current().application).toBeUndefined()
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })).toHaveLength(1)
})

it('does not restore a pending application after local cancellation starts', async () => {
  const value = await source()
  await withOwnerReply(value, signal => value.controller.pollApplication(value.run, signal),
    () => value.run(store => value.controller.markEnding(store)))
  expect(value.current()).toMatchObject({ state: 'ending', application: { state: 'cancelling' } })
  await value.controller.pollApplication(value.run, signal())
  expect(value.store.current().capture).toBeUndefined()
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })).toEqual([])
})

it('rejects activation when local collection stops during online grant verification', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  await value.approve()
  await expect(withOwnerReply(value, signal => value.controller.pollApplication(value.run, signal),
    () => value.run(store => value.controller.markEnding(store)), 2)).rejects.toMatchObject({ code: 'grant-ended' })
  expect(value.current().state).toBe('ending')
  await value.controller.pollApplication(value.run, signal())
  expect(value.store.current().capture).toBeUndefined()
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
})

it('retains a late approval only for cancellation when its source session has ended', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  await value.approve()
  await withOwnerReply(value, signal => value.controller.pollApplication(value.run, signal), async () => { value.endSession() })
  expect(value.current()).toMatchObject({ state: 'prepared', application: { state: 'waiting' } })
  expect(value.current().invitation).toBeUndefined()
  await value.controller.markEnding(value.store)
  await value.controller.pollApplication(value.run, signal())
  expect(value.store.current().capture).toBeUndefined()
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
})

it('rejects a retained source grant under a replacement transport identity', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  const approval = await value.approve()
  const replacement = await host('replacement-source-identity')
  const controller = new ContributionController<LocalCapture>(() => replacement.access)
  const original = value.current()
  await expect(controller.selectActivation(value.store, approval.invitation, signal()))
    .rejects.toMatchObject({ code: 'invitation-mismatch' })
  expect(value.current()).toEqual(original)
  expect(value.current().invitation).toBeUndefined()
  expect(replacement.transport.outbound).toBe(0)
})

it('does not replace a selected grant with a second legitimate Task grant', async () => {
  const value = await activeSource()
  const task = await value.owner.createTask('Another independently authorized task')
  const other = await value.owner.access.approveContribution({ taskId: task.id, proposal: value.current().proposal,
    ownerAddress: value.invitation.ownerAddress, ...value.limits })
  expect(() => value.controller.selectInvitation(value.store, value.current(), other.invitation))
    .toThrow('An existing contribution grant cannot be replaced')
  expect(value.current().invitation).toEqual(value.invitation)
  expect(value.current().state).toBe('active')
})

it('rejects an invitation with unusable sample limits before retaining it', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  const approval = await value.approve()
  const original = value.current()
  await expect(value.controller.selectActivation(value.store,
    { ...approval.invitation, grant: { ...approval.invitation.grant, maxSamples: 0 } }, signal()))
    .rejects.toMatchObject({ code: 'invitation-mismatch' })
  expect(value.current()).toEqual(original)
  expect(value.current().invitation).toBeUndefined()
})

it('cancels an expired local application before asking for approval', async () => {
  const value = await source()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(value.limits.expiresAt + 1)
  const apply = vi.spyOn(value.source.access, 'applyContribution')
  const cancel = vi.spyOn(value.source.access, 'cancelContributionApplication')
  await value.controller.pollApplication(value.run, signal())
  expect(apply).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
  expect(value.store.current().capture).toBeUndefined()
  expect(value.cleared[0]?.application?.state).toBe('cancelling')
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })).toEqual([])
})

it.each(['rejected', 'expired'] as const)('retains owner %s decisions without polling or activating them again', async (status) => {
  const value = await ownerDecidedSource(status)
  await value.controller.pollApplication(value.run, signal())
  expect(value.current()).toMatchObject({ state: 'prepared', application: { state: status }, issue: 'rejected' })
  expect(value.current().invitation).toBeUndefined()
  expect(value.controller.needsWork(value.store)).toBe(false)
  const retained = value.current()
  const request = vi.spyOn(value.source.transport, 'request')
  await value.controller.pollApplication(value.run, signal())
  expect(request).not.toHaveBeenCalled()
  expect(value.current()).toBe(retained)
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })).toEqual([])
})

it.each(['rejected', 'expired'] as const)('clears locally cancelling work after an owner %s reply', async (status) => {
  const value = await ownerDecidedSource(status)
  await withOwnerReply(value, signal => value.controller.pollApplication(value.run, signal),
    () => value.run(store => value.controller.markEnding(store)))
  expect(value.store.current().capture).toBeUndefined()
  expect(value.cleared).toHaveLength(1)
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })).toEqual([])
})

it.each(['deleted', 'replaced'] as const)('does not acknowledge an outbox item %s while its owner reply waits', async (change) => {
  const value = await activeSource()
  await value.store.save({ ...value.current(), sequence: 1 })
  value.outbox.set('original-lease', { id: 'original-lease', sample: value.sample })
  const result = await withOwnerReply(value, signal => value.controller.pollRecovery(value.run, signal), async () => {
    expect(value.owner.tasks.get({ taskId: value.task.id }).context).toHaveLength(1)
    if (change === 'deleted') value.outbox.delete('original-lease')
    else {
      await value.run(store => store.save({ ...value.current(), sequence: 2 }))
      value.outbox.set('original-lease', { id: 'original-lease', sample: { ...value.sample, sequence: 2 } })
    }
  })
  expect(result).toBe(false)
  expect(value.outbox.get('original-lease')?.receipt).toBeUndefined()
  expect(value.outbox.size).toBe(change === 'deleted' ? 0 : 1)
  expect(value.current().state).toBe('active')
  expect(value.owner.tasks.get({ taskId: value.task.id }).context).toHaveLength(1)
})

it('does not clear a replacement capture when an older withdrawal receipt arrives', async () => {
  const value = await activeSource()
  await value.controller.markEnding(value.store)
  const replacement = await replacementCapture(value, false)
  const result = await withOwnerReply(value, signal => value.controller.pollRecovery(value.run, signal),
    () => value.run(store => store.save(replacement.capture)))
  expect(result).toBe(false)
  expect(value.current()).toEqual(replacement.capture)
  expect(value.cleared).toEqual([])
  expect(value.owner.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
})

it('finishes local removal from its durable terminal receipt after a failed clear', async () => {
  const value = await activeSource()
  await value.controller.markEnding(value.store)
  const clear = vi.spyOn(value.store, 'clear').mockRejectedValueOnce(new Error('local removal failed'))
  const end = vi.spyOn(value.source.access, 'endContribution')
  await expect(value.controller.pollRecovery(value.run, signal())).rejects.toThrow('local removal failed')
  expect(value.current()).toMatchObject({ state: 'ending', endReceipt: { event: { kind: 'peer-contribution-ended' } } })
  const restored = new ContributionController<LocalCapture>(() => value.source.access)
  expect(await restored.pollRecovery(value.run, signal())).toBe(false)
  expect(value.store.current().capture).toBeUndefined()
  expect(clear).toHaveBeenCalledTimes(2)
  expect(end).toHaveBeenCalledOnce()
  expect(value.cleared[0]?.rootLabels).toEqual(['private-local-root'])
})

it.each(['capacity', 'different receipt'] as const)('preserves a confirmed receipt when an older concurrent reply reports %s', async (failure) => {
  const value = await activeSource()
  await value.store.save({ ...value.current(), sequence: 1 })
  value.outbox.set('original-lease', { id: 'original-lease', sample: value.sample })
  let replies = 0
  let confirmed: ContributionOutboxItem['receipt']
  value.source.transport.transform = (input) => {
    const response = contributionResponseSchema.parse(input)
    if (++replies === 1) return response
    if (response.op !== 'sample' || (response.result.status !== 'accepted' && response.result.status !== 'reused')) {
      throw new Error('Expected the delayed original sample receipt')
    }
    return { ...response, result: failure === 'capacity' ? { status: 'capacity' }
      : { ...response.result, receipt: { ...response.result.receipt, revision: response.result.receipt.revision + 1 } } }
  }
  try {
    const pending = withOwnerReply(value, signal => value.controller.pollRecovery(value.run, signal), async () => {
      expect(await value.controller.pollRecovery(value.run, signal())).toBe(true)
      confirmed = value.outbox.get('original-lease')?.receipt
      expect(confirmed).toBeDefined()
    })
    if (failure === 'capacity') expect(await pending).toBe(true)
    else await expect(pending).rejects.toThrow('exact retry returned a different receipt')
    expect(replies).toBe(2)
    expect(value.outbox.get('original-lease')?.receipt).toEqual(confirmed)
    expect(value.current().issue).toBeUndefined()
    expect(value.current().state).toBe('active')
    expect(value.owner.tasks.get({ taskId: value.task.id }).context).toHaveLength(1)
  } finally { value.source.transport.transform = undefined }
})
