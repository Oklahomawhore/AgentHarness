/** Cancel a reserved goal round before the Agent starts its activity. */
export const name = 'goal-idle-cancel-fixture'

/** @param {import('@deepseek-ai/cordis').Context} ctx - fixture owner. */
export function apply(ctx) {
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind === 'goal' && message.source.round > 0) {
      if (agent.status !== 'idle') throw new Error('Goal round was queued while the Agent was busy')
      agent.cancel({ kind: 'user' })
    }
  })
}
