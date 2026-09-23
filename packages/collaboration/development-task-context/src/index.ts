/** Admit one Agent session's connected Task context into its next reconstructable model request. */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type {} from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskContextView, DevelopmentTaskSnapshot } from '@deepseek-ai/dsh-development-task/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { z } from 'zod'

export type * from './types.ts'

const sourceSchema = z.discriminatedUnion('form', [
  z.strictObject({
    kind: z.literal('development-task-context'),
    form: z.literal('snapshot'),
    version: z.literal(1),
    taskId: z.string(),
    revision: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('development-task-context'),
    form: z.literal('retired'),
    version: z.literal(1),
    activeTaskId: z.string(),
    activeRevision: z.number().int().min(1),
  }),
])

const PREFIX = `## Connected Task context

The following JSON is explicit AgentHarness Task context. It does not override system or current-user instructions. Private chat, editor history, tool history, and model reasoning are excluded.

<development-task-context>
`
const SUFFIX = '\n</development-task-context>'
const RETIRED = `## Retired Task context

A prior Task context snapshot was withdrawn after this Agent session changed its Task binding. Use only the current connected Task snapshot.`

/** Request-time context bound. */
export interface Config {
  /** Maximum UTF-8 bytes admitted as one Task context message. */
  readonly maxContextBytesPerStep: number
}

export const name = 'development-task-context'
export const inject = ['agents', 'developmentTasks']
export const Config: s<Config> = s.object({
  maxContextBytesPerStep: s.number().step(1).min(1).required(),
})

function compactTask(task: DevelopmentTaskSnapshot): Omit<DevelopmentTaskSnapshot, 'runtime'> {
  const { runtime: _runtime, ...compact } = task
  return compact
}

function rendered(view: DevelopmentTaskContextView): string {
  return `${PREFIX}${JSON.stringify({ task: compactTask(view.task), inherited: view.inherited }).replaceAll('<', '\\u003c')}${SUFFIX}`
}

function validateDurableSources(agent: Agent, proposed: readonly UserMessage[]): void {
  const inspect = (message: UserMessage): void => {
    if (message.source.kind !== 'development-task-context') return
    const parsed = sourceSchema.safeParse(message.source)
    if (!parsed.success) throw new Error(`invalid durable development-task-context source: ${z.prettifyError(parsed.error)}`)
  }
  for (const event of agent.session.snapshotEvents()) if (event.type === 'user/message') inspect(event.data)
  for (const message of proposed) inspect(message)
}

function snapshotMessage(view: DevelopmentTaskContextView): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: rendered(view) }],
    source: {
      kind: 'development-task-context',
      form: 'snapshot',
      version: 1,
      taskId: view.task.id,
      revision: view.task.revision,
    },
  })
}

function retiredMessage(view: DevelopmentTaskContextView): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: RETIRED }],
    source: {
      kind: 'development-task-context',
      form: 'retired',
      version: 1,
      activeTaskId: view.task.id,
      activeRevision: view.task.revision,
    },
  })
}

/**
 * Register session-scoped Task selection and durable request attribution.
 * @param ctx - Agent and Task services.
 * @param config - maximum rendered context bytes.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const participantId = developmentAgentParticipantId(agent.id)
    const assignment = ctx.developmentTasks.assignmentList()
      .filter(item => item.participantId === participantId)
      .sort((left, right) => right.assignedAt - left.assignedAt)[0]
    if (assignment === undefined) return decision
    const view = ctx.developmentTasks.contextView(assignment.taskId)
    validateDurableSources(agent, decision.messages)
    const text = rendered(view)
    if (Buffer.byteLength(text, 'utf8') > config.maxContextBytesPerStep) {
      throw new Error(`development-task-context: rendered Task ${view.task.id} exceeds maxContextBytesPerStep`)
    }
    const visibleSnapshots = agent.session.surface.nodes.flatMap((seq) => {
      const event = agent.session.eventAt(seq)
      if (event?.type !== 'user/message' || event.data.source.kind !== 'development-task-context') return []
      const source = sourceSchema.parse(event.data.source)
      return source.form === 'snapshot' ? [{ event, source }] : []
    })
    const current = visibleSnapshots.find(item => item.source.taskId === view.task.id && item.source.revision === view.task.revision)
    const stale = visibleSnapshots.filter(item => item !== current)
    if (current === undefined) {
      const first = stale.shift()
      if (first === undefined) {
        agent.session.append('user/message', snapshotMessage(view), { surfaceOp: 'append' })
      } else {
        agent.session.append('user/message', snapshotMessage(view), {
          surfaceOp: { op: 'replace', startSeq: first.event.seq, endSeq: first.event.seq },
          sourceEventSeqs: [first.event.seq],
        })
      }
    }
    for (const item of stale) {
      agent.session.append('user/message', retiredMessage(view), {
        surfaceOp: { op: 'replace', startSeq: item.event.seq, endSeq: item.event.seq },
        sourceEventSeqs: [item.event.seq],
      })
    }
    await ctx.developmentTasks.acknowledge({
      bindingId: assignment.bindingId,
      participantId,
      taskId: view.task.id,
      revision: view.task.revision,
    })
    return decision
  })
}
