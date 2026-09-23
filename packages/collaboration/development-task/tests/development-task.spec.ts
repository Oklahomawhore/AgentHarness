import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService, {
  type DevelopmentParticipantId,
} from '@deepseek-ai/dsh-development-room'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentTaskService, {
  type Config,
  type DevelopmentTaskBindingId,
  type DevelopmentTaskId,
} from '../src/index.ts'

const contexts: Context[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId
const binding = (value: string): DevelopmentTaskBindingId => value as DevelopmentTaskBindingId
const config: Config = {
  maxTasks: 32,
  maxEventsPerTask: 64,
  maxMergeParents: 8,
  maxContextBlockBytes: 64 * 1024,
  maxLineageTasks: 64,
  maxTextBytes: 4096,
  roomRetryIntervalMs: 10_000,
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(overrides: Partial<Config> = {}): Promise<{
  ctx: Context
  rooms: DevelopmentRoomService
  tasks: DevelopmentTaskService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId: 'node-a', presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 64, maxTextBytes: 4096,
  })
  await rooms.announce({ id: participant('owner'), kind: 'human', displayName: 'Owner' })
  await rooms.announce({ id: participant('agent'), kind: 'agent', displayName: 'Agent' })
  return { ctx, rooms, tasks: new DevelopmentTaskService(ctx, { ...config, ...overrides }) }
}

function rootRequest(objective: string) {
  return {
    origin: { kind: 'root' as const },
    objective,
    scope: `${objective} shared context`,
    createdBy: participant('owner'),
  }
}

describe('DevelopmentTaskService', () => {
  it('creates immutable Root, Fork, and Merge context lineage', async () => {
    const { rooms, tasks } = await setup()
    const root = await tasks.create(rootRequest('Root Task'))
    expect(root).toMatchObject({ revision: 1, runtime: 'ready', origin: { kind: 'root' } })
    expect(rooms.list().rooms.find(room => room.id === root.hiddenRoomId)?.participantIds)
      .toEqual([participant('owner')])

    const published = await tasks.publishContext({
      taskId: root.id,
      participantId: participant('owner'),
      text: 'Public architecture decision',
      uri: 'file:///decision.md',
    })
    const fork = await tasks.create({
      ...rootRequest('Fork Task'),
      origin: { kind: 'fork', parent: { taskId: root.id, revision: published.revision } },
    })
    const second = await tasks.create(rootRequest('Second Root'))
    const merged = await tasks.create({
      ...rootRequest('Merged Task'),
      origin: {
        kind: 'merge',
        parents: [
          { taskId: fork.id, revision: fork.revision },
          { taskId: second.id, revision: second.revision },
        ],
      },
    })

    expect(tasks.contextView(fork.id).inherited?.sources[0]).toMatchObject({
      parent: { taskId: root.id, revision: published.revision },
      context: [{ text: 'Public architecture decision' }],
    })
    expect(merged.origin.kind).toBe('merge')
    expect(tasks.lineage({ taskId: merged.id }).tasks.map(task => task.id))
      .toEqual(expect.arrayContaining([root.id, fork.id, second.id, merged.id]))
  })

  it('pins inherited context to an exact revision and rejects duplicate Merge parents', async () => {
    const { tasks } = await setup()
    const root = await tasks.create(rootRequest('Revision Root'))
    const published = await tasks.publishContext({
      taskId: root.id,
      participantId: participant('owner'),
      text: 'Only revision two contains this context',
    })
    const fromFirstRevision = await tasks.create({
      ...rootRequest('Historical Fork'),
      origin: { kind: 'fork', parent: { taskId: root.id, revision: 1 } },
    })
    expect(tasks.contextView(fromFirstRevision.id).inherited?.sources[0]?.context).toEqual([])

    await expect(tasks.create({
      ...rootRequest('Unavailable Fork'),
      origin: { kind: 'fork', parent: { taskId: root.id, revision: published.revision + 1 } },
    })).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' })
    await expect(tasks.create({
      ...rootRequest('Invalid Merge'),
      origin: {
        kind: 'merge',
        parents: [
          { taskId: root.id, revision: published.revision },
          { taskId: root.id, revision: 1 },
        ],
      },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('keeps different sessions of the same Agent independently bound', async () => {
    const { rooms, tasks } = await setup()
    const first = await tasks.create(rootRequest('First'))
    const second = await tasks.create(rootRequest('Second'))
    const agent = participant('agent')

    const firstSession = await tasks.checkout({
      taskId: first.id,
      participantId: agent,
      bindingId: binding('binding-codex-session-one'),
      sessionLabel: 'Codex session one',
    })
    const secondSession = await tasks.checkout({
      taskId: second.id,
      participantId: agent,
      bindingId: binding('binding-codex-session-two'),
      sessionLabel: 'Codex session two',
    })

    expect(firstSession.assignment.taskId).toBe(first.id)
    expect(secondSession.assignment.taskId).toBe(second.id)
    expect(rooms.list().rooms.find(room => room.id === first.hiddenRoomId)?.participantIds).toContain(agent)
    expect(rooms.list().rooms.find(room => room.id === second.hiddenRoomId)?.participantIds).toContain(agent)

    const acknowledged = await tasks.acknowledge({
      bindingId: secondSession.assignment.bindingId,
      participantId: agent,
      taskId: second.id,
      revision: second.revision,
    })
    expect(acknowledged.acknowledgedRevision).toBe(second.revision)
    expect(tasks.assignmentList()).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: firstSession.assignment.bindingId, taskId: first.id }),
      expect.objectContaining({ bindingId: secondSession.assignment.bindingId, taskId: second.id }),
    ]))

    await tasks.clear({ bindingId: firstSession.assignment.bindingId, participantId: agent })
    expect(tasks.assignmentList()).toEqual([acknowledged])
    expect(rooms.list().rooms.find(room => room.id === first.hiddenRoomId)?.participantIds).not.toContain(agent)
    expect(rooms.list().rooms.find(room => room.id === second.hiddenRoomId)?.participantIds).toContain(agent)
  })

  it('keeps Room membership while another session remains on the same Task', async () => {
    const { rooms, tasks } = await setup()
    const task = await tasks.create(rootRequest('Shared session target'))
    const agent = participant('agent')
    const first = await tasks.checkout({ taskId: task.id, participantId: agent })
    const second = await tasks.checkout({ taskId: task.id, participantId: agent })
    expect(first.assignment.bindingId).not.toBe(second.assignment.bindingId)

    await tasks.clear({ bindingId: first.assignment.bindingId, participantId: agent })
    expect(rooms.list().rooms.find(room => room.id === task.hiddenRoomId)?.participantIds).toContain(agent)
    expect(tasks.assignmentList()).toEqual([second.assignment])
  })

  it('rejects unavailable Tasks and oversized inherited context', async () => {
    const { rooms, tasks } = await setup({ maxContextBlockBytes: 32 })
    const root = await tasks.create(rootRequest('Tiny'))
    await tasks.publishContext({
      taskId: root.id,
      participantId: participant('owner'),
      text: 'A context entry larger than the complete block limit',
    })
    const head = tasks.get({ taskId: root.id })
    await expect(tasks.create({
      ...rootRequest('Too large'),
      origin: { kind: 'fork', parent: { taskId: root.id, revision: head.revision } },
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(() => tasks.get({ taskId: 'task-missing' as DevelopmentTaskId }))
      .toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }))
    expect(rooms.list().rooms).toHaveLength(1)
  })

  it('lets callers remove publications before enforcing the inherited context limit', async () => {
    const { tasks } = await setup({ maxContextBlockBytes: 500 })
    const root = await tasks.create(rootRequest('Selectable context'))
    const published = await tasks.publishContext({
      taskId: root.id,
      participantId: participant('owner'),
      text: 'x'.repeat(1000),
    })
    const origin = { kind: 'fork' as const, parent: { taskId: root.id, revision: published.revision } }
    await expect(tasks.create({ ...rootRequest('Unfiltered'), origin }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    const filtered = await tasks.create({
      ...rootRequest('Filtered'),
      origin,
      excludedContextIds: [published.context[0]!.id],
    })
    expect(tasks.contextView(filtered.id).inherited?.sources[0]?.context).toEqual([])
  })

  it('retries a degraded hidden Room in the background', async () => {
    const { rooms, tasks } = await setup({ roomRetryIntervalMs: 10 })
    const ensure = rooms.ensure.bind(rooms)
    let failOnce = true
    vi.spyOn(rooms, 'ensure').mockImplementation(async (request) => {
      if (failOnce) {
        failOnce = false
        throw new Error('temporary Room outage')
      }
      return await ensure(request)
    })
    const created = await tasks.create(rootRequest('Self-healing runtime'))
    expect(created.runtime).toBe('degraded')
    await vi.waitFor(() => { expect(tasks.get({ taskId: created.id }).runtime).toBe('ready') })
  })
})
