/** External hook reports retain their original evidence meaning through every context backend. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { peerContributionGrantSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { peerPublication, peerWithdrawals } from '@deepseek-ai/dsh-development-task/src/peer.ts'
import type { DevelopmentTaskContextPublication, DevelopmentTaskPeerContributionObservationResult } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import { expandReportedGrants } from '../../../../scripts/scope-evaluation/reported-grant-evidence.mjs'
import FactsBackend from '../src/facts.ts'
import TextBackend from '../src/text.ts'
import ReportedBackend from '../src/reported.ts'
import { prepareSemanticInput, projectSemanticReply, restoreSemanticInput, semanticModelInput } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
function context() { const ctx = new Context(); contexts.push(ctx); return ctx }
function backends() { return [new TextBackend(context()), new ReportedBackend(context())] }
function facts() { return new FactsBackend(context(), { routes: [], unmatchedFields: ['operationId'] }) }
const source = { kind: 'claude-work', version: 7, name: 'Original Claude session', tools: ['Write', 'Edit'],
  commands: [{ command: 'pnpm test', rootIndex: 0 }, { command: 'pnpm test ', rootIndex: 0 }, { command: 'pnpm test', rootIndex: 1 }],
  stopReports: true }
function grant(capture = 'a'.repeat(32)) {
  return peerContributionGrantSchema.parse({ version: 1, taskId: 'd3fc78a2-5f5e-43ca-aecd-f389c716e044',
    ownerPeerId: '1'.repeat(64), contributorPeerId: '2'.repeat(64), grantId: '8b8d8d52-0a9f-4014-beba-7a2cb3d01b25',
    generation: '29969411-e992-4822-9783-fd0c426e3265', captureId: capture,
    captureGeneration: 'f16a1f32-3d4c-4097-b233-77000639d976', source,
    expiresAt: 4_000_000_000_000, maxSamples: 20, maxSampleBytes: 40000 })
}
function report(sequence: number, result: DevelopmentTaskPeerContributionObservationResult, capture?: string) {
  return peerPublication(peerContributionRequestSchema.parse({ sequence, grant: grant(capture), result,
    sourceId: createHash('sha256').update(JSON.stringify([sequence, result])).digest('hex') }), sequence)
}
function stop(sequence: number, text: string, stopHookActive = false, capture?: string) {
  return report(sequence, { kind: 'claude-stop-report', version: 7, text, stopHookActive,
    sha256: createHash('sha256').update(text).digest('hex') }, capture)
}
function command(sequence: number, failed = false, selector = source.commands[0]!, capture?: string) {
  return report(sequence, { kind: 'claude-command-observation', version: 7, tool: 'Bash',
    hookEvent: failed ? 'PostToolUseFailure' : 'PostToolUse', omissions: [], fields: { ...selector,
      ...failed ? { error: 'Exit code 7\nI76_BASH_ERR' } : { stdout: 'I76_BASH_OK', stderr: '', interrupted: false } } }, capture)
}
function file(sequence: number, content: string) {
  return report(sequence, { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'policy.md', content } })
}
function input(context: readonly DevelopmentTaskContextPublication[], maxContextBytes = 40_000): DevelopmentTaskContextInput {
  type Task = DevelopmentTaskContextInput['view']['task']
  return { view: { task: { id: grant().taskId, ownerNodeId: 'owner-node' as Task['ownerNodeId'], revision: 20,
    origin: { kind: 'root' }, hiddenRoomId: 'room' as Task['hiddenRoomId'], runtime: 'ready',
    objective: 'Coordinate existing owners', scope: 'Selected original session work', createdBy: 'human' as Task['createdBy'],
    createdAt: 1, updatedAt: 20, context } }, recipient: { participantId: 'reader' as Task['createdBy'] },
  maxContextBytes, signal: new AbortController().signal }
}
function ids(value: DevelopmentTaskContextProjection) {
  return value.selectedSources.flatMap(ref => ref.kind === 'publication' ? [ref.publicationId] : [])
}
function expanded(value: DevelopmentTaskContextProjection) {
  const raw = value.text.match(/<development-task-context>\n([\s\S]+)\n<\/development-task-context>/)?.[1]
  if (raw === undefined) throw new Error('Missing complete Task frame')
  return expandReportedGrants(JSON.parse(raw) as unknown, '6') as { publications: unknown[] }
}

it('retains independent full Stop reports without claiming a completed native turn', async () => {
  const reports = [stop(1, ' First report. 中文🙂\n'), stop(2, 'Continued response.', true)]
  for (const backend of backends()) {
    const result = await backend.compute(input(reports))
    expect(ids(result)).toEqual(reports.map(value => value.id))
    expect(expanded(result).publications).toEqual(reports.map(({ peerStopReport: _report, ...publication }) => ({
      source: { kind: 'publication', taskId: grant().taskId, revision: 20, publicationId: publication.id }, ...publication,
    })))
    expect(result.text).not.toContain('completed-turn-outcome')
  }
  const prepared = prepareSemanticInput(input(reports))
  expect(prepared.mandatory).toEqual([])
  expect(prepared.sources.map(value => value.body)).toEqual(reports.map(value => value.text))
  expect(prepared.sources).toMatchObject(reports.map(value => ({ attribution: {
    authorization: { source }, stopReport: { sha256: value.peerStopReport?.sha256,
      stopHookActive: value.peerStopReport?.stopHookActive, source,
      meaning: 'Complete text reported by the Claude Stop hook; the turn may continue. Not owner-approved or independently verified.' },
  } })))
  expect(restoreSemanticInput(semanticModelInput(prepared))).toEqual(prepared)
})

it('replaces the exact command attempt with its failure and keeps independent commands and files', async () => {
  const reports = [file(1, 'OLD_FILE'), command(2), command(3, false, source.commands[1]),
    command(4, false, source.commands[2]), command(1, false, undefined, 'b'.repeat(32)), file(5, 'CURRENT_FILE'), command(6, true)]
  const retained = reports.slice(2)
  for (const backend of backends()) {
    const result = await backend.compute(input(reports))
    expect(ids(result)).toEqual(retained.map(value => value.id))
    expect(result.omittedSources.map(value => value.reason)).toEqual(['superseded', 'superseded'])
    expect(result.text).not.toContain('OLD_FILE')
    expect(result.text).toContain('PostToolUseFailure')
    expect(result.text).not.toContain('"exitCode"')
  }
  const prepared = prepareSemanticInput(input(reports))
  expect(prepared.sources).toMatchObject([{ source: { publicationId: reports[5]!.id }, attribution: { authorization: { source } } }])
  expect(prepared.mandatory).toMatchObject([reports[2], reports[3], reports[4], reports[6]].map(publication => ({
    kind: 'command-evidence', publication,
  })))
  const result = projectSemanticReply(prepared, { version: 1,
    decisions: prepared.sources.map(value => ({ sourceId: value.sourceId, relevant: false })), updates: [] }, 40_000)
  expect(result.text).toContain('I76_BASH_ERR')
  expect(result.text).not.toContain('"exitCode"')
})

it('omits self reports by exact capture and withdraws all categories together', async () => {
  const own = [file(1, 'OWN_FILE'), command(2), stop(3, 'OWN_STOP')]
  const independent = stop(1, 'INDEPENDENT_STOP', false, 'b'.repeat(32))
  const value = { ...input([...own, independent]), recipient: { ...input([]).recipient, peerCapture: grant() } }
  for (const backend of backends()) expect(ids(await backend.compute(value))).toEqual([independent.id])
  expect(prepareSemanticInput(value).sources.map(value => value.source)).toMatchObject([{ publicationId: independent.id }])
  const terminal = peerWithdrawals(grant(), undefined, 'revoked', 10)[0]!
  const ended = input([...own, independent, terminal])
  for (const backend of backends()) {
    const result = await backend.compute(ended)
    expect(ids(result)).toEqual([independent.id, terminal.id])
    expect(result.omittedSources.map(value => value.reason)).toEqual(['withdrawn', 'withdrawn', 'withdrawn'])
    expect(result.text).not.toContain('OWN_STOP')
  }
  expect(prepareSemanticInput(ended).mandatory).toMatchObject([{ kind: 'withdrawal', publication: terminal }])
})

it('blocks current Stop text in the OpenAPI-only backend, while self and withdrawn reports remain explicit', async () => {
  const publication = stop(1, '{"operationId":"NOT_A_VERIFIED_FACT"}')
  const current = await facts().compute(input([publication]))
  expect(current.activation).toMatchObject({ coverage: 'blocked-current' })
  expect(current.omittedSources).toMatchObject([{ reason: 'unsupported' }])
  expect(current.text).not.toContain('NOT_A_VERIFIED_FACT')
  const self = await facts().compute({ ...input([publication]), recipient: { ...input([]).recipient, peerCapture: grant() } })
  expect(self.activation).toMatchObject({ coverage: 'complete' })
  expect(self.omittedSources).toMatchObject([{ reason: 'self-published' }])
  const terminal = peerWithdrawals(grant(), undefined, 'revoked', 10)[0]!
  const ended = await facts().compute(input([publication, terminal]))
  expect(ended.activation).toMatchObject({ coverage: 'complete' })
  expect(ended.omittedSources).toMatchObject([{ reason: 'withdrawn' }])
})

it('retains noncanonical report text and omits an oversized report atomically', async () => {
  const original = stop(1, 'FULL_STOP')
  const oversized = stop(2, '🙂'.repeat(5000))
  for (const backend of backends()) {
    const literal = await backend.compute(input([{ ...original, text: 'EXTRA_REPORT_WORDS' }]))
    expect(expanded(literal).publications).toMatchObject([{ text: 'EXTRA_REPORT_WORDS', peerStopReport: original.peerStopReport }])
    const bounded = await backend.compute(input([oversized], 8000))
    expect(ids(bounded)).toEqual([])
    expect(bounded.omittedSources).toMatchObject([{ reason: 'budget' }])
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(8000)
  }
})

it.each([
  { name: 'unsupported', hookEvent: 'PostToolUse', fields: {}, omissions: ['unsupported-tool-response'], marker: 'unsupported-tool-response' },
  { name: 'interrupted', hookEvent: 'PostToolUse', fields: { stdout: '', stderr: '', interrupted: true }, omissions: [], marker: '"interrupted":true' },
  { name: 'unavailable failure output', hookEvent: 'PostToolUseFailure', fields: {}, omissions: ['error'], marker: 'PostToolUseFailure' },
] as const)('retains $name as the current command attempt instead of restoring success', async ({ hookEvent, fields, omissions, marker }) => {
  const previous = command(1)
  const current = report(2, { kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent,
    fields: { rootIndex: 0, command: 'pnpm test', ...fields }, omissions })
  for (const backend of backends()) {
    const projected = await backend.compute(input([previous, current]))
    expect(ids(projected)).toEqual([current.id])
    expect(projected.text).not.toContain('I76_BASH_OK')
    const publications = expanded(projected).publications
    expect(publications).toHaveLength(1)
    expect(publications[0]).toHaveProperty('text', expect.stringContaining(marker))
    expect(projected.omittedSources).toMatchObject([{ source: { publicationId: previous.id }, reason: 'superseded' }])
  }
  const prepared = prepareSemanticInput(input([previous, current]))
  expect(prepared.sources).toEqual([])
  expect(prepared.mandatory).toMatchObject([{ kind: 'command-evidence', publication: current }])
  const projected = projectSemanticReply(prepared, { version: 1, decisions: [], updates: [] }, 40_000)
  expect(projected.text).not.toContain('I76_BASH_OK')
  expect(projected.text).not.toContain('"exitCode"')
})

it('retains frozen parent Stop evidence when the current capture is withdrawn', async () => {
  const historical = stop(1, 'HISTORICAL_STOP')
  const current = stop(2, 'CURRENT_STOP')
  const terminal = peerWithdrawals(grant(), undefined, 'revoked', 10)[0]!
  const value = input([current, terminal])
  const withHistory: DevelopmentTaskContextInput = { ...value, view: { ...value.view, inherited: {
    id: 'frozen-block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1,
    sources: [{ parent: { taskId: grant().taskId, revision: 3 }, objective: 'Past review', scope: 'Frozen reports', context: [historical] }],
  } } }
  for (const backend of backends()) {
    const projected = await backend.compute(withHistory)
    expect(ids(projected)).toEqual([terminal.id, historical.id])
    expect(projected.text).toContain('HISTORICAL_STOP')
    expect(projected.text).not.toContain('CURRENT_STOP')
  }
  expect(prepareSemanticInput(withHistory).sources).toMatchObject([
    { source: { publicationId: historical.id, revision: 3 }, attribution: { basis: 'frozen-parent-snapshot' } },
  ])
  expect((await facts().compute(withHistory)).activation).toMatchObject({ coverage: 'complete' })
})
