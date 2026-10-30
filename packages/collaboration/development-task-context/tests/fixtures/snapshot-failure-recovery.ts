/** A rejected context preparation retains its original user request for the next explicit continuation. */
import type { Context } from '@deepseek-ai/cordis'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentRoomId } from '@deepseek-ai/dsh-development-room'
import type { DevelopmentTaskBindingId, DevelopmentTaskId } from '@deepseek-ai/dsh-development-task'

/** Loader fixture identity. */
export const name = 'task-context-failure-recovery-snapshot'
/** Real services used for Task selection and model-request verification. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm']

/**
 * Select an oversized Task, then a concise Task on the next explicit user turn.
 * @param ctx - shipped SDK services with the Task context overlay.
 */
export async function apply(ctx: Context): Promise<void> {
  const nodeId = 'snapshot-node' as DevelopmentNodeId
  const owner = 'snapshot-owner' as DevelopmentParticipantId
  const large = 'task-context-too-large' as DevelopmentTaskId
  const small = 'task-context-recovered' as DevelopmentTaskId
  const bindingId = 'binding-context-failure' as DevelopmentTaskBindingId
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  ctx.developmentTasks.restoreLog([large, small].map((taskId, index) => ({
    nodeId, seq: index + 1, at: index + 1, taskId, revision: 1,
    hiddenRoomId: `room-context-failure-${index}` as DevelopmentRoomId,
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: index === 0 ? 'OVERSIZED_TASK_'.repeat(120) : 'RECOVERED_TASK_FACT',
      scope: 'Keep the original request when context preparation fails.' },
  })))
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const participantId = developmentAgentParticipantId(agent.id)
    if (turn === 1) {
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot Agent' })
      await ctx.developmentTasks.checkout({ taskId: large, participantId, bindingId })
    } else if (turn === 2) {
      await ctx.developmentTasks.checkout({ taskId: small, participantId, bindingId })
    }
    return await next()
  })
  ctx.on('llm/stream', (options, next) => {
    const input = options.messages.filter(message => message.role === 'user' && message.source.kind === 'user')
      .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
    for (const text of ['Keep my original implementation request.', 'Continue with the concise current Task.']) {
      if (input.filter(value => value === text).length !== 1) throw new Error('Task context failure lost or duplicated a user request')
    }
    const context = options.messages.filter(message => message.source.kind === 'development-task-context')
      .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (!context.includes('RECOVERED_TASK_FACT') || context.includes('OVERSIZED_TASK_')) {
      throw new Error('Task context failure recovery adopted the wrong Task')
    }
    return next()
  })
}
