/** The private observer records real loop requests and refuses incomplete or divergent durable evidence. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Session from '@deepseek-ai/dsh-session'
import * as Catalog from '@deepseek-ai/dsh-session-format-catalog'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockAdapter, textResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'

interface ObserverConfig {
  directory: string
  sessionRoot: string
  maxSessions: number
  expectedRequests: number
  maxRequestBytes: number
  maxSessionBytes: number
  maxEvidenceBytes: number
  drainBudgetMs: number
}
interface ObserverHandle { close(): Promise<void> }
interface ObserverModule {
  installObserver(
    ctx: Context,
    config: ObserverConfig,
    modules: { Llm: typeof Llm; Session: typeof Session; Catalog: typeof Catalog },
  ): Promise<ObserverHandle>
}
// The production plugin stays plain ESM so the built dsh profile does not need a TS loader.
const observer = await import(new URL('./two-device-observer.mjs', import.meta.url).href) as ObserverModule
const verificationSchema = z.object({
  final: z.boolean(), status: z.enum(['running', 'passed', 'failed']), expectedRequests: z.number(),
  observedRequests: z.number(), verifiedRequests: z.number(), activeStreams: z.number(), drainBudgetExceeded: z.boolean(),
  failures: z.array(z.string()),
  sessions: z.array(z.object({ sessionId: z.string(), observedRequests: z.number(), latestTurnId: z.number().nullable(),
    idle: z.boolean(), eventCount: z.number(), path: z.string(), sha256: z.string(), requestReconstruction: z.literal(true) })),
})
const requestSchema = z.object({ index: z.number(), sessionId: z.string(), turn: z.number(), step: z.number(),
  eventCount: z.number(), prefixSha256: z.string(), config: z.record(z.string(), z.unknown()),
  messages: z.array(z.unknown()), tools: z.array(z.unknown()), contextBytes: z.number(), sourceSeqs: z.array(z.unknown()) })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (failures.length > 0) throw new AggregateError(failures, 'observer fixture cleanup failed')
})

async function fixture(overrides: Partial<ObserverConfig> = {}, adapter = new MockAdapter([textResponse('one'), textResponse('two')])) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-two-device-observer-'))
  const ctx = new Context()
  const handles: AgentHandle[] = []
  const owned: { observation?: ObserverHandle } = {}
  let expectedFailure = false
  cleanups.push(async () => {
    const failures: unknown[] = []
    if (owned.observation !== undefined) {
      try { await owned.observation.close() } catch (error) { if (!expectedFailure) failures.push(error) }
    }
    for (const handle of handles.toReversed()) {
      try { await handle.dispose() } catch (error) { failures.push(error) }
    }
    try { await ctx.fiber.dispose() } catch (error) { if (!expectedFailure) failures.push(error) }
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'observer fixture resources did not settle')
  })
  await mountAgentLoopTestDependencies(ctx)
  const config: ObserverConfig = { directory: join(root, 'evidence'), sessionRoot: join(root, 'sessions'), maxSessions: 1,
    expectedRequests: 1, maxRequestBytes: 1048576, maxSessionBytes: 4194304, maxEvidenceBytes: 8388608,
    drainBudgetMs: 15000, ...overrides }
  const persistenceFiber = await ctx.plugin(Jsonl, { root: config.sessionRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const observation = await observer.installObserver(ctx, config, { Llm, Session, Catalog })
  owned.observation = observation
  const handle = await ctx.agents.create({ sessionId: Session.SessionId('observer-session'),
    agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  handles.push(handle)
  const send = async (text: string) => {
    handle.agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await handle.agent.whenIdle()
  }
  const verification = async () => verificationSchema.parse(JSON.parse(await readFile(join(config.directory, 'verification.json'), 'utf8')))
  const requests = async () => (await readFile(join(config.directory, 'requests.jsonl'), 'utf8')).trimEnd().split('\n')
    .filter(line => line.length > 0).map(line => requestSchema.parse(JSON.parse(line)))
  return { root, ctx, agent: handle.agent, config, adapter, observation, persistenceFiber, send, verification, requests,
    allowFailure() { expectedFailure = true } }
}

describe('two-device actual-request observer', () => {
  it('records unchanged full ordinary requests and rebuilds both durable prefixes after each settled turn', async () => {
    const f = await fixture({ expectedRequests: 2 })
    expect(await f.verification()).toMatchObject({ status: 'running', observedRequests: 0 })
    await f.send('private first prompt 字')
    await expect.poll(async () => (await f.verification()).verifiedRequests).toBe(1)
    await f.send('ordinary second prompt')
    await expect.poll(async () => (await f.verification()).verifiedRequests).toBe(2)
    const records = await f.requests()
    expect(records.map(record => [record.index, record.turn, record.step])).toEqual([[0, 1, 1], [1, 2, 1]])
    expect(records.map(record => record.messages)).toEqual(f.adapter.requests.map(request => request.messages))
    expect(records.map(record => record.tools)).toEqual(f.adapter.requests.map(request => request.tools ?? []))
    expect(records.every(record => record.sourceSeqs.length === 0 && record.contextBytes === 0)).toBe(true)
    expect(records[0]?.config).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(records[0]?.prefixSha256).not.toBe(records[1]?.prefixSha256)
    await f.observation.close()
    expect(await f.verification()).toMatchObject({ status: 'passed', final: true, observedRequests: 2, verifiedRequests: 2,
      activeStreams: 0, drainBudgetExceeded: false, failures: [],
      sessions: [{ latestTurnId: 2, idle: true, observedRequests: 2, requestReconstruction: true }] })
    const saved = await f.requests()
    await f.send('after the finite observer interval')
    expect(await f.requests()).toEqual(saved)
  })

  it('fails final verification when the controlled program ended before its expected last request', async () => {
    const f = await fixture({ expectedRequests: 2 })
    f.allowFailure()
    await f.send('only one')
    await expect(f.observation.close()).rejects.toThrow('not fully consumed')
    expect(await f.verification()).toMatchObject({ final: true, status: 'failed', observedRequests: 1 })
  })

  it('rejects an extra actual request before invoking the next model stream', async () => {
    const f = await fixture()
    f.allowFailure()
    await f.send('first')
    await f.send('unexpected second')
    expect(f.adapter.requests).toHaveLength(1)
    await expect(f.observation.close()).rejects.toThrow('extra controlled model request')
    expect(await f.verification()).toMatchObject({ final: true, status: 'failed', observedRequests: 1 })
  })

  it.each(['maxRequestBytes', 'maxEvidenceBytes', 'maxSessionBytes'] as const)('enforces %s before retaining or dispatching a request', async (key) => {
    const f = await fixture({ [key]: 32 })
    f.allowFailure()
    await f.send('字'.repeat(100))
    expect(f.adapter.requests).toHaveLength(0)
    expect(await f.requests()).toEqual([])
    await expect(f.observation.close()).rejects.toThrow('byte limit')
    expect(await f.verification()).toMatchObject({ final: true, status: 'failed', observedRequests: 0 })
  })

  it('refuses a valid JSONL file whose captured prompt changed after the last live check', async () => {
    const f = await fixture()
    f.allowFailure()
    await f.send('PRIVATE_ORIGINAL_123')
    await expect.poll(async () => (await f.verification()).status).toBe('passed')
    const saved = (await f.verification()).sessions[0]
    if (saved === undefined) throw new Error('missing Session artifact')
    const path = join(f.config.sessionRoot, saved.path)
    const original = await readFile(path, 'utf8')
    expect(original).toContain('PRIVATE_ORIGINAL_123')
    await writeFile(path, original.replaceAll('PRIVATE_ORIGINAL_123', 'PRIVATE_TAMPERED_123'))
    await expect(f.observation.close()).rejects.toThrow('persisted request prefix differs')
    expect(await f.verification()).toMatchObject({ status: 'failed', final: true })
  })

  it('marks closing during an active request as failure without cancelling the caller-owned Agent', async () => {
    const f = await fixture({}, new MockAdapter(['hang']))
    f.allowFailure()
    f.agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'held' }] }))
    try {
      await expect.poll(() => f.adapter.requests.length).toBe(1)
      await expect(f.observation.close()).rejects.toThrow('before the observed turn settled')
      expect(f.agent.status).toBe('running')
      expect(await f.verification()).toMatchObject({ status: 'failed', final: true, activeStreams: 1 })
    } finally { f.agent.cancel({ kind: 'user' }); await f.agent.whenIdle() }
  })

  it('verifies the actual durable log after Host teardown removes its Session durability participant', async () => {
    const f = await fixture()
    await f.send('already durable before teardown')
    await expect.poll(async () => (await f.verification()).status).toBe('passed')
    await f.persistenceFiber.dispose()
    expect(await f.ctx.sessions.flush(f.agent.session)).toBe(false)
    await f.observation.close()
    expect(await f.verification()).toMatchObject({ final: true, status: 'passed', verifiedRequests: 1,
      failures: [], sessions: [{ idle: true, requestReconstruction: true }] })
  })

  it.each(['request prefix', 'turn end'] as const)('still rejects missing durable %s after the participant has detached', async (missing) => {
    const f = await fixture()
    f.allowFailure()
    await f.send('must survive teardown')
    await expect.poll(async () => (await f.verification()).status).toBe('passed')
    const saved = (await f.verification()).sessions[0]
    if (saved === undefined) throw new Error('missing Session artifact')
    await f.persistenceFiber.dispose()
    expect(await f.ctx.sessions.flush(f.agent.session)).toBe(false)
    const path = join(f.config.sessionRoot, saved.path)
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ type: 'turn/end' })
    await writeFile(path, (missing === 'request prefix' ? lines.slice(0, 1) : lines.slice(0, -1)).join('\n') + '\n')
    await expect(f.observation.close()).rejects.toThrow(missing === 'request prefix'
      ? 'persisted request prefix differs' : 'before the observed turn settled')
    expect(await f.verification()).toMatchObject({ final: true, status: 'failed' })
  })

  it('verifies only its initial request cut when another turn reaches the stream during flush', async () => {
    const f = await fixture({ expectedRequests: 2 }, new MockAdapter([textResponse('first'), 'hang']))
    const flushed = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    const secondCaptured = Promise.withResolvers<undefined>()
    const persistence = f.ctx.sessionPersistence
    const originalFlush = persistence.flush.bind(persistence)
    const flush = vi.spyOn(persistence, 'flush').mockImplementationOnce(async () => {
      await originalFlush()
      flushed.resolve(undefined)
      await releaseFlush.promise
    })
    const originalCreate = Session.Session.create.bind(Session.Session)
    const create = vi.spyOn(Session.Session, 'create').mockImplementation((...args) => {
      const detached = originalCreate(...args)
      if (args[1]?.some(event => event.type === 'turn/start' && event.data.turn === 2)) secondCaptured.resolve(undefined)
      return detached
    })
    let second: Promise<void> | undefined
    try {
      await f.send('first cut')
      await flushed.promise
      second = f.send('second cut while first flush waits')
      await secondCaptured.promise
      // The second request is real and its Session is durable, but it did not belong to the first verification cut.
      await originalFlush()
      releaseFlush.resolve(undefined)
      await expect.poll(() => f.adapter.requests.length).toBe(2)
      expect(await f.verification()).toMatchObject({ status: 'running', observedRequests: 2, verifiedRequests: 1, failures: [] })
      f.agent.cancel({ kind: 'user' })
      await second
      await expect.poll(async () => (await f.verification()).verifiedRequests).toBe(2)
      await f.observation.close()
      expect(await f.verification()).toMatchObject({ final: true, status: 'passed', verifiedRequests: 2, failures: [] })
    } finally {
      releaseFlush.resolve(undefined)
      f.agent.cancel({ kind: 'user' })
      if (second !== undefined) await second
      create.mockRestore()
      flush.mockRestore()
    }
  })

  it('keeps two independently owned evidence roots and request logs separate', async () => {
    const a = await fixture()
    const b = await fixture()
    await Promise.all([a.send('ONLY_A'), b.send('ONLY_B')])
    await Promise.all([a.observation.close(), b.observation.close()])
    expect(JSON.stringify(await a.requests())).toContain('ONLY_A')
    expect(JSON.stringify(await a.requests())).not.toContain('ONLY_B')
    expect(JSON.stringify(await b.requests())).toContain('ONLY_B')
    expect(JSON.stringify(await b.requests())).not.toContain('ONLY_A')
  })
})
