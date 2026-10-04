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
  return { owner, source, task, store, controller, run, current, approve, sample, outbox, cleared,
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
