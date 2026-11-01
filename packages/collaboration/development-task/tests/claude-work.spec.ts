import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import { afterEach, expect, it } from 'vitest'
import DevelopmentTaskService from '../src/index.ts'
import { claudeWorkSourceSchema, claudeCommandObservationResultSchema, claudeStopReportResultSchema,
  localContributionGrantSchema, localContributionObservationResultSchema, peerContributionGrantSchema,
  peerContributionRequestSchema, peerContributionResultSchema, developmentTaskEventSchema } from '../src/schema.ts'
import { peerContributionPayloadDigest, peerPublicationRequest } from '../src/peer.ts'
import type { DevelopmentTaskPeerContributionObservationResult, DevelopmentTaskObservedSourceId } from '../src/types.ts'

const contexts: Context[] = []
const human = brandString<DevelopmentParticipantId>('claude-owner')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const source = { kind: 'claude-work', version: 7, name: 'Selected Claude work', tools: ['Write', 'Edit'],
  commands: [{ command: 'verify', rootIndex: 0 }], stopReports: true } as const
const file = { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
  fields: { rootIndex: 0, path: 'work.txt', content: 'work' }, omissions: [] } as const
const command = { kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent: 'PostToolUse',
  fields: { rootIndex: 0, command: 'verify', stdout: 'ordinary output', stderr: '', interrupted: false }, omissions: [] } as const
const stop = { kind: 'claude-stop-report', version: 7, text: 'Complete report 🙂\r\n',
  sha256: hash('Complete report 🙂\r\n'), stopHookActive: false } as const
const sample = (result: DevelopmentTaskPeerContributionObservationResult, sequence = 1) => ({ result, sequence,
  sourceId: brandString<DevelopmentTaskObservedSourceId>(hash(`sample-${sequence}`)) })
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, { nodeId: 'claude-owner', presenceTtlMs: 10000,
    maxParticipants: 8, maxRooms: 32, maxTextBytes: 8192 })
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  return new DevelopmentTaskService(ctx, { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4,
    maxContextBlockBytes: 32768, maxLineageTasks: 32, maxTextBytes: 8192, roomRetryIntervalMs: 10000 })
}
async function fixture() {
  const tasks = await setup()
  const task = await tasks.create({ origin: { kind: 'root' }, objective: 'Original Claude work', scope: 'Explicit reports', createdBy: human })
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: task.id, grantId: 'grant', generation: 'generation',
    ownerPeerId: 'owner-peer', contributorPeerId: 'source-peer', captureId: 'capture', captureGeneration: 'capture-generation',
    source, expiresAt: Date.now() + 60000, maxSamples: 3, maxSampleBytes: 8192 })
  return { tasks, task, grant }
}

it('keeps every selected Claude category explicit and separate from native and recorded permission', async () => {
  const f = await fixture()
  for (const invalid of [{ ...source, tools: [], commands: [], stopReports: false }, { ...source, stopReports: undefined },
    { ...source, tools: ['Write', 'Write'] }, { ...source, commands: [...source.commands, ...source.commands] },
    { ...source, initialization: 'recorded-local-tools' }, { ...source, fileContent: 'completed-native-file' }]) {
    expect(claudeWorkSourceSchema.safeParse(invalid).success).toBe(false)
  }
  for (let mask = 1; mask < 8; mask++) {
    const selected = { ...source, tools: mask & 1 ? ['Write'] : [], commands: mask & 2 ? source.commands : [], stopReports: Boolean(mask & 4) }
    for (const [result, allowed] of [[file, mask & 1], [command, mask & 2], [stop, mask & 4]] as const) {
      const parsed = peerContributionRequestSchema.safeParse({ grant: { ...f.grant, source: selected }, ...sample(result) })
      expect(parsed.success).toBe(Boolean(allowed))
    }
  }
  const native = { kind: 'native-work', version: 6, name: 'native', tools: ['Write'], commands: source.commands, completedTurns: true }
  for (const result of [command, stop]) {
    expect(peerContributionRequestSchema.safeParse({ grant: { ...f.grant, source: native }, ...sample(result) }).success).toBe(false)
    expect(localContributionObservationResultSchema.safeParse(result).success).toBe(false)
  }
  for (const result of [{ ...file, version: 3, completedFile: { state: 'included', content: 'work', sha256: hash('work') } },
    { kind: 'command-observation', version: 4, tool: 'Bash', fields: command.fields, state: 'unavailable', reason: 'tool-failed' },
    { kind: 'completed-turn-outcome', version: 5, text: stop.text, sha256: stop.sha256 },
    { ...command, fields: { ...command.fields, rootIndex: 1 } }, { ...command, fields: { ...command.fields, command: 'other' } }]) {
    expect(peerContributionRequestSchema.safeParse({ grant: f.grant, ...sample(file), result }).success).toBe(false)
  }
  const localGrant = { version: 1, taskId: f.task.id, participantId: human, bindingId: 'binding',
    expectedBindingEpoch: { nodeId: 'node', seq: 1 }, captureId: f.grant.captureId, captureGeneration: f.grant.captureGeneration,
    source, expiresAt: f.grant.expiresAt, maxSamples: f.grant.maxSamples, maxSampleBytes: f.grant.maxSampleBytes }
  expect(localContributionGrantSchema.safeParse({ ...localGrant, source: native }).success).toBe(true)
  expect(localContributionGrantSchema.safeParse(localGrant).success).toBe(false)
})

it('accepts only original Bash fields, whole-field omissions and exact complete Stop text', () => {
  for (const valid of [command,
    { ...command, fields: { rootIndex: 0, command: 'verify', interrupted: true }, omissions: ['stdout', 'stderr'] },
    { ...command, fields: { rootIndex: 0, command: 'verify' }, omissions: ['unsupported-tool-response'] },
    { ...command, hookEvent: 'PostToolUseFailure', fields: { rootIndex: 0, command: 'verify', error: 'Exit code 7' } },
    { ...command, hookEvent: 'PostToolUseFailure', fields: { rootIndex: 0, command: 'verify' }, omissions: ['error'] }]) {
    expect(claudeCommandObservationResultSchema.safeParse(valid).success).toBe(true)
  }
  for (const invalid of [{ ...command, exitCode: 0 }, { ...command, fields: { ...command.fields, error: 'failure' } },
    { ...command, fields: { rootIndex: 0, command: 'verify', stdout: '', stderr: '' } },
    { ...command, omissions: ['stdout'] }, { ...command, omissions: ['unsupported-tool-response'] },
    { ...command, hookEvent: 'PostToolUseFailure' }, { ...command, omissions: ['stdout', 'stdout'] }]) {
    expect(claudeCommandObservationResultSchema.safeParse(invalid).success).toBe(false)
  }
  expect(claudeStopReportResultSchema.parse(stop)).toEqual(stop)
  for (const invalid of [{ ...stop, sha256: hash(stop.text.trim()) }, { ...stop, text: '' },
    { ...stop, promptId: 'private' }, { ...stop, stopHookActive: undefined }]) {
    expect(claudeStopReportResultSchema.safeParse(invalid).success).toBe(false)
  }
})

it('shares one allowance, restores exact reports and receipts, and withdraws Stop with the original capture', async () => {
  const f = await fixture()
  await f.tasks.openPeerContribution(f.grant)
  const admitted = []
  for (const [index, result] of [file, command, stop].entries()) {
    const request = { grant: f.grant, ...sample(result, index + 1) }
    const receipt = await f.tasks.admitPeerContribution(request, f.grant.contributorPeerId)
    admitted.push(receipt)
    expect(peerPublicationRequest(receipt.publication)).toEqual(request)
    expect(peerContributionResultSchema.parse(receipt)).toEqual(receipt)
  }
  expect(admitted[2]?.publication.peerStopReport).toMatchObject(stop)
  expect(admitted[2]?.publication.peerTurnOutcome).toBeUndefined()
  expect(admitted[2]?.publication.text).toContain('not proof that the turn ended')
  expect(Object.isFrozen(admitted[1]?.publication.peerToolObservation?.fields)).toBe(true)
  expect(Object.isFrozen(admitted[2]?.publication.peerStopReport?.capture)).toBe(true)
  await expect(f.tasks.admitPeerContribution({ grant: f.grant, ...sample(stop, 4) }, f.grant.contributorPeerId))
    .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  const restored = await setup()
  restored.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.tasks.log()))))
  const restoredSample = await restored.admitPeerContribution({ grant: f.grant, ...sample(stop, 3) }, f.grant.contributorPeerId)
  expect(restoredSample.receipt).toEqual(admitted[2]?.receipt)
  await restored.endPeerContribution({ grant: f.grant, reason: 'left' }, f.grant.contributorPeerId)
  const reopened = await setup()
  reopened.restoreLog(developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(restored.log()))))
  const reopenedSample = await reopened.admitPeerContribution({ grant: f.grant, ...sample(stop, 3) }, f.grant.contributorPeerId)
  expect(reopenedSample.receipt).toEqual(admitted[2]?.receipt)
  expect(reopened.get({ taskId: f.task.id }).context.at(-1)?.peerContribution?.ended).toBe('left')
  await expect(reopened.admitPeerContribution({ grant: f.grant, ...sample(stop, 4) }, f.grant.contributorPeerId))
    .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
})

it('binds exact original output, Stop state and every selected category to receipts', async () => {
  const f = await fixture()
  const original = { grant: f.grant, ...sample(command) }
  const { stdout: _stdout, ...withoutStdout } = command.fields
  for (const result of [{ ...command, fields: { ...command.fields, stdout: 'changed' } },
    { ...command, fields: { ...command.fields, interrupted: true } },
    { ...command, fields: withoutStdout, omissions: ['stdout'] as const }]) {
    expect(peerContributionPayloadDigest({ ...original, result })).not.toBe(peerContributionPayloadDigest(original))
  }
  expect(peerContributionPayloadDigest({ grant: f.grant, ...sample({ ...stop, stopHookActive: true }) }))
    .not.toBe(peerContributionPayloadDigest({ grant: f.grant, ...sample(stop) }))
  for (const selected of [{ ...source, tools: ['Write'] as const }, { ...source, commands: [] }, { ...source, stopReports: false }]) {
    const digest = peerContributionPayloadDigest({ ...original, grant: { ...f.grant, source: selected } })
    expect(digest).not.toBe(peerContributionPayloadDigest(original))
  }
})
