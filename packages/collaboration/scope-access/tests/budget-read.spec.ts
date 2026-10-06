/** Consumer allowances narrow owner projections without changing online read authority. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { projectionDigest } from '../src/schema.ts'
import { budgetReadRequestSchema, captureReadRequestSchema, readRequestSchema, readResponseSchema } from '../src/state.ts'
import { cleanup, host, peer } from './helpers.ts'

const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await cleanup()
})
const signal = (): AbortSignal => new AbortController().signal
const protocol = '/agentharness/scope-read/3'
const projections = (node: Awaited<ReturnType<typeof host>>) =>
  node.pool.media.get('scope_access')!.tables.get('projections') ?? new Map<string, unknown>()

async function fixture(ownerBudget = 12000, receiverBudget = 6000) {
  const a = await host('budget-owner', undefined, { maxContextBytes: ownerBudget, maxResponseBytes: 32768 })
  const b = await host('budget-reader', undefined, { maxContextBytes: receiverBudget, maxResponseBytes: 32768 })
  const task = await a.createTask('Retain independent work within each recipient allowance')
  const ownerAddress = (await a.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: b.transport.peerId, ownerAddress,
    expiresAt: Date.now() + 50000, responsibility: 'Maintain my independently owned client.' })
  const subscription = await b.access.join({ invitation })
  const target = { peerId: invitation.ownerPeerId, address: invitation.ownerAddress }
  const wire = (maxContextBytes: number) => ({ version: 3, requestId: randomUUID(), subscriptionId: subscription.id,
    generation: subscription.generation, invitation, maxContextBytes })
  return { a, b, task, invitation, subscription, target, wire }
}

it('delivers fitting current facts with explicit omissions instead of returning the owner-sized text', async () => {
  const f = await fixture()
  for (const text of ['OLDER_LARGE_A:' + 'a'.repeat(3300), 'OLDER_LARGE_B:' + 'b'.repeat(3300),
    'CURRENT_SMALL_FACT: client accepts uid.']) {
    await f.a.tasks.publishContext({ taskId: f.task.id, participantId: f.a.participantId, text })
  }
  await expect(f.b.access.retrieve(f.subscription.id, signal())).rejects.toThrow('invitation')
  const compute = vi.spyOn(f.a.backend, 'compute')
  const transport = vi.spyOn(f.b.transport, 'request')
  const result = await f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 1800 }, signal())
  if (result.status !== 'active') throw new Error('Expected budgeted facts')
  expect(result.projection.maxContextBytes).toBe(1800)
  expect(Buffer.byteLength(result.projection.text)).toBeLessThanOrEqual(1800)
  expect(result.projection.text).toContain('CURRENT_SMALL_FACT')
  expect(result.projection.text).not.toContain('OLDER_LARGE_A')
  expect(result.projection.omittedSources.filter(item => item.reason === 'budget')).toHaveLength(2)
  expect(result.projection.selectedSources).toHaveLength(2)
  expect(compute.mock.calls[0]?.[0].maxContextBytes).toBe(1800)
  expect(transport.mock.calls[0]?.[1]).toBe(protocol)
  expect(budgetReadRequestSchema.parse(transport.mock.calls[0]?.[2]).maxContextBytes).toBe(1800)
  const retained = projections(f.b).size
  await expect(f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 1800 }, signal()))
    .resolves.toEqual(result)
  expect(projections(f.b).size).toBe(retained)
  const changed = await f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 1900 }, signal())
  if (changed.status !== 'active') throw new Error('Expected the narrowed current projection')
  expect(changed.projection.projectionId).not.toBe(result.projection.projectionId)
  expect(changed.projection.text).toBe(result.projection.text)
})

it.each([
  { owner: 12000, receiver: 6000, caller: 1400, offered: 1400, effective: 1400 },
  { owner: 12000, receiver: 1700, caller: 10000, offered: 1700, effective: 1700 },
  { owner: 1800, receiver: 6000, caller: 10000, offered: 6000, effective: 1800 },
])('narrows caller $caller through receiver $receiver and owner $owner limits', async (limits) => {
  const f = await fixture(limits.owner, limits.receiver)
  const transport = vi.spyOn(f.b.transport, 'request')
  const compute = vi.spyOn(f.a.backend, 'compute')
  const result = await f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: limits.caller }, signal())
  if (result.status !== 'active') throw new Error('Expected active bounded projection')
  expect(result.projection.maxContextBytes).toBe(limits.effective)
  expect(compute.mock.calls[0]?.[0].maxContextBytes).toBe(limits.effective)
  expect(budgetReadRequestSchema.parse(transport.mock.calls[0]?.[2]).maxContextBytes).toBe(limits.offered)
})

it('keeps old read parsers strict and rejects invalid version-three budgets before reading Task facts', async () => {
  const f = await fixture()
  const read = vi.spyOn(f.a.tasks, 'currentContextView')
  const request = f.wire(1800)
  expect(readRequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false)
  expect(captureReadRequestSchema.safeParse({ ...request, version: 2,
    originalCapture: { captureId: randomUUID(), captureGeneration: randomUUID() } }).success).toBe(false)
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(f.b.transport.request(f.target, protocol, { ...request, maxContextBytes: invalid }, signal())).rejects.toThrow()
  }
  await expect(f.b.transport.request(f.target, protocol, { ...request, future: true }, signal())).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
  await expect(f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 0 }, signal())).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
})

it.each(['cap', 'text'] as const)('rejects owner %s above the offered budget even with a recomputed digest', async (change) => {
  const f = await fixture()
  f.b.transport.transform = (raw) => {
    const response = readResponseSchema.parse(raw)
    if (response.result.status !== 'active') throw new Error('Expected active response')
    const changed = { ...response.result.projection, maxContextBytes: 3000,
      ...(change === 'text' ? { text: '多'.repeat(900) } : {}) }
    return { ...response, result: { status: 'active', projection: { ...changed, projectionId: projectionDigest(changed) } } }
  }
  await expect(f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 1800 }, signal()))
    .rejects.toThrow('requested text budget')
  expect(projections(f.b).size).toBe(0)
})

it('does not downgrade when the peer lacks the budgeted protocol and disposes its owned handler', async () => {
  const f = await fixture()
  f.a.transport.handlers.delete(protocol)
  const request = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 1800 }, signal()))
    .resolves.toEqual({ status: 'unavailable' })
  expect(request.mock.calls.map(call => call[1])).toEqual([protocol])
  expect(f.b.transport.handlers.has(protocol)).toBe(true)
  await f.b.ctx.fiber.dispose()
  expect(f.b.transport.handlers.has(protocol)).toBe(false)
})

it.each(['revoked', 'left', 'cancelled'] as const)('discards a budgeted computation after %s during backend work', async (ending) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const compute = f.a.backend.compute.bind(f.a.backend)
  vi.spyOn(f.a.backend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return await compute(input)
  })
  const cancelled = new AbortController()
  const pending = f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 1800 }, cancelled.signal)
    .catch((error: unknown) => error)
  try {
    await entered.promise
    if (ending === 'revoked') await f.a.access.revoke({ grantId: f.invitation.grantId })
    else if (ending === 'left') await f.b.access.leave({ subscriptionId: f.subscription.id })
    else cancelled.abort(new Error('budget consumer cancelled'))
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending])
  }
  if (ending === 'cancelled') expect(await pending).toBeInstanceOf(Error)
  else expect(await pending).toEqual({ status: ending })
  expect(projections(f.b).size).toBe(0)
  if (ending === 'revoked') expect(projections(f.a).size).toBe(0)
})

it('denies a foreign authenticated peer before computing a negotiated projection', async () => {
  const f = await fixture()
  const foreign = await host('budget-foreign', undefined, {}, [], peer('budget-foreign'))
  const read = vi.spyOn(f.a.tasks, 'currentContextView')
  const raw = await foreign.transport.request(f.target, protocol, f.wire(1800), signal())
  expect(readResponseSchema.parse(raw).result).toEqual({ status: 'denied' })
  expect(read).not.toHaveBeenCalled()
})
