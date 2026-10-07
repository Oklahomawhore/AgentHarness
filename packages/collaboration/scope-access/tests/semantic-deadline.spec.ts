/** Default native Web request deadlines cover semantic inference over real authenticated TCP. */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-task/types'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import { Config as ConfiguredBackendConfig } from '@deepseek-ai/dsh-development-task-context/configured'
import SemanticBackend, { type Config as SemanticConfig } from '@deepseek-ai/dsh-development-task-context/semantic'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Libp2pTransport from '@deepseek-ai/dsh-scope-transport/libp2p'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import z from 'zod'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScopeAccess, { Config as AccessConfig } from '../src/index.ts'

function parseConfig<T>(schema: Schema<T>, value: unknown): T {
  // Schema.resolve validates unknown YAML; its legacy API does not preserve the schema's generic output type.
  return Schema.resolve(value, schema, {})[0] as T
}

const rows = loadOverlayPatches('dsh', fileURLToPath(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url)))
  .flatMap(patch => patch.insert ?? [])
const accessConfig = parseConfig(AccessConfig, rows.find(row => row.id === 'scope-access')?.config)
const transportConfig = parseConfig(Libp2pTransport.Config, {
  ...z.record(z.string(), z.unknown()).parse(rows.find(row => row.id === 'scope-transport-libp2p')?.config),
  // Only listener allocation differs: each test owns OS-assigned loopback ports and private identity storage.
  listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
})
const auditRows = z.array(z.object({ id: z.string(), config: z.unknown() }))
  .parse(rows.find(row => row.id === 'development-task-context-audit')?.config)
const configuredBackend = parseConfig(ConfiguredBackendConfig, auditRows.find(row => row.id === 'development-task-context-backend')?.config)
const { selection: _selection, ...execution } = configuredBackend
const auditId = SessionId(configuredBackend.auditSessionId)
const canary = 'policy requires exactly one retry'
const inputSchema = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string() })) })
const roots: string[] = []
const contexts: Context[] = []
const cancellations: AbortController[] = []
const pending: Promise<PromiseSettledResult<unknown>[]>[] = []

// The new delayed case deliberately crosses the previous five-second transport deadline.
// Teardown receives the same budget and drains owned requests before removing their private roots.
afterEach(async () => {
  for (const controller of cancellations.splice(0)) controller.abort(new Error('deadline fixture disposed'))
  await Promise.all(pending.splice(0))
  const errors: unknown[] = []
  for (const ctx of contexts.splice(0).reverse()) {
    try { await ctx.fiber.dispose() } catch (error) { errors.push(error) }
  }
  const privateRoots = roots.splice(0)
  if (errors.length === 0) {
    for (const root of privateRoots) {
      try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'semantic deadline fixture cleanup failed')
}, 30_000)

function controller(): AbortController {
  const value = new AbortController()
  cancellations.push(value)
  return value
}

function observe<T>(work: Promise<T>): Promise<T> {
  pending.push(Promise.allSettled([work]))
  return work
}

class ControlledSummary extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered = Promise.withResolvers<undefined>()
  readonly settled = Promise.withResolvers<undefined>()
  firstElapsedMs = 0
  constructor(private readonly first: 'delayed' | 'until-abort', private readonly before: () => Promise<void>) { super() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.before()
    const signal = options.signal
    if (signal === undefined) throw new Error('semantic inference must have a cancellation signal')
    const first = this.requests.length === 1
    const started = performance.now()
    try {
      if (first) {
        this.entered.resolve(undefined)
        if (this.first === 'delayed') {
          // Elapsed time is the subject; this does not stand in for readiness or resource settlement.
          await delay(5500, undefined, { signal })
        } else {
          await new Promise<never>((_resolve, reject) => {
            const cancelled = () => { reject(new Error('controlled summary cancelled', { cause: signal.reason })) }
            if (signal.aborted) { cancelled(); return }
            signal.addEventListener('abort', cancelled, { once: true })
          })
        }
      }
      signal.throwIfAborted()
      const text = options.messages.flatMap(message => message.content
        .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const input = inputSchema.parse(JSON.parse(text))
      const response = {
        version: 1,
        decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
        updates: input.sources.map(source => ({ text: source.body,
          sources: [{ sourceId: source.sourceId, quote: source.body }] })),
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(response) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      if (first) { this.firstElapsedMs = performance.now() - started; this.settled.resolve(undefined) }
    }
  }
}

async function host(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-semantic-deadline-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
  ctx.provide('appExit', (code) => { throw new Error(`unexpected Host exit ${String(code)}`) })
  await ctx.plugin(Credentials, { path: join(root, 'credentials.yml'), dshHome: root, watch: false })
  await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool())))
  const storage = new DomainFacility(ctx, { backend: 'memory' })
  ctx.provide('storageDomain', storage)
  ctx.effect(() => () => storage.closeAll())
  new DevelopmentRoomService(ctx, { nodeId: id, presenceTtlMs: 60_000, maxParticipants: 16, maxRooms: 16, maxTextBytes: 4096 })
  const tasks = new DevelopmentTaskService(ctx, { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
    maxContextBlockBytes: 65536, maxLineageTasks: 16, maxTextBytes: 4096, roomRetryIntervalMs: 10_000 })
  const participantId = `${id}-owner` as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: participantId, kind: 'human', displayName: id })
  const backend = ctx.plugin(TextBackend)
  await backend
  await ctx.plugin(Libp2pTransport, transportConfig)
  const access = new ScopeAccess(ctx, accessConfig)
  await access.identity()
  return { root, ctx, tasks, participantId, backend, access }
}

async function fixture(first: 'delayed' | 'until-abort', maxCalls: number) {
  const owner = await host('owner')
  const receiver = await host('receiver')
  await owner.ctx.plugin(SessionStore)
  await owner.ctx.plugin(LlmRuntime)
  await owner.ctx.plugin(JsonlSessionPersistence, { root: join(owner.root, 'audit'), compression: 'none' })
  const audit = async () => {
    await using reader = await owner.ctx.sessionPersistence.open(auditId, 'read')
    return (await reader.read()).events
  }
  const adapter = new ControlledSummary(first, async () => {
    const events = await audit()
    const requests = events.filter(event => event.type === 'context/semantic-request')
    expect(requests).toHaveLength(adapter.requests.length)
    expect(requests.at(-1)?.data.ordinal).toBe(adapter.requests.length)
    expect(requests.at(-1)?.data.messages).toEqual(adapter.requests.at(-1)?.messages)
  })
  owner.ctx.effect(() => owner.ctx.llm.registerAdapter(['deadline-fixture'], adapter))
  await owner.backend.dispose()
  const semanticConfig: SemanticConfig = { ...execution, provider: 'deadline-fixture', model: 'controlled-summary', maxCalls }
  const semanticFork = owner.ctx.plugin(SemanticBackend, semanticConfig)
  await semanticFork
  const task = await owner.tasks.create({ origin: { kind: 'root' }, objective: 'Implement the client',
    scope: 'The authorized API policy', createdBy: owner.participantId })
  await owner.tasks.publishContext({ taskId: task.id, participantId: owner.participantId, text: canary })
  const ownerIdentity = await owner.access.identity()
  const recipientIdentity = await receiver.access.identity()
  expect(ownerIdentity.peerId).not.toBe(recipientIdentity.peerId)
  const invitation = await owner.access.invite({ taskId: task.id, ownerAddress: ownerIdentity.addresses[0]!,
    recipientPeerId: recipientIdentity.peerId, responsibility: 'Client integration', expiresAt: Date.now() + 120_000 })
  const subscription = await receiver.access.join({ invitation })
  const read = (signal: AbortSignal) => observe(receiver.access.retrieveWithinBudget({
    subscriptionId: subscription.id, maxContextBytes: 7080,
  }, signal))
  return { owner, receiver, adapter, audit, read, task, semanticFork, semanticConfig }
}

it('delivers an audited semantic summary after the old five-second deadline using both Web defaults', async () => {
  expect(execution.timeoutMs).toBe(20_000)
  expect(accessConfig.requestTimeoutMs).toBe(30_000)
  expect(transportConfig.requestTimeoutMs).toBe(35_000)
  expect(transportConfig.connectionTimeoutMs).toBe(5000)
  expect(accessConfig.waitTimeoutMs).toBe(3000)
  const f = await fixture('delayed', 1)
  const result = await f.read(controller().signal)
  await f.adapter.settled.promise
  expect(f.adapter.firstElapsedMs).toBeGreaterThanOrEqual(5000)
  expect(result.status).toBe('active')
  if (result.status !== 'active') throw new Error('a configured summary was cut off by a default peer deadline')
  expect(result.projection.text).toContain(canary)
  expect(result.projection.maxContextBytes).toBe(Math.min(7080, accessConfig.maxContextBytes))
  expect(await f.read(controller().signal)).toEqual(result)
  expect(f.adapter.requests).toHaveLength(1)
  const events = await f.audit()
  expect(events.filter(event => event.type === 'context/semantic-request')).toHaveLength(1)
  expect(events.filter(event => event.type === 'context/semantic-result').map(event => event.data.status)).toEqual(['completed'])
}, 30_000)

it('propagates cancellation through TCP and preserves reserved calls after draining and reopening the provider', async () => {
  const f = await fixture('until-abort', 2)
  const cancellation = controller()
  const request = f.read(cancellation.signal)
  const rejection = expect(request).rejects.toThrow()
  await f.adapter.entered.promise
  cancellation.abort(new Error('the native caller left its binding'))
  await rejection
  await f.adapter.settled.promise
  expect(f.adapter.requests[0]?.signal?.aborted).toBe(true)
  // Provider disposal is the public barrier for both the cancelled job and its final audit flush.
  await f.semanticFork.dispose()
  expect((await f.audit()).filter(event => event.type === 'context/semantic-result')
    .map(event => event.data.status)).toEqual(['failed'])
  await f.owner.ctx.plugin(SemanticBackend, f.semanticConfig)
  const result = await f.read(controller().signal)
  expect(result.status).toBe('active')
  if (result.status !== 'active') throw new Error('cancelled work retained admission or inference capacity')
  expect(result.projection.text).toContain(canary)
  await f.owner.tasks.publishContext({ taskId: f.task.id, participantId: f.owner.participantId, text: 'a later authorized revision' })
  expect((await f.read(controller().signal)).status).toBe('unavailable')
  expect(f.adapter.requests).toHaveLength(2)
  const events = await f.audit()
  expect(events.filter(event => event.type === 'context/semantic-request').map(event => event.data.ordinal)).toEqual([1, 2])
  expect(events.filter(event => event.type === 'context/semantic-result').map(event => event.data.status)).toEqual(['failed', 'completed'])
})
