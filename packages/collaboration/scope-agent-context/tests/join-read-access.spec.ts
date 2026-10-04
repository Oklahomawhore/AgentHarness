import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import ScopeAgentContext from '../src/index.ts'
import { joinReadHistory } from '../src/join-read.ts'
import type { ScopeAgentJoinReadId } from '../src/types.ts'

const directories: string[] = []
const releases: (() => void)[] = []
afterEach(async () => {
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
    { id: 'consumer', name: 'cordis:fixture-consumer', config: { maxContextBytes: 8000, coalesceMs: 1, retryDelayMs: 1000 } },
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

it('recovers an adopted Session cold and leaves only its original durable subscription', async () => {
  const { b, directory, readerName, request, handle } = await fixture()
  expect(await b.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
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
})

const routeOwner = '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy'
const newAddress = `/ip4/127.0.0.1/tcp/2/p2p/${routeOwner}`

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
