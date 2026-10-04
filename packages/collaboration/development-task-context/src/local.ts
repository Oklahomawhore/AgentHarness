/** Owner-local reads and exact logged messages shared by passive and automatically managed Task consumers. */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-development-room'
import type {} from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskAssignment } from '@deepseek-ai/dsh-development-task/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './backend.ts'
import { isTerminalPublication } from './publication.ts'
import { localContextProjectionDigest, localContextProjectionSchema, localTaskContextSourceSchema } from './local-schema.ts'
import type { DevelopmentTaskLocalContextProjection, DevelopmentTaskLocalContextReadResult, DevelopmentTaskLocalContextTarget, DevelopmentTaskLocalContextWithdrawalReason } from './types.ts'

export type * from './admission.ts'

export { localContextTargetSchema, localContextProjectionSchema, localContextProjectionDigest } from './local-schema.ts'

// Caller-context proxies preserve calls but do not provide stable service identity.
function taskIdentity(tasks: Context['developmentTasks']): Context['developmentTasks'] {
  return (tasks as Context['developmentTasks'] & { [symbols.original]?: Context['developmentTasks'] })[symbols.original] ?? tasks
}

function localTasks(ctx: Context) {
  const tasks = ctx.get('developmentTasks')
  if (tasks === undefined) throw new Error('development-task-context: local reads require developmentTasks')
  return tasks
}

function assignmentFor(ctx: Context, target: DevelopmentTaskLocalContextTarget): DevelopmentTaskAssignment | undefined {
  const tasks = localTasks(ctx)
  const assignment = tasks.assignmentList().find(item => item.participantId === target.participantId)
  if (assignment?.taskId !== target.taskId || assignment.bindingId !== target.taskBindingId) return undefined
  const epoch = tasks.assignmentLog().findLast(item => item.bindingId === target.taskBindingId
    && item.participantId === target.participantId && item.change.kind === 'task-bound')
  if (epoch?.nodeId !== target.bindingEpoch.nodeId || epoch.seq !== target.bindingEpoch.seq) return undefined
  const rooms = ctx.get('developmentRooms')
  if (rooms === undefined) throw new Error('development-task-context: local reads require developmentRooms')
  const task = tasks.get({ taskId: target.taskId })
  return task.ownerNodeId === rooms.list().nodeId && task.origin.kind === 'root' ? assignment : undefined
}

/**
 * Compute a current local Root Task projection for one unchanged assignment interval.
 * Ordinary additions preserve the captured revision; new terminal notices or provider replacement cause recomputation.
 * @param ctx - authoritative Task, Room, and context backend services; caller owns their lifetime.
 * @param target - exact task-bound identity, independent of any remote grant or subscription.
 * @param maxContextBytes - complete model-visible UTF-8 text budget; this helper adds no framing.
 * @param signal - caller's combined request and lifecycle cancellation.
 * @returns an exact active projection, or left if the target is no longer a local Root assignment.
 * @throws when current authority cannot be read, persistence or computation fails, or cancellation occurs.
 */
export async function readLocalTaskContext(ctx: Context, target: DevelopmentTaskLocalContextTarget,
  maxContextBytes: number, signal: AbortSignal): Promise<DevelopmentTaskLocalContextReadResult> {
  while (true) {
    signal.throwIfAborted()
    const tasks = localTasks(ctx)
    const assignment = assignmentFor(ctx, target)
    if (assignment === undefined) return { status: 'left' }
    const view = await tasks.currentContextView(target.taskId)
    signal.throwIfAborted()
    if (assignmentFor(ctx, target) === undefined) return { status: 'left' }
    if (taskIdentity(localTasks(ctx)) !== taskIdentity(tasks)) continue
    const backend = ctx.get('developmentTaskContextBackend')
    if (backend === undefined) throw new Error('development-task-context: local reads require developmentTaskContextBackend')
    const identity = backend.identity
    const output = await backend.compute({ view, recipient: { participantId: target.participantId,
      ...(assignment.sessionLabel === undefined ? {} : { sessionLabel: assignment.sessionLabel }) }, maxContextBytes, signal })
    signal.throwIfAborted()
    await tasks.currentContextView(target.taskId)
    signal.throwIfAborted()
    if (assignmentFor(ctx, target) === undefined) return { status: 'left' }
    if (taskIdentity(localTasks(ctx)) !== taskIdentity(tasks) || ctx.get('developmentTaskContextBackend')?.identity !== identity) continue
    const terminals = new Set(view.task.context.filter(isTerminalPublication).map(item => item.id))
    const latest = tasks.get({ taskId: target.taskId })
    if (latest.context.some(item => isTerminalPublication(item) && !terminals.has(item.id))) continue
    const fields = { ...output, ...target, kind: 'local-task' as const, version: 1 as const,
      taskRevision: view.task.revision, ownerNodeId: view.task.ownerNodeId, backend: { ...identity }, maxContextBytes }
    const projection = localContextProjectionSchema.parse({ ...fields, projectionId: localContextProjectionDigest(fields) })
    const expected = new Set([JSON.stringify({ kind: 'task', taskId: view.task.id, revision: view.task.revision }),
      ...view.task.context.map(item => JSON.stringify({ kind: 'publication', taskId: view.task.id,
        revision: view.task.revision, publicationId: item.id }))])
    const actual = [...projection.selectedSources, ...projection.omittedSources.map(item => item.source)]
    if (expected.size !== actual.length || actual.some(item => !expected.has(JSON.stringify(item)))) {
      throw new Error('development-task-context: backend coverage differs from the captured local Root Task')
    }
    return { status: 'active', projection }
  }
}

/**
 * Retain a complete local projection as one replayable model input without additional framing.
 * @param projection - result captured through the authoritative local reader.
 * @returns a version-3 Task snapshot whose text is exactly the recorded projection text.
 */
export function localContextSnapshotMessage(projection: DevelopmentTaskLocalContextProjection): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: projection.text }],
    source: { kind: 'development-task-context', form: 'snapshot', version: 3, projection } })
}

/**
 * Read current Task nodes while preserving replaced historical records.
 * @param agent - actual receiving Agent and Session surface.
 * @returns visible Task messages with validated durable attribution.
 */
export function visibleLocalTaskContext(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.surface.nodes.flatMap((seq) => {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'development-task-context') return []
    const source = localTaskContextSourceSchema.parse(event.data.source)
    if (source.form === 'snapshot' && source.version === 3) {
      const content = event.data.content
      if (content.length !== 1 || content[0]?.type !== 'text' || content[0].text !== source.projection.text) {
        throw new Error('development-task-context: local snapshot text differs from its recorded projection')
      }
    }
    return [event]
  })
}

/**
 * Withdraw local Task facts without retaining their old body in the current surface.
 * @param reason - why current facts are unavailable; this does not claim that the Task assignment was cleared.
 * @returns a managed withdrawal message; the immutable source history remains unchanged.
 */
export function localContextWithdrawalMessage(reason: DevelopmentTaskLocalContextWithdrawalReason): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: `## Task context withdrawn\n\nNo current Task context is available (${reason}). Previously injected Task snapshots must not be used as current facts.` }],
    source: { kind: 'development-task-context', form: 'withdrawn', version: 3, reason } })
}

/**
 * Replace the one current Task snapshot, retaining source sequence links for exact replay.
 * @param agent - receiving Agent whose current Task nodes are replaced.
 * @param message - exact snapshot or withdrawal to adopt.
 * @returns a first-admission message when no Task node exists; the Loop commits it with the accepted request.
 */
export function replaceLocalTaskContext(agent: Agent, message: UserMessage): UserMessage | undefined {
  const visible = visibleLocalTaskContext(agent)
  if (visible.length === 0) return message
  for (const [index, event] of visible.entries()) {
    agent.session.append('user/message', index === 0 ? message : localContextWithdrawalMessage('left'), {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
    })
  }
  return undefined
}
