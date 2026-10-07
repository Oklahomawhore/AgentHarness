/** Real LLM and JSONL persistence exercise semantic summaries, durability and lifecycle ownership. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo, type FinishReason } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { DevelopmentTaskContextPublication, DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SemanticBackend, { type Config } from '../src/semantic.ts'
import { prepareSemanticInput, projectSemanticReply, restoreSemanticProjection } from '../src/semantic-input.ts'
import { semanticRequestSchema, semanticResultSchema } from '../src/semantic-schema.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []
const config: Config = { auditSessionId: 'semantic-audit-test', provider: 'fixture', model: 'fixture-model',
  maxInputBytes: 30_000, maxOutputTokens: 1000, maxOutputBytes: 20_000, timeoutMs: 10_000,
  maxConcurrentCalls: 2, maxCalls: 8 }

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function input(label = 'frontend', publications?: readonly DevelopmentTaskContextPublication[]): DevelopmentTaskContextInput {
  return { view: { task: {
    id: 'orders' as DevelopmentTaskContextInput['view']['task']['id'],
    ownerNodeId: 'node' as DevelopmentTaskContextInput['view']['task']['ownerNodeId'], revision: 2,
    origin: { kind: 'root' }, hiddenRoomId: 'room' as DevelopmentTaskContextInput['view']['task']['hiddenRoomId'],
    runtime: 'ready', objective: 'Ship orders', scope: 'Integration',
    createdBy: 'owner' as DevelopmentTaskContextInput['view']['task']['createdBy'], createdAt: 1, updatedAt: 2,
    context: publications ?? [
      { id: 'code', text: 'code: retry limit is 3. unrelated body canary', publishedAt: 1,
        publishedBy: 'author' as DevelopmentTaskContextInput['recipient']['participantId'] },
      { id: 'docs', text: 'docs: never retry a declined payment', publishedAt: 2,
        publishedBy: 'author' as DevelopmentTaskContextInput['recipient']['participantId'] },
    ],
  } }, recipient: { participantId: 'receiver' as DevelopmentTaskContextInput['recipient']['participantId'], sessionLabel: label },
  maxContextBytes: 10_000, signal: new AbortController().signal }
}

function response(options: GenerateOptions): unknown {
  const block = options.messages[0]?.content[0]
  if (block?.type !== 'text') throw new Error('expected one text input')
  const request = JSON.parse(block.text) as { recipient: { sessionLabel: string }; sources: { sourceId: string; body: string }[] }
  const relevant = request.recipient.sessionLabel === 'frontend' ? 'code:' : 'docs:'
  return { version: 1,
    decisions: request.sources.map(source => ({ sourceId: source.sourceId, relevant: source.body.startsWith(relevant) })),
    updates: request.sources.filter(source => source.body.startsWith(relevant)).map(source => ({
      text: relevant === 'code:' ? 'Use three retries for integration.' : 'Do not retry declined payments.',
      sources: [{ sourceId: source.sourceId, quote: source.body.split('. ')[0] }],
    })) }
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  before: ((options: GenerateOptions) => Promise<void>) | undefined
  result: (options: GenerateOptions) => unknown = response
  reasoning = false
  finish: FinishReason | undefined = { kind: 'stop' }
  defaultEffort: string | undefined
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, ...(this.defaultEffort === undefined ? {} : {
      reasoning: { efforts: [{ id: ReasoningEffortId(this.defaultEffort), name: this.defaultEffort }],
        defaultEffort: ReasoningEffortId(this.defaultEffort) },
    }) }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.before?.(options)
    if (this.reasoning) {
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 1, text: 'Select only the relevant source.' }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(this.result(options)) }
    if (this.finish !== undefined) yield { type: 'finish', reason: this.finish }
  }
}

async function harness(options: Partial<Config> = {}, existingRoot?: string, beforeMount?: (ctx: Context) => void) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'semantic-provider-'))
  if (existingRoot === undefined) roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore); await ctx.plugin(LlmRuntime); await ctx.plugin(Jsonl, { root, compression: 'none' })
  const adapter = new Adapter()
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
  beforeMount?.(ctx)
  const fork = ctx.plugin(SemanticBackend, { ...config, ...options })
  await fork
  return { ctx, adapter, root, fork, backend: ctx.developmentTaskContextBackend }
}

it('summarizes two original sources differently by responsibility, preserving exact quotes and omissions', async () => {
  const value = await harness()
  const frontend = await value.backend.compute(input())
  const qa = await value.backend.compute(input('qa'))
  expect(frontend.text).toContain('Use three retries for integration.')
  expect(frontend.text).not.toContain('unrelated body canary')
  expect(frontend.text).not.toContain('never retry')
  expect(qa.text).toContain('never retry a declined payment')
  expect(frontend.omittedSources).toEqual([{ source: { kind: 'publication', taskId: 'orders', revision: 2, publicationId: 'docs' }, reason: 'recipient-irrelevant' }])
  expect(value.adapter.requests).toHaveLength(2)
  expect(value.ctx.sessions.list()).toEqual([])
  const reader = await value.ctx.sessionPersistence.open(SessionId(config.auditSessionId), 'read')
  try {
    const events = (await reader.read()).events
    expect(events.map(event => event.type)).toEqual(['context/semantic-request', 'context/semantic-result', 'context/semantic-request', 'context/semantic-result'])
    for (const event of events) {
      if (event.type === 'context/semantic-result') expect(event.data.usage).toBeNull()
    }
  } finally { await reader.close() }
})

it('does not put the original tool body back into summary attribution', () => {
  const grant: DevelopmentTaskPeerContributionGrant = {
    version: 1, taskId: 'orders' as DevelopmentTaskPeerContributionGrant['taskId'],
    ownerPeerId: 'owner' as DevelopmentTaskPeerContributionGrant['ownerPeerId'],
    contributorPeerId: 'source' as DevelopmentTaskPeerContributionGrant['contributorPeerId'],
    grantId: 'grant' as DevelopmentTaskPeerContributionGrant['grantId'], generation: 'generation' as DevelopmentTaskPeerContributionGrant['generation'],
    captureId: 'capture' as DevelopmentTaskPeerContributionGrant['captureId'], captureGeneration: 'capture-generation' as DevelopmentTaskPeerContributionGrant['captureGeneration'],
    source: { kind: 'tool-observations', name: 'work', tools: ['Write'] }, expiresAt: 4_000_000_000_000,
    maxSamples: 10, maxSampleBytes: 20_000,
  }
  const publication: DevelopmentTaskContextPublication = { id: 'write', text: 'retry limit is 3. BODY_MUST_NOT_LEAK', publishedAt: 1,
    peerContribution: { version: 1, grant }, peerToolObservation: {
      kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'src/orders.ts', content: 'retry limit is 3. BODY_MUST_NOT_LEAK' }, omissions: [],
      sourceName: 'work', grantId: grant.grantId, sequence: 1, observerPeerId: grant.contributorPeerId,
      sourceId: 'source-id' as NonNullable<DevelopmentTaskContextPublication['peerToolObservation']>['sourceId'],
      capture: { id: grant.captureId, generation: grant.captureGeneration },
    } }
  const evidence = prepareSemanticInput(input('frontend', [publication]))
  const sourceId = evidence.sources[0]?.sourceId
  const projected = projectSemanticReply(evidence, { version: 1, decisions: [{ sourceId, relevant: true }],
    updates: [{ text: 'Use three retries.', sources: [{ sourceId, quote: 'retry limit is 3' }] }] }, 10_000)
  expect(projected.text).not.toContain('BODY_MUST_NOT_LEAK')
  expect(projected.text).toContain('src/orders.ts')
  expect(projected.text).toContain('reportedStatus')
})

it('reuses an exact completed result after closing and reopening the audit writer', async () => {
  const first = await harness()
  const projection = await first.backend.compute(input())
  await first.ctx.fiber.dispose()
  const second = await harness({}, first.root)
  expect(await second.backend.compute(input())).toEqual(projection)
  expect(second.adapter.requests).toHaveLength(0)
})

it('joins a later caller after the first reservation is already durable', async () => {
  const value = await harness()
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  value.adapter.before = async () => { entered.resolve(undefined); await release.promise }
  const first = value.backend.compute(input())
  await entered.promise
  const second = value.backend.compute(input())
  release.resolve(undefined)
  expect(await second).toEqual(await first)
  expect(value.adapter.requests).toHaveLength(1)
})

it('keeps an already reserved request finishable when a different key exhausts the call budget', async () => {
  const value = await harness({ maxCalls: 1 })
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  value.adapter.before = async () => { entered.resolve(undefined); await release.promise }
  const first = value.backend.compute(input())
  await entered.promise
  await expect(value.backend.compute(input('qa'))).rejects.toThrow('maxCalls')
  release.resolve(undefined)
  expect((await first).text).toContain('three retries')
  expect(await value.backend.compute(input())).toEqual(await first)
})

it('retries a recorded model failure within the cumulative call budget', async () => {
  const value = await harness({ maxCalls: 2 })
  value.adapter.result = () => ({ invalid: true })
  await expect(value.backend.compute(input())).rejects.toThrow()
  value.adapter.result = response
  expect((await value.backend.compute(input())).text).toContain('three retries')
  expect(value.adapter.requests).toHaveLength(2)
})

it('rejects incomplete quotes and complete-output budget overflow', async () => {
  const value = await harness()
  value.adapter.result = (options) => {
    const result = response(options) as { updates: { sources: { quote: string }[] }[] }
    const reference = result.updates[0]?.sources[0]
    if (reference === undefined) throw new Error('missing test source')
    reference.quote = 'invented exact quote'
    return result
  }
  await expect(value.backend.compute(input())).rejects.toThrow('exact quote')
  value.adapter.result = response
  await expect(value.backend.compute({ ...input(), maxContextBytes: 100 })).rejects.toThrow('maxContextBytes')
})


async function auditEvents(value: Awaited<ReturnType<typeof harness>>) {
  const handle = await value.ctx.sessionPersistence.open(SessionId(config.auditSessionId), 'read')
  try { return (await handle.read()).events }
  finally { await handle.close() }
}

it('logs resolved reasoning defaults and accepts reasoning blocks without delivering them', async () => {
  const value = await harness()
  value.adapter.defaultEffort = 'high'
  value.adapter.reasoning = true
  const projection = await value.backend.compute(input())
  expect(projection.text).not.toContain('Select only the relevant source.')
  expect(value.adapter.requests[0]?.reasoningEffort).toBe('high')
  const request = (await auditEvents(value)).find(event => event.type === 'context/semantic-request')
  expect(request?.data).toMatchObject({ call: { reasoningEffort: 'high', maxTokens: 1000 } })
})

it('drains the cancelled last-reader job before releasing its audit writer', async () => {
  const value = await harness()
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  value.adapter.before = async (options) => {
    entered.resolve(undefined)
    const signal = options.signal
    if (signal === undefined) throw new Error('missing model cancellation')
    await new Promise<undefined>((resolve) =>{  signal.addEventListener('abort', () =>{  resolve(undefined) }, { once: true }) })
    aborted.resolve(undefined)
    await release.promise
    signal.throwIfAborted()
  }
  const controller = new AbortController()
  const request = value.backend.compute({ ...input(), signal: controller.signal })
  const rejected = expect(request).rejects.toThrow('caller stopped')
  await entered.promise
  controller.abort(new Error('caller stopped'))
  await rejected
  await aborted.promise
  let disposed = false
  const disposal = value.fork.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await disposal
  const events = await auditEvents(value)
  expect(events.filter(event => event.type === 'context/semantic-result').map(event => event.data))
    .toMatchObject([{ status: 'failed', usage: null, projection: null }])
  const writer = await value.ctx.sessionPersistence.open(SessionId(config.auditSessionId), 'write')
  await writer.close()
})

it('rebuilds cached output from the raw reply and refuses a valid-shaped unrelated projection', async () => {
  const value = await harness()
  await value.backend.compute(input())
  const events = await auditEvents(value)
  const recordedRequest = events.find(event => event.type === 'context/semantic-request')
  const recordedResult = events.find(event => event.type === 'context/semantic-result')
  const request = semanticRequestSchema.parse(recordedRequest?.data)
  const result = semanticResultSchema.parse(recordedResult?.data)
  if (result.version !== 3) throw new Error('new computations must persist result version three')
  const projection = result.projection
  if (projection === null) throw new Error('missing completed projection')
  expect(restoreSemanticProjection(request, result)).toEqual(projection)
  expect(() => restoreSemanticProjection(request, { ...result, projection: {
    ...projection, text: 'unrelated but well-formed cached summary',
  } })).toThrow('disagrees')
  expect(() => restoreSemanticProjection({ ...request, maxContextBytes: 100 }, result)).toThrow('maxContextBytes')
  expect(() => restoreSemanticProjection(request, { ...result, projection: {
    ...projection, selectedSources: [],
  } })).toThrow('disagrees')
})

it('preserves an interrupted durable reservation without silently dispatching the same request again', async () => {
  const original = await harness()
  await original.backend.compute(input())
  const request = (await auditEvents(original)).find(event => event.type === 'context/semantic-request')
  if (request === undefined) throw new Error('missing original request')
  const interrupted = await harness()
  await interrupted.fork.dispose()
  const seed = interrupted.ctx.sessions.prepare(SessionId(config.auditSessionId))
  const writer = await interrupted.ctx.sessionPersistence.create(seed.header)
  try { await writer.append([request]); await writer.flush() }
  finally { await writer.close() }
  const reopened = interrupted.ctx.plugin(SemanticBackend, config)
  await reopened
  await expect(interrupted.ctx.developmentTaskContextBackend.compute(input())).rejects.toThrow('unknown interrupted attempt')
  expect(interrupted.adapter.requests).toHaveLength(0)
})


it.each([1, 2])('refuses delivery when JSONL flush %s fails, and only dispatches after the request flush', async (failedFlush) => {
  const value = await harness({}, undefined, (ctx) => {
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
      const handle = await create(header, options)
      const flush = handle.flush.bind(handle)
      let calls = 0
      vi.spyOn(handle, 'flush').mockImplementation(async () => {
        if (++calls === failedFlush) throw new Error('fixture persistence flush failed')
        await flush()
      })
      return handle
    })
  })
  await expect(value.backend.compute(input())).rejects.toThrow('fixture persistence flush failed')
  expect(value.adapter.requests).toHaveLength(failedFlush - 1)
  await expect(value.backend.compute(input())).rejects.toThrow()
  expect(value.adapter.requests).toHaveLength(failedFlush - 1)
})

it('rejects an oversized single model chunk while retaining only its size and digest', async () => {
  const value = await harness({ maxOutputBytes: 100 })
  await expect(value.backend.compute(input())).rejects.toThrow('maxOutputBytes')
  const result = (await auditEvents(value)).find(event => event.type === 'context/semantic-result')
  const record = semanticResultSchema.parse(result?.data)
  expect(record.status).toBe('failed')
  expect(record.projection).toBeNull()
  expect(record.rejectedChunk?.bytes).toBeGreaterThan(100)
  expect(record.rejectedChunk?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(record.rawOutput)).not.toContain('Use three retries')
})

it.each(['missing', 'max-tokens'] as const)('refuses a complete-looking JSON reply with %s finish', async (kind) => {
  const value = await harness()
  value.adapter.finish = kind === 'missing' ? undefined : { kind }
  await expect(value.backend.compute(input())).rejects.toThrow('incomplete model finish')
  const result = (await auditEvents(value)).find(event => event.type === 'context/semantic-result')
  expect(result?.data).toMatchObject({ status: 'failed', projection: null })
})


it('audits exact-capture omissions while delivering another Session on the same peer and reusing the recorded result', async () => {
  const grant: DevelopmentTaskPeerContributionGrant = {
    version: 1, taskId: 'orders' as DevelopmentTaskPeerContributionGrant['taskId'],
    ownerPeerId: 'owner' as DevelopmentTaskPeerContributionGrant['ownerPeerId'],
    contributorPeerId: 'source' as DevelopmentTaskPeerContributionGrant['contributorPeerId'],
    grantId: 'grant' as DevelopmentTaskPeerContributionGrant['grantId'], generation: 'generation' as DevelopmentTaskPeerContributionGrant['generation'],
    captureId: 'capture' as DevelopmentTaskPeerContributionGrant['captureId'], captureGeneration: 'capture-generation' as DevelopmentTaskPeerContributionGrant['captureGeneration'],
    source: { kind: 'tool-observations', name: 'work', tools: ['Write'] }, expiresAt: 4_000_000_000_000,
    maxSamples: 10, maxSampleBytes: 20_000,
  }
  const publication = (id: string, selected: DevelopmentTaskPeerContributionGrant): DevelopmentTaskContextPublication => ({
    id, text: `code: ${id} report`, publishedAt: 1, peerContribution: { version: 1, grant: selected },
    peerToolObservation: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'same.ts', content: `${id} report` }, omissions: [],
      sourceName: 'work', grantId: selected.grantId, sequence: 1, observerPeerId: selected.contributorPeerId,
      sourceId: id as NonNullable<DevelopmentTaskContextPublication['peerToolObservation']>['sourceId'],
      capture: { id: selected.captureId, generation: selected.captureGeneration } },
  })
  const base = input('frontend', [publication('ORIGINAL_CAPTURE', grant),
    publication('OTHER_SESSION', { ...grant, captureId: 'other' as typeof grant.captureId })])
  const request = { ...base, recipient: { ...base.recipient, peerCapture: grant } }
  const value = await harness()
  const result = await value.backend.compute(request)
  expect(result.text).toContain('OTHER_SESSION report')
  expect(result.text).not.toContain('ORIGINAL_CAPTURE report')
  expect(result.omittedSources).toContainEqual({ reason: 'self-published',
    source: { kind: 'publication', taskId: 'orders', revision: 2, publicationId: 'ORIGINAL_CAPTURE' } })
  expect(value.adapter.requests).toHaveLength(1)
  expect(JSON.stringify(value.adapter.requests[0]?.messages)).not.toContain('ORIGINAL_CAPTURE report')
  await value.fork.dispose()
  const reopened = await harness({}, value.root)
  expect(await reopened.backend.compute(request)).toEqual(result)
  expect(reopened.adapter.requests).toHaveLength(0)
  const manual = await reopened.backend.compute(base)
  expect(manual.text).toContain('ORIGINAL_CAPTURE report')
  expect(manual.text).toContain('OTHER_SESSION report')
  expect(reopened.adapter.requests).toHaveLength(1)
})
