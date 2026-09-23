import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskBindingId } from '@deepseek-ai/dsh-development-task/types'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as DevelopmentTaskContext from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
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
  await ctx.plugin(DevelopmentRoomService, {
    nodeId: 'node-a', presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 2_048,
  })
  await ctx.plugin(DevelopmentTaskService, {
    maxTasks: 32, maxEventsPerTask: 64,
    maxMergeParents: 8, maxContextBlockBytes: 65_536, maxLineageTasks: 64, maxTextBytes: 2_048, roomRetryIntervalMs: 10_000,
  })
  await ctx.plugin(DevelopmentTaskContext, { maxContextBytesPerStep: 65_536 })
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
