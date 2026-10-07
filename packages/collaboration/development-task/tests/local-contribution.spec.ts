import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import { afterEach, expect, it, vi } from 'vitest'
import DevelopmentTaskService, { localContributionId, localContributionPayloadDigest } from '../src/index.ts'
import type { Config, DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionRequest } from '../src/index.ts'
import { developmentTaskEventSchema, developmentTaskContextBlockSchema, localContributionStateSchema,
  completedFileToolObservationResultSchema, toolObservationResultSchema, recordedToolObservationResultSchema } from '../src/schema.ts'

const contexts: Context[] = []
const human = 'owner' as DevelopmentParticipantId
const agent = 'agent-source' as DevelopmentParticipantId
const config: Config = { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
  maxContextBlockBytes: 32768, maxLineageTasks: 32, maxTextBytes: 8192, roomRetryIntervalMs: 10000 }

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

async function setup(overrides: Partial<Config> = {}, nodeId = 'local-owner') {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId, presenceTtlMs: 10000, maxParticipants: 8, maxRooms: 32, maxTextBytes: 8192 })
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  await rooms.announce({ id: agent, kind: 'agent', displayName: 'Existing Agent' })
  const tasks = new DevelopmentTaskService(ctx, { ...config, ...overrides })
  return { ctx, rooms, tasks }
}

async function scenario(overrides: Partial<Config> = {}, fields: Partial<DevelopmentTaskLocalContributionGrant> = {}) {
  const current = await setup(overrides)
  const task = await current.tasks.create({ origin: { kind: 'root' }, objective: 'Build app', scope: 'Code and documentation', createdBy: human })
  const { assignment } = await current.tasks.checkout({ taskId: task.id, participantId: agent })
  const epoch = current.tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('checkout must commit a binding')
  const grant: DevelopmentTaskLocalContributionGrant = { version: 1, taskId: task.id, participantId: agent,
    bindingId: assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
    captureId: 'capture-a' as DevelopmentTaskLocalContributionGrant['captureId'],
    captureGeneration: 'generation-a' as DevelopmentTaskLocalContributionGrant['captureGeneration'],
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] },
    expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 8192, ...fields }
  return { ...current, task, grant }
}

function sample(grant: DevelopmentTaskLocalContributionGrant, sequence = 1): DevelopmentTaskLocalContributionRequest {
  return { grant, sequence, sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskLocalContributionRequest['sourceId'],
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: `file-${sequence}.ts`, content: `local-report-${sequence}` }, omissions: [] } }
}

it('uses the actual local assignment and returns original receipts for exact persisted reports', async () => {
  const { tasks, grant, rooms } = await scenario()
  const participants = rooms.list().participants
  const opened = await tasks.openLocalContribution(grant)
  expect(await tasks.openLocalContribution(grant)).toEqual(opened)
  const input = sample(grant)
  const [first, repeated] = await Promise.all([tasks.admitLocalContribution(input), tasks.admitLocalContribution(input)])
  expect(first.outcome).toBe('published')
  expect(repeated).toEqual({ ...first, outcome: 'reused' })
  expect(first.receipt).toMatchObject({ intervalId: localContributionId(grant), participantId: agent,
    payloadDigest: localContributionPayloadDigest(input), event: { kind: 'context-published', nodeId: 'local-owner', seq: 3 } })
  expect(first.publication).toMatchObject({ publishedBy: agent, localContribution: { grant }, localToolObservation: input.result })
  expect(first.publication.peerContribution).toBeUndefined()
  expect(rooms.list().participants).toEqual(participants)
  expect(Object.isFrozen(first.publication.localToolObservation?.fields)).toBe(true)
  expect(Object.isFrozen(opened.grant.expectedBindingEpoch)).toBe(true)
  expect(localContributionStateSchema.parse(await tasks.localContributionStatus({ grant }))).toEqual(opened)
})

it('rejects another participant, stale epochs, altered limits, unauthorized tools and conflicting sample identities', async () => {
  const { tasks, grant } = await scenario({}, { source: { kind: 'tool-observations', name: 'write-only', tools: ['Write'] } })
  await expect(tasks.openLocalContribution({ ...grant, participantId: human })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(tasks.openLocalContribution({ ...grant, expectedBindingEpoch: { ...grant.expectedBindingEpoch, seq: 999 } }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await tasks.openLocalContribution(grant)
  await expect(tasks.openLocalContribution({ ...grant, maxSamples: 99 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await tasks.admitLocalContribution(sample(grant))
  await expect(tasks.admitLocalContribution({ ...sample(grant), result: { kind: 'tool-observation', version: 1,
    tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'file-1.ts', content: 'different' }, omissions: [] } }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(tasks.admitLocalContribution({ ...sample(grant, 2), result: { kind: 'tool-observation', version: 1,
    tool: 'Edit', reportedStatus: 'success', fields: { rootIndex: 0, path: 'file-1.ts', oldString: 'a', newString: 'b', replaceAll: false }, omissions: [] } }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(tasks.admitLocalContribution({ ...sample(grant, 2), sequence: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(tasks.log()).toHaveLength(3)
})

it('reserves terminal capacity and preserves exact receipts after clear without reopening the capture', async () => {
  const { tasks, grant, task } = await scenario({ maxEventsPerTask: 4 }, { maxSamples: 1 })
  await tasks.openLocalContribution(grant)
  const first = await tasks.admitLocalContribution(sample(grant))
  await expect(tasks.publishContext({ taskId: task.id, participantId: human, text: 'would consume end slot' }))
    .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await expect(tasks.admitLocalContribution(sample(grant, 2))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await tasks.clear({ participantId: agent, bindingId: grant.bindingId })
  const ended = await tasks.localContributionStatus({ grant })
  expect(ended).toMatchObject({ state: 'ended', reason: 'revoked', endReceipt: { event: { kind: 'local-contribution-ended' } } })
  expect((await tasks.admitLocalContribution(sample(grant))).receipt).toEqual(first.receipt)
  await expect(tasks.admitLocalContribution(sample(grant, 2))).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  await expect(tasks.openLocalContribution(grant)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(tasks.get({ taskId: task.id }).context.at(-1)).toMatchObject({ localContribution: { grant, ended: 'revoked' } })
  expect(tasks.log()).toHaveLength(4)
})

it('keeps end-before-open tombstones and stops a local interval before replacing its assignment epoch', async () => {
  const { tasks, grant, task } = await scenario()
  const end = await tasks.endLocalContribution({ grant, reason: 'left' })
  expect(await tasks.endLocalContribution({ grant, reason: 'revoked' })).toEqual(end)
  await expect(tasks.openLocalContribution(grant)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const next = { ...grant, captureGeneration: 'next-generation' as DevelopmentTaskLocalContributionGrant['captureGeneration'] }
  await tasks.openLocalContribution(next)
  await tasks.checkout({ taskId: task.id, participantId: agent, bindingId: grant.bindingId })
  expect(await tasks.localContributionStatus({ grant: next })).toMatchObject({ state: 'ended', reason: 'revoked' })
  await expect(tasks.admitLocalContribution(sample(next))).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
})

it('fails current reads closed when due local termination cannot persist and retries the original end', async () => {
  const { ctx, tasks, grant, task } = await scenario()
  await tasks.openLocalContribution(grant)
  await tasks.admitLocalContribution(sample(grant))
  const now = vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
  const release = ctx.on('development-task/persist', (entry) => {
    if (entry.change.kind === 'local-contribution-ended') throw new Error('fixture end write failed')
  })
  await expect(tasks.currentContextView(task.id)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(tasks.log()).toHaveLength(3)
  release()
  await tasks.currentContextView(task.id)
  expect(await tasks.localContributionStatus({ grant })).toMatchObject({ state: 'ended', reason: 'expired' })
  now.mockRestore()
})

it('restores local authority, receipts and frozen inherited publications through the strict Task schema', async () => {
  const { tasks, grant, task } = await scenario()
  await tasks.openLocalContribution(grant)
  const first = await tasks.admitLocalContribution(sample(grant))
  const fork = await tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: tasks.get({ taskId: task.id }).revision } },
    objective: 'Frozen report', scope: 'History', createdBy: human })
  await tasks.endLocalContribution({ grant, reason: 'left' })
  const reopened = await setup()
  reopened.tasks.restoreContextBlocks(tasks.blocks().map(item => developmentTaskContextBlockSchema.parse(JSON.parse(JSON.stringify(item)))))
  reopened.tasks.restoreLog(tasks.log().map(item => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(item)))))
  reopened.tasks.restoreAssignmentLog(tasks.assignmentLog())
  expect(await reopened.tasks.localContributionStatus({ grant })).toEqual(await tasks.localContributionStatus({ grant }))
  expect((await reopened.tasks.admitLocalContribution(sample(grant))).receipt).toEqual(first.receipt)
  expect(reopened.tasks.contextView(fork.id).inherited?.sources[0]?.context).toContainEqual(first.publication)
  const replica = await setup({}, 'replica')
  replica.tasks.restoreLog(tasks.log().slice(0, 3).map(item => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(item)))))
  await expect(replica.tasks.currentContextView(task.id)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it('restores historical bytes and original receipts after lowering new-admission text limits', async () => {
  const { tasks, grant } = await scenario()
  await tasks.openLocalContribution(grant)
  const input: DevelopmentTaskLocalContributionRequest = { ...sample(grant), result: {
    kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'large.ts', content: 'reported-content'.repeat(100) }, omissions: [],
  } }
  const original = await tasks.admitLocalContribution(input)
  const ended = await tasks.endLocalContribution({ grant, reason: 'left' })
  const reopened = await setup({ maxTextBytes: 128 })
  reopened.tasks.restoreLog(tasks.log().map(item => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(item)))))
  reopened.tasks.restoreAssignmentLog(tasks.assignmentLog())
  expect((await reopened.tasks.admitLocalContribution(input)).receipt).toEqual(original.receipt)
  expect(await reopened.tasks.endLocalContribution({ grant, reason: 'revoked' })).toEqual(ended)
})

it('checks leave consent in the owner queue and preserves a newer checkout and its capture', async () => {
  const { ctx, tasks, grant, task } = await scenario()
  await tasks.openLocalContribution(grant)
  const another = await tasks.create({ origin: { kind: 'root' }, objective: 'Another task', scope: 'Other work', createdBy: human })
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.on('development-task/assignment-persist', async (entry) => {
    if (entry.change.kind !== 'task-bound' || entry.change.taskId !== another.id) return
    started.resolve(undefined)
    await release.promise
  })
  const moving = tasks.checkout({ taskId: another.id, participantId: agent, bindingId: grant.bindingId })
  await started.promise
  const returning = tasks.checkout({ taskId: task.id, participantId: agent, bindingId: grant.bindingId })
  const staleLeave = expect(tasks.clear(grant)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  release.resolve(undefined)
  await Promise.all([moving, returning, staleLeave])
  const epoch = tasks.assignmentLog().findLast(entry => entry.change.kind === 'task-bound')
  if (epoch === undefined) throw new Error('returning checkout must be durable')
  const currentGrant = { ...grant, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
    captureGeneration: 'new-checkout' as DevelopmentTaskLocalContributionGrant['captureGeneration'] }
  await tasks.openLocalContribution(currentGrant)
  await expect(tasks.clear(grant)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(tasks.assignmentList()).toEqual([expect.objectContaining({ taskId: task.id, bindingId: grant.bindingId })])
  expect(await tasks.localContributionStatus({ grant: currentGrant })).toMatchObject({ state: 'active' })
  await tasks.clear(currentGrant)
  expect(tasks.assignmentList()).toEqual([])
  expect(await tasks.localContributionStatus({ grant: currentGrant })).toMatchObject({ state: 'ended', reason: 'revoked' })
})


function completedResult(content = 'PRIVATE_BASE\nexport const value = 2\n') {
  return completedFileToolObservationResultSchema.parse({ kind: 'tool-observation', version: 3, tool: 'Edit',
    reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'existing.ts', oldString: 'value = 1', newString: 'value = 2', replaceAll: false },
    completedFile: { state: 'included', content, sha256: createHash('sha256').update(content).digest('hex') } })
}

it('requires independent completed-file permission at local admission and preserves it through cold replay', async () => {
  const ordinary = await scenario()
  await ordinary.tasks.openLocalContribution(ordinary.grant)
  await expect(ordinary.tasks.admitLocalContribution({ ...sample(ordinary.grant), result: completedResult() }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const f = await scenario({}, { source: { kind: 'tool-observations', version: 3, name: 'session-work',
    tools: ['Write', 'Edit'], fileContent: 'completed-native-file' } })
  await f.tasks.openLocalContribution(f.grant)
  await expect(f.tasks.admitLocalContribution(sample(f.grant))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const request = { ...sample(f.grant), result: completedResult() }
  const accepted = await f.tasks.admitLocalContribution(request)
  expect(accepted.publication.localContribution?.grant.source).toEqual(f.grant.source)
  expect(accepted.publication.localToolObservation).toMatchObject(request.result)
  const observation = accepted.publication.localToolObservation
  if (observation?.version !== 3) throw new Error('Missing completed-file observation')
  expect(Object.isFrozen(observation.completedFile)).toBe(true)
  expect(accepted.receipt.payloadDigest).toBe(localContributionPayloadDigest(request))
  expect(localContributionPayloadDigest({ ...request, result: completedResult('DIFFERENT_FULL_FILE') }))
    .not.toBe(accepted.receipt.payloadDigest)
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  restored.tasks.restoreAssignmentLog(f.tasks.assignmentLog())
  expect((await restored.tasks.admitLocalContribution(request)).receipt).toEqual(accepted.receipt)
  await restored.tasks.endLocalContribution({ grant: f.grant, reason: 'left' })
  expect((await restored.tasks.currentContextView(f.task.id)).task.context.at(-1)?.localContribution?.ended).toBe('left')
  expect((await restored.tasks.admitLocalContribution(request)).receipt).toEqual(accepted.receipt)
})

it.each(['digest', 'crlf', 'surrogate', 'failure', 'failed-reason', 'history', 'legacy'] as const)
('rejects completed-file %s that violates the durable result representation', (change) => {
  const result = completedResult()
  const raw = change === 'digest' ? { ...result, completedFile: { state: 'included', content: 'wrong', sha256: 'a'.repeat(64) } }
    : change === 'crlf' || change === 'surrogate' ? { ...result, completedFile: { state: 'included',
      content: change === 'crlf' ? 'A\r\nB' : '\ud800',
      sha256: createHash('sha256').update(change === 'crlf' ? 'A\r\nB' : '\ud800').digest('hex') } }
      : change === 'failure' ? { ...result, reportedStatus: 'failure', omissions: ['oldString', 'newString'],
        fields: { rootIndex: 0, path: 'existing.ts', replaceAll: false } }
        : change === 'failed-reason' ? { ...result, completedFile: { state: 'omitted', reason: 'tool-failed' } }
          : change === 'history' ? { ...result, origin: { kind: 'recorded-local-tools', planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } }
            : { ...result, version: 1 }
  expect(completedFileToolObservationResultSchema.safeParse(raw).success).toBe(false)
  expect(toolObservationResultSchema.safeParse(result).success).toBe(false)
  expect(recordedToolObservationResultSchema.safeParse(result).success).toBe(false)
})

it.each(['tool-failed', 'budget', 'unavailable'] as const)('retains whole-field completed-file omission %s', async (reason) => {
  const f = await scenario({}, { source: { kind: 'tool-observations', version: 3, name: 'session-work',
    tools: ['Edit'], fileContent: 'completed-native-file' } })
  await f.tasks.openLocalContribution(f.grant)
  const result = completedFileToolObservationResultSchema.parse({ kind: 'tool-observation', version: 3, tool: 'Edit',
    reportedStatus: reason === 'tool-failed' ? 'failure' : 'success', omissions: ['oldString', 'newString'],
    fields: { rootIndex: 0, path: 'existing.ts', replaceAll: false }, completedFile: { state: 'omitted', reason } })
  const accepted = await f.tasks.admitLocalContribution({ ...sample(f.grant), result })
  expect(accepted.publication.localToolObservation).toMatchObject({ completedFile: { state: 'omitted', reason } })
  expect(accepted.publication.text).not.toContain('PRIVATE_BASE')
})
