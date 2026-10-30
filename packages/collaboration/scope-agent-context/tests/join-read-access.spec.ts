import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import ScopeAgentContext from '../src/index.ts'
import { originalCaptureSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { joinReadHistory } from '../src/join-read.ts'
import { stateSchema } from '../src/state.ts'
import type { ScopeAgentJoinReadId } from '../src/types.ts'

const directories: string[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const release of releases.splice(0)) release()
  try { await cleanup() } finally {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  }
})

class Recorder extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Read complete' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// Transport is controlled; Access, its transactional storage, Agent loop, and Session JSONL writer execute their production methods.
async function mountReceiver(receiver: Awaited<ReturnType<typeof host>>, directory: string) {
  const { ctx } = receiver
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Builtin fixture names keep real Loader entry ownership without emulating Node's internal module loader.
  ctx.loader.builtins['fixture-jsonl'] = JsonlPersistence
  ctx.loader.builtins['fixture-consumer'] = ScopeAgentContext
  const path = join(directory, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { id: 'persistence', name: 'cordis:fixture-jsonl', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { id: 'consumer', name: 'cordis:fixture-consumer', config: { maxContextBytes: 8000, maxLocalContextBytes: 4000, coalesceMs: 1, retryDelayMs: 1000 } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const adapter = new Recorder()
  ctx.llm.registerAdapter(['join-test'], adapter)
  return adapter
}

async function fixture(ownerId?: string) {
  const suffix = randomUUID()
  const a = await host(`join-owner-${suffix}`, undefined, {}, [], peer(ownerId ?? `join-owner-${suffix}`))
  const b = await host(`join-reader-${suffix}`)
  const directory = await mkdtemp(join(tmpdir(), 'scope-join-access-'))
  directories.push(directory)
  const adapter = await mountReceiver(b, directory)
  const task = await a.createTask('Independent scope read')
  await a.tasks.publishContext({ taskId: task.id, participantId: a.participantId, text: 'AUTHORIZED_OWNER_CANARY' })
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('owner address missing')
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: peer(`join-reader-${suffix}`),
    ownerAddress, expiresAt: Date.now() + 50_000, responsibility: 'Review the reported work' })
  const handle = await b.ctx.agents.create({ sessionId: SessionId(randomUUID()),
    agentOptions: { provider: 'join-test', model: 'join-test' } })
  const request = { agentId: handle.agent.id, adoptionId: randomUUID() as ScopeAgentJoinReadId,
    expectedReadStateSeq: -1 as const, invitation }
  return { a, b, adapter, directory, handle, request, readerName: `join-reader-${suffix}` }
}

async function readStored(value: Awaited<ReturnType<typeof host>>, id: SessionId) {
  const handle = await value.ctx.sessionPersistence.open(id, 'read')
  try {
    const seed = await handle.read()
    return Session.fromRestore(id, seed.events, handle.header, handle.inheritedEventCount, seed.eventState)
  } finally { await handle.close() }
}

async function readCursor(value: Awaited<ReturnType<typeof host>>, id: SessionId) {
  const status = await value.ctx.scopeAgentContext.status({ agentId: id })
  if (status.eligibility === 'not-live') throw new Error('fixture Agent must remain live')
  return status.readStateSeq
}

function contextText(request: GenerateOptions): string {
  return request.messages.filter(message => message.role === 'user' && message.source.kind === 'scope-agent-context')
    .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

it('adopts once through real Access and supplies only online-authorized context to the actual request', async () => {
  const value = await fixture()
  const { a, b, handle, request, adapter } = value
  expect(await Promise.all([b.ctx.scopeAgentContext.adoptJoinRead(request), b.ctx.scopeAgentContext.adoptJoinRead(request)]))
    .toEqual([{ status: 'adopted' }, { status: 'adopted' }])
  expect((await b.access.list()).subscriptions).toHaveLength(1)
  const cursor = await readCursor(b, handle.agent.id)
  expect(await b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id,
    adoptionId: request.adoptionId, leaveAdopted: false })).toEqual({ status: 'adopted' })
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the current scope' }] }))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await handle.agent.whenIdle()
  expect(contextText(adapter.requests[0]!)).toContain('AUTHORIZED_OWNER_CANARY')
  expect(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
    .toMatchObject({ data: { reason: { kind: 'completed' } } })
  expect(await readCursor(b, handle.agent.id)).toBe(cursor)
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  expect(joinReadHistory(await readStored(b, handle.agent.id)).records.get(request.adoptionId)?.phase).toBe('adopted')
  expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')
    .map(event => event.data.phase)).toEqual(['planned', 'adopted'])
  await a.access.revoke({ grantId: request.invitation.grantId })
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read after owner revocation' }] }))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
  await handle.agent.whenIdle()
  expect(contextText(adapter.requests[1]!)).not.toContain('AUTHORIZED_OWNER_CANARY')
  expect((await b.access.list()).subscriptions[0]?.state).toBe('revoked')
})

it('waits for real subscription creation before confirming a concurrent departure', async () => {
  const { b, handle, request } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const ensure = b.access.ensureSubscription.bind(b.access)
  const intercepted = vi.spyOn(b.access, 'ensureSubscription').mockImplementation(async (plan) => {
    entered.resolve(undefined)
    await release.promise
    return await ensure(plan)
  })
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request)
  await entered.promise
  let confirmed = false
  const cancelling = b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id,
    adoptionId: request.adoptionId, leaveAdopted: true }).then((result) => { confirmed = true; return result })
  await expect.poll(async () => joinReadHistory(await readStored(b, handle.agent.id)).records.get(request.adoptionId)?.phase).toBe('ended')
  expect(confirmed).toBe(false)
  release.resolve(undefined)
  expect(await cancelling).toEqual({ status: 'ended' })
  expect(await adopting).toEqual({ status: 'ended' })
  expect(intercepted).toHaveBeenCalledTimes(1)
  const [subscription] = (await b.access.list()).subscriptions
  expect(subscription?.state).toBe('left')
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'ended' })
  expect(intercepted).toHaveBeenCalledTimes(1)
  expect(joinReadHistory(await readStored(b, handle.agent.id)).bindingId).toBeNull()
})

it('cancels a held initial plan before either adoption can create a subscription', async () => {
  const { b, handle, request, adapter } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let held = false
  const remove = b.ctx.on('session/flush', async (session) => {
    if (held || session.id !== request.agentId || joinReadHistory(session).records.get(request.adoptionId)?.phase !== 'planned') return
    held = true
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const ensure = vi.spyOn(b.access, 'ensureSubscription')
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request)
  const settlements = [Promise.allSettled([adopting])]
  try {
    await entered.promise
    const cancelling = b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id,
      adoptionId: request.adoptionId, leaveAdopted: true })
    settlements.push(Promise.allSettled([cancelling]))
    release.resolve(undefined)
    expect(await adopting).toEqual({ status: 'ended' })
    expect(await cancelling).toEqual({ status: 'ended' })
    expect(ensure).not.toHaveBeenCalled()
    expect((await b.access.list()).subscriptions).toEqual([])
    expect((await readStored(b, request.agentId)).snapshotEvents()
      .filter(event => event.type === 'scope-agent-context/join-read').map(event => event.data.phase)).toEqual(['planned', 'ended'])
    expect(adapter.requests).toEqual([])
  } finally { release.resolve(undefined); await Promise.all(settlements); remove(); ensure.mockRestore() }
})

it('shares one pending real subscription creation between concurrent adoption retries', async () => {
  const { b, handle, request, adapter } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const ensure = b.access.ensureSubscription.bind(b.access)
  const creating = vi.spyOn(b.access, 'ensureSubscription').mockImplementation(async (plan) => {
    entered.resolve(undefined)
    await release.promise
    return await ensure(plan)
  })
  const adopting = Promise.all([b.ctx.scopeAgentContext.adoptJoinRead(request), b.ctx.scopeAgentContext.adoptJoinRead(request)])
  const settled = Promise.allSettled([adopting])
  try {
    await entered.promise
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
      expectedReadStateSeq: await readCursor(b, handle.agent.id), ownerAddress: request.invitation.ownerAddress }))
      .toEqual({ status: 'ended' })
    expect(creating).toHaveBeenCalledOnce()
    expect((await b.access.list()).subscriptions).toEqual([])
    release.resolve(undefined)
    expect(await adopting).toEqual([{ status: 'adopted' }, { status: 'adopted' }])
    expect(creating).toHaveBeenCalledOnce()
    expect((await b.access.list()).subscriptions).toHaveLength(1)
    expect((await readStored(b, request.agentId)).snapshotEvents()
      .filter(event => event.type === 'scope-agent-context/join-read').map(event => event.data.phase)).toEqual(['planned', 'adopted'])
    expect(adapter.requests).toEqual([])
  } finally { release.resolve(undefined); await settled; creating.mockRestore() }
})

it('completes a pending departure after subscription creation fails', async () => {
  const { b, handle, request } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const failure = new Error('receiving subscription creation failed')
  const ensure = vi.spyOn(b.access, 'ensureSubscription').mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    throw failure
  })
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request)
  const adoption = Promise.allSettled([adopting])
  const settlements = [adoption]
  try {
    await entered.promise
    let confirmed = false
    const cancelling = b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id, adoptionId: request.adoptionId,
      leaveAdopted: true }).then((result) => { confirmed = true; return result })
    settlements.push(Promise.allSettled([cancelling]))
    await expect.poll(async () => joinReadHistory(await readStored(b, handle.agent.id)).records.get(request.adoptionId)?.phase).toBe('ended')
    // A terminal route operation shares the Session queue without waiting for subscription creation.
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
      expectedReadStateSeq: await readCursor(b, handle.agent.id), ownerAddress: request.invitation.ownerAddress }))
      .toEqual({ status: 'ended' })
    expect(confirmed).toBe(false)
    release.resolve(undefined)
    expect(await adoption).toEqual([{ status: 'rejected', reason: failure }])
    expect(await cancelling).toEqual({ status: 'ended' })
    expect((await b.access.list()).subscriptions).toEqual([])
    expect(joinReadHistory(await readStored(b, handle.agent.id)).bindingId).toBeNull()
  } finally { release.resolve(undefined); await Promise.all(settlements); ensure.mockRestore() }
})

it.each(['adoption', 'cancellation'] as const)(
  'refuses to continue %s in a replacement Session that does not own the original join', async (operation) => {
    const { b, handle, request, adapter } = await fixture(routeOwner)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    releases.push(() => { release.resolve(undefined) })
    const ensure = b.access.ensureSubscription.bind(b.access)
    const ensuring = vi.spyOn(b.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
      const subscription = await ensure(plan)
      entered.resolve(undefined)
      await release.promise
      return subscription
    })
    const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request)
    const settlements = [Promise.allSettled([adopting])]
    let removeReplacement: (() => void | Promise<void>) | undefined
    try {
      await entered.promise
      const cancelling = operation === 'cancellation' ? b.ctx.scopeAgentContext.cancelJoinRead({
        agentId: request.agentId, adoptionId: request.adoptionId, leaveAdopted: true,
      }) : undefined
      if (cancelling !== undefined) {
        settlements.push(Promise.allSettled([cancelling]))
        expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId,
          adoptionId: request.adoptionId, expectedReadStateSeq: request.expectedReadStateSeq,
          ownerAddress: request.invitation.ownerAddress })).toEqual({ status: 'ended' })
      }
      await handle.dispose()
      const before = await b.ctx.sessionPersistence.open(request.agentId, 'read')
      let original: Awaited<ReturnType<typeof before.read>>
      try { original = await before.read() } finally { await before.close() }
      const replacement = b.ctx.sessions.prepare(request.agentId)
      removeReplacement = b.ctx.effect(() => b.ctx.sessions.enter(replacement))
      b.ctx.sessions.announce(replacement)
      expect(b.ctx.sessions.get(request.agentId)).toBe(replacement)
      expect(b.ctx.agents.get(request.agentId)).toBeUndefined()
      release.resolve(undefined)
      await expect(adopting).rejects.toThrow('adoption plan disappeared')
      if (cancelling !== undefined) await expect(cancelling).rejects.toThrow('cancellation lost its terminal record')
      expect(replacement.snapshotEvents()).toEqual([])
      const after = await b.ctx.sessionPersistence.open(request.agentId, 'read')
      try { expect(await after.read()).toEqual(original) } finally { await after.close() }
      expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['active'])
      expect(adapter.requests).toEqual([])
    } finally {
      release.resolve(undefined)
      await Promise.all(settlements)
      await removeReplacement?.()
      ensuring.mockRestore()
      await b.ctx.scopeAgentContext.cancelJoinRead({ agentId: request.agentId,
        adoptionId: request.adoptionId, leaveAdopted: true })
      expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['left'])
    }
  },
)

it('admits ordinary work with withdrawal while the adopted checkpoint is still pending', async () => {
  const { b, handle, request, adapter } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let held = false
  const remove = b.ctx.on('session/flush', async (session) => {
    if (held || session.id !== handle.agent.id || joinReadHistory(session).records.get(request.adoptionId)?.phase !== 'adopted') return
    held = true
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request)
  const settled = Promise.allSettled([adopting])
  try {
    await entered.promise
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary work before receiving checkpoint' }] }))
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(contextText(adapter.requests[0]!)).toContain('(unavailable)')
    expect(contextText(adapter.requests[0]!)).not.toContain('AUTHORIZED_OWNER_CANARY')
    expect(handle.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/request')).toBe(false)
    release.resolve(undefined)
    expect(await adopting).toEqual({ status: 'adopted' })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read after receiving checkpoint' }] }))
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(contextText(adapter.requests[1]!)).toContain('AUTHORIZED_OWNER_CANARY')
  } finally { release.resolve(undefined); await settled; remove() }
})

it('recovers an adopted Session cold and leaves only its original durable subscription', async () => {
  const { b, directory, readerName, request, handle, adapter } = await fixture()
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the authorized shared facts' }] }))
  await handle.agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(contextText(adapter.requests[0]!)).toContain('AUTHORIZED_OWNER_CANARY')
  const before = await b.access.list()
  const original = before.subscriptions[0]
  if (original === undefined) throw new Error('original subscription missing')
  await b.ctx.fiber.dispose()
  const restored = await host(readerName, b.pool)
  await mountReceiver(restored, directory)
  expect(restored.ctx.agents.get(handle.agent.id)).toBeUndefined()
  expect(await restored.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id,
    adoptionId: request.adoptionId, leaveAdopted: false })).toEqual({ status: 'adopted' })
  expect((await restored.access.list()).subscriptions).toEqual(before.subscriptions)
  expect(await restored.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id,
    adoptionId: request.adoptionId, leaveAdopted: true })).toEqual({ status: 'ended' })
  expect(await restored.access.ensureSubscription(original)).toEqual({ ...original, state: 'left' })
  expect(restored.ctx.agents.get(handle.agent.id)).toBeUndefined()
  expect(restored.ctx.sessions.get(handle.agent.id)).toBeUndefined()
  const final = await readStored(restored, handle.agent.id)
  expect(joinReadHistory(final).bindingId).toBeNull()
  expect(final.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')
    .map(event => event.data.phase)).toEqual(['planned', 'adopted', 'ended'])
  const messages = final.deriveMessages()
  const withdrawal = messages.findIndex(message => message.role === 'user' && message.source.kind === 'scope-agent-context')
  expect(withdrawal).toBeGreaterThan(messages.findIndex(message => message.role === 'assistant'))
  expect(messages[withdrawal]).toMatchObject({ source: { kind: 'scope-agent-context', form: 'withdrawn', reason: 'left' } })
})

it.each(['generation', 'grant'] as const)('rejects cold cancellation when stored subscription %s differs from its Session plan', async (changed) => {
  const { a, b, directory, readerName, request } = await fixture(routeOwner)
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const expectedReadStateSeq = await readCursor(b, request.agentId)
  const original = (await b.access.list()).subscriptions[0]!
  await b.ctx.fiber.dispose()
  const replacement = changed === 'generation'
    ? { ...structuredClone(original), generation: randomUUID() }
    : { ...structuredClone(original), invitation: await a.access.invite({ taskId: request.invitation.taskId,
      recipientPeerId: request.invitation.recipientPeerId, ownerAddress: request.invitation.ownerAddress,
      expiresAt: request.invitation.expiresAt, responsibility: 'Another authorized read' }) }
  // Reopening the unknown medium validates the replacement before comparing it with the independent Session log.
  const medium = b.pool.media.get('scope_access')?.tables.get('subscriptions')
  if (medium === undefined) throw new Error('stored subscriptions missing')
  medium.set(original.id, replacement)
  const restored = await host(readerName, b.pool)
  const adapter = await mountReceiver(restored, directory)
  expect((await restored.access.list()).subscriptions).toEqual([replacement])
  const leaving = vi.spyOn(restored.access, 'leave')
  if (changed === 'grant') {
    const before = await restored.ctx.sessionPersistence.open(request.agentId, 'read')
    let stored: Awaited<ReturnType<typeof before.read>>
    try { stored = await before.read() } finally { await before.close() }
    await expect(restored.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
      expectedReadStateSeq, ownerAddress: newAddress })).rejects.toThrow('read subscription changed authority')
    const after = await restored.ctx.sessionPersistence.open(request.agentId, 'read')
    try { expect(await after.read()).toEqual(stored) } finally { await after.close() }
  }
  await expect(restored.ctx.scopeAgentContext.cancelJoinRead({ agentId: request.agentId,
    adoptionId: request.adoptionId, leaveAdopted: true })).rejects.toThrow('owned join subscription changed identity')
  expect(leaving).not.toHaveBeenCalled()
  expect((await restored.access.list()).subscriptions).toEqual([replacement])
  expect(joinReadHistory(await readStored(restored, request.agentId)).records.get(request.adoptionId)?.phase).toBe('ended')
  expect(restored.ctx.agents.get(request.agentId)).toBeUndefined()
  expect(restored.ctx.sessions.get(request.agentId)).toBeUndefined()
  expect(adapter.requests).toEqual([])
})

it('rejects restored subscription authority drift without changing the recovered Session', async () => {
  const { a, b, directory, readerName, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  const original = (await b.access.list()).subscriptions[0]!
  await b.ctx.fiber.dispose()
  const replacement = { ...structuredClone(original), invitation: await a.access.invite({
    taskId: request.invitation.taskId, recipientPeerId: request.invitation.recipientPeerId,
    ownerAddress: request.invitation.ownerAddress, expiresAt: request.invitation.expiresAt,
    responsibility: 'Another authorized read',
  }) }
  // Access validates the unknown stored value on reopen; the independent JSONL retains the original grant.
  const medium = b.pool.media.get('scope_access')?.tables.get('subscriptions')
  if (medium === undefined) throw new Error('stored subscriptions missing')
  medium.set(original.id, replacement)
  const restored = await host(readerName, b.pool)
  const adapter = await mountReceiver(restored, directory)
  expect((await restored.access.list()).subscriptions).toEqual([replacement])
  const resumed = await restored.ctx.agents.resume({ resumeSessionId: request.agentId,
    agentOptions: { provider: 'join-test', model: 'join-test' } })
  try {
    await restored.ctx.sessions.flush(resumed.agent.session)
    const events = resumed.agent.session.snapshotEvents()
    const baseline = await restored.ctx.sessionPersistence.open(request.agentId, 'read')
    let stored: Awaited<ReturnType<typeof baseline.read>>
    try { stored = await baseline.read() } finally { await baseline.close() }
    await expect(restored.ctx.scopeAgentContext.status({ agentId: request.agentId }))
      .rejects.toThrow('read subscription changed authority')
    await expect(restored.ctx.scopeAgentContext.resume({ agentId: request.agentId,
      expectedBindingId: before.state.binding.id, automatic }))
      .rejects.toThrow('read subscription changed authority')
    expect(resumed.agent.session.snapshotEvents()).toEqual(events)
    await restored.ctx.sessions.flush(resumed.agent.session)
    const after = await restored.ctx.sessionPersistence.open(request.agentId, 'read')
    try { expect(await after.read()).toEqual(stored) } finally { await after.close() }
    expect((await restored.access.list()).subscriptions).toEqual([replacement])
    expect(adapter.requests).toEqual([])
    expect(resumed.agent.status).toBe('idle')
  } finally { await resumed.dispose() }
})

const routeOwner = '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy'
const newAddress = `/ip4/127.0.0.1/tcp/2/p2p/${routeOwner}`

it('ends an actually expired invitation without creating a receiving subscription', async () => {
  const { b, handle, request, adapter } = await fixture()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(request.invitation.expiresAt + 1)
  try {
    expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'ended' })
    expect((await b.access.list()).subscriptions).toEqual([])
    expect(joinReadHistory(await readStored(b, handle.agent.id)).records.get(request.adoptionId))
      .toMatchObject({ phase: 'ended', plan: null })
    expect(adapter.requests).toEqual([])
  } finally { clock.mockRestore() }
})

it('accepts the current route without publishing another durable route selection', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  const state = await b.ctx.scopeAgentContext.bind({ agentId: handle.agent.id, expectedBindingId: null,
    invitation: request.invitation, automatic: null })
  const before = handle.agent.session.snapshotEvents()
  const update = vi.spyOn(b.access, 'updateSubscriptionRoute')
  try {
    expect(await b.ctx.scopeAgentContext.updateRoute({ agentId: handle.agent.id, expectedBindingId: state.binding!.id,
      expectedReadStateSeq: await readCursor(b, handle.agent.id), ownerAddress: request.invitation.ownerAddress })).toEqual(state)
    expect(update).not.toHaveBeenCalled()
    expect(handle.agent.session.snapshotEvents()).toEqual(before)
  } finally { update.mockRestore() }
})

it('recovers the original adoption acknowledgement at its unchanged address without a route write', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = handle.agent.session.snapshotEvents()
  const update = vi.spyOn(b.access, 'updateSubscriptionRoute')
  try {
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
      expectedReadStateSeq: request.expectedReadStateSeq, ownerAddress: request.invitation.ownerAddress }))
      .toEqual({ status: 'updated' })
    expect(update).not.toHaveBeenCalled()
    expect(handle.agent.session.snapshotEvents()).toEqual(before)
    expect((await b.access.list()).subscriptions[0]?.invitation).toEqual(request.invitation)
    expect(adapter.requests).toEqual([])
  } finally { update.mockRestore() }
})

it('does not update an ended Access subscription retained by its original adopted Session', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const subscription = (await b.access.list()).subscriptions[0]!
  await b.access.leave({ subscriptionId: subscription.id })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
    expectedReadStateSeq: await readCursor(b, handle.agent.id), ownerAddress: newAddress })).toEqual({ status: 'ended' })
  expect(handle.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/route')).toBe(false)
  expect((await b.access.list()).subscriptions[0]?.state).toBe('left')
})

it('ends an adopted operation when its real Access subscription was independently left', async () => {
  const { b, handle, request, adapter } = await fixture()
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const subscription = (await b.access.list()).subscriptions[0]!
  await b.access.leave({ subscriptionId: subscription.id })
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'ended' })
  expect((await b.access.list()).subscriptions).toEqual([{ ...subscription, state: 'left' }])
  expect(joinReadHistory(await readStored(b, request.agentId)).bindingId).toBeNull()
  expect((await readStored(b, request.agentId)).snapshotEvents()
    .filter(event => event.type === 'scope-agent-context/join-read').map(event => event.data.phase))
    .toEqual(['planned', 'adopted', 'ended'])
  expect(handle.agent.status).toBe('idle')
  expect(adapter.requests).toEqual([])
})

it('ends a pending adoption when its newly created Access subscription was independently left', async () => {
  const { b, handle, request, adapter } = await fixture()
  const ensure = b.access.ensureSubscription.bind(b.access)
  const ensuring = vi.spyOn(b.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
    const subscription = await ensure(plan)
    await b.access.leave({ subscriptionId: subscription.id })
    return await ensure(plan)
  })
  try {
    expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'ended' })
    expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['left'])
    const history = joinReadHistory(await readStored(b, request.agentId))
    expect(history.bindingId).toBeNull()
    expect(history.records.get(request.adoptionId)).toMatchObject({ phase: 'ended', leaveAdopted: false })
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')
      .map(event => event.data.phase)).toEqual(['planned', 'ended'])
    expect(adapter.requests).toEqual([])
  } finally { ensuring.mockRestore() }
})

it.each(['leave', 'replace'] as const)('does not recover an original route after a manual %s', async (change) => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  if (change === 'leave') await b.ctx.scopeAgentContext.leave({ agentId: request.agentId, expectedBindingId: before.state.binding.id })
  else await b.ctx.scopeAgentContext.bind({ agentId: request.agentId, expectedBindingId: before.state.binding.id,
    invitation: request.invitation, automatic: null })
  const events = handle.agent.session.snapshotEvents()
  const subscriptions = (await b.access.list()).subscriptions
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress }))
    .toEqual({ status: change === 'leave' ? 'ended' : 'superseded' })
  expect(handle.agent.session.snapshotEvents()).toEqual(events)
  expect((await b.access.list()).subscriptions).toEqual(subscriptions)
  expect(adapter.requests).toEqual([])
})

it('does not recover a superseded adoption selected after a manual binding', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.bind({ agentId: request.agentId, expectedBindingId: null,
    invitation: request.invitation, automatic: null })
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'superseded' })
  const events = handle.agent.session.snapshotEvents()
  const subscriptions = (await b.access.list()).subscriptions
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
    expectedReadStateSeq: request.expectedReadStateSeq, ownerAddress: newAddress })).toEqual({ status: 'superseded' })
  expect(handle.agent.session.snapshotEvents()).toEqual(events)
  expect((await b.access.list()).subscriptions).toEqual(subscriptions)
  expect(adapter.requests).toEqual([])
})

it.each(['leave', 'replace'] as const)('preserves a later manual %s when an adopted retry receives its earlier Access result', async (change) => {
  const { b, handle, request, adapter } = await fixture()
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const original = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (original.eligibility === 'not-live' || original.state.binding === null
    || original.state.binding.kind === 'local-task') throw new Error('expected original remote binding')
  const subscriptionId = original.state.binding.subscriptionId
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const ensure = b.access.ensureSubscription.bind(b.access)
  const observing = vi.spyOn(b.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
    const result = await ensure(plan)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const retrying = b.ctx.scopeAgentContext.adoptJoinRead(request)
  const settled = Promise.allSettled([retrying])
  try {
    await entered.promise
    if (change === 'leave') await b.ctx.scopeAgentContext.leave({ agentId: request.agentId, expectedBindingId: original.state.binding.id })
    else await b.ctx.scopeAgentContext.bind({ agentId: request.agentId, expectedBindingId: original.state.binding.id,
      invitation: request.invitation, automatic: null })
    const current = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
    release.resolve(undefined)
    expect(await retrying).toEqual({ status: change === 'leave' ? 'ended' : 'superseded' })
    expect(await b.ctx.scopeAgentContext.status({ agentId: request.agentId })).toEqual(current)
    const subscriptions = (await b.access.list()).subscriptions
    expect(subscriptions.find(item => item.id === subscriptionId)?.state).toBe('left')
    expect(subscriptions.filter(item => item.state === 'active')).toHaveLength(change === 'leave' ? 0 : 1)
    expect(adapter.requests).toEqual([])
    expect(handle.agent.status).toBe('idle')
  } finally { release.resolve(undefined); await settled; observing.mockRestore() }
})

it.each(['selection', 'access-commit'] as const)('does not renew a read grant expiring at route %s', async (stage) => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const expectedReadStateSeq = await readCursor(b, handle.agent.id)
  const update = b.access.updateSubscriptionRoute.bind(b.access)
  const clock = vi.spyOn(Date, 'now')
  const routing = vi.spyOn(b.access, 'updateSubscriptionRoute').mockImplementation(async (route) => {
    clock.mockReturnValue(request.invitation.expiresAt + 1)
    return await update(route)
  })
  try {
    if (stage === 'selection') clock.mockReturnValue(request.invitation.expiresAt + 1)
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
      expectedReadStateSeq, ownerAddress: newAddress })).toEqual({ status: 'ended' })
    expect(routing).toHaveBeenCalledTimes(1)
    const subscription = (await b.access.list()).subscriptions[0]!
    expect(subscription.state).toBe('expired')
    expect(subscription.invitation.ownerAddress).toBe(request.invitation.ownerAddress)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route'))
      .toHaveLength(stage === 'selection' ? 0 : 1)
    expect(adapter.requests).toEqual([])
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after route expiry' }] }))
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(contextText(adapter.requests[0]!)).toContain('(expired)')
    expect(contextText(adapter.requests[0]!)).not.toContain('AUTHORIZED_OWNER_CANARY')
  } finally {
    routing.mockRestore()
    clock.mockRestore()
    await handle.agent.whenIdle()
  }
})

it('lets a manual policy change supersede route consent while Access inventory is being read', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const list = b.access.list.bind(b.access)
  const inventory = vi.spyOn(b.access, 'list').mockImplementationOnce(async () => {
    const result = await list()
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const routing = b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress })
  const settled = Promise.allSettled([routing])
  try {
    await entered.promise
    await b.ctx.scopeAgentContext.pause({ agentId: handle.agent.id, expectedBindingId: before.state.binding.id })
    release.resolve(undefined)
    expect(await routing).toEqual({ status: 'superseded' })
    expect(handle.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/route')).toBe(false)
    expect((await list()).subscriptions[0]?.invitation.ownerAddress).toBe(request.invitation.ownerAddress)
  } finally { release.resolve(undefined); await settled; inventory.mockRestore() }
})

it.each((['flush', 'access'] as const)
  .flatMap(stage => (['leave', 'replace'] as const).map(change => ({ stage, change }))))(
  'lets an actual $change defeat route recovery while $stage is held', async ({ stage, change }) => {
    const { b, handle, request } = await fixture(routeOwner)
    await b.ctx.scopeAgentContext.adoptJoinRead(request)
    const before = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
    if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    releases.push(() => { release.resolve(undefined) })
    let held = false
    const remove = b.ctx.on('session/flush', async (session) => {
      if (stage !== 'flush' || held || session.id !== handle.agent.id
        || !session.snapshotEvents().some(event => event.type === 'scope-agent-context/route')) return
      held = true
      entered.resolve(undefined)
      await release.promise
    }, { global: true })
    const update = b.access.updateSubscriptionRoute.bind(b.access)
    const updating = vi.spyOn(b.access, 'updateSubscriptionRoute').mockImplementation(async (route) => {
      const result = await update(route)
      if (stage === 'access' && !held) { held = true; entered.resolve(undefined); await release.promise }
      return result
    })
    const routing = b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
      expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress })
    const settled = Promise.allSettled([routing])
    try {
      await entered.promise
      if (change === 'leave') {
        expect((await b.ctx.scopeAgentContext.leave({ agentId: handle.agent.id,
          expectedBindingId: before.state.binding.id })).binding).toBeNull()
      } else await b.ctx.scopeAgentContext.bind({ agentId: handle.agent.id,
        expectedBindingId: before.state.binding.id, invitation: request.invitation, automatic: null })
      const selected = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
      release.resolve(undefined)
      expect(await routing).toEqual({ status: change === 'leave' ? 'ended' : 'superseded' })
      expect(await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })).toEqual(selected)
      expect((await b.access.list()).subscriptions[0]?.state).toBe('left')
    } finally { release.resolve(undefined); await settled; remove(); updating.mockRestore() }
  },
)

it('preserves a newer Access route while the Scope route intent awaits flush', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  const original = (await b.access.list()).subscriptions[0]!
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let held = false
  const remove = b.ctx.on('session/flush', async (session) => {
    if (held || session !== handle.agent.session
      || !session.snapshotEvents().some(event => event.type === 'scope-agent-context/route')) return
    held = true
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const routing = b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress })
  const settled = Promise.allSettled([routing])
  try {
    await entered.promise
    expect((await b.access.list()).subscriptions).toEqual([original])
    const newer = await b.access.updateSubscriptionRoute({ ...original, routeRevision: 2 })
    expect(newer).toEqual({ ...original, routeRevision: 2 })
    release.resolve(undefined)
    expect(await routing).toEqual({ status: 'superseded' })
    expect((await b.access.list()).subscriptions).toEqual([newer])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route'))
      .toMatchObject([{ data: { bindingId: before.state.binding.id,
        subscription: { routeRevision: 1, invitation: { ownerAddress: newAddress } } } }])
    const after = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
    if (after.eligibility === 'not-live') throw new Error('expected live binding')
    expect(after.state).toEqual({ ...before.state, binding: { ...before.state.binding,
      invitation: { ...request.invitation, ownerAddress: newAddress } } })
    expect(adapter.requests).toEqual([])
  } finally { release.resolve(undefined); await settled; remove() }
})

it('logs and replays a route-only change without replacing subscription, adoption, policy, or budget', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const initial = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (initial.eligibility === 'not-live' || initial.state.binding === null) throw new Error('expected binding')
  await b.ctx.scopeAgentContext.resume({ agentId: handle.agent.id, expectedBindingId: initial.state.binding.id,
    automatic: { goal: 'Review changed scope', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 } })
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await handle.agent.whenIdle()
  await b.ctx.scopeAgentContext.pause({ agentId: handle.agent.id, expectedBindingId: initial.state.binding.id })
  const before = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected binding')
  expect(before.state.usedBudget).toBe(1)
  const route = { agentId: handle.agent.id, expectedBindingId: before.state.binding.id,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress }
  const updated = await b.ctx.scopeAgentContext.updateRoute(route)
  expect(updated).toEqual({ ...before.state,
    binding: { ...before.state.binding, invitation: { ...request.invitation, ownerAddress: newAddress } } })
  expect(await b.ctx.scopeAgentContext.updateRoute(route)).toEqual(updated)
  expect((await b.access.list()).subscriptions).toHaveLength(1)
  expect(joinReadHistory(await readStored(b, handle.agent.id)).records.get(request.adoptionId)?.plan?.subscription.invitation)
    .toEqual(request.invitation)
  const history = joinReadHistory(await readStored(b, handle.agent.id))
  expect(history.routes.get(before.state.binding.id)?.event.subscription.invitation.ownerAddress).toBe(newAddress)
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use recovered route' }] }))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
  await handle.agent.whenIdle()
  expect(contextText(adapter.requests[1]!)).toContain('AUTHORIZED_OWNER_CANARY')
  await b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id, adoptionId: request.adoptionId, leaveAdopted: true })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ ...route, adoptionId: request.adoptionId })).toEqual({ status: 'ended' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('left')
})

it('does not reuse route consent after a manual policy change', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const status = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (status.eligibility === 'not-live' || status.state.binding === null) throw new Error('expected binding')
  const recovery = { agentId: handle.agent.id, adoptionId: request.adoptionId,
    expectedReadStateSeq: status.readStateSeq, ownerAddress: newAddress }
  await b.ctx.scopeAgentContext.pause({ agentId: handle.agent.id, expectedBindingId: status.state.binding.id })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute(recovery)).toEqual({ status: 'superseded' })
  expect((await b.access.list()).subscriptions[0]?.invitation).toEqual(request.invitation)
})

it('reconciles a durable route after Access storage fails without a second route event', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const expectedReadStateSeq = await readCursor(b, handle.agent.id)
  const recovery = { agentId: handle.agent.id, adoptionId: request.adoptionId, expectedReadStateSeq, ownerAddress: newAddress }
  b.pool.failNextWrites = 1
  await expect(b.ctx.scopeAgentContext.updateJoinReadRoute(recovery)).rejects.toThrow('injected write failure')
  expect((await b.access.list()).subscriptions[0]?.invitation.ownerAddress).toBe(request.invitation.ownerAddress)
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute(recovery)).toEqual({ status: 'updated' })
  expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route')).toHaveLength(1)
  expect((await b.access.list()).subscriptions[0]?.invitation.ownerAddress).toBe(newAddress)
})

it('does not replay a durable route after a departure during the ordinary read checkpoint', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  b.pool.failNextWrites = 1
  await expect(b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress })).rejects.toThrow('injected write failure')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let held = false
  const remove = b.ctx.on('session/flush', async (session) => {
    if (held || session !== handle.agent.session || !session.snapshotEvents().some(event => event.type === 'turn/start')) return
    held = true
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const updating = vi.spyOn(b.access, 'updateSubscriptionRoute')
  handle.agent.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Continue ordinary work while the previous route is pending' }] }))
  try {
    await entered.promise
    expect(adapter.requests).toEqual([])
    expect(updating).not.toHaveBeenCalled()
    expect((await b.ctx.scopeAgentContext.leave({ agentId: request.agentId,
      expectedBindingId: before.state.binding.id })).binding).toBeNull()
    release.resolve(undefined)
    await handle.agent.whenIdle()
    expect(updating).not.toHaveBeenCalled()
    expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['left'])
    expect(adapter.requests).toHaveLength(1)
    expect(contextText(adapter.requests[0]!)).not.toContain('AUTHORIZED_OWNER_CANARY')
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route')).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    remove()
    await handle.agent.whenIdle()
    updating.mockRestore()
  }
})

it('does not checkpoint a queued watch route after departure supersedes its captured binding', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  const route = { agentId: request.agentId, adoptionId: request.adoptionId,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress }
  const accessEntered = Promise.withResolvers<undefined>(), releaseAccess = Promise.withResolvers<undefined>()
  const flushEntered = Promise.withResolvers<undefined>(), releaseFlush = Promise.withResolvers<undefined>()
  releases.push(() => { releaseAccess.resolve(undefined); releaseFlush.resolve(undefined) })
  let accessHeld = false, flushHeld = false, departed = false
  const checkpoints: number[] = [], afterDeparture: number[] = []
  const remove = b.ctx.on('session/flush', async (session) => {
    if (session !== handle.agent.session) return
    checkpoints.push(session.seq)
    if (departed) afterDeparture.push(session.seq)
    if (!accessHeld || flushHeld) return
    flushHeld = true
    flushEntered.resolve(undefined)
    await releaseFlush.promise
  }, { global: true })
  const update = b.access.updateSubscriptionRoute.bind(b.access)
  const updating = vi.spyOn(b.access, 'updateSubscriptionRoute').mockImplementationOnce(async (selection) => {
    const result = await update(selection)
    accessHeld = true
    accessEntered.resolve(undefined)
    await releaseAccess.promise
    return result
  })
  const first = b.ctx.scopeAgentContext.updateJoinReadRoute(route)
  const settlements = [Promise.allSettled([first])]
  try {
    await accessEntered.promise
    const second = b.ctx.scopeAgentContext.updateJoinReadRoute(route)
    settlements.push(Promise.allSettled([second]))
    releaseAccess.resolve(undefined)
    expect(await first).toEqual({ status: 'updated' })
    await flushEntered.promise
    expect(checkpoints).toHaveLength(2)
    expect((await b.ctx.scopeAgentContext.leave({ agentId: request.agentId,
      expectedBindingId: before.state.binding.id })).binding).toBeNull()
    departed = true
    releaseFlush.resolve(undefined)
    expect(await second).toEqual({ status: 'ended' })
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute(route)).toEqual({ status: 'ended' })
    expect(updating).toHaveBeenCalledTimes(1)
    expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['left'])
    expect(afterDeparture).toEqual([])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route')).toHaveLength(1)
    expect(adapter.requests).toEqual([])
  } finally {
    releaseAccess.resolve(undefined)
    releaseFlush.resolve(undefined)
    await Promise.all(settlements)
    remove()
    updating.mockRestore()
  }
})

it('finishes a pending original adoption at its new route while retaining the initial plan', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  vi.spyOn(b.access, 'ensureSubscription').mockRejectedValueOnce(new Error('temporary storage unavailable'))
  await expect(b.ctx.scopeAgentContext.adoptJoinRead(request)).rejects.toThrow('temporary storage unavailable')
  const rebased = { ...request, invitation: { ...request.invitation, ownerAddress: newAddress } }
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(rebased)).toEqual({ status: 'adopted' })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
    expectedReadStateSeq: request.expectedReadStateSeq, ownerAddress: newAddress })).toEqual({ status: 'updated' })
  expect(joinReadHistory(handle.agent.session).records.get(request.adoptionId)?.plan?.subscription.invitation).toEqual(request.invitation)
  expect((await b.access.list()).subscriptions[0]?.invitation.ownerAddress).toBe(newAddress)
})

it('ends an original adoption route retry when Access independently leaves during its write', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  const draining = vi.spyOn(b.access, 'updateSubscriptionRoute')
  const waiting = Promise.withResolvers<undefined>()
  const wait = b.access.waitForChange.bind(b.access)
  const watching = vi.spyOn(b.access, 'waitForChange').mockImplementation((...args) => {
    if (args[1] !== undefined) waiting.resolve(undefined)
    return wait(...args)
  })
  const ensuring = vi.spyOn(b.access, 'ensureSubscription').mockRejectedValueOnce(new Error('temporary original route failure'))
  try {
    await expect(b.ctx.scopeAgentContext.adoptJoinRead(request)).rejects.toThrow('temporary original route failure')
    await b.ctx.scopeAgentContext.adoptJoinRead({ ...request, invitation: { ...request.invitation, ownerAddress: newAddress } })
    await waiting.promise
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
      expectedReadStateSeq: request.expectedReadStateSeq, ownerAddress: newAddress })).toEqual({ status: 'updated' })
    expect(draining.mock.calls.length).toBeGreaterThanOrEqual(3)
    draining.mockRestore()
    const update = b.access.updateSubscriptionRoute.bind(b.access)
    const updating = vi.spyOn(b.access, 'updateSubscriptionRoute').mockImplementationOnce(async (route) => {
      await b.access.leave({ subscriptionId: route.id })
      return await update(route)
    })
    try {
      expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: request.agentId, adoptionId: request.adoptionId,
        expectedReadStateSeq: request.expectedReadStateSeq, ownerAddress: newAddress })).toEqual({ status: 'ended' })
      expect(updating).toHaveBeenCalledTimes(1)
      expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['left'])
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route')).toHaveLength(1)
      expect(adapter.requests).toEqual([])
    } finally { updating.mockRestore() }
  } finally { watching.mockRestore(); ensuring.mockRestore(); draining.mockRestore() }
})

it('retains a capture association when a pending adoption resumes at a new route', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  const originalCapture = originalCaptureSchema.parse({ captureId: randomUUID(), captureGeneration: randomUUID() })
  const associated = { ...request, originalCapture }
  const ensuring = vi.spyOn(b.access, 'ensureSubscription').mockRejectedValueOnce(new Error('temporary capture storage unavailable'))
  try {
    await expect(b.ctx.scopeAgentContext.adoptJoinRead(associated)).rejects.toThrow('temporary capture storage unavailable')
    expect(await b.ctx.scopeAgentContext.adoptJoinRead({ ...associated,
      invitation: { ...request.invitation, ownerAddress: newAddress } })).toEqual({ status: 'adopted' })
    const subscription = (await b.access.list()).subscriptions[0]!
    expect(subscription).toMatchObject({ version: 2, originalCapture, routeRevision: 1,
      invitation: { ownerAddress: newAddress } })
    const history = joinReadHistory(await readStored(b, request.agentId))
    expect(history.records.get(request.adoptionId)).toMatchObject({ version: 4, phase: 'adopted',
      plan: { subscription: { version: 2, originalCapture, invitation: request.invitation } } })
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route'))
      .toMatchObject([{ data: { version: 2, subscription: { version: 2, originalCapture } } }])
    expect(adapter.requests).toEqual([])
  } finally { ensuring.mockRestore() }
})

it('reports native route recovery as superseded when Access independently ends the read at commit', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  const update = b.access.updateSubscriptionRoute.bind(b.access)
  const updating = vi.spyOn(b.access, 'updateSubscriptionRoute').mockImplementationOnce(async (route) => {
    await b.access.leave({ subscriptionId: route.id })
    return await update(route)
  })
  try {
    await expect(b.ctx.scopeAgentContext.updateRoute({ agentId: request.agentId,
      expectedBindingId: before.state.binding.id, expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress }))
      .rejects.toMatchObject({ code: 'scope-agent/superseded' })
    expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['left'])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/route')).toHaveLength(1)
    expect(adapter.requests).toEqual([])
  } finally { updating.mockRestore() }
})

it('rejects a completed native route response after the owning Agent is disposed', async () => {
  const { b, handle, request, adapter } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected adopted binding')
  const update = b.access.updateSubscriptionRoute.bind(b.access)
  const updating = vi.spyOn(b.access, 'updateSubscriptionRoute').mockImplementationOnce(async (route) => {
    const result = await update(route)
    await handle.dispose()
    return result
  })
  try {
    await expect(b.ctx.scopeAgentContext.updateRoute({ agentId: request.agentId,
      expectedBindingId: before.state.binding.id, expectedReadStateSeq: before.readStateSeq, ownerAddress: newAddress }))
      .rejects.toMatchObject({ code: 'scope-agent/not-live' })
    expect(b.ctx.agents.get(request.agentId)).toBeUndefined()
    expect((await b.access.list()).subscriptions[0]?.invitation.ownerAddress).toBe(newAddress)
    expect(adapter.requests).toEqual([])
  } finally { updating.mockRestore() }
})

it('recovers a cold existing read route without starting an Agent and cancellation still owns the original subscription', async () => {
  const { b, directory, readerName, request, handle } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const expectedReadStateSeq = await readCursor(b, handle.agent.id)
  const [original] = (await b.access.list()).subscriptions
  if (original === undefined) throw new Error('missing subscription')
  await b.ctx.fiber.dispose()
  const restored = await host(readerName, b.pool)
  await mountReceiver(restored, directory)
  expect(await restored.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: handle.agent.id, adoptionId: request.adoptionId,
    expectedReadStateSeq, ownerAddress: newAddress })).toEqual({ status: 'updated' })
  expect(restored.ctx.agents.get(handle.agent.id)).toBeUndefined()
  expect((await restored.access.list()).subscriptions).toEqual([{ ...original, routeRevision: 1,
    invitation: { ...original.invitation, ownerAddress: newAddress } }])
  expect(await restored.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id, adoptionId: request.adoptionId,
    leaveAdopted: true })).toEqual({ status: 'ended' })
  expect((await restored.access.list()).subscriptions[0]?.state).toBe('left')
})

it('supersedes cold legacy route recovery when a local Task state reuses the adopted remote binding UUID', async () => {
  const { b, request, handle, adapter } = await fixture(routeOwner)
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const records = handle.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')
  const planned = records.find(event => event.data.phase === 'planned')
  const adopted = records.find(event => event.data.phase === 'adopted')
  if (planned?.data.version !== 1 || planned.data.phase !== 'planned'
    || adopted?.data.version !== 1 || adopted.data.phase !== 'adopted') throw new Error('expected real legacy passive adoption')
  expect(adopted.data.plan).toEqual(planned.data.plan)

  const session = Session.create(SessionId(randomUUID()))
  const participantId = developmentAgentParticipantId(session.id)
  await b.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Cold local Agent' })
  const task = await b.createTask('Separate local responsibility')
  const checked = await b.tasks.checkout({ taskId: task.id, participantId })
  const epoch = b.tasks.assignmentLog().findLast(event => event.participantId === participantId && event.change.kind === 'task-bound')
  if (epoch === undefined) throw new Error('missing real local Task assignment epoch')
  session.append('scope-agent-context/join-read', { ...planned.data, agentId: session.id })
  session.append('scope-agent-context/join-read', { ...adopted.data, agentId: session.id })
  // Legacy persisted rows permit UUID reuse across binding kinds; current capture-origin rows prohibit it.
  const local = stateSchema.parse({ version: 2, agentId: session.id, automatic: null, mode: 'passive', pauseReason: null,
    usedBudget: 0, lastActivationAt: null, pendingActivation: null,
    binding: { kind: 'local-task', id: planned.data.plan.bindingId,
      target: { taskId: task.id, taskBindingId: checked.assignment.bindingId, participantId,
        bindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } } } })
  session.append('scope-agent-context/state', local)
  const writer = await b.ctx.sessionPersistence.create(session.header)
  try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  const readSeed = async () => {
    const reader = await b.ctx.sessionPersistence.open(session.id, 'read')
    try { return { seed: await reader.read(), header: reader.header, inheritedEventCount: reader.inheritedEventCount } }
    finally { await reader.close() }
  }
  const before = await readSeed()
  const detached = Session.fromRestore(session.id, before.seed.events, before.header, before.inheritedEventCount, before.seed.eventState)
  const history = joinReadHistory(detached)
  expect(history.records.get(request.adoptionId)).toMatchObject({ version: 1, phase: 'adopted' })
  expect(history.bindingId).toBe(local.binding?.id)
  const lastState = detached.snapshotEvents().findLast(event => event.type === 'scope-agent-context/state')
  expect(lastState?.data).toEqual(local)
  const inventory = await b.access.list()
  const medium = structuredClone(b.pool.media)
  const ensure = vi.spyOn(b.access, 'ensureSubscription')
  const update = vi.spyOn(b.access, 'updateSubscriptionRoute')
  const leave = vi.spyOn(b.access, 'leave')
  try {
    expect(b.ctx.agents.get(session.id)).toBeUndefined()
    expect(b.ctx.sessions.get(session.id)).toBeUndefined()
    expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ agentId: session.id, adoptionId: request.adoptionId,
      expectedReadStateSeq: history.readStateSeq, ownerAddress: newAddress })).toEqual({ status: 'superseded' })
    expect(ensure).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(leave).not.toHaveBeenCalled()
    expect(await b.access.list()).toEqual(inventory)
    expect(b.pool.media).toEqual(medium)
    expect(await readSeed()).toEqual(before)
    expect(b.ctx.agents.get(session.id)).toBeUndefined()
    expect(b.ctx.sessions.get(session.id)).toBeUndefined()
    expect(adapter.requests).toEqual([])
  } finally { ensure.mockRestore(); update.mockRestore(); leave.mockRestore() }
})

it('does not change Access before route intent flush and lets leave defeat the failed intent', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const expectedReadStateSeq = await readCursor(b, handle.agent.id)
  const route = { agentId: handle.agent.id, adoptionId: request.adoptionId, expectedReadStateSeq, ownerAddress: newAddress }
  const flush = vi.spyOn(b.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('route checkpoint failed'))
  await expect(b.ctx.scopeAgentContext.updateJoinReadRoute(route)).rejects.toThrow('route checkpoint failed')
  flush.mockRestore()
  expect((await b.access.list()).subscriptions[0]?.invitation.ownerAddress).toBe(request.invitation.ownerAddress)
  expect(await b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id, adoptionId: request.adoptionId,
    leaveAdopted: true })).toEqual({ status: 'ended' })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute(route)).toEqual({ status: 'ended' })
  expect((await b.access.list()).subscriptions[0]?.state).toBe('left')
})

it('rejects a stale native route cursor after the same binding moves A to B to A', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const stale = { agentId: handle.agent.id, adoptionId: request.adoptionId,
    expectedReadStateSeq: await readCursor(b, handle.agent.id), ownerAddress: newAddress }
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute(stale)).toEqual({ status: 'updated' })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute({ ...stale,
    expectedReadStateSeq: await readCursor(b, handle.agent.id), ownerAddress: request.invitation.ownerAddress })).toEqual({ status: 'updated' })
  expect(await b.ctx.scopeAgentContext.updateJoinReadRoute(stale)).toEqual({ status: 'superseded' })
  const [current] = (await b.access.list()).subscriptions
  expect(current?.routeRevision).toBe(2)
  expect(current?.invitation.ownerAddress).toBe(request.invitation.ownerAddress)
  expect(joinReadHistory(await readStored(b, handle.agent.id)).routes.size).toBe(1)
})

it('reports invalid user routes with a typed error and leaves the invitation unchanged', async () => {
  const { b, handle, request } = await fixture(routeOwner)
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  const current = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (current.eligibility === 'not-live' || current.state.binding === null) throw new Error('expected binding')
  await expect(b.ctx.scopeAgentContext.updateRoute({ agentId: handle.agent.id, expectedBindingId: current.state.binding.id,
    expectedReadStateSeq: current.readStateSeq, ownerAddress: newAddress.replace('/tcp/2/', '/tcp/0/') }))
    .rejects.toMatchObject({ code: 'scope-agent/invalid-route' })
  expect((await b.access.list()).subscriptions[0]?.invitation).toEqual(request.invitation)
  expect(handle.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/route')).toBe(false)
})

const automatic = { goal: 'Review authorized updates', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 }

function consumerEntry(value: Awaited<ReturnType<typeof fixture>>) {
  const entry = [...value.b.ctx.loader.entries()].find(item => item.options.name === 'cordis:fixture-consumer')
  if (entry === undefined) throw new Error('missing real Loader consumer entry')
  return entry
}

async function reloadConsumer(value: Awaited<ReturnType<typeof fixture>>) {
  const entry = consumerEntry(value)
  await entry.update({ disabled: true })
  await entry.update({ disabled: false })
  await value.b.ctx.loader.await()
}

it('automatically reads once from an atomic durable adoption and does not undo a later pause on retry', async () => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const request = { ...value.request, automatic }
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await handle.agent.whenIdle()
  expect(contextText(adapter.requests[0]!)).toContain('AUTHORIZED_OWNER_CANARY')
  const status = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (status.eligibility === 'not-live' || status.state.binding === null) throw new Error('missing adopted binding')
  expect(status.state).toMatchObject({ automatic, usedBudget: 1 })
  await b.ctx.scopeAgentContext.pause({ agentId: handle.agent.id, expectedBindingId: status.state.binding.id })
  const paused = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  expect(await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })).toEqual(paused)
  await expect(b.ctx.scopeAgentContext.adoptJoinRead({ ...request, automatic: { ...automatic, activationLimit: 3 } }))
    .rejects.toThrow('changes original inputs')
  const events = (await readStored(b, handle.agent.id)).snapshotEvents()
    .filter(event => event.type === 'scope-agent-context/join-read')
  expect(events.map(event => [event.data.version, event.data.phase])).toEqual([[2, 'planned'], [2, 'adopted']])
  expect(adapter.requests).toHaveLength(1)
})

it('does not reserve or dispatch automatic work before the adopted checkpoint completes', async () => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const remove = b.ctx.on('session/flush', async (session) => {
    if (session.id !== handle.agent.id || joinReadHistory(session).records.get(value.request.adoptionId)?.phase !== 'adopted') return
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead({ ...value.request, automatic })
  try {
    await entered.promise
    vi.useFakeTimers()
    try {
      // Advance the owned scheduler interval while the durability participant remains blocked.
      await vi.advanceTimersByTimeAsync(100)
      const status = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
      if (status.eligibility === 'not-live') throw new Error('Agent must remain live')
      expect(status.state.usedBudget).toBe(0)
      expect(status.state.pendingActivation).toBeNull()
      expect(adapter.requests).toHaveLength(0)
    } finally { vi.useRealTimers() }
  } finally { release.resolve(undefined); remove() }
  expect(await adopting).toEqual({ status: 'adopted' })
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await handle.agent.whenIdle()
})

it('cancels an automatic plan while subscription creation is in flight without enabling it', async () => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const ensure = b.access.ensureSubscription.bind(b.access)
  vi.spyOn(b.access, 'ensureSubscription').mockImplementation(async (plan) => {
    entered.resolve(undefined)
    await release.promise
    return await ensure(plan)
  })
  const request = { ...value.request, automatic }
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request)
  await entered.promise
  const cancelling = b.ctx.scopeAgentContext.cancelJoinRead({ agentId: handle.agent.id,
    adoptionId: request.adoptionId, leaveAdopted: true })
  await expect.poll(() => joinReadHistory(handle.agent.session).records.get(request.adoptionId)?.phase).toBe('ended')
  release.resolve(undefined)
  expect(await cancelling).toEqual({ status: 'ended' })
  expect(await adopting).toEqual({ status: 'ended' })
  expect((await b.access.list()).subscriptions.map(item => item.state)).toEqual(['left'])
  expect(adapter.requests).toHaveLength(0)
  expect(joinReadHistory(await readStored(b, handle.agent.id)).records.get(request.adoptionId))
    .toMatchObject({ version: 2, phase: 'ended', plan: { automatic } })
})

it.each(['consumer-reload', 'agent-replacement'] as const)('invalidates a pending automatic plan after %s', async (change) => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const ensure = vi.spyOn(b.access, 'ensureSubscription').mockRejectedValueOnce(new Error('controlled creation failure'))
  const request = { ...value.request, automatic }
  await expect(b.ctx.scopeAgentContext.adoptJoinRead(request)).rejects.toThrow('controlled creation failure')
  expect(joinReadHistory(handle.agent.session).records.get(request.adoptionId)?.phase).toBe('planned')
  let replacement: Awaited<ReturnType<typeof b.ctx.agents.resume>> | undefined
  if (change === 'consumer-reload') await reloadConsumer(value)
  else {
    await handle.dispose()
    replacement = await b.ctx.agents.resume({ resumeSessionId: request.agentId,
      agentOptions: { provider: 'join-test', model: 'join-test' } })
  }
  try {
    expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'superseded' })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect((await b.access.list()).subscriptions).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
  } finally { await replacement?.dispose() }
})

it('keeps an already adopted automatic binding paused after consumer reload and exact retry', async () => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const request = { ...value.request, automatic }
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await handle.agent.whenIdle()
  await reloadConsumer(value)
  const restored = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (restored.eligibility === 'not-live') throw new Error('Agent must remain live')
  expect(restored.state).toMatchObject({ mode: 'paused', pauseReason: 'restored', usedBudget: 1, automatic })
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  expect(await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })).toEqual(restored)
  expect(adapter.requests).toHaveLength(1)
})

it('treats automatic limits as lifetime totals while allowing an exhausted adopted operation to retry', async () => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const request = { ...value.request, automatic: { ...automatic, activationLimit: 1 } }
  await b.ctx.scopeAgentContext.adoptJoinRead(request)
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await handle.agent.whenIdle()
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const before = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('missing adopted binding')
  expect(before.state.usedBudget).toBe(1)
  await b.ctx.scopeAgentContext.leave({ agentId: handle.agent.id, expectedBindingId: before.state.binding.id })
  const next = { ...request, adoptionId: randomUUID() as ScopeAgentJoinReadId,
    expectedReadStateSeq: await readCursor(b, handle.agent.id) }
  await expect(b.ctx.scopeAgentContext.adoptJoinRead(next)).rejects.toThrow('absolute activation budget')
  expect(joinReadHistory(handle.agent.session).records.has(next.adoptionId)).toBe(false)
  expect(await b.ctx.scopeAgentContext.adoptJoinRead({ ...next, automatic })).toEqual({ status: 'adopted' })
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
  await handle.agent.whenIdle()
  const final = await b.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (final.eligibility === 'not-live') throw new Error('Agent must remain live')
  expect(final.state.usedBudget).toBe(2)
})


const pendingLifecycles = (['ensure', 'planned-flush', 'adopted-flush'] as const)
  .flatMap(stage => (['consumer-reload', 'agent-replacement'] as const).map(change => ({ stage, change })))

it.each(pendingLifecycles)('does not transfer automatic permission through $change during $stage', async ({ stage, change }) => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const request = { ...value.request, automatic }
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let held = false
  const ensure = b.access.ensureSubscription.bind(b.access)
  const ensured = vi.spyOn(b.access, 'ensureSubscription').mockImplementation(async (plan) => {
    const subscription = await ensure(plan)
    if (stage === 'ensure' && !held) {
      held = true
      entered.resolve(undefined)
      await release.promise
    }
    return subscription
  })
  const remove = b.ctx.on('session/flush', async (session) => {
    if (held || session.id !== request.agentId || stage === 'ensure') return
    const phase = joinReadHistory(session).records.get(request.adoptionId)?.phase
    if (phase !== (stage === 'planned-flush' ? 'planned' : 'adopted')) return
    held = true
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const adopting = b.ctx.scopeAgentContext.adoptJoinRead(request).then(
    result => ({ kind: 'result' as const, result }), (error: unknown) => ({ kind: 'error' as const, error: String(error) }),
  )
  let replacement: Awaited<ReturnType<typeof b.ctx.agents.resume>> | undefined
  try {
    await entered.promise
    const entry = consumerEntry(value)
    const stopping = change === 'consumer-reload' ? entry.update({ disabled: true }) : handle.dispose()
    try {
      await vi.waitFor(() => {
        if (change === 'consumer-reload') expect(b.ctx.get('scopeAgentContext')).toBeUndefined()
        else expect(b.ctx.agents.get(request.agentId)).toBeUndefined()
      })
      expect(adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined) }
    await stopping
    const settled = await adopting
    if (settled.kind === 'result') expect(settled.result.status).not.toBe('adopted')
    if (change === 'consumer-reload') {
      await entry.update({ disabled: false })
      await b.ctx.loader.await()
    } else {
      replacement = await b.ctx.agents.resume({ resumeSessionId: request.agentId,
        agentOptions: { provider: 'join-test', model: 'join-test' } })
    }
    const result = await b.ctx.scopeAgentContext.adoptJoinRead(request)
    const history = joinReadHistory(await readStored(b, request.agentId))
    if (stage === 'adopted-flush') {
      expect(result).toEqual({ status: 'adopted' })
      const status = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
      if (status.eligibility === 'not-live') throw new Error('replacement Agent must be live')
      expect(status.state).toMatchObject({ mode: 'paused', pauseReason: 'restored', automatic, usedBudget: 0 })
      expect(history.records.get(request.adoptionId)?.phase).toBe('adopted')
    } else {
      expect(result).toEqual({ status: 'superseded' })
      expect(history.records.get(request.adoptionId)?.phase).toBe('superseded')
      expect((await b.access.list()).subscriptions.every(subscription => subscription.state === 'left')).toBe(true)
      expect(ensured).toHaveBeenCalledTimes(stage === 'ensure' ? 1 : 0)
    }
    expect(adapter.requests).toHaveLength(0)
  } finally {
    release.resolve(undefined)
    remove()
    await adopting
    await replacement?.dispose()
  }
})

it.each([false, true])('retries a failed adopted checkpoint without replacing the binding or later pause: %s', async (pause) => {
  const value = await fixture()
  const { b, handle, adapter } = value
  const request = { ...value.request, automatic }
  const failure = new Error('controlled adopted checkpoint failure')
  let failed = false
  const remove = b.ctx.on('session/flush', (session) => {
    if (failed || session.id !== request.agentId
      || joinReadHistory(session).records.get(request.adoptionId)?.phase !== 'adopted') return
    failed = true
    throw failure
  }, { global: true })
  try {
    await expect(b.ctx.scopeAgentContext.adoptJoinRead(request)).rejects.toBe(failure)
    const before = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
    if (before.eligibility === 'not-live' || before.state.binding === null) throw new Error('expected original binding')
    expect(before.state.usedBudget).toBe(0)
    expect(adapter.requests).toHaveLength(0)
    if (pause) await b.ctx.scopeAgentContext.pause({ agentId: request.agentId, expectedBindingId: before.state.binding.id })
    const paused = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
    expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
    if (pause) {
      expect(await b.ctx.scopeAgentContext.status({ agentId: request.agentId })).toEqual(paused)
      expect(adapter.requests).toHaveLength(0)
    } else {
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await handle.agent.whenIdle()
      expect(contextText(adapter.requests[0]!)).toContain('AUTHORIZED_OWNER_CANARY')
    }
    expect((await b.access.list()).subscriptions).toHaveLength(1)
    const records = (await readStored(b, request.agentId)).snapshotEvents()
      .filter(event => event.type === 'scope-agent-context/join-read')
    expect(records.map(event => [event.data.version, event.data.phase])).toEqual([[2, 'planned'], [2, 'adopted']])
    expect(joinReadHistory(handle.agent.session).bindingId).toBe(before.state.binding.id)
  } finally { remove() }
})

it.each(['enabled', 'paused', 'changed-policy'] as const)(
  'finishes a failed adopted checkpoint when Stop preserves the read, retaining %s permission', async (permission) => {
    const value = await fixture()
    const { b, handle, adapter } = value
    const request = { ...value.request, automatic }
    const failure = new Error('controlled adopted checkpoint failure before Stop')
    let failed = false
    const remove = b.ctx.on('session/flush', (session) => {
      if (failed || session.id !== request.agentId
        || joinReadHistory(session).records.get(request.adoptionId)?.phase !== 'adopted') return
      failed = true
      throw failure
    }, { global: true })
    try {
      await expect(b.ctx.scopeAgentContext.adoptJoinRead(request)).rejects.toBe(failure)
      const adopted = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
      if (adopted.eligibility === 'not-live' || adopted.state.binding === null) throw new Error('expected adopted binding')
      const bindingId = adopted.state.binding.id
      const changed = { ...automatic, goal: 'Use the later locally approved goal', activationLimit: 3 }
      if (permission === 'paused') await b.ctx.scopeAgentContext.pause({ agentId: request.agentId, expectedBindingId: bindingId })
      if (permission === 'changed-policy') await b.ctx.scopeAgentContext.resume({ agentId: request.agentId,
        expectedBindingId: bindingId, automatic: changed })
      expect(adapter.requests).toHaveLength(0)
      expect(await b.ctx.scopeAgentContext.cancelJoinRead({ agentId: request.agentId,
        adoptionId: request.adoptionId, leaveAdopted: false })).toEqual({ status: 'adopted' })
      if (permission === 'paused') {
        handle.agent.followup(createUserMessage({ source: { kind: 'user' },
          content: [{ type: 'text', text: 'Read manually after keeping the subscription' }] }))
      }
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await handle.agent.whenIdle()
      expect(contextText(adapter.requests[0]!)).toContain('AUTHORIZED_OWNER_CANARY')
      const status = await b.ctx.scopeAgentContext.status({ agentId: request.agentId })
      if (status.eligibility === 'not-live') throw new Error('Agent must remain live')
      expect(status.state).toMatchObject({ mode: permission === 'paused' ? 'paused' : 'enabled',
        automatic: permission === 'changed-policy' ? changed : automatic,
        usedBudget: permission === 'paused' ? 0 : 1, binding: { id: bindingId } })
      expect((await b.access.list()).subscriptions.map(subscription => subscription.state)).toEqual(['active'])
      expect((await readStored(b, request.agentId)).snapshotEvents()
        .filter(event => event.type === 'scope-agent-context/join-read').map(event => event.data.phase))
        .toEqual(['planned', 'adopted'])
    } finally { remove() }
  },
)

it('does not upgrade an original unassociated adoption when retried with a capture identity', async () => {
  const { b, request } = await fixture()
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const subscriptions = (await b.access.list()).subscriptions
  expect(subscriptions).toHaveLength(1)
  expect(subscriptions[0]?.version).toBeUndefined()
  await expect(b.ctx.scopeAgentContext.adoptJoinRead({ ...request,
    originalCapture: originalCaptureSchema.parse({ captureId: randomUUID(), captureGeneration: randomUUID() }) }))
    .rejects.toThrow('retry changes original inputs')
  expect((await b.access.list()).subscriptions).toEqual(subscriptions)
})
