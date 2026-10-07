import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { afterEach, expect, it, vi } from 'vitest'
import DevelopmentTaskService, { peerContributionArtifactId, peerContributionPayloadDigest, peerContributionPublicationId } from '../src/index.ts'
import type { Config, DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContributionRequest, DevelopmentTaskId,
  DevelopmentTaskContributionGrantId, DevelopmentTaskContributionGeneration, DevelopmentTaskCaptureId,
  DevelopmentTaskCaptureGeneration, DevelopmentTaskObservedSourceId } from '../src/index.ts'
import { developmentTaskContextBlockSchema, developmentTaskEventSchema, peerContributionAdmissionReceiptSchema,
  peerContributionStateSchema, toolObservationResultSchema, completedFileToolObservationResultSchema,
  recordedToolObservationResultSchema, legacyPeerContributionSampleSchema, recordedPeerContributionSampleSchema, localContributionSampleSchema } from '../src/schema.ts'
import { peerPublication, peerPublicationRequest } from '../src/peer.ts'

const contexts: Context[] = []
const owner = 'owner-peer' as ScopePeerId
const source = 'source-peer' as ScopePeerId
const human = 'owner-human' as DevelopmentParticipantId
const config: Config = { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
  maxContextBlockBytes: 32768, maxLineageTasks: 32, maxTextBytes: 4096, roomRetryIntervalMs: 10000 }

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

async function setup(overrides: Partial<Config> = {}, nodeId = 'task-owner') {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId, presenceTtlMs: 10000, maxParticipants: 8, maxRooms: 32, maxTextBytes: 4096 })
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  const tasks = new DevelopmentTaskService(ctx, { ...config, ...overrides })
  return { ctx, rooms, tasks }
}

async function scenario(overrides: Partial<Config> = {}, fields: Partial<DevelopmentTaskPeerContributionGrant> = {}) {
  const current = await setup(overrides)
  const task = await current.tasks.create({ origin: { kind: 'root' }, objective: 'Orders', scope: 'API declarations', createdBy: human })
  return { ...current, task, grant: grantFor(task.id, fields) }
}

function grantFor(
  taskId: DevelopmentTaskId, fields: Partial<DevelopmentTaskPeerContributionGrant> = {},
): DevelopmentTaskPeerContributionGrant {
  return { version: 1, taskId, grantId: 'grant-one' as DevelopmentTaskContributionGrantId,
    generation: 'grant-generation' as DevelopmentTaskContributionGeneration,
    ownerPeerId: owner, contributorPeerId: source, captureId: 'capture-one' as DevelopmentTaskCaptureId,
    captureGeneration: 'capture-generation' as DevelopmentTaskCaptureGeneration,
    source: { name: 'orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 4096,
    ...fields }
}

function sample(grant: DevelopmentTaskPeerContributionGrant, sequence = 1): DevelopmentTaskPeerContributionRequest {
  return { grant, sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskObservedSourceId, sequence,
    result: { state: 'valid', sha256: 'a'.repeat(64), facts: { operationId: 'createOrder', requestBodyRequired: true,
      requiredRequestFields: ['sku'], responseStatuses: ['201', 'default'], deprecated: false } } }
}

it('admits an authenticated peer without creating a participant or assignment and returns the original commit', async () => {
  const { tasks, rooms, task, grant } = await scenario()
  const before = rooms.list().participants
  const opened = await tasks.openPeerContribution(grant)
  expect(await tasks.openPeerContribution(grant)).toEqual(opened)
  const input = sample(grant)
  const [first, retry] = await Promise.all([tasks.admitPeerContribution(input, source), tasks.admitPeerContribution(input, source)])
  expect(first.outcome).toBe('published')
  expect(retry).toEqual({ ...first, outcome: 'reused' })
  expect(first.publication).toMatchObject({ id: peerContributionPublicationId(input), peerContribution: { grant }, peerObservation: {
    observerPeerId: source, artifactId: peerContributionArtifactId(grant), sourceId: input.sourceId,
    capture: { id: grant.captureId, generation: grant.captureGeneration } } })
  expect(first.publication.publishedBy).toBeUndefined()
  expect(first.publication.observation).toBeUndefined()
  expect(first.publication.text).toContain('has not independently verified')
  expect(first.receipt).toMatchObject({ ownerPeerId: owner, contributorPeerId: source, revision: 3,
    payloadDigest: peerContributionPayloadDigest(input), event: { nodeId: 'task-owner', seq: 3, kind: 'context-published' } })
  await tasks.publishContext({ taskId: task.id, participantId: human, text: 'Unrelated update' })
  expect((await tasks.admitPeerContribution(input, source)).receipt).toEqual(first.receipt)
  expect(tasks.assignmentLog()).toEqual([])
  expect(rooms.list().participants).toEqual(before)
  expect(Object.isFrozen(first.publication.peerObservation?.capture)).toBe(true)
  expect(Object.isFrozen(opened.grant.source)).toBe(true)
})

it('rejects other senders, altered grants, reused source content and nonadvancing new samples', async () => {
  const { tasks, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const input = sample(grant)
  await expect(tasks.admitPeerContribution(input, 'third-peer' as ScopePeerId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  if (grant.source.kind === 'tool-observations') throw new Error('expected OpenAPI fixture source')
  await expect(tasks.admitPeerContribution({ ...input, grant: { ...grant, source: { ...grant.source, path: '/private' } } }, source))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const first = await tasks.admitPeerContribution(input, source)
  await expect(tasks.admitPeerContribution({ ...input, result: { state: 'unavailable', reason: 'missing-file' } }, source))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(tasks.admitPeerContribution({ ...sample(grant, 2), sequence: 1 }, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(tasks.log()).toHaveLength(3)
  expect((await tasks.admitPeerContribution(input, source)).receipt).toEqual(first.receipt)
})

it('reserves termination at capacity, withdraws the current chain and reuses prior receipts after ending', async () => {
  const { tasks, task, grant } = await scenario({ maxEventsPerTask: 4 }, { maxSamples: 1 })
  await tasks.openPeerContribution(grant)
  const input = sample(grant)
  const admitted = await tasks.admitPeerContribution(input, source)
  await expect(tasks.publishContext({ taskId: task.id, participantId: human, text: 'Would consume retirement' }))
    .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await expect(tasks.admitPeerContribution(sample(grant, 2), source)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await expect(tasks.endPeerContribution({ grant, reason: 'revoked' }, source)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const end = await tasks.endPeerContribution({ grant, reason: 'left' }, source)
  expect(end.event.kind).toBe('peer-contribution-ended')
  expect(await tasks.endPeerContribution({ grant, reason: 'revoked' }, owner)).toEqual(end)
  expect((await tasks.admitPeerContribution(input, source)).receipt).toEqual(admitted.receipt)
  await expect(tasks.admitPeerContribution(sample(grant, 2), source)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  await expect(tasks.openPeerContribution(grant)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const context = tasks.get({ taskId: task.id }).context
  expect(context).toHaveLength(3)
  expect(context[0]).toEqual(admitted.publication)
  expect(context[1]?.peerObservation).toMatchObject({ state: 'revoked', sequence: 2 })
  expect(context[2]?.peerContribution).toEqual({ version: 1, grant, ended: 'left' })
  expect(tasks.log()).toHaveLength(4)
})

it('keeps empty-grant and end-before-open tombstones so delayed capture approval cannot revive them', async () => {
  const { tasks, task, grant } = await scenario()
  const ended = await tasks.endPeerContribution({ grant, reason: 'left' }, source)
  await expect(tasks.openPeerContribution(grant)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(tasks.peerContributions({ taskId: task.id })).toEqual([{ grant, state: 'ended', reason: 'left', endReceipt: ended }])
  expect(tasks.get({ taskId: task.id }).context).toEqual([expect.objectContaining({ peerContribution: { version: 1, grant, ended: 'left' } })])
  await expect(tasks.openPeerContribution({ ...grant, grantId: 'fresh-grant' as DevelopmentTaskContributionGrantId }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
})

it('expires authorization through a durable terminal commit before accepting later samples', async () => {
  const { tasks, task, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const input = sample(grant)
  const first = await tasks.admitPeerContribution(input, source)
  vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
  await expect(tasks.admitPeerContribution(sample(grant, 2), source)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(tasks.peerContributions({})[0]).toMatchObject({ state: 'ended', reason: 'expired' })
  expect(tasks.get({ taskId: task.id }).context.at(-1)?.peerContribution?.ended).toBe('expired')
  expect((await tasks.admitPeerContribution(input, source)).receipt).toEqual(first.receipt)
  const count = tasks.log().length
  await tasks.expirePeerContributions({})
  expect(tasks.log()).toHaveLength(count)
})

it('does not commit a failed write or failed retirement and preserves its reserved retry', async () => {
  const { ctx, tasks, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  let fail = true
  const dispose = ctx.on('development-task/persist', () => { if (fail) throw new Error('fixture storage failure') })
  await expect(tasks.admitPeerContribution(sample(grant), source)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(tasks.log()).toHaveLength(2)
  fail = false
  const admitted = await tasks.admitPeerContribution(sample(grant), source)
  fail = true
  await expect(tasks.endPeerContribution({ grant, reason: 'left' }, source)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(tasks.peerContributions({})[0]?.state).toBe('active')
  dispose()
  await tasks.endPeerContribution({ grant, reason: 'left' }, source)
  expect((await tasks.admitPeerContribution(sample(grant), source)).receipt).toEqual(admitted.receipt)
})

it('reuses a committed sample without requiring a new expiry write while current reads still fail closed', async () => {
  const { ctx, tasks, task, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const input = sample(grant)
  const admitted = await tasks.admitPeerContribution(input, source)
  vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
  ctx.on('development-task/persist', () => { throw new Error('fixture retirement unavailable') })
  expect((await tasks.admitPeerContribution(input, source)).receipt).toEqual(admitted.receipt)
  await expect(tasks.currentContextView(task.id)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(tasks.log()).toHaveLength(3)
})

it('orders in-flight admission before termination and rejects every new sample behind it', async () => {
  const { ctx, tasks, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.on('development-task/persist', async (entry) => {
    if (entry.change.kind !== 'context-published') return
    entered.resolve(undefined)
    await release.promise
  })
  const admission = tasks.admitPeerContribution(sample(grant), source)
  await entered.promise
  const ending = tasks.endPeerContribution({ grant, reason: 'left' }, source)
  const late = tasks.admitPeerContribution(sample(grant, 2), source)
  const denied = expect(late).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  release.resolve(undefined)
  const accepted = await admission
  const end = await ending
  await denied
  expect(end.revision).toBe(accepted.receipt.revision + 1)
  expect(tasks.peerContributions({})[0]?.state).toBe('ended')
})

it('enforces the complete UTF-8 sample budget and owner quota while exact retries remain reusable', async () => {
  const current = await scenario({}, { maxSamples: 1 })
  const input: DevelopmentTaskPeerContributionRequest = { ...sample(current.grant), result: { state: 'valid', sha256: 'a'.repeat(64), facts: { operationId: '下单🙂', requestBodyRequired: false,
    requiredRequestFields: [], responseStatuses: ['200'], deprecated: false } } }
  const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  const grant = { ...current.grant, maxSampleBytes: bytes }
  const exact = { ...input, grant }
  // Replacing 4096 with a three-digit limit reduces the complete request by one byte.
  const bound = Buffer.byteLength(JSON.stringify(exact), 'utf8')
  const finalGrant = { ...grant, maxSampleBytes: bound }
  await current.tasks.openPeerContribution(finalGrant)
  await current.tasks.admitPeerContribution({ ...input, grant: finalGrant }, source)
  await expect(current.tasks.admitPeerContribution({ ...sample(finalGrant, 2) }, source)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  const other = await scenario({}, { maxSampleBytes: bound - 1 })
  await other.tasks.openPeerContribution(other.grant)
  await expect(other.tasks.admitPeerContribution({ ...input, grant: other.grant }, source)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
})

it('restores original receipts, rejects insufficient retirement capacity and validates terminal attribution', async () => {
  const { tasks, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const first = await tasks.admitPeerContribution(sample(grant), source)
  const logs = tasks.log().map(entry => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry))))
  const tooSmall = await setup({ maxEventsPerTask: 3 })
  expect(() => { tooSmall.tasks.restoreLog(logs) }).toThrow('revocations')
  const restored = await setup()
  restored.tasks.restoreLog(logs)
  expect((await restored.tasks.admitPeerContribution(sample(grant), source)).receipt).toEqual(first.receipt)
  const state = restored.tasks.peerContributions({})[0]!
  expect(peerContributionStateSchema.parse(state)).toEqual(state)
  expect(peerContributionAdmissionReceiptSchema.safeParse({ ...first.receipt, event: { ...first.receipt.event, kind: 'peer-contribution-opened' } }).success).toBe(false)
  expect(() => { restored.tasks.restoreLog([{ ...logs.at(-1)!, seq: 4, revision: 4,
    change: { kind: 'peer-contribution-ended', grant: { ...grant, contributorPeerId: 'other' as ScopePeerId }, reason: 'left' } }]) })
    .toThrow('changes')
})


it('requires a local Root Task and sufficient capacity before granting, while replicas expose no local peer authority', async () => {
  const small = await scenario({ maxEventsPerTask: 2 })
  await expect(small.tasks.openPeerContribution(small.grant)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  expect(small.tasks.log()).toHaveLength(1)
  const { tasks, task, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const remote = await setup({}, 'other-node')
  for (const entry of tasks.log()) await remote.tasks.acceptLogReplica(entry, entry.nodeId)
  expect(remote.tasks.peerContributions({})).toEqual([])
  await remote.tasks.expirePeerContributions({})
  await expect(remote.tasks.admitPeerContribution(sample(grant), source)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const fork = await tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: task.revision } },
    objective: 'History', scope: 'Historical evidence', createdBy: human })
  await expect(tasks.openPeerContribution(grantFor(fork.id))).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
})

it('rejects forged durable peer provenance and fails restoration when the new byte limit prevents retirement', async () => {
  const { tasks, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  const admitted = await tasks.admitPeerContribution(sample(grant), source)
  const entries = tasks.log()
  const bad = await setup()
  bad.tasks.restoreLog(entries.slice(0, 2))
  const observation = admitted.publication.peerObservation!
  expect(() => { bad.tasks.restoreLog([{ ...entries[2]!, change: { kind: 'context-published', publication: {
    id: admitted.publication.id, text: admitted.publication.text, publishedAt: admitted.publication.publishedAt,
    peerContribution: admitted.publication.peerContribution!,
    peerObservation: { ...observation, observerPeerId: 'forged-peer' as ScopePeerId },
  } } }]) }).toThrow('authorization')
  expect(bad.tasks.log()).toHaveLength(2)
  const undersized = await setup({ maxTextBytes: 128 })
  expect(() => { undersized.tasks.restoreLog(entries.slice(0, 2)) }).toThrow('maxTextBytes')
})

it('reads current local context only after expiry persists and leaves unrelated and inherited Tasks readable', async () => {
  const { ctx, tasks, task, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  await tasks.admitPeerContribution(sample(grant), source)
  const fork = await tasks.create({ origin: { kind: 'fork', parent: {
    taskId: task.id, revision: tasks.get({ taskId: task.id }).revision,
  } }, objective: 'Historical declarations', scope: 'Frozen parent evidence', createdBy: human })
  const frozen = tasks.contextView(fork.id)
  vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
  const dispose = ctx.on('development-task/persist', (entry) => {
    if (entry.change.kind === 'peer-contribution-ended') throw new Error('fixture retirement failure')
  })
  await expect(tasks.currentContextView(task.id)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(tasks.peerContributions({ taskId: task.id })[0]?.state).toBe('active')
  expect(await tasks.currentContextView(fork.id)).toEqual(frozen)
  await tasks.expirePeerContributions({ taskId: fork.id })
  dispose()
  const view = await tasks.currentContextView(task.id)
  expect(view.task.context.at(-1)?.peerContribution?.ended).toBe('expired')
  expect(view.task.revision).toBe(4)
  expect(await tasks.currentContextView(fork.id)).toEqual(frozen)
})

it('keeps an authoritative read pending until its terminal event has committed', async () => {
  const { ctx, tasks, task, grant } = await scenario()
  await tasks.openPeerContribution(grant)
  await tasks.admitPeerContribution(sample(grant), source)
  vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.on('development-task/persist', async (entry) => {
    if (entry.change.kind !== 'peer-contribution-ended') return
    entered.resolve(undefined)
    await release.promise
  })
  let settled = false
  const pending = tasks.currentContextView(task.id).then((view) => { settled = true; return view })
  await entered.promise
  expect(settled).toBe(false)
  expect(tasks.contextView(task.id).task.revision).toBe(3)
  release.resolve(undefined)
  const view = await pending
  expect(view.task.revision).toBe(4)
  expect(view.task.context.at(-1)?.peerContribution?.ended).toBe('expired')
})

it('refuses active direct peer evidence on Mesh replicas but preserves terminal and frozen historical views', async () => {
  const { tasks, task, grant } = await scenario()
  const remote = await setup({}, 'replica-node')
  await remote.tasks.acceptLogReplica(tasks.log()[0]!, tasks.log()[0]!.nodeId)
  expect((await remote.tasks.currentContextView(task.id)).task.context).toEqual([])
  await tasks.openPeerContribution(grant)
  await tasks.admitPeerContribution(sample(grant), source)
  const fork = await tasks.create({ origin: { kind: 'fork', parent: {
    taskId: task.id, revision: tasks.get({ taskId: task.id }).revision,
  } }, objective: 'Historical peer evidence', scope: 'Pinned parent', createdBy: human })
  for (const block of tasks.blocks()) await remote.tasks.acceptContextReplica(block)
  for (const entry of tasks.log().slice(1)) await remote.tasks.acceptLogReplica(entry, entry.nodeId)
  await expect(remote.tasks.currentContextView(task.id)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect((await remote.tasks.currentContextView(fork.id)).inherited).toEqual(tasks.contextView(fork.id).inherited)
  await tasks.endPeerContribution({ grant, reason: 'revoked' }, owner)
  const terminal = tasks.log().at(-1)!
  await remote.tasks.acceptLogReplica(terminal, terminal.nodeId)
  expect((await remote.tasks.currentContextView(task.id)).task.context).toEqual(tasks.contextView(task.id).task.context)
})

function toolSample(grant: DevelopmentTaskPeerContributionGrant, sequence = 1): DevelopmentTaskPeerContributionRequest {
  return { grant, sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskObservedSourceId, sequence,
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'src/order.ts', content: 'export const orderCode = "新🙂"' }, omissions: [] } }
}

it('admits ordered Write and Edit events for different files without an artifact selector or Task membership', async () => {
  const { tasks, task, rooms, grant } = await scenario({}, { source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] }, maxSamples: 2 })
  const before = rooms.list().participants
  await tasks.openPeerContribution(grant)
  const first = await tasks.admitPeerContribution(toolSample(grant), source)
  const second = await tasks.admitPeerContribution({ ...toolSample(grant, 2), result: {
    kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success',
    fields: { rootIndex: 1, path: 'guide/contract.md', oldString: 'old', newString: 'new', replaceAll: false }, omissions: [],
  } }, source)
  const view = await tasks.currentContextView(task.id)
  expect(view.task.context).toEqual([first.publication, second.publication])
  await expect(tasks.admitPeerContribution(toolSample(grant, 3), source)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  expect(view.task.context.map(item => item.peerToolObservation?.fields.path)).toEqual(['src/order.ts', 'guide/contract.md'])
  expect(view.task.context.map(item => item.peerToolObservation?.sequence)).toEqual([1, 2])
  expect(view.task.context.every(item => item.peerObservation === undefined && item.publishedBy === undefined)).toBe(true)
  expect(first.publication.peerToolObservation).toMatchObject({ observerPeerId: source, sourceName: 'session-work',
    capture: { id: grant.captureId, generation: grant.captureGeneration }, sourceId: toolSample(grant).sourceId })
  expect(first.publication.text).toContain('reported event, not a current file snapshot')
  expect(first.publication.text).toContain('has not independently verified')
  expect(rooms.list().participants).toEqual(before)
  expect(tasks.assignmentLog()).toEqual([])
  expect(Object.isFrozen(first.publication.peerToolObservation?.fields)).toBe(true)
  expect(Object.isFrozen(first.publication.peerToolObservation?.omissions)).toBe(true)
  const retained = tasks.peerContributions({})[0]!.grant.source
  if (retained.kind !== 'tool-observations') throw new Error('expected tool permission')
  expect(Object.isFrozen(retained)).toBe(true)
  expect(Object.isFrozen(retained.tools)).toBe(true)
})

it('rejects a mismatched report kind or unapproved tool and binds retries to every tool field', async () => {
  const { tasks, grant } = await scenario({}, { source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  await tasks.openPeerContribution(grant)
  await expect(tasks.admitPeerContribution(sample(grant), source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const denied: DevelopmentTaskPeerContributionRequest = { ...toolSample(grant), result: {
    kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'src/order.ts', oldString: 'old', newString: 'new', replaceAll: false }, omissions: [],
  } }
  await expect(tasks.admitPeerContribution(denied, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(tasks.admitPeerContribution(toolSample(grant), 'third-peer' as ScopePeerId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const first = await tasks.admitPeerContribution(toolSample(grant), source)
  const changed = { ...toolSample(grant), result: { kind: 'tool-observation' as const, version: 1 as const, tool: 'Write' as const,
    reportedStatus: 'success' as const, fields: { rootIndex: 0, path: 'src/order.ts', content: 'changed' }, omissions: [] } }
  await expect(tasks.admitPeerContribution(changed, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(tasks.admitPeerContribution({ ...toolSample(grant, 2), sequence: 1 }, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect((await tasks.admitPeerContribution(toolSample(grant), source)).receipt).toEqual(first.receipt)
  expect(tasks.log()).toHaveLength(3)
  const legacy = await scenario()
  await legacy.tasks.openPeerContribution(legacy.grant)
  await expect(legacy.tasks.admitPeerContribution(toolSample(legacy.grant), source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
})

it('strictly parses relative tool paths and explicit omitted fields without admitting arbitrary metadata', () => {
  const base = { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'src/order.ts', content: 'new' }, omissions: [] }
  expect(toolObservationResultSchema.parse(base)).toEqual(base)
  for (const path of ['/private/order.ts', '../order.ts', 'a/../b', 'a//b', 'C:/secret', 'a\\b', './a', 'a\u0000b']) {
    expect(toolObservationResultSchema.safeParse({ ...base, fields: { ...base.fields, path } }).success).toBe(false)
  }
  for (const invalid of [
    { ...base, sessionId: 'private-session' }, { ...base, tool: 'Bash' },
    { ...base, fields: { ...base.fields, absoluteRoot: '/private' } },
    { ...base, fields: { rootIndex: 0, path: 'a' } },
    { ...base, omissions: ['content'] }, { ...base, omissions: ['oldString'] },
    { ...base, reportedStatus: 'failure' }, { ...base, fields: { ...base.fields, error: 'error' } },
    { ...base, fields: { rootIndex: 0, path: 'a' }, omissions: ['content', 'content'] },
  ]) expect(toolObservationResultSchema.safeParse(invalid).success).toBe(false)
  const failed = { ...base, reportedStatus: 'failure', fields: { rootIndex: 0, path: 'a', error: 'Permission denied' }, omissions: ['content'] }
  expect(toolObservationResultSchema.parse(failed)).toEqual(failed)
  expect(toolObservationResultSchema.parse({ ...base, fields: { rootIndex: 0, path: 'a' }, omissions: ['content'] }).omissions).toEqual(['content'])
})

it('restores tool provenance and exact receipts without rewriting legacy OpenAPI events', async () => {
  const { tasks, task, grant } = await scenario({}, { source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } })
  await tasks.openPeerContribution(grant)
  const input = toolSample(grant)
  const admitted = await tasks.admitPeerContribution(input, source)
  const raw = JSON.stringify(tasks.log())
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(raw)))
  expect(JSON.stringify(restored.tasks.log())).toBe(raw)
  expect((await restored.tasks.admitPeerContribution(input, source)).receipt).toEqual(admitted.receipt)
  expect((await restored.tasks.currentContextView(task.id)).task.context).toEqual(tasks.contextView(task.id).task.context)
  const forged = await setup()
  forged.tasks.restoreLog(tasks.log().slice(0, 2))
  const publication = admitted.publication
  if (publication.peerToolObservation === undefined) throw new Error('expected tool provenance')
  const tampered = { ...publication, peerToolObservation: { ...publication.peerToolObservation, observerPeerId: 'forged-peer' as ScopePeerId } }
  expect(() => { forged.tasks.restoreLog([{ ...tasks.log()[2]!, change: { kind: 'context-published', publication: tampered } }]) }).toThrow('authorization')
  expect(forged.tasks.log()).toHaveLength(2)
  const legacy = await scenario()
  await legacy.tasks.openPeerContribution(legacy.grant)
  const original = await legacy.tasks.admitPeerContribution(sample(legacy.grant), source)
  const oldBytes = JSON.stringify(legacy.tasks.log())
  const reopened = await setup()
  reopened.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(oldBytes)))
  expect(JSON.stringify(reopened.tasks.log())).toBe(oldBytes)
  expect((await reopened.tasks.admitPeerContribution(sample(legacy.grant), source)).receipt).toEqual(original.receipt)
})

it('reserves tool withdrawal at quota and preserves receipts after termination and restart', async () => {
  const { tasks, task, grant } = await scenario({ maxEventsPerTask: 5 }, {
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] }, maxSamples: 2,
  })
  await tasks.openPeerContribution(grant)
  const first = await tasks.admitPeerContribution(toolSample(grant), source)
  await tasks.admitPeerContribution(toolSample(grant, 2), source)
  await expect(tasks.admitPeerContribution(toolSample(grant, 3), source)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  const receipt = await tasks.endPeerContribution({ grant, reason: 'left' }, source)
  const restored = await setup()
  restored.tasks.restoreLog(tasks.log().map(entry => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry)))))
  expect(await restored.tasks.endPeerContribution({ grant, reason: 'left' }, source)).toEqual(receipt)
  expect((await restored.tasks.admitPeerContribution(toolSample(grant), source)).receipt).toEqual(first.receipt)
  await expect(restored.tasks.admitPeerContribution(toolSample(grant, 3), source)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const context = restored.tasks.contextView(task.id).task.context
  expect(context).toHaveLength(3)
  expect(context.slice(0, 2).every(item => item.peerToolObservation !== undefined)).toBe(true)
  expect(context[2]?.peerContribution?.ended).toBe('left')
  expect(context[2]?.peerToolObservation).toBeUndefined()
})

it('bounds the complete UTF-8 tool request and retains no publication when persistence fails', async () => {
  const { ctx, tasks, grant } = await scenario({}, { source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const input = toolSample(grant)
  const exact = { ...grant, maxSampleBytes: Buffer.byteLength(JSON.stringify(input), 'utf8') }
  const bounded = { ...exact, maxSampleBytes: Buffer.byteLength(JSON.stringify({ ...input, grant: exact }), 'utf8') }
  await tasks.openPeerContribution(bounded)
  const current = { ...input, grant: bounded }
  expect(Buffer.byteLength(JSON.stringify(current), 'utf8')).toBe(bounded.maxSampleBytes)
  const dispose = ctx.on('development-task/persist', () => { throw new Error('fixture store unavailable') })
  await expect(tasks.admitPeerContribution(current, source)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(tasks.log()).toHaveLength(2)
  dispose()
  await tasks.admitPeerContribution(current, source)
  const other = await scenario({}, { source: bounded.source, maxSampleBytes: bounded.maxSampleBytes - 1 })
  await other.tasks.openPeerContribution(other.grant)
  await expect(other.tasks.admitPeerContribution(toolSample(other.grant), source)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
})


it('retains tool provenance in immutable parent blocks and strict Mesh replica reads', async () => {
  const { tasks, task, grant } = await scenario({}, { source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  await tasks.openPeerContribution(grant)
  const admitted = await tasks.admitPeerContribution(toolSample(grant), source)
  const fork = await tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: 3 } },
    objective: 'Historical tools', scope: 'Frozen observations', createdBy: human })
  const replica = await setup({}, 'tool-replica')
  for (const block of tasks.blocks()) {
    await replica.tasks.acceptContextReplica(developmentTaskContextBlockSchema.parse(JSON.parse(JSON.stringify(block))))
  }
  for (const entry of tasks.log()) {
    await replica.tasks.acceptLogReplica(developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry))), entry.nodeId)
  }
  await expect(replica.tasks.currentContextView(task.id)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  const inherited = (await replica.tasks.currentContextView(fork.id)).inherited
  if (inherited === undefined) throw new Error('expected frozen parent block')
  expect(inherited.sources[0]?.context).toEqual([admitted.publication])
  expect(Object.isFrozen(inherited.sources[0]?.context[0]?.peerToolObservation?.fields)).toBe(true)
  await tasks.endPeerContribution({ grant, reason: 'revoked' }, owner)
  const ended = tasks.log().at(-1)!
  await replica.tasks.acceptLogReplica(developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(ended))), ended.nodeId)
  expect((await replica.tasks.currentContextView(task.id)).task.context).toEqual(tasks.contextView(task.id).task.context)
  expect((await replica.tasks.currentContextView(fork.id)).inherited).toEqual(inherited)
})

it('requires explicit historical-sharing authority and preserves recorded provenance through retry and restore', async () => {
  const { tasks, task, grant } = await scenario({}, { source: { kind: 'tool-observations', version: 2,
    initialization: 'recorded-local-tools', name: 'session-work', tools: ['Write', 'Edit'] } })
  const live = toolSample(grant)
  if (!('kind' in live.result)) throw new Error('expected tool report')
  const recorded: DevelopmentTaskPeerContributionRequest = { ...live, result: { ...live.result, version: 2,
    origin: { kind: 'recorded-local-tools', planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } } }
  const { grant: _grant, ...body } = recorded
  expect(toolObservationResultSchema.safeParse(recorded.result).success).toBe(false)
  expect(localContributionSampleSchema.safeParse(body).success).toBe(false)
  expect(legacyPeerContributionSampleSchema.safeParse(body).success).toBe(false)
  expect(recordedPeerContributionSampleSchema.parse(body)).toEqual(body)
  expect(recordedPeerContributionSampleSchema.safeParse({ ...body, result: live.result }).success).toBe(false)
  await tasks.openPeerContribution(grant)
  const admitted = await tasks.admitPeerContribution(recorded, source)
  expect(peerPublicationRequest(admitted.publication)).toEqual(recorded)
  expect(admitted.publication.text).toContain('Previously recorded tool attempt')
  expect(admitted.publication.text).toContain('not re-executed or checked against the current file')
  expect(admitted.receipt.payloadDigest).toBe(peerContributionPayloadDigest(recorded))
  expect(admitted.receipt.payloadDigest).not.toBe(peerContributionPayloadDigest(live))
  const observation = admitted.publication.peerToolObservation
  if (observation?.version !== 2) throw new Error('expected recorded observation')
  expect(Object.isFrozen(observation.origin)).toBe(true)
  if (!('kind' in recorded.result) || recorded.result.version !== 2) throw new Error('expected recorded sample')
  await expect(tasks.admitPeerContribution({ ...recorded, result: { ...recorded.result,
    origin: { ...recorded.result.origin, executionDigest: 'c'.repeat(64) } } }, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const raw = JSON.stringify(tasks.log())
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(raw)))
  expect(JSON.stringify(restored.tasks.log())).toBe(raw)
  expect((await restored.tasks.admitPeerContribution(recorded, source)).receipt).toEqual(admitted.receipt)
  await restored.tasks.admitPeerContribution(toolSample(grant, 2), source)
  await restored.tasks.endPeerContribution({ grant, reason: 'left' }, source)
  expect((await restored.tasks.currentContextView(task.id)).task.context.at(-1)?.peerContribution?.ended).toBe('left')
  expect((await restored.tasks.admitPeerContribution(recorded, source)).receipt).toEqual(admitted.receipt)
  const ordinary = await scenario({}, { source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  await ordinary.tasks.openPeerContribution(ordinary.grant)
  await expect(ordinary.tasks.admitPeerContribution({ ...recorded, grant: ordinary.grant }, source))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(ordinary.tasks.contextView(ordinary.task.id).task.context).toEqual([])
})

it('rejects incomplete or extra recorded origins and binds each origin field into the receipt', () => {
  const grant = grantFor('task' as DevelopmentTaskId, { source: { kind: 'tool-observations', version: 2,
    initialization: 'recorded-local-tools', name: 'session-work', tools: ['Write'] } })
  const live = toolSample(grant)
  if (!('kind' in live.result)) throw new Error('expected tool report')
  const result = { ...live.result, version: 2 as const,
    origin: { kind: 'recorded-local-tools' as const, planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } }
  for (const origin of [undefined, { ...result.origin, localSessionId: 'private' }, { ...result.origin, planDigest: '' },
    { ...result.origin, executionDigest: 'unbounded-proof' }, { ...result.origin, kind: 'live' }]) {
    expect(recordedToolObservationResultSchema.safeParse({ ...result, origin }).success).toBe(false)
  }
  const base = peerContributionPayloadDigest({ ...live, result })
  for (const key of ['planDigest', 'executionDigest'] as const) {
    expect(peerContributionPayloadDigest({ ...live, result: { ...result, origin: { ...result.origin, [key]: 'c'.repeat(64) } } }))
      .not.toBe(base)
  }
})


it.each(['history', 'tool'] as const)('rejects serialized inherited recorded reports without %s permission even with a recomputed block digest', async (permission) => {
  const { tasks, task, grant } = await scenario({}, { source: { kind: 'tool-observations', version: 2,
    initialization: 'recorded-local-tools', name: 'session-work', tools: ['Write'] } })
  await tasks.openPeerContribution(grant)
  const original = toolSample(grant)
  if (!('kind' in original.result)) throw new Error('expected tool report')
  const recorded: DevelopmentTaskPeerContributionRequest = { ...original, result: { ...original.result, version: 2,
    origin: { kind: 'recorded-local-tools', planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } } }
  const admitted = await tasks.admitPeerContribution(recorded, source)
  const fork = await tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: 3 } },
    objective: 'Recorded work', scope: 'Inherited observations', createdBy: human })
  const block = tasks.blocks()[0]
  if (block === undefined) throw new Error('expected inherited block')
  const restored = await setup()
  restored.tasks.restoreContextBlocks([developmentTaskContextBlockSchema.parse(JSON.parse(JSON.stringify(block)))])
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(tasks.log()))))
  const inherited = restored.tasks.contextView(fork.id).inherited
  expect(inherited?.sources[0]?.context).toEqual([admitted.publication])
  const observation = inherited?.sources[0]?.context[0]?.peerToolObservation
  if (observation?.version !== 2) throw new Error('expected restored recorded observation')
  expect(Object.isFrozen(observation.origin)).toBe(true)
  const sources = block.sources.map(parentSource => ({ ...parentSource,
    context: parentSource.context.map(publication => ({ ...publication,
      peerContribution: { version: 1, grant: { ...grant,
        source: permission === 'history' ? { kind: 'tool-observations', name: 'session-work', tools: ['Write'] }
          : { kind: 'tool-observations', version: 2, initialization: 'recorded-local-tools', name: 'session-work', tools: ['Edit'] } } },
    })),
  }))
  const tampered = { ...block, sources,
    id: `context-${createHash('sha256').update(JSON.stringify({ version: 1, sources })).digest('hex')}` }
  expect(tampered.id).not.toBe(block.id)
  const serialized = JSON.stringify(tampered)
  const rejected = await setup()
  expect(() => {
    rejected.tasks.restoreContextBlocks([developmentTaskContextBlockSchema.parse(JSON.parse(serialized))])
  }).toThrow()
  expect(rejected.tasks.blocks()).toEqual([])
})


it('requires exact peer completed-file permission and preserves the complete payload in receipts and restored publications', async () => {
  const complete = { kind: 'tool-observations' as const, version: 3 as const, name: 'session-work',
    tools: ['Edit'] as const, fileContent: 'completed-native-file' as const }
  const result = completedFileToolObservationResultSchema.parse({ kind: 'tool-observation', version: 3, tool: 'Edit',
    reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/old.ts', oldString: 'one', newString: 'two', replaceAll: false },
    completedFile: { state: 'included', content: 'UNSHARED_BEFORE_CONSENT two',
      sha256: createHash('sha256').update('UNSHARED_BEFORE_CONSENT two').digest('hex') } })
  for (const permission of [
    { kind: 'tool-observations' as const, name: 'session-work', tools: ['Edit'] as const },
    { kind: 'tool-observations' as const, version: 2 as const, name: 'session-work', tools: ['Edit'] as const,
      initialization: 'recorded-local-tools' as const },
  ]) {
    const f = await scenario({}, { source: permission })
    await f.tasks.openPeerContribution(f.grant)
    await expect(f.tasks.admitPeerContribution({ ...toolSample(f.grant), result }, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.tasks.get({ taskId: f.task.id }).context).toEqual([])
  }
  const f = await scenario({}, { source: complete })
  await f.tasks.openPeerContribution(f.grant)
  const request = { ...toolSample(f.grant), result }
  const accepted = await f.tasks.admitPeerContribution(request, source)
  expect(peerPublicationRequest(accepted.publication)).toEqual(request)
  const observation = accepted.publication.peerToolObservation
  if (observation?.version !== 3) throw new Error('Missing completed-file observation')
  expect(Object.isFrozen(observation.completedFile)).toBe(true)
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  expect((await restored.tasks.admitPeerContribution(request, source)).receipt).toEqual(accepted.receipt)
  const changed = { ...request, result: { ...result, completedFile: { state: 'omitted' as const, reason: 'budget' as const } } }
  expect(peerContributionPayloadDigest(changed)).not.toBe(accepted.receipt.payloadDigest)
  await expect(restored.tasks.admitPeerContribution(changed, source)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await restored.tasks.endPeerContribution({ grant: f.grant, reason: 'revoked' }, owner)
  expect((await restored.tasks.currentContextView(f.task.id)).task.context.at(-1)?.peerContribution?.ended).toBe('revoked')
})

it('rejects independently typed report and permission versions when constructing peer publications', () => {
  const live = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, tool: 'Edit',
    reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/old.ts', oldString: 'one', newString: 'two', replaceAll: false } })
  const recorded = recordedToolObservationResultSchema.parse({ ...live, version: 2,
    origin: { kind: 'recorded-local-tools', planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } })
  const completed = completedFileToolObservationResultSchema.parse({ ...live, version: 3,
    completedFile: { state: 'omitted', reason: 'budget' } })
  const ordinary = grantFor('task' as DevelopmentTaskId, { source: {
    kind: 'tool-observations', name: 'session-work', tools: ['Edit'],
  } })
  const historical = grantFor(ordinary.taskId, { source: {
    kind: 'tool-observations', version: 2, initialization: 'recorded-local-tools', name: 'session-work', tools: ['Edit'],
  } })
  const complete = grantFor(ordinary.taskId, { source: {
    kind: 'tool-observations', version: 3, fileContent: 'completed-native-file', name: 'session-work', tools: ['Edit'],
  } })
  const mismatches: DevelopmentTaskPeerContributionRequest[] = [
    { ...toolSample(complete), result: live },
    { ...toolSample(complete), result: recorded },
    { ...toolSample(ordinary), result: completed },
    { ...toolSample(historical), result: completed },
    { ...toolSample(ordinary), result: recorded },
    { ...toolSample(grantFor(ordinary.taskId)), result: completed },
  ]
  for (const request of mismatches) {
    expect(() => peerPublication(request, 1)).toThrow('tool report requires its matching live or recorded observation authorization')
  }
})
