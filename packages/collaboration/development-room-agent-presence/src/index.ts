/** Project live Harness agents into development-room participant leases. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

/** Lease cadence for projected agents. */
export interface Config {
  /** Milliseconds between lease renewals for every live agent. */
  readonly heartbeatMs: number
}

/** Runtime validation for the agent-presence projection configuration. */
export const Config: z.ZodType<Config> = z.object({
  heartbeatMs: z.number().int().positive(),
})

/** Services required to project live agents into development rooms. */
export const inject = ['agents', 'developmentRooms']

/**
 * Derive the stable room participant identity for one Agent Session.
 * @param id - durable Agent and Session identity.
 * @returns lower-kebab participant identity that does not expose the Session id.
 */
export function developmentAgentParticipantId(id: SessionId | string): DevelopmentParticipantId {
  const digest = createHash('sha256').update(String(id)).digest('hex').slice(0, 20)
  return `agent-${digest}` as DevelopmentParticipantId
}

/**
 * Mount the live-Agent roster projection and periodic lease renewals.
 * @param ctx - host context carrying Agents and development rooms.
 * @param config - heartbeat cadence.
 */
export function apply(ctx: Context, config: Config): void {
  const tracked = new Set<DevelopmentParticipantId>()

  const synchronize = async (agent: Agent): Promise<void> => {
    const participantId = developmentAgentParticipantId(agent.id)
    const shortId = String(agent.id).slice(0, 8)
    tracked.add(participantId)
    await ctx.developmentRooms.announce({
      id: participantId,
      kind: 'agent',
      displayName: `Agent ${shortId}`,
    })
  }
  const withdraw = async (agent: Agent): Promise<void> => {
    const participantId = developmentAgentParticipantId(agent.id)
    if (!tracked.delete(participantId)) return
    await ctx.developmentRooms.withdraw({ participantId })
  }

  const settle = async (operation: Promise<void>, agent: Agent, action: string): Promise<void> => {
    try {
      await operation
    } catch (error: unknown) {
      ctx.logger.warn(`development-room-agent-presence: ${action} failed for agent "${agent.id}": ${String(error)}`)
    }
  }
  const observe = (operation: Promise<void>, agent: Agent, action: string): void => { void settle(operation, agent, action) }

  for (const agent of ctx.agents.list()) observe(synchronize(agent), agent, 'announcement')
  ctx.on('agent/created', ({ agent }) => { observe(synchronize(agent), agent, 'announcement') }, { global: true })
  ctx.on('agent/status', ({ agent }) => { observe(synchronize(agent), agent, 'heartbeat') }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { observe(withdraw(agent), agent, 'withdrawal') }, { global: true })

  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const agent of ctx.agents.list()) {
        observe(synchronize(agent), agent, 'heartbeat')
      }
    }, config.heartbeatMs)
    timer.unref()
    return async () => {
      clearInterval(timer)
      await Promise.all(ctx.agents.list().map(agent => settle(withdraw(agent), agent, 'withdrawal')))
    }
  }, 'development-room-agent-presence: heartbeat')
}
