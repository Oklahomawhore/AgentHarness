import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import { afterEach, expect, it } from 'vitest'
import DevelopmentTaskService from '../src/index.ts'
import type { DevelopmentTaskLocalContributionObservationResult, DevelopmentTaskNativeWorkSource,
  DevelopmentTaskObservedSourceId } from '../src/types.ts'
import { nativeWorkSourceSchema, localContributionGrantSchema, peerContributionGrantSchema,
  localContributionRequestSchema, peerContributionRequestSchema, developmentTaskEventSchema,
  localContributionResultSchema, peerContributionResultSchema } from '../src/schema.ts'
import { localContributionPayloadDigest, localPublicationRequest } from '../src/local.ts'
import { peerContributionPayloadDigest, peerPublicationRequest } from '../src/peer.ts'
import { nativeWorkResultValues, nativeWorkSourceValues, freezeNativeWorkSource } from '../src/native-work.ts'

const contexts: Context[] = []
const human = brandString<DevelopmentParticipantId>('native-work-owner')
const participant = brandString<DevelopmentParticipantId>('native-work-agent')
const source: DevelopmentTaskNativeWorkSource = { kind: 'native-work', version: 6, name: 'My responsibility',
  tools: ['Write', 'Edit'], commands: [{ command: 'verify', rootIndex: 0 }], completedTurns: true }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const file = { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
  fields: { rootIndex: 0, path: 'work.txt', content: 'implemented' }, omissions: [] } as const
const command = { kind: 'command-observation', version: 4, tool: 'Bash',
  fields: { rootIndex: 0, command: 'verify' }, state: 'unavailable', reason: 'tool-failed' } as const
const answer = { kind: 'completed-turn-outcome', version: 5, text: 'An Agent report, with qualifications.',
  sha256: hash('An Agent report, with qualifications.') } as const
const sample = (result: DevelopmentTaskLocalContributionObservationResult, sequence = 1) => ({
  result, sequence, sourceId: brandString<DevelopmentTaskObservedSourceId>(hash(`work-${String(sequence)}`)),
})
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId: 'native-work-owner', presenceTtlMs: 10000,
    maxParticipants: 8, maxRooms: 32, maxTextBytes: 8192 })
  for (const id of [human, participant]) await rooms.announce({ id, kind: id === human ? 'human' : 'agent', displayName: id })
  const tasks = new DevelopmentTaskService(ctx, { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
    maxContextBlockBytes: 32768, maxLineageTasks: 32, maxTextBytes: 8192, roomRetryIntervalMs: 10000 })
  return { tasks }
}
async function fixture() {
  const { tasks } = await setup()
  const task = await tasks.create({ origin: { kind: 'root' }, objective: 'Original responsibility', scope: 'Shared goal', createdBy: human })
  const { assignment } = await tasks.checkout({ taskId: task.id, participantId: participant })
  const epoch = tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('Missing assignment epoch')
  const common = { version: 1, taskId: task.id, captureId: 'capture', captureGeneration: 'generation', source,
    expiresAt: Date.now() + 60000, maxSamples: 3, maxSampleBytes: 8192 }
  const local = localContributionGrantSchema.parse({ ...common, participantId: participant, bindingId: assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } })
  const peer = peerContributionGrantSchema.parse({ ...common, grantId: 'grant', generation: 'generation',
    ownerPeerId: 'owner-peer', contributorPeerId: 'source-peer' })
  return { tasks, task, local, peer }
}

it('requires explicit nonempty categories and rejects roots, initialization and malformed selectors', () => {
  for (const invalid of [{ ...source, tools: [], commands: [], completedTurns: false },
    { ...source, tools: undefined }, { ...source, commands: undefined }, { ...source, completedTurns: undefined },
    { ...source, roots: [] }, { ...source, initialization: 'recorded-local-tools' }, { ...source, version: 5 },
    { ...source, tools: ['Write', 'Write'] }, { ...source, commands: [...source.commands, ...source.commands] },
    { ...source, commands: [{ command: 'verify\0secret', rootIndex: 0 }] },
    { ...source, tools: [], fileContent: 'completed-native-file' }]) {
    expect(nativeWorkSourceSchema.safeParse(invalid).success).toBe(false)
  }
})

it('admits exactly selected categories for every nonempty combination without upgrading old authority', async () => {
  const f = await fixture()
  for (let mask = 1; mask < 8; mask++) {
    const selected = nativeWorkSourceSchema.parse({ ...source, tools: mask & 1 ? ['Write'] : [],
      commands: mask & 2 ? source.commands : [], completedTurns: Boolean(mask & 4) })
    for (const [result, enabled] of [[file, mask & 1], [command, mask & 2], [answer, mask & 4]] as const) {
      expect(localContributionRequestSchema.safeParse({ grant: { ...f.local, source: selected }, ...sample(result) }).success)
        .toBe(Boolean(enabled))
      expect(peerContributionRequestSchema.safeParse({ grant: { ...f.peer, source: selected }, ...sample(result) }).success)
        .toBe(Boolean(enabled))
    }
  }
  const recorded = { ...file, version: 2, origin: { kind: 'recorded-local-tools', planDigest: hash('plan'), executionDigest: hash('execution') } }
  expect(peerContributionRequestSchema.safeParse({ grant: f.peer, ...sample(file), result: recorded }).success).toBe(false)
  expect(peerContributionRequestSchema.safeParse({ grant: f.peer, ...sample(file), result: { state: 'unavailable', reason: 'missing' } }).success).toBe(false)
  const complete = { ...file, version: 3, completedFile: { state: 'included', content: 'implemented', sha256: hash('implemented') } } as const
  for (const [schema, grant] of [[localContributionRequestSchema, f.local], [peerContributionRequestSchema, f.peer]] as const) {
    expect(schema.safeParse({ grant, ...sample(complete) }).success).toBe(false)
    const selected = { ...grant, source: { ...source, fileContent: 'completed-native-file' } }
    expect(schema.safeParse({ grant: selected, ...sample(complete) }).success).toBe(true)
    expect(schema.safeParse({ grant: selected, ...sample(file) }).success).toBe(false)
    expect(schema.safeParse({ grant, ...sample({ ...command, fields: { command: 'verify ', rootIndex: 0 } }) }).success).toBe(false)
    expect(schema.safeParse({ grant, ...sample({ ...command, fields: { command: 'verify', rootIndex: 1 } }) }).success).toBe(false)
  }
  for (const old of [{ kind: 'tool-observations', name: 'files', tools: ['Write'] },
    { kind: 'completed-turn-outcomes', version: 5, name: 'answers' }]) {
    expect(peerContributionGrantSchema.safeParse({ ...f.peer, source: { ...old, completedTurns: true, commands: [] } }).success).toBe(false)
  }
})

it.each(['local', 'peer'] as const)('keeps all %s categories under one immutable allowance and termination across restore', async (role) => {
  const f = await fixture()
  const grant = role === 'local' ? f.local : f.peer
  const opened = role === 'local' ? await f.tasks.openLocalContribution(f.local) : await f.tasks.openPeerContribution(f.peer)
  expect(opened.grant.source).toEqual(source)
  expect(Object.isFrozen(opened.grant.source)).toBe(true)
  if (opened.grant.source.kind !== 'native-work') throw new Error('Expected combined source')
  expect(Object.isFrozen(opened.grant.source.tools)).toBe(true)
  expect(Object.isFrozen(opened.grant.source.commands[0])).toBe(true)
  const admit = (result: DevelopmentTaskLocalContributionObservationResult, sequence: number) => role === 'local'
    ? f.tasks.admitLocalContribution({ grant: f.local, ...sample(result, sequence) })
    : f.tasks.admitPeerContribution({ grant: f.peer, ...sample(result, sequence) }, f.peer.contributorPeerId)
  const admitted = []
  for (const [index, result] of [file, command, answer].entries()) admitted.push(await admit(result, index + 1))
  for (const [index, result] of admitted.entries()) {
    const request = role === 'local' ? localPublicationRequest(result.publication) : peerPublicationRequest(result.publication)
    expect(request).toEqual({ grant, ...sample([file, command, answer][index]!, index + 1) })
    expect((role === 'local' ? localContributionResultSchema : peerContributionResultSchema).parse(result)).toEqual(result)
  }
  expect(admitted[2]?.publication.text).toContain('not owner-approved facts')
  await expect(admit(answer, 4)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  if (role === 'local') await f.tasks.endLocalContribution({ grant: f.local, reason: 'revoked' })
  else await f.tasks.endPeerContribution({ grant: f.peer, reason: 'revoked' }, f.peer.ownerPeerId)
  const restored = await setup()
  restored.tasks.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  restored.tasks.restoreAssignmentLog(f.tasks.assignmentLog())
  const retry = role === 'local' ? await restored.tasks.admitLocalContribution({ grant: f.local, ...sample(answer, 3) })
    : await restored.tasks.admitPeerContribution({ grant: f.peer, ...sample(answer, 3) }, f.peer.contributorPeerId)
  expect(retry.receipt).toEqual(admitted[2]?.receipt)
  expect(restored.tasks.get({ taskId: f.task.id }).context).toHaveLength(4)
  const late = role === 'local' ? restored.tasks.admitLocalContribution({ grant: f.local, ...sample(answer, 4) })
    : restored.tasks.admitPeerContribution({ grant: f.peer, ...sample(answer, 4) }, f.peer.contributorPeerId)
  await expect(late).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  const tampered = JSON.parse(JSON.stringify(f.tasks.log())) as unknown[]
  for (const raw of tampered) {
    if (typeof raw !== 'object' || raw === null || !('change' in raw)) continue
    const change = raw.change
    if (typeof change !== 'object' || change === null || !('publication' in change)) continue
    const publication = change.publication
    if (typeof publication !== 'object' || publication === null || !('text' in publication)) continue
    publication.text = 'Owner-approved fact'
  }
  const invalid = await setup()
  expect(() => { invalid.tasks.restoreLog(developmentTaskEventSchema.array().parse(tampered)) }).toThrow()
})

it('binds every selected category and complete result while preserving object-order independence', async () => {
  const f = await fixture()
  const peer = { grant: f.peer, ...sample(file) }
  const local = { grant: f.local, ...sample(file) }
  for (const changed of [{ ...source, name: 'Other' }, { ...source, tools: ['Write'] as const },
    { ...source, commands: [] }, { ...source, completedTurns: false }, { ...source, fileContent: 'completed-native-file' as const }]) {
    expect(peerContributionPayloadDigest({ ...peer, grant: { ...f.peer, source: changed } })).not.toBe(peerContributionPayloadDigest(peer))
    expect(localContributionPayloadDigest({ ...local, grant: { ...f.local, source: changed } }))
      .not.toBe(localContributionPayloadDigest(local))
  }
  const reordered = { completedTurns: true, commands: source.commands, tools: source.tools,
    name: source.name, version: 6, kind: 'native-work' } as const
  expect(peerContributionPayloadDigest({ ...peer, grant: { ...f.peer, source: reordered } })).toBe(peerContributionPayloadDigest(peer))
  expect(localContributionPayloadDigest({ ...local, grant: { ...f.local, source: reordered } })).toBe(localContributionPayloadDigest(local))
  expect(freezeNativeWorkSource({ ...source, fileContent: 'completed-native-file' }).fileContent).toBe('completed-native-file')
  expect(nativeWorkSourceValues(source)).toEqual(['native-work', 6, source.name, ['Write', 'Edit'], [['verify', 0]], true, null])
  const edit = { ...file, tool: 'Edit', fields: { rootIndex: 0, path: 'work.txt', replaceAll: false },
    omissions: ['oldString', 'newString'] } as const
  const values: DevelopmentTaskLocalContributionObservationResult[] = [file, command, answer, edit,
    { ...file, reportedStatus: 'failure', fields: { rootIndex: 0, path: 'work.txt', error: 'denied' }, omissions: ['content'] },
    { ...edit, fields: { ...edit.fields, oldString: 'old', newString: 'new' }, omissions: [] },
    { ...file, version: 3, completedFile: { state: 'included', content: 'implemented', sha256: hash('implemented') } },
    { ...file, version: 3, completedFile: { state: 'omitted', reason: 'budget' } }]
  expect(new Set(values.map(result => JSON.stringify(nativeWorkResultValues(result)))).size).toBe(values.length)
})
