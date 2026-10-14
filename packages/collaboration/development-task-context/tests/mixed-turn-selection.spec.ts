/** Independent completed answers receive bounded source opportunities alongside current command reports. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { localContributionRequestSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { localPublication } from '@deepseek-ai/dsh-development-task/src/local.ts'
import { peerPublication, peerWithdrawals } from '@deepseek-ai/dsh-development-task/src/peer.ts'
import type { DevelopmentTaskContextPublication } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import ReportedBackend from '../src/reported.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const taskId = 'ea2e92dd-a4a5-4b90-89f8-6f2760e39b1a'
const commands = ['node verify-payment.js', 'node check-syntax.js', 'node check-types.js',
  'node verify-package.js', 'node verify-release.js']
const reportText = 'OUTCOME_HOLD: the customer approval is still pending; keep the release disabled.'
function hash(text: string) { return createHash('sha256').update(text).digest('hex') }
function peerGrant(kind: 'command' | 'answer') {
  return { version: 1, taskId, ownerPeerId: '1'.repeat(64), contributorPeerId: (kind === 'command' ? '2' : '3').repeat(64),
    grantId: kind === 'command' ? 'cfab3df7-a4a8-4d89-8975-d84741d76510' : '16f50168-8418-4b08-8e7a-c1f76c0135d6',
    generation: kind === 'command' ? '34847ebe-2fe6-41bc-8bea-be6c66c32f8b' : 'ac086ce1-85ae-4d65-b1a6-885b4b22bac3',
    captureId: (kind === 'command' ? 'a' : 'b').repeat(32),
    captureGeneration: kind === 'command' ? 'e2052407-0357-4d68-8eac-75b19f96e157' : '8e4a7c8c-a14d-45b1-a833-a1dfb8fa56e8',
    source: kind === 'command'
      ? { kind: 'tool-observations', version: 4, name: 'Implementation checks', tools: [],
        commands: commands.map(command => ({ command, rootIndex: 0 })) }
      : { kind: 'completed-turn-outcomes', version: 5, name: 'Customer approval review' },
    expiresAt: 4_000_000_000_000, maxSamples: 5, maxSampleBytes: 8192 }
}
function commandReports() {
  return commands.map((command, index) => peerPublication(peerContributionRequestSchema.parse({
    grant: peerGrant('command'), sequence: index + 1, sourceId: hash(`command:${index}`),
    result: { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command, rootIndex: 0 },
      state: 'completed', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 20000,
      stdout: { state: 'included', text: `${command}: passed\n`, truncated: false },
      stderr: { state: 'included', text: '', truncated: false } },
  }), index + 1))
}
function answer(mode: 'local' | 'peer') {
  const sample = { sourceId: hash(`${mode}:answer`), sequence: 1,
    result: { kind: 'completed-turn-outcome', version: 5, text: reportText, sha256: hash(reportText) } }
  const grant = peerGrant('answer')
  if (mode === 'peer') return peerPublication(peerContributionRequestSchema.parse({ ...sample, grant }), 10)
  return localPublication(localContributionRequestSchema.parse({ ...sample, grant: {
    version: 1, taskId, participantId: 'customer-review-owner', bindingId: '10900c06-dbd7-4bea-a165-ae8f518a153e',
    expectedBindingEpoch: { nodeId: 'review-node', seq: 1 }, captureId: grant.captureId,
    captureGeneration: grant.captureGeneration, source: grant.source, expiresAt: grant.expiresAt,
    maxSamples: grant.maxSamples, maxSampleBytes: grant.maxSampleBytes,
  } }), 10)
}
function input(context: readonly DevelopmentTaskContextPublication[], maxContextBytes: number): DevelopmentTaskContextInput {
  type Task = DevelopmentTaskContextInput['view']['task']
  return { view: { task: { id: taskId as Task['id'], ownerNodeId: 'owner-node' as Task['ownerNodeId'], revision: 8,
    origin: { kind: 'root' }, hiddenRoomId: 'shared-release' as Task['hiddenRoomId'], runtime: 'ready',
    objective: 'Prepare the release under each person’s approval responsibilities', scope: 'Implementation and customer approval',
    createdBy: 'scope-owner' as Task['createdBy'], createdAt: 1, updatedAt: 10, context } },
  recipient: { participantId: 'release-reviewer' as Task['createdBy'] },
  maxContextBytes, signal: new AbortController().signal }
}
function selected(value: DevelopmentTaskContextProjection) {
  return value.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
}

it.each(['local', 'peer'] as const)('admits a fitting %s answer before a second current command from another source', async (mode) => {
  const ctx = new Context()
  contexts.push(ctx)
  const backend = new ReportedBackend(ctx)
  const checks = commandReports()
  const latest = checks.at(-1)!
  const outcome = answer(mode)
  const firstRound = await backend.compute(input([latest, outcome], 8000))
  expect(selected(firstRound)).toEqual([latest.id, outcome.id])
  expect(firstRound.omittedSources).toEqual([])
  const maxContextBytes = Buffer.byteLength(firstRound.text, 'utf8')
  expect(maxContextBytes).toBeLessThanOrEqual(8000)
  const mixed = await backend.compute(input([...checks, outcome], maxContextBytes))
  expect(Buffer.byteLength(mixed.text, 'utf8')).toBeLessThanOrEqual(maxContextBytes)
  const measurement = JSON.stringify({ mode, maxContextBytes, actualBytes: Buffer.byteLength(mixed.text, 'utf8'),
    selectedCommands: checks.filter(item => selected(mixed).includes(item.id)).length,
    selectedAnswers: Number(selected(mixed).includes(outcome.id)), omissions: mixed.omittedSources.map(item => item.reason) })
  expect(selected(mixed), measurement).toContain(outcome.id)
  expect(selected(mixed)).toContain(latest.id)
  expect(mixed.text).toContain(reportText)
  expect(mixed.omittedSources).not.toContainEqual(expect.objectContaining({ reason: 'superseded' }))
})

it('filters withdrawn and exact self-authored answers before offering current sources bounded selection', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const backend = new ReportedBackend(ctx)
  const checks = commandReports()
  const outcome = answer('peer')
  const full = input([checks.at(-1)!, outcome], 8000)
  const grant = outcome.peerContribution!.grant
  const own = await backend.compute({ ...full, recipient: { ...full.recipient, peerCapture: grant } })
  expect(selected(own)).toEqual([checks.at(-1)!.id])
  expect(own.omittedSources).toMatchObject([{ source: { publicationId: outcome.id }, reason: 'self-published' }])
  const terminal = peerWithdrawals(grant, undefined, 'revoked', 11)[0]!
  const ended = await backend.compute(input([checks.at(-1)!, outcome, terminal], 8000))
  expect(selected(ended)).toEqual([checks.at(-1)!.id, terminal.id])
  expect(ended.omittedSources).toMatchObject([{ source: { publicationId: outcome.id }, reason: 'withdrawn' }])
  expect(ended.text).not.toContain(reportText)
  expect(ended.text).toContain(terminal.text)
})
