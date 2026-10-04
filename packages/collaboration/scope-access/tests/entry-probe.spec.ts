import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { contributionEntrySchema, contributionProposalSchema } from '../src/contribution-schema.ts'
import { applicationRecordSchema } from '../src/application-schema.ts'
import type { Config } from '../src/index.ts'
import { cleanup, host, peer } from './helpers.ts'

// Public identity only; transport authentication is controlled here and exercised by the Web composition separately.
const ownerPeer = peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy')
const address = (port: number): string => `/ip4/127.0.0.1/tcp/${port}/p2p/${ownerPeer}`
const protocol = '/agentharness/scope-entry-probe/1'
const signal = (): AbortSignal => new AbortController().signal
afterEach(cleanup)

async function fixture(sourceConfig: Partial<Config> = {}) {
  const a = await host('probe-owner', undefined, {}, [], ownerPeer)
  const b = await host('probe-source', undefined, sourceConfig)
  const task = await a.createTask('Private objective is never returned by entry probes')
  await b.access.identity()
  const created = await a.access.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress: address(1), expiresAt: Date.now() + 20_000 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('probe-source'), captureId: randomUUID(),
    captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const request = { entry: created.entry, proposal, limits: { expiresAt: Date.now() + 40_000, maxSamples: 4, maxSampleBytes: 2048 } }
  const approve = () => a.access.approveContributionApplication({ entryId: request.entry.entryId,
    expectedProposal: proposal, limits: request.limits, ownerAddress: address(1), read: { responsibility: 'Frontend' } })
  const retained = () => applicationRecordSchema.parse(a.pool.media.get('scope_access')?.tables.get('applications')?.get(created.entry.entryId))
  return { a, b, task, entry: created.entry, request, approve, retained }
}

it('returns only ready without reading a Task, changing storage, or granting either permission', async () => {
  const { a, b, entry } = await fixture()
  const before = structuredClone([a.pool.media, b.pool.media])
  const writes = vi.spyOn(a.pool, 'consumeInjectedFailure')
  const sourceWrites = vi.spyOn(b.pool, 'consumeInjectedFailure')
  const taskReads = vi.spyOn(a.tasks, 'contextView').mockImplementation(() => { throw new Error('Task must remain private') })
  const taskAuthority = vi.spyOn(a.tasks, 'peerContributions').mockImplementation(() => { throw new Error('No Task reconciliation') })
  const changes = vi.fn()
  a.ctx.on('scope-access/contribution-application-changed', changes)
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
  expect([a.pool.media, b.pool.media]).toEqual(before)
  expect(writes).not.toHaveBeenCalled()
  expect(sourceWrites).not.toHaveBeenCalled()
  expect(taskReads).not.toHaveBeenCalled()
  expect(taskAuthority).not.toHaveBeenCalled()
  expect(changes).not.toHaveBeenCalled()
})

it('observes a pending claim without revealing its claimant or reserving the entry', async () => {
  const { a, b, entry, request } = await fixture()
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
  const c = await host('probe-other')
  const other = { ...request, proposal: contributionProposalSchema.parse({ ...request.proposal,
    contributorPeerId: peer('probe-other'), captureId: randomUUID() }) }
  expect(await c.access.applyContribution(other, signal())).toEqual({ status: 'pending' })
  const before = structuredClone(a.pool.media)
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'claimed' })
  expect(await c.access.probeContributionEntry({ entry })).toEqual({ status: 'claimed' })
  expect(a.pool.media).toEqual(before)
  expect(await b.access.applyContribution(request, signal())).toEqual({ status: 'denied' })
})

it.each(['approved', 'rejected', 'cancelled'] as const)('reports %s as closed without reconciling Task grants', async (decision) => {
  const { a, b, entry, request, approve } = await fixture()
  await b.access.applyContribution(request, signal())
  if (decision === 'approved') await approve()
  else if (decision === 'rejected') await a.access.rejectContributionApplication({ entryId: entry.entryId, expectedProposal: request.proposal })
  else await b.access.cancelContributionApplication(request, signal())
  const before = structuredClone(a.pool.media)
  const authority = vi.spyOn(a.tasks, 'peerContributions').mockImplementation(() => { throw new Error('Probe must not recover authority') })
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'closed' })
  expect(a.pool.media).toEqual(before)
  expect(authority).not.toHaveBeenCalled()
})

it('checks wall-clock expiry without persisting the expired decision', async () => {
  const { a, b, entry, retained } = await fixture()
  const before = structuredClone(a.pool.media)
  const writes = vi.spyOn(a.pool, 'consumeInjectedFailure')
  vi.spyOn(Date, 'now').mockReturnValue(entry.expiresAt)
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'expired' })
  expect(retained().decision).toBe('open')
  expect(a.pool.media).toEqual(before)
  expect(writes).not.toHaveBeenCalled()
})

it('keeps failed approval intent closed without finishing its planned grant', async () => {
  const { a, b, entry, request, approve, task } = await fixture()
  await b.access.applyContribution(request, signal())
  const detach = a.ctx.on('development-task/persist', (event) => {
    if (event.change.kind === 'peer-contribution-opened') throw new Error('Task write unavailable')
  })
  await expect(approve()).rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  detach()
  const before = a.tasks.log()
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'closed' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
  expect(a.tasks.log()).toEqual(before)
})

it('binds every original entry field but accepts a direct new address for the same owner', async () => {
  const { a, b, entry } = await fixture()
  const before = structuredClone(a.pool.media)
  for (const changed of [
    { ...entry, entryId: randomUUID() }, { ...entry, taskId: 'another-task' }, { ...entry, expiresAt: entry.expiresAt + 1 },
    { ...entry, kind: 'contribution-entry' }, { ...entry, kind: 'contribution-entry', sourceKind: 'openapi' },
  ]) {
    expect(await b.access.probeContributionEntry({ entry: contributionEntrySchema.parse(changed) })).toEqual({ status: 'denied' })
  }
  expect(await b.access.probeContributionEntry({ entry: { ...entry, ownerAddress: address(2) } })).toEqual({ status: 'ready' })
  expect(a.pool.media).toEqual(before)
})

it('refuses self probes and malformed destinations before transport sends', async () => {
  const { a, b, entry } = await fixture()
  const ownerSends = vi.spyOn(a.transport, 'request')
  const sourceSends = vi.spyOn(b.transport, 'request')
  expect(await a.access.probeContributionEntry({ entry })).toEqual({ status: 'denied' })
  for (const ownerAddress of [address(0), address(2).replace(String(ownerPeer), 'wrong-peer'), 'https://example.test/', '/dns4/example.test/tcp/1']) {
    expect(await b.access.probeContributionEntry({ entry: { ...entry, ownerAddress } })).toEqual({ status: 'denied' })
  }
  expect(ownerSends).not.toHaveBeenCalled()
  expect(sourceSends).not.toHaveBeenCalled()
})

it('checks the authenticated incoming sender and actual owner against the retained entry', async () => {
  const { a, entry } = await fixture()
  const handler = a.transport.handlers.get(protocol)
  if (handler === undefined) throw new Error('Probe protocol is not registered')
  const payload = { version: 1, requestId: randomUUID(), entry }
  expect(await handler({ peerId: ownerPeer, payload, signal: signal() })).toEqual({ version: 1, requestId: payload.requestId,
    result: { status: 'denied' } })
  const other = await host('probe-wrong-owner')
  const wrongHandler = other.transport.handlers.get(protocol)
  if (wrongHandler === undefined) throw new Error('Probe protocol is not registered')
  expect(await wrongHandler({ peerId: peer('probe-source'), payload, signal: signal() })).toEqual({ version: 1,
    requestId: payload.requestId, result: { status: 'denied' } })
})

it('rejects uncorrelated, malformed, and oversized peer responses', async () => {
  const { b, entry } = await fixture()
  for (const transform of [
    () => ({ version: 1, requestId: randomUUID(), result: { status: 'ready' } }),
    (raw: unknown) => ({ ...(raw as Record<string, unknown>), result: { status: 'ready', context: 'must not leak' } }),
    (raw: unknown) => ({ ...(raw as Record<string, unknown>), version: 2 }),
  ]) {
    b.transport.transform = transform
    expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'unavailable' })
  }
  b.transport.transform = () => 'x'.repeat(20_000)
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'capacity' })
})

it('bounds the complete request before sending', async () => {
  const { b, entry } = await fixture({ maxApplicationRequestBytes: 100 })
  const sends = vi.spyOn(b.transport, 'request')
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'capacity' })
  expect(sends).not.toHaveBeenCalled()
})

it('leaves outbound ordinary capacity bounded and releases every admitted request', async () => {
  const { b, entry } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = b.transport.request.bind(b.transport)
  let count = 0
  vi.spyOn(b.transport, 'request').mockImplementation(async (...args) => {
    count++; if (count === 4) entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  const probes = Array.from({ length: 4 }, () => b.access.probeContributionEntry({ entry }))
  try {
    await entered.promise
    expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'capacity' })
    expect(count).toBe(4)
  } finally { release.resolve(undefined) }
  expect(await Promise.all(probes)).toEqual(Array.from({ length: 4 }, () => ({ status: 'ready' })))
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'ready' })
})

it('bounds inbound ordinary capacity without holding the application mutation queue', async () => {
  const { a, b, entry, request } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const identity = a.transport.identity.bind(a.transport)
  let count = 0
  vi.spyOn(a.transport, 'identity').mockImplementation(async () => {
    count++; if (count === 4) entered.resolve(undefined)
    await release.promise
    return identity()
  })
  const handler = a.transport.handlers.get(protocol)
  if (handler === undefined) throw new Error('Probe protocol is not registered')
  const probe = () => handler({ peerId: peer('probe-source'), payload: { version: 1, requestId: randomUUID(), entry }, signal: signal() })
  const probes = Array.from({ length: 4 }, probe)
  try {
    await entered.promise
    expect(await probe()).toMatchObject({ result: { status: 'capacity' } })
    expect(await b.access.cancelContributionApplication(request, signal())).toEqual({ status: 'cancelled' })
  } finally { release.resolve(undefined) }
  expect(await Promise.all(probes)).toEqual(expect.arrayContaining([expect.objectContaining({ result: { status: 'closed' } })]))
})

it('returns unavailable when the provider reaches the configured deadline', async () => {
  const { b, entry } = await fixture({ requestTimeoutMs: 30, waitTimeoutMs: 10 })
  vi.spyOn(b.transport, 'request').mockImplementation(async (_target, _protocol, _payload, requestSignal) => {
    await new Promise<void>((resolve) => { requestSignal.addEventListener('abort', () => { resolve() }, { once: true }) })
    requestSignal.throwIfAborted()
  })
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'unavailable' })
})

it('aborts and drains an in-flight probe when its source service is disposed', async () => {
  const { b, entry } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  let aborted = false
  vi.spyOn(b.transport, 'request').mockImplementation(async (_target, _protocol, _payload, requestSignal) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { requestSignal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
    requestSignal.throwIfAborted()
  })
  const probing = b.access.probeContributionEntry({ entry })
  const rejected = expect(probing).rejects.toThrow('disposed')
  await entered.promise
  await b.ctx.fiber.dispose()
  await rejected
  expect(aborted).toBe(true)
  expect(b.transport.handlers.has(protocol)).toBe(false)
})

it('keeps a disconnected owner unavailable without changing source state', async () => {
  const { b, entry } = await fixture()
  const before = structuredClone(b.pool.media)
  vi.spyOn(b.transport, 'request').mockRejectedValue(new ScopeTransportError('scope-transport/unavailable'))
  expect(await b.access.probeContributionEntry({ entry })).toEqual({ status: 'unavailable' })
  expect(b.pool.media).toEqual(before)
})
