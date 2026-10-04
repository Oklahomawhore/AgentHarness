import { randomUUID } from 'node:crypto'
import { cleanup, config, host, peer } from './helpers.ts'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import { afterEach, expect, it, vi } from 'vitest'
import { type MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScopeAccess, { type Config } from '../src/index.ts'
import { readResponseSchema, waitResponseSchema } from '../src/state.ts'
import { projectionDigest } from '../src/schema.ts'
import type { ScopeChangeCursor, ScopeGeneration, ScopeAccessProjection, ScopeSubscriptionId } from '../src/types.ts'

afterEach(cleanup)

async function joined(overrides: Partial<Config> = {}) {
  const a = await host('peer-a', undefined, overrides)
  const b = await host('peer-b')
  const task = await a.createTask()
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: peer('peer-b'),
    ownerAddress: (await a.access.identity()).addresses[0]!, expiresAt: Date.now() + 50_000, responsibility: 'frontend' })
  const subscription = await b.access.join({ invitation })
  return { a, b, task, invitation, subscription }
}

const signal = (): AbortSignal => new AbortController().signal
const projections = (pool: MemoryMediaPool) => pool.media.get('scope_access')!.tables.get('projections') ?? new Map<string, unknown>()

it('reads only an invited Root Task and persists exact text on both Hosts before returning', async () => {
  const { a, b, task, invitation, subscription } = await joined()
  await a.createTask('PRIVATE-CANARY')
  const result = await b.access.retrieve(subscription.id, signal())
  expect(result.status).toBe('active')
  if (result.status !== 'active') throw new Error('expected active projection')
  expect(result.projection).toMatchObject({ version: 2, activation: { kind: 'exact' } })
  expect(result.projection.text).toContain('Shared canary')
  expect(JSON.stringify(result)).not.toContain('PRIVATE-CANARY')
  expect(result.projection.selectedSources).toEqual([{ kind: 'task', taskId: task.id, revision: task.revision }])
  for (const node of [a, b]) {
    expect(projections(node.pool).get(result.projection.projectionId)).toEqual(result.projection)
  }
  expect((await b.access.list()).grants).toEqual([])
  expect(b.tasks.list({ limit: 16 })).toEqual([])
  expect(result.projection.grantGeneration).toBe(invitation.generation)
  await expect(b.access.retrieve(subscription.id, signal())).resolves.toEqual(result)
})

it.each(['peer', 'task', 'generation', 'responsibility'] as const)('denies a mismatched %s before reading any Task', async (field) => {
  const { a, b, invitation, subscription } = await joined()
  const c = await host('peer-c')
  const requestInvitation = { ...invitation,
    ...(field === 'task' ? { taskId: 'private-task' as DevelopmentTaskId } : {}),
    ...(field === 'generation' ? { generation: randomUUID() as ScopeGeneration } : {}),
    ...(field === 'responsibility' ? { responsibility: 'admin' } : {}),
  }
  const read = vi.spyOn(a.tasks, 'contextView')
  const response = await (field === 'peer' ? c : b).transport.request({ peerId: invitation.ownerPeerId,
    address: invitation.ownerAddress }, '/agentharness/scope-read/1', {
    version: 1, requestId: randomUUID(), subscriptionId: subscription.id,
    generation: subscription.generation, invitation: requestInvitation,
  }, signal())
  expect(read).not.toHaveBeenCalled()
  expect(readResponseSchema.parse(response).result).toEqual({ status: 'denied' })
  expect(JSON.stringify(response)).not.toContain(invitation.taskId)
})

it('revokes while computation is pending and never persists or returns the computed text', async () => {
  const { a, b, invitation, subscription } = await joined()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = a.backend.compute.bind(a.backend)
  vi.spyOn(a.backend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return await compute(input)
  })
  const pending = b.access.retrieve(subscription.id, signal())
  await entered.promise
  await a.access.revoke({ grantId: invitation.grantId })
  release.resolve(undefined)
  await expect(pending).resolves.toEqual({ status: 'revoked' })
  expect(projections(a.pool).size).toBe(0)
  expect((await b.access.list()).subscriptions[0]?.state).toBe('revoked')
})

it('keeps an offline subscription unknown and returns no earlier cached facts', async () => {
  const { a, b, subscription } = await joined()
  expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
  await a.ctx.fiber.dispose()
  await expect(b.access.retrieve(subscription.id, signal())).resolves.toEqual({ status: 'unavailable' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('active')
})

it('rejects a delayed active reply after local leave and gives rejoining a new identity', async () => {
  const { b, invitation, subscription } = await joined()
  const arrived = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  b.transport.transform = async (response) => { arrived.resolve(undefined); await release.promise; return response }
  const pending = b.access.retrieve(subscription.id, signal())
  await arrived.promise
  await b.access.leave({ subscriptionId: subscription.id })
  const replacement = await b.access.join({ invitation })
  expect(replacement.id).not.toBe(subscription.id)
  expect(replacement.generation).not.toBe(subscription.generation)
  release.resolve(undefined)
  await expect(pending).resolves.toEqual({ status: 'left' })
  expect(projections(b.pool).size).toBe(0)
})

it.each(['taskId', 'ownerPeerId', 'recipientPeerId', 'grantGeneration', 'coverage', 'requestId'] as const)(
  'rejects a wire response with wrong %s before receiver persistence', async (field) => {
    const { b, subscription } = await joined()
    b.transport.transform = (raw) => {
      const response = readResponseSchema.parse(raw)
      if (response.result.status !== 'active') throw new Error('expected active response')
      if (field === 'requestId') return { ...response, requestId: randomUUID() }
      const projection: ScopeAccessProjection = { ...response.result.projection,
        ...(field === 'taskId' ? { taskId: 'another-task' as DevelopmentTaskId, selectedSources: [], omittedSources: [] } : {}),
        ...(field === 'ownerPeerId' ? { ownerPeerId: peer('another-owner') } : {}),
        ...(field === 'recipientPeerId' ? { recipientPeerId: peer('another-recipient') } : {}),
        ...(field === 'grantGeneration' ? { grantGeneration: randomUUID() as ScopeGeneration } : {}),
        ...(field === 'coverage' ? { selectedSources: [{ kind: 'task', taskId: 'private-task' as DevelopmentTaskId, revision: 1 }] } : {}),
      }
      return { ...response, result: { status: 'active', projection: { ...projection, projectionId: projectionDigest(projection) } } }
    }
    await expect(b.access.retrieve(subscription.id, signal())).rejects.toThrow()
    expect(projections(b.pool).size).toBe(0)
    b.transport.transform = undefined
    expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
  },
)

it('rejects backend cross-Task coverage and a complete response over budget', async () => {
  const { a, b, subscription } = await joined()
  vi.spyOn(a.backend, 'compute').mockResolvedValue({ activation: { kind: 'exact' }, text: 'private', selectedSources: [
    { kind: 'task', taskId: 'private-task' as DevelopmentTaskId, revision: 1 },
  ], omittedSources: [] })
  await expect(b.access.retrieve(subscription.id, signal())).rejects.toThrow()
  expect(projections(a.pool).size).toBe(0)
  const small = await joined({ maxResponseBytes: 128 })
  await expect(small.b.access.retrieve(small.subscription.id, signal())).rejects.toThrow('response exceeds budget')
})

it('delivers a captured revision during continuous input and captures new evidence on the next request', async () => {
  const { a, b, task, subscription } = await joined()
  const compute = a.backend.compute.bind(a.backend)
  const controlled = vi.spyOn(a.backend, 'compute').mockImplementation(async (input) => {
    const result = await compute(input)
    await a.tasks.publishContext({ taskId: task.id, participantId: a.participantId, text: 'new evidence' })
    return result
  })
  const first = await b.access.retrieve(subscription.id, signal())
  expect(first.status).toBe('active')
  if (first.status !== 'active') throw new Error('expected captured projection')
  expect(first.projection.taskRevision).toBe(task.revision)
  expect(first.projection.text).not.toContain('new evidence')
  controlled.mockRestore()
  const next = await b.access.retrieve(subscription.id, signal())
  expect(next.status).toBe('active')
  if (next.status !== 'active') throw new Error('expected next projection')
  expect(next.projection.taskRevision).toBeGreaterThan(first.projection.taskRevision)
  expect(next.projection.text).toContain('new evidence')
})

it('retains revocation and receiving withdrawal across restart and rejects transport-key replacement', async () => {
  const { a, b, invitation, subscription } = await joined()
  await b.access.retrieve(subscription.id, signal())
  await a.access.revoke({ grantId: invitation.grantId })
  await b.access.leave({ subscriptionId: subscription.id })
  await a.ctx.fiber.dispose()
  await b.ctx.fiber.dispose()
  const restoredA = await host('peer-a', a.pool)
  const restoredB = await host('peer-b', b.pool)
  expect((await restoredA.access.list()).grants[0]?.state).toBe('revoked')
  await expect(restoredB.access.retrieve(subscription.id, signal())).resolves.toEqual({ status: 'left' })
  await restoredB.ctx.fiber.dispose()
  const changed = await host('new-peer', b.pool)
  await expect(changed.access.list()).rejects.toThrow('different transport key')
  expect(changed.exit).toHaveBeenCalledWith(1)
})

it('keeps grant and projection state unchanged when durability fails, while revocation needs no spare slot', async () => {
  const { a, b, invitation, subscription } = await joined({ maxGrants: 1 })
  a.pool.failNextWrites = 1
  await expect(b.access.retrieve(subscription.id, signal())).rejects.toThrow('injected write failure')
  expect(projections(a.pool).size).toBe(0)
  expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
  a.pool.failNextWrites = 1
  await expect(a.access.revoke({ grantId: invitation.grantId })).rejects.toThrow('injected write failure')
  expect((await a.access.list()).grants[0]?.state).toBe('active')
  await a.access.revoke({ grantId: invitation.grantId })
  await expect(b.access.retrieve(subscription.id, signal())).resolves.toEqual({ status: 'revoked' })
})

it('distinguishes expiration from revocation and refuses a parent-bearing Task', async () => {
  const { a, b, task, invitation, subscription } = await joined()
  const fork = await a.tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: task.revision } },
    objective: 'Fork', scope: 'fork', createdBy: a.participantId })
  await expect(a.access.invite({ ...invitation, taskId: fork.id })).rejects.toThrow('Root Tasks')
  vi.spyOn(Date, 'now').mockReturnValue(invitation.expiresAt)
  await expect(b.access.retrieve(subscription.id, signal())).resolves.toEqual({ status: 'expired' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('expired')
})

it('requires explicit receiver identity when accepting local intent', async () => {
  const { invitation } = await joined()
  const c = await host('peer-c')
  await expect(c.access.join({ invitation })).rejects.toThrow('recipient')
  await expect(c.access.retrieve(randomUUID() as ScopeSubscriptionId, signal())).resolves.toEqual({ status: 'left' })
})

it('does not adopt computation from a provider replaced while its promise is pending', async () => {
  const { a, b, subscription } = await joined()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = a.backend.compute.bind(a.backend)
  vi.spyOn(a.backend, 'compute').mockImplementation(async (input) => {
    const projection = await compute(input)
    entered.resolve(undefined)
    await release.promise
    return projection
  })
  const pending = b.access.retrieve(subscription.id, signal())
  await entered.promise
  await a.backendFork.dispose()
  await a.ctx.plugin(TextBackend)
  release.resolve(undefined)
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  expect(projections(b.pool).size).toBe(0)
  expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
})

it('aborts computation on disposal and waits for it before closing durable state', async () => {
  const { a, b, subscription } = await joined()
  const entered = Promise.withResolvers<undefined>()
  const finished = vi.fn()
  vi.spyOn(a.backend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await new Promise<never>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => { finished(); reject(new Error('backend cancelled')) }, { once: true })
    })
    throw new Error('unreachable')
  })
  const pending = b.access.retrieve(subscription.id, signal()).catch((error: unknown) => error)
  await entered.promise
  await a.ctx.fiber.dispose()
  expect(finished).toHaveBeenCalledOnce()
  expect(await pending).toBeInstanceOf(Error)
  expect(projections(a.pool).size).toBe(0)
})

it('bounds concurrent reads without blocking revocation behind a slow backend', async () => {
  const { a, b, invitation, subscription } = await joined({ maxConcurrentReads: 1 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const compute = a.backend.compute.bind(a.backend)
  vi.spyOn(a.backend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return await compute(input)
  })
  const pending = b.access.retrieve(subscription.id, signal())
  await entered.promise
  const another = await b.access.join({ invitation })
  await expect(b.access.retrieve(another.id, signal())).resolves.toEqual({ status: 'unavailable' })
  await a.access.revoke({ grantId: invitation.grantId })
  release.resolve(undefined)
  await expect(pending).resolves.toEqual({ status: 'revoked' })
})

it('rejects a timer duration that Node would clamp before admitting any read', () => {
  expect(() => ScopeAccess.Config(Object.assign({}, config, { requestTimeoutMs: 2_147_483_648 }))).toThrow()
})

async function cursorOf(access: ScopeAccess, id: ScopeSubscriptionId): Promise<ScopeChangeCursor> {
  const result = await access.waitForChange(id, undefined, signal())
  if (result.status !== 'changed') throw new Error(`expected change cursor, received ${result.status}`)
  return result.cursor
}

function observeOwnerRead(owner: Awaited<ReturnType<typeof host>>) {
  const entered = Promise.withResolvers<undefined>()
  const read = owner.tasks.contextView.bind(owner.tasks)
  const spy = vi.spyOn(owner.tasks, 'contextView').mockImplementation((id) => {
    entered.resolve(undefined)
    return read(id)
  })
  return { entered: entered.promise, restore: () => { spy.mockRestore() } }
}

it('aligns online without facts or projection writes, then returns unchanged at its bounded deadline', async () => {
  const { a, b, subscription } = await joined()
  const compute = vi.spyOn(a.backend, 'compute')
  const cursor = await cursorOf(b.access, subscription.id)
  expect(cursor).toMatch(/^[a-f0-9]{64}$/)
  expect(compute).not.toHaveBeenCalled()
  expect(projections(a.pool).size).toBe(0)
  expect(projections(b.pool).size).toBe(0)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const observed = observeOwnerRead(a)
  const pending = b.access.waitForChange(subscription.id, cursor, signal())
  await observed.entered
  await vi.advanceTimersByTimeAsync(config.waitTimeoutMs)
  await expect(pending).resolves.toEqual({ status: 'unchanged', cursor })
  expect(a.transport.inbound).toBe(0)
})

it('wakes for its committed Task while unrelated commits and retrieval persistence cause no change hint', async () => {
  const { a, b, task, subscription } = await joined()
  const unrelated = await a.createTask('PRIVATE-CANARY')
  const cursor = await cursorOf(b.access, subscription.id)
  const observed = observeOwnerRead(a)
  let settled = false
  const pending = b.access.waitForChange(subscription.id, cursor, signal()).finally(() => { settled = true })
  await observed.entered
  await a.tasks.publishContext({ taskId: unrelated.id, participantId: a.participantId, text: 'private update' })
  expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
  expect(settled).toBe(false)
  await a.tasks.publishContext({ taskId: task.id, participantId: a.participantId, text: 'shared update' })
  const result = await pending
  expect(result.status).toBe('changed')
  if (result.status !== 'changed') throw new Error('expected change')
  expect(result.cursor).not.toBe(cursor)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|shared update|taskId|revision/)
})

it('rechecks current state after listener registration instead of losing an intervening update', async () => {
  const { a, b, task, subscription } = await joined()
  const cursor = await cursorOf(b.access, subscription.id)
  const earlier = a.tasks.contextView(task.id)
  await a.tasks.publishContext({ taskId: task.id, participantId: a.participantId, text: 'committed before listener registration' })
  const latest = a.tasks.contextView(task.id)
  // The first read captures old state; the next read sees the commit without another event.
  const read = vi.spyOn(a.tasks, 'contextView').mockReturnValueOnce(earlier).mockReturnValue(latest)
  const result = await b.access.waitForChange(subscription.id, cursor, signal())
  expect(result.status).toBe('changed')
  expect(read).toHaveBeenCalledTimes(3)
})

it('publishes revocation hints only after durability succeeds and stores the receiver terminal state', async () => {
  const { a, b, invitation, subscription } = await joined()
  const cursor = await cursorOf(b.access, subscription.id)
  const observed = observeOwnerRead(a)
  let settled = false
  const pending = b.access.waitForChange(subscription.id, cursor, signal()).finally(() => { settled = true })
  await observed.entered
  a.pool.failNextWrites = 1
  await expect(a.access.revoke({ grantId: invitation.grantId })).rejects.toThrow('injected write failure')
  expect(settled).toBe(false)
  await a.access.revoke({ grantId: invitation.grantId })
  await expect(pending).resolves.toEqual({ status: 'revoked' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('revoked')
  await expect(b.access.waitForChange(subscription.id, undefined, signal())).resolves.toEqual({ status: 'revoked' })
})

it('ends an authorized wait at expiration without waiting for the longer unchanged deadline', async () => {
  const { a, b, invitation, subscription } = await joined()
  const cursor = await cursorOf(b.access, subscription.id)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(invitation.expiresAt - 100)
  const observed = observeOwnerRead(a)
  const pending = b.access.waitForChange(subscription.id, cursor, signal())
  await observed.entered
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toEqual({ status: 'expired' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('expired')
})

it('reports durable leave when it wins queued expiration admission', async () => {
  const { b, invitation, subscription } = await joined()
  let leaving: Promise<void> | undefined
  vi.spyOn(Date, 'now').mockImplementationOnce(() => {
    leaving = b.access.leave({ subscriptionId: subscription.id })
    return invitation.expiresAt
  })
  await expect(b.access.waitForChange(subscription.id, undefined, signal())).resolves.toEqual({ status: 'left' })
  await leaving
  expect((await b.access.list()).subscriptions[0]?.state).toBe('left')
})

it('replaces only its previous wait, leaving retrieval latest-request identity independent', async () => {
  const { a, b, task, subscription } = await joined()
  const cursor = await cursorOf(b.access, subscription.id)
  const observed = observeOwnerRead(a)
  const first = b.access.waitForChange(subscription.id, cursor, signal()).catch((error: unknown) => error)
  await observed.entered
  const second = b.access.waitForChange(subscription.id, cursor, signal())
  expect(await first).toBeInstanceOf(Error)
  expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
  await a.tasks.publishContext({ taskId: task.id, participantId: a.participantId, text: 'after replacement' })
  expect((await second).status).toBe('changed')
  expect(b.transport.outbound).toBe(0)
})

it('leaves promptly during a wait and rejects a delayed change response after local withdrawal', async () => {
  const { b, subscription } = await joined()
  const arrived = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  b.transport.transform = async (response) => { arrived.resolve(undefined); await release.promise; return response }
  const pending = b.access.waitForChange(subscription.id, undefined, signal())
  await arrived.promise
  await b.access.leave({ subscriptionId: subscription.id })
  release.resolve(undefined)
  await expect(pending).resolves.toEqual({ status: 'left' })
})

it('reserves an ordinary transport slot when change waits reach their independent capacity', async () => {
  const { a, b, invitation, subscription } = await joined({ maxConcurrentReads: 1 })
  const waits: Array<Promise<unknown>> = []
  const abort = new AbortController()
  for (let index = 0; index < config.maxConcurrentWaits; index++) {
    const item = index === 0 ? subscription : await b.access.join({ invitation })
    const cursor = await cursorOf(b.access, item.id)
    const observed = observeOwnerRead(a)
    waits.push(b.access.waitForChange(item.id, cursor, abort.signal).catch((error: unknown) => error))
    await observed.entered
    observed.restore()
  }
  expect(a.transport.inbound).toBe(3)
  expect(b.transport.outbound).toBe(3)
  const excess = await b.access.join({ invitation })
  await expect(b.access.waitForChange(excess.id, undefined, signal())).resolves.toEqual({ status: 'unavailable' })
  expect((await b.access.retrieve(subscription.id, signal())).status).toBe('active')
  await a.access.revoke({ grantId: invitation.grantId })
  expect(await Promise.all(waits)).toEqual([{ status: 'revoked' }, { status: 'revoked' }, { status: 'revoked' }])
  expect(b.transport.outbound).toBe(0)
})

it('settles cancelled and disposed waits, and provider replacement ends an existing wait', async () => {
  const { a, b, subscription } = await joined()
  const cursor = await cursorOf(b.access, subscription.id)
  const observed = observeOwnerRead(a)
  const abort = new AbortController()
  const cancelled = b.access.waitForChange(subscription.id, cursor, abort.signal).catch((error: unknown) => error)
  await observed.entered
  abort.abort(new Error('consumer stopped'))
  expect(await cancelled).toBeInstanceOf(Error)
  observed.restore()
  const replaced = observeOwnerRead(a)
  const pending = b.access.waitForChange(subscription.id, cursor, signal())
  await replaced.entered
  await a.backendFork.dispose()
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  await a.ctx.plugin(TextBackend)
  replaced.restore()
  const disposing = observeOwnerRead(a)
  const last = b.access.waitForChange(subscription.id, cursor, signal()).catch((error: unknown) => error)
  await disposing.entered
  await b.ctx.fiber.dispose()
  expect(await last).toBeInstanceOf(Error)
  expect(a.transport.inbound).toBe(0)
})

it.each(['peer', 'task', 'generation'] as const)('rejects a change wait with mismatched %s before a Task lookup', async (field) => {
  const { a, b, invitation, subscription } = await joined()
  const c = await host('peer-c')
  const lookup = vi.spyOn(a.tasks, 'contextView')
  const response = await (field === 'peer' ? c : b).transport.request({ peerId: invitation.ownerPeerId,
    address: invitation.ownerAddress }, '/agentharness/scope-watch/1', { version: 1, requestId: randomUUID(),
    subscriptionId: subscription.id, generation: subscription.generation, invitation: { ...invitation,
      ...(field === 'task' ? { taskId: 'private-task' } : {}), ...(field === 'generation' ? { generation: randomUUID() } : {}),
    } }, signal())
  expect(lookup).not.toHaveBeenCalled()
  expect(waitResponseSchema.parse(response).result).toEqual({ status: 'denied' })
  expect(JSON.stringify(response)).not.toMatch(/cursor|taskId|private-task/)
})

it.each(['requestId', 'subscriptionId', 'generation', 'cursor', 'unchanged'] as const)(
  'rejects an incorrectly correlated %s wait reply without adopting terminal state', async (field) => {
    const { b, subscription } = await joined()
    b.transport.transform = (raw) => {
      const response = waitResponseSchema.parse(raw)
      if (field === 'cursor') return { ...response, result: { status: 'changed', cursor: 'malformed' } }
      if (field === 'unchanged') return { ...response, result: { status: 'unchanged', cursor: 'a'.repeat(64) } }
      return { ...response, [field]: randomUUID(), result: { status: 'revoked' } }
    }
    await expect(b.access.waitForChange(subscription.id, undefined, signal())).rejects.toThrow()
    expect((await b.access.list()).subscriptions[0]?.state).toBe('active')
  },
)

it.each([{ maxConcurrentWaits: 7 }, { waitTimeoutMs: 5000 }, { requestTimeoutMs: 5001 }])(
  'rejects wait settings that consume all transport capacity or exceed its deadline: %j', async (overrides) => {
    await expect(host('invalid-settings', undefined, overrides)).rejects.toThrow('waits must leave ordinary read and contribution end capacity')
  },
)

it('keeps an offline wait unknown and enforces the complete hint-response byte budget', async () => {
  const { a, b, subscription } = await joined()
  const cursor = await cursorOf(b.access, subscription.id)
  await a.ctx.fiber.dispose()
  await expect(b.access.waitForChange(subscription.id, cursor, signal())).resolves.toEqual({ status: 'unavailable' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('active')
  const small = await joined({ maxResponseBytes: 128 })
  await expect(small.b.access.waitForChange(small.subscription.id, undefined, signal())).rejects.toThrow('response exceeds budget')
})
