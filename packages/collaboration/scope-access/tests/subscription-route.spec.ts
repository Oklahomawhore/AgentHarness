import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from './helpers.ts'

// Public fixture identity only; no private key or network process is involved in this transport-controlled suite.
const owner = '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy'
const address = (port: number): string => `/ip4/127.0.0.1/tcp/${port}/p2p/${owner}`
afterEach(cleanup)
async function fixture() {
  const a = await host('route-owner', undefined, {}, [], peer(owner))
  const b = await host('route-reader')
  const task = await a.createTask('Route recovery canary')
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: peer('route-reader'), ownerAddress: address(1),
    expiresAt: Date.now() + 50_000, responsibility: 'Review scope' })
  const subscription = await b.access.join({ invitation })
  const route = { ...subscription, routeRevision: 1, invitation: { ...invitation, ownerAddress: address(2) } }
  return { a, b, subscription, route }
}
it('keeps grant and receiving identities through changed routes, retries, and storage reopen', async () => {
  const { a, b, subscription, route } = await fixture()
  expect(await b.access.updateSubscriptionRoute(route)).toEqual(route)
  expect(await b.access.ensureSubscription(subscription)).toEqual(route)
  expect(await b.access.retrieve(subscription.id, new AbortController().signal)).toMatchObject({ status: 'active' })
  expect((await a.access.list()).grants[0]?.invitation).toEqual(subscription.invitation)
  await b.ctx.fiber.dispose()
  const restored = await host('route-reader', b.pool)
  expect(await restored.access.updateSubscriptionRoute(route)).toEqual(route)
  expect((await restored.access.list()).subscriptions).toEqual([route])
})
it('rejects changed permission, wrong peer, zero port, and route-revision ABA', async () => {
  const { b, subscription, route } = await fixture()
  await expect(b.access.updateSubscriptionRoute({ ...route, invitation: { ...route.invitation, responsibility: 'Different' } }))
    .rejects.toThrow('authority')
  await expect(b.access.updateSubscriptionRoute({ ...route, invitation: { ...route.invitation, ownerAddress: address(0) } }))
    .rejects.toThrow()
  await expect(b.access.updateSubscriptionRoute({ ...route,
    invitation: { ...route.invitation, ownerAddress: address(2).replace(owner, 'wrong-peer') } })).rejects.toThrow()
  await b.access.updateSubscriptionRoute(route)
  const returned = { ...subscription, routeRevision: 2 }
  await b.access.updateSubscriptionRoute(returned)
  expect(await b.access.updateSubscriptionRoute(route)).toEqual(returned)
  await expect(b.access.updateSubscriptionRoute({ ...route, routeRevision: 2 })).rejects.toThrow('another address')
})
it('leaves terminal subscriptions terminal and keeps failed writes retryable', async () => {
  const { b, subscription, route } = await fixture()
  b.pool.failNextWrites = 1
  await expect(b.access.updateSubscriptionRoute(route)).rejects.toThrow('injected write failure')
  expect((await b.access.list()).subscriptions).toEqual([subscription])
  expect(await b.access.updateSubscriptionRoute(route)).toEqual(route)
  await b.access.leave({ subscriptionId: subscription.id })
  expect(await b.access.updateSubscriptionRoute({ ...subscription, routeRevision: 2 })).toEqual({ ...route, state: 'left' })
})
it('rejects an old-route read reply after the new route commits', async () => {
  const { b, subscription, route } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  b.transport.transform = async (response) => { entered.resolve(undefined); await release.promise; return response }
  const reading = b.access.retrieve(subscription.id, new AbortController().signal)
  try {
    await entered.promise
    await b.access.updateSubscriptionRoute(route)
  } finally { release.resolve(undefined) }
  expect(await reading).toEqual({ status: 'unavailable' })
  b.transport.transform = undefined
  expect(await b.access.retrieve(subscription.id, new AbortController().signal)).toMatchObject({ status: 'active' })
})
it('persists expiry before refusing any new route and never renews it', async () => {
  const { b, route } = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(route.invitation.expiresAt)
  expect(await b.access.updateSubscriptionRoute(route)).toMatchObject({ state: 'expired', invitation: { ownerAddress: address(1) } })
  vi.restoreAllMocks()
  expect(await b.access.updateSubscriptionRoute(route)).toMatchObject({ state: 'expired' })
})
