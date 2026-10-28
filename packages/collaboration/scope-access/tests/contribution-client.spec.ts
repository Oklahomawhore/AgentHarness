import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { peerContributionProposalSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { ContributionController, contributionRecordSchema } from '../src/contribution-client.ts'
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

it.each(['application', 'activation'] as const)('rejects an old %s reply after the capture generation changes', async (phase) => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  await value.approve()
  const replacement = await replacementCapture(value, false)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  let replies = 0
  value.source.transport.transform = async (response) => {
    replies++
    if (replies === (phase === 'application' ? 1 : 2)) {
      entered.resolve(undefined)
      await release.promise
    }
    return response
  }
  const pending = value.controller.pollApplication(value.run, lifetime.signal).then(
    () => ({ state: 'fulfilled' as const }),
    (error: unknown) => ({ state: 'rejected' as const, error }),
  )
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Application settled before the reply barrier') })])
    expect(value.source.transport.outbound).toBe(1)
    expect(value.owner.transport.inbound).toBe(1)
    expect(value.inLocalOperation()).toBe(false)
    await value.run(store => store.save(replacement.capture))
    release.resolve(undefined)
    expect(await pending).toMatchObject({ state: 'rejected', error: { code: 'stale-capture' } })
    expect(value.current()).toEqual(replacement.capture)
    expect(value.current().invitation).toBeUndefined()
    expect(value.cleared).toEqual([])
    expect(value.outbox.size).toBe(0)
    expect(value.owner.tasks.peerContributions({ taskId: replacement.task.id })).toEqual([])
    expect(value.owner.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('active')
  } finally {
    release.resolve(undefined)
    lifetime.abort()
    await pending
    value.source.transport.transform = undefined
  }
  expect(value.source.transport.outbound).toBe(0)
  expect(value.owner.transport.inbound).toBe(0)
})

it('does not attach an old sample receipt after the capture generation changes', async () => {
  const value = await source()
  await value.controller.pollApplication(value.run, signal())
  await value.approve()
  await value.controller.pollApplication(value.run, signal())
  await value.store.save({ ...value.current(), sequence: 1 })
  const oldCapture = value.current()
  const oldItem = { id: 'original-lease', sample: value.sample }
  value.outbox.set(oldItem.id, oldItem)
  const replacement = await replacementCapture(value, true)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  value.source.transport.transform = async (response) => {
    entered.resolve(undefined)
    await release.promise
    return response
  }
  const pending = value.controller.pollRecovery(value.run, lifetime.signal).then(
    result => ({ state: 'fulfilled' as const, result }),
    (error: unknown) => ({ state: 'rejected' as const, error }),
  )
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Recovery settled before the reply barrier') })])
    expect(value.source.transport.outbound).toBe(1)
    expect(value.owner.transport.inbound).toBe(1)
    expect(value.inLocalOperation()).toBe(false)
    const committed = value.owner.tasks.get({ taskId: value.task.id })
    expect(committed.context).toHaveLength(1)
    expect(value.outbox.get(oldItem.id)?.receipt).toBeUndefined()
    expect(replacement.capture.proposal.captureId).toBe(oldCapture.proposal.captureId)
    expect(replacement.capture.proposal.captureGeneration).not.toBe(oldCapture.proposal.captureGeneration)
    await value.run(store => store.save(replacement.capture))
    release.resolve(undefined)
    expect(await pending).toEqual({ state: 'fulfilled', result: false })
    expect(value.current()).toEqual(replacement.capture)
    expect(value.outbox.get(oldItem.id)).toEqual(oldItem)
    expect(value.outbox.size).toBe(1)
    expect(value.cleared).toEqual([])
    expect(value.owner.tasks.get({ taskId: value.task.id }).revision).toBe(committed.revision)
    expect(value.owner.tasks.get({ taskId: replacement.task.id }).context).toEqual([])
  } finally {
    release.resolve(undefined)
    lifetime.abort()
    await pending
    value.source.transport.transform = undefined
  }
  expect(value.source.transport.outbound).toBe(0)
  expect(value.owner.transport.inbound).toBe(0)
})
