/** Admit one Agent session's connected Task context into its next reconstructable model request. */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type {} from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskAssignment, DevelopmentTaskContextView } from '@deepseek-ai/dsh-development-task/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { z } from 'zod'
import { localTaskContextSourceSchema as sourceSchema } from './local-schema.ts'
import type {} from './backend.ts'
import { isTerminalPublication } from './publication.ts'
import type { DevelopmentTaskBindingEpoch, DevelopmentTaskContextProjection, DevelopmentTaskContextSource } from './types.ts'

export type * from './types.ts'
export * from './local.ts'

const RETIRED = `## Retired Task context

A prior Task context snapshot was withdrawn after this Agent session changed its Task binding. Use only the current connected Task snapshot.`
const DISCONNECTED = `## Disconnected Task context

This Agent session is not connected to a Task. Previously injected Task context has been withdrawn.`

/** Request-time context bound. */
export interface Config {
  /** Maximum UTF-8 bytes admitted as one Task context message. */
  readonly maxContextBytesPerStep: number
}

export const name = 'development-task-context'
export const inject = ['agents', 'developmentTasks', 'developmentTaskContextBackend']
export const Config: s<Config> = s.object({
  maxContextBytesPerStep: s.number().step(1).min(1).required(),
})

function validateDurableSources(agent: Agent, proposed: readonly UserMessage[]): void {
  const inspect = (message: UserMessage): void => {
    if (message.source.kind !== 'development-task-context') return
    const parsed = sourceSchema.safeParse(message.source)
    if (parsed.success && parsed.data.form === 'snapshot' && parsed.data.version === 3
      && (message.content.length !== 1 || message.content[0]?.type !== 'text' || message.content[0].text !== parsed.data.projection.text)) {
      throw new Error('development-task-context: local snapshot text differs from its recorded projection')
    }
    if (!parsed.success) throw new Error(`invalid durable development-task-context source: ${z.prettifyError(parsed.error)}`)
  }
  for (const event of agent.session.snapshotEvents()) if (event.type === 'user/message') inspect(event.data)
  for (const message of proposed) inspect(message)
}

function snapshotMessage(
  view: DevelopmentTaskContextView,
  assignment: DevelopmentTaskAssignment,
  bindingEpoch: DevelopmentTaskBindingEpoch,
  backend: { readonly id: string; readonly revision: string },
  maxContextBytes: number,
  projection: DevelopmentTaskContextProjection,
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: projection.text }],
    source: {
      kind: 'development-task-context',
      form: 'snapshot',
      version: 2,
      taskId: view.task.id,
      revision: view.task.revision,
      bindingId: assignment.bindingId,
      bindingEpoch,
      backend,
      maxContextBytes,
      selectedSources: projection.selectedSources,
      omittedSources: projection.omittedSources,
    },
  })
}

function bindingEpoch(ctx: Context, assignment: DevelopmentTaskAssignment): DevelopmentTaskBindingEpoch {
  const bound = ctx.developmentTasks.assignmentLog().findLast(entry => entry.bindingId === assignment.bindingId
    && entry.participantId === assignment.participantId && entry.change.kind === 'task-bound')
  if (bound === undefined) throw new Error('development-task-context: current binding has no durable task-bound event')
  return { nodeId: bound.nodeId, seq: bound.seq }
}

function sameEpoch(left: DevelopmentTaskBindingEpoch, right: { readonly nodeId: string; readonly seq: number }): boolean {
  return left.nodeId === right.nodeId && left.seq === right.seq
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
  const lifetime = new AbortController()
  const acknowledgements = new Map<string, Promise<void>>()
  const claims = new Map<Agent, { message: UserMessage; turn: number }[]>()
  ctx.effect(() => async () => {
    lifetime.abort()
    claims.clear()
    await Promise.all(acknowledgements.values())
  })
  const acknowledge = (participantId: DevelopmentTaskAssignment['participantId'], source: Pick<Extract<DevelopmentTaskContextSource, { version: 2 }>, 'taskId' | 'revision' | 'bindingId' | 'bindingEpoch'>): void => {
    if (lifetime.signal.aborted) return
    const assignment = ctx.developmentTasks.assignmentList().find(item => item.bindingId === source.bindingId)
    if (assignment?.participantId !== participantId || assignment.taskId !== source.taskId
      || !sameEpoch(bindingEpoch(ctx, assignment), source.bindingEpoch)
      || (assignment.acknowledgedRevision ?? 0) >= source.revision) return
    const key = `${source.bindingEpoch.nodeId}/${source.bindingEpoch.seq}/${source.revision}`
    if (acknowledgements.has(key)) return
    const pending = ctx.developmentTasks.acknowledge({
      bindingId: source.bindingId, participantId, taskId: source.taskId, revision: source.revision,
      expectedBindingEpoch: source.bindingEpoch,
    }).then(() => undefined).catch((error: unknown) => {
      ctx.logger.warn('development-task-context: projection acknowledgement failed: %s', error)
    }).finally(() => { acknowledgements.delete(key) })
    acknowledgements.set(key, pending)
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      const agent = ctx.agents.get(session.id)
      if (agent?.session === session) claims.delete(agent)
    }
    if (event.type === 'user/message' && event.data.source.kind === 'development-task-context'
      && event.data.source.form === 'snapshot') {
      const source = event.data.source
      if (source.version === 2) acknowledge(developmentAgentParticipantId(session.id), source)
      if (source.version === 3) {
        const value = source.projection
        acknowledge(developmentAgentParticipantId(session.id), { taskId: value.taskId, revision: value.taskRevision,
          bindingId: value.taskBindingId, bindingEpoch: value.bindingEpoch })
      }
    }
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const pending = claims.get(agent) ?? []
    pending.push({ message, turn })
    claims.set(agent, pending)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { claims.delete(agent) }, { global: true })
  ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next): Promise<PreStepDecision> => {
    const actualClaims = (claims.get(agent) ?? []).filter(item => item.turn === turn).map(item => item.message)
    claims.delete(agent)
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    validateDurableSources(agent, decision.messages)
    const admissionSignal = AbortSignal.any([signal, lifetime.signal])
    return await ctx.waterfall('development-task-context/admit', { agent, decision, claimed: actualClaims, turn, step, signal: admissionSignal }, async () => {
      const participantId = developmentAgentParticipantId(agent.id)
      const selectedAssignment = (): DevelopmentTaskAssignment | undefined => ctx.developmentTasks.assignmentList()
        .filter(item => item.participantId === participantId)
        .sort((left, right) => right.assignedAt - left.assignedAt)[0]
      const operationSignal = AbortSignal.any([signal, lifetime.signal])
      const isCancelled = (): boolean => operationSignal.aborted
      const cancelled = (): PreStepDecision => {
        if (lifetime.signal.aborted && !signal.aborted) {
          agent.inbox.splice('next-step', 0, 0, decision.messages)
        }
        return { kind: 'reject' }
      }
      while (!isCancelled()) {
        const assignment = selectedAssignment()
        const visibleContext = agent.session.surface.nodes.flatMap((seq) => {
          const event = agent.session.eventAt(seq)
          if (event?.type !== 'user/message' || event.data.source.kind !== 'development-task-context') return []
          const source = sourceSchema.parse(event.data.source)
          return [{ event, source }]
        })
        if (assignment === undefined) {
          for (const item of visibleContext) {
            if (item.source.form === 'disconnected') continue
            agent.session.append('user/message', createUserMessage({
              content: [{ type: 'text', text: DISCONNECTED }],
              source: { kind: 'development-task-context', form: 'disconnected', version: 1 },
            }), {
              surfaceOp: { op: 'replace', startSeq: item.event.seq, endSeq: item.event.seq },
              sourceEventSeqs: [item.event.seq],
            })
          }
          return decision
        }
        const epoch = bindingEpoch(ctx, assignment)
        const stillBound = (): boolean => {
          const current = selectedAssignment()
          return current !== undefined && current.bindingId === assignment.bindingId
            && current.taskId === assignment.taskId && sameEpoch(epoch, bindingEpoch(ctx, current))
        }
        let view: DevelopmentTaskContextView
        try {
          view = await ctx.developmentTasks.currentContextView(assignment.taskId)
        } catch (error) {
          if (isCancelled()) return cancelled()
          agent.inbox.splice('next-step', 0, 0, decision.messages)
          throw error
        }
        if (isCancelled()) return cancelled()
        if (!stillBound()) continue
        const backend = ctx.developmentTaskContextBackend
        const providerIdentity = backend.identity
        const identity = { ...providerIdentity }
        const current = visibleContext.find(item => item.source.form === 'snapshot'
          && item.source.version === 2 && item.source.taskId === view.task.id && item.source.revision === view.task.revision
          && item.source.bindingId === assignment.bindingId && sameEpoch(epoch, item.source.bindingEpoch)
          && item.source.backend.id === identity.id && item.source.backend.revision === identity.revision
          && item.source.maxContextBytes === config.maxContextBytesPerStep)
        const stale = visibleContext.filter(item => item !== current)
        let projection: DevelopmentTaskContextProjection | undefined
        if (current === undefined) {
          try {
            projection = await backend.compute({
              view,
              recipient: {
                participantId,
                ...(assignment.sessionLabel === undefined ? {} : { sessionLabel: assignment.sessionLabel }),
              },
              maxContextBytes: config.maxContextBytesPerStep,
              signal: operationSignal,
            })
          } catch (error) {
            if (isCancelled()) return cancelled()
            throw error
          }
        }
        try {
          await ctx.developmentTasks.currentContextView(assignment.taskId)
        } catch (error) {
          if (isCancelled()) return cancelled()
          agent.inbox.splice('next-step', 0, 0, decision.messages)
          throw error
        }
        if (isCancelled()) return cancelled()
        if (!stillBound() || ctx.get('developmentTaskContextBackend')?.identity !== providerIdentity) continue
        const terminalIds = new Set(view.task.context.filter(isTerminalPublication).map(item => item.id))
        const latest = ctx.developmentTasks.get({ taskId: assignment.taskId })
        if (latest.context.some(item => isTerminalPublication(item) && !terminalIds.has(item.id))) continue
        if (projection !== undefined) {
          if (Buffer.byteLength(projection.text, 'utf8') > config.maxContextBytesPerStep) {
            throw new Error(`development-task-context: backend output for Task ${view.task.id} exceeds maxContextBytesPerStep`)
          }
          const message = snapshotMessage(view, assignment, epoch, identity, config.maxContextBytesPerStep, projection)
          const first = stale.shift()
          if (first === undefined) {
            return { ...decision, messages: [...decision.messages, message] }
          } else {
            agent.session.append('user/message', message, {
              surfaceOp: { op: 'replace', startSeq: first.event.seq, endSeq: first.event.seq },
              sourceEventSeqs: [first.event.seq],
            })
          }
        }
        for (const item of stale) {
          if (item.source.form === 'retired' && item.source.activeTaskId === view.task.id
            && item.source.activeRevision === view.task.revision) continue
          agent.session.append('user/message', retiredMessage(view), {
            surfaceOp: { op: 'replace', startSeq: item.event.seq, endSeq: item.event.seq },
            sourceEventSeqs: [item.event.seq],
          })
        }
        if (current !== undefined && current.event.data.source.kind === 'development-task-context'
          && current.event.data.source.form === 'snapshot' && current.event.data.source.version === 2) {
          acknowledge(participantId, current.event.data.source)
        }
        return decision
      }
      return cancelled()
    })
  })
  ctx.provide('developmentTaskContextAdmission', { signal: lifetime.signal })
}
