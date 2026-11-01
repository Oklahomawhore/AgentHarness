/** Contribution management and wire failures preserve the original Task authority. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { peerContributionGrantSchema, peerContributionProposalSchema } from '@deepseek-ai/dsh-development-task/schema'
import { contributionResponseSchema } from '../src/contribution-schema.ts'
import type { Config } from '../src/index.ts'
import { cleanup, host, peer } from './helpers.ts'

const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await cleanup()
})
function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  releases.push(() => { released.resolve(undefined) })
  return { entered: entered.promise, release: () => { released.resolve(undefined) },
    wait: async () => { entered.resolve(undefined); await released.promise } }
}
const signal = (): AbortSignal => new AbortController().signal
async function fixture(overrides: Partial<Config> = {}, maxEventsPerTask = 32) {
  const a = await host('lifecycle-owner', undefined, overrides, [], peer('lifecycle-owner'), maxEventsPerTask)
  const b = await host('lifecycle-source')
  const task = await a.createTask()
  const request = { taskId: task.id, ownerAddress: (await a.access.identity()).addresses[0]!,
    proposal: peerContributionProposalSchema.parse({ contributorPeerId: peer('lifecycle-source'), captureId: randomUUID(),
      captureGeneration: randomUUID(), source: { name: 'orders', method: 'post', path: '/orders' } }),
    expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096 }
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: task.id, ownerPeerId: peer('lifecycle-owner'),
    ...request.proposal, grantId: randomUUID(), generation: randomUUID(), expiresAt: request.expiresAt,
    maxSamples: request.maxSamples, maxSampleBytes: request.maxSampleBytes })
  return { a, b, task, request, grant }
}

it('rejects invalid approval limits before committing Task authority', async () => {
  const { a, task, request } = await fixture()
  await expect(a.access.approveContribution({ ...request, maxSamples: 0 }))
    .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
})

it('reports Task event capacity without reserving a contribution', async () => {
  const { a, task, request } = await fixture({}, 2)
  await expect(a.access.approveContribution(request)).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
})

it('applies the complete response budget to an empty inventory', async () => {
  const { a, task } = await fixture({ maxResponseBytes: 1 })
  await expect(a.access.contributionInventory({ taskId: task.id })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
})

it('refuses Task authority issued for another transport owner', async () => {
  const { a, task, grant } = await fixture()
  const foreign = peerContributionGrantSchema.parse({ ...grant, ownerPeerId: 'foreign-owner' })
  await a.tasks.openPeerContribution(foreign)
  await expect(a.access.contributionInventory({ taskId: task.id })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  await expect(a.access.revokeContribution({ grant: foreign })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(a.tasks.peerContributions({ taskId: task.id })[0]?.state).toBe('active')
})

it.each(['owner', 'self', 'address', 'expired', 'lifetime', 'sample-budget'] as const)(
  'rejects an invitation with invalid %s permission before opening authority', async (field) => {
    const { a, task, request, grant } = await fixture()
    const changed = peerContributionGrantSchema.parse({ ...grant,
      ...(field === 'owner' ? { ownerPeerId: 'foreign-owner' } : {}),
      ...(field === 'self' ? { contributorPeerId: grant.ownerPeerId } : {}),
      ...(field === 'expired' ? { expiresAt: Date.now() - 1 } : {}),
      ...(field === 'lifetime' ? { expiresAt: Date.now() + 120_000 } : {}),
      ...(field === 'sample-budget' ? { maxSampleBytes: 16385 } : {}),
    })
    await expect(a.access.inviteContribution({ grant: changed,
      ownerAddress: field === 'address' ? '/ip4/127.0.0.1/tcp/2/p2p/lifecycle-owner' : request.ownerAddress }))
      .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
    expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
  },
)

it('recovers the caller-retained grant committed while an approval waits to open', async () => {
  const { a, task, request, grant } = await fixture()
  const held = barrier()
  const open = a.tasks.openPeerContribution.bind(a.tasks)
  vi.spyOn(a.tasks, 'openPeerContribution').mockImplementationOnce(async (candidate) => { await held.wait(); return await open(candidate) })
  const pending = a.access.approveContribution(request)
  await held.entered
  await open(grant)
  held.release()
  const approved = await pending
  expect(approved.invitation.grant).toEqual(grant)
  expect(a.tasks.peerContributions({ taskId: task.id })).toHaveLength(1)
})

it('retains an expiry refusal when no concurrent approval was committed', async () => {
  const { a, task, request } = await fixture()
  const held = barrier()
  const open = a.tasks.openPeerContribution.bind(a.tasks)
  vi.spyOn(a.tasks, 'openPeerContribution').mockImplementationOnce(async (candidate) => { await held.wait(); return await open(candidate) })
  const rejected = expect(a.access.approveContribution(request)).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  await held.entered
  vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt + 1)
  held.release()
  await rejected
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
})

it('reports the original grant ending while its approval waits to reopen it', async () => {
  const { a, task, request, grant } = await fixture()
  await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  const held = barrier()
  const open = a.tasks.openPeerContribution.bind(a.tasks)
  vi.spyOn(a.tasks, 'openPeerContribution').mockImplementationOnce(async (candidate) => { await held.wait(); return await open(candidate) })
  const rejected = expect(a.access.approveContribution(request)).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
  await held.entered
  await a.access.revokeContribution({ grant })
  held.release()
  await rejected
  expect(a.tasks.peerContributions({ taskId: task.id })[0]?.state).toBe('ended')
})

it('rejects a contribution invitation used by another local contributor', async () => {
  const { a, request, grant } = await fixture()
  const invitation = await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  const other = await host('lifecycle-other')
  await expect(other.access.contributionStatus({ invitation }, signal())).rejects.toThrow('names another contributor')
})

it('rejects an oversized inbound wire request before parsing or changing authority', async () => {
  const { a, b, task, request, grant } = await fixture()
  const invitation = await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  const revision = a.tasks.get({ taskId: task.id }).revision
  await expect(b.transport.request({ peerId: grant.ownerPeerId, address: request.ownerAddress }, '/agentharness/scope-contribute/1',
    { version: 1, requestId: randomUUID(), op: 'status', invitation, padding: 'x'.repeat(16384) }, signal()))
    .rejects.toThrow('request exceeds budget')
  expect(a.tasks.get({ taskId: task.id }).revision).toBe(revision)
})

it('rejects a valid wire reply for a different operation', async () => {
  const { a, b, request, grant } = await fixture()
  const invitation = await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  b.transport.transform = raw => ({ ...contributionResponseSchema.parse(raw), op: 'end', result: { status: 'capacity' } })
  await expect(b.access.contributionStatus({ invitation }, signal())).rejects.toThrow('does not match its request')
})

it('propagates an unexpected Task authority failure instead of treating it as permission denial', async () => {
  const { a, b, request, grant } = await fixture()
  const invitation = await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  vi.spyOn(a.tasks, 'peerContributions').mockImplementationOnce(() => { throw new Error('fixture Task provider failed') })
  await expect(b.access.contributionStatus({ invitation }, signal())).rejects.toThrow('fixture Task provider failed')
})

it('preserves caller cancellation after the owner produced an active reply', async () => {
  const { a, b, request, grant } = await fixture()
  const invitation = await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  const held = barrier()
  b.transport.transform = async (raw) => { await held.wait(); return raw }
  const controller = new AbortController()
  const reason = new Error('contribution consumer stopped')
  const rejected = expect(b.access.contributionStatus({ invitation }, controller.signal)).rejects.toBe(reason)
  await held.entered
  controller.abort(reason)
  held.release()
  await rejected
  b.transport.transform = undefined
  await expect(b.access.contributionStatus({ invitation }, signal())).resolves.toMatchObject({ status: 'active' })
})

it('refuses an inbound status request while an earlier request occupies its contribution slot', async () => {
  const { a, b, request, grant } = await fixture({ maxConcurrentContributions: 1 })
  const invitation = await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  const held = barrier()
  const expire = a.tasks.expirePeerContributions.bind(a.tasks)
  vi.spyOn(a.tasks, 'expirePeerContributions').mockImplementationOnce(async (input) => { await held.wait(); await expire(input) })
  const pending = b.access.contributionStatus({ invitation }, signal())
  await held.entered
  const raw = await b.transport.request({ peerId: grant.ownerPeerId, address: request.ownerAddress }, '/agentharness/scope-contribute/1',
    { version: 1, requestId: randomUUID(), op: 'status', invitation }, signal())
  expect(contributionResponseSchema.parse(raw).result).toEqual({ status: 'capacity' })
  held.release()
  await expect(pending).resolves.toMatchObject({ status: 'active' })
  await expect(b.access.contributionStatus({ invitation }, signal())).resolves.toMatchObject({ status: 'active' })
})

it('drains a failed expiry commit during disposal without scheduling another attempt', async () => {
  vi.useFakeTimers()
  const { a, request, grant } = await fixture()
  await a.access.inviteContribution({ grant, ownerAddress: request.ownerAddress })
  const held = barrier()
  const failed = vi.fn()
  a.ctx.on('development-task/persist', async (event) => {
    if (event.change.kind !== 'peer-contribution-ended') return
    failed()
    await held.wait()
    throw new Error('fixture expiry storage failed')
  })
  await vi.advanceTimersByTimeAsync(50_001)
  await held.entered
  const disposed = a.ctx.fiber.dispose()
  held.release()
  await disposed
  await vi.advanceTimersByTimeAsync(60_000)
  expect(failed).toHaveBeenCalledOnce()
  expect(a.exit).not.toHaveBeenCalled()
})
