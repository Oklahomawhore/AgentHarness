import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DevelopmentRoomService, { type DevelopmentNodeId, type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import { peerContributionGrantSchema } from '@deepseek-ai/dsh-development-task/schema'
import type {
  DevelopmentTaskBindingId, DevelopmentTaskId, DevelopmentTaskObservedSourceId,
  DevelopmentTaskOpenApiObservationIdentity, DevelopmentTaskOpenApiObservationResult,
} from '@deepseek-ai/dsh-development-task/types'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import DevelopmentTaskContextBackend from '../src/backend.ts'
import * as TaskContext from '../src/index.ts'
import TextBackend from '../src/text.ts'
import FactsBackend from '../src/facts.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class AlternateBackend extends DevelopmentTaskContextBackend {
  readonly identity = { id: 'alternate', revision: 'test-1' }
  override async compute(input: DevelopmentTaskContextInput): Promise<DevelopmentTaskContextProjection> {
    return {
      activation: { kind: 'exact' },
      text: `Alternative projection: ${input.view.task.objective}`,
      selectedSources: [{ kind: 'task', taskId: input.view.task.id, revision: input.view.task.revision }],
      omittedSources: [],
    }
  }
}

async function harness(
  provider: typeof TextBackend | typeof AlternateBackend | typeof FactsBackend = TextBackend,
  seed?: readonly SessionEvent[],
) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-task', DevelopmentTaskService],
    ['@deepseek-ai/dsh-development-task-context', TaskContext],
    ['fixture:context-backend', provider],
    ['fixture:alternate-backend', AlternateBackend],
    ['fixture:text-replacement', TextBackend],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  const directory = await mkdtemp(join(tmpdir(), 'task-context-backend-'))
  directories.push(directory)
  const fixture = join(directory, 'cordis.yml')
  const configuration = provider === FactsBackend ? './fixtures/facts-cordis.yml' : './fixtures/backend-cordis.yml'
  await copyFile(new URL(configuration, import.meta.url), fixture)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(fixture).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agents.create({
    sessionId: SessionId('backend-agent'),
    ...(seed === undefined ? {} : { seed }),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const owner = 'backend-owner' as DevelopmentParticipantId
  const agentId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
  await ctx.developmentRooms.announce({ id: agentId, kind: 'agent', displayName: 'Recipient' })
  const bindingId = 'backend-binding' as DevelopmentTaskBindingId
  const followup = async (text = 'continue'): Promise<void> => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const create = async (objective = 'Shared objective') => ctx.developmentTasks.create({
    origin: { kind: 'root' }, objective, scope: 'Exact scope', createdBy: owner,
  })
  const checkout = async (taskId: Awaited<ReturnType<typeof create>>['id']) => ctx.developmentTasks.checkout({
    taskId, participantId: agentId, bindingId,
  })
  return { ctx, adapter, agent, owner, agentId, bindingId, followup, create, checkout }
}

function requestText(request: GenerateOptions | undefined): string {
  return request?.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
}

function contextEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context')
}

async function remoteProducer(owner: Context, taskId: DevelopmentTaskId) {
  const peer = new Context()
  contexts.push(peer)
  const sourceNodeId = 'remote-node' as DevelopmentNodeId
  const participantId = 'remote-sampler' as DevelopmentParticipantId
  await peer.plugin(DevelopmentRoomService, {
    nodeId: sourceNodeId, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 4096,
  })
  await peer.plugin(DevelopmentTaskService, {
    maxTasks: 32, maxEventsPerTask: 64, maxMergeParents: 8, maxContextBlockBytes: 65536,
    maxLineageTasks: 64, maxTextBytes: 4096, roomRetryIntervalMs: 10_000,
  })
  await peer.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Remote sampler' })
  await owner.developmentRooms.acceptPresenceReplica(peer.developmentRooms.list().participants[0]!, sourceNodeId)
  for (const entry of owner.developmentTasks.log()) await peer.developmentTasks.acceptLogReplica(entry, entry.nodeId)
  const { assignment } = await peer.developmentTasks.checkout({
    taskId, participantId, bindingId: 'remote-binding' as DevelopmentTaskBindingId,
  })
  const epoch = peer.developmentTasks.assignmentLog().at(-1)!
  await owner.developmentTasks.acceptAssignmentReplica(epoch, sourceNodeId)
  const identity = {
    taskId, sourceNodeId, participantId, bindingId: assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
  }
  const interval = await owner.developmentTasks.approveObservedInterval(identity)
  const sample = async (sequence: number, result: Exclude<DevelopmentTaskOpenApiObservationResult, { state: 'revoked' }>) => {
    const observation: DevelopmentTaskOpenApiObservationIdentity = {
      kind: 'openapi-artifact', version: 1, artifactId: 'remote-orders' as DevelopmentTaskOpenApiObservationIdentity['artifactId'],
      sourceName: '远端 Orders API', grantId: 'remote-grant' as DevelopmentTaskOpenApiObservationIdentity['grantId'], sequence,
      operation: { method: 'post', path: '/orders' },
    }
    return await owner.developmentTasks.acceptObservedRemote({
      taskId, participantId, bindingId: identity.bindingId, expectedBindingEpoch: identity.expectedBindingEpoch,
      sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskObservedSourceId,
      intervalId: interval.id, text: 'Complete remote API declaration', observation: { ...observation, ...result },
    }, sourceNodeId)
  }
  const observe = async (text: string) => owner.developmentTasks.acceptObservedRemote({
    taskId, participantId, bindingId: identity.bindingId, expectedBindingEpoch: identity.expectedBindingEpoch,
    sourceId: 'f'.repeat(64) as DevelopmentTaskObservedSourceId, intervalId: interval.id, text,
  }, sourceNodeId)
  return {
    sample, observe, intervalId: interval.id,
    end: async () => owner.developmentTasks.acceptObservedIntervalEnd(identity, sourceNodeId),
  }
}

async function peerProducer(ctx: Context, taskId: DevelopmentTaskId) {
  const grant = peerContributionGrantSchema.parse({
    version: 1, taskId, grantId: 'peer-grant', generation: 'peer-generation',
    ownerPeerId: 'owner-peer', contributorPeerId: 'source-peer', captureId: 'capture', captureGeneration: 'capture-generation',
    source: { name: 'Orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 60000,
    maxSamples: 8, maxSampleBytes: 4096,
  })
  await ctx.developmentTasks.openPeerContribution(grant)
  return {
    grant,
    sample: async (sequence = 1, field = 'peerSku') => ctx.developmentTasks.admitPeerContribution({
      grant, sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskObservedSourceId, sequence,
      result: { state: 'valid', sha256: 'a'.repeat(64), facts: { requestBodyRequired: true,
        requiredRequestFields: [field], responseStatuses: ['201'], deprecated: false } },
    }, grant.contributorPeerId),
    end: async () => ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, grant.ownerPeerId),
  }
}

function holdNextComputation(ctx: Context, rejectsOnAbort = false) {
  const started = Promise.withResolvers<DevelopmentTaskContextInput>()
  const release = Promise.withResolvers<undefined>()
  const compute = ctx.developmentTaskContextBackend.compute.bind(ctx.developmentTaskContextBackend)
  const spy = vi.spyOn(ctx.developmentTaskContextBackend, 'compute').mockImplementationOnce(async (input) => {
    const projection = await compute(input)
    started.resolve(input)
    if (rejectsOnAbort) {
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { reject(new Error('computation aborted', { cause: input.signal.reason })) }
        input.signal.addEventListener('abort', aborted, { once: true })
        void release.promise.then(() => {
          input.signal.removeEventListener('abort', aborted)
          resolve()
        })
      })
    } else await release.promise
    return projection
  })
  return { started: started.promise, release: (): void => { release.resolve(undefined) }, spy }
}

describe('recipient Task context backend', () => {
  it('blocks a cached peer projection when expiry cannot persist and keeps the claimed input for retry', async () => {
    const live = await harness(FactsBackend)
    const task = await live.create()
    await live.checkout(task.id)
    const producer = await peerProducer(live.ctx, task.id)
    await producer.sample()
    await live.followup('Prime current evidence')
    expect(requestText(live.adapter.requests[0])).toContain('peerSku')
    const compute = vi.spyOn(live.ctx.developmentTaskContextBackend, 'compute')
    const dispose = live.ctx.on('development-task/persist', (entry) => {
      if (entry.change.kind === 'peer-contribution-ended') throw new Error('fixture expiry storage failure')
    })
    vi.spyOn(Date, 'now').mockReturnValue(producer.grant.expiresAt)
    await live.followup('Keep this work pending')
    expect(live.adapter.requests).toHaveLength(1)
    expect(compute).not.toHaveBeenCalled()
    expect(contextEvents(live.agent.session.snapshotEvents())).toHaveLength(1)
    expect(live.agent.inbox.nextStep).toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'Keep this work pending' }] })])
    dispose()
    await live.followup('Retry after storage recovery')
    expect(live.adapter.requests).toHaveLength(2)
    expect(requestText(live.adapter.requests[1])).not.toContain('peerSku')
    expect(requestText(live.adapter.requests[1])).toContain('Keep this work pending')
    expect(requestText(live.adapter.requests[1])).toContain('expired')
  })

  it.each(['expired', 'revoked'] as const)('recomputes a slow peer projection when authorization becomes %s', async (reason) => {
    const live = await harness(FactsBackend)
    const task = await live.create()
    await live.checkout(task.id)
    const producer = await peerProducer(live.ctx, task.id)
    await producer.sample()
    const held = holdNextComputation(live.ctx)
    const pending = live.followup('Use current declarations')
    await held.started
    if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(producer.grant.expiresAt)
    else await producer.end()
    held.release()
    await pending
    expect(held.spy).toHaveBeenCalledTimes(2)
    expect(live.adapter.requests).toHaveLength(1)
    const delivered = requestText(live.adapter.requests[0])
    expect(delivered).not.toContain('peerSku')
    expect(delivered).toContain(reason)
    expect(delivered).toContain('Use current declarations')
    expect(contextEvents(live.agent.session.snapshotEvents())).toHaveLength(1)
    expect(contextEvents(live.agent.session.snapshotEvents())[0]).toMatchObject({ data: { source: { revision: 4 } } })
  })

  it.each(['before-compute', 'after-compute'] as const)('rechecks binding after authority read %s', async (position) => {
    const live = await harness()
    const first = await live.create('First authority scope')
    const second = await live.create('Second authority scope')
    await live.checkout(first.id)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const read = live.ctx.developmentTasks.currentContextView.bind(live.ctx.developmentTasks)
    let count = 0
    vi.spyOn(live.ctx.developmentTasks, 'currentContextView').mockImplementation(async (id) => {
      const view = await read(id)
      count++
      if (count === (position === 'before-compute' ? 1 : 2)) {
        started.resolve(undefined)
        await release.promise
      }
      return view
    })
    const pending = live.followup('Retain work while authority is checked')
    await started.promise
    await live.checkout(second.id)
    release.resolve(undefined)
    await pending
    expect(live.adapter.requests).toHaveLength(1)
    expect(requestText(live.adapter.requests[0])).toContain('Second authority scope')
    expect(requestText(live.adapter.requests[0])).not.toContain('First authority scope')
    expect(requestText(live.adapter.requests[0])).toContain('Retain work while authority is checked')
  })

  it('does not admit computed text when its final authority read cannot persist expiry', async () => {
    const live = await harness(FactsBackend)
    const task = await live.create()
    await live.checkout(task.id)
    const producer = await peerProducer(live.ctx, task.id)
    await producer.sample()
    const held = holdNextComputation(live.ctx)
    const pending = live.followup('Preserve work after a failed final read')
    await held.started
    live.ctx.on('development-task/persist', (entry) => {
      if (entry.change.kind === 'peer-contribution-ended') throw new Error('fixture final retirement failure')
    })
    vi.spyOn(Date, 'now').mockReturnValue(producer.grant.expiresAt)
    held.release()
    await pending
    expect(live.adapter.requests).toHaveLength(0)
    expect(contextEvents(live.agent.session.snapshotEvents())).toHaveLength(0)
    expect(live.agent.inbox.nextStep).toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'Preserve work after a failed final read' }] })])
  })

  it('allows a captured peer sample to finish while later ordinary samples arrive', async () => {
    const live = await harness(FactsBackend)
    const task = await live.create()
    await live.checkout(task.id)
    const producer = await peerProducer(live.ctx, task.id)
    await producer.sample()
    const held = holdNextComputation(live.ctx)
    const pending = live.followup()
    await held.started
    await producer.sample(2, 'laterPeerSku')
    held.release()
    await pending
    expect(held.spy).toHaveBeenCalledTimes(1)
    expect(requestText(live.adapter.requests[0])).toContain('peerSku')
    expect(requestText(live.adapter.requests[0])).not.toContain('laterPeerSku')
    await live.followup()
    expect(requestText(live.adapter.requests[1])).toContain('laterPeerSku')
    expect(requestText(live.adapter.requests[1])).not.toContain('"peerSku"')
  })

  it('adopts remote corrections, invalidation, and owner withdrawal as exact native facts context and replays the terminal projection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_728_000_000_000)
    const live = await harness(FactsBackend)
    const task = await live.create('Ship the remote Orders API')
    await live.checkout(task.id)
    const producer = await remoteProducer(live.ctx, task.id)
    await producer.sample(1, { state: 'valid', sha256: 'a'.repeat(64), facts: {
      requestBodyRequired: true, requiredRequestFields: ['oldSku'], responseStatuses: ['201'], deprecated: false,
    } })
    await live.followup('Use the shared API')
    expect(requestText(live.adapter.requests[0])).toContain('"observerNodeId":"remote-node"')
    expect(requestText(live.adapter.requests[0])).toContain('"requiredRequestFields":["oldSku"]')
    await producer.sample(2, { state: 'valid', sha256: 'b'.repeat(64), facts: {
      requestBodyRequired: true, requiredRequestFields: ['sku', '优惠码'], responseStatuses: ['201', '4XX'], deprecated: false,
    } })
    await live.followup('Continue with the corrected API')
    expect(requestText(live.adapter.requests[1])).toContain('"requiredRequestFields":["sku","优惠码"]')
    expect(requestText(live.adapter.requests[1])).not.toContain('oldSku')
    await producer.sample(3, { state: 'invalid', sha256: 'c'.repeat(64), reason: 'invalid-json' })
    await live.followup('Continue after the invalid sample')
    expect(requestText(live.adapter.requests[2])).toContain('"state":"invalid"')
    expect(requestText(live.adapter.requests[2])).not.toContain('"facts":')
    const receipt = await producer.end()
    expect(receipt.ownerNodeId).toBe('backend-node')
    await live.followup('Continue after the source interval ended')
    const withdrawn = requestText(live.adapter.requests[3])
    expect(withdrawn).toContain('"evidence":"revoked"')
    expect(withdrawn).toContain('"observerNodeId":"remote-node"')
    expect(withdrawn).not.toContain('"facts":')

    const recorded = contextEvents(live.agent.session.snapshotEvents())
    expect(recorded).toHaveLength(4)
    for (const event of recorded) {
      expect(event).toMatchObject({ data: { source: { backend: { id: 'openapi-facts' }, bindingEpoch: { nodeId: 'backend-node' } } } })
      if (event.type !== 'user/message') throw new Error('expected recorded Task projection')
      expect(Buffer.byteLength(event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toBeLessThanOrEqual(65536)
    }
    const current = live.ctx.developmentTasks.contextView(task.id)
    const withdrawalSource = current.task.context.find(item => item.observation?.state === 'revoked')!.observation!.sourceId
    const recordedText = recorded.map((event) => {
      if (event.type !== 'user/message') throw new Error('expected recorded Task projection')
      return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        .replaceAll(task.id, '{{taskId}}').replaceAll(producer.intervalId, '{{intervalId}}')
        .replaceAll(withdrawalSource, '{{withdrawalSourceId}}')
    }).join('\n\n--- next request ---\n\n') + '\n'
    await expect(recordedText).toMatchFileSnapshot(new URL('./expected/facts-remote-lifecycle.txt', import.meta.url).pathname)
    const complete = await live.ctx.developmentTaskContextBackend.compute({
      view: current, recipient: { participantId: live.agentId },
      maxContextBytes: 65536, signal: new AbortController().signal,
    })
    const budget = Buffer.byteLength(complete.text) - 1
    const omitted = await live.ctx.developmentTaskContextBackend.compute({
      view: current, recipient: { participantId: live.agentId },
      maxContextBytes: budget, signal: new AbortController().signal,
    })
    expect(Buffer.byteLength(omitted.text)).toBeLessThanOrEqual(budget)
    expect(omitted.text).toContain('"artifacts":[]')
    expect(omitted.omittedSources.filter(item => item.reason === 'budget')).toHaveLength(2)

    const replay = await harness(FactsBackend, live.agent.session.snapshotEvents())
    replay.ctx.developmentTasks.restoreLog(live.ctx.developmentTasks.log())
    replay.ctx.developmentTasks.restoreAssignmentLog(live.ctx.developmentTasks.assignmentLog())
    const compute = vi.spyOn(replay.ctx.developmentTaskContextBackend, 'compute')
    await replay.followup('Use the restored terminal projection')
    expect(compute).not.toHaveBeenCalled()
    expect(requestText(replay.adapter.requests[0])).toContain(complete.text)
    expect(contextEvents(replay.agent.session.snapshotEvents())).toHaveLength(4)
  })

  it('withdraws remote original text before budgeting the terminal notice while preserving a frozen parent snapshot', async () => {
    const live = await harness()
    const task = await live.create()
    await live.checkout(task.id)
    const producer = await remoteProducer(live.ctx, task.id)
    const accepted = await producer.observe('OLD_REMOTE_CLAIM')
    await live.followup()
    expect(requestText(live.adapter.requests[0])).toContain('OLD_REMOTE_CLAIM')
    const child = await live.ctx.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: task.id, revision: live.ctx.developmentTasks.get({ taskId: task.id }).revision } },
      objective: 'Frozen evidence', scope: 'Historical claims', createdBy: live.owner,
    })
    await producer.end()
    await live.followup()
    expect(requestText(live.adapter.requests[1])).not.toContain('OLD_REMOTE_CLAIM')
    expect(requestText(live.adapter.requests[1])).toContain('"observedIntervalEnded":true')
    const input: DevelopmentTaskContextInput = {
      view: live.ctx.developmentTasks.contextView(task.id),
      recipient: {
        participantId: 'remote-sampler' as DevelopmentParticipantId,
      }, maxContextBytes: 65536, signal: new AbortController().signal,
    }
    const full = await live.ctx.developmentTaskContextBackend.compute(input)
    expect(full.text).toContain('"observedIntervalEnded":true')
    expect(full.omittedSources).toEqual([{ source: {
      kind: 'publication', taskId: task.id, revision: input.view.task.revision, publicationId: accepted.publication.id,
    }, reason: 'withdrawn' }])
    const budget = Buffer.byteLength(full.text) - 1
    const bounded = await live.ctx.developmentTaskContextBackend.compute({ ...input, maxContextBytes: budget })
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(budget)
    expect(bounded.text).not.toContain('OLD_REMOTE_CLAIM')
    expect(bounded.text).toContain('"publications":[]')
    expect(bounded.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'budget'])
    const inherited = await live.ctx.developmentTaskContextBackend.compute({
      ...input, view: live.ctx.developmentTasks.contextView(child.id), recipient: { ...input.recipient, participantId: live.agentId },
    })
    expect(inherited.text).toContain('OLD_REMOTE_CLAIM')
    expect(inherited.text).not.toContain('"observedIntervalEnded":true')
  })

  it('adopts and replays unsupported-source coverage from the facts provider through the native consumer', async () => {
    const live = await harness(FactsBackend)
    const task = await live.create()
    await live.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: live.owner, text: 'Unverified API assertion' })
    await live.checkout(task.id)
    await live.followup()
    const originalText = requestText(live.adapter.requests[0])
    expect(originalText).toContain('## OpenAPI declarations as sampled')
    expect(originalText).not.toContain('Unverified API assertion')
    expect(contextEvents(live.agent.session.snapshotEvents())[0]).toMatchObject({ data: { source: {
      backend: { id: 'openapi-facts' }, omittedSources: [{ reason: 'unsupported' }],
    } } })
    const replay = await harness(FactsBackend, live.agent.session.snapshotEvents())
    replay.ctx.developmentTasks.restoreLog(live.ctx.developmentTasks.log())
    replay.ctx.developmentTasks.restoreAssignmentLog(live.ctx.developmentTasks.assignmentLog())
    const compute = vi.spyOn(replay.ctx.developmentTaskContextBackend, 'compute')
    await replay.followup()
    expect(requestText(replay.adapter.requests[0])).toContain('"unsupportedSources":1')
    expect(compute).not.toHaveBeenCalled()
  })

  it.each([TextBackend, AlternateBackend])('adopts the provider selected by real Loader composition: %s', async (provider) => {
    const { ctx, agent, adapter, create, checkout, followup } = await harness(provider)
    const task = await create()
    await checkout(task.id)
    await followup()
    expect(ctx.developmentTaskContextBackend).toBeInstanceOf(provider)
    const source = contextEvents(agent.session.snapshotEvents())[0]
    expect(source).toMatchObject({ data: { source: {
      form: 'snapshot', version: 2, taskId: task.id,
      backend: { id: provider === TextBackend ? 'text' : 'alternate' },
      bindingEpoch: { nodeId: 'backend-node', seq: 1 },
    } } })
    expect(requestText(adapter.requests[0])).toContain(provider === TextBackend ? '## Connected Task context' : 'Alternative projection:')
    const providerEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'fixture:context-backend')
    expect(providerEntry?.fiber).toBeDefined()
    await providerEntry!.fiber!.dispose()
    expect(ctx.get('developmentTaskContextBackend')).toBeUndefined()
  })

  it('gives different recipients original publications excluding their own contributions', async () => {
    const { ctx, agentId, owner, create, checkout, followup, adapter } = await harness()
    const task = await create()
    await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Owner exact API: x < 5' })
    await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: agentId, text: 'My prior publication' })
    await checkout(task.id)
    await followup()
    expect(requestText(adapter.requests[0])).toContain('Owner exact API: x \\u003c 5')
    expect(requestText(adapter.requests[0])).not.toContain('My prior publication')
    const view = ctx.developmentTasks.contextView(task.id)
    const ownerProjection = await ctx.developmentTaskContextBackend.compute({
      view, recipient: { participantId: owner }, maxContextBytes: 65536, signal: new AbortController().signal,
    })
    expect(ownerProjection.text).toContain('My prior publication')
    expect(ownerProjection.text).not.toContain('Owner exact API:')
    expect(ownerProjection.omittedSources).toEqual([expect.objectContaining({ reason: 'self-published' })])
  })

  it('retains whole Unicode text at an exact complete-output budget and reports omitted sources below it', async () => {
    const { ctx, owner, agentId, create } = await harness()
    const task = await create('目标 😀')
    await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: '接口不得返回空值 🚀' })
    const view = ctx.developmentTasks.contextView(task.id)
    const input: DevelopmentTaskContextInput = {
      view, recipient: { participantId: agentId }, maxContextBytes: 65536, signal: new AbortController().signal,
    }
    const full = await ctx.developmentTaskContextBackend.compute(input)
    const bytes = Buffer.byteLength(full.text, 'utf8')
    const exact = await ctx.developmentTaskContextBackend.compute({ ...input, maxContextBytes: bytes })
    expect(exact.text).toBe(full.text)
    const bounded = await ctx.developmentTaskContextBackend.compute({ ...input, maxContextBytes: bytes - 1 })
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(bytes - 1)
    expect(bounded.text).toContain('目标 😀')
    expect(bounded.text).not.toContain('接口不得返回空值')
    expect(bounded.omittedSources).toHaveLength(1)
    expect(bounded.omittedSources[0]).toMatchObject({ source: { publicationId: view.task.context[0]!.id }, reason: 'budget' })
    expect(bounded.text).toContain('"budgetOmissions":1')
    await expect(ctx.developmentTaskContextBackend.compute({ ...input, maxContextBytes: 1 })).rejects.toThrow('mandatory Task context')
  })

  it.each(['switch', 'ABA', 'disconnect'] as const)('recomputes after a binding %s while retaining the originally claimed user input', async (change) => {
    const { ctx, agent, adapter, agentId, bindingId, create, checkout, followup } = await harness()
    const a = await create('Scope A')
    const b = await create('Scope B')
    await checkout(a.id)
    await followup('prime')
    await ctx.developmentTasks.publishContext({ taskId: a.id, participantId: agentId, text: 'trigger changed baseline' })
    const held = holdNextComputation(ctx)
    const pending = followup('work during rebinding')
    await held.started
    const captured = ctx.developmentTasks.assignmentLog().findLast(entry => entry.bindingId === bindingId && entry.change.kind === 'task-bound')!
    if (change === 'disconnect') await ctx.developmentTasks.clear({ participantId: agentId, bindingId })
    else {
      await checkout(b.id)
      if (change === 'ABA') await checkout(a.id)
    }
    held.release()
    await pending
    expect(adapter.requests).toHaveLength(2)
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(2)
    const latest = requestText(adapter.requests[1])
    expect(latest).toContain('work during rebinding')
    if (change === 'disconnect') expect(latest).toContain('not connected to a Task')
    else {
      expect(latest).toContain(change === 'ABA' ? 'Scope A' : 'Scope B')
      const event = contextEvents(agent.session.snapshotEvents()).at(-1)
      expect(event).not.toMatchObject({ data: { source: { bindingEpoch: { nodeId: captured.nodeId, seq: captured.seq } } } })
    }
  })

  it('adopts the captured revision while newer sources arrive, then advances next request', async () => {
    const { ctx, agent, adapter, owner, create, checkout, followup } = await harness()
    const task = await create()
    await checkout(task.id)
    const held = holdNextComputation(ctx)
    const pending = followup()
    await held.started
    for (const text of ['new fact 1', 'new fact 2', 'new fact 3']) {
      await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text })
    }
    held.release()
    await pending
    expect(adapter.requests).toHaveLength(1)
    expect(contextEvents(agent.session.snapshotEvents())[0]).toMatchObject({ data: { source: { revision: 1 } } })
    await followup()
    expect(requestText(adapter.requests[1])).toContain('new fact 3')
    expect(contextEvents(agent.session.snapshotEvents()).at(-1)).toMatchObject({ data: { source: { revision: 4 } } })
  })

  it('does not commit a computed projection when cancellation wins before adoption', async () => {
    const { ctx, agent, adapter, create, checkout, followup } = await harness()
    const task = await create()
    await checkout(task.id)
    const held = holdNextComputation(ctx)
    const pending = followup()
    await held.started
    agent.cancel({ kind: 'user' })
    held.release()
    await pending
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.developmentTasks.assignmentList()[0]?.acknowledgedRevision).toBeUndefined()
  })

  it('reuses adopted text after acknowledgement fails, including after restoring a Session', async () => {
    const first = await harness()
    const task = await first.create()
    await first.checkout(task.id)
    vi.spyOn(first.ctx.developmentTasks, 'acknowledge').mockRejectedValueOnce(new Error('ack storage unavailable'))
    const compute = vi.spyOn(first.ctx.developmentTaskContextBackend, 'compute')
    await first.followup()
    expect(contextEvents(first.agent.session.snapshotEvents())).toHaveLength(1)
    expect(first.adapter.requests).toHaveLength(1)
    await first.followup()
    expect(compute).toHaveBeenCalledTimes(1)
    const history = first.agent.session.snapshotEvents()
    const second = await harness(TextBackend, history)
    second.ctx.developmentTasks.restoreLog(first.ctx.developmentTasks.log())
    second.ctx.developmentTasks.restoreAssignmentLog(first.ctx.developmentTasks.assignmentLog())
    const secondCompute = vi.spyOn(second.ctx.developmentTaskContextBackend, 'compute')
    await second.followup('continue restored')
    expect(secondCompute).not.toHaveBeenCalled()
    expect(requestText(second.adapter.requests[0])).toContain('## Connected Task context')
    expect(requestText(second.adapter.requests[0])).not.toContain('Alternative projection:')
    expect(contextEvents(second.agent.session.snapshotEvents())).toHaveLength(1)
  })

  it('bounds custom backend output at adoption and leaves no false acknowledgement', async () => {
    const { ctx, agent, adapter, create, checkout, followup } = await harness(AlternateBackend)
    const task = await create()
    await checkout(task.id)
    vi.spyOn(ctx.developmentTaskContextBackend, 'compute').mockResolvedValue({
      activation: { kind: 'exact' }, text: '🚀'.repeat(17000), selectedSources: [], omittedSources: [],
    })
    await followup()
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.developmentTasks.assignmentList()[0]?.acknowledgedRevision).toBeUndefined()
  })

  it('uses a replacement provider for a new request without rewriting past adopted text', async () => {
    const first = await harness()
    const task = await first.create()
    await first.checkout(task.id)
    await first.followup()
    const history = first.agent.session.snapshotEvents()
    const entry = [...first.ctx.loader.entries()].find(item => item.options.name === 'fixture:context-backend')!
    await entry.update({ name: 'fixture:alternate-backend' })
    await first.ctx.loader.await()
    await first.followup('use current provider')
    const adopted = contextEvents(first.agent.session.snapshotEvents())
    expect(adopted).toHaveLength(2)
    expect(adopted[0]).toEqual(contextEvents(history)[0])
    expect(requestText(first.adapter.requests[1])).toContain('Alternative projection:')
    expect(requestText(first.adapter.requests[1])).not.toContain('## Connected Task context')
  })

  it('recomputes at a changed live byte budget instead of retaining an oversized cached projection', async () => {
    const { ctx, owner, create, checkout, followup, adapter, agent } = await harness()
    const task = await create()
    await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'x'.repeat(2048) })
    await checkout(task.id)
    await followup()
    const consumer = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task-context')!
    await consumer.update({ config: { maxContextBytesPerStep: 1000 } })
    await ctx.loader.await()
    await followup('apply smaller budget')
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(2)
    const latest = agent.session.deriveMessages().find(message => message.source.kind === 'development-task-context')!
    const text = latest.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1000)
    expect(requestText(adapter.requests[1])).not.toContain('x'.repeat(2048))
    expect(latest.source).toMatchObject({ maxContextBytes: 1000, omittedSources: [{ reason: 'budget' }] })
  })

  it.each([
    ['provider', false], ['consumer', false], ['consumer', true],
  ] as const)('does not adopt work after %s disposal with cancellation-aware computation %s and retains claimed input', async (target, rejectsOnAbort) => {
    const { ctx, create, checkout, followup, adapter, agent } = await harness()
    const task = await create()
    await checkout(task.id)
    const held = holdNextComputation(ctx, rejectsOnAbort)
    const pending = followup('retain this input')
    const input = await held.started
    const name = target === 'provider' ? 'fixture:context-backend' : '@deepseek-ai/dsh-development-task-context'
    const entry = [...ctx.loader.entries()].find(item => item.options.name === name)!
    await entry.fiber!.dispose()
    expect(input.signal.aborted).toBe(true)
    held.release()
    await pending
    expect(adapter.requests).toHaveLength(0)
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(0)
    expect(agent.inbox.nextStep).toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'retain this input' }] })])
  })

  it('awaits an owned acknowledgement during consumer disposal without blocking the model request', async () => {
    const { ctx, create, checkout, followup, adapter } = await harness()
    const task = await create()
    await checkout(task.id)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const acknowledge = ctx.developmentTasks.acknowledge.bind(ctx.developmentTasks)
    vi.spyOn(ctx.developmentTasks, 'acknowledge').mockImplementationOnce(async (request) => {
      started.resolve(undefined)
      await release.promise
      return acknowledge(request)
    })
    const pending = followup()
    await started.promise
    await pending
    expect(adapter.requests).toHaveLength(1)
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context')!
    let disposed = false
    const disposal = entry.fiber!.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
  })

  it('rejects an unloaded instance result even when its live replacement has identical identity fields', async () => {
    const { ctx, create, checkout, followup, adapter, agent } = await harness()
    const task = await create()
    await checkout(task.id)
    const originalIdentity = ctx.developmentTaskContextBackend.identity
    const held = holdNextComputation(ctx)
    const pending = followup('retain across provider reload')
    await held.started
    const entry = [...ctx.loader.entries()].find(item => item.options.name === 'fixture:context-backend')!
    await entry.update({ name: 'fixture:text-replacement' })
    await ctx.loader.await()
    expect(ctx.developmentTaskContextBackend.identity).toEqual(originalIdentity)
    expect(ctx.developmentTaskContextBackend.identity).not.toBe(originalIdentity)
    held.release()
    await pending
    expect(adapter.requests).toHaveLength(0)
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(1)
    await followup('continue with replacement')
    expect(requestText(adapter.requests[0])).toContain('retain across provider reload')
    expect(contextEvents(agent.session.snapshotEvents())).toHaveLength(1)
  })

  it('checks expected binding epoch inside the Task acknowledgement queue after an A-to-B-to-A change', async () => {
    const { ctx, create, checkout, agentId, bindingId } = await harness()
    const a = await create('A')
    const b = await create('B')
    await checkout(a.id)
    const original = ctx.developmentTasks.assignmentLog().at(-1)!
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('development-task/assignment-persist', async (entry) => {
      if (entry.change.kind === 'task-bound' && entry.change.taskId === b.id) {
        started.resolve(undefined)
        await release.promise
      }
    })
    const changing = checkout(b.id)
    await started.promise
    const returning = checkout(a.id)
    const staleAck = ctx.developmentTasks.acknowledge({
      bindingId, participantId: agentId, taskId: a.id, revision: a.revision,
      expectedBindingEpoch: { nodeId: original.nodeId, seq: original.seq },
    })
    const rejection = expect(staleAck).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    release.resolve(undefined)
    await changing
    await returning
    await rejection
    expect(ctx.developmentTasks.assignmentList()[0]?.acknowledgedRevision).toBeUndefined()
    const latest = ctx.developmentTasks.assignmentLog().at(-1)!
    await expect(ctx.developmentTasks.acknowledge({
      bindingId, participantId: agentId, taskId: a.id, revision: a.revision,
      expectedBindingEpoch: { nodeId: latest.nodeId, seq: latest.seq },
    })).resolves.toMatchObject({ acknowledgedRevision: a.revision })
  })
})
