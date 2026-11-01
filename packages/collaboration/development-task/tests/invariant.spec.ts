import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentTaskService, { type DevelopmentTaskLogEntry } from '../src/index.ts'
import * as TaskInvariant from '../src/invariant.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(nodeId: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DevelopmentRoomService, {
    nodeId, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 16, maxTextBytes: 2048,
  })
  await ctx.plugin(DevelopmentTaskService, {
    maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4, maxContextBlockBytes: 65_536,
    maxLineageTasks: 16, maxTextBytes: 2048, roomRetryIntervalMs: 10_000,
  })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  const companion = ctx.plugin(TaskInvariant)
  await companion
  const owner = `${nodeId}-owner` as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: nodeId })
  const create = (objective: string) => ctx.developmentTasks.create({
    origin: { kind: 'root' }, objective, scope: 'Task invariant', createdBy: owner,
  })
  return { ctx, owner, create, companion }
}

describe('Task persistence and projection invariant', () => {
  it('accepts an exact replica replay without a second durable write', async () => {
    const source = await setup('source')
    const replica = await setup('replica')
    const task = await source.create('Original Task')
    const [entry] = source.ctx.developmentTasks.log()
    if (entry === undefined) throw new Error('Task creation did not retain its event')
    const persisted = vi.fn<(event: DevelopmentTaskLogEntry) => void>()
    replica.ctx.on('development-task/persist', persisted)
    await replica.ctx.developmentTasks.acceptLogReplica(entry, entry.nodeId)
    expect(persisted).toHaveBeenCalledOnce()
    await expect(replica.ctx.developmentTasks.acceptLogReplica(entry, entry.nodeId))
      .resolves.toMatchObject({ id: task.id, revision: 1 })
    expect(persisted).toHaveBeenCalledOnce()
    expect(replica.ctx.developmentTasks.log()).toEqual([entry])
    await source.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: source.owner, text: 'Next revision' })
    const next = source.ctx.developmentTasks.log().at(-1)
    if (next === undefined) throw new Error('Task publication did not retain its event')
    await expect(replica.ctx.developmentTasks.acceptLogReplica(next, next.nodeId)).resolves.toMatchObject({ revision: 2 })
    expect(persisted).toHaveBeenCalledTimes(2)
  })

  it('rejects a persist candidate whose real source predecessor is absent from the recipient log', async () => {
    const source = await setup('source')
    const replica = await setup('replica')
    await source.create('First source Task')
    await source.create('Second source Task')
    const entry = source.ctx.developmentTasks.log().at(-1)
    if (entry === undefined) throw new Error('Second Task did not retain its event')
    await expect(replica.ctx.parallel('development-task/persist', entry)).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'INVARIANT' })],
    })
    expect(replica.ctx.developmentTasks.log()).toEqual([])
  })

  it('rejects a change notification carrying an event retained only by another Host', async () => {
    const source = await setup('source')
    const recipient = await setup('recipient')
    const snapshot = await source.create('Foreign notification')
    const [entry] = source.ctx.developmentTasks.log()
    if (entry === undefined) throw new Error('Task creation did not retain its event')
    expect(() => { recipient.ctx.emit('development-task/changed', snapshot, entry, { kind: 'local', nodeId: entry.nodeId }) })
      .toThrow(expect.objectContaining({ code: 'INVARIANT' }))
  })

  it('rejects a retained event superseded by a newer Task revision and releases listeners on disposal', async () => {
    const host = await setup('owner')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const first = await host.create('First Task')
      const [entry] = host.ctx.developmentTasks.log()
      if (entry === undefined) throw new Error('Task creation did not retain its event')
      clock.mockReturnValue(2000)
      await host.ctx.developmentTasks.publishContext({ taskId: first.id, participantId: host.owner, text: 'Newer revision' })
      const notify = () => { host.ctx.emit('development-task/changed', first, entry, { kind: 'local', nodeId: entry.nodeId }) }
      expect(notify).toThrow(expect.objectContaining({ code: 'INVARIANT' }))
      await host.companion.dispose()
      expect(notify).not.toThrow()
    } finally { clock.mockRestore() }
  })

  it('rejects another retained Task event even when both Tasks share a timestamp', async () => {
    const host = await setup('owner')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const first = await host.create('First Task')
      await host.create('Second Task')
      const entry = host.ctx.developmentTasks.log().at(-1)
      if (entry === undefined) throw new Error('Second Task did not retain its event')
      expect(() => { host.ctx.emit('development-task/changed', first, entry, { kind: 'local', nodeId: entry.nodeId }) })
        .toThrow(expect.objectContaining({ code: 'INVARIANT' }))
    } finally { clock.mockRestore() }
  })

  it.each(['old-event', 'old-snapshot', 'old-pair'] as const)('rejects an equal-time same-Task %s notification', async (outdated) => {
    const host = await setup('owner')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const first = await host.create('Versioned Task')
      const [oldEntry] = host.ctx.developmentTasks.log()
      const current = await host.ctx.developmentTasks.publishContext({
        taskId: first.id, participantId: host.owner, text: 'Newer revision at the same time',
      })
      const currentEntry = host.ctx.developmentTasks.log().at(-1)
      if (oldEntry === undefined || currentEntry === undefined) throw new Error('Task revisions did not retain their events')
      const snapshot = outdated === 'old-event' ? current : first
      const entry = outdated === 'old-snapshot' ? currentEntry : oldEntry
      expect(() => { host.ctx.emit('development-task/changed', snapshot, entry, { kind: 'local', nodeId: entry.nodeId }) })
        .toThrow(expect.objectContaining({ code: 'INVARIANT' }))
    } finally { clock.mockRestore() }
  })
})
