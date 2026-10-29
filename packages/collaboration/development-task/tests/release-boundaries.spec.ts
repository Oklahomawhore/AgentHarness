import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentTaskService, {
  type Config, type DevelopmentTaskAssignmentLogEntry, type DevelopmentTaskContextBlock, type DevelopmentTaskLogEntry,
} from '../src/index.ts'
import { localContributionGrantSchema } from '../src/schema.ts'

const contexts: Context[] = []
const owner = 'release-owner' as DevelopmentParticipantId
const agent = 'release-agent' as DevelopmentParticipantId
const config: Config = {
  maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4, maxContextBlockBytes: 32_768,
  maxLineageTasks: 16, maxTextBytes: 8192, roomRetryIntervalMs: 10_000,
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

async function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId: 'release-node', presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 8192,
  })
  await rooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
  await rooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
  const tasks = new DevelopmentTaskService(ctx, { ...config, ...overrides })
  const create = (objective: string) => tasks.create({ origin: { kind: 'root' }, objective, scope: 'Release acceptance', createdBy: owner })
  return { ctx, rooms, tasks, create }
}

describe('Task admission before state changes', () => {
  it('keeps the parent and log unchanged when inherited-block persistence fails, then permits a retry', async () => {
    const { ctx, tasks, create } = await setup()
    const parent = await create('Parent')
    const retained = tasks.log()
    const stop = ctx.on('development-task/context-persist', () => { throw new Error('Inherited block unavailable') })
    const request = { origin: { kind: 'fork' as const, parent: { taskId: parent.id, revision: parent.revision } },
      objective: 'Child', scope: 'Selected context', createdBy: owner }
    await expect(tasks.create(request)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(tasks.blocks()).toEqual([])
    expect(tasks.log()).toEqual(retained)
    expect(tasks.get({ taskId: parent.id })).toEqual(parent)
    stop()
    const child = await tasks.create(request)
    expect(child.inheritedContextBlockId).toBeDefined()
    expect(tasks.blocks()).toHaveLength(1)
    expect(tasks.log()).toHaveLength(retained.length + 1)
  })

  it.each(['root', 'duplicate', 'foreign'] as const)('rejects %s publication exclusions before persisting an inherited block', async (kind) => {
    const { ctx, tasks, create } = await setup()
    const parent = await create('Parent')
    const published = await tasks.publishContext({ taskId: parent.id, participantId: owner, text: 'Parent publication' })
    const publication = published.context[0]
    if (publication === undefined) throw new Error('Parent publication was not retained')
    const persisted = vi.fn<(block: DevelopmentTaskContextBlock) => void>()
    ctx.on('development-task/context-persist', persisted)
    const retained = tasks.log()
    await expect(tasks.create({
      origin: kind === 'root' ? { kind: 'root' } : { kind: 'fork', parent: { taskId: parent.id, revision: published.revision } },
      objective: 'Child', scope: 'Selected context', createdBy: owner,
      excludedContextIds: kind === 'duplicate' ? [publication.id, publication.id] : [kind === 'foreign' ? 'another-task-publication' : publication.id],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.blocks()).toEqual([])
    expect(tasks.log()).toEqual(retained)
  })

  it('rejects an acknowledgement from an older checkout epoch without changing the new binding', async () => {
    const { ctx, tasks, create } = await setup()
    const task = await create('Shared responsibility')
    const { assignment } = await tasks.checkout({ taskId: task.id, participantId: agent })
    const epoch = tasks.assignmentLog().at(-1)
    if (epoch === undefined) throw new Error('Checkout did not retain its epoch')
    const request = { taskId: task.id, participantId: agent, bindingId: assignment.bindingId, revision: task.revision }
    await tasks.checkout({ ...request, sessionLabel: 'Reconnected Session' })
    const retained = tasks.assignmentLog()
    const persisted = vi.fn<(entry: DevelopmentTaskAssignmentLogEntry) => void>()
    ctx.on('development-task/assignment-persist', persisted)
    await expect(tasks.acknowledge({ ...request, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.assignmentLog()).toEqual(retained)
    const current = retained.at(-1)
    if (current === undefined) throw new Error('Reconnect did not retain its epoch')
    await expect(tasks.acknowledge({ ...request, expectedBindingEpoch: { nodeId: current.nodeId, seq: current.seq } }))
      .resolves.toMatchObject({ acknowledgedRevision: task.revision, sessionLabel: 'Reconnected Session' })
  })

  it.each(['blank', 'oversized'] as const)('preserves an active local capture when checkout rejects a %s session label', async (invalid) => {
    const { tasks, create } = await setup()
    const task = await create('Existing responsibility')
    const { assignment } = await tasks.checkout({ taskId: task.id, participantId: agent })
    const epoch = tasks.assignmentLog().at(-1)
    if (epoch === undefined) throw new Error('Checkout did not retain its binding event')
    const grant = localContributionGrantSchema.parse({
      version: 1, taskId: task.id, participantId: agent, bindingId: assignment.bindingId,
      expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, captureId: 'release-capture', captureGeneration: 'release-generation',
      source: { kind: 'tool-observations', name: 'Authorized existing work', tools: ['Write'] },
      expiresAt: Date.now() + 60_000, maxSamples: 4, maxSampleBytes: 4096,
    })
    await tasks.openLocalContribution(grant)
    const retained = tasks.log()
    const bindings = tasks.assignmentLog()
    await expect(tasks.checkout({ taskId: task.id, participantId: agent, bindingId: assignment.bindingId,
      sessionLabel: invalid === 'blank' ? ' ' : 'x'.repeat(config.maxTextBytes + 1),
    })).rejects.toMatchObject({ code: invalid === 'blank' ? 'INVALID_REQUEST' : 'LIMIT_EXCEEDED' })
    expect(await tasks.localContributionStatus({ grant })).toMatchObject({ state: 'active' })
    expect(tasks.log()).toEqual(retained)
    expect(tasks.assignmentLog()).toEqual(bindings)
  })

  it.each(['objective', 'scope'] as const)('rejects a blank Fork %s before persisting inherited context', async (field) => {
    const { ctx, tasks, create } = await setup()
    const parent = await create('Parent responsibility')
    const retained = tasks.log()
    const persisted = vi.fn<(block: DevelopmentTaskContextBlock) => void>()
    ctx.on('development-task/context-persist', persisted)
    await expect(tasks.create({ origin: { kind: 'fork', parent: { taskId: parent.id, revision: parent.revision } },
      objective: field === 'objective' ? ' ' : 'Child responsibility', scope: field === 'scope' ? ' ' : 'Child scope', createdBy: owner,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.blocks()).toEqual([])
    expect(tasks.log()).toEqual(retained)
  })

  it('rejects a fractional delivered revision before persisting an acknowledgement', async () => {
    const { ctx, tasks, create } = await setup()
    const task = await create('Delivered revision')
    await tasks.publishContext({ taskId: task.id, participantId: owner, text: 'Revision two' })
    const { assignment } = await tasks.checkout({ taskId: task.id, participantId: agent })
    const request = { taskId: task.id, participantId: agent, bindingId: assignment.bindingId }
    const retained = tasks.assignmentLog()
    const persisted = vi.fn<(entry: DevelopmentTaskAssignmentLogEntry) => void>()
    ctx.on('development-task/assignment-persist', persisted)
    await expect(ctx.developmentTaskAssignments.acknowledge({ ...request, revision: 1.5 }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.assignmentLog()).toEqual(retained)
    await expect(ctx.developmentTaskAssignments.acknowledge({ ...request, revision: 2 }))
      .resolves.toMatchObject({ acknowledgedRevision: 2 })
  })
})

describe('Task query and configuration bounds', () => {
  it.each([
    ['maxTasks', 0], ['maxEventsPerTask', 1.5], ['maxMergeParents', 1], ['maxContextBlockBytes', -1],
    ['maxLineageTasks', Infinity], ['maxTextBytes', NaN], ['roomRetryIntervalMs', 0],
  ] as const)('rejects invalid %s configuration before creating a Task service', async (field, value) => {
    await expect(setup({ [field]: value })).rejects.toThrow(TypeError)
  })

  it('returns a depth boundary and visits a shared ancestor only once in a diamond lineage', async () => {
    const { tasks, create } = await setup()
    const root = await create('Common parent')
    const children = await Promise.all(['Left', 'Right'].map(objective => tasks.create({
      origin: { kind: 'fork', parent: { taskId: root.id, revision: root.revision } },
      objective, scope: 'Parallel human responsibility', createdBy: owner,
    })))
    const merged = await tasks.create({ origin: { kind: 'merge', parents: children.map(child => ({ taskId: child.id, revision: child.revision })) },
      objective: 'Merged context', scope: 'Combined decisions', createdBy: owner })
    const shallow = tasks.lineage({ taskId: merged.id, ancestorDepth: 1, descendantDepth: 0 })
    expect(shallow.tasks.map(task => task.id)).toEqual([merged.id, ...children.map(child => child.id)])
    expect(shallow.boundaryTaskIds).toEqual([root.id])
    const complete = tasks.lineage({ taskId: merged.id, ancestorDepth: 2, descendantDepth: 0 })
    expect(complete.tasks.map(task => task.id)).toEqual([...shallow.tasks.map(task => task.id), root.id])
    expect(complete.boundaryTaskIds).toEqual([])
  })

  it('filters Tasks by their creator or a retained participant assignment without changing either inventory', async () => {
    const { rooms, tasks, create } = await setup()
    const first = await create('Owner responsibility')
    const other = 'another-owner' as DevelopmentParticipantId
    await rooms.announce({ id: other, kind: 'human', displayName: 'Another owner' })
    const second = await tasks.create({ origin: { kind: 'root' }, objective: 'Other responsibility', scope: 'Other scope', createdBy: other })
    const checked = await tasks.checkout({ taskId: second.id, participantId: agent })
    const retained = tasks.log()
    const bindings = tasks.assignmentLog()
    expect(tasks.list({ participantId: owner }).map(item => item.id)).toEqual([first.id])
    expect(tasks.list({ participantId: other }).map(item => item.id)).toEqual([second.id])
    expect(tasks.list({ participantId: agent }).map(item => item.id)).toEqual([second.id])
    expect(tasks.log()).toEqual(retained)
    expect(tasks.assignmentLog()).toEqual(bindings)
    await tasks.clear({ bindingId: checked.assignment.bindingId, participantId: agent })
    expect(tasks.list({ participantId: agent })).toEqual([])
    expect(tasks.list({ participantId: other }).map(item => item.id)).toEqual([second.id])
  })

  it.each([0, 1.5, config.maxLineageTasks + 1])('rejects query limit %s before returning a truncated result', async (limit) => {
    const { tasks, create } = await setup()
    const task = await create('Query limit')
    expect(() => tasks.list({ limit })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => tasks.lineage({ taskId: task.id, limit })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(tasks.list({ limit: 1 }).map(item => item.id)).toEqual([task.id])
  })

  it.each([-1, 0.5, 33])('rejects lineage depth %s for both traversal directions', async (depth) => {
    const { tasks, create } = await setup()
    const task = await create('Lineage depth')
    expect(() => tasks.lineage({ taskId: task.id, ancestorDepth: depth })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => tasks.lineage({ taskId: task.id, descendantDepth: depth })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(tasks.lineage({ taskId: task.id, ancestorDepth: 0, descendantDepth: 0 }).tasks.map(item => item.id)).toEqual([task.id])
  })

  it('returns an explicit lineage boundary when ancestors consume the requested Task limit', async () => {
    const { tasks, create } = await setup()
    const parent = await create('Parent')
    const child = await tasks.create({ origin: { kind: 'fork', parent: { taskId: parent.id, revision: parent.revision } },
      objective: 'Child', scope: 'Child scope', createdBy: owner })
    const descendant = await tasks.create({ origin: { kind: 'fork', parent: { taskId: child.id, revision: child.revision } },
      objective: 'Descendant', scope: 'Descendant scope', createdBy: owner })
    const lineage = tasks.lineage({ taskId: child.id, ancestorDepth: 1, descendantDepth: 2, limit: 2 })
    expect(lineage.tasks.map(item => item.id)).toEqual([child.id, parent.id])
    expect(lineage.boundaryTaskIds).toEqual([descendant.id])
  })

  it('rejects a full Task inventory before emitting another durable Task event', async () => {
    const { ctx, tasks, create } = await setup({ maxTasks: 2 })
    await create('First Task'); await create('Second Task')
    const retained = tasks.log()
    const persisted = vi.fn<(entry: DevelopmentTaskLogEntry) => void>()
    ctx.on('development-task/persist', persisted)
    await expect(create('Third Task')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.log()).toEqual(retained)
  })

  it('rejects more Merge parents than configured without persisting an inherited block', async () => {
    const { ctx, tasks, create } = await setup({ maxMergeParents: 2 })
    const parents = await Promise.all(['First', 'Second', 'Third'].map(objective => create(objective)))
    const persisted = vi.fn<(block: DevelopmentTaskContextBlock) => void>()
    ctx.on('development-task/context-persist', persisted)
    await expect(tasks.create({ origin: { kind: 'merge', parents: parents.map(parent => ({ taskId: parent.id, revision: parent.revision })) },
      objective: 'Oversized Merge', scope: 'Merge scope', createdBy: owner })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.blocks()).toEqual([])
  })

  it('accepts the exact UTF-8 text budget and rejects one more multibyte character without another write', async () => {
    const { ctx, tasks, create } = await setup({ maxTextBytes: 24 })
    const task = await create('Root')
    const persisted = vi.fn<(entry: DevelopmentTaskLogEntry) => void>()
    ctx.on('development-task/persist', persisted)
    await tasks.publishContext({ taskId: task.id, participantId: owner, text: '界'.repeat(8) })
    const retained = tasks.log()
    await expect(tasks.publishContext({ taskId: task.id, participantId: owner, text: '界'.repeat(9) }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(persisted).toHaveBeenCalledOnce()
    expect(tasks.log()).toEqual(retained)
  })
})
