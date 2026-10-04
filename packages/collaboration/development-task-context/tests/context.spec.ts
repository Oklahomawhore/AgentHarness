import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskBindingId, DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as DevelopmentTaskContext from '../src/index.ts'
import TextContextBackend from '../src/text.ts'
import { localContributionGrantSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { readLocalTaskContext, localContextSnapshotMessage, replaceLocalTaskContext, localContextProjectionSchema, localContextWithdrawalMessage } from '../src/local.ts'
import type { DevelopmentTaskLocalContextReadResult } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly responses: StreamChunk[][]) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.responses.shift()
    if (next === undefined) throw new Error('script exhausted')
    for (const chunk of next) yield chunk
  }
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-task', DevelopmentTaskService],
    ['@deepseek-ai/dsh-development-task-context/text', TextContextBackend],
    ['@deepseek-ai/dsh-development-task-context', DevelopmentTaskContext],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  const directory = await mkdtemp(join(tmpdir(), 'task-context-admission-'))
  directories.push(directory)
  const fixture = join(directory, 'cordis.yml')
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), fixture)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(fixture).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled))
    .toEqual([])
  const adapter = new RecordingAdapter([response('A done'), response('B done'), response('B after Room warning')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('task-agent'), { provider: 'mock', model: 'mock' })
  const owner = 'human-owner' as DevelopmentParticipantId
  const agentId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
  await ctx.developmentRooms.announce({ id: agentId, kind: 'agent', displayName: 'Task Agent' })
  return { ctx, adapter, agent, owner, agentId }
}

function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('Agent-session Task context', () => {
  it('keeps the Loader function-plugin namespace free of a default export', () => {
    expect('default' in DevelopmentTaskContext).toBe(false)
  })

  it('withdraws disconnected Task context from requests while retaining replayable history', async () => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const task = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Disconnected scope objective', scope: 'Disconnected scope details', createdBy: owner,
    })
    await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Disconnected scope publication' })
    const bindingId = 'binding-disconnect' as DevelopmentTaskBindingId
    await ctx.developmentTasks.checkout({ taskId: task.id, participantId: agentId, bindingId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work in the connected scope' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(adapter.requests[0]!)).toContain('Disconnected scope publication')

    await ctx.developmentTasks.clear({ bindingId, participantId: agentId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue independently' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const disconnected = requestText(adapter.requests[1]!)
    expect(disconnected).not.toContain('Disconnected scope objective')
    expect(disconnected).not.toContain('Disconnected scope details')
    expect(disconnected).not.toContain('Disconnected scope publication')
    expect(disconnected).toContain('This Agent session is not connected to a Task.')

    const history = agent.session.snapshotEvents()
    const contextEvents = history.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')
    expect(contextEvents).toHaveLength(2)
    const original = contextEvents[0]!
    const originalText = original.type === 'user/message'
      ? original.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : ''
    expect(originalText).toContain('Disconnected scope publication')
    expect(contextEvents[1]).toMatchObject({
      sourceEventSeqs: [contextEvents[0]!.seq],
      data: { source: { kind: 'development-task-context', form: 'disconnected', version: 1 } },
    })

    const restored = await ctx.agents.create({
      sessionId: SessionId('disconnected-history-replay'),
      seed: history,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue the restored conversation' }], source: { kind: 'user' } }))
    await restored.agent.whenIdle()
    const replayed = requestText(adapter.requests[2]!)
    expect(replayed).not.toContain('Disconnected scope publication')
    expect(replayed).not.toContain('Disconnected scope objective')
    expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')).toHaveLength(2)
  })

  it('replaces the disconnection marker when the session connects to another Task', async () => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const first = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'First scope objective', scope: 'first', createdBy: owner,
    })
    const second = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Second scope objective', scope: 'second', createdBy: owner,
    })
    const bindingId = 'binding-reconnect' as DevelopmentTaskBindingId
    await ctx.developmentTasks.checkout({ taskId: first.id, participantId: agentId, bindingId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.developmentTasks.clear({ bindingId, participantId: agentId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'disconnected work' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.developmentTasks.checkout({ taskId: second.id, participantId: agentId, bindingId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'connected work' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const reconnected = requestText(adapter.requests[2]!)
    expect(reconnected).toContain('Second scope objective')
    expect(reconnected).not.toContain('First scope objective')
    expect(reconnected).not.toContain('This Agent session is not connected to a Task.')
    expect(agent.session.deriveMessages().filter(message => message.source.kind === 'development-task-context'))
      .toHaveLength(1)
  })

  it('withdraws a replayed snapshot when no Task binding survives the restart', async () => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const task = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Old restored scope', scope: 'old details', createdBy: owner,
    })
    await ctx.developmentTasks.checkout({
      taskId: task.id, participantId: agentId, bindingId: 'binding-before-restart' as DevelopmentTaskBindingId,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'initial work' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(adapter.requests[0]!)).toContain('Old restored scope')

    const restored = await ctx.agents.create({
      sessionId: SessionId('restored-without-task-binding'),
      seed: agent.session.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue without a shared task' }], source: { kind: 'user' } }))
    await restored.agent.whenIdle()
    expect(requestText(adapter.requests[1]!)).not.toContain('Old restored scope')
    expect(requestText(adapter.requests[1]!)).toContain('This Agent session is not connected to a Task.')
    expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')).toHaveLength(2)
  })

  it('replaces Task A context with Task B for one explicit session binding', async () => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const taskA = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'A-only objective', scope: 'A-only scope', createdBy: owner,
    })
    await ctx.developmentTasks.publishContext({ taskId: taskA.id, participantId: owner, text: 'A-only published context' })
    const taskB = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'B-only objective', scope: 'B-only scope', createdBy: owner,
    })

    const bindingId = 'binding-native-agent-session' as DevelopmentTaskBindingId
    await ctx.developmentTasks.checkout({ taskId: taskA.id, participantId: agentId, bindingId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work on the active task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(adapter.requests[0]!)).toContain('A-only published context')

    await ctx.developmentTasks.checkout({ taskId: taskB.id, participantId: agentId, bindingId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue after checkout' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('B-only objective')
    expect(second).not.toContain('A-only objective')
    expect(second).not.toContain('A-only published context')

    const durable = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')
    expect(durable.map(event => event.type === 'user/message' ? event.data.source : undefined)).toEqual([
      expect.objectContaining({ form: 'snapshot', taskId: taskA.id, revision: 2 }),
      expect.objectContaining({ form: 'snapshot', taskId: taskB.id, revision: 1 }),
    ])
    const derived = agent.session.deriveMessages()
      .filter(message => message.source.kind === 'development-task-context')
    expect(derived).toHaveLength(1)
    expect(derived[0]?.source).toMatchObject({ taskId: taskB.id, revision: 1 })
    expect(ctx.developmentTasks.assignmentList()).toContainEqual(expect.objectContaining({
      participantId: agentId, taskId: taskB.id, acknowledgedRevision: 1,
    }))
  })

  it('uses only the connected Task even when leaving the previous hidden Room fails', async () => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const taskA = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Room A context', scope: 'A', createdBy: owner,
    })
    const taskB = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Room B context', scope: 'B', createdBy: owner,
    })
    const bindingId = 'binding-room-failure-session' as DevelopmentTaskBindingId
    await ctx.developmentTasks.checkout({ taskId: taskA.id, participantId: agentId, bindingId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'prime A' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    vi.spyOn(ctx.developmentRooms, 'leave').mockRejectedValueOnce(new Error('simulated Room leave failure'))
    const switched = await ctx.developmentTasks.checkout({ taskId: taskB.id, participantId: agentId, bindingId })
    expect(switched.assignment.taskId).toBe(taskB.id)
    expect(switched.runtime).toMatchObject({ targetJoined: true, previousLeft: false })
    expect(switched.runtime.warnings).toHaveLength(1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work after partial Room failure' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const request = requestText(adapter.requests[1]!)
    expect(request).toContain('Room B context')
    expect(request).not.toContain('Room A context')
  })
})

async function localSelection(ctx: Context, agentId: DevelopmentParticipantId, owner: DevelopmentParticipantId) {
  const task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Managed local objective', scope: 'Exact current scope', createdBy: owner })
  const { assignment } = await ctx.developmentTasks.checkout({ taskId: task.id, participantId: agentId })
  const epoch = ctx.developmentTasks.assignmentLog().findLast(item => item.bindingId === assignment.bindingId && item.change.kind === 'task-bound')
  if (epoch === undefined) throw new Error('missing actual binding epoch')
  return { task, target: { taskId: task.id, participantId: agentId, taskBindingId: assignment.bindingId,
    bindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } } }
}

function requireActive(result: DevelopmentTaskLocalContextReadResult) {
  if (result.status !== 'active') throw new Error('expected current local Task')
  return result.projection
}

describe('managed owner-local Task admission', () => {
  it('withdraws the live admission capability when the real Loader consumer unloads', async () => {
    const { ctx } = await harness()
    const admission = ctx.get('developmentTaskContextAdmission')
    if (admission === undefined) throw new Error('actual Task consumer is missing')
    expect(admission.signal.aborted).toBe(false)
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context')
    if (entry?.fiber === undefined) throw new Error('actual consumer fiber is missing')
    await entry.fiber.dispose()
    expect(admission.signal.aborted).toBe(true)
    expect(ctx.get('developmentTaskContextAdmission')).toBeUndefined()
    expect(ctx.get('developmentTaskContextBackend')).toBeDefined()
  })

  it.each([false, true])('delegates exactly one injector independently of adjacent pre-step order: prepend=%s', async (prepend) => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Actual user claim' }] })
    const derived = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Plugin derived context' }] })
    ctx.on('agent/pre-step', async (payload, next) => {
      payload.messages.push(derived)
      return await next()
    }, { prepend })
    const claims: UserMessage[][] = []
    ctx.on('development-task-context/admit', async (input) => {
      claims.push([...input.claimed])
      const projection = requireActive(await readLocalTaskContext(ctx, target, 4096, input.signal))
      const pending = replaceLocalTaskContext(input.agent, localContextSnapshotMessage(projection))
      return { ...input.decision, messages: pending === undefined
        ? input.decision.messages : [...input.decision.messages, pending] }
    })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    agent.followup(original)
    await agent.whenIdle()
    expect(compute).toHaveBeenCalledTimes(1)
    expect(claims).toEqual([[original]])
    const request = adapter.requests[0]
    if (request === undefined) throw new Error('actual request missing')
    const messages = request.messages.filter(message => message.role === 'user' && message.source.kind === 'development-task-context')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.source).toMatchObject({ kind: 'development-task-context', form: 'snapshot', version: 3,
      projection: { ...target, activation: { kind: 'exact' } } })
    expect(requestText(request)).toContain('Actual user claim')
    expect(requestText(request)).toContain('Plugin derived context')
    const detached = Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header)
    expect(detached.deriveMessages().filter(message => message.source.kind === 'development-task-context')).toEqual(messages)
    await expect.poll(() => ctx.developmentTasks.assignmentList()
      .find(item => item.bindingId === target.taskBindingId)?.acknowledgedRevision).toBe(1)
  })

  it('retains a captured ordinary revision and reads a concurrent addition next time', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const backend = ctx.developmentTaskContextBackend
    const compute = backend.compute.bind(backend)
    vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => { entered.resolve(undefined); await release.promise; return await compute(input) })
    const reading = readLocalTaskContext(ctx, target, 4096, new AbortController().signal)
    await entered.promise
    await ctx.developmentTasks.publishContext({ taskId: target.taskId, participantId: owner, text: 'Later ordinary fact' })
    release.resolve(undefined)
    const first = requireActive(await reading)
    expect(first.taskRevision).toBe(1)
    expect(first.text).not.toContain('Later ordinary fact')
    const second = requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
    expect(second.taskRevision).toBe(2)
    expect(second.text).toContain('Later ordinary fact')
  })

  it('rejects an old result after clear and checkout reuse the same Task and binding ID', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const backend = ctx.developmentTaskContextBackend
    const compute = backend.compute.bind(backend)
    vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => { entered.resolve(undefined); await release.promise; return await compute(input) })
    const reading = readLocalTaskContext(ctx, target, 4096, new AbortController().signal)
    await entered.promise
    await ctx.developmentTasks.clear({ bindingId: target.taskBindingId, participantId: agentId })
    await ctx.developmentTasks.checkout({ taskId: target.taskId, bindingId: target.taskBindingId, participantId: agentId })
    release.resolve(undefined)
    expect(await reading).toEqual({ status: 'left' })
  })

  it.each(['compute', 'final-view'] as const)('recomputes after a real terminal while %s is held', async (phase) => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const author = 'local-other-author' as DevelopmentParticipantId
    await ctx.developmentRooms.announce({ id: author, kind: 'agent', displayName: 'Author' })
    const { assignment } = await ctx.developmentTasks.checkout({ taskId: target.taskId, participantId: author })
    const epoch = ctx.developmentTasks.assignmentLog().findLast(item => item.bindingId === assignment.bindingId && item.change.kind === 'task-bound')
    if (epoch === undefined) throw new Error('missing author epoch')
    const grant = localContributionGrantSchema.parse({ version: 1, taskId: target.taskId, participantId: author,
      bindingId: assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
      captureId: 'local-reader-capture', captureGeneration: 'local-reader-generation',
      source: { kind: 'tool-observations', name: 'work', tools: ['Write'] }, expiresAt: Date.now() + 60000, maxSamples: 2, maxSampleBytes: 2048 })
    await ctx.developmentTasks.openLocalContribution(grant)
    await ctx.developmentTasks.admitLocalContribution({ grant, sequence: 1, sourceId: '1'.repeat(64) as DevelopmentTaskObservedSourceId,
      result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
        fields: { rootIndex: 0, path: 'work.ts', content: 'WITHDRAW_ME' }, omissions: [] } })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const backend = ctx.developmentTaskContextBackend
    const compute = backend.compute.bind(backend)
    const calls = vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => {
      const output = await compute(input)
      expect(output.text).toContain('WITHDRAW_ME')
      if (phase === 'compute') { entered.resolve(undefined); await release.promise }
      return output
    })
    if (phase === 'final-view') {
      const original = ctx.developmentTasks.currentContextView.bind(ctx.developmentTasks)
      let reads = 0
      vi.spyOn(ctx.developmentTasks, 'currentContextView').mockImplementation(async (taskId) => {
        const captured = await original(taskId)
        if (++reads === 2) { entered.resolve(undefined); await release.promise }
        return captured
      })
    }
    const reading = readLocalTaskContext(ctx, target, 8192, new AbortController().signal)
    await entered.promise
    await ctx.developmentTasks.endLocalContribution({ grant, reason: 'left' })
    release.resolve(undefined)
    const final = requireActive(await reading)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(final.text).not.toContain('WITHDRAW_ME')
    expect(final.omittedSources.some(item => item.reason === 'withdrawn')).toBe(true)
  })

  it('does not deliver a completed projection after caller cancellation', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const backend = ctx.developmentTaskContextBackend
    const compute = backend.compute.bind(backend)
    vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => { entered.resolve(undefined); await release.promise; return await compute(input) })
    const signal = new AbortController()
    const reason = new Error('caller stopped local read')
    const reading = readLocalTaskContext(ctx, target, 4096, signal.signal)
    const rejected = expect(reading).rejects.toBe(reason)
    await entered.promise
    signal.abort(reason)
    release.resolve(undefined)
    await rejected
  })

  it('withdraws failed managed reads without clearing the still-current Task assignment', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    ctx.on('development-task-context/admit', async (input) => {
      let message: UserMessage
      try {
        const projection = requireActive(await readLocalTaskContext(ctx, target, 4096, input.signal))
        message = localContextSnapshotMessage(projection)
      } catch {
        message = localContextWithdrawalMessage('unavailable')
      }
      const pending = replaceLocalTaskContext(input.agent, message)
      return { ...input.decision, messages: pending === undefined
        ? input.decision.messages : [...input.decision.messages, pending] }
    })
    const send = async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue actual work' }] }))
      await agent.whenIdle()
    }
    await send()
    vi.spyOn(ctx.developmentTaskContextBackend, 'compute').mockRejectedValueOnce(new Error('backend temporarily unavailable'))
    await send()
    const request = adapter.requests[1]
    if (request === undefined) throw new Error('withdrawal request missing')
    expect(requestText(request)).not.toContain('Managed local objective')
    expect(requestText(request)).toContain('No current Task context is available (unavailable).')
    expect(requestText(request)).not.toContain('not connected')
    expect(ctx.developmentTasks.assignmentList()).toContainEqual(expect.objectContaining({ taskId: target.taskId }))
    const source = request.messages.find(message => message.source.kind === 'development-task-context')?.source
    expect(source).toEqual({ kind: 'development-task-context', form: 'withdrawn', version: 3, reason: 'unavailable' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')).toHaveLength(2)
  })

  it('pins complete byte budget and rejects edited persisted projection bytes', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const signal = new AbortController().signal
    const baseline = requireActive(await readLocalTaskContext(ctx, target, 4096, signal))
    const bytes = Buffer.byteLength(baseline.text, 'utf8')
    const exact = requireActive(await readLocalTaskContext(ctx, target, bytes, signal))
    expect(exact.text).toBe(baseline.text)
    await expect(readLocalTaskContext(ctx, target, bytes - 1, signal)).rejects.toThrow()
    expect(localContextProjectionSchema.safeParse({ ...exact, text: `${exact.text}changed` }).success).toBe(false)
    expect(localContextProjectionSchema.safeParse({ ...exact, taskBindingId: 'other-binding' }).success).toBe(false)
    expect(localContextProjectionSchema.parse(exact)).toEqual(exact)
  })
})
