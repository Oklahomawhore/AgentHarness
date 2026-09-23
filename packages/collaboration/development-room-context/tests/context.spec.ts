import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DevelopmentRoomService, {
  type DevelopmentParticipantId,
  type DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import DevelopmentRoomContextService, {
  DevelopmentRoomContextError,
  type DevelopmentRoomContextEntry,
} from '@deepseek-ai/dsh-development-room-context'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('script exhausted')
    for (const chunk of response) yield chunk
  }
}

async function harness(options: { maxTextBytes?: number; maxEntriesPerStep?: number } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DevelopmentRoomService, {
    nodeId: 'node-a',
    presenceTtlMs: 10_000,
    maxParticipants: 16,
    maxRooms: 8,
    maxTextBytes: 512,
  })
  await ctx.plugin(DevelopmentRoomContextService, {
    maxTextBytes: options.maxTextBytes ?? 512,
    maxEntriesPerStep: options.maxEntriesPerStep ?? 16,
  })
  return ctx
}

async function joinHuman(ctx: Context, roomId: DevelopmentRoomId, id = 'alice'): Promise<DevelopmentParticipantId> {
  const participantId = id as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: participantId, kind: 'human', displayName: 'Alice' })
  await ctx.developmentRooms.join({ roomId, participantId })
  return participantId
}

async function joinAgent(ctx: Context, roomId: DevelopmentRoomId, agent: Agent): Promise<DevelopmentParticipantId> {
  const participantId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Agent' })
  await ctx.developmentRooms.join({ roomId, participantId })
  return participantId
}

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function contextEvents(agent: Agent): Array<SessionEvent<'user/message'>> {
  return agent.session.snapshotEvents().filter(
    (event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind === 'development-room-context',
  )
}

describe('DevelopmentRoomContextService', () => {
  it('rejects invalid direct constructor bounds', () => {
    const context = (): Context => {
      const ctx = new Context()
      contexts.push(ctx)
      new DevelopmentRoomService(ctx, {
        nodeId: 'node-a', presenceTtlMs: 10_000, maxParticipants: 8, maxRooms: 4, maxTextBytes: 256,
      })
      return ctx
    }
    expect(() => new DevelopmentRoomContextService(context(), { maxTextBytes: 0, maxEntriesPerStep: 1 }))
      .toThrow('maxTextBytes must be a positive safe integer')
    expect(() => new DevelopmentRoomContextService(context(), { maxTextBytes: 1, maxEntriesPerStep: 1.5 }))
      .toThrow('maxEntriesPerStep must be a positive safe integer')
  })

  it('admits each joined-room entry once and continues bounded backlog on later requests', async () => {
    const ctx = await harness({ maxEntriesPerStep: 1 })
    const adapter = new ScriptedAdapter([
      textResponse('one'), textResponse('two'), textResponse('three'), textResponse('four'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('agent-one'), { provider: 'mock', model: 'mock' })
    const room = await ctx.developmentRooms.create({ objective: 'Release coordination' })
    const alice = await joinHuman(ctx, room.id)
    const agentParticipant = await joinAgent(ctx, room.id, agent)
    await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'Alpha context' })
    await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'Beta context' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(contextEvents(agent)).toHaveLength(2)
    expect(requestText(adapter.requests[0]!)).toContain('Alpha context')
    expect(requestText(adapter.requests[0]!)).not.toContain('Beta context')
    expect(requestText(adapter.requests[1]!)).toContain('Alpha context')
    expect(requestText(adapter.requests[1]!)).toContain('Beta context')
    expect(requestText(adapter.requests[2]!).match(/Alpha context/g)).toHaveLength(1)
    expect(contextEvents(agent).map(event => event.data.source)).toEqual([
      {
        kind: 'development-room-context', form: 'snapshot', version: 1,
        entries: [{ nodeId: 'node-a', seq: 1 }],
      },
      {
        kind: 'development-room-context', form: 'snapshot', version: 1,
        entries: [{ nodeId: 'node-a', seq: 2 }],
      },
    ])

    await ctx.developmentRooms.leave({ roomId: room.id, participantId: agentParticipant })
    await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'Gamma context' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'after leave' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(adapter.requests[3]!)).not.toContain('Gamma context')
    expect(contextEvents(agent)).toHaveLength(2)
  })

  it('groups several unseen entries from one room into one request message', async () => {
    const ctx = await harness()
    const adapter = new ScriptedAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('agent-grouped'), { provider: 'mock', model: 'mock' })
    const room = await ctx.developmentRooms.create({ objective: 'Grouped context' })
    const alice = await joinHuman(ctx, room.id)
    await joinAgent(ctx, room.id, agent)
    await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'first entry' })
    await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'second entry' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use both' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(contextEvents(agent)).toHaveLength(1)
    const source = contextEvents(agent)[0]?.data.source
    if (source?.kind !== 'development-room-context') throw new Error('missing development-room-context source')
    expect(source.entries).toHaveLength(2)
    expect(requestText(adapter.requests[0]!)).toContain('first entry')
    expect(requestText(adapter.requests[0]!)).toContain('second entry')
  })

  it('accepts publications only from current members and enforces UTF-8 bounds', async () => {
    const ctx = await harness({ maxTextBytes: 5 })
    const room = await ctx.developmentRooms.create({ objective: 'Bounds' })
    const alice = 'alice' as DevelopmentParticipantId
    await ctx.developmentRooms.announce({ id: alice, kind: 'human', displayName: 'Alice' })

    await expect(ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'hello' }))
      .rejects.toMatchObject({ code: 'NOT_ROOM_MEMBER' })
    await ctx.developmentRooms.join({ roomId: room.id, participantId: alice })
    await expect(ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: '   ' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: '你好' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(ctx.developmentRoomContexts.share({
      roomId: 'room-missing' as DevelopmentRoomId,
      participantId: alice,
      text: 'x',
    })).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' })
  })

  it('publishes only after persistence and preserves the next sequence after failure', async () => {
    const ctx = await harness()
    const room = await ctx.developmentRooms.create({ objective: 'Persistence' })
    const alice = await joinHuman(ctx, room.id)
    const stop = ctx.on('development-room-context/persist', () => {
      throw new Error('disk unavailable')
    })

    await expect(ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'first' }))
      .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(ctx.developmentRoomContexts.log()).toEqual([])
    stop()
    const stopString = ctx.on('development-room-context/persist', () => {
      throw 'still unavailable'
    })
    await expect(ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'second' }))
      .rejects.toThrow('still unavailable')
    stopString()
    const committed = await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'retry' })
    expect(committed.seq).toBe(1)
  })

  it('restores equivalent positions idempotently and rejects gaps or divergence', async () => {
    const ctx = await harness()
    const entry: DevelopmentRoomContextEntry = {
      nodeId: 'node-a' as DevelopmentRoomContextEntry['nodeId'],
      seq: 1,
      at: 1,
      roomId: 'room-restored' as DevelopmentRoomId,
      participantId: 'alice' as DevelopmentParticipantId,
      text: 'restored',
    }
    ctx.developmentRoomContexts.restoreLocalLog([entry, entry])
    expect(ctx.developmentRoomContexts.log()).toEqual([entry])
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, text: 'different' }]) })
      .toThrow(DevelopmentRoomContextError)
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, seq: 3 }]) })
      .toThrow(/expected sequence 2/)
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, nodeId: 'node-b' as typeof entry.nodeId, seq: 2 }]) })
      .toThrow(/foreign node/)
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, seq: 0 }]) })
      .toThrow(/invalid sequence or timestamp/)
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, seq: 2, at: -1 }]) })
      .toThrow(/invalid sequence or timestamp/)
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, seq: 2, text: '   ' }]) })
      .toThrow(/invalid text/)
    expect(() => { ctx.developmentRoomContexts.restoreLocalLog([{ ...entry, seq: 2, text: 'x'.repeat(513) }]) })
      .toThrow(/invalid text/)
  })

  it('preserves rejected or aborted pre-step decisions and fails loud on invalid durable sources', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('agent-pre-step'), { provider: 'mock', model: 'mock' })
    const rejected = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(rejected).toEqual({ kind: 'reject' })

    const controller = new AbortController()
    controller.abort()
    const aborted = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(aborted).toEqual({ kind: 'enter', messages: [] })

    const room = await ctx.developmentRooms.create({ objective: 'Invalid durable source' })
    await joinAgent(ctx, room.id, agent)
    const alice = await joinHuman(ctx, room.id)
    await ctx.developmentRoomContexts.share({ roomId: room.id, participantId: alice, text: 'shared' })
    const invalid = createUserMessage({
      content: [{ type: 'text', text: 'invalid' }],
      source: {
        kind: 'development-room-context', form: 'snapshot', version: 1, entries: [],
      } as never,
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      {
        messages: [invalid],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: 'enter' as const, messages: [invalid] }),
    )).rejects.toThrow('invalid durable development-room-context source')
  })
})
