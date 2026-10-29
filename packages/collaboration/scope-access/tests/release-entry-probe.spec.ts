import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { applicationRecordSchema, groupRecordSchema } from '../src/application-schema.ts'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { cleanup, host, peer } from './helpers.ts'

const ownerPeer = peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy')
afterEach(cleanup)

async function fixture() {
  const owner = await host('release-probe-owner', undefined, {}, [], ownerPeer)
  const source = await host('release-probe-source')
  const task = await owner.createTask('Private shared work')
  const identity = await owner.access.identity()
  const ownerAddress = identity.addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address is missing')
  const { entry } = await owner.access.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000 })
  await source.access.identity()
  return { owner, source, entry }
}

it.each([
  ['scope-transport/capacity', 'capacity'],
  ['scope-transport/request-too-large', 'capacity'],
  ['scope-transport/response-too-large', 'capacity'],
  ['scope-transport/invalid-target', 'denied'],
  ['scope-transport/identity-invalid', 'denied'],
] as const)('keeps %s probes read-only and releases their request slot', async (code, status) => {
  const { owner, source, entry } = await fixture()
  const before = structuredClone([owner.pool.media, source.pool.media])
  const sends = vi.spyOn(source.transport, 'request')
  for (let attempt = 0; attempt < 4; attempt++) {
    sends.mockRejectedValueOnce(new ScopeTransportError(code))
    expect(await source.access.probeContributionEntry({ entry })).toEqual({ status })
  }
  expect(await source.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
  expect([owner.pool.media, source.pool.media]).toEqual(before)
})

it('propagates unexpected provider errors and still admits a later probe', async () => {
  const { owner, source, entry } = await fixture()
  const before = structuredClone([owner.pool.media, source.pool.media])
  const failure = new Error('Provider implementation failed')
  const sends = vi.spyOn(source.transport, 'request')
  for (let attempt = 0; attempt < 4; attempt++) {
    sends.mockRejectedValueOnce(failure)
    await expect(source.access.probeContributionEntry({ entry })).rejects.toBe(failure)
  }
  expect(await source.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
  expect([owner.pool.media, source.pool.media]).toEqual(before)
})

it('keeps a durably expired application expired after a wall-clock rollback without further writes', async () => {
  const { owner, source, entry } = await fixture()
  const proposal = contributionProposalSchema.parse({ contributorPeerId: source.transport.peerId, captureId: randomUUID(),
    captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const request = { entry, proposal, limits: { expiresAt: entry.expiresAt + 20_000, maxSamples: 4, maxSampleBytes: 2048 } }
  const signal = new AbortController().signal
  expect(await source.access.applyContribution(request, signal)).toEqual({ status: 'pending' })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(entry.expiresAt)
  try {
    expect(await source.access.contributionApplicationStatus(request, signal)).toEqual({ status: 'expired' })
    const record = applicationRecordSchema.parse(owner.pool.media.get('scope_access')?.tables.get('applications')?.get(entry.entryId))
    expect(record.decision).toBe('expired')
    const before = structuredClone([owner.pool.media, source.pool.media])
    const writes = vi.spyOn(owner.pool, 'consumeInjectedFailure')
    clock.mockReturnValue(entry.expiresAt - 1)
    expect(await source.access.probeContributionEntry({ entry })).toEqual({ status: 'expired' })
    expect([owner.pool.media, source.pool.media]).toEqual(before)
    expect(writes).not.toHaveBeenCalled()
  } finally { clock.mockRestore() }
})

it.each(['live', 'restored'] as const)('observes expired source consent on a %s pending single entry without persisting its decision', async (lifecycle) => {
  const { owner, source, entry } = await fixture()
  const observer = await host('release-probe-observer')
  await observer.access.identity()
  const proposal = contributionProposalSchema.parse({ contributorPeerId: source.transport.peerId, captureId: randomUUID(),
    captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const expiresAt = entry.expiresAt - 10_000
  const request = { entry, proposal, limits: { expiresAt, maxSamples: 4, maxSampleBytes: 2048 } }
  expect(await source.access.applyContribution(request, new AbortController().signal)).toEqual({ status: 'pending' })
  await source.ctx.fiber.dispose()
  let current = owner
  if (lifecycle === 'restored') {
    const events = owner.tasks.log()
    await owner.ctx.fiber.dispose()
    current = await host('release-probe-owner', owner.pool, {}, events, ownerPeer)
    await current.access.identity()
  }
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
  try {
    const before = structuredClone([current.pool.media, observer.pool.media])
    const writes = vi.spyOn(current.pool, 'consumeInjectedFailure')
    expect(await observer.access.probeContributionEntry({ entry })).toEqual({ status: 'expired' })
    expect(applicationRecordSchema.parse(current.pool.media.get('scope_access')?.tables.get('applications')?.get(entry.entryId)).decision).toBe('pending')
    expect([current.pool.media, observer.pool.media]).toEqual(before)
    expect(writes).not.toHaveBeenCalled()
  } finally { clock.mockRestore() }
})

it('keeps a reusable entry available for another member after one pending source consent expires', async () => {
  const { owner, source, entry: single } = await fixture()
  const observer = await host('release-probe-observer')
  await observer.access.identity()
  const { entry } = await owner.access.createGroupEntry({ taskId: single.taskId, ownerAddress: single.ownerAddress,
    expiresAt: single.expiresAt, maxMembers: 2 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: source.transport.peerId, captureId: randomUUID(),
    captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const expiresAt = entry.expiresAt - 10_000
  const limits = { expiresAt, maxSamples: 4, maxSampleBytes: 2048 }
  const signal = new AbortController().signal
  expect(await source.access.applyContribution({ entry, proposal, limits }, signal)).toEqual({ status: 'pending' })
  await source.ctx.fiber.dispose()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
  try {
    const before = structuredClone([owner.pool.media, observer.pool.media])
    const writes = vi.spyOn(owner.pool, 'consumeInjectedFailure')
    expect(await observer.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
    expect([owner.pool.media, observer.pool.media]).toEqual(before)
    expect(writes).not.toHaveBeenCalled()
    const other = contributionProposalSchema.parse({ ...proposal, contributorPeerId: observer.transport.peerId, captureId: randomUUID() })
    expect(await observer.access.applyContribution({ entry, proposal: other,
      limits: { ...limits, expiresAt: entry.expiresAt } }, signal)).toEqual({ status: 'pending' })
    const record = groupRecordSchema.parse(owner.pool.media.get('scope_group_applications')?.tables.get('entries')?.get(entry.entryId))
    expect(record.members).toHaveLength(2)
    expect(record.members[0]?.decision).toBe('pending')
    expect(await observer.access.probeContributionEntry({ entry })).toEqual({ status: 'capacity' })
  } finally { clock.mockRestore() }
})
