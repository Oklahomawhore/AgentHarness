import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { peerContributionGrantSchema, peerContributionPublicationId } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { contributionInvitationSchema } from '../src/schema.ts'
import type { Config } from '../src/index.ts'
import { contributionResponseSchema } from '../src/contribution-schema.ts'
import type { ScopeContributionSample } from '../src/types.ts'
import { cleanup, config, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
const sample = (sequence = 1, field = 'sku'): ScopeContributionSample => ({
  sourceId: createHash('sha256').update(`${String(sequence)}:${field}`).digest('hex') as DevelopmentTaskObservedSourceId,
  sequence,
  result: { state: 'valid', sha256: 'a'.repeat(64), facts: {
    operationId: 'createOrder', requestBodyRequired: true, requiredRequestFields: [field], responseStatuses: ['201'], deprecated: false,
  } },
})
async function granted(overrides: Partial<Config> = {}) {
  const a = await host('peer-a', undefined, overrides)
  const b = await host('peer-b')
  const task = await a.createTask()
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: task.id, grantId: randomUUID(), generation: randomUUID(),
    ownerPeerId: peer('peer-a'), contributorPeerId: peer('peer-b'), captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { name: 'orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 50_000, maxSamples: 16, maxSampleBytes: 4096 })
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const invitation = await a.access.inviteContribution({ ownerAddress, grant })
  return { a, b, task, grant, invitation }
}
async function readSubscription(value: Awaited<ReturnType<typeof granted>>) {
  const invitation = await value.a.access.invite({ taskId: value.task.id, recipientPeerId: peer('peer-b'),
    ownerAddress: value.invitation.ownerAddress, expiresAt: Date.now() + 55_000, responsibility: 'frontend' })
  return await value.b.access.join({ invitation })
}

it('admits only separately approved peer evidence and keeps read permission independent', async () => {
  const { a, b, task, grant, invitation } = await granted()
  expect((await b.access.contributionStatus({ invitation }, signal())).status).toBe('active')
  expect(b.tasks.list({ limit: 16 })).toEqual([])
  expect((await b.access.list()).subscriptions).toEqual([])
  const first = await b.access.contribute({ invitation, sample: sample() }, signal())
  expect(first.status).toBe('accepted')
  if (first.status !== 'accepted') throw new Error('expected original receipt')
  expect(first.receipt.publicationId).toBe(peerContributionPublicationId({ grant, ...sample() }))
  expect(first.receipt.event.kind).toBe('context-published')
  const context = a.tasks.contextView(task.id).task.context
  expect(context).toHaveLength(1)
  expect(context[0]?.peerObservation?.observerPeerId).toBe(peer('peer-b'))
  expect(context[0]?.publishedBy).toBeUndefined()
  const revision = a.tasks.get({ taskId: task.id }).revision
  await expect(b.access.contribute({ invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'reused', receipt: first.receipt })
  expect(a.tasks.get({ taskId: task.id }).revision).toBe(revision)
  const ordinary = await a.access.invite({ taskId: task.id, recipientPeerId: peer('peer-b'),
    ownerAddress: invitation.ownerAddress, expiresAt: Date.now() + 30_000, responsibility: 'frontend' })
  expect(contributionInvitationSchema.safeParse(ordinary).success).toBe(false)
})

it.each(['peer', 'task', 'capture', 'selector', 'generation'] as const)('refuses an unapproved contribution %s without publishing', async (field) => {
  const { a, b, task, invitation } = await granted()
  const c = await host('peer-c')
  const changed = contributionInvitationSchema.parse({ ...invitation, grant: { ...invitation.grant,
    ...(field === 'task' ? { taskId: 'private-task' } : {}),
    ...(field === 'capture' ? { captureGeneration: randomUUID() } : {}),
    ...(field === 'selector' ? { source: { ...invitation.grant.source, name: 'private' } } : {}),
    ...(field === 'generation' ? { generation: randomUUID() } : {}),
  } })
  const revision = a.tasks.get({ taskId: task.id }).revision
  const raw = await (field === 'peer' ? c : b).transport.request({ peerId: invitation.grant.ownerPeerId,
    address: invitation.ownerAddress }, '/agentharness/scope-contribute/1', {
    version: 1, requestId: randomUUID(), op: 'sample', invitation: changed, sample: sample(),
  }, signal())
  const result = contributionResponseSchema.parse(raw).result
  expect(result).toEqual({ status: 'denied' })
  expect(a.tasks.get({ taskId: task.id }).revision).toBe(revision)
  expect(JSON.stringify(result)).not.toContain(task.id)
})

it('recovers the exact original receipt after a committed response is lost and a grant ends', async () => {
  const { a, b, task, grant, invitation } = await granted()
  b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  await expect(b.access.contribute({ invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  const revision = a.tasks.get({ taskId: task.id }).revision
  b.transport.transform = undefined
  const recovered = await b.access.contribute({ invitation, sample: sample() }, signal())
  expect(recovered.status).toBe('reused')
  expect(a.tasks.get({ taskId: task.id }).revision).toBe(revision)
  const ended = await a.access.revokeContribution({ grant })
  expect(ended.status).toBe('ended')
  await expect(b.access.contribute({ invitation, sample: sample() }, signal())).resolves.toEqual(recovered)
  await expect(b.access.contribute({ invitation, sample: sample(2) }, signal())).resolves.toEqual(ended)
  await expect(b.access.contribute({ invitation, sample: { ...sample(), result: sample(1, 'changed').result } }, signal()))
    .resolves.toEqual({ status: 'denied' })
  await expect(b.access.endContribution({ invitation }, signal())).resolves.toEqual(ended)
})

it.each(['taskId', 'ownerPeerId', 'contributorPeerId', 'grantId', 'generation', 'captureId', 'captureGeneration',
  'sourceId', 'sequence', 'payloadDigest', 'publicationId', 'event-kind', 'requestId'] as const)(
  'rejects a shaped but unrelated sample receipt field %s and preserves the original retry', async (field) => {
    const { b, invitation } = await granted()
    b.transport.transform = (raw) => {
      const response = contributionResponseSchema.parse(raw)
      if (response.op !== 'sample' || (response.result.status !== 'accepted' && response.result.status !== 'reused')) {
        throw new Error('expected sample response')
      }
      if (field === 'requestId') return { ...response, requestId: randomUUID() }
      const receipt = response.result.receipt
      const changed = field === 'event-kind' ? { event: { ...receipt.event, kind: 'peer-contribution-opened' } }
        : { [field]: field === 'sequence' ? 2 : field === 'sourceId' || field === 'payloadDigest' ? 'b'.repeat(64) : `wrong-${field}` }
      return { ...response, result: { ...response.result, receipt: { ...receipt, ...changed } } }
    }
    await expect(b.access.contribute({ invitation, sample: sample() }, signal())).rejects.toThrow()
    b.transport.transform = undefined
    expect((await b.access.contribute({ invitation, sample: sample() }, signal())).status).toBe('reused')
  },
)

it('rejects an open receipt substituted for a terminal commit', async () => {
  const { b, invitation } = await granted()
  const opened = await b.access.contributionStatus({ invitation }, signal())
  if (opened.status !== 'active') throw new Error('expected open receipt')
  b.transport.transform = (raw) => {
    const response = contributionResponseSchema.parse(raw)
    return { ...response, result: { status: 'ended', reason: 'left', receipt: opened.receipt } }
  }
  await expect(b.access.endContribution({ invitation }, signal())).rejects.toThrow()
  b.transport.transform = undefined
  const ended = await b.access.endContribution({ invitation }, signal())
  expect(ended.status).toBe('ended')
  if (ended.status === 'ended') expect(ended.receipt.event.kind).toBe('peer-contribution-ended')
})

it('fails closed on expiry persistence failure without relying on a Host exit', async () => {
  const value = await granted()
  const subscription = await readSubscription(value)
  const admitted = await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  if (admitted.status !== 'accepted') throw new Error('expected original sample receipt')
  const cached = await value.b.access.retrieve(subscription.id, signal())
  expect(cached.status).toBe('active')
  if (cached.status !== 'active') throw new Error('expected cached valid evidence')
  expect(cached.projection.text).toContain('sku')
  const persist = value.a.ctx.on('development-task/persist', async (event) => {
    if (event.change.kind === 'peer-contribution-ended') throw new Error('unavailable store')
  })
  vi.spyOn(Date, 'now').mockReturnValue(value.grant.expiresAt + 1)
  try {
    await expect(value.b.access.retrieve(subscription.id, signal())).rejects.toThrow('unavailable store')
    await expect(value.b.access.waitForChange(subscription.id, undefined, signal())).rejects.toThrow('unavailable store')
    expect(value.a.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('active')
    expect(value.a.exit).not.toHaveBeenCalled()
    const revision = value.a.tasks.get({ taskId: value.task.id }).revision
    await expect(value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal()))
      .resolves.toEqual({ status: 'reused', receipt: admitted.receipt })
    await expect(value.b.access.contribute({ invitation: value.invitation, sample: sample(2) }, signal()))
      .resolves.toEqual({ status: 'unavailable' })
    await expect(value.b.access.endContribution({ invitation: value.invitation }, signal()))
      .resolves.toEqual({ status: 'unavailable' })
    expect(value.a.tasks.get({ taskId: value.task.id }).revision).toBe(revision)
  } finally { persist() }
  const recovered = await value.b.access.retrieve(subscription.id, signal())
  expect(recovered.status).toBe('active')
  if (recovered.status !== 'active') throw new Error('expected current withdrawal')
  expect(recovered.projection.projectionId).not.toBe(cached.projection.projectionId)
  expect(recovered.projection.text).not.toContain('sku')
  expect(value.a.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
})

it('rejects an old captured view when revocation commits before the capture promise returns', async () => {
  const value = await granted()
  const subscription = await readSubscription(value)
  await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const capture = value.a.tasks.currentContextView.bind(value.a.tasks)
  vi.spyOn(value.a.tasks, 'currentContextView').mockImplementationOnce(async (taskId) => {
    const view = await capture(taskId)
    entered.resolve(undefined)
    await release.promise
    return view
  })
  const pending = value.b.access.retrieve(subscription.id, signal())
  await entered.promise
  try {
    expect((await value.a.access.revokeContribution({ grant: value.grant })).status).toBe('ended')
  } finally { release.resolve(undefined) }
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  const recovered = await value.b.access.retrieve(subscription.id, signal())
  expect(recovered.status).toBe('active')
  if (recovered.status === 'active') expect(recovered.projection.text).not.toContain('sku')
})

it('rejects a captured projection when its contributor ends during slow computation', async () => {
  const value = await granted()
  const subscription = await readSubscription(value)
  await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = value.a.backend.compute.bind(value.a.backend)
  vi.spyOn(value.a.backend, 'compute').mockImplementation(async (input) => {
    const result = await compute(input); entered.resolve(undefined); await release.promise; return result
  })
  const pending = value.b.access.retrieve(subscription.id, signal())
  await entered.promise
  try {
    expect((await value.b.access.endContribution({ invitation: value.invitation }, signal())).status).toBe('ended')
  } finally { release.resolve(undefined) }
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
})

it('keeps an end slot available when its ordinary reads and change waits reach capacity', async () => {
  const value = await granted()
  await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  const stops = new AbortController()
  const waits: Array<Promise<unknown>> = []
  for (let index = 0; index < config.maxConcurrentWaits; index++) {
    const subscription = await readSubscription(value)
    const aligned = await value.b.access.waitForChange(subscription.id, undefined, signal())
    if (aligned.status !== 'changed') throw new Error('expected initial cursor')
    const entered = Promise.withResolvers<undefined>()
    const original = value.a.tasks.contextView.bind(value.a.tasks)
    const read = vi.spyOn(value.a.tasks, 'contextView').mockImplementation((id) => { entered.resolve(undefined); return original(id) })
    waits.push(value.b.access.waitForChange(subscription.id, aligned.cursor, stops.signal).catch((error: unknown) => error))
    await entered.promise
    read.mockRestore()
  }
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = value.a.backend.compute.bind(value.a.backend)
  let computations = 0
  vi.spyOn(value.a.backend, 'compute').mockImplementation(async (input) => {
    const output = await compute(input)
    computations++
    if (computations === 4) entered.resolve(undefined)
    await release.promise
    return output
  })
  const subscriptions = await Promise.all(Array.from({ length: 4 }, () => readSubscription(value)))
  const reads = subscriptions.map(item => value.b.access.retrieve(item.id, signal()))
  await entered.promise
  try {
    expect(value.b.transport.outbound).toBe(7)
    await expect(value.b.access.contributionStatus({ invitation: value.invitation }, signal())).resolves.toEqual({ status: 'capacity' })
    const ended = await value.b.access.endContribution({ invitation: value.invitation }, signal())
    expect(ended.status).toBe('ended')
    expect(value.a.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
  } finally { stops.abort(); release.resolve(undefined) }
  expect(await Promise.all(reads)).toEqual(Array.from({ length: 4 }, () => ({ status: 'unavailable' })))
  await Promise.all(waits)
})

it('bounds complete contribution requests and replies without exposing unrelated Task history', async () => {
  const value = await granted()
  await value.a.createTask('PRIVATE-CANARY')
  const oversized: ScopeContributionSample = { ...sample(2), result: { state: 'valid', sha256: 'a'.repeat(64), facts: {
    requestBodyRequired: true, requiredRequestFields: Array.from({ length: 300 }, (_, index) => `field-${String(index)}-${'x'.repeat(64)}`),
    responseStatuses: ['201'], deprecated: false,
  } } }
  const revision = value.a.tasks.get({ taskId: value.task.id }).revision
  await expect(value.b.access.contribute({ invitation: value.invitation, sample: oversized }, signal())).rejects.toThrow('request exceeds budget')
  expect(value.a.tasks.get({ taskId: value.task.id }).revision).toBe(revision)
  const result = await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(config.maxResponseBytes)
  expect(JSON.stringify(result)).not.toContain('PRIVATE-CANARY')
  value.b.transport.transform = response => ({ response, extra: 'x'.repeat(config.maxResponseBytes) })
  await expect(value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())).rejects.toThrow('response exceeds budget')
})

it.each(['request', 'response'] as const)('rejects an invitation whose terminal %s cannot fit before opening authority', async (limit) => {
  const a = await host('peer-a', undefined, limit === 'request' ? { maxContributionRequestBytes: 256 } : { maxResponseBytes: 128 })
  const task = await a.createTask()
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: task.id, grantId: randomUUID(), generation: randomUUID(),
    ownerPeerId: peer('peer-a'), contributorPeerId: peer('peer-b'), captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { name: 'orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 50_000, maxSamples: 16, maxSampleBytes: 128 })
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const revision = a.tasks.get({ taskId: task.id }).revision
  await expect(a.access.inviteContribution({ ownerAddress, grant })).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
  expect(a.tasks.get({ taskId: task.id }).revision).toBe(revision)
})

it('leaves an offline or cancelled contribution unconfirmed and removes its protocol on disposal', async () => {
  const { a, b, invitation } = await granted()
  const abort = new AbortController()
  abort.abort(new Error('capture stopped'))
  await expect(b.access.contribute({ invitation, sample: sample() }, abort.signal)).rejects.toThrow('capture stopped')
  await a.ctx.fiber.dispose()
  expect(a.transport.handlers.has('/agentharness/scope-contribute/1')).toBe(false)
  await expect(b.access.endContribution({ invitation }, signal())).resolves.toEqual({ status: 'unavailable' })
})

it('keeps original sample and terminal receipts across service restart from the committed Task log', async () => {
  const value = await granted()
  const first = await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  if (first.status !== 'accepted') throw new Error('expected committed sample')
  const events = value.a.tasks.log()
  await value.a.ctx.fiber.dispose()
  await value.b.ctx.fiber.dispose()
  const a = await host('peer-a', value.a.pool, {}, events)
  const b = await host('peer-b', value.b.pool)
  await expect(b.access.contribute({ invitation: value.invitation, sample: sample() }, signal()))
    .resolves.toEqual({ status: 'reused', receipt: first.receipt })
  expect(a.tasks.log()).toHaveLength(events.length)
  const ended = await b.access.endContribution({ invitation: value.invitation }, signal())
  const closedEvents = a.tasks.log()
  await a.ctx.fiber.dispose()
  const reopened = await host('peer-a', a.pool, {}, closedEvents)
  await expect(b.access.endContribution({ invitation: value.invitation }, signal())).resolves.toEqual(ended)
  await expect(b.access.contribute({ invitation: value.invitation, sample: sample(2) }, signal())).resolves.toEqual(ended)
  expect(reopened.tasks.log()).toHaveLength(closedEvents.length)
})

it('refuses a replaced transport key even when only Task contribution authority survives', async () => {
  const value = await granted()
  const events = value.a.tasks.log()
  await value.a.ctx.fiber.dispose()
  const changed = await host('peer-a', undefined, {}, events)
  vi.spyOn(changed.transport, 'identity').mockResolvedValue({ peerId: peer('replacement-key'), addresses: [] })
  // identity is read after the app-ready continuation, before any independent request can be authorized.
  await expect(changed.access.identity()).rejects.toThrow('different transport key')
  expect(changed.exit).toHaveBeenCalledWith(1)
})

it('commits expiry through the owner queue and wakes a read watch without delivering cached evidence', async () => {
  vi.useFakeTimers()
  const value = await granted()
  const subscription = await readSubscription(value)
  const admitted = await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  if (admitted.status !== 'accepted') throw new Error('expected sample')
  const aligned = await value.b.access.waitForChange(subscription.id, undefined, signal())
  if (aligned.status !== 'changed') throw new Error('expected cursor')
  await vi.advanceTimersByTimeAsync(49_990)
  const entered = Promise.withResolvers<undefined>()
  const contextView = value.a.tasks.contextView.bind(value.a.tasks)
  const observe = vi.spyOn(value.a.tasks, 'contextView').mockImplementation((taskId) => {
    entered.resolve(undefined)
    return contextView(taskId)
  })
  let settled = false
  const pending = value.b.access.waitForChange(subscription.id, aligned.cursor, signal()).then((result) => {
    settled = true
    return result
  })
  await entered.promise
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(11)
  observe.mockRestore()
  expect(value.a.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
  const hint = await pending
  expect(hint.status).toBe('changed')
  const projection = await value.b.access.retrieve(subscription.id, signal())
  expect(projection.status).toBe('active')
  if (projection.status === 'active') expect(projection.projection.text).not.toContain('sku')
  const status = await value.b.access.contributionStatus({ invitation: value.invitation }, signal())
  expect(status).toMatchObject({ status: 'ended', reason: 'expired' })
  await expect(value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal()))
    .resolves.toEqual({ status: 'reused', receipt: admitted.receipt })
  expect((await value.b.access.list()).subscriptions[0]?.state).toBe('active')
})

it('logs one failed expiry attempt without exiting or spinning, then retries on explicit current reads', async () => {
  vi.useFakeTimers()
  const value = await granted()
  const subscription = await readSubscription(value)
  await value.b.access.contribute({ invitation: value.invitation, sample: sample() }, signal())
  const failed = vi.fn()
  const stop = value.a.ctx.on('development-task/persist', async (event) => {
    if (event.change.kind !== 'peer-contribution-ended') return
    failed()
    throw new Error('temporary terminal persistence failure')
  })
  await vi.advanceTimersByTimeAsync(50_020)
  expect(failed).toHaveBeenCalledOnce()
  expect(value.a.exit).not.toHaveBeenCalled()
  await expect(value.b.access.retrieve(subscription.id, signal())).rejects.toThrow('temporary terminal persistence failure')
  expect(failed).toHaveBeenCalledTimes(2)
  stop()
  expect((await value.b.access.retrieve(subscription.id, signal())).status).toBe('active')
  expect(value.a.tasks.peerContributions({ taskId: value.task.id })[0]?.state).toBe('ended')
})
