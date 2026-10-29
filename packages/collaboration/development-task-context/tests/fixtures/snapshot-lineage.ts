/** SDK replay fixture for canonical inherited parent facts after rejected lineage corruption. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { developmentTaskContextBlockSchema, developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskBindingId } from '@deepseek-ai/dsh-development-task/types'

/** Loader fixture identity. */
export const name = 'task-lineage-integrity-snapshot'
/** Actual SDK services used for lineage admission and model-visible context. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm']

/**
 * Reject a recomputed forged snapshot and bind one regular user turn to its canonical replacement.
 * @param ctx - SDK profile with real Room, Task, and text-context services.
 */
export async function apply(ctx: Context): Promise<void> {
  const root = developmentTaskEventSchema.parse({ nodeId: 'snapshot-node', seq: 1, at: 1,
    taskId: 'task-lineage-parent-snapshot', revision: 1, hiddenRoomId: 'room-lineage-parent-snapshot',
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: 'snapshot-lineage-owner',
      objective: 'CANONICAL_PARENT_OBJECTIVE', scope: 'Retain the selected parent revision exactly.' } })
  assert.equal(ctx.developmentRooms.list().nodeId, root.nodeId)
  assert.ok(root.change.kind === 'task-created')
  const owner = root.change.createdBy
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot lineage owner' })
  const publication = developmentTaskEventSchema.parse({ nodeId: root.nodeId, seq: 2, at: 2,
    taskId: root.taskId, revision: 2, hiddenRoomId: root.hiddenRoomId,
    change: { kind: 'context-published', publication: { id: 'context-lineage-parent-fact',
      text: 'FROZEN_PARENT_FACT', publishedBy: owner, publishedAt: 2 } } })
  ctx.developmentTasks.restoreLog([root, publication])
  const parent = ctx.developmentTasks.get({ taskId: root.taskId })
  const parentRef = { taskId: parent.id, revision: parent.revision }
  const sources = [{ parent: parentRef,
    objective: parent.objective, scope: parent.scope, context: parent.context }]
  const canonical = developmentTaskContextBlockSchema.parse({ createdAt: 3, sources,
    id: `context-${createHash('sha256').update(JSON.stringify({ version: 1, sources })).digest('hex')}` })
  const forgedSources = sources.map(source => ({ ...source,
    context: source.context.map(item => ({ ...item, text: 'FORGED_PARENT_FACT' })) }))
  const forged = developmentTaskContextBlockSchema.parse({ createdAt: 3, sources: forgedSources,
    id: `context-${createHash('sha256').update(JSON.stringify({ version: 1, sources: forgedSources })).digest('hex')}` })
  ctx.developmentTasks.restoreContextBlocks([canonical, forged])
  const child = developmentTaskEventSchema.parse({ nodeId: root.nodeId, seq: 3, at: 3,
    taskId: 'task-lineage-child-snapshot', revision: 1, hiddenRoomId: 'room-lineage-child-snapshot',
    change: { kind: 'task-created', origin: { kind: 'fork', parent: parentRef }, createdBy: owner,
      objective: 'Use the frozen parent facts.', scope: 'Preserve canonical Task lineage.', inheritedContextBlockId: canonical.id } })
  assert.ok(child.change.kind === 'task-created')
  const rejected = developmentTaskEventSchema.parse({ ...child,
    change: { ...child.change, inheritedContextBlockId: forged.id } })
  const before = ctx.developmentTasks.log()
  const blocks = ctx.developmentTasks.blocks()
  assert.throws(() => { ctx.developmentTasks.restoreLog([rejected]) }, { code: 'REPLICA_CONFLICT' })
  assert.deepEqual(ctx.developmentTasks.log(), before)
  assert.deepEqual(ctx.developmentTasks.blocks(), blocks)
  assert.equal(ctx.developmentTasks.log().at(-1)?.seq, 2)
  ctx.developmentTasks.restoreLog([child])
  assert.deepEqual(ctx.developmentTasks.log(), [...before, child])
  assert.deepEqual(ctx.developmentTasks.contextView(child.taskId).inherited?.sources, canonical.sources)
  ctx.developmentTasks.restoreLog([developmentTaskEventSchema.parse({ ...publication, seq: 4, at: 4, revision: 3,
    change: { kind: 'context-published', publication: { id: 'context-lineage-later-fact',
      text: 'LATER_PARENT_FACT', publishedBy: owner, publishedAt: 4 } } })])
  const bindingId = 'binding-lineage-snapshot' as DevelopmentTaskBindingId
  let requests = 0
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    assert.equal(turn, 1)
    const participantId = developmentAgentParticipantId(agent.id)
    await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot lineage Agent' })
    await ctx.developmentTasks.checkout({ taskId: child.taskId, participantId, bindingId })
    return await next()
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.equal(requests, 1)
    const context = options.messages.filter(message => message.source.kind === 'development-task-context')
    assert.equal(context.length, 1)
    const text = context.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    assert.ok(text.includes('FROZEN_PARENT_FACT'))
    assert.ok(text.includes('CANONICAL_PARENT_OBJECTIVE'))
    assert.ok(!JSON.stringify(options.messages).includes('FORGED_PARENT_FACT'))
    assert.ok(!JSON.stringify(options.messages).includes('LATER_PARENT_FACT'))
    return next()
  })
}
