/** Change-wait admission includes pending initial Task reads, before cursor alignment finishes. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host } from './helpers.ts'

afterEach(cleanup)

async function fixture() {
  const owner = await host('wait-admission-owner', undefined, { maxConcurrentWaits: 1 })
  const first = await host('wait-admission-first', undefined, { maxConcurrentWaits: 1 })
  const second = await host('wait-admission-second', undefined, { maxConcurrentWaits: 1 })
  const task = await owner.createTask()
  const [ownerAddress] = (await owner.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing advertised owner route')
  const subscriptions = await Promise.all([first, second].map(async (receiver) => {
    const invitation = await owner.access.invite({ taskId: task.id, recipientPeerId: receiver.transport.peerId,
      ownerAddress, expiresAt: Date.now() + 50000, responsibility: 'Read the independently authorized Task.' })
    return receiver.access.join({ invitation })
  }))
  const [firstSubscription, secondSubscription] = subscriptions
  if (firstSubscription === undefined || secondSubscription === undefined) throw new Error('Missing receiving intent')
  return { owner, first, second, firstSubscription, secondSubscription }
}

it.each([false, true])('reserves the initial owner read until settlement, including caller cancellation=%s', async (cancel) => {
  const { owner, first, second, firstSubscription, secondSubscription } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const current = owner.tasks.currentContextView.bind(owner.tasks)
  let held = false
  const viewed = vi.spyOn(owner.tasks, 'currentContextView').mockImplementation(async (id) => {
    const view = await current(id)
    if (!held) {
      held = true
      entered.resolve(undefined)
      await release.promise
    }
    return view
  })
  const lifetime = new AbortController()
  const pending = first.access.waitForChange(firstSubscription.id, undefined, lifetime.signal)
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    if (cancel) lifetime.abort(new Error('Original caller cancelled'))
    expect(await second.access.waitForChange(secondSubscription.id, undefined, new AbortController().signal))
      .toEqual({ status: 'unavailable' })
    expect(viewed).toHaveBeenCalledTimes(1)
    expect((await second.access.retrieve(secondSubscription.id, new AbortController().signal)).status).toBe('active')
    release.resolve(undefined)
    if (cancel) await expect(pending).rejects.toThrow('Original caller cancelled')
    else expect((await pending).status).toBe('changed')
    expect((await second.access.waitForChange(secondSubscription.id, undefined, new AbortController().signal)).status).toBe('changed')
  } finally {
    release.resolve(undefined)
    await settled
    viewed.mockRestore()
  }
  expect(owner.transport.inbound).toBe(0)
  expect(first.transport.outbound).toBe(0)
  expect(second.transport.outbound).toBe(0)
})

it('keeps a cancelled wire’s owner allowance until its actual view settles before a same-subscription retry', async () => {
  const { owner, first, firstSubscription } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const current = owner.tasks.currentContextView.bind(owner.tasks)
  let held = false
  const viewed = vi.spyOn(owner.tasks, 'currentContextView').mockImplementation(async (id) => {
    const view = await current(id)
    if (!held) {
      held = true
      entered.resolve(undefined)
      await release.promise
    }
    return view
  })
  const remote: Promise<unknown>[] = []
  const send = first.transport.request.bind(first.transport)
  const cancelledWire = vi.spyOn(first.transport, 'request').mockImplementation((target, protocol, payload, signal) => {
    const response = send(target, protocol, payload, signal)
    remote.push(Promise.allSettled([response]))
    const cancelled = Promise.withResolvers<never>()
    const abort = () => { cancelled.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    return Promise.race([response, cancelled.promise]).finally(() => { signal.removeEventListener('abort', abort) })
  })
  const pending = first.access.waitForChange(firstSubscription.id, undefined, new AbortController().signal)
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    expect(await first.access.waitForChange(firstSubscription.id, undefined, new AbortController().signal))
      .toEqual({ status: 'unavailable' })
    await expect(pending).rejects.toThrow('wait superseded')
    expect(viewed).toHaveBeenCalledTimes(1)
    release.resolve(undefined)
    await Promise.all(remote)
    expect((await first.access.waitForChange(firstSubscription.id, undefined, new AbortController().signal)).status).toBe('changed')
  } finally {
    release.resolve(undefined)
    await settled
    await Promise.all(remote)
    cancelledWire.mockRestore()
    viewed.mockRestore()
  }
  expect(owner.transport.inbound).toBe(0)
  expect(first.transport.outbound).toBe(0)
})
