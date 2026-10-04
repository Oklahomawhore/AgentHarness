import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScopeGeneration, ScopeSubscription, ScopeSubscriptionId } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal

async function receiving() {
  const a = await host('adoption-owner')
  const b = await host('adoption-receiver', undefined, { maxSubscriptions: 1 })
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('owner has no address')
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: peer('adoption-receiver'),
    ownerAddress, expiresAt: Date.now() + 50_000, responsibility: 'Frontend' })
  const plan: ScopeSubscription = { id: randomUUID() as ScopeSubscriptionId, generation: randomUUID() as ScopeGeneration,
    invitation, state: 'active' }
  return { a, b, plan }
}

it('persists one preallocated subscription for concurrent identical adoption attempts', async () => {
  const { b, plan } = await receiving()
  const results = await Promise.all([b.access.ensureSubscription(plan), b.access.ensureSubscription(plan)])
  expect(results).toEqual([plan, plan])
  expect((await b.access.list()).subscriptions).toEqual([plan])
  await expect(b.access.join({ invitation: plan.invitation })).rejects.toThrow('capacity')
  await expect(b.access.ensureSubscription(plan)).resolves.toEqual(plan)
})

it.each(['generation', 'invitation'] as const)('refuses a different %s using the same receiving identity', async (field) => {
  const { b, plan } = await receiving()
  await b.access.ensureSubscription(plan)
  const changed: ScopeSubscription = field === 'generation' ? { ...plan, generation: randomUUID() as ScopeGeneration }
    : { ...plan, invitation: { ...plan.invitation, responsibility: 'QA' } }
  await expect(b.access.ensureSubscription(changed)).rejects.toThrow('another plan')
  expect((await b.access.list()).subscriptions).toEqual([plan])
})

it('returns a retained leave even when the original invitation has expired', async () => {
  const { b, plan } = await receiving()
  await b.access.ensureSubscription(plan)
  await b.access.leave({ subscriptionId: plan.id })
  vi.spyOn(Date, 'now').mockReturnValue(plan.invitation.expiresAt + 1)
  await expect(b.access.ensureSubscription(plan)).resolves.toEqual({ ...plan, state: 'left' })
  expect(await b.access.retrieve(plan.id, signal())).toEqual({ status: 'left' })
})

it('retains remotely observed revocation and never resets it during adoption retry', async () => {
  const { a, b, plan } = await receiving()
  await b.access.ensureSubscription(plan)
  await a.access.revoke({ grantId: plan.invitation.grantId })
  expect(await b.access.retrieve(plan.id, signal())).toEqual({ status: 'revoked' })
  await expect(b.access.ensureSubscription(plan)).resolves.toEqual({ ...plan, state: 'revoked' })
})

it('persists observed expiry before returning an existing plan and rejects an expired new one', async () => {
  const { b, plan } = await receiving()
  await b.access.ensureSubscription(plan)
  vi.spyOn(Date, 'now').mockReturnValue(plan.invitation.expiresAt + 1)
  await expect(b.access.ensureSubscription(plan)).resolves.toEqual({ ...plan, state: 'expired' })
  await expect(b.access.ensureSubscription({ ...plan, id: randomUUID() as ScopeSubscriptionId })).rejects.toThrow('expiry')
  vi.restoreAllMocks()
  await expect(b.access.ensureSubscription(plan)).resolves.toEqual({ ...plan, state: 'expired' })
  expect((await b.access.list()).subscriptions).toHaveLength(1)
})

it('recovers the original subscription after reopening source storage instead of allocating a second one', async () => {
  const { b, plan } = await receiving()
  await b.access.ensureSubscription(plan)
  await b.ctx.fiber.dispose()
  const restored = await host('adoption-receiver', b.pool, { maxSubscriptions: 1 })
  await expect(restored.access.ensureSubscription(plan)).resolves.toEqual(plan)
  expect((await restored.access.list()).subscriptions).toEqual([plan])
})

it('keeps a failed subscription write absent and retries only the same planned identity', async () => {
  const { b, plan } = await receiving()
  await b.access.identity()
  b.pool.failNextWrites = 1
  await expect(b.access.ensureSubscription(plan)).rejects.toThrow('injected write failure')
  expect((await b.access.list()).subscriptions).toEqual([])
  await expect(b.access.ensureSubscription(plan)).resolves.toEqual(plan)
})
