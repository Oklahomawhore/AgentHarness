import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import { afterEach, expect, it } from 'vitest'
import DevelopmentTaskService, { localContributionPayloadDigest, peerContributionPayloadDigest } from '../src/index.ts'
import type { DevelopmentTaskCommandObservationResult, DevelopmentTaskCommandToolObservationSource,
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskPeerContributionGrant, DevelopmentTaskObservedSourceId } from '../src/types.ts'
import { commandSelectorSchema, commandObservationResultSchema, localContributionGrantSchema, peerContributionGrantSchema,
  localContributionRequestSchema, peerContributionRequestSchema, developmentTaskEventSchema, developmentTaskContextBlockSchema,
  toolObservationResultSchema, recordedToolObservationResultSchema, completedFileToolObservationResultSchema } from '../src/schema.ts'
import { localPublicationRequest } from '../src/local.ts'
import { peerPublicationRequest } from '../src/peer.ts'

const contexts: Context[] = []
const human = brandString<DevelopmentParticipantId>('human-owner')
const participant = brandString<DevelopmentParticipantId>('agent-source')
const permission: DevelopmentTaskCommandToolObservationSource = { kind: 'tool-observations', version: 4, name: 'verification',
  tools: [], commands: [{ command: 'pnpm test --run', rootIndex: 0 }] }

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId: 'command-owner', presenceTtlMs: 10000,
    maxParticipants: 8, maxRooms: 32, maxTextBytes: 8192 })
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  await rooms.announce({ id: participant, kind: 'agent', displayName: 'Existing Agent' })
  const tasks = new DevelopmentTaskService(ctx, { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
    maxContextBlockBytes: 32768, maxLineageTasks: 32, maxTextBytes: 8192, roomRetryIntervalMs: 10000 })
  return { ctx, rooms, tasks }
}
async function scenario(source = permission) {
  const host = await setup()
  const task = await host.tasks.create({ origin: { kind: 'root' }, objective: 'Existing project', scope: 'Authorized outcomes', createdBy: human })
  const { assignment } = await host.tasks.checkout({ taskId: task.id, participantId: participant })
  const epoch = host.tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('Missing original assignment')
  const common = { version: 1, taskId: task.id, captureId: 'capture', captureGeneration: 'generation', source,
    expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 8192 }
  const local = localContributionGrantSchema.parse({ ...common, participantId: participant, bindingId: assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } })
  const peer = peerContributionGrantSchema.parse({ ...common, grantId: 'command-grant', generation: 'grant-generation',
    ownerPeerId: 'owner-peer', contributorPeerId: 'source-peer' })
  return { ...host, task, local, peer }
}
function outcome(exitCode: number | null = 0): DevelopmentTaskCommandObservationResult {
  return { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'pnpm test --run', rootIndex: 0 },
    state: 'completed', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 30000,
    stdout: { state: 'included', text: '检查🙂 completed\n', truncated: false },
    stderr: { state: 'included', text: '', truncated: false } }
}
function sample<G extends DevelopmentTaskLocalContributionGrant | DevelopmentTaskPeerContributionGrant>(
  grant: G, result = outcome(), sequence = 1,
) {
  return { grant, result, sequence, sourceId: brandString<DevelopmentTaskObservedSourceId>(
    createHash('sha256').update(`command-${String(sequence)}`).digest('hex')) }
}

it('requires an explicit command source and exact selectors without silently adding file permission', async () => {
  const f = await scenario()
  const opened = await f.tasks.openLocalContribution(f.local)
  expect(opened.grant.source).toEqual(permission)
  if (opened.grant.source.version !== 4) throw new Error('Missing command permission')
  expect(Object.isFrozen(opened.grant.source.commands[0])).toBe(true)
  for (const source of [
    { ...permission, commands: [] }, { ...permission, commands: [...permission.commands, ...permission.commands] },
    { ...permission, fileContent: 'completed-native-file' }, { ...permission, initialization: 'recorded-local-tools' },
    { kind: 'tool-observations', name: 'old', tools: ['Write'], commands: permission.commands },
    { ...permission, version: 3, fileContent: 'completed-native-file', tools: ['Edit'] },
  ]) expect(localContributionGrantSchema.safeParse({ ...f.local, source }).success).toBe(false)
  for (const fields of [{ command: '', rootIndex: 0 }, { command: ' \n', rootIndex: 0 },
    { command: 'echo\0secret', rootIndex: 0 }, { command: 'pnpm test', rootIndex: -1 }]) {
    expect(commandSelectorSchema.safeParse(fields).success).toBe(false)
  }
  for (const fields of [{ command: 'pnpm test --run ', rootIndex: 0 }, { command: 'pnpm test --run', rootIndex: 1 }]) {
    await expect(f.tasks.admitLocalContribution(sample(f.local, { ...outcome(), fields })))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }
  const file = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'file.ts', content: 'not authorized' }, omissions: [] })
  expect(localContributionRequestSchema.safeParse({ ...sample(f.local), result: file }).success).toBe(false)
  const old = { ...f.local, source: { kind: 'tool-observations', name: 'old', tools: ['Write'] } }
  expect(localContributionRequestSchema.safeParse({ ...sample(f.local), grant: old }).success).toBe(false)
})

it('preserves failure, timeout, signal and truncated output independently without fabricating an exit', () => {
  const completed = outcome()
  if (completed.state !== 'completed') throw new Error('Missing completed fixture')
  const variants = [completed, { ...completed, exitCode: 2 }, { ...completed, exitCode: null, signal: 'SIGTERM', timedOut: true },
    { ...completed, exitCode: null, signal: 'SIGINT', aborted: true },
    { ...completed, stdout: { state: 'omitted' as const, reason: 'budget' as const, truncated: true },
      stderr: { state: 'included' as const, text: 'reported provider prefix', truncated: true } },
    { kind: 'command-observation', version: 4, tool: 'Bash', fields: completed.fields,
      state: 'unavailable', reason: 'tool-failed' },
    { kind: 'command-observation', version: 4, tool: 'Bash', fields: completed.fields,
      state: 'unavailable', reason: 'completion-unavailable' }]
  for (const value of variants) {
    expect(commandObservationResultSchema.parse(value)).toEqual(value)
    expect(toolObservationResultSchema.safeParse(value).success).toBe(false)
    expect(recordedToolObservationResultSchema.safeParse(value).success).toBe(false)
    expect(completedFileToolObservationResultSchema.safeParse(value).success).toBe(false)
  }
  expect(commandObservationResultSchema.safeParse({ ...variants[5], exitCode: 0 }).success).toBe(false)
  expect(commandObservationResultSchema.safeParse({ ...completed, stdout: { state: 'included', text: 'missing truncation' } }).success).toBe(false)
  expect(commandObservationResultSchema.safeParse({ ...completed, stderr: { state: 'omitted', reason: 'budget', truncated: false,
    text: 'must be wholly omitted' } }).success).toBe(false)
})

it('retains exact local outcome evidence and receipts through restart, inheritance and withdrawal', async () => {
  const f = await scenario()
  await f.tasks.openLocalContribution(f.local)
  const first = await f.tasks.admitLocalContribution(sample(f.local))
  const failed = await f.tasks.admitLocalContribution(sample(f.local, outcome(1), 2))
  expect(localPublicationRequest(first.publication)).toEqual(sample(f.local))
  expect(first.publication.text).toContain('one execution, not verification of current code')
  expect(first.publication.localToolObservation).toMatchObject({ state: 'completed', exitCode: 0 })
  expect(failed.publication.localToolObservation).toMatchObject({ state: 'completed', exitCode: 1 })
  const tool = first.publication.localToolObservation
  if (tool?.kind !== 'command-observation' || tool.state !== 'completed') throw new Error('Missing command evidence')
  expect(Object.isFrozen(tool.stdout)).toBe(true)
  const fork = await f.tasks.create({ origin: { kind: 'fork', parent: { taskId: f.task.id,
    revision: f.tasks.get({ taskId: f.task.id }).revision } }, objective: 'Inherited reports', scope: 'Prior work', createdBy: human })
  await f.tasks.endLocalContribution({ grant: f.local, reason: 'left' })
  const restored = await setup()
  restored.tasks.restoreContextBlocks(developmentTaskContextBlockSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.blocks()))))
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  restored.tasks.restoreAssignmentLog(f.tasks.assignmentLog())
  expect((await restored.tasks.admitLocalContribution(sample(f.local))).receipt).toEqual(first.receipt)
  expect(restored.tasks.contextView(fork.id).inherited?.sources[0]?.context).toContainEqual(failed.publication)
  expect(await restored.tasks.localContributionStatus({ grant: f.local })).toMatchObject({ state: 'ended', reason: 'left' })
  await expect(restored.tasks.admitLocalContribution(sample(f.local, outcome(), 3))).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(localContributionPayloadDigest(sample(f.local, outcome(1)))).not.toBe(first.receipt.payloadDigest)
})

it('admits authenticated command evidence while preserving exact grants and output receipt identity', async () => {
  const f = await scenario()
  const opened = await f.tasks.openPeerContribution(f.peer)
  if (opened.grant.source.kind !== 'tool-observations' || opened.grant.source.version !== 4) throw new Error('Missing command grant')
  expect(Object.isFrozen(opened.grant.source.commands[0])).toBe(true)
  await expect(f.tasks.admitPeerContribution(sample(f.peer), f.peer.ownerPeerId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const first = await f.tasks.admitPeerContribution(sample(f.peer), f.peer.contributorPeerId)
  expect(peerPublicationRequest(first.publication)).toEqual(sample(f.peer))
  expect(first.publication.text).toContain('not independently verified this execution')
  const tool = first.publication.peerToolObservation
  if (tool?.kind !== 'command-observation' || tool.state !== 'completed') throw new Error('Missing command evidence')
  expect(Object.isFrozen(tool.stderr)).toBe(true)
  const unavailable: DevelopmentTaskCommandObservationResult = { kind: 'command-observation', version: 4, tool: 'Bash',
    fields: { command: 'pnpm test --run', rootIndex: 0 }, state: 'unavailable', reason: 'completion-unavailable' }
  const second = await f.tasks.admitPeerContribution(sample(f.peer, unavailable, 2), f.peer.contributorPeerId)
  expect(peerPublicationRequest(second.publication).result).toEqual(unavailable)
  expect(peerContributionPayloadDigest(sample(f.peer, unavailable))).not.toBe(first.receipt.payloadDigest)
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  expect((await restored.tasks.admitPeerContribution(sample(f.peer), f.peer.contributorPeerId)).receipt).toEqual(first.receipt)
  await expect(restored.tasks.admitPeerContribution(sample(f.peer, outcome(1)), f.peer.contributorPeerId))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await restored.tasks.endPeerContribution({ grant: f.peer, reason: 'left' }, f.peer.contributorPeerId)
  expect((await restored.tasks.currentContextView(f.task.id)).task.context.at(-1)).toMatchObject({
    peerContribution: { grant: f.peer, ended: 'left' },
  })
  expect(restored.tasks.peerContributions({ taskId: f.task.id })).toEqual([
    expect.objectContaining({ state: 'ended', reason: 'left' }),
  ])
  expect(peerContributionRequestSchema.safeParse({ ...sample(f.peer), grant: { ...f.peer,
    source: { kind: 'tool-observations', name: 'old', tools: ['Write'] } } }).success).toBe(false)
})

it('keeps mixed file and command permissions distinct including completed-file disclosure', async () => {
  const f = await scenario({ ...permission, tools: ['Write'], fileContent: 'completed-native-file' })
  await f.tasks.openLocalContribution(f.local)
  await f.tasks.openPeerContribution(f.peer)
  const content = 'explicit complete file\n'
  const file = completedFileToolObservationResultSchema.parse({ kind: 'tool-observation', version: 3, tool: 'Write',
    reportedStatus: 'success', fields: { rootIndex: 0, path: 'file.ts', content }, omissions: [],
    completedFile: { state: 'included', content, sha256: createHash('sha256').update(content).digest('hex') } })
  await f.tasks.admitLocalContribution({ ...sample(f.local), result: file })
  await f.tasks.admitPeerContribution({ ...sample(f.peer), result: file }, f.peer.contributorPeerId)
  await f.tasks.admitLocalContribution(sample(f.local, outcome(), 2))
  await f.tasks.admitPeerContribution(sample(f.peer, outcome(), 2), f.peer.contributorPeerId)
  const withoutFull: DevelopmentTaskPeerContributionGrant = { ...f.peer, source: { ...permission, tools: ['Write'] as const } }
  expect(peerContributionRequestSchema.safeParse({ ...sample(withoutFull), result: file }).success).toBe(false)
  const original = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, tool: 'Write',
    reportedStatus: 'success', fields: { rootIndex: 0, path: 'file.ts', content }, omissions: [] })
  expect(peerContributionRequestSchema.safeParse({ ...sample(withoutFull), result: original }).success).toBe(true)
  expect(peerContributionRequestSchema.safeParse({ ...sample(f.peer), result: original }).success).toBe(false)
})
