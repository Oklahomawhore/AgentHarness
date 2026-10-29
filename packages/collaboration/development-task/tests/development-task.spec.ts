import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService, {
  type DevelopmentParticipantId,
} from '@deepseek-ai/dsh-development-room'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import DevelopmentTaskService, {
  type Config,
  type DevelopmentTaskAdmitObservedContextRequest,
  type DevelopmentTaskBindingId,
  type DevelopmentTaskAssignmentLogEntry,
  type DevelopmentTaskLogEntry,
  type DevelopmentTaskId,
  type DevelopmentTaskObservedSourceId,
  type DevelopmentTaskArtifactId,
  type DevelopmentTaskArtifactGrantId,
  type DevelopmentTaskOpenApiObservationInput,
  type DevelopmentTaskRevokeObservedArtifactRequest,
  type DevelopmentNodeId,
  type DevelopmentTaskObservedIntervalIdentity,
} from '../src/index.ts'
import { developmentTaskAssignmentEventSchema, developmentTaskContextBlockSchema, developmentTaskEventSchema, openApiObservationInputSchema } from '../src/schema.ts'

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

async function setup(overrides: Partial<Config> = {}, nodeId = 'node-a'): Promise<{
  ctx: Context
  rooms: DevelopmentRoomService
  tasks: DevelopmentTaskService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 64, maxTextBytes: 4096,
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

function artifactObservation(sequence = 1, grant = 'grant-one'): DevelopmentTaskOpenApiObservationInput & { readonly state: 'valid' } {
  return {
    kind: 'openapi-artifact', version: 1, artifactId: 'api-contract' as DevelopmentTaskArtifactId,
    sourceName: 'checkout API', grantId: grant as DevelopmentTaskArtifactGrantId, sequence,
    operation: { method: 'post', path: '/orders' }, state: 'valid', sha256: '1'.repeat(64),
    facts: { operationId: 'createOrder', requestBodyRequired: true, requiredRequestFields: ['name'], responseStatuses: ['200', 'default'], deprecated: false },
  }
}

function revocation(request: DevelopmentTaskAdmitObservedContextRequest, sequence = 2): DevelopmentTaskRevokeObservedArtifactRequest {
  const { state: _state, sha256: _digest, facts: _facts, ...identity } = artifactObservation(sequence)
  return { ...request, sourceId: 'f'.repeat(64) as DevelopmentTaskObservedSourceId, text: 'Artifact grant ended',
    observation: { ...identity, state: 'revoked', reason: 'grant-ended' },
  }
}

async function observationRequest(
  tasks: DevelopmentTaskService,
  taskId: DevelopmentTaskId,
): Promise<DevelopmentTaskAdmitObservedContextRequest> {
  const checked = await tasks.checkout({ taskId, participantId: participant('agent'), bindingId: binding('observed-agent') })
  const bound = tasks.assignmentLog().at(-1)!
  return {
    taskId, participantId: checked.assignment.participantId, bindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: bound.nodeId, seq: bound.seq },
    sourceId: 'a'.repeat(64) as DevelopmentTaskObservedSourceId,
    text: '\n{"kind":"tool-observation","result":"nonce-42"}\n',
  }
}

async function remoteObservationScenario(overrides: Partial<Config> = {}) {
  const owner = await setup(overrides)
  const source = await setup({}, 'node-b')
  const remoteAgent = participant('remote-agent')
  await source.rooms.announce({ id: remoteAgent, kind: 'agent', displayName: 'Remote Agent' })
  const profile = source.rooms.list().participants.find(item => item.id === remoteAgent)!
  await owner.rooms.acceptPresenceReplica(profile, profile.nodeId)
  const task = await owner.tasks.create(rootRequest('Remote observation'))
  await source.tasks.acceptLogReplica(owner.tasks.log()[0]!, 'node-a' as DevelopmentNodeId)
  const checked = await source.tasks.checkout({ taskId: task.id, participantId: remoteAgent,
    bindingId: binding('remote-binding'), sessionLabel: 'Backend API',
  })
  const bound = source.tasks.assignmentLog().at(-1)!
  const identity: DevelopmentTaskObservedIntervalIdentity = {
    taskId: task.id, sourceNodeId: profile.nodeId, participantId: remoteAgent, bindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: bound.nodeId, seq: bound.seq },
  }
  const request = { ...identity, sourceId: 'a'.repeat(64) as DevelopmentTaskObservedSourceId,
    text: 'Remote authorized observation', observation: artifactObservation(),
  }
  return { owner, source, task, identity, request, bound }
}

describe('owner-approved remote observation intervals', () => {
  it('approves an explicit source without requiring its assignment replica and returns original admission receipts', async () => {
    const { owner, identity, request } = await remoteObservationScenario()
    expect(owner.tasks.assignmentLog()).toEqual([])
    const interval = await owner.tasks.approveObservedInterval(identity)
    expect(await owner.tasks.approveObservedInterval(identity)).toEqual(interval)
    const input = { ...request, intervalId: interval.id }
    const [first, second] = await Promise.all([
      owner.tasks.acceptObservedRemote(input, identity.sourceNodeId),
      owner.tasks.acceptObservedRemote(input, identity.sourceNodeId),
    ])
    expect([first.outcome, second.outcome]).toEqual(['published', 'reused'])
    expect(first.receipt).toEqual(second.receipt)
    expect(first.receipt).toMatchObject({ ownerNodeId: 'node-a', revision: 3, event: { nodeId: 'node-a', seq: 3 } })
    expect(first.publication).toMatchObject({ observedIntervalId: interval.id,
      observation: { observerNodeId: 'node-b', binding: { epoch: identity.expectedBindingEpoch } },
    })
    await owner.tasks.publishContext({ taskId: identity.taskId, participantId: participant('owner'), text: 'Later context' })
    const retried = await owner.tasks.acceptObservedRemote(input, identity.sourceNodeId)
    expect(owner.tasks.get({ taskId: identity.taskId }).revision).toBe(4)
    expect(retried.receipt).toEqual(first.receipt)
    await expect(owner.tasks.acceptObservedRemote({ ...input, text: 'Changed' }, identity.sourceNodeId))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(owner.tasks.get({ taskId: identity.taskId }).revision).toBe(4)
  })

  it('discovers only replicated current remote bindings as approval candidates', async () => {
    const { owner, source, identity, bound } = await remoteObservationScenario()
    expect(owner.tasks.observedCandidates({ taskId: identity.taskId })).toEqual([])
    await owner.tasks.acceptAssignmentReplica(bound, identity.sourceNodeId)
    expect(owner.tasks.observedCandidates({ taskId: identity.taskId })).toEqual([{ ...identity, sessionLabel: 'Backend API' }])
    await source.tasks.clear({ bindingId: identity.bindingId, participantId: identity.participantId })
    await owner.tasks.acceptAssignmentReplica(source.tasks.assignmentLog().at(-1)!, identity.sourceNodeId)
    expect(owner.tasks.observedCandidates({ taskId: identity.taskId })).toEqual([])
    await expect(source.tasks.approveObservedInterval(identity)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  })

  it('returns only the admitted publication and receipt as unrelated Task history grows beyond a Mesh frame', async () => {
    const { owner, identity, request } = await remoteObservationScenario({ maxEventsPerTask: 256 })
    const interval = await owner.tasks.approveObservedInterval(identity)
    const input = { ...request, intervalId: interval.id }
    await owner.tasks.acceptObservedRemote(input, identity.sourceNodeId)
    const before = await owner.tasks.acceptObservedRemote(input, identity.sourceNodeId)
    for (let index = 0; index < 200; index++) {
      await owner.tasks.publishContext({ taskId: identity.taskId, participantId: participant('owner'), text: 'x'.repeat(4096) })
    }
    const history = JSON.stringify(owner.tasks.get({ taskId: identity.taskId }))
    expect(Buffer.byteLength(Buffer.from(history).toString('base64url'))).toBeGreaterThan(1_048_576)
    const after = await owner.tasks.acceptObservedRemote(input, identity.sourceNodeId)
    expect(after).toEqual(before)
    expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThan(4096)
    expect(Object.hasOwn(after, 'task')).toBe(false)
  })

  it('rejects the wrong authenticated peer, binding epoch, and unapproved interval without a commit', async () => {
    const { owner, identity, request } = await remoteObservationScenario()
    const interval = await owner.tasks.approveObservedInterval(identity)
    const input = { ...request, intervalId: interval.id }
    await expect(owner.tasks.acceptObservedRemote(input, 'node-c' as DevelopmentNodeId))
      .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    await expect(owner.tasks.acceptObservedRemote({ ...input,
      expectedBindingEpoch: { ...identity.expectedBindingEpoch, seq: 99 },
    }, identity.sourceNodeId))
      .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    await expect(owner.tasks.acceptObservedIntervalEnd(identity, 'node-c' as DevelopmentNodeId))
      .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    expect(owner.tasks.get({ taskId: identity.taskId }).revision).toBe(2)
  })

  it('persists admission before its receipt and atomically ends it before late completions', async () => {
    const { owner, identity, request } = await remoteObservationScenario()
    const interval = await owner.tasks.approveObservedInterval(identity)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    owner.ctx.on('development-task/persist', async (entry) => {
      if (entry.change.kind !== 'context-published') return
      entered.resolve(undefined)
      await release.promise
    })
    const input = { ...request, intervalId: interval.id }
    const admission = owner.tasks.acceptObservedRemote(input, identity.sourceNodeId)
    await entered.promise
    const end = owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)
    try {
      expect(owner.tasks.get({ taskId: identity.taskId }).revision).toBe(2)
    } finally {
      release.resolve(undefined)
    }
    const [admitted, ended] = await Promise.all([admission, end])
    expect(ended.revision).toBe(admitted.receipt.revision + 1)
    const task = owner.tasks.get({ taskId: identity.taskId })
    expect(task.context.map(item => item.observation?.state ?? 'notice')).toEqual(['valid', 'revoked', 'notice'])
    expect(task.context.at(-1)).toMatchObject({ observedIntervalId: interval.id, observedIntervalEnded: true })
    expect((await owner.tasks.acceptObservedRemote(input, identity.sourceNodeId)).receipt).toEqual(admitted.receipt)
    expect(await owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)).toEqual(ended)
    await expect(owner.tasks.acceptObservedRemote({ ...input, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId,
      observation: artifactObservation(2),
    }, identity.sourceNodeId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    expect(owner.tasks.get({ taskId: identity.taskId }).revision).toBe(ended.revision)
  })

  it('retains a terminal tombstone before approval and keeps a new binding epoch independent', async () => {
    const { owner, identity } = await remoteObservationScenario()
    const receipt = await owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)
    await expect(owner.tasks.approveObservedInterval(identity)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    expect(await owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)).toEqual(receipt)
    const next = await owner.tasks.approveObservedInterval({ ...identity,
      expectedBindingEpoch: { ...identity.expectedBindingEpoch, seq: identity.expectedBindingEpoch.seq + 1 },
    })
    expect(next.state).toBe('active')
    expect(next.id).not.toBe(receipt.intervalId)
    expect(await owner.tasks.observedIntervals({ taskId: identity.taskId })).toHaveLength(2)
  })

  it('reserves one terminal event for all remote artifact chains and rejects writes that consume it', async () => {
    const { owner, identity, request } = await remoteObservationScenario({ maxEventsPerTask: 5 })
    const interval = await owner.tasks.approveObservedInterval(identity)
    await owner.tasks.acceptObservedRemote({ ...request, intervalId: interval.id }, identity.sourceNodeId)
    await owner.tasks.acceptObservedRemote({ ...request, intervalId: interval.id, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId,
      observation: artifactObservation(1, 'grant-two'),
    }, identity.sourceNodeId)
    await expect(owner.tasks.publishContext({ taskId: identity.taskId, participantId: participant('owner'), text: 'Exhausted' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    const ended = await owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)
    expect(ended.revision).toBe(5)
    expect(owner.tasks.get({ taskId: identity.taskId }).context.filter(item => item.observation?.state === 'revoked')).toHaveLength(2)
    expect(await owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)).toEqual(ended)
  })

  it('keeps authority and receipts unchanged when opening or ending persistence fails', async () => {
    const { owner, identity, request } = await remoteObservationScenario()
    const failOpen = owner.ctx.on('development-task/persist', () => { throw new Error('disk unavailable') })
    await expect(owner.tasks.approveObservedInterval(identity)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(await owner.tasks.observedIntervals({ taskId: identity.taskId })).toEqual([])
    expect(owner.tasks.get({ taskId: identity.taskId }).revision).toBe(1)
    failOpen()
    const interval = await owner.tasks.approveObservedInterval(identity)
    const admitted = await owner.tasks.acceptObservedRemote({ ...request, intervalId: interval.id }, identity.sourceNodeId)
    const failEnd = owner.ctx.on('development-task/persist', () => { throw new Error('disk unavailable') })
    await expect(owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(await owner.tasks.observedIntervals({ taskId: identity.taskId })).toEqual([interval])
    expect(owner.tasks.get({ taskId: identity.taskId }).context).toEqual([admitted.publication])
    failEnd()
    const ended = await owner.tasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)
    expect(ended.revision).toBe(4)
    expect((await owner.tasks.observedIntervals({ taskId: identity.taskId }))[0]?.state).toBe('ended')
  })
})

describe('DevelopmentTaskService', () => {
  it.each([1, 64, 250])('defaults Task catalog reads within the configured %i result limit', async (maxLineageTasks) => {
    const { tasks } = await setup({ maxLineageTasks })
    const first = await tasks.create(rootRequest('Catalog first'))
    await tasks.create(rootRequest('Catalog second'))
    await tasks.create(rootRequest('Catalog third'))
    expect(tasks.list({})).toHaveLength(Math.min(3, maxLineageTasks))
    expect(tasks.list({ limit: 1 })).toHaveLength(1)
    expect(tasks.lineage({ taskId: first.id }).tasks).toEqual([first])
    expect(() => tasks.list({ limit: maxLineageTasks + 1 })).toThrow('limit must be between')
    expect(() => tasks.lineage({ taskId: first.id, limit: maxLineageTasks + 1 })).toThrow('limit must be between')
  })

  it('admits typed artifact evidence without promoting publication text that copies its JSON', async () => {
    const { tasks } = await setup()
    const task = await tasks.create(rootRequest('Artifact admission'))
    const request = { ...await observationRequest(tasks, task.id), observation: artifactObservation() }
    const admitted = await tasks.admitObservedContext(request)
    expect(admitted.publication.observation).toMatchObject({
      ...request.observation, sourceId: request.sourceId, observerNodeId: 'node-a',
      binding: { id: request.bindingId, epoch: request.expectedBindingEpoch },
    })
    const observation = admitted.publication.observation!
    expect(Object.isFrozen(observation)).toBe(true)
    expect(Object.isFrozen(observation.binding.epoch)).toBe(true)
    expect(Object.isFrozen(observation.operation)).toBe(true)
    if (observation.state !== 'valid') throw new Error('expected a valid artifact')
    expect(Object.isFrozen(observation.facts.requiredRequestFields)).toBe(true)
    const manual = await tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: JSON.stringify(observation) })
    expect(manual.context.at(-1)?.observation).toBeUndefined()
  })

  it('compares all artifact evidence before deduplication and rejects older new sources', async () => {
    const { tasks } = await setup()
    const task = await tasks.create(rootRequest('Artifact sequence'))
    const request = { ...await observationRequest(tasks, task.id), observation: artifactObservation() }
    await tasks.admitObservedContext(request)
    await expect(tasks.admitObservedContext({ ...request, observation: { ...request.observation, sha256: '2'.repeat(64) } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const next = { ...request, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId, observation: artifactObservation(3) }
    await tasks.admitObservedContext(next)
    await expect(tasks.admitObservedContext(request)).resolves.toMatchObject({ outcome: 'reused' })
    await expect(tasks.admitObservedContext({ ...request, sourceId: 'c'.repeat(64) as DevelopmentTaskObservedSourceId, observation: artifactObservation(2) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(tasks.admitObservedContext({ ...next, sourceId: 'c'.repeat(64) as DevelopmentTaskObservedSourceId,
      observation: { ...artifactObservation(4), operation: { method: 'post', path: '/changed' } },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await tasks.revokeObservedArtifact(revocation(request, 4))
    await expect(tasks.admitObservedContext(request)).resolves.toMatchObject({ outcome: 'reused' })
    await expect(tasks.admitObservedContext({ ...next, sourceId: 'd'.repeat(64) as DevelopmentTaskObservedSourceId, observation: artifactObservation(5) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('uses the reserved event to revoke after clear and participant departure', async () => {
    const { tasks, rooms } = await setup({ maxEventsPerTask: 3 })
    const task = await tasks.create(rootRequest('Reserved revocation'))
    const request = { ...await observationRequest(tasks, task.id), observation: artifactObservation() }
    await tasks.admitObservedContext(request)
    await expect(tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'would consume reserve' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await tasks.clear(request)
    await rooms.withdraw({ participantId: participant('agent') })
    await expect(tasks.admitObservedContext({ ...request, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId, observation: artifactObservation(2) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const revoke = revocation(request)
    await expect(tasks.revokeObservedArtifact({ ...revoke, expectedBindingEpoch: { ...revoke.expectedBindingEpoch, seq: 999 } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(tasks.revokeObservedArtifact({ ...revoke, participantId: participant('unknown') }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const ended = await tasks.revokeObservedArtifact(revoke)
    expect(ended.task.revision).toBe(3)
    expect(ended.publication.observation?.state).toBe('revoked')
    await expect(tasks.revokeObservedArtifact(revoke)).resolves.toMatchObject({ outcome: 'reused', publication: ended.publication })
    await expect(tasks.revokeObservedArtifact({ ...revoke, observation: { ...revoke.observation, sequence: 3 } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'past the hard limit' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('reserves one independent revocation per active grant and requires prior evidence', async () => {
    const { tasks } = await setup({ maxEventsPerTask: 5 })
    const task = await tasks.create(rootRequest('Independent reserves'))
    const request = { ...await observationRequest(tasks, task.id), observation: artifactObservation() }
    await expect(tasks.revokeObservedArtifact(revocation(request))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await tasks.admitObservedContext(request)
    const second = { ...request, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId, observation: artifactObservation(1, 'grant-two') }
    await tasks.admitObservedContext(second)
    await expect(tasks.admitObservedContext({ ...request, sourceId: 'c'.repeat(64) as DevelopmentTaskObservedSourceId, observation: artifactObservation(2) }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await tasks.revokeObservedArtifact(revocation(request))
    const revokeSecond = revocation(second)
    await tasks.revokeObservedArtifact({ ...revokeSecond, sourceId: 'e'.repeat(64) as DevelopmentTaskObservedSourceId,
      observation: { ...revokeSecond.observation, grantId: second.observation.grantId },
    })
    expect(tasks.get({ taskId: task.id }).revision).toBe(5)
  })

  it('preserves artifact evidence and reserved capacity across durable restore and inheritance', async () => {
    const first = await setup({ maxEventsPerTask: 3 })
    const task = await first.tasks.create(rootRequest('Restored artifact'))
    const request = { ...await observationRequest(first.tasks, task.id), observation: artifactObservation() }
    const admitted = await first.tasks.admitObservedContext(request)
    const fork = await first.tasks.create({ ...rootRequest('Inherited artifact'), origin: { kind: 'fork', parent: { taskId: task.id, revision: 2 } } })
    const blocks = first.tasks.blocks().map(block => developmentTaskContextBlockSchema.parse(JSON.parse(JSON.stringify(block))))
    const logs = first.tasks.log().map(entry => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry))))
    const assignments = first.tasks.assignmentLog()
      .map(entry => developmentTaskAssignmentEventSchema.parse(JSON.parse(JSON.stringify(entry))))
    const restored = await setup({ maxEventsPerTask: 3 })
    restored.tasks.restoreContextBlocks(blocks)
    restored.tasks.restoreLog(logs)
    restored.tasks.restoreAssignmentLog(assignments)
    expect(restored.tasks.contextView(fork.id).inherited?.sources[0]?.context[0]).toEqual(admitted.publication)
    expect(JSON.stringify(restored.tasks.blocks())).toBe(JSON.stringify(blocks))
    const observation = restored.tasks.get({ taskId: task.id }).context[0]?.observation
    expect(Object.isFrozen(observation?.binding.epoch)).toBe(true)
    await expect(restored.tasks.admitObservedContext(request)).resolves.toMatchObject({ outcome: 'reused' })
    await restored.tasks.clear(request)
    await expect(restored.tasks.revokeObservedArtifact(revocation(request))).resolves.toMatchObject({ task: { revision: 3 } })
    const block = structuredClone(blocks[0]!)
    const publication = block.sources[0]!.context[0]!
    if (publication.peerContribution !== undefined || publication.localContribution !== undefined
      || publication.observation?.state !== 'valid') {
      throw new Error('expected inherited local artifact')
    }
    const corrupted = { ...block, sources: [{ ...block.sources[0]!, context: [{ ...publication,
      observation: { ...publication.observation, sha256: '2'.repeat(64) },
    }] }] }
    expect(() => { restored.tasks.restoreContextBlocks([corrupted]) }).toThrow('digest')
  })

  it('bounds complete observation JSON and rejects unsupported durable metadata', async () => {
    const { tasks } = await setup()
    const task = await tasks.create(rootRequest('Artifact validation'))
    const request = { ...await observationRequest(tasks, task.id), observation: artifactObservation() }
    await expect(tasks.admitObservedContext({ ...request, observation: { ...request.observation, sourceName: '界'.repeat(1400) } }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(openApiObservationInputSchema.safeParse({ ...request.observation, version: 2 }).success).toBe(false)
    expect(openApiObservationInputSchema.safeParse({ ...request.observation, observerNodeId: 'forged' }).success).toBe(false)
    const admitted = await tasks.admitObservedContext(request)
    const entry = tasks.log().at(-1)!
    expect(developmentTaskEventSchema.safeParse({ ...entry, change: { kind: 'context-published', publication: {
      ...admitted.publication, observation: { ...admitted.publication.observation, arbitrary: true },
    } } }).success).toBe(false)
  })

  it('refuses a restored local grant when reduced capacity would remove its revocation reservation', async () => {
    const first = await setup({ maxEventsPerTask: 3 })
    const task = await first.tasks.create(rootRequest('Restored capacity'))
    const request = { ...await observationRequest(first.tasks, task.id), observation: artifactObservation() }
    await first.tasks.admitObservedContext(request)
    const saved = JSON.stringify(first.tasks.log())
    const entries = (JSON.parse(saved) as unknown[]).map(entry => developmentTaskEventSchema.parse(entry))
    const restored = await setup({ maxEventsPerTask: 2 })
    let writes = 0
    restored.ctx.on('development-task/persist', () => { writes++ })
    expect(() => { restored.tasks.restoreLog(entries) }).toThrow('cannot cover restored artifact revocations')
    expect(writes).toBe(0)
    expect(JSON.stringify(entries)).toBe(saved)
    const sufficient = await setup({ maxEventsPerTask: 3 })
    sufficient.tasks.restoreLog(entries)
    await expect(sufficient.tasks.revokeObservedArtifact(revocation(request))).resolves.toMatchObject({ task: { revision: 3 } })
  })

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

  it.each([10, 1])('selects the last retained binding by durable order when the later clock reads %s', async (laterTime) => {
    const { tasks } = await setup()
    const first = await tasks.create(rootRequest('First retained responsibility'))
    const second = await tasks.create(rootRequest('Latest retained responsibility'))
    const agent = participant('agent')
    expect(tasks.latestAssignment(agent)).toBeUndefined()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10)
    let older: Awaited<ReturnType<typeof tasks.checkout>>
    let newer: Awaited<ReturnType<typeof tasks.checkout>>
    try {
      older = await tasks.checkout({ taskId: first.id, participantId: agent, bindingId: binding('z-older') })
      clock.mockReturnValue(laterTime)
      newer = await tasks.checkout({ taskId: second.id, participantId: agent, bindingId: binding('a-newer') })
    } finally { clock.mockRestore() }
    await tasks.acknowledge({ bindingId: older.assignment.bindingId, participantId: agent,
      taskId: first.id, revision: first.revision })
    expect(tasks.latestAssignment(agent)).toEqual(newer.assignment)
    expect(tasks.latestAssignment(participant('owner'))).toBeUndefined()
    const restored = await setup()
    restored.tasks.restoreLog(tasks.log())
    restored.tasks.restoreAssignmentLog(tasks.assignmentLog())
    expect(restored.tasks.latestAssignment(agent)).toEqual(newer.assignment)
    await restored.tasks.clear({ bindingId: newer.assignment.bindingId, participantId: agent })
    expect(restored.tasks.latestAssignment(agent)).toMatchObject({ bindingId: older.assignment.bindingId, acknowledgedRevision: 1 })
    await restored.tasks.clear({ bindingId: older.assignment.bindingId, participantId: agent })
    expect(restored.tasks.latestAssignment(agent)).toBeUndefined()
  })

  it('selects only retained bindings still owned by the participant after a cleared binding id is reused', async () => {
    const { tasks, rooms } = await setup()
    const agent = participant('agent')
    const other = participant('another-agent')
    await rooms.announce({ id: other, kind: 'agent', displayName: 'Another Agent' })
    const first = await tasks.create(rootRequest('Retained original responsibility'))
    const second = await tasks.create(rootRequest('Another participant responsibility'))
    const retained = await tasks.checkout({ taskId: first.id, participantId: agent, bindingId: binding('retained') })
    const reusedId = binding('reused')
    await tasks.checkout({ taskId: second.id, participantId: agent, bindingId: reusedId })
    await expect(tasks.checkout({ taskId: second.id, participantId: other, bindingId: reusedId }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(tasks.clear({ bindingId: reusedId, participantId: other })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await tasks.clear({ bindingId: reusedId, participantId: agent })
    const reused = await tasks.checkout({ taskId: second.id, participantId: other, bindingId: reusedId })
    const restored = await setup()
    await restored.rooms.announce({ id: other, kind: 'agent', displayName: 'Another Agent' })
    restored.tasks.restoreLog(tasks.log())
    restored.tasks.restoreAssignmentLog(tasks.assignmentLog())
    for (const current of [tasks, restored.tasks]) {
      expect(current.latestAssignment(agent)).toEqual(retained.assignment)
      expect(current.latestAssignment(other)).toEqual(reused.assignment)
      expect(Object.isFrozen(current.latestAssignment(agent))).toBe(true)
      await current.clear({ bindingId: retained.assignment.bindingId, participantId: agent })
      expect(current.latestAssignment(agent)).toBeUndefined()
      expect(current.latestAssignment(other)).toEqual(reused.assignment)
    }
  })

  it('treats rebinding an existing session as newer than other retained sessions without letting acknowledgements reorder it', async () => {
    const { tasks } = await setup()
    const first = await tasks.create(rootRequest('First responsibility'))
    const second = await tasks.create(rootRequest('Other session responsibility'))
    const agent = participant('agent')
    const original = await tasks.checkout({ taskId: first.id, participantId: agent, bindingId: binding('original') })
    const other = await tasks.checkout({ taskId: second.id, participantId: agent, bindingId: binding('other') })
    const rebound = await tasks.checkout({ taskId: second.id, participantId: agent, bindingId: original.assignment.bindingId })
    await tasks.acknowledge({ bindingId: other.assignment.bindingId, participantId: agent, taskId: second.id, revision: second.revision })
    expect(tasks.latestAssignment(agent)).toEqual(rebound.assignment)
    const restored = await setup()
    restored.tasks.restoreLog(tasks.log())
    restored.tasks.restoreAssignmentLog(tasks.assignmentLog())
    expect(restored.tasks.latestAssignment(agent)).toEqual(rebound.assignment)
  })

  it('keeps the prior latest assignment when persistence rejects a new binding', async () => {
    const { ctx, tasks } = await setup()
    const first = await tasks.create(rootRequest('Confirmed responsibility'))
    const second = await tasks.create(rootRequest('Unconfirmed responsibility'))
    const agent = participant('agent')
    const retained = await tasks.checkout({ taskId: first.id, participantId: agent, bindingId: binding('confirmed') })
    const before = tasks.assignmentLog()
    ctx.on('development-task/assignment-persist', () => { throw new Error('persistence unavailable') })
    await expect(tasks.checkout({ taskId: second.id, participantId: agent, bindingId: binding('unconfirmed') }))
      .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(tasks.assignmentLog()).toEqual(before)
    expect(tasks.latestAssignment(agent)).toEqual(retained.assignment)
  })

  it('keeps latest selection Host-only while assignment Remotes update the same retained state', async () => {
    const { ctx, tasks } = await setup()
    const remote = ctx.developmentTaskAssignments
    expect(remoteMethods(tasks).some(method => method.method === 'latestAssignment')).toBe(false)
    expect(remoteMethods(remote).map(method => method.method)).toEqual(['list', 'checkout', 'clear', 'acknowledge'])
    const created = await tasks.createRemote(rootRequest('Remote responsibility'))
    const agent = participant('agent')
    const checked = await remote.checkout({ taskId: created.task.id, participantId: agent })
    const acknowledged = await remote.acknowledge({
      bindingId: checked.assignment.bindingId, participantId: agent, taskId: created.task.id, revision: created.task.revision,
    })
    expect(remote.list()).toEqual([acknowledged])
    expect(tasks.latestAssignment(agent)).toEqual(acknowledged)
    expect(tasks.context({ taskId: created.task.id }).task.id).toBe(created.task.id)
    await remote.clear({ bindingId: checked.assignment.bindingId, participantId: agent })
    expect(remote.list()).toEqual([])
    expect(tasks.latestAssignment(agent)).toBeUndefined()
  })

  it('restores reversed durable events and rejects logs missing their first dependency', async () => {
    const { tasks } = await setup()
    const task = await tasks.create(rootRequest('Restored dependency order'))
    await tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'Durable context' })
    const agent = participant('agent')
    const checked = await tasks.checkout({ taskId: task.id, participantId: agent })
    await tasks.acknowledge({ bindingId: checked.assignment.bindingId, participantId: agent, taskId: task.id, revision: 2 })
    const logs = tasks.log().map(entry => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry))))
    const assignments = tasks.assignmentLog().map(entry => developmentTaskAssignmentEventSchema.parse(JSON.parse(JSON.stringify(entry))))
    const restored = await setup()
    restored.tasks.restoreLog([...logs].reverse())
    restored.tasks.restoreAssignmentLog([...assignments].reverse())
    expect(restored.tasks.log()).toEqual(logs)
    expect(restored.tasks.assignmentLog()).toEqual(assignments)
    expect(restored.tasks.latestAssignment(agent)).toEqual(tasks.latestAssignment(agent))
    const missingTask = await setup()
    expect(() => { missingTask.tasks.restoreLog(logs.slice(1)) }).toThrow('unresolved lineage or sequence dependencies')
    expect(missingTask.tasks.log()).toEqual([])
    const missingBinding = await setup()
    missingBinding.tasks.restoreLog(logs)
    expect(() => { missingBinding.tasks.restoreAssignmentLog(assignments.slice(1)) }).toThrow('sequence gap')
    expect(missingBinding.tasks.assignmentLog()).toEqual([])
    expect(missingBinding.tasks.latestAssignment(agent)).toBeUndefined()
  })

  it('rejects delayed acknowledgements before persistence and leaves the next durable assignment restorable', async () => {
    const { ctx, tasks } = await setup()
    const task = await tasks.create(rootRequest('Acknowledgement ordering'))
    await tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'Second revision' })
    const checked = await tasks.checkout({ taskId: task.id, participantId: participant('agent') })
    const request = { bindingId: checked.assignment.bindingId, participantId: checked.assignment.participantId, taskId: task.id }
    await tasks.acknowledge({ ...request, revision: 2 })
    const retained = tasks.assignmentLog()
    const persisted = vi.fn<(entry: DevelopmentTaskAssignmentLogEntry) => void>()
    ctx.on('development-task/assignment-persist', persisted)

    await expect(tasks.acknowledge({ ...request, revision: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(persisted).not.toHaveBeenCalled()
    expect(tasks.assignmentLog()).toEqual(retained)
    const latest = await tasks.acknowledge({ ...request, revision: 2 })
    expect(persisted).toHaveBeenCalledOnce()
    const restored = await setup()
    restored.tasks.restoreLog(tasks.log())
    restored.tasks.restoreAssignmentLog([...retained, ...persisted.mock.calls.map(([entry]) => entry)])
    expect(restored.tasks.assignmentList()).toEqual([latest])
  })

  it.each(['regression', 'gap', 'conflicting-duplicate'] as const)('rejects replicated assignment %s before persistence', async (failure) => {
    const { owner, source, task, bound } = await remoteObservationScenario()
    const sourceNodeId = 'node-b' as DevelopmentNodeId
    await owner.tasks.acceptAssignmentReplica(bound, sourceNodeId)
    await owner.tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'Revision two' })
    await source.tasks.acceptLogReplica(owner.tasks.log().at(-1)!, 'node-a' as DevelopmentNodeId)
    const request = { taskId: task.id, bindingId: bound.bindingId, participantId: bound.participantId, revision: 2 }
    await source.tasks.acknowledge(request)
    const acknowledged = source.tasks.assignmentLog().at(-1)!
    await owner.tasks.acceptAssignmentReplica(acknowledged, sourceNodeId)
    const persisted = vi.fn<(entry: DevelopmentTaskAssignmentLogEntry) => void>()
    owner.ctx.on('development-task/assignment-persist', persisted)
    const invalid = { ...acknowledged,
      seq: acknowledged.seq + (failure === 'gap' ? 2 : failure === 'regression' ? 1 : 0),
      change: { kind: 'context-acknowledged' as const, taskId: task.id, revision: 1 } }
    await expect(owner.tasks.acceptAssignmentReplica(invalid, sourceNodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).not.toHaveBeenCalled()
    const valid = await source.tasks.acknowledge(request)
    await expect(owner.tasks.acceptAssignmentReplica(source.tasks.assignmentLog().at(-1)!, sourceNodeId)).resolves.toEqual(valid)
    expect(persisted).toHaveBeenCalledOnce()
  })

  it('rejects a conflicting duplicate Task replica before persistence and keeps later events restorable', async () => {
    const owner = await setup({}, 'node-a')
    const replica = await setup({}, 'node-b')
    const task = await owner.tasks.create(rootRequest('Replica identity'))
    const ownerNodeId = 'node-a' as DevelopmentNodeId
    await replica.tasks.acceptLogReplica(owner.tasks.log()[0]!, ownerNodeId)
    await owner.tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'Original publication' })
    const published = owner.tasks.log().at(-1)!
    await replica.tasks.acceptLogReplica(published, ownerNodeId)
    if (published.change.kind !== 'context-published') throw new Error('Expected a context publication')
    const conflict: DevelopmentTaskLogEntry = { ...published, change: { ...published.change,
      publication: { ...published.change.publication, text: 'Conflicting publication' } } }
    const retained = replica.tasks.log()
    const persisted = vi.fn<(entry: DevelopmentTaskLogEntry) => void>()
    replica.ctx.on('development-task/persist', persisted)

    await expect(replica.tasks.acceptLogReplica(conflict, ownerNodeId)).rejects.toMatchObject({ code: 'REPLICA_CONFLICT' })
    expect(persisted).not.toHaveBeenCalled()
    expect(replica.tasks.log()).toEqual(retained)
    await owner.tasks.publishContext({ taskId: task.id, participantId: participant('owner'), text: 'Later publication' })
    const latest = await replica.tasks.acceptLogReplica(owner.tasks.log().at(-1)!, ownerNodeId)
    expect(persisted).toHaveBeenCalledOnce()
    const restored = await setup({}, 'node-b')
    restored.tasks.restoreLog([...retained, ...persisted.mock.calls.map(([entry]) => entry)])
    expect(restored.tasks.get({ taskId: task.id })).toEqual(latest)
  })

  it('reuses committed assignment replicas without persisting or notifying again after acknowledgement and clear', async () => {
    const { owner, source, task, bound } = await remoteObservationScenario()
    const sourceNodeId = source.rooms.list().nodeId
    await owner.tasks.acceptAssignmentReplica(bound, sourceNodeId)
    const acknowledged = await source.tasks.acknowledge({ taskId: task.id, participantId: bound.participantId,
      bindingId: bound.bindingId, revision: task.revision })
    await owner.tasks.acceptAssignmentReplica(source.tasks.assignmentLog().at(-1)!, sourceNodeId)
    const changed = vi.fn()
    owner.ctx.on('development-task/assignment-changed', changed)
    const persisted = vi.fn(() => { throw new Error('No duplicate assignment write is allowed') })
    const stop = owner.ctx.on('development-task/assignment-persist', persisted)
    await expect(owner.tasks.acceptAssignmentReplica(bound, sourceNodeId)).resolves.toEqual(acknowledged)
    expect(persisted).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    stop()

    await source.tasks.clear({ participantId: bound.participantId, bindingId: bound.bindingId })
    await owner.tasks.acceptAssignmentReplica(source.tasks.assignmentLog().at(-1)!, sourceNodeId)
    changed.mockClear()
    owner.ctx.on('development-task/assignment-persist', persisted)
    const retained = owner.tasks.assignmentLog()
    await expect(owner.tasks.acceptAssignmentReplica(bound, sourceNodeId)).resolves.toBeUndefined()
    expect(persisted).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(owner.tasks.assignmentLog()).toEqual(retained)
    expect(owner.tasks.assignmentList()).toEqual([])
  })

  it('keeps different sessions of the same Agent independently bound', async () => {
    const { ctx, rooms, tasks } = await setup()
    const assignmentChanged = vi.fn()
    ctx.on('development-task/assignment-changed', assignmentChanged)
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
    expect(assignmentChanged).toHaveBeenLastCalledWith(null,
      expect.objectContaining({ bindingId: firstSession.assignment.bindingId, change: { kind: 'task-cleared', previousTaskId: first.id } }),
      { kind: 'local', nodeId: 'node-a' })
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

  it.each(['failed retry', 'disposal'] as const)('owns one blocked hidden Room repair across %s', async (mode) => {
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    vi.useFakeTimers()
    try {
      const { ctx, rooms, tasks } = await setup({ roomRetryIntervalMs: 10 })
      const ensure = vi.spyOn(rooms, 'ensure')
      let attempts = 0
      ctx.on('development-room/persist', async (entry) => {
        if (entry.change.kind !== 'room-created') return
        attempts++
        if (attempts === 1) throw new Error('initial Room write unavailable')
        if (attempts === 2) {
          entered.resolve(undefined)
          await gate.promise
          if (mode === 'failed retry') throw new Error('background Room write unavailable')
        }
      })
      const task = await tasks.create(rootRequest('One background repair'))
      expect(task.runtime).toBe('degraded')
      await vi.advanceTimersByTimeAsync(10)
      await entered.promise
      await vi.advanceTimersByTimeAsync(50)
      expect(attempts).toBe(2)
      expect(ensure).toHaveBeenCalledTimes(2)
      if (mode === 'failed retry') {
        gate.resolve(undefined)
        await vi.advanceTimersByTimeAsync(10)
        expect(attempts).toBe(3)
        expect(ensure).toHaveBeenCalledTimes(3)
        expect(tasks.get({ taskId: task.id }).runtime).toBe('ready')
      } else {
        let disposed = false
        const closing = ctx.fiber.dispose().then(() => { disposed = true })
        await vi.advanceTimersByTimeAsync(50)
        expect(disposed).toBe(false)
        expect(attempts).toBe(2)
        gate.resolve(undefined)
        await closing
        await vi.advanceTimersByTimeAsync(100)
        expect(attempts).toBe(2)
        expect(rooms.log().filter(entry => entry.change.kind === 'room-created')).toHaveLength(1)
      }
    } finally {
      gate.resolve(undefined)
      try {
        await vi.advanceTimersByTimeAsync(0)
        await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
      } finally { vi.restoreAllMocks(); vi.useRealTimers() }
    }
  })
})

describe('observed Task context admission', () => {
  it('commits concurrent retries once and returns the original normalized publication', async () => {
    const { ctx, tasks } = await setup()
    const task = await tasks.create(rootRequest('Observed edits'))
    const request = await observationRequest(tasks, task.id)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let persisted = 0
    ctx.on('development-task/persist', async (entry) => {
      if (entry.change.kind !== 'context-published') return
      persisted++
      started.resolve(undefined)
      await release.promise
    })
    const first = tasks.admitObservedContext(request)
    await started.promise
    const duplicate = tasks.admitObservedContext({ ...request, text: request.text.trim() })
    expect(tasks.get({ taskId: task.id }).context).toEqual([])
    release.resolve(undefined)
    const results = await Promise.all([first, duplicate])
    expect(persisted).toBe(1)
    expect(results[1].publication).toEqual(results[0].publication)
    expect(tasks.log()).toHaveLength(2)
    await expect(JSON.stringify({
      outcomes: results.map(result => result.outcome),
      revision: results[1].task.revision,
      publication: {
        id: results[1].publication.id,
        text: results[1].publication.text,
        publishedBy: results[1].publication.publishedBy,
      },
    }, null, 2) + '\n').toMatchFileSnapshot(fileURLToPath(new URL('./expected/observed-context.json', import.meta.url)))
  })

  it('rejects conflicting source text and preserves distinct observations with equal text', async () => {
    const { tasks } = await setup()
    const task = await tasks.create(rootRequest('Source identities'))
    const request = await observationRequest(tasks, task.id)
    const first = await tasks.admitObservedContext(request)
    await expect(tasks.admitObservedContext({ ...request, text: 'different result' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(tasks.get({ taskId: task.id }).context).toEqual([first.publication])
    const distinct = await tasks.admitObservedContext({ ...request, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId })
    expect(distinct.outcome).toBe('published')
    expect(distinct.task.context).toHaveLength(2)
    expect(distinct.publication.id).not.toBe(first.publication.id)
    expect(distinct.publication.text).toBe(first.publication.text)
  })

  it('rejects reuse of a source by a different currently bound publisher', async () => {
    const { rooms, tasks } = await setup()
    const task = await tasks.create(rootRequest('Source publisher'))
    const request = await observationRequest(tasks, task.id)
    await tasks.admitObservedContext(request)
    const other = participant('other-agent')
    await rooms.announce({ id: other, kind: 'agent', displayName: 'Other' })
    const checked = await tasks.checkout({ taskId: task.id, participantId: other })
    const bound = tasks.assignmentLog().at(-1)!
    await expect(tasks.admitObservedContext({
      ...request, participantId: other, bindingId: checked.assignment.bindingId,
      expectedBindingEpoch: { nodeId: bound.nodeId, seq: bound.seq },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(tasks.get({ taskId: task.id }).context).toHaveLength(1)
  })

  it('checks the binding epoch inside the queue before reusing an A-to-B-to-A observation', async () => {
    const { ctx, tasks } = await setup()
    const a = await tasks.create(rootRequest('Scope A'))
    const b = await tasks.create(rootRequest('Scope B'))
    const request = await observationRequest(tasks, a.id)
    await tasks.admitObservedContext(request)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('development-task/assignment-persist', async (entry) => {
      if (entry.change.kind !== 'task-bound' || entry.change.taskId !== b.id) return
      started.resolve(undefined)
      await release.promise
    })
    const changing = tasks.checkout({ ...request, taskId: b.id })
    await started.promise
    const returning = tasks.checkout(request)
    const stale = expect(tasks.admitObservedContext(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    release.resolve(undefined)
    await Promise.all([changing, returning, stale])
    expect(tasks.get({ taskId: a.id }).context).toHaveLength(1)
    expect(tasks.get({ taskId: b.id }).context).toEqual([])
    const latest = tasks.assignmentLog().at(-1)!
    await expect(tasks.admitObservedContext({
      ...request, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId,
      expectedBindingEpoch: { nodeId: latest.nodeId, seq: latest.seq },
    })).resolves.toMatchObject({ outcome: 'published', task: { revision: 3 } })
  })

  it('refuses disconnected, mismatched, and unavailable participants before publishing', async () => {
    const { tasks } = await setup()
    const task = await tasks.create(rootRequest('Binding authority'))
    const other = await tasks.create(rootRequest('Other Task'))
    const request = await observationRequest(tasks, task.id)
    await expect(tasks.admitObservedContext({ ...request, taskId: other.id }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(tasks.admitObservedContext({ ...request, bindingId: binding('missing-binding') }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    for (const id of ['owner', 'missing-agent']) {
      await expect(tasks.admitObservedContext({ ...request, participantId: participant(id) }))
        .rejects.toMatchObject({ code: 'PARTICIPANT_NOT_AVAILABLE' })
    }
    const leaving = tasks.clear(request)
    const late = expect(tasks.admitObservedContext(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await Promise.all([leaving, late])
    expect(tasks.get({ taskId: task.id }).context).toEqual([])
  })

  it('refuses nonlocal Task ownership without forwarding the observation', async () => {
    const remote = await setup({}, 'node-b')
    const task = await remote.tasks.create(rootRequest('Remote Task'))
    const local = await setup()
    local.tasks.restoreLog(remote.tasks.log())
    const request = await observationRequest(local.tasks, task.id)
    await expect(local.tasks.admitObservedContext(request)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    expect(local.tasks.get({ taskId: task.id }).context).toEqual([])
  })

  it('restores source deduplication from persisted Task and binding events', async () => {
    const first = await setup()
    const task = await first.tasks.create(rootRequest('Restored observations'))
    const request = await observationRequest(first.tasks, task.id)
    const admitted = await first.tasks.admitObservedContext(request)
    const events = JSON.parse(JSON.stringify(first.tasks.log())) as unknown[]
    const assignments = JSON.parse(JSON.stringify(first.tasks.assignmentLog())) as unknown[]
    await first.ctx.fiber.dispose()
    const restored = await setup()
    restored.tasks.restoreLog(events.map(entry => developmentTaskEventSchema.parse(entry)))
    restored.tasks.restoreAssignmentLog(assignments.map(entry => developmentTaskAssignmentEventSchema.parse(entry)))
    let persisted = 0
    restored.ctx.on('development-task/persist', () => { persisted++ })
    const retried = await restored.tasks.admitObservedContext(request)
    expect(retried.outcome).toBe('reused')
    expect(retried.publication).toEqual(admitted.publication)
    expect(retried.task.revision).toBe(admitted.task.revision)
    expect(persisted).toBe(0)
    await expect(restored.tasks.admitObservedContext({ ...request, text: 'conflicting replay' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not consume a source identity when persistence fails', async () => {
    const { ctx, tasks } = await setup()
    const task = await tasks.create(rootRequest('Retry persistence'))
    const request = await observationRequest(tasks, task.id)
    const stopFailing = ctx.on('development-task/persist', () => { throw new Error('storage unavailable') })
    await expect(tasks.admitObservedContext(request)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(tasks.get({ taskId: task.id }).context).toEqual([])
    stopFailing()
    await expect(tasks.admitObservedContext(request)).resolves.toMatchObject({ outcome: 'published', task: { revision: 2 } })
  })

  it('validates source digests and publication bounds while allowing reuse at the event limit', async () => {
    const { tasks } = await setup({ maxEventsPerTask: 2 })
    const task = await tasks.create(rootRequest('Bounds'))
    const request = await observationRequest(tasks, task.id)
    for (const id of ['', 'A'.repeat(64), '0'.repeat(63), 'g'.repeat(64)]) {
      await expect(tasks.admitObservedContext({ ...request, sourceId: id as DevelopmentTaskObservedSourceId }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(tasks.admitObservedContext({ ...request, text: ' \n ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(tasks.admitObservedContext({ ...request, text: '🚀'.repeat(1025) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    const exact = await tasks.admitObservedContext({ ...request, text: '🚀'.repeat(1024) })
    expect(Buffer.byteLength(exact.publication.text)).toBe(4096)
    await expect(tasks.admitObservedContext({ ...request, text: exact.publication.text })).resolves.toMatchObject({ outcome: 'reused' })
    await expect(tasks.admitObservedContext({ ...request, sourceId: 'b'.repeat(64) as DevelopmentTaskObservedSourceId }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(tasks.get({ taskId: task.id }).context).toEqual([exact.publication])
  })
})
