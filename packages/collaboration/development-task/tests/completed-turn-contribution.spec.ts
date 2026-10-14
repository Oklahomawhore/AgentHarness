import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import { afterEach, expect, it } from 'vitest'
import DevelopmentTaskService, { localContributionPayloadDigest, peerContributionPayloadDigest } from '../src/index.ts'
import type { DevelopmentTaskCompletedTurnObservationResult, DevelopmentTaskCompletedTurnObservationSource,
  DevelopmentTaskLocalContributionGrant, DevelopmentTaskPeerContributionGrant, DevelopmentTaskObservedSourceId } from '../src/types.ts'
import { completedTurnObservationResultSchema, localContributionGrantSchema, peerContributionGrantSchema,
  localContributionRequestSchema, peerContributionRequestSchema, developmentTaskEventSchema, developmentTaskContextBlockSchema,
  toolObservationResultSchema, recordedToolObservationResultSchema, completedFileToolObservationResultSchema,
  commandObservationResultSchema, peerContributionResultSchema, localContributionResultSchema } from '../src/schema.ts'
import { localPublicationRequest } from '../src/local.ts'
import { peerPublicationRequest, peerContributionArtifactId } from '../src/peer.ts'

const contexts: Context[] = []
const human = brandString<DevelopmentParticipantId>('human-owner')
const participant = brandString<DevelopmentParticipantId>('agent-source')
const permission: DevelopmentTaskCompletedTurnObservationSource = { kind: 'completed-turn-outcomes', version: 5, name: 'decisions' }
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId: 'turn-owner', presenceTtlMs: 10000,
    maxParticipants: 8, maxRooms: 32, maxTextBytes: 8192 })
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  await rooms.announce({ id: participant, kind: 'agent', displayName: 'Existing Agent' })
  const tasks = new DevelopmentTaskService(ctx, { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
    maxContextBlockBytes: 32768, maxLineageTasks: 32, maxTextBytes: 8192, roomRetryIntervalMs: 10000 })
  return { ctx, rooms, tasks }
}
async function scenario(maxSamples = 2) {
  const host = await setup()
  const task = await host.tasks.create({ origin: { kind: 'root' }, objective: 'Existing project', scope: 'Authorized reports', createdBy: human })
  const { assignment } = await host.tasks.checkout({ taskId: task.id, participantId: participant })
  const epoch = host.tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('Missing original assignment')
  const common = { version: 1, taskId: task.id, captureId: 'capture', captureGeneration: 'generation', source: permission,
    expiresAt: Date.now() + 60000, maxSamples, maxSampleBytes: 8192 }
  const local = localContributionGrantSchema.parse({ ...common, participantId: participant, bindingId: assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } })
  const peer = peerContributionGrantSchema.parse({ ...common, grantId: 'turn-grant', generation: 'grant-generation',
    ownerPeerId: 'owner-peer', contributorPeerId: 'source-peer' })
  return { ...host, task, local, peer }
}
function outcome(text = '  完整答复🙂\r\nA decision and its qualifications.\n'): DevelopmentTaskCompletedTurnObservationResult {
  return { kind: 'completed-turn-outcome', version: 5, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') }
}
function sample<G extends DevelopmentTaskLocalContributionGrant | DevelopmentTaskPeerContributionGrant>(
  grant: G, sequence = 1, text?: string,
) {
  return { grant, result: outcome(text), sequence,
    sourceId: brandString<DevelopmentTaskObservedSourceId>(createHash('sha256').update(`turn-${String(sequence)}`).digest('hex')) }
}

it('requires an independent exact permission and the complete nonempty UTF-8 reply digest', async () => {
  const f = await scenario()
  expect(completedTurnObservationResultSchema.parse(outcome())).toEqual(outcome())
  for (const result of [outcome(''), outcome(' \r\n'), outcome('\ud800'), { ...outcome(), sha256: 'f'.repeat(64) },
    { ...outcome(), text: `${outcome().text}changed` }, { ...outcome(), omissions: ['text'] }, { ...outcome(), version: 4 }]) {
    expect(completedTurnObservationResultSchema.safeParse(result).success).toBe(false)
  }
  for (const source of [{ ...permission, tools: [] }, { ...permission, roots: [] }, { ...permission, commands: [] },
    { ...permission, initialization: 'recorded-local-tools' }, { ...permission, fileContent: 'completed-native-file' },
    { ...permission, version: 4 }, { ...permission, name: ' ' }]) {
    expect(localContributionGrantSchema.safeParse({ ...f.local, source }).success).toBe(false)
    expect(peerContributionGrantSchema.safeParse({ ...f.peer, source }).success).toBe(false)
  }
  for (const schema of [toolObservationResultSchema, recordedToolObservationResultSchema,
    completedFileToolObservationResultSchema, commandObservationResultSchema]) {
    expect(schema.safeParse(outcome()).success).toBe(false)
  }
  for (const source of [{ kind: 'tool-observations', name: 'files', tools: ['Write'] },
    { kind: 'tool-observations', version: 2, initialization: 'recorded-local-tools', name: 'files', tools: ['Write'] },
    { kind: 'tool-observations', version: 3, fileContent: 'completed-native-file', name: 'files', tools: ['Write'] },
    { kind: 'tool-observations', version: 4, commands: [{ command: 'check', rootIndex: 0 }], name: 'commands', tools: [] },
    { name: 'api', method: 'post', path: '/run' }]) {
    expect(peerContributionRequestSchema.safeParse({ ...sample(f.peer), grant: { ...f.peer, source } }).success).toBe(false)
  }
  const tool = { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'file.md', content: 'not authorized' } }
  expect(localContributionRequestSchema.safeParse({ ...sample(f.local), result: tool }).success).toBe(false)
  expect(peerContributionRequestSchema.safeParse({ ...sample(f.peer), result: tool }).success).toBe(false)
  expect(() => peerContributionArtifactId(f.peer)).toThrow('do not identify a replaceable artifact')
})

it('retains independent local replies, exact receipts and full permission through inheritance and restart', async () => {
  const f = await scenario()
  const opened = await f.tasks.openLocalContribution(f.local)
  expect(opened.grant.source).toEqual(permission)
  expect(Object.isFrozen(opened.grant.source)).toBe(true)
  const first = await f.tasks.admitLocalContribution(sample(f.local))
  const second = await f.tasks.admitLocalContribution(sample(f.local, 2, 'Later report does not replace the earlier decision.'))
  expect(localPublicationRequest(first.publication)).toEqual(sample(f.local))
  expect(first.publication.localTurnOutcome).toEqual({ ...sample(f.local).result, sourceId: sample(f.local).sourceId, sequence: 1 })
  expect(first.publication.localToolObservation).toBeUndefined()
  expect(first.publication.text).toContain('not owner-approved facts')
  expect(Object.isFrozen(first.publication.localTurnOutcome)).toBe(true)
  expect(localContributionResultSchema.parse(first)).toEqual(first)
  expect(f.tasks.get({ taskId: f.task.id }).context).toEqual([first.publication, second.publication])
  await expect(f.tasks.admitLocalContribution(sample(f.local, 3))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  const fork = await f.tasks.create({ origin: { kind: 'fork', parent: { taskId: f.task.id,
    revision: f.tasks.get({ taskId: f.task.id }).revision } }, objective: 'Inherited reports', scope: 'Prior work', createdBy: human })
  await f.tasks.endLocalContribution({ grant: f.local, reason: 'left' })
  const restored = await setup()
  restored.tasks.restoreContextBlocks(developmentTaskContextBlockSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.blocks()))))
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  restored.tasks.restoreAssignmentLog(f.tasks.assignmentLog())
  expect((await restored.tasks.admitLocalContribution(sample(f.local))).receipt).toEqual(first.receipt)
  expect(restored.tasks.contextView(fork.id).inherited?.sources[0]?.context).toEqual([first.publication, second.publication])
  expect(await restored.tasks.localContributionStatus({ grant: f.local })).toMatchObject({ state: 'ended', reason: 'left' })
  expect(restored.tasks.get({ taskId: f.task.id }).context.at(-1)?.localTurnOutcome).toBeUndefined()
  await expect(restored.tasks.admitLocalContribution(sample(f.local, 3))).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(localContributionPayloadDigest(sample(f.local, 1, 'changed'))).not.toBe(first.receipt.payloadDigest)
})

it('requires the authenticated peer and counts each complete report without treating later turns as replacements', async () => {
  const f = await scenario()
  await expect(f.tasks.admitPeerContribution(sample(f.peer), f.peer.contributorPeerId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const opened = await f.tasks.openPeerContribution(f.peer)
  expect(Object.isFrozen(opened.grant.source)).toBe(true)
  await expect(f.tasks.admitPeerContribution(sample(f.peer), f.peer.ownerPeerId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const first = await f.tasks.admitPeerContribution(sample(f.peer), f.peer.contributorPeerId)
  const second = await f.tasks.admitPeerContribution(sample(f.peer, 2, 'Separate later outcome.'), f.peer.contributorPeerId)
  expect(peerPublicationRequest(first.publication)).toEqual(sample(f.peer))
  expect(first.publication.peerTurnOutcome).toEqual({ ...outcome(), sourceName: permission.name, grantId: f.peer.grantId,
    sequence: 1, observerPeerId: f.peer.contributorPeerId, sourceId: sample(f.peer).sourceId,
    capture: { id: f.peer.captureId, generation: f.peer.captureGeneration } })
  expect(first.publication.peerToolObservation).toBeUndefined()
  expect(first.publication.text).toContain('not owner-approved facts')
  expect(Object.isFrozen(first.publication.peerTurnOutcome?.capture)).toBe(true)
  expect(peerContributionResultSchema.parse(first)).toEqual(first)
  expect(f.tasks.get({ taskId: f.task.id }).context).toEqual([first.publication, second.publication])
  await expect(f.tasks.admitPeerContribution(sample(f.peer, 3), f.peer.contributorPeerId)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await expect(f.tasks.endPeerContribution({ grant: f.peer, reason: 'revoked' }, f.peer.contributorPeerId))
    .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  await f.tasks.endPeerContribution({ grant: f.peer, reason: 'revoked' }, f.peer.ownerPeerId)
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  expect((await restored.tasks.admitPeerContribution(sample(f.peer), f.peer.contributorPeerId)).receipt).toEqual(first.receipt)
  await expect(restored.tasks.admitPeerContribution(sample(f.peer, 1, 'changed'), f.peer.contributorPeerId))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(restored.tasks.admitPeerContribution(sample(f.peer, 3), f.peer.contributorPeerId)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const terminal = restored.tasks.get({ taskId: f.task.id }).context.at(-1)
  expect(terminal).toMatchObject({ peerContribution: { grant: f.peer, ended: 'revoked' } })
  expect(terminal?.peerTurnOutcome).toBeUndefined()
  expect(terminal?.text).not.toContain(outcome().text)
  expect(peerContributionPayloadDigest(sample(f.peer, 1, 'changed'))).not.toBe(first.receipt.payloadDigest)
})

it('rejects durable attribution tampering and conflicting sample sequences rather than accepting arbitrary reply text', async () => {
  const f = await scenario(4)
  await f.tasks.openPeerContribution(f.peer)
  await f.tasks.openLocalContribution(f.local)
  const peer = await f.tasks.admitPeerContribution(sample(f.peer), f.peer.contributorPeerId)
  const local = await f.tasks.admitLocalContribution(sample(f.local))
  for (const publication of [peer.publication, local.publication]) {
    const record = f.tasks.log().find(item => item.change.kind === 'context-published' && item.change.publication.id === publication.id)
    if (record?.change.kind !== 'context-published') throw new Error('Missing admitted report')
    for (const changed of [{ ...publication, text: 'owner has approved everything' },
      publication.peerTurnOutcome === undefined
        ? { ...publication, localTurnOutcome: { ...publication.localTurnOutcome, sequence: 2 } }
        : { ...publication, peerTurnOutcome: { ...publication.peerTurnOutcome, sourceName: 'forged source' } }]) {
      const restored = await setup()
      const entries = f.tasks.log().map(item => item === record ? { ...item, change: { ...record.change, publication: changed } } : item)
      expect(() => { restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(entries)))) }).toThrow()
    }
  }
  await expect(f.tasks.admitPeerContribution({ ...sample(f.peer, 2), sequence: 1 }, f.peer.contributorPeerId)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(f.tasks.admitLocalContribution({ ...sample(f.local, 2), sequence: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
})
