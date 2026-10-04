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

async function fixture() {
  const suffix = randomUUID()
  const a = await host(`join-owner-${suffix}`)
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
