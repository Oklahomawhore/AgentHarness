/** Local creation, parsed replicas, and restored history share the Host's retained Task capacity. */
import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import { afterEach, expect, it, vi } from 'vitest'
import DevelopmentTaskService, { type Config, type DevelopmentTaskLogEntry } from '../src/index.ts'
import { developmentTaskEventSchema } from '../src/schema.ts'

const contexts: Context[] = []
const config: Config = { maxTasks: 2, maxEventsPerTask: 16, maxMergeParents: 4, maxContextBlockBytes: 32768,
  maxLineageTasks: 16, maxTextBytes: 8192, roomRetryIntervalMs: 10_000 }

afterEach(async () => {
  const results = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'Task capacity fixture cleanup failed')
})

async function host(nodeId: string, maxTasks = config.maxTasks) {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId, presenceTtlMs: 10_000,
    maxParticipants: 8, maxRooms: 8, maxTextBytes: 8192 })
  const owner = `${nodeId}-owner` as DevelopmentParticipantId
  await rooms.announce({ id: owner, kind: 'human', displayName: 'Task owner' })
  const tasks = new DevelopmentTaskService(ctx, { ...config, maxTasks })
  const create = (objective: string) => tasks.create({ origin: { kind: 'root' }, objective, scope: 'Capacity fixture', createdBy: owner })
  return { ctx, tasks, owner, create }
}

async function history() {
  const source = await host('capacity-source')
  const first = await source.create('First retained Task')
  await source.tasks.publishContext({ taskId: first.id, participantId: source.owner, text: 'Updated existing Task' })
  const second = await source.create('Second retained Task')
  const entries = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(source.tasks.log())))
  return { source, first, second, entries }
}

it('rejects another parsed replica at capacity before persistence while permitting existing Task updates and exact retries', async () => {
  const f = await history()
  const recipient = await host('capacity-recipient', 1)
  const [created, updated, overflow] = f.entries
  if (created === undefined || updated === undefined || overflow === undefined) throw new Error('Missing generated Task history')
  await recipient.tasks.acceptLogReplica(created, created.nodeId)
  await recipient.tasks.acceptLogReplica(updated, updated.nodeId)
  const retained = recipient.tasks.log()
  const persisted = vi.fn<(entry: DevelopmentTaskLogEntry) => void>()
  const changed = vi.fn()
  recipient.ctx.on('development-task/persist', persisted)
  recipient.ctx.on('development-task/changed', changed)
  await expect(recipient.tasks.acceptLogReplica(created, created.nodeId)).resolves.toMatchObject({ id: f.first.id, revision: 2 })
  await expect(recipient.tasks.acceptLogReplica(overflow, overflow.nodeId)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  expect(persisted).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(recipient.tasks.log()).toEqual(retained)
  expect(recipient.tasks.list({ limit: 2 }).map(task => task.id)).toEqual([f.first.id])
  expect(() => recipient.tasks.get({ taskId: f.second.id })).toThrow()
})

it('rejects parsed restoration above a reduced retained Task capacity without rewriting its history', async () => {
  const f = await history()
  const enough = await host('capacity-restored-enough', 2)
  enough.tasks.restoreLog(f.entries)
  expect(enough.tasks.list({ limit: 2 })).toHaveLength(2)
  const narrow = await host('capacity-restored-narrow', 1)
  const persisted = vi.fn<(entry: DevelopmentTaskLogEntry) => void>()
  narrow.ctx.on('development-task/persist', persisted)
  expect(() => { narrow.tasks.restoreLog(f.entries) }).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
  expect(narrow.tasks.log()).toEqual(f.entries.slice(0, 2))
  expect(narrow.tasks.list({ limit: 2 }).map(task => task.id)).toEqual([f.first.id])
  expect(persisted).not.toHaveBeenCalled()
  expect(f.source.tasks.log()).toEqual(f.entries)
})
