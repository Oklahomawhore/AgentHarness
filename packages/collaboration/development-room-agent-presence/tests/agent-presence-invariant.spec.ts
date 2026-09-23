import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, developmentAgentParticipantId } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
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
})
