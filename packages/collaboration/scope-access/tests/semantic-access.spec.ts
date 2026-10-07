/** Scope authorization rechecks around real semantic requests and durable auxiliary audit logs. */
import { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import z from 'zod'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SemanticBackend, { type Config as SemanticConfig } from '@deepseek-ai/dsh-development-task-context/semantic'
import { localContributionGrantSchema, peerContributionGrantSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentParticipantId, DevelopmentTaskBindingId, DevelopmentTaskObservedSourceId, DevelopmentTaskToolObservationResult } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeContributionSample } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

const privateRoots: string[] = []
const observerContexts: Context[] = []
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try { await cleanup() } finally {
    await Promise.all(observerContexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(privateRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

const signal = (): AbortSignal => new AbortController().signal
const auditId = SessionId('scope-semantic-access-audit')
const firstCanary = 'semantic-source-original-canary'
const secondCanary = 'semantic-source-in-flight-canary'
const inputSchema = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string() })) })
const semanticConfig: SemanticConfig = {
  auditSessionId: auditId, provider: 'controlled-semantic', model: 'recorded-summary',
  maxInputBytes: 32768, maxOutputTokens: 4096, maxOutputBytes: 6000,
  timeoutMs: 4000, maxConcurrentCalls: 2, maxCalls: 8,
}

class ControlledSemanticAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()

  constructor() {
    super()
    releases.push(() => { this.release.resolve(undefined) })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 2) {
      this.entered.resolve(undefined)
      await this.release.promise
    }
    options.signal?.throwIfAborted()
    const text = options.messages.flatMap(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    const input = inputSchema.parse(JSON.parse(text))
    const response = {
      version: 1,
      decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
      updates: input.sources.map((source) => {
        const canary = [firstCanary, secondCanary].find(value => source.body.includes(value))
        if (canary === undefined) throw new Error('expected a controlled tool report')
        return { text: `Reported source update: ${canary}.`, sources: [{ sourceId: source.sourceId, quote: canary }] }
      }),
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(response) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function sample(sequence: number, canary: string): Omit<ScopeContributionSample, 'result'> & { result: DevelopmentTaskToolObservationResult } {
  return {
    sourceId: createHash('sha256').update(`semantic-tool-${String(sequence)}`).digest('hex') as DevelopmentTaskObservedSourceId,
    sequence,
    result: {
      kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
      fields: { rootIndex: 0, path: sequence === 1 ? 'src/service.ts' : 'notes/service.md', content: canary },
    },
  }
}

async function fixture(source: 'peer' | 'local' = 'peer') {
  const a = await host('semantic-owner')
  const b = await host('semantic-source')
  const c = await host('semantic-recipient')
  const auditRoot = await mkdtemp(join(tmpdir(), 'dsh-semantic-access-'))
  privateRoots.push(auditRoot)
  await a.ctx.plugin(SessionStore)
  await a.ctx.plugin(LlmRuntime)
  await a.ctx.plugin(JsonlSessionPersistence, { root: auditRoot, compression: 'none' })
  const adapter = new ControlledSemanticAdapter()
  a.ctx.effect(() => a.ctx.llm.registerAdapter(['controlled-semantic'], adapter))
  await a.backendFork.dispose()
  const semanticFork = a.ctx.plugin(SemanticBackend, semanticConfig)
  await semanticFork
  const observer = new Context()
  observerContexts.push(observer)
  await observer.plugin(JsonlSessionPersistence, { root: auditRoot, compression: 'none' })
  const audit = async () => {
    await using handle = await observer.sessionPersistence.open(auditId, 'read')
    return (await handle.read()).events
  }
  const task = await a.createTask('Implement the service and document its behavior')
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const grant = peerContributionGrantSchema.parse({
    version: 1, taskId: task.id, grantId: randomUUID(), generation: randomUUID(),
    ownerPeerId: peer('semantic-owner'), contributorPeerId: peer('semantic-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] },
    expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096,
  })
  const contribution = source === 'peer' ? await a.access.inviteContribution({ ownerAddress, grant }) : undefined
  const participantId = 'local-source-agent' as DevelopmentParticipantId
  const bindingId = 'local-source-binding' as DevelopmentTaskBindingId
  const localGrant = source === 'local' ? await (async () => {
    await a.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Owner source' })
    await a.tasks.checkout({ taskId: task.id, participantId, bindingId })
    const epoch = a.tasks.assignmentLog().findLast(event => event.bindingId === bindingId && event.change.kind === 'task-bound')!
    const permission = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId, bindingId,
      expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, captureId: randomUUID(), captureGeneration: randomUUID(),
      source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] },
      expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096 })
    await a.tasks.openLocalContribution(permission)
    return permission
  })() : undefined
  const invitation = await a.access.invite({ taskId: task.id, ownerAddress,
    recipientPeerId: peer('semantic-recipient'), expiresAt: Date.now() + 50_000, responsibility: 'frontend' })
  const subscription = await c.access.join({ invitation })
  const read = async () => await c.access.retrieve(subscription.id, signal())
  const add = async (sequence: number, canary: string) => {
    const observation = sample(sequence, canary)
    if (localGrant !== undefined && 'kind' in observation.result) {
      const result = await a.tasks.admitLocalContribution({ grant: localGrant, ...observation, result: observation.result })
      expect(result.outcome).toBe('published')
    } else {
      if (contribution === undefined) throw new Error('the peer source has no invitation')
      const result = await b.access.contribute({ invitation: contribution, sample: observation }, signal())
      expect(result.status).toBe('accepted')
    }
  }
  await add(1, firstCanary)
  const initial = await read()
  if (initial.status !== 'active') throw new Error('expected initial semantic projection')
  expect(initial.projection.text).toContain(firstCanary)
  expect(adapter.requests).toHaveLength(1)
  await add(2, secondCanary)
  return { a, b, c, adapter, audit, semanticFork, contribution, localGrant, invitation, subscription, initial, read }
}

async function assertAuditBeforeRelease(value: Awaited<ReturnType<typeof fixture>>) {
  await value.adapter.entered.promise
  const events = await value.audit()
  const requests = events.filter(event => event.type === 'context/semantic-request')
  expect(requests).toHaveLength(2)
  expect(events.filter(event => event.type === 'context/semantic-result')).toHaveLength(1)
  const request = requests[1]!
  const dispatched = value.adapter.requests[1]!
  expect(request.ignorable).toBe(true)
  expect(dispatched).toMatchObject({ ...request.data.call, system: request.data.system,
    messages: request.data.messages, purpose: request.data.purpose })
  expect(JSON.stringify(request.data.messages)).toContain(secondCanary)
  expect(dispatched.tools ?? []).toEqual([])
  expect(value.b.tasks.list({ limit: 16 })).toEqual([])
  expect(value.c.tasks.list({ limit: 16 })).toEqual([])
}

async function assertCompletedAudit(value: Awaited<ReturnType<typeof fixture>>) {
  const events = await value.audit()
  const requests = events.filter(event => event.type === 'context/semantic-request')
  const results = events.filter(event => event.type === 'context/semantic-result')
  expect(results).toHaveLength(2)
  expect(results[1]?.data).toMatchObject({ requestSeq: requests[1]!.seq, key: requests[1]!.data.key, status: 'completed' })
  expect(results[1]?.data.projection?.text).toContain(secondCanary)
}

function projectionIds(value: Awaited<ReturnType<typeof host>>): readonly string[] {
  return [...value.pool.media.get('scope_access')!.tables.get('projections')!.keys()]
}

it('refuses a semantic result computed after read revocation and never reuses its earlier cached summary', async () => {
  const value = await fixture()
  const pending = value.read()
  try {
    await assertAuditBeforeRelease(value)
    await value.a.access.revoke({ grantId: value.invitation.grantId })
  } finally {
    value.adapter.release.resolve(undefined)
    await Promise.allSettled([pending])
  }
  await expect(pending).resolves.toEqual({ status: 'revoked' })
  await expect(value.read()).resolves.toEqual({ status: 'revoked' })
  expect(value.adapter.requests).toHaveLength(2)
  await assertCompletedAudit(value)
  expect(projectionIds(value.a)).toEqual([value.initial.projection.projectionId])
  expect(projectionIds(value.c)).toEqual([value.initial.projection.projectionId])
})

it('refuses an in-flight semantic summary after source end and cannot restore it from the durable provider cache', async () => {
  const value = await fixture()
  const pending = value.read()
  try {
    await assertAuditBeforeRelease(value)
    const ended = await value.b.access.endContribution({ invitation: value.contribution! }, signal())
    expect(ended.status).toBe('ended')
  } finally {
    value.adapter.release.resolve(undefined)
    await Promise.allSettled([pending])
  }
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  expect(projectionIds(value.a)).toEqual([value.initial.projection.projectionId])
  expect(projectionIds(value.c)).toEqual([value.initial.projection.projectionId])
  await assertCompletedAudit(value)
  await value.semanticFork.dispose()
  await value.a.ctx.plugin(SemanticBackend, semanticConfig)
  const current = await value.read()
  if (current.status !== 'active') throw new Error('read authorization must remain active after source withdrawal')
  expect(current.projection.projectionId).not.toBe(value.initial.projection.projectionId)
  expect(current.projection.text).not.toContain(firstCanary)
  expect(current.projection.text).not.toContain(secondCanary)
  expect(current.projection.omittedSources.filter(item => item.reason === 'withdrawn')).toHaveLength(2)
  expect((await value.c.access.list()).subscriptions[0]?.state).toBe('active')
  const requestCount = value.adapter.requests.length
  await expect(value.read()).resolves.toEqual(current)
  expect(value.adapter.requests).toHaveLength(requestCount)
})

it('withholds an in-flight semantic projection after owner-local capture end while keeping remote read permission', async () => {
  const value = await fixture('local')
  const pending = value.read()
  try {
    await assertAuditBeforeRelease(value)
    const ended = await value.a.tasks.endLocalContribution({ grant: value.localGrant!, reason: 'left' })
    expect(ended.event.kind).toBe('local-contribution-ended')
  } finally {
    value.adapter.release.resolve(undefined)
    await Promise.allSettled([pending])
  }
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  expect(projectionIds(value.a)).toEqual([value.initial.projection.projectionId])
  expect(projectionIds(value.c)).toEqual([value.initial.projection.projectionId])
  await assertCompletedAudit(value)
  await value.semanticFork.dispose()
  await value.a.ctx.plugin(SemanticBackend, semanticConfig)
  const current = await value.read()
  if (current.status !== 'active') throw new Error('local source withdrawal must retain remote read authority')
  expect(current.projection.projectionId).not.toBe(value.initial.projection.projectionId)
  expect(current.projection.text).not.toContain(firstCanary)
  expect(current.projection.text).not.toContain(secondCanary)
  expect(current.projection.omittedSources.filter(item => item.reason === 'withdrawn')).toHaveLength(2)
  expect((await value.c.access.list()).subscriptions[0]?.state).toBe('active')
  const calls = value.adapter.requests.length
  await expect(value.read()).resolves.toEqual(current)
  expect(value.adapter.requests).toHaveLength(calls)
})

it('passes the negotiated allowance through the semantic backend and its durable request evidence', async () => {
  const value = await fixture()
  value.adapter.release.resolve(undefined)
  const result = await value.c.access.retrieveWithinBudget({ subscriptionId: value.subscription.id, maxContextBytes: 4000 }, signal())
  if (result.status !== 'active' || result.projection.version !== 2) throw new Error('Expected current semantic result')
  expect(result.projection.maxContextBytes).toBe(4000)
  expect(Buffer.byteLength(result.projection.text)).toBeLessThanOrEqual(4000)
  expect(result.projection.activation.kind).toBe('recipient-evidence')
  const audit = await value.audit()
  const request = audit.findLast(event => event.type === 'context/semantic-request')
  if (request?.type !== 'context/semantic-request') throw new Error('Missing semantic request evidence')
  expect(request.data.maxContextBytes).toBe(4000)
  expect(value.adapter.requests).toHaveLength(2)
  const before = value.adapter.requests.length
  await expect(value.c.access.retrieveWithinBudget({ subscriptionId: value.subscription.id, maxContextBytes: 4000 }, signal()))
    .resolves.toEqual(result)
  expect(value.adapter.requests).toHaveLength(before)
})
