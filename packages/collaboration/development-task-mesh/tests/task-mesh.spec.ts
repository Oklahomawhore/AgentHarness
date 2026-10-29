import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh/types'
import DevelopmentRoomService, {
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
  type DevelopmentRoomId,
} from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type {
  DevelopmentTaskAdmitRemoteObservedContextRequest,
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskBindingId,
  DevelopmentTaskId,
  DevelopmentTaskLogEntry,
  DevelopmentTaskObservedIntervalIdentity,
  DevelopmentTaskObservedSourceId,
} from '@deepseek-ai/dsh-development-task/types'
import { developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentTaskMeshService from '../src/index.ts'

const contexts: Context[] = []
const REMOTE = 'remote-node' as DevelopmentNodeId
const TASK = 'task-remote' as DevelopmentTaskId
const ROOM = 'room-remote' as DevelopmentRoomId
const HUMAN = 'human-remote' as DevelopmentParticipantId

class MemoryMesh extends DevelopmentMeshService {
  list(): DevelopmentMeshSnapshot {
    return { nodeId: this.ctx.developmentRooms.list().nodeId, clusterId: 'test', secretFingerprint: 'test', peers: [] }
  }
  publish(): void {}
  async command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown> {
    if (ownerNodeId !== this.list().nodeId) throw Object.assign(new Error('offline'), { code: 'RUNTIME_UNAVAILABLE' })
    return await this.channel(channel)?.command?.(payload, ownerNodeId)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(nodeId = 'local-node'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DevelopmentRoomService, {
    nodeId, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 2_048,
  })
  await ctx.plugin(DevelopmentTaskService, {
    maxTasks: 32, maxEventsPerTask: 64,
    maxMergeParents: 8, maxContextBlockBytes: 65_536, maxLineageTasks: 64, maxTextBytes: 2_048, roomRetryIntervalMs: 10_000,
  })
  await ctx.plugin(MemoryMesh)
  await ctx.plugin(DevelopmentTaskMeshService)
  return ctx
}

function created(objective = 'Remote Root'): DevelopmentTaskLogEntry {
  return {
    nodeId: REMOTE,
    seq: 1,
    at: 1,
    taskId: TASK,
    revision: 1,
    hiddenRoomId: ROOM,
    change: {
      kind: 'task-created',
      origin: { kind: 'root' },
      objective,
      scope: 'remote scope',
      createdBy: HUMAN,
    },
  }
}

function contextPublished(): DevelopmentTaskLogEntry {
  return {
    nodeId: REMOTE,
    seq: 2,
    at: 2,
    taskId: TASK,
    revision: 2,
    hiddenRoomId: ROOM,
    change: {
      kind: 'context-published',
      publication: { id: 'context-one', text: 'arrived out of order', publishedBy: HUMAN, publishedAt: 2 },
    },
  }
}

function artifactPublished(): DevelopmentTaskLogEntry {
  const sourceId = 'a'.repeat(64)
  return developmentTaskEventSchema.parse({ ...contextPublished(), change: { kind: 'context-published', publication: {
    id: `context-observation-${sourceId}`, text: 'Observed OpenAPI', publishedBy: HUMAN, publishedAt: 2,
    observation: {
      kind: 'openapi-artifact', version: 1, artifactId: 'orders-api', sourceName: 'Orders API', grantId: 'grant-one', sequence: 1,
      operation: { method: 'post', path: '/orders' }, observerNodeId: REMOTE, sourceId,
      binding: { id: 'agent-session', epoch: { nodeId: REMOTE, seq: 1 } },
      state: 'valid', sha256: '1'.repeat(64),
      facts: { requestBodyRequired: true, requiredRequestFields: ['name'], responseStatuses: ['201', 'default'], deprecated: false },
    },
  } } })
}

async function approvedSource() {
  const ctx = await setup()
  const source = new Context()
  contexts.push(source)
  await source.plugin(DevelopmentRoomService, {
    nodeId: REMOTE, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 2_048,
  })
  const publisher = 'remote-agent' as DevelopmentParticipantId
  await source.developmentRooms.announce({ id: publisher, kind: 'agent', displayName: 'Remote Agent' })
  await ctx.developmentRooms.acceptPresenceReplica(source.developmentRooms.list().participants[0]!, REMOTE)
  const creator = 'local-human' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: creator, kind: 'human', displayName: 'Owner' })
  const task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'API scope', scope: 'Shared API', createdBy: creator })
  const identity: DevelopmentTaskObservedIntervalIdentity = {
    taskId: task.id, sourceNodeId: REMOTE, participantId: publisher, bindingId: 'remote-binding' as DevelopmentTaskBindingId,
    expectedBindingEpoch: { nodeId: REMOTE, seq: 1 },
  }
  const interval = await ctx.developmentTasks.approveObservedInterval(identity)
  const request: DevelopmentTaskAdmitRemoteObservedContextRequest = {
    taskId: task.id, participantId: publisher, bindingId: identity.bindingId, expectedBindingEpoch: identity.expectedBindingEpoch,
    intervalId: interval.id, sourceId: 'a'.repeat(64) as DevelopmentTaskObservedSourceId, text: 'Authorized remote observation',
  }
  return { ctx, identity, interval, request }
}

describe('development Task Mesh channel', () => {
  it('reads only local deltas and sends the context blocks required by the selected creation events', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const publish = vi.spyOn(ctx.developmentMesh, 'publish')
    const creator = 'local-owner' as DevelopmentParticipantId
    const agent = 'local-agent' as DevelopmentParticipantId
    await ctx.developmentRooms.announce({ id: creator, kind: 'human', displayName: 'Owner' })
    await ctx.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
    const root = await ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Root', scope: 'Scope', createdBy: creator })
    await ctx.developmentTaskMesh.route('local-node' as DevelopmentNodeId, {
      method: 'publishContext', request: { taskId: root.id, participantId: creator, text: 'API ready' },
    })
    const fork = await ctx.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: root.id, revision: 2 } },
      objective: 'Fork', scope: 'Scope', createdBy: creator })
    const merged = await ctx.developmentTasks.create({ origin: { kind: 'merge', parents: [
      { taskId: root.id, revision: 2 }, { taskId: fork.id, revision: 1 },
    ] }, objective: 'Merge', scope: 'Scope', createdBy: creator })
    await ctx.developmentTasks.checkout({ taskId: merged.id, participantId: agent })
    expect(publish).toHaveBeenCalledTimes(5)
    const localEvents = [...ctx.developmentTasks.log()]
    const assignment = ctx.developmentTasks.assignmentLog()[0]!
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    expect(publish).toHaveBeenCalledTimes(5)
    expect(await channel.heads()).toEqual({ 'task:local-node': 4, 'task:remote-node': 1, 'assignment:local-node': 1 })
    const blocks = ctx.developmentTasks.blocks()
    expect(await channel.read({})).toEqual([
      ...blocks.map(block => ({ kind: 'context-block', block })),
      ...localEvents.map(entry => ({ kind: 'task-event', entry })),
      { kind: 'assignment-event', entry: assignment },
    ])
    expect(await channel.read({ 'task:local-node': 3, 'assignment:local-node': 1 })).toEqual([
      { kind: 'context-block', block: blocks.find(block => block.id === merged.inheritedContextBlockId) },
      { kind: 'task-event', entry: localEvents[3] },
    ])
    expect(await channel.read({ 'task:local-node': 4, 'assignment:local-node': 1 })).toEqual([])
  })

  it.each(['fork', 'merge'] as const)('holds an inherited %s until its block and cross-owner parent revisions have arrived', async (kind) => {
    const parentOwner = 'parent-owner' as DevelopmentNodeId
    const parents = await setup(parentOwner)
    await parents.developmentRooms.announce({ id: HUMAN, kind: 'human', displayName: 'Owner' })
    const parent = await parents.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Parent', scope: 'Scope', createdBy: HUMAN })
    await parents.developmentTasks.publishContext({ taskId: parent.id, participantId: HUMAN, text: 'Pinned contract' })
    const second = await parents.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Second', scope: 'Scope', createdBy: HUMAN })
    const source = await setup(REMOTE)
    for (const entry of parents.developmentTasks.log()) await source.developmentTasks.acceptLogReplica(entry, parentOwner)
    const creator = 'child-owner' as DevelopmentParticipantId
    await source.developmentRooms.announce({ id: creator, kind: 'human', displayName: 'Child owner' })
    const parentRef = { taskId: parent.id, revision: 2 }
    const origin = kind === 'fork' ? { kind, parent: parentRef } : { kind, parents: [parentRef, { taskId: second.id, revision: 1 }] }
    const child = await source.developmentTasks.create({ origin, objective: 'Child', scope: 'Scope', createdBy: creator })
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const [root, publication, secondRoot] = parents.developmentTasks.log()
    const childEntry = source.developmentTasks.log().at(-1)!
    const block = source.developmentTasks.blocks()[0]!
    const persisted = vi.fn()
    ctx.on('development-task/persist', persisted)
    await channel.receive([{ kind: 'task-event', entry: childEntry }], REMOTE)
    await channel.receive([{ kind: 'context-block', block }], REMOTE)
    expect(ctx.developmentTasks.list({})).toEqual([])
    expect(persisted).not.toHaveBeenCalled()
    await channel.receive([{ kind: 'task-event', entry: root }], parentOwner)
    expect(ctx.developmentTasks.list({})).toHaveLength(1)
    await channel.receive([{ kind: 'task-event', entry: publication }, { kind: 'task-event', entry: secondRoot }], parentOwner)
    expect(ctx.developmentTasks.get({ taskId: child.id })).toMatchObject({ objective: 'Child', inheritedContextBlockId: block.id })
    expect(ctx.developmentTasks.context({ taskId: child.id }).inherited?.sources[0]?.context[0]?.text).toBe('Pinned contract')
    expect(persisted).toHaveBeenCalledTimes(4)
  })

  it('rejects changed pending Task events and accepts exact pending and committed retries without another write', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const pending = contextPublished()
    const item = { kind: 'task-event', entry: pending }
    const persisted = vi.fn()
    ctx.on('development-task/persist', persisted)
    await channel.receive([item, item], REMOTE)
    await expect(channel.receive([{ ...item, entry: { ...pending, at: 3 } }], REMOTE)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).not.toHaveBeenCalled()
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    expect(persisted).toHaveBeenCalledTimes(2)
    await channel.receive([item], REMOTE)
    expect(persisted).toHaveBeenCalledTimes(2)
  })

  it('authenticates and deduplicates pending assignment events before committing a delayed clear', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    const bound: DevelopmentTaskAssignmentLogEntry = { nodeId: REMOTE, seq: 1, at: 1,
      bindingId: 'delayed-clear' as DevelopmentTaskBindingId, participantId: HUMAN, change: { kind: 'task-bound', taskId: TASK } }
    const cleared: DevelopmentTaskAssignmentLogEntry = { ...bound, seq: 2, at: 2, change: { kind: 'task-cleared', previousTaskId: TASK } }
    const item = { kind: 'assignment-event', entry: cleared }
    const persisted = vi.fn()
    ctx.on('development-task/assignment-persist', persisted)
    await expect(channel.receive([item], 'forged-node' as DevelopmentNodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    await channel.receive([item, item], REMOTE)
    await expect(channel.receive([{ ...item, entry: { ...cleared, at: 3 } }], REMOTE)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).not.toHaveBeenCalled()
    await channel.receive([{ kind: 'assignment-event', entry: bound }], REMOTE)
    expect(ctx.developmentTasks.assignmentList()).toEqual([])
    expect(ctx.developmentTasks.assignmentLog()).toEqual([bound, cleared])
    expect(persisted).toHaveBeenCalledTimes(2)
    await expect(channel.receive([{ ...item, entry: { ...cleared, at: 3 } }], REMOTE)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).toHaveBeenCalledTimes(2)
  })

  it('refuses an overfull dependency queue without persisting events that lack their predecessor', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const events = Array.from({ length: 20_001 }, (_, index) => ({
      kind: 'task-event', entry: { ...contextPublished(), seq: index + 2, revision: index + 2 },
    }))
    const persisted = vi.fn()
    ctx.on('development-task/persist', persisted)
    await channel.receive(events.slice(0, 10_000), REMOTE)
    await expect(channel.receive(events.slice(10_000), REMOTE)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(persisted).not.toHaveBeenCalled()
    expect(ctx.developmentTasks.log()).toEqual([])
    expect(await channel.heads()).toEqual({})
  })

  it('uses the actual command peer for observation admission and terminal authorization', async () => {
    const { ctx, identity, request, interval } = await approvedSource()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const command = (payload: unknown, source: DevelopmentNodeId) => channel.command!(payload, source)
    await expect(command({ method: 'admitObservedRemote', request }, 'other-node' as DevelopmentNodeId))
      .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    await expect(async () => await command({ method: 'admitObservedRemote', request: { ...request, sourceNodeId: REMOTE } }, REMOTE))
      .rejects.toMatchObject({ name: 'ZodError' })
    const admission = await command({ method: 'admitObservedRemote', request }, REMOTE)
    expect(admission).toMatchObject({ outcome: 'published', receipt: { intervalId: interval.id, revision: 3 } })
    await expect(command({ method: 'endObservedInterval', request: identity }, 'other-node' as DevelopmentNodeId))
      .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    const ended = await command({ method: 'endObservedInterval', request: identity }, REMOTE)
    expect(ended).toMatchObject({ intervalId: interval.id, revision: 4 })
    await expect(command({ method: 'admitObservedRemote', request }, REMOTE)).resolves.toMatchObject({ outcome: 'reused', receipt: {
      intervalId: interval.id, revision: 3,
    } })
    expect(ctx.developmentTasks.get({ taskId: identity.taskId }).context.at(-1)?.observedIntervalEnded).toBe(true)
  })

  it('parses authoritative interval and terminal results and refuses malformed owner receipts', async () => {
    const { ctx, identity, interval, request } = await approvedSource()
    const owner = 'local-node' as DevelopmentNodeId
    await expect(ctx.developmentTaskMesh.route(owner, { method: 'observedIntervals', request: { taskId: identity.taskId } }))
      .resolves.toEqual([interval])
    const admitted = await ctx.developmentMesh.channel('development-task/v1')!.command!({ method: 'admitObservedRemote', request }, REMOTE)
    vi.spyOn(ctx.developmentMesh, 'command').mockResolvedValueOnce(JSON.parse(JSON.stringify(admitted)) as unknown)
    await expect(ctx.developmentTaskMesh.route(owner, { method: 'admitObservedRemote', request }))
      .resolves.toEqual(admitted)
    const end = await ctx.developmentTaskMesh.route(owner, { method: 'endObservedInterval', request: identity })
    expect(end).toMatchObject({ intervalId: interval.id, revision: 4 })
    vi.spyOn(ctx.developmentMesh, 'command').mockResolvedValue({ ...end, event: { nodeId: owner, seq: 0 } })
    await expect(ctx.developmentTaskMesh.route(owner, { method: 'endObservedInterval', request: identity }))
      .rejects.toMatchObject({ name: 'ZodError' })
    await expect(ctx.developmentTaskMesh.route(owner, { method: 'admitObservedRemote', request }))
      .rejects.toMatchObject({ name: 'ZodError' })
    await expect(ctx.developmentTaskMesh.route(owner, { method: 'observedIntervals', request: { taskId: identity.taskId } }))
      .rejects.toMatchObject({ name: 'ZodError' })
  })

  it.each([
    'Task', 'interval id', 'source identity',
    'approval Task', 'approval interval', 'approval owner', 'approval event source',
    'end Task', 'end interval', 'end owner', 'end event source',
  ])('rejects the entire interval list when its %s association is wrong', async (field) => {
    const { ctx, identity, interval } = await approvedSource()
    if (interval.state !== 'active') throw new Error('fixture approval missing')
    const endReceipt = await ctx.developmentTasks.endObservedInterval(identity)
    const [ended] = await ctx.developmentTasks.observedIntervals({ taskId: identity.taskId })
    const receiptChange = field.endsWith('Task') ? { taskId: 'another-task' }
      : field.endsWith('interval') ? { intervalId: 'b'.repeat(64) }
        : field.endsWith('owner') ? { ownerNodeId: 'another-owner' }
          : { event: { nodeId: 'another-owner', seq: 1 } }
    const wrong = field === 'Task' ? { ...ended, taskId: 'another-task' }
      : field === 'interval id' ? { ...ended, id: 'b'.repeat(64) }
        : field === 'source identity' ? { ...ended, expectedBindingEpoch: { ...identity.expectedBindingEpoch, seq: 99 } }
          : field.startsWith('approval') ? { ...ended, approvalReceipt: { ...interval.approvalReceipt, ...receiptChange } }
            : { ...ended, endReceipt: { ...endReceipt, ...receiptChange } }
    const transport = vi.spyOn(ctx.developmentMesh, 'command').mockResolvedValue([interval, wrong])
    const query = { method: 'observedIntervals' as const, request: { taskId: identity.taskId } }
    await expect(ctx.developmentTaskMesh.route(endReceipt.ownerNodeId, query)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    transport.mockResolvedValue([ended])
    await expect(ctx.developmentTaskMesh.route(endReceipt.ownerNodeId, query)).resolves.toEqual([ended])
    expect(await ctx.developmentTasks.observedIntervals({ taskId: identity.taskId })).toEqual([ended])
  })

  it('preserves trusted observation fields through the wire parser and detects changed evidence', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const observed = artifactPublished()
    const wire = JSON.parse(JSON.stringify([{ kind: 'task-event', entry: created() }, { kind: 'task-event', entry: observed }])) as unknown[]
    await channel.receive(wire, REMOTE)
    expect(ctx.developmentTasks.log()[1]).toEqual(observed)
    const publication = ctx.developmentTasks.get({ taskId: TASK }).context[0]!
    expect(Object.isFrozen(publication.observation?.binding.epoch)).toBe(true)
    if (observed.change.kind !== 'context-published' || observed.change.publication.observation?.state !== 'valid') {
      throw new Error('expected valid artifact event')
    }
    await expect(channel.receive([{ kind: 'task-event', entry: { ...observed, change: { ...observed.change, publication: {
      ...observed.change.publication, observation: { ...observed.change.publication.observation, sha256: '2'.repeat(64) },
    } } } }], REMOTE)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
  })

  it('rejects forged admission-node evidence before persisting its Task event', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    const observed = artifactPublished()
    if (observed.change.kind !== 'context-published') throw new Error('expected publication')
    let persisted = 0
    ctx.on('development-task/persist', () => { persisted++ })
    await expect(channel.receive([{ kind: 'task-event', entry: { ...observed, change: { ...observed.change, publication: {
      ...observed.change.publication, observation: { ...observed.change.publication.observation, observerNodeId: 'forged-local-node' },
    } } } }], REMOTE)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).toBe(0)
    expect(ctx.developmentTasks.get({ taskId: TASK }).revision).toBe(1)
  })

  it('rejects observation metadata on the wire publish command', async () => {
    const ctx = await setup()
    await expect(ctx.developmentMesh.command('local-node' as DevelopmentNodeId, 'development-task/v1', {
      method: 'publishContext', request: { taskId: TASK, participantId: HUMAN, text: 'claim', observation: { kind: 'openapi-artifact' } },
    })).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('buffers an out-of-order event until its exact predecessor arrives', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await channel.receive([{ kind: 'task-event', entry: contextPublished() }], REMOTE)
    expect(ctx.developmentTasks.list({ limit: 32 })).toEqual([])

    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    expect(ctx.developmentTasks.get({ taskId: TASK })).toMatchObject({ revision: 2, context: [{ text: 'arrived out of order' }] })
  })

  it('buffers a cross-owner assignment until its referenced Task arrives without persisting incomplete state', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const home = 'participant-home' as DevelopmentNodeId
    const bound: DevelopmentTaskAssignmentLogEntry = {
      nodeId: home, seq: 1, at: 1, bindingId: 'cross-owner-binding' as DevelopmentTaskBindingId,
      participantId: 'cross-owner-agent' as DevelopmentParticipantId, change: { kind: 'task-bound', taskId: TASK },
    }
    const persisted = vi.fn()
    ctx.on('development-task/assignment-persist', persisted)

    await expect(channel.receive([{ kind: 'assignment-event', entry: bound }], home)).resolves.toBeUndefined()
    expect(persisted).not.toHaveBeenCalled()
    expect(ctx.developmentTasks.assignmentLog()).toEqual([])
    expect(await channel.heads()).not.toHaveProperty(`assignment:${home}`)

    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    expect(ctx.developmentTasks.assignmentList()).toEqual([{
      bindingId: bound.bindingId, participantId: bound.participantId, taskId: TASK, assignedAt: bound.at,
    }])
    expect(persisted).toHaveBeenCalledExactlyOnceWith(bound)
    await channel.receive([{ kind: 'assignment-event', entry: bound }], home)
    expect(persisted).toHaveBeenCalledOnce()
  })

  it('buffers a cross-owner acknowledgement until its referenced Task revision arrives', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    const home = 'participant-home' as DevelopmentNodeId
    const bound: DevelopmentTaskAssignmentLogEntry = {
      nodeId: home, seq: 1, at: 1, bindingId: 'cross-owner-binding' as DevelopmentTaskBindingId,
      participantId: 'cross-owner-agent' as DevelopmentParticipantId, change: { kind: 'task-bound', taskId: TASK },
    }
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    await channel.receive([{ kind: 'assignment-event', entry: bound }], home)
    const acknowledged: DevelopmentTaskAssignmentLogEntry = {
      ...bound, seq: 2, at: 2, change: { kind: 'context-acknowledged', taskId: TASK, revision: 2 },
    }
    const persisted = vi.fn()
    ctx.on('development-task/assignment-persist', persisted)

    await channel.receive([{ kind: 'assignment-event', entry: acknowledged }], home)
    expect(persisted).not.toHaveBeenCalled()
    expect(ctx.developmentTasks.assignmentLog()).toEqual([bound])
    expect(ctx.developmentTasks.assignmentList()[0]?.acknowledgedRevision).toBeUndefined()
    expect(await channel.heads()).toHaveProperty(`assignment:${home}`, 1)

    await channel.receive([{ kind: 'task-event', entry: contextPublished() }], REMOTE)
    expect(ctx.developmentTasks.assignmentList()[0]?.acknowledgedRevision).toBe(2)
    expect(persisted).toHaveBeenCalledExactlyOnceWith(acknowledged)
    expect(await channel.heads()).toHaveProperty(`assignment:${home}`, 2)
  })

  it('rejects a different payload for an already committed event identity', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await channel.receive([{ kind: 'task-event', entry: created() }], REMOTE)
    await expect(channel.receive([{ kind: 'task-event', entry: created('Conflicting Root') }], REMOTE))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(ctx.developmentTasks.get({ taskId: TASK }).objective).toBe('Remote Root')
  })

  it('rejects an event whose claimed origin differs from its authenticated peer', async () => {
    const ctx = await setup()
    const channel = ctx.developmentMesh.channel('development-task/v1')!
    await expect(channel.receive([{ kind: 'task-event', entry: created() }], 'other-node' as DevelopmentNodeId))
      .rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
  })
})
