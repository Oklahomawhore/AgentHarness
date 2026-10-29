import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService, { type DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh'
import DevelopmentRoomService, { type DevelopmentNodeId, type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskMeshService from '@deepseek-ai/dsh-development-task-mesh'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DevelopmentTaskService, { type DevelopmentTaskLogEntry, type DevelopmentTaskObservedIntervalIdentity } from '../src/index.ts'
import { developmentTaskAdmitRemoteObservedContextRequestSchema, developmentTaskContextBlockSchema, developmentTaskEventSchema } from '../src/schema.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

class DirectMesh extends DevelopmentMeshService {
  static inject = ['developmentRooms']
  constructor(ctx: Context, private readonly hosts: ReadonlyMap<DevelopmentNodeId, Context>) { super(ctx) }
  override list(): DevelopmentMeshSnapshot {
    return { nodeId: this.ctx.developmentRooms.list().nodeId, clusterId: 'release-test', secretFingerprint: 'keyless', peers: [] }
  }
  override publish(): void {}
  override async command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown> {
    const recipient = this.hosts.get(ownerNodeId)?.developmentMesh.channel(channel)
    if (recipient?.command === undefined) throw Object.assign(new Error('Owner is offline'), { code: 'RUNTIME_UNAVAILABLE' })
    return await recipient.command(payload, this.ctx.developmentRooms.list().nodeId)
  }
}

async function setup(nodeId: string) {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 4096,
  })
  const owner = `${nodeId}-owner` as DevelopmentParticipantId
  await rooms.announce({ id: owner, kind: 'human', displayName: nodeId })
  const tasks = new DevelopmentTaskService(ctx, {
    maxTasks: 16, maxEventsPerTask: 64, maxMergeParents: 4, maxContextBlockBytes: 32_768,
    maxLineageTasks: 32, maxTextBytes: 4096, roomRetryIntervalMs: 10_000,
  })
  return { ctx, rooms, tasks, owner }
}

async function routedSource() {
  const owner = await setup('owner-node')
  const source = await setup('source-node')
  const ownerNodeId = owner.rooms.list().nodeId
  const sourceNodeId = source.rooms.list().nodeId
  const hosts = new Map<DevelopmentNodeId, Context>([[ownerNodeId, owner.ctx], [sourceNodeId, source.ctx]])
  new DirectMesh(owner.ctx, hosts)
  const sourceTransport = new DirectMesh(source.ctx, hosts)
  await owner.ctx.plugin(DevelopmentTaskMeshService)
  await source.ctx.plugin(DevelopmentTaskMeshService)
  const task = await owner.tasks.create({ origin: { kind: 'root' }, objective: 'Original responsibility',
    scope: 'Authorized shared observations', createdBy: owner.owner })
  const [creation] = owner.tasks.log()
  if (creation === undefined) throw new Error('Owner Task creation was not retained')
  await source.tasks.acceptLogReplica(creation, ownerNodeId)
  const participantId = 'source-agent' as DevelopmentParticipantId
  await source.rooms.announce({ id: participantId, kind: 'agent', displayName: 'Source Agent' })
  const profile = source.rooms.list().participants.find(item => item.id === participantId)
  if (profile === undefined) throw new Error('Source Agent was not announced')
  await owner.rooms.acceptPresenceReplica(profile, sourceNodeId)
  const checked = await source.tasks.checkout({ taskId: task.id, participantId, sessionLabel: 'Existing source Session' })
  const bound = source.tasks.assignmentLog().at(-1)
  if (bound === undefined) throw new Error('Source checkout was not retained')
  const identity: DevelopmentTaskObservedIntervalIdentity = {
    taskId: task.id, sourceNodeId, participantId, bindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: bound.nodeId, seq: bound.seq },
  }
  return { owner, source, hosts, sourceTransport, ownerNodeId, sourceNodeId, task, identity, bound }
}

describe('Task owner routing and recovery', () => {
  it.each(['node-sequence', 'task-revision', 'second-creation', 'hidden-room', 'backwards-time', 'unknown-task', 'foreign-owner'] as const)(
    'rejects parsed %s corruption without occupying the next owner log position', async (mismatch) => {
      const source = await setup('source-node')
      const recipient = await setup('recipient-node')
      const task = await source.tasks.create({ origin: { kind: 'root' }, objective: 'Owner context', scope: 'Original scope', createdBy: source.owner })
      await source.tasks.publishContext({ taskId: task.id, participantId: source.owner, text: 'Original publication' })
      const [creation, publication] = source.tasks.log()
      if (creation === undefined || publication === undefined) throw new Error('Generated Task history is missing')
      await recipient.tasks.acceptLogReplica(creation, creation.nodeId)
      const wire = developmentTaskEventSchema.parse({ ...publication,
        ...(mismatch === 'node-sequence' ? { seq: publication.seq + 1 } : {}),
        ...(mismatch === 'task-revision' ? { revision: publication.revision + 1 } : {}),
        ...(mismatch === 'second-creation' ? { change: creation.change } : {}),
        ...(mismatch === 'hidden-room' ? { hiddenRoomId: 'another-room' } : {}),
        ...(mismatch === 'backwards-time' ? { at: creation.at - 1 } : {}),
        ...(mismatch === 'unknown-task' ? { taskId: 'another-task', revision: 1 } : {}),
        ...(mismatch === 'foreign-owner' ? { nodeId: 'another-node', seq: 1 } : {}),
      })
      const persisted = vi.fn<(candidate: DevelopmentTaskLogEntry) => void>()
      recipient.ctx.on('development-task/persist', persisted)
      await expect(recipient.tasks.acceptLogReplica(wire, wire.nodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
      expect(persisted).not.toHaveBeenCalled()
      expect(recipient.tasks.log()).toEqual([creation])
      await expect(recipient.tasks.acceptLogReplica(publication, publication.nodeId)).resolves.toMatchObject({
        context: [expect.objectContaining({ text: 'Original publication' })],
      })
      expect(persisted).toHaveBeenCalledOnce()
      expect(recipient.tasks.log()).toEqual(source.tasks.log())
    },
  )

  it('rejects an event authenticated as another peer before persistence', async () => {
    const source = await setup('source-node')
    const recipient = await setup('recipient-node')
    await source.tasks.create({ origin: { kind: 'root' }, objective: 'Owner context', scope: 'Original scope', createdBy: source.owner })
    const creation = source.tasks.log()[0]
    if (creation === undefined) throw new Error('Generated Task creation is missing')
    const persisted = vi.fn<(candidate: DevelopmentTaskLogEntry) => void>()
    recipient.ctx.on('development-task/persist', persisted)
    await expect(recipient.tasks.acceptLogReplica(creation, recipient.rooms.list().nodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).not.toHaveBeenCalled()
    expect(recipient.tasks.log()).toEqual([])
    await expect(recipient.tasks.acceptLogReplica(creation, creation.nodeId)).resolves.toMatchObject({ id: creation.taskId })
  })

  it('routes approved source admission and termination to the original owner and preserves retry receipts', async () => {
    const { owner, source, task, identity } = await routedSource()
    const approved = await owner.tasks.approveObservedInterval(identity)
    if (approved.state !== 'active') throw new Error('Approved source interval did not become active')
    await expect(source.tasks.observedIntervals({ taskId: task.id })).resolves.toEqual([approved])
    const request = developmentTaskAdmitRemoteObservedContextRequestSchema.parse({
      taskId: identity.taskId, participantId: identity.participantId, bindingId: identity.bindingId,
      expectedBindingEpoch: identity.expectedBindingEpoch, intervalId: approved.id,
      sourceId: 'a'.repeat(64), text: 'Explicitly authorized source observation',
    })
    await expect(owner.tasks.admitObservedRemote(request)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    const first = await source.tasks.admitObservedRemote(request)
    expect(first).toMatchObject({ outcome: 'published', publication: { text: request.text }, receipt: { ownerNodeId: approved.approvalReceipt.ownerNodeId } })
    expect(owner.tasks.contextView(task.id).task.context).toEqual([first.publication])
    const ended = await source.tasks.endObservedInterval(identity)
    await expect(owner.tasks.endObservedInterval(identity)).resolves.toEqual(ended)
    await expect(source.tasks.endObservedInterval(identity)).resolves.toEqual(ended)
    await expect(source.tasks.admitObservedRemote(request)).resolves.toMatchObject({ outcome: 'reused', receipt: first.receipt })
    await expect(source.tasks.observedIntervals({ taskId: task.id })).resolves.toEqual([
      expect.objectContaining({ state: 'ended', endReceipt: ended, approvalReceipt: approved.approvalReceipt }),
    ])
    expect(source.tasks.get({ taskId: task.id }).revision).toBe(1)
  })

  it('routes explicit publication without replacing the source assignment and preserves owner validation errors', async () => {
    const { owner, source, task, identity } = await routedSource()
    const assignment = source.tasks.assignmentList()
    const result = await source.tasks.publishContext({ taskId: task.id, participantId: identity.participantId, text: 'Owner-committed context' })
    expect(result.context).toEqual([expect.objectContaining({ text: 'Owner-committed context', publishedBy: identity.participantId })])
    expect(owner.tasks.get({ taskId: task.id })).toEqual(result)
    expect(source.tasks.assignmentList()).toEqual(assignment)
    await expect(source.tasks.publishContext({ taskId: task.id, participantId: identity.participantId, text: ' ' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', cause: { code: 'INVALID_REQUEST' } })
    expect(owner.tasks.get({ taskId: task.id })).toEqual(result)
  })

  it('keeps offline cached Task data readable and resumes owner queries after the same peer returns', async () => {
    const { source, hosts, ownerNodeId, owner, task } = await routedSource()
    hosts.delete(ownerNodeId)
    const cached = source.tasks.get({ taskId: task.id })
    await expect(source.tasks.observedIntervals({ taskId: task.id })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(source.tasks.get({ taskId: task.id })).toEqual(cached)
    hosts.set(ownerNodeId, owner.ctx)
    await expect(source.tasks.observedIntervals({ taskId: task.id })).resolves.toEqual([])
    expect(source.tasks.get({ taskId: task.id })).toEqual(cached)
  })

  it('preserves a transport failure without a protocol error code', async () => {
    const { source, sourceTransport, task } = await routedSource()
    const failure = new Error('Unclassified transport failure')
    vi.spyOn(sourceTransport, 'command').mockRejectedValueOnce(failure)
    await expect(source.tasks.observedIntervals({ taskId: task.id })).rejects.toBe(failure)
    await expect(source.tasks.observedIntervals({ taskId: task.id })).resolves.toEqual([])
  })
})

async function generatedLineage() {
  const source = await setup('source-node')
  const first = await source.tasks.create({ origin: { kind: 'root' }, objective: 'First parent', scope: 'First scope', createdBy: source.owner })
  const second = await source.tasks.create({ origin: { kind: 'root' }, objective: 'Second parent', scope: 'Second scope', createdBy: source.owner })
  const firstContext = await source.tasks.publishContext({ taskId: first.id, participantId: source.owner, text: 'First publication' })
  const secondContext = await source.tasks.publishContext({ taskId: second.id, participantId: source.owner, text: 'Second publication' })
  const firstParent = { taskId: firstContext.id, revision: firstContext.revision }
  const parents = [firstParent, { taskId: secondContext.id, revision: secondContext.revision }]
  const fork = await source.tasks.create({ origin: { kind: 'fork', parent: firstParent },
    objective: 'Valid Fork', scope: 'One selected parent', createdBy: source.owner })
  const merge = await source.tasks.create({ origin: { kind: 'merge', parents },
    objective: 'Valid Merge', scope: 'Two selected parents', createdBy: source.owner })
  const reverse = await source.tasks.create({ origin: { kind: 'merge', parents: [...parents].reverse() },
    objective: 'Reverse Merge', scope: 'Reverse selected order', createdBy: source.owner })
  const root = await source.tasks.create({ origin: { kind: 'root' }, objective: 'Independent Root', scope: 'No parent', createdBy: source.owner })
  const forkBlock = source.tasks.blocks().find(block => block.id === fork.inheritedContextBlockId)
  const reverseBlock = source.tasks.blocks().find(block => block.id === reverse.inheritedContextBlockId)
  if (forkBlock === undefined || reverseBlock === undefined) throw new Error('Generated inherited blocks are missing')
  return { source, firstContext, secondContext, fork, merge, root, forkBlock, reverseBlock }
}

describe('Task inherited-context replica validation', () => {
  it('waits for a missing inherited block during restore and rejects its replica until the block arrives', async () => {
    const { source, fork, forkBlock } = await generatedLineage()
    const recipient = await setup('recipient-node')
    const restored = await setup('restored-node')
    const entry = source.tasks.log().find(item => item.taskId === fork.id)
    if (entry === undefined) throw new Error('Generated Fork is missing')
    const parents = source.tasks.log().filter(item => item.seq < entry.seq)
    for (const parent of parents) await recipient.tasks.acceptLogReplica(parent, parent.nodeId)
    const persisted = vi.fn<(candidate: DevelopmentTaskLogEntry) => void>()
    recipient.ctx.on('development-task/persist', persisted)
    await expect(recipient.tasks.acceptLogReplica(entry, entry.nodeId)).rejects.toMatchObject({ code: 'PARENT_REVISION_UNAVAILABLE' })
    expect(persisted).not.toHaveBeenCalled()
    expect(recipient.tasks.log()).toEqual(parents)
    expect(() => { restored.tasks.restoreLog([...parents, entry]) }).toThrow('unresolved lineage or sequence dependencies')
    expect(restored.tasks.log()).toEqual(parents)
    restored.tasks.restoreContextBlocks([forkBlock])
    restored.tasks.restoreLog([entry])
    await recipient.tasks.acceptContextReplica(forkBlock)
    await expect(recipient.tasks.acceptLogReplica(entry, entry.nodeId)).resolves.toMatchObject({ id: fork.id })
    expect(restored.tasks.contextView(fork.id)).toEqual(recipient.tasks.contextView(fork.id))
  })

  it.each(['replica', 'restore'] as const)('rejects %s of a Merge repeating a parent even with a matching content-addressed block', async (admission) => {
    const { source, merge, forkBlock } = await generatedLineage()
    const recipient = await setup('recipient-node')
    const entry = source.tasks.log().find(item => item.taskId === merge.id)
    const parent = forkBlock.sources[0]
    if (entry?.change.kind !== 'task-created' || parent === undefined) throw new Error('Generated Merge evidence is missing')
    const sources = [parent, parent]
    const block = developmentTaskContextBlockSchema.parse({
      id: `context-${createHash('sha256').update(JSON.stringify({ version: 1, sources })).digest('hex')}`,
      createdAt: forkBlock.createdAt, sources,
    })
    const wire = developmentTaskEventSchema.parse({ ...entry, change: {
      ...entry.change, origin: { kind: 'merge', parents: sources.map(item => item.parent) }, inheritedContextBlockId: block.id,
    } })
    const previous = source.tasks.log().filter(item => item.seq < entry.seq)
    const blocks = [...source.tasks.blocks(), block]
    const persisted = vi.fn<(candidate: DevelopmentTaskLogEntry) => void>()
    if (admission === 'restore') {
      recipient.tasks.restoreContextBlocks(blocks)
      recipient.ctx.on('development-task/persist', persisted)
      expect(() => { recipient.tasks.restoreLog([...previous, wire]) }).toThrow(expect.objectContaining({ code: 'REPLICA_CONFLICT' }))
    } else {
      for (const item of blocks) await recipient.tasks.acceptContextReplica(item)
      for (const prior of previous) await recipient.tasks.acceptLogReplica(prior, prior.nodeId)
      recipient.ctx.on('development-task/persist', persisted)
      await expect(recipient.tasks.acceptLogReplica(wire, wire.nodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    }
    expect(persisted).not.toHaveBeenCalled()
    expect(recipient.tasks.log()).toEqual(previous)
  })

  it.each(['root-block', 'fork-missing', 'merge-missing', 'merge-count', 'merge-order'] as const)(
    'rejects parsed Task lineage corruption: %s', async (mismatch) => {
      const { source, root, fork, merge, forkBlock, reverseBlock } = await generatedLineage()
      const recipient = await setup('recipient-node')
      const target = mismatch === 'root-block' ? root : mismatch === 'fork-missing' ? fork : merge
      const entry = source.tasks.log().find(item => item.taskId === target.id)
      if (entry?.change.kind !== 'task-created') throw new Error('Generated Task creation is missing')
      let change = entry.change
      if (mismatch === 'fork-missing' || mismatch === 'merge-missing') {
        const { inheritedContextBlockId: _blockId, ...without } = entry.change
        change = without
      } else change = { ...entry.change, inheritedContextBlockId: mismatch === 'merge-order' ? reverseBlock.id : forkBlock.id }
      for (const block of source.tasks.blocks()) await recipient.tasks.acceptContextReplica(block)
      for (const previous of source.tasks.log().filter(item => item.seq < entry.seq)) {
        await recipient.tasks.acceptLogReplica(previous, previous.nodeId)
      }
      const wire = developmentTaskEventSchema.parse({ ...entry, change })
      const retained = recipient.tasks.log()
      const persisted = vi.fn<(candidate: DevelopmentTaskLogEntry) => void>()
      recipient.ctx.on('development-task/persist', persisted)
      await expect(recipient.tasks.acceptLogReplica(wire, wire.nodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
      expect(persisted).not.toHaveBeenCalled()
      expect(recipient.tasks.log()).toEqual(retained)
    },
  )

  it('preserves valid parent-context exclusions and ordered Merge history across parsed replicas and restore', async () => {
    const { source, firstContext, secondContext } = await generatedLineage()
    const [publication] = firstContext.context
    if (publication === undefined) throw new Error('First parent publication is missing')
    const fork = await source.tasks.create({ origin: { kind: 'fork', parent: { taskId: firstContext.id, revision: firstContext.revision } },
      objective: 'Explicitly excluded Fork', scope: 'Selected subset', createdBy: source.owner, excludedContextIds: [publication.id] })
    const merge = await source.tasks.create({ origin: { kind: 'merge', parents: [
      { taskId: firstContext.id, revision: firstContext.revision }, { taskId: secondContext.id, revision: secondContext.revision },
    ] }, objective: 'Explicitly excluded Merge', scope: 'Selected ordered subset', createdBy: source.owner, excludedContextIds: [publication.id] })
    const replica = await setup('replica-node')
    const restored = await setup('restored-node')
    const blocks = source.tasks.blocks().map(block => developmentTaskContextBlockSchema.parse(JSON.parse(JSON.stringify(block))))
    const entries = source.tasks.log().map(entry => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry))))
    for (const block of blocks) await replica.tasks.acceptContextReplica(block)
    for (const entry of entries) await replica.tasks.acceptLogReplica(entry, entry.nodeId)
    restored.tasks.restoreContextBlocks(blocks)
    restored.tasks.restoreLog(entries)
    for (const current of [replica, restored]) {
      expect(current.tasks.contextView(fork.id).inherited?.sources.map(item => item.context)).toEqual([[]])
      expect(current.tasks.contextView(merge.id).inherited?.sources.map(item => item.parent)).toEqual([
        { taskId: firstContext.id, revision: firstContext.revision }, { taskId: secondContext.id, revision: secondContext.revision },
      ])
      expect(current.tasks.contextView(merge.id).inherited?.sources.map(item => item.context)).toEqual([[], secondContext.context])
    }
  })

  it.each([
    { admission: 'replica', mismatch: 'different-parent' }, { admission: 'replica', mismatch: 'different-revision' },
    { admission: 'restore', mismatch: 'different-parent' }, { admission: 'restore', mismatch: 'different-revision' },
  ] as const)('rejects $admission of a Fork event referencing a valid $mismatch block', async ({ admission, mismatch }) => {
    const source = await setup('source-node')
    const recipient = await setup('recipient-node')
    const first = await source.tasks.create({ origin: { kind: 'root' }, objective: 'Selected parent', scope: 'Selected scope', createdBy: source.owner })
    const second = await source.tasks.create({ origin: { kind: 'root' }, objective: 'Other parent', scope: 'Other scope', createdBy: source.owner })
    const revisedFirst = await source.tasks.publishContext({ taskId: first.id, participantId: source.owner, text: 'Later selected-parent context' })
    const revisedSecond = await source.tasks.publishContext({ taskId: second.id, participantId: source.owner, text: 'Other-parent context' })
    const selected = await source.tasks.create({ origin: { kind: 'fork', parent: { taskId: first.id, revision: first.revision } },
      objective: 'Selected old revision', scope: 'Pinned old history', createdBy: source.owner })
    for (const parent of [revisedFirst, revisedSecond]) {
      await source.tasks.create({ origin: { kind: 'fork', parent: { taskId: parent.id, revision: parent.revision } },
        objective: 'Another valid inherited block', scope: 'Separate selected history', createdBy: source.owner })
    }
    const entry = source.tasks.log().find(item => item.taskId === selected.id)
    const other = mismatch === 'different-parent' ? revisedSecond : revisedFirst
    const block = source.tasks.blocks().find(item => item.sources[0]?.parent.taskId === other.id
      && item.sources[0].parent.revision === other.revision)
    if (entry?.change.kind !== 'task-created' || block === undefined) throw new Error('Generated Fork evidence is missing')
    const previous = source.tasks.log().filter(item => item.seq < entry.seq)
    const wire = developmentTaskEventSchema.parse({ ...entry, change: { ...entry.change, inheritedContextBlockId: block.id } })
    const persisted = vi.fn<(candidate: DevelopmentTaskLogEntry) => void>()
    if (admission === 'restore') {
      recipient.tasks.restoreContextBlocks([block])
      recipient.ctx.on('development-task/persist', persisted)
      expect(() => { recipient.tasks.restoreLog([...previous, wire]) }).toThrow(expect.objectContaining({ code: 'REPLICA_CONFLICT' }))
      expect(persisted).not.toHaveBeenCalled()
      expect(recipient.tasks.log()).toEqual(previous)
    } else {
      await recipient.tasks.acceptContextReplica(block)
      for (const prior of previous) await recipient.tasks.acceptLogReplica(prior, prior.nodeId)
      const retained = recipient.tasks.log()
      recipient.ctx.on('development-task/persist', persisted)
      await expect(recipient.tasks.acceptLogReplica(wire, wire.nodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
      expect(persisted).not.toHaveBeenCalled()
      expect(recipient.tasks.log()).toEqual(retained)
    }
  })
})
