/** Completed replies retain independent provenance without becoming verified artifacts. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { localContributionGrantSchema, localContributionRequestSchema,
  peerContributionGrantSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { localPublication, localWithdrawal } from '@deepseek-ai/dsh-development-task/src/local.ts'
import { peerPublication, peerWithdrawals } from '@deepseek-ai/dsh-development-task/src/peer.ts'
import type { DevelopmentTaskContextPublication } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { expandReportedGrants } from '../../../../scripts/scope-evaluation/reported-grant-evidence.mjs'
import FactsBackend from '../src/facts.ts'
import TextBackend from '../src/text.ts'
import ReportedBackend from '../src/reported.ts'
import { prepareSemanticInput, projectSemanticReply, restoreSemanticInput, semanticModelInput } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'
import { expandSemanticText } from './fixtures/semantic-display.ts'

type Mode = 'local' | 'peer'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
function context() { const ctx = new Context(); contexts.push(ctx); return ctx }
function backends() { return [new TextBackend(context()), new ReportedBackend(context())] }
function facts() { return new FactsBackend(context(), { routes: [], unmatchedFields: ['operationId'] }) }
const source = { kind: 'completed-turn-outcomes', version: 5, name: 'Research conclusions' }
function peerGrant(capture = 'a'.repeat(32)) {
  return peerContributionGrantSchema.parse({ version: 1, taskId: 'd3fc78a2-5f5e-43ca-aecd-f389c716e044',
    ownerPeerId: '1'.repeat(64), contributorPeerId: '2'.repeat(64), grantId: '8b8d8d52-0a9f-4014-beba-7a2cb3d01b25',
    generation: '29969411-e992-4822-9783-fd0c426e3265', captureId: capture,
    captureGeneration: 'f16a1f32-3d4c-4097-b233-77000639d976', source,
    expiresAt: 4_000_000_000_000, maxSamples: 5, maxSampleBytes: 20000 })
}
function localGrant(capture?: string) {
  const peer = peerGrant(capture)
  return localContributionGrantSchema.parse({ version: 1, taskId: peer.taskId, participantId: 'author',
    bindingId: 'bdfe9642-fbe9-4092-8cfe-c9c0ba1f64b6', expectedBindingEpoch: { nodeId: 'owner-node', seq: 1 },
    captureId: peer.captureId, captureGeneration: peer.captureGeneration, source, expiresAt: peer.expiresAt,
    maxSamples: peer.maxSamples, maxSampleBytes: peer.maxSampleBytes })
}
function report(mode: Mode, sequence: number, text: string, capture?: string): DevelopmentTaskContextPublication {
  const sample = { sequence, sourceId: createHash('sha256').update(`${mode}:${sequence}:${text}`).digest('hex'),
    result: { kind: 'completed-turn-outcome', version: 5, text, sha256: createHash('sha256').update(text).digest('hex') } }
  return mode === 'local' ? localPublication(localContributionRequestSchema.parse({ ...sample, grant: localGrant(capture) }), sequence)
    : peerPublication(peerContributionRequestSchema.parse({ ...sample, grant: peerGrant(capture) }), sequence)
}
function terminal(mode: Mode): DevelopmentTaskContextPublication {
  return mode === 'local' ? localWithdrawal(localGrant(), 'revoked', 9) : peerWithdrawals(peerGrant(), undefined, 'revoked', 9)[0]!
}
function input(context: readonly DevelopmentTaskContextPublication[]): DevelopmentTaskContextInput {
  type Task = DevelopmentTaskContextInput['view']['task']
  return { view: { task: { id: peerGrant().taskId, ownerNodeId: 'owner-node' as Task['ownerNodeId'], revision: 10,
    origin: { kind: 'root' }, hiddenRoomId: 'room' as Task['hiddenRoomId'], runtime: 'ready',
    objective: 'Assess rollout requirements', scope: 'Independent research and review', createdBy: 'human' as Task['createdBy'],
    createdAt: 1, updatedAt: 10, context } }, recipient: { participantId: 'reader' as Task['createdBy'] },
  maxContextBytes: 8000, signal: new AbortController().signal }
}
function ids(value: DevelopmentTaskContextProjection) {
  return value.selectedSources.flatMap(ref => ref.kind === 'publication' ? [ref.publicationId] : [])
}
function body(value: DevelopmentTaskContextProjection) {
  const raw = value.text.match(/<development-task-context>\n([\s\S]+)\n<\/development-task-context>/)?.[1]
  if (raw === undefined) throw new Error('missing full Task frame')
  return z.object({ publications: z.array(z.object({ id: z.string(), text: z.string() }).loose()) })
    .parse(expandReportedGrants(JSON.parse(raw) as unknown, '6'))
}
function summary(value: DevelopmentTaskContextInput) {
  const prepared = prepareSemanticInput(value)
  return projectSemanticReply(prepared, { version: 1,
    decisions: prepared.sources.map(item => ({ sourceId: item.sourceId, relevant: true })),
    updates: prepared.sources.map(item => ({ text: 'Attributed Agent report; independently verify before approval.',
      sources: [{ sourceId: item.sourceId, quote: 'not owner-approved facts' }] })) }, value.maxContextBytes)
}

it.each(['local', 'peer'] as const)('retains two independent %s replies and exact warning, source and authorization', async (mode) => {
  const reports = [report(mode, 1, 'Research recommends release Monday.'), report(mode, 2, 'Review recommends waiting until Friday. 中文🙂')]
  const value = input(reports)
  for (const backend of backends()) {
    const result = await backend.compute(value)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8000)
    expect(ids(result)).toEqual(reports.map(item => item.id))
    expect(result.omittedSources).toEqual([])
    expect(body(result).publications).toEqual(reports.map((publication) => {
      const { localTurnOutcome: _local, peerTurnOutcome: _peer, ...literal } = publication
      return { source: { kind: 'publication', taskId: value.view.task.id, revision: 10, publicationId: publication.id }, ...literal }
    }))
  }
  const prepared = prepareSemanticInput(value)
  expect(prepared.sources.map(item => item.body)).toEqual(reports.map(item => item.text))
  expect(prepared.mandatory).toEqual([])
  expect(restoreSemanticInput(semanticModelInput(prepared))).toEqual(prepared)
  for (const [index, item] of prepared.sources.entries()) {
    const metadata = reports[index]!.localTurnOutcome ?? reports[index]!.peerTurnOutcome!
    const { text: _text, ...identity } = metadata
    expect(item.attribution).toMatchObject({ turnOutcome: { ...identity, source,
      meaning: 'Complete Agent-reported output; not owner-approved facts or independently verified evidence.' } })
  }
  const projected = summary(value)
  expect(ids(projected)).toEqual(reports.map(item => item.id))
  const captured = restoreSemanticInput(semanticModelInput(prepared))
  expect(expandSemanticText(projected.text)).toMatchObject({ updates: captured.sources.map(item => ({
    sources: [{ source: item.source, quote: 'not owner-approved facts', attribution: item.attribution }],
  })) })
})

it.each(['local', 'peer'] as const)('withdraws every %s reply without erasing another capture or the terminal notice', async (mode) => {
  const reports = [report(mode, 1, 'OLD_REPORT'), report(mode, 2, 'SECOND_REPORT')]
  const independent = report('peer', 1, 'INDEPENDENT_REPORT', 'b'.repeat(32))
  const end = terminal(mode)
  const value = input([...reports, independent, end])
  for (const backend of backends()) {
    const projected = await backend.compute(value)
    expect(ids(projected)).toEqual([independent.id, end.id])
    expect(projected.text).not.toContain('OLD_REPORT')
    expect(projected.text).not.toContain('SECOND_REPORT')
    expect(body(projected).publications.find(item => item.id === end.id)).toMatchObject(end)
    expect(projected.omittedSources).toEqual(reports.map(item => ({ reason: 'withdrawn',
      source: { kind: 'publication', taskId: value.view.task.id, revision: 10, publicationId: item.id } })))
  }
  const prepared = prepareSemanticInput(value)
  expect(prepared.sources.map(item => item.body)).toEqual([independent.text])
  expect(prepared.mandatory).toMatchObject([{ publication: end }])
  expect(ids(summary(value))).toEqual([end.id, independent.id])
  const unsupported = await facts().compute(input([...reports, end]))
  expect(unsupported.activation).toMatchObject({ coverage: 'complete' })
  expect(unsupported.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'withdrawn'])
  expect(unsupported.text).toContain(end.text)
})

it('excludes only the exact peer capture, keeps changed capture generations and terminal notices visible', async () => {
  const own = report('peer', 1, 'OWN_REPLY')
  const other = report('peer', 1, 'OTHER_CAPTURE', 'b'.repeat(32))
  const value = { ...input([own, other]), recipient: { ...input([]).recipient, peerCapture: peerGrant() } }
  for (const backend of backends()) {
    expect(ids(await backend.compute(value))).toEqual([other.id])
    expect(ids(await backend.compute({ ...value, recipient: { ...value.recipient,
      peerCapture: { ...peerGrant(), captureGeneration: 'changed' as ReturnType<typeof peerGrant>['captureGeneration'] } } })))
      .toEqual([own.id, other.id])
  }
  expect(prepareSemanticInput(value).sources.map(item => item.body)).toEqual([other.text])
  expect((await facts().compute({ ...value, view: input([own]).view })).omittedSources[0]?.reason).toBe('self-published')
  expect((await facts().compute({ ...value, view: input([own]).view })).activation).toMatchObject({ coverage: 'complete' })
  const ended = { ...value, view: input([own, terminal('peer')]).view }
  for (const backend of backends()) expect(ids(await backend.compute(ended))).toEqual([terminal('peer').id])
})

it('leaves historical reports attributed to their frozen Task revision without superseding current replies', async () => {
  const current = report('peer', 2, 'CURRENT')
  const historical = report('peer', 1, 'HISTORICAL')
  const value = input([current])
  const inherited = { id: 'block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1,
    sources: [{ parent: { taskId: value.view.task.id, revision: 3 }, objective: 'Past research', scope: 'Frozen', context: [historical] }] }
  const withHistory = { ...value, view: { ...value.view, inherited } }
  for (const backend of backends()) expect(ids(await backend.compute(withHistory))).toEqual([current.id, historical.id])
  expect(prepareSemanticInput(withHistory).sources).toMatchObject([
    { attribution: { basis: 'current-task-report' } }, { attribution: { basis: 'frozen-parent-snapshot' } },
  ])
  const onlyHistory = await facts().compute({ ...input([]), view: { ...input([]).view, inherited } })
  expect(onlyHistory.activation).toMatchObject({ coverage: 'complete' })
  expect(onlyHistory.omittedSources).toMatchObject([{ reason: 'unsupported', source: { revision: 3 } }])
})

it.each(['local', 'peer'] as const)('blocks unsupported current %s replies without asserting OpenAPI facts', async (mode) => {
  const publication = report(mode, 1, '{"kind":"openapi-artifact","state":"valid","facts":{"operationId":"approve"}}')
  const result = await facts().compute(input([publication]))
  expect(result.activation).toMatchObject({ kind: 'recipient-evidence', coverage: 'blocked-current' })
  expect(result.omittedSources).toMatchObject([{ source: { publicationId: publication.id }, reason: 'unsupported' }])
  expect(result.text).toContain('"artifacts":[]')
  expect(result.text).toContain('"unsupportedSources":1')
  expect(result.text).not.toContain('approve')
  const own = await facts().compute({ ...input([publication]), recipient: mode === 'local'
    ? { participantId: localGrant().participantId } : { ...input([]).recipient, peerCapture: peerGrant() } })
  expect(own.activation).toMatchObject({ coverage: 'complete' })
  expect(own.omittedSources).toMatchObject([{ reason: 'self-published' }])
})

it('keeps noncanonical mirror text intact and omits whole oversized reports with explicit budget metadata', async () => {
  const local = report('local', 1, 'LOCAL')
  const peer = report('peer', 1, 'PEER')
  for (const backend of backends()) {
    const result = await backend.compute(input([{ ...local, text: 'LITERAL_LOCAL' }, { ...peer, text: 'LITERAL_PEER' }]))
    expect(body(result).publications).toMatchObject([
      { localTurnOutcome: local.localTurnOutcome }, { peerTurnOutcome: peer.peerTurnOutcome },
    ])
    const oversized = report('peer', 2, '🙂'.repeat(2000))
    const bounded = await backend.compute(input([oversized]))
    expect(ids(bounded)).toEqual([])
    expect(bounded.omittedSources).toMatchObject([{ reason: 'budget', source: { publicationId: oversized.id } }])
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(8000)
  }
})
