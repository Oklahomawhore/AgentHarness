/** Deterministic Task binding changes around the SDK snapshot's two user turns. */

import type { Context } from '@deepseek-ai/cordis'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentRoomId } from '@deepseek-ai/dsh-development-room'
import type { DevelopmentTaskBindingId, DevelopmentTaskId } from '@deepseek-ai/dsh-development-task'

/** Loader fixture identity. */
export const name = 'task-context-disconnect-snapshot'
/** Services whose actual binding and request behavior the fixture exercises. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm']

/**
 * Seed a fixed Task and change its binding before each admitted request.
 * @param ctx - real Task, Room, and Agent services from the SDK profile overlay.
 */
export async function apply(ctx: Context): Promise<void> {
  const nodeId = 'snapshot-node' as DevelopmentNodeId
  const owner = 'snapshot-owner' as DevelopmentParticipantId
  const taskId = 'task-disconnect-snapshot' as DevelopmentTaskId
  const bindingId = 'binding-disconnect-snapshot' as DevelopmentTaskBindingId
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  ctx.developmentTasks.restoreLog([{
    nodeId, seq: 1, at: 1, taskId, revision: 1,
    hiddenRoomId: 'room-disconnect-snapshot' as DevelopmentRoomId,
    change: {
      kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: 'TASK_SCOPE_FACT', scope: 'Scope details disappear after disconnection.',
    },
  }])
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const participantId = developmentAgentParticipantId(agent.id)
    if (turn === 1) {
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot Agent' })
      await ctx.developmentTasks.checkout({ taskId, participantId, bindingId })
    } else if (turn === 2) {
      await ctx.developmentTasks.clear({ bindingId, participantId })
    }
    return decision
  })
  ctx.on('llm/stream', (options, next) => {
    const text = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (text.includes('Continue independently after disconnect.')) {
      if (text.includes('TASK_SCOPE_FACT') || !text.includes('This Agent session is not connected to a Task.')) {
        throw new Error('Disconnected model request retained Task context or lost its withdrawal marker')
      }
    } else if (text.includes('Work in the connected Task.') && !text.includes('TASK_SCOPE_FACT')) {
      throw new Error('Connected model request lost its Task context')
    }
    return next()
  })
}
