import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { peerContributionGrantSchema, peerContributionProposalSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeContributionApproveRequest } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)

async function owner() {
  const a = await host('owner-management-a')
  const task = await a.createTask()
  const request: ScopeContributionApproveRequest = {
    taskId: task.id, ownerAddress: (await a.access.identity()).addresses[0]!,
    proposal: peerContributionProposalSchema.parse({ contributorPeerId: peer('owner-management-b'), captureId: randomUUID(), captureGeneration: randomUUID(),
      source: { name: 'orders', method: 'post', path: '/orders' } }),
    expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096,
  }
  return { ...a, task, request }
}

it('commits one immutable grant for concurrent identical owner approvals', async () => {
  const a = await owner()
  const [first, second] = await Promise.all([
    a.access.approveContribution(a.request), a.access.approveContribution(a.request),
  ])
  expect(second).toEqual(first)
  expect(a.tasks.log().filter(event => event.change.kind === 'peer-contribution-opened')).toHaveLength(1)
  const inventory = await a.access.contributionInventory({ taskId: a.task.id })
  expect(inventory.entries).toHaveLength(1)
  expect(inventory.entries[0]).toMatchObject({ state: 'active', grant: first.invitation.grant })
  expect(await a.access.previewContributionText({ text: first.text })).toEqual(first.invitation)
})

it.each(['maxSamples', 'maxSampleBytes', 'expiresAt', 'source'] as const)(
  'rejects changed approval %s without another grant and never reopens a terminal capture', async (field) => {
    const a = await owner()
    const original = await a.access.approveContribution(a.request)
    const changed = field === 'source'
      ? { ...a.request, proposal: { ...a.request.proposal, source: { ...a.request.proposal.source, path: '/elsewhere' } } }
      : { ...a.request, [field]: a.request[field] + 1 }
    const revision = a.tasks.get({ taskId: a.task.id }).revision
    await expect(a.access.approveContribution(changed)).rejects.toMatchObject({ code: 'scope-contribution/source-conflict' })
    expect(a.tasks.get({ taskId: a.task.id }).revision).toBe(revision)
    await a.access.revokeContribution({ grant: original.invitation.grant })
    await expect(a.access.approveContribution(a.request)).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
    expect(a.tasks.peerContributions({ taskId: a.task.id })).toHaveLength(1)
  },
)

it('recovers the persisted approval after a lost response and Host restart', async () => {
  const a = await owner()
  const original = await a.access.approveContribution(a.request)
  const events = a.tasks.log()
  const revision = a.tasks.get({ taskId: a.task.id }).revision
  await a.ctx.fiber.dispose()
  const reopened = await host('owner-management-a', a.pool, {}, events)
  expect(await reopened.access.approveContribution(a.request)).toEqual(original)
  expect(await reopened.access.recoverContributionInvitation({ taskId: a.task.id,
    grantId: original.invitation.grant.grantId, generation: original.invitation.grant.generation,
    ownerAddress: a.request.ownerAddress })).toEqual(original)
  expect(reopened.tasks.get({ taskId: a.task.id }).revision).toBe(revision)
})

it('recovers only the original grant with a currently confirmed advertised address', async () => {
  const a = await owner()
  const original = await a.access.approveContribution(a.request)
  const address = '/ip4/127.0.0.1/tcp/2/p2p/owner-management-a'
  vi.spyOn(a.transport, 'identity').mockResolvedValue({ peerId: peer('owner-management-a'), addresses: [address] })
  const request = { taskId: a.task.id, grantId: original.invitation.grant.grantId,
    generation: original.invitation.grant.generation, ownerAddress: address }
  const recovered = await a.access.recoverContributionInvitation(request)
  expect(recovered.invitation.grant).toEqual(original.invitation.grant)
  expect(recovered.invitation.ownerAddress).toBe(address)
  expect(recovered.text).not.toBe(original.text)
  await expect(a.access.recoverContributionInvitation({ ...request, generation: peerContributionGrantSchema.parse({ ...original.invitation.grant, generation: 'wrong' }).generation }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  await expect(a.access.recoverContributionInvitation({ ...request, ownerAddress: a.request.ownerAddress }))
    .rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
})

it('shows durable expiry and recovers only its original terminal grant', async () => {
  const a = await owner()
  const original = await a.access.approveContribution(a.request)
  vi.spyOn(Date, 'now').mockReturnValue(a.request.expiresAt + 1)
  const inventory = await a.access.contributionInventory({ taskId: a.task.id })
  expect(inventory.entries[0]).toMatchObject({ state: 'ended', reason: 'expired' })
  const recovered = await a.access.recoverContributionInvitation({ taskId: a.task.id,
    grantId: original.invitation.grant.grantId, generation: original.invitation.grant.generation,
    ownerAddress: a.request.ownerAddress })
  expect(recovered.invitation.grant).toEqual(original.invitation.grant)
  await expect(a.access.approveContribution(a.request)).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
})

it('previews only bounded versioned contribution text without granting authority', async () => {
  const a = await owner()
  const transfer = { version: 1, kind: 'openapi-contribution-request', proposal: a.request.proposal }
  expect(await a.access.previewContributionText({ text: JSON.stringify(transfer) })).toEqual(transfer)
  for (const value of [JSON.stringify({ ...transfer, version: 2 }), JSON.stringify({ ...transfer, kind: 'read' }),
    JSON.stringify({ ...transfer, proposal: { ...transfer.proposal, roots: ['/private/source'] } }), 'null',
    ' '.repeat(16384) + JSON.stringify(transfer)]) {
    await expect(a.access.previewContributionText({ text: value })).rejects.toMatchObject({ code: 'scope-contribution/invalid-text' })
  }
  expect(a.tasks.peerContributions({ taskId: a.task.id })).toEqual([])
})

it('reuses an earlier caller-retained grant instead of replacing it with a derived identity', async () => {
  const a = await owner()
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: a.task.id,
    ownerPeerId: peer('owner-management-a'), ...a.request.proposal, grantId: randomUUID(), generation: randomUUID(),
    expiresAt: a.request.expiresAt, maxSamples: a.request.maxSamples, maxSampleBytes: a.request.maxSampleBytes })
  await a.access.inviteContribution({ grant, ownerAddress: a.request.ownerAddress })
  const revision = a.tasks.get({ taskId: a.task.id }).revision
  expect((await a.access.approveContribution(a.request)).invitation.grant).toEqual(grant)
  expect(a.tasks.get({ taskId: a.task.id }).revision).toBe(revision)
})

it('serializes conflicting simultaneous approvals at the Task authority commit', async () => {
  const a = await owner()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const stop = a.ctx.on('development-task/persist', async (event) => {
    if (event.change.kind === 'peer-contribution-opened') {
      entered.resolve(undefined)
      await release.promise
    }
  })
  const first = a.access.approveContribution(a.request)
  await entered.promise
  const conflicting = a.access.approveContribution({ ...a.request, maxSamples: a.request.maxSamples + 1 })
  const rejected = expect(conflicting).rejects.toMatchObject({ code: 'scope-contribution/source-conflict' })
  release.resolve(undefined)
  try { await first; await rejected } finally { stop(); release.resolve(undefined) }
  expect(a.tasks.log().filter(event => event.change.kind === 'peer-contribution-opened')).toHaveLength(1)
})

it('keeps approval identity recoverable after a failed durable commit', async () => {
  const a = await owner()
  const identities: string[] = []
  const stop = a.ctx.on('development-task/persist', async (event) => {
    if (event.change.kind === 'peer-contribution-opened') {
      identities.push(event.change.grant.grantId)
      throw new Error('fixture durable storage unavailable')
    }
  })
  await expect(a.access.approveContribution(a.request)).rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  expect(a.tasks.peerContributions({ taskId: a.task.id })).toEqual([])
  stop()
  const recovered = await a.access.approveContribution(a.request)
  expect(recovered.invitation.grant.grantId).toBe(identities[0])
})

it('rejects stale grant revocation without terminating the selected active grant', async () => {
  const a = await owner()
  const original = await a.access.approveContribution(a.request)
  const wrong = peerContributionGrantSchema.parse({ ...original.invitation.grant, generation: 'stale-generation' })
  const revision = a.tasks.get({ taskId: a.task.id }).revision
  await expect(a.access.revokeContribution({ grant: wrong })).rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  expect(a.tasks.get({ taskId: a.task.id }).revision).toBe(revision)
  expect((await a.access.contributionInventory({ taskId: a.task.id })).entries[0]?.state).toBe('active')
})

it('rejects oversized complete approval output before creating authority', async () => {
  const a = await owner()
  const small = await host('owner-small-response', undefined, { maxResponseBytes: 1024 })
  const task = await small.createTask()
  const request = { ...a.request, taskId: task.id, ownerAddress: (await small.access.identity()).addresses[0]! }
  await expect(small.access.approveContribution(request)).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(small.tasks.peerContributions({ taskId: task.id })).toEqual([])
})

it('reports a complete transfer that exceeds the input limit as capacity before committing', async () => {
  const a = await owner()
  const small = await host('owner-small-request', undefined, { maxContributionRequestBytes: 128 })
  const task = await small.createTask()
  await expect(small.access.approveContribution({ ...a.request, taskId: task.id, maxSampleBytes: 64,
    ownerAddress: (await small.access.identity()).addresses[0]! })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(small.tasks.peerContributions({ taskId: task.id })).toEqual([])
})

it('pages complete authority records including terminal grants without changing their identities', async () => {
  const a = await owner()
  for (let index = 0; index < 4; index++) {
    await a.access.approveContribution({ ...a.request, proposal: peerContributionProposalSchema.parse({ ...a.request.proposal,
      captureId: `capture-${String(index)}` }) })
  }
  const original = a.tasks.peerContributions({ taskId: a.task.id })
  await a.access.revokeContribution({ grant: original[1]!.grant })
  const expected = a.tasks.peerContributions({ taskId: a.task.id })
  const pageBudget = Math.max(...expected.map(entry => Buffer.byteLength(JSON.stringify({
    entries: [entry], nextGrantId: entry.grant.grantId,
  }), 'utf8')))
  const events = a.tasks.log()
  await a.ctx.fiber.dispose()
  const reopened = await host('owner-management-a', a.pool, { maxResponseBytes: pageBudget }, events)
  let page = await reopened.access.contributionInventory({ taskId: a.task.id })
  const recovered = [...page.entries]
  let count = 1
  while (page.nextGrantId !== null) {
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(pageBudget)
    page = await reopened.access.contributionInventory({ taskId: a.task.id, afterGrantId: page.nextGrantId })
    recovered.push(...page.entries)
    count++
    if (count > original.length) throw new Error('inventory did not advance')
  }
  expect(count).toBeGreaterThan(1)
  expect(recovered).toEqual([...reopened.tasks.peerContributions({ taskId: a.task.id })].sort((left, right) =>
    left.grant.grantId < right.grant.grantId ? -1 : 1))
  expect(recovered.filter(entry => entry.state === 'ended')).toHaveLength(1)
  const otherTask = await reopened.createTask()
  await expect(reopened.access.contributionInventory({ taskId: otherTask.id, afterGrantId: recovered[0]!.grant.grantId }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
})

it('rejects an inventory entry that cannot fit the complete page budget', async () => {
  const a = await owner()
  await a.access.approveContribution(a.request)
  const events = a.tasks.log()
  await a.ctx.fiber.dispose()
  const reopened = await host('owner-management-a', a.pool, { maxResponseBytes: 256 }, events)
  await expect(reopened.access.contributionInventory({ taskId: a.task.id })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
})

it('rejects missing, foreign-owned, and derived Tasks even when each inventory is empty', async () => {
  const a = await owner()
  const foreign = await host('owner-foreign')
  const foreignTask = await foreign.createTask()
  for (const event of foreign.tasks.log()) await a.tasks.acceptLogReplica(event, event.nodeId)
  const derived = await a.tasks.create({ origin: { kind: 'fork', parent: { taskId: a.task.id, revision: a.task.revision } },
    objective: 'Derived context', scope: 'fork fixture', createdBy: a.participantId })
  const expiry = vi.spyOn(a.tasks, 'expirePeerContributions')
  for (const taskId of ['missing-task' as DevelopmentTaskId, foreignTask.id, derived.id]) {
    await expect(a.access.contributionInventory({ taskId })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  }
  expect(expiry).not.toHaveBeenCalled()
})

it('bounds the complete validated preview response separately from pasted input', async () => {
  const a = await owner()
  const small = await host('owner-small-preview', undefined, { maxResponseBytes: 256 })
  const text = JSON.stringify({ version: 1, kind: 'openapi-contribution-request', proposal: a.request.proposal })
  await expect(small.access.previewContributionText({ text })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
})

it('recovers a terminal grant route solely to recover the original end receipt', async () => {
  const a = await owner()
  const b = await host('owner-management-b')
  const original = await a.access.approveContribution(a.request)
  const ended = await a.access.revokeContribution({ grant: original.invitation.grant })
  const revision = a.tasks.get({ taskId: a.task.id }).revision
  const address = '/ip4/127.0.0.1/tcp/3/p2p/owner-management-a'
  vi.spyOn(a.transport, 'identity').mockResolvedValue({ peerId: peer('owner-management-a'), addresses: [address] })
  const recovered = await a.access.recoverContributionInvitation({ taskId: a.task.id,
    grantId: original.invitation.grant.grantId, generation: original.invitation.grant.generation, ownerAddress: address })
  expect(recovered.invitation).toEqual({ ...original.invitation, ownerAddress: address })
  const signal = new AbortController().signal
  expect(await b.access.contributionStatus({ invitation: recovered.invitation }, signal)).toEqual(ended)
  expect(await b.access.endContribution({ invitation: recovered.invitation }, signal)).toEqual(ended)
  await expect(a.access.approveContribution({ ...a.request, ownerAddress: address }))
    .rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
  expect(a.tasks.get({ taskId: a.task.id }).revision).toBe(revision)
})
