import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, developmentAgentParticipantId } from '../src/index.ts'
import * as PresenceInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

function stubAgent(ctx: Context, rawId: string): { agent: Agent; setStatus(status: AgentStatus): void } {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: {} as Agent['inbox'],
    get status() { return status },
    ctx: ctx.extend(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, setStatus: (next) => { status = next } }
}

async function bench(): Promise<{ ctx: Context; agents: AgentRegistry; rooms: DevelopmentRoomService }> {
  const ctx = new Context()
  contexts.push(ctx)
  const agents = new AgentRegistry(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId: 'node-a',
    presenceTtlMs: 10_000,
    maxParticipants: 8,
    maxRooms: 4,
    maxTextBytes: 256,
  })
  return { ctx, agents, rooms }
}

describe('development-room Agent presence', () => {
  it('projects existing and newly created Agents, status changes, and disposal', async () => {
    const { ctx, agents, rooms } = await bench()
    const existing = stubAgent(ctx, 'existing-session')
    agents.register(existing.agent)
    apply(ctx, { heartbeatMs: 5_000 })

    const projectedId = developmentAgentParticipantId(existing.agent.id)
    await vi.waitFor(() => {
      expect(rooms.list().participants).toMatchObject([{
        id: projectedId, kind: 'agent', presence: 'online',
      }])
    })

    existing.setStatus('running')
    agentEvents(ctx, existing.agent).emit('agent/status', { status: 'running' })
    await vi.waitFor(() => {
      expect(rooms.list().participants[0]).toMatchObject({ presence: 'online' })
    })

    const created = stubAgent(ctx, 'created-session')
    const disposeCreated = agents.register(created.agent)
    await vi.waitFor(() => {
      expect(rooms.list().participants.map(item => item.id)).toContain(developmentAgentParticipantId(created.agent.id))
    })
    disposeCreated()
    await vi.waitFor(() => {
      expect(rooms.list().participants.find(item => item.id === developmentAgentParticipantId(created.agent.id)))
        .toMatchObject({ presence: 'offline' })
    })
  })

  it('derives stable opaque lower-kebab identities', () => {
    expect(developmentAgentParticipantId(SessionId('Private/Session ID'))).toMatch(/^agent-[a-f0-9]{20}$/)
    expect(developmentAgentParticipantId(SessionId('Private/Session ID')))
      .toBe(developmentAgentParticipantId(SessionId('Private/Session ID')))
  })

  it('renews leases on the configured cadence and withdraws when its plugin unloads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'))
    const { ctx, agents, rooms } = await bench()
    const existing = stubAgent(ctx, 'periodic-session')
    agents.register(existing.agent)
    const projection = ctx.plugin({ inject: ['agents', 'developmentRooms'], apply }, { heartbeatMs: 5_000 })
    await projection
    await vi.advanceTimersByTimeAsync(0)
    const initial = rooms.list().participants[0]!
    await vi.advanceTimersByTimeAsync(5_000)
    expect(rooms.list().participants[0]).toMatchObject({ presence: 'online', lastSeenAt: initial.lastSeenAt + 5_000 })
    await projection.dispose()
    expect(rooms.list().participants[0]).toMatchObject({ presence: 'offline' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rooms.list().participants[0]).toMatchObject({ presence: 'offline', lastSeenAt: 0 })
  })

  it('ignores disposal for an Agent that was not projected', async () => {
    const { ctx, rooms } = await bench()
    apply(ctx, { heartbeatMs: 5_000 })
    const unregistered = stubAgent(ctx, 'unregistered-session')
    agentEvents(ctx, unregistered.agent).emit('agent/disposed', {})
    expect(rooms.list().participants).toEqual([])
  })

  it('preserves existing participant leases when an Agent announcement exceeds capacity', async () => {
    const { ctx, agents, rooms } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    for (let index = 0; index < 8; index++) {
      await rooms.announce({ id: `human-${String(index)}` as ReturnType<typeof developmentAgentParticipantId>,
        kind: 'human', displayName: 'Human' })
    }
    agents.register(stubAgent(ctx, 'capacity-session').agent)
    apply(ctx, { heartbeatMs: 5_000 })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('announcement failed')) })
    expect(rooms.list().participants).toHaveLength(8)
    expect(rooms.list().participants.every(participant => participant.kind === 'human')).toBe(true)
  })
})

describe('live-Agent presence invariant', () => {
  it('accepts unrelated presence without requiring an Agent registry', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(PresenceInvariant)
    const rooms = new DevelopmentRoomService(ctx, { nodeId: 'node-a', presenceTtlMs: 10_000,
      maxParticipants: 8, maxRooms: 4, maxTextBytes: 256 })
    await expect(rooms.announce({ id: 'human' as ReturnType<typeof developmentAgentParticipantId>,
      kind: 'human', displayName: 'Human' })).resolves.toMatchObject({ participants: [{ kind: 'human' }] })
  })

  it('rejects mismatched kind and offline presence for a live Agent and removes its checks on unload', async () => {
    const { ctx, agents, rooms } = await bench()
    const existing = stubAgent(ctx, 'invariant-session')
    agents.register(existing.agent)
    const id = developmentAgentParticipantId(existing.agent.id)
    await ctx.plugin(InvariantRegistry)
    const invariant = ctx.plugin(PresenceInvariant)
    await invariant
    await rooms.announce({ id: 'unrelated' as typeof id, kind: 'human', displayName: 'Human' })
    await rooms.announce({ id, kind: 'agent', displayName: 'Agent' })
    const violation = { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-development-room-agent-presence' }
    await expect(rooms.announce({ id, kind: 'human', displayName: 'Wrong kind' })).rejects.toMatchObject(violation)
    await rooms.announce({ id, kind: 'agent', displayName: 'Agent' })
    await expect(rooms.withdraw({ participantId: id })).rejects.toMatchObject(violation)
    await invariant.dispose()
    await expect(rooms.announce({ id, kind: 'human', displayName: 'No projection checks' })).resolves.toBeDefined()
  })
})
