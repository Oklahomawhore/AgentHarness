import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskBindingId, DevelopmentTaskId, DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as DevelopmentTaskContext from '../src/index.ts'
import TextContextBackend from '../src/text.ts'
import { localContributionGrantSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { readLocalTaskContext, localContextSnapshotMessage, replaceLocalTaskContext, localContextProjectionSchema, localContextProjectionDigest, localContextWithdrawalMessage, visibleLocalTaskContext } from '../src/local.ts'
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

async function harness(responses = [response('A done'), response('B done'), response('B after Room warning')]) {
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
  const adapter = new RecordingAdapter(responses)
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
    const disconnectedMessages = adapter.requests[1]!.messages
    expect(disconnectedMessages.findIndex(message => message.role === 'assistant'))
      .toBeLessThan(disconnectedMessages.findIndex(message => message.role === 'user' && message.source.kind === 'development-task-context'))

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

  it.each([true, false])('keeps ordinary Agent requests scoped after another participant reuses a cleared binding id (retained: %s)', async (retainEarlierBinding) => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const taskA = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Original participant responsibility', scope: 'Original scope', createdBy: owner,
    })
    const taskB = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Other participant responsibility', scope: 'Other scope', createdBy: owner,
    })
    const ownFact = 'TASK_A_RETAINED_FACT'
    const otherCanary = 'TASK_B_OTHER_PARTICIPANT_CANARY'
    await ctx.developmentTasks.publishContext({ taskId: taskA.id, participantId: owner, text: ownFact })
    await ctx.developmentTasks.publishContext({ taskId: taskB.id, participantId: owner, text: otherCanary })
    const retainedId = 'binding-original-retained' as DevelopmentTaskBindingId
    const reusedId = 'binding-later-reused' as DevelopmentTaskBindingId
    await ctx.developmentTasks.checkout({ taskId: taskA.id, participantId: agentId, bindingId: retainedId })
    await ctx.developmentTasks.checkout({ taskId: taskA.id, participantId: agentId, bindingId: reusedId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start my responsibility' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(adapter.requests[0]!)).toContain(ownFact)

    await ctx.developmentTasks.clear({ bindingId: reusedId, participantId: agentId })
    if (!retainEarlierBinding) await ctx.developmentTasks.clear({ bindingId: retainedId, participantId: agentId })
    const otherAgent = 'other-task-agent' as DevelopmentParticipantId
    await ctx.developmentRooms.announce({ id: otherAgent, kind: 'agent', displayName: 'Other Task Agent' })
    await ctx.developmentTasks.checkout({ taskId: taskB.id, participantId: otherAgent, bindingId: reusedId })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue my responsibility' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const nextRequest = requestText(adapter.requests[1]!)
    expect(nextRequest).not.toContain(otherCanary)
    if (retainEarlierBinding) {
      expect(nextRequest).toContain(ownFact)
      expect(nextRequest).not.toContain('This Agent session is not connected to a Task.')
    } else {
      expect(nextRequest).not.toContain(ownFact)
      expect(nextRequest).toContain('This Agent session is not connected to a Task.')
    }
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
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
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
    const messages = adapter.requests[1]!.messages
    expect(messages.findIndex(message => message.role === 'assistant'))
      .toBeLessThan(messages.findIndex(message => message.role === 'user' && message.source.kind === 'development-task-context'))

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
    expect(compute).toHaveBeenCalledTimes(2)
    const events = agent.session.snapshotEvents().length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'keep working on B' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(compute).toHaveBeenCalledTimes(2)
    expect(agent.session.snapshotEvents().slice(events).filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')).toEqual([])
  })

  it('consolidates a retained retirement node without recomputing or repeating current context', async () => {
    const { ctx, adapter, agent, owner, agentId } = await harness()
    const task = await ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Current restored Task', scope: 'current', createdBy: owner,
    })
    await ctx.developmentTasks.checkout({ taskId: task.id, participantId: agentId })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    const send = async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue current work' }] }))
      await agent.whenIdle()
    }
    await send()
    agent.session.append('user/message', createUserMessage({
      source: { kind: 'development-task-context', form: 'retired', version: 1, activeTaskId: task.id, activeRevision: task.revision },
      content: [{ type: 'text', text: '## Retired Task context\n\nUse only the current connected Task snapshot.' }],
    }), { surfaceOp: 'append' })
    await send()
    expect(compute).toHaveBeenCalledTimes(1)
    const messages = adapter.requests[1]!.messages
    const contextMessages = messages.filter(message => message.role === 'user' && message.source.kind === 'development-task-context')
    expect(contextMessages).toHaveLength(1)
    expect(contextMessages[0]?.content).toEqual(adapter.requests[0]!.messages
      .find(message => message.role === 'user' && message.source.kind === 'development-task-context')?.content)
    expect(messages.findIndex(message => message.role === 'assistant')).toBeLessThan(messages.indexOf(contextMessages[0]!))
    const eventCount = agent.session.snapshotEvents().length
    await send()
    expect(compute).toHaveBeenCalledTimes(1)
    expect(agent.session.snapshotEvents().slice(eventCount).filter(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context')).toEqual([])
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

async function localSelection(ctx: Context, agentId: DevelopmentParticipantId, owner: DevelopmentParticipantId, sessionLabel?: string) {
  const task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Managed local objective', scope: 'Exact current scope', createdBy: owner })
  const { assignment } = await ctx.developmentTasks.checkout({ taskId: task.id, participantId: agentId,
    ...(sessionLabel === undefined ? {} : { sessionLabel }) })
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
  it('withdraws a historical version-1 snapshot without changing its original Session record', async () => {
    const { agent, adapter } = await harness()
    const legacy = createUserMessage({
      source: { kind: 'development-task-context', form: 'snapshot', version: 1,
        taskId: 'historical-task' as DevelopmentTaskId,
        revision: 1 },
      content: [{ type: 'text', text: 'Historical Task facts' }],
    })
    agent.session.append('user/message', legacy, { surfaceOp: 'append' })
    const history = agent.session.snapshotEvents()
    expect(visibleLocalTaskContext(agent).map(event => event.data)).toEqual([legacy])
    const withdrawal = localContextWithdrawalMessage('left')
    expect(replaceLocalTaskContext(agent, withdrawal)).toBeUndefined()
    expect(visibleLocalTaskContext(agent).map(event => event.data)).toEqual([withdrawal])
    expect(agent.session.snapshotEvents().slice(0, history.length)).toEqual(history)
    expect(Session.create(agent.id, structuredClone(agent.session.snapshotEvents()), agent.session.header).deriveMessages())
      .toEqual(agent.session.deriveMessages())
    expect(adapter.requests).toEqual([])
  })

  it.each(['admission', 'acknowledgement'] as const)(
    'keeps Task %s local when an isolated native registry reuses the Session id', async (operation) => {
      const { ctx, agent, agentId, owner, adapter } = await harness()
      const { target } = await localSelection(ctx, agentId, owner)
      const other = ctx.isolate('agents').isolate('sessions').isolate('agentLoop').isolate('systemPrompt').isolate('sessionProjections')
      await other.plugin(SessionStore)
      await other.plugin(AgentRegistry)
      await other.plugin(SystemPrompt, {})
      await other.plugin(SessionProjectionRegistry)
      await other.plugin(AgentLoop, { agents: [] })
      let foreign: Awaited<ReturnType<typeof other.agents.create>> | undefined
      await other.plugin({ name: 'independent-task-session',
        inject: ['agents', 'agentLoop', 'sessions', 'systemPrompt', 'sessionProjections'],
        async apply(consumer) {
          foreign = await consumer.agents.create({ sessionId: agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
        } })
      if (foreign === undefined) throw new Error('the isolated native Agent must finish creation')
      try {
        expect(ctx.agents.get(agent.id)).toBe(agent)
        expect(other.agents.get(agent.id)).toBe(foreign.agent)
        expect(ctx.developmentTaskContextAdmission.signalFor(agent)?.aborted).toBe(false)
        expect(ctx.developmentTaskContextAdmission.signalFor(foreign.agent)).toBeUndefined()
        if (operation === 'admission') {
          foreign.agent.followup(createUserMessage({ source: { kind: 'user' },
            content: [{ type: 'text', text: 'Continue independent work without the other registry Task' }] }))
          await foreign.agent.whenIdle()
          expect(adapter.requests).toHaveLength(1)
          expect(requestText(adapter.requests[0]!)).not.toContain('Managed local objective')
          expect(visibleLocalTaskContext(foreign.agent)).toHaveLength(0)
        } else {
          const projection = requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
          foreign.agent.session.append('turn/start', { turn: 1 })
          foreign.agent.session.append('user/message', localContextSnapshotMessage(projection), { surfaceOp: 'append' })
          foreign.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        }
        // This public owner-queue read settles any acknowledgement queued by the foreign event.
        await ctx.developmentTasks.currentContextView(target.taskId)
        expect(ctx.developmentTasks.assignmentList().find(item => item.bindingId === target.taskBindingId)?.acknowledgedRevision)
          .toBeUndefined()
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my assigned Task' }] }))
        await agent.whenIdle()
        expect(requestText(adapter.requests.at(-1)!)).toContain('Managed local objective')
        await ctx.developmentTasks.currentContextView(target.taskId)
        expect(ctx.developmentTasks.assignmentList().find(item => item.bindingId === target.taskBindingId)?.acknowledgedRevision).toBe(1)
      } finally { await foreign.dispose() }
    },
  )

  it('routes context computation using the selected Session responsibility', async () => {
    const { ctx, agentId, owner } = await harness()
    const sessionLabel = 'Maintain frontend integration with the shared API'
    const { target } = await localSelection(ctx, agentId, owner, sessionLabel)
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
    expect(compute).toHaveBeenCalledTimes(1)
    expect(compute.mock.calls[0]![0].recipient).toEqual({ participantId: agentId, sessionLabel })
  })

  it.each(['missing', 'unrelated'] as const)('rejects schema-valid backend coverage with a %s captured source', async (change) => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    await ctx.developmentTasks.publishContext({ taskId: target.taskId, participantId: owner, text: 'Captured source fact' })
    const signal = new AbortController().signal
    const baseline = requireActive(await readLocalTaskContext(ctx, target, 4096, signal))
    const backend = ctx.developmentTaskContextBackend
    const compute = backend.compute.bind(backend)
    vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => {
      const output = await compute(input)
      const captured = output.selectedSources.find(source => source.kind === 'publication')
      if (captured === undefined) throw new Error('actual captured publication is missing')
      let selectedSources = output.selectedSources.filter(source => source !== captured)
      if (change === 'unrelated') {
        const updated = await ctx.developmentTasks.publishContext({ taskId: target.taskId, participantId: owner, text: 'Later ordinary fact' })
        const later = updated.context.find(item => !input.view.task.context.some(source => source.id === item.id))
        if (later === undefined) throw new Error('actual later publication is missing')
        selectedSources = output.selectedSources.map(source => source === captured ? { ...captured, publicationId: later.id } : source)
        expect(selectedSources).toHaveLength(output.selectedSources.length)
      }
      const fields = { ...baseline, ...output, selectedSources }
      expect(localContextProjectionSchema.safeParse({ ...fields, projectionId: localContextProjectionDigest(fields) }).success).toBe(true)
      return { ...output, selectedSources }
    })
    await expect(readLocalTaskContext(ctx, target, 4096, signal))
      .rejects.toThrow('backend coverage differs from the captured local Root Task')
  })

  it('excludes a foreign-owner Root Task restored and checked out through the real Task service', async () => {
    const { ctx, agentId } = await harness()
    const foreignContext = new Context()
    contexts.push(foreignContext)
    const rooms = new DevelopmentRoomService(foreignContext, { nodeId: 'foreign-owner', presenceTtlMs: 10000,
      maxParticipants: 16, maxRooms: 32, maxTextBytes: 2048 })
    const tasks = new DevelopmentTaskService(foreignContext, { maxTasks: 32, maxEventsPerTask: 64, maxMergeParents: 8,
      maxContextBlockBytes: 65536, maxLineageTasks: 64, maxTextBytes: 2048, roomRetryIntervalMs: 10000 })
    const owner = 'foreign-human-owner' as DevelopmentParticipantId
    await rooms.announce({ id: owner, kind: 'human', displayName: 'Foreign owner' })
    const task = await tasks.create({ origin: { kind: 'root' }, objective: 'Foreign responsibility', scope: 'Foreign scope', createdBy: owner })
    ctx.developmentTasks.restoreLog(tasks.log())
    const { assignment } = await ctx.developmentTasks.checkout({ taskId: task.id, participantId: agentId })
    const epoch = ctx.developmentTasks.assignmentLog().at(-1)
    if (epoch === undefined) throw new Error('missing actual foreign Task assignment epoch')
    expect(ctx.developmentTasks.get({ taskId: task.id }).ownerNodeId).not.toBe(ctx.developmentRooms.list().nodeId)
    expect(ctx.developmentTasks.assignmentList()).toContainEqual(assignment)
    await expect(readLocalTaskContext(ctx, { taskId: task.id, participantId: agentId, taskBindingId: assignment.bindingId,
      bindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }, 4096, new AbortController().signal)).resolves.toEqual({ status: 'left' })
  })

  it('accepts the current local Root assignment and excludes cleared assignments and fork Tasks', async () => {
    const { ctx, agentId, owner } = await harness()
    const { task, target } = await localSelection(ctx, agentId, owner)
    const signal = new AbortController().signal
    expect(requireActive(await readLocalTaskContext(ctx, target, 4096, signal))).toMatchObject(target)
    await ctx.developmentTasks.clear({ bindingId: target.taskBindingId, participantId: agentId })
    expect(await readLocalTaskContext(ctx, target, 4096, signal)).toEqual({ status: 'left' })
    const fork = await ctx.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: task.revision } },
      objective: 'Review inherited work', scope: 'Historical task', createdBy: owner })
    const { assignment } = await ctx.developmentTasks.checkout({ taskId: fork.id, participantId: agentId })
    const epoch = ctx.developmentTasks.assignmentLog().at(-1)
    if (epoch === undefined) throw new Error('missing actual fork assignment epoch')
    expect(await readLocalTaskContext(ctx, { ...target, taskId: fork.id, taskBindingId: assignment.bindingId,
      bindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }, 4096, signal)).toEqual({ status: 'left' })
  })

  it('rejects a captured view after the assignment clears before computation starts', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const currentContextView = ctx.developmentTasks.currentContextView.bind(ctx.developmentTasks)
    vi.spyOn(ctx.developmentTasks, 'currentContextView').mockImplementationOnce(async (taskId) => {
      const view = await currentContextView(taskId)
      entered.resolve(undefined)
      await release.promise
      return view
    })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    const reading = readLocalTaskContext(ctx, target, 4096, new AbortController().signal)
    const settled = Promise.allSettled([reading])
    try {
      await entered.promise
      await ctx.developmentTasks.clear({ bindingId: target.taskBindingId, participantId: agentId })
      release.resolve(undefined)
      expect(await reading).toEqual({ status: 'left' })
      expect(compute).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await settled
    }
  })

  it('recomputes with the replacement backend after its real Loader entry reloads', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const backend = ctx.developmentTaskContextBackend
    const identity = backend.identity
    const compute = backend.compute.bind(backend)
    const oldCompute = vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => {
      const projection = await compute(input)
      entered.resolve(undefined)
      await release.promise
      return projection
    })
    const reading = readLocalTaskContext(ctx, target, 4096, new AbortController().signal)
    const settled = Promise.allSettled([reading])
    try {
      await entered.promise
      const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context/text')
      if (entry === undefined) throw new Error('actual context backend entry is missing')
      await entry.update({ disabled: true })
      expect(ctx.get('developmentTaskContextBackend')).toBeUndefined()
      await entry.update({ disabled: false })
      await ctx.loader.await()
      const replacement = ctx.developmentTaskContextBackend
      expect(replacement.identity).not.toBe(identity)
      const newCompute = vi.spyOn(replacement, 'compute')
      release.resolve(undefined)
      const projection = requireActive(await reading)
      expect(projection).toMatchObject({ ...target, backend: replacement.identity })
      expect(oldCompute).toHaveBeenCalledTimes(1)
      expect(newCompute).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(undefined)
      await settled
    }
  })

  it('discards a captured view before computation when its Task service reloads with the same assignment', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const tasks = ctx.developmentTasks
    const log = tasks.log()
    const assignments = tasks.assignmentLog()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const currentContextView = tasks.currentContextView.bind(tasks)
    vi.spyOn(tasks, 'currentContextView').mockImplementationOnce(async (taskId) => {
      const view = await currentContextView(taskId)
      entered.resolve(undefined)
      await release.promise
      return view
    })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    const reading = readLocalTaskContext(ctx, target, 4096, new AbortController().signal)
    const settled = Promise.allSettled([reading])
    try {
      await entered.promise
      const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task')
      if (entry === undefined) throw new Error('actual Task service entry is missing')
      await entry.update({ disabled: true })
      expect(ctx.get('developmentTasks')).toBeUndefined()
      await entry.update({ disabled: false })
      await ctx.loader.await()
      ctx.developmentTasks.restoreLog(log)
      ctx.developmentTasks.restoreAssignmentLog(assignments)
      await ctx.developmentTasks.publishContext({ taskId: target.taskId, participantId: owner, text: 'FACT_FROM_RELOADED_TASK_SERVICE' })
      release.resolve(undefined)
      const projection = requireActive(await reading)
      expect(projection.text).toContain('FACT_FROM_RELOADED_TASK_SERVICE')
      expect(compute).toHaveBeenCalledTimes(1)
      expect(compute.mock.calls[0]![0].view.task.revision).toBe(projection.taskRevision)
    } finally {
      release.resolve(undefined)
      await settled
    }
  })

  it('rejects a captured view when the real Loader backend unloads before computation', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const currentContextView = ctx.developmentTasks.currentContextView.bind(ctx.developmentTasks)
    vi.spyOn(ctx.developmentTasks, 'currentContextView').mockImplementationOnce(async (taskId) => {
      const view = await currentContextView(taskId)
      entered.resolve(undefined)
      await release.promise
      return view
    })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    const reading = readLocalTaskContext(ctx, target, 4096, new AbortController().signal)
    const settled = Promise.allSettled([reading])
    try {
      await entered.promise
      const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context/text')
      if (entry === undefined) throw new Error('actual context backend entry is missing')
      await entry.update({ disabled: true })
      expect(ctx.get('developmentTaskContextBackend')).toBeUndefined()
      release.resolve(undefined)
      await expect(reading).rejects.toThrow('local reads require developmentTaskContextBackend')
      expect(compute).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await settled
    }
  })

  it('rejects local reads after the real Loader Task service unloads', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task')
    if (entry === undefined) throw new Error('actual Task service entry is missing')
    await entry.update({ disabled: true })
    expect(ctx.get('developmentTasks')).toBeUndefined()
    await expect(readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
      .rejects.toThrow('local reads require developmentTasks')
  })

  it('does not borrow Room identity from another isolation realm for a local Task read', async () => {
    const { ctx, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const isolated = ctx.isolate('developmentRooms')
    expect(isolated.get('developmentTasks')).toBeDefined()
    expect(isolated.get('developmentRooms')).toBeUndefined()
    await expect(readLocalTaskContext(isolated, target, 4096, new AbortController().signal))
      .rejects.toThrow('local reads require developmentRooms')
    expect(requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))).toMatchObject(target)
  })

  it('rejects restored local snapshot text that differs from its valid recorded projection', async () => {
    const { ctx, agent, agentId, owner, adapter } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const projection = requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
    agent.session.append('user/message', localContextSnapshotMessage(projection), { surfaceOp: 'append' })
    const seed = agent.session.snapshotEvents()
    const original = await ctx.agents.create({ sessionId: SessionId('local-history-original'), seed,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(visibleLocalTaskContext(original.agent)).toHaveLength(1)
    const changed = seed.map(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context'
      ? { ...event, data: { ...event.data, content: [{ type: 'text' as const, text: 'FORGED_LOCAL_CONTEXT' }] } } : event)
    const restored = await ctx.agents.create({ sessionId: SessionId('local-history-changed'), seed: changed,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(localContextProjectionSchema.parse(projection)).toEqual(projection)
    expect(() => visibleLocalTaskContext(restored.agent)).toThrow('local snapshot text differs from its recorded projection')
    restored.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do not trust the edited context' }] }))
    await restored.agent.whenIdle()
    expect(restored.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data)
      .toMatchObject({ reason: { kind: 'error', error: { message: 'development-task-context: local snapshot text differs from its recorded projection' } } })
    expect(adapter.requests).toEqual([])
  })

  it('rejects restored source metadata that fails the durable parser before a model request', async () => {
    const { ctx, agent, agentId, owner, adapter } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const projection = requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
    agent.session.append('user/message', localContextSnapshotMessage(projection), { surfaceOp: 'append' })
    const changed = agent.session.snapshotEvents().map(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context' && event.data.source.form === 'snapshot' && event.data.source.version === 3
      ? { ...event, data: { ...event.data, source: { ...event.data.source, projection: { ...event.data.source.projection,
        backend: { ...event.data.source.projection.backend, id: '' } } } } } : event)
    const { agent: restored } = await ctx.agents.create({ sessionId: SessionId('local-invalid-source-metadata'), seed: changed,
      agentOptions: { provider: 'mock', model: 'mock' } })
    restored.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do not trust invalid source metadata' }] }))
    await restored.whenIdle()
    const ending = restored.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end' || ending.data.reason.kind !== 'error') throw new Error('expected rejected restored metadata')
    expect(ending.data.reason.error.message).toContain('invalid durable development-task-context source')
    expect(adapter.requests).toEqual([])
  })

  it('does not credit another stored Session for the original Agent Task projection', async () => {
    const { ctx, agent, agentId, owner, adapter } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const projection = requireActive(await readLocalTaskContext(ctx, target, 4096, new AbortController().signal))
    const other = ctx.sessions.create(SessionId('stored-session-without-agent'))
    expect(ctx.agents.get(other.id)).toBeUndefined()
    other.append('turn/start', { turn: 1 })
    other.append('user/message', localContextSnapshotMessage(projection), { surfaceOp: 'append' })
    other.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.developmentTasks.assignmentList().find(item => item.bindingId === target.taskBindingId)?.acknowledgedRevision)
      .toBeUndefined()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue only my own Task' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    await expect.poll(() => ctx.developmentTasks.assignmentList()
      .find(item => item.bindingId === target.taskBindingId)?.acknowledgedRevision).toBe(1)
    expect(ctx.agents.get(other.id)).toBeUndefined()
  })

  it('withdraws the live admission capability when the real Loader consumer unloads', async () => {
    const { ctx, agent } = await harness()
    const admission = ctx.get('developmentTaskContextAdmission')
    if (admission === undefined) throw new Error('actual Task consumer is missing')
    const signal = admission.signalFor(agent)
    if (signal === undefined) throw new Error('actual Task consumer does not handle its Agent')
    expect(signal.aborted).toBe(false)
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context')
    if (entry?.fiber === undefined) throw new Error('actual consumer fiber is missing')
    await entry.fiber.dispose()
    expect(signal.aborted).toBe(true)
    expect(ctx.get('developmentTaskContextAdmission')).toBeUndefined()
    expect(ctx.get('developmentTaskContextBackend')).toBeDefined()
  })

  it('retains unsubmitted input when the Loader consumer unloads while a downstream pre-step is waiting', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    await localSelection(ctx, agentId, owner)
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const removeBarrier = ctx.on('agent/pre-step', async ({ signal }, next) => {
      entered.resolve(signal)
      await release.promise
      return next()
    })
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep my pending responsibility' }] })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context')
    if (entry === undefined) throw new Error('actual consumer entry is missing')
    agent.followup(original)
    const idle = agent.whenIdle()
    try {
      const signal = await entered.promise
      await entry.update({ disabled: true })
      await ctx.loader.await()
      expect(signal.aborted).toBe(false)
      release.resolve(undefined)
      await idle
      expect(adapter.requests).toHaveLength(0)
      expect(compute).not.toHaveBeenCalled()
      expect(agent.inbox.nextStep.filter(message => message.id === original.id)).toEqual([original])
      expect(visibleLocalTaskContext(agent)).toHaveLength(0)
      removeBarrier()
      await entry.update({ disabled: false })
      await ctx.loader.await()
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after the consumer reloads' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.messages.filter(message => message.id === original.id)).toEqual([original])
      expect(requestText(adapter.requests[0]!)).toContain('Managed local objective')
      expect(agent.inbox.nextStep).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      removeBarrier()
      await idle
      await agent.whenIdle()
    }
  })

  it('honors an admission plugin rejection without falling back to passive Task injection', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    const policy = ctx.plugin({ name: 'reject-task-admission', apply(consumer) {
      consumer.on('development-task-context/admit', async () => ({ kind: 'reject' }))
    } })
    try {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Wait for my admission policy' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
      expect(compute).not.toHaveBeenCalled()
      expect(visibleLocalTaskContext(agent)).toHaveLength(0)
      expect(ctx.developmentTasks.latestAssignment(agentId)?.bindingId).toBe(target.taskBindingId)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
        .toMatchObject({ data: { reason: { kind: 'blocked' } } })
      await policy.dispose()
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after the policy unloads' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0]!)).toContain('Managed local objective')
      expect(compute).toHaveBeenCalledTimes(1)
    } finally { await policy.dispose(); await agent.whenIdle() }
  })

  it('retains only the delegate-selected ordinary input after Task computation fails', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    await localSelection(ctx, agentId, owner)
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Preserve this original responsibility' }] })
    const derived = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Temporary derived admission context' }] })
    const removeDerived = ctx.on('agent/pre-step', async (payload, next) => { payload.messages.push(derived); return next() })
    const policy = ctx.plugin({ name: 'retain-only-claimed-input', apply(consumer) {
      consumer.on('development-task-context/admit', async (input, next) => { input.retainInput(input.claimed); return next() })
    } })
    vi.spyOn(ctx.developmentTaskContextBackend, 'compute').mockRejectedValueOnce(new Error('backend temporarily unavailable'))
    try {
      agent.followup(original)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextStep).toEqual([original])
      expect(visibleLocalTaskContext(agent)).toHaveLength(0)
      removeDerived()
      await policy.dispose()
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after backend recovery' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.messages.filter(message => message.id === original.id)).toEqual([original])
      expect(adapter.requests[0]!.messages.some(message => message.id === derived.id)).toBe(false)
      expect(requestText(adapter.requests[0]!)).toContain('Managed local objective')
    } finally { removeDerived(); await policy.dispose(); await agent.whenIdle() }
  })

  it('rechecks the selected Task when an admission delegate changes its binding after passive computation', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    const { target } = await localSelection(ctx, agentId, owner)
    const replacement = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: owner,
      objective: 'Replacement human responsibility', scope: 'Use the new assignment only' })
    let switched = false
    const policy = ctx.plugin({ name: 'switch-after-passive-admission', apply(consumer) {
      consumer.on('development-task-context/admit', async (_input, next) => {
        const decision = await next()
        if (!switched) {
          switched = true
          await ctx.developmentTasks.checkout({ taskId: replacement.id, participantId: agentId, bindingId: target.taskBindingId })
        }
        return decision
      })
    } })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    try {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my current responsibility' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(compute.mock.calls.map(([input]) => input.view.task.id)).toEqual([target.taskId, replacement.id])
      expect(requestText(adapter.requests[0]!)).toContain('Replacement human responsibility')
      expect(requestText(adapter.requests[0]!)).not.toContain('Managed local objective')
      expect(adapter.requests[0]!.messages.filter(message => message.source.kind === 'development-task-context')).toHaveLength(1)
      const history = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'development-task-context')
      expect(history).toHaveLength(1)
      expect(JSON.stringify(history[0])).toContain('Replacement human responsibility')
      expect(JSON.stringify(history)).not.toContain('Managed local objective')
      expect(Session.create(agent.id, structuredClone(agent.session.snapshotEvents()), agent.session.header).deriveMessages())
        .toEqual(agent.session.deriveMessages())
    } finally { await policy.dispose(); await agent.whenIdle() }
  })

  it('passes the ordinary Session responsibility to its actual passive Task computation', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    const sessionLabel = 'Maintain the frontend responsibility'
    await localSelection(ctx, agentId, owner, sessionLabel)
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my assigned frontend work' }] }))
    await agent.whenIdle()
    expect(compute).toHaveBeenCalledTimes(1)
    expect(compute.mock.calls[0]![0].recipient).toEqual({ participantId: agentId, sessionLabel })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.messages.find(message => message.source.kind === 'development-task-context')?.source)
      .toMatchObject({ version: 2, form: 'snapshot' })
    expect(requestText(adapter.requests[0]!)).toContain('Managed local objective')
  })

  it('continues after a real tool result without claiming the same ordinary input again', async () => {
    const call = { type: 'tool-call' as const, id: ToolCallId('task-context-read'), name: 'read_task_fixture', arguments: '{}' }
    const { ctx, agent, adapter, agentId, owner } = await harness([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: call }, { type: 'finish', reason: { kind: 'tool-calls' } },
    ], response('Task work completed')])
    await localSelection(ctx, agentId, owner)
    const execute = vi.fn(async () => [{ type: 'text' as const, text: 'Fixture read completed' }])
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: call.name, description: 'Read a fixture-owned value', parameters: {}, execute })))
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read once and finish my Task' }] })
    const claims: (readonly UserMessage[])[] = []
    ctx.on('development-task-context/admit', async (input, next) => { claims.push([...input.claimed]); return next() })
    const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
    agent.followup(original)
    await agent.whenIdle()
    expect(execute).toHaveBeenCalledOnce()
    expect(adapter.requests).toHaveLength(2)
    expect(claims).toEqual([[original], []])
    expect(compute).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Fixture read completed')
    expect(adapter.requests[1]!.messages.filter(message => message.id === original.id)).toEqual([original])
    expect(adapter.requests[1]!.messages.filter(message => message.source.kind === 'development-task-context')).toHaveLength(1)
    expect(Session.create(agent.id, structuredClone(agent.session.snapshotEvents()), agent.session.header).deriveMessages())
      .toEqual(agent.session.deriveMessages())
  })

  it('exposes a scoped injector only to the actual Agent whose scope receives its events', async () => {
    const { ctx, agent, adapter, agentId, owner } = await harness()
    await localSelection(ctx, agentId, owner)
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task-context')
    if (entry === undefined) throw new Error('actual consumer entry is missing')
    await entry.update({ disabled: true })
    await ctx.loader.await()
    const scope = createScope(ctx, agent)
    const consumer = scope.ctx.plugin(DevelopmentTaskContext, { maxContextBytesPerStep: 4096 })
    const outside = await ctx.agents.create({ sessionId: SessionId('outside-task-injector-scope'), agentOptions: { provider: 'mock', model: 'mock' } })
    try {
      const admission = ctx.get('developmentTaskContextAdmission')
      if (admission === undefined) throw new Error('scoped Task consumer is missing')
      expect(admission.signalFor(agent)?.aborted).toBe(false)
      expect(admission.signalFor(outside.agent)).toBeUndefined()
      outside.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue independent work' }] }))
      await outside.agent.whenIdle()
      expect(requestText(adapter.requests[0]!)).not.toContain('Managed local objective')
      expect(visibleLocalTaskContext(outside.agent)).toHaveLength(0)
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my scoped responsibility' }] }))
      await agent.whenIdle()
      expect(requestText(adapter.requests[1]!)).toContain('Managed local objective')
    } finally { await outside.dispose(); await consumer.dispose(); await scope.dispose() }
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
