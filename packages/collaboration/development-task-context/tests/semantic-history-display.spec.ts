/** Current command evidence remains deliverable as superseded history grows; durable versions retain their exact text. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { developmentTaskContextBlockSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskContextPublication } from '@deepseek-ai/dsh-development-task/types'
import { expect, it } from 'vitest'
import { z } from 'zod'
import type { SemanticDelivery } from '../src/semantic-display.ts'
import { semanticHistoryTableDelivery } from '../src/semantic-history-display.ts'
import { semanticMandatoryTableDelivery } from '../src/semantic-mandatory-display.ts'
import { prepareSemanticInput, projectSemanticReply, restoreSemanticInput, restoreSemanticProjection, semanticModelInput,
  type SemanticInput } from '../src/semantic-input.ts'
import { semanticJson, semanticReplySchema, semanticRequestSchema, semanticResultSchema } from '../src/semantic-schema.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextSourceRef } from '../src/types.ts'
import { expandSemanticText, semanticTextValue } from './fixtures/semantic-display.ts'

type Task = DevelopmentTaskContextInput['view']['task']

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const row = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: z.string(), revision: z.number() }),
  z.object({ kind: z.literal('publication'), publicationId: z.string(), taskSourceIndex: z.number() }),
])
const displaySchema = z.object({ sourceTable: z.array(row), coverage: z.object({
  selectedSources: z.array(z.number()), omittedSources: z.array(z.object({ sourceIndex: z.number(), reason: z.string() })),
  supersededSources: z.array(z.object({ taskSourceIndex: z.number(), count: z.number() })),
}) })
const expandedSchema = z.object({ coverage: z.object({ selectedSources: z.array(z.json()),
  omittedSources: z.array(z.object({ source: z.json(), reason: z.string() })) }) }).loose()

function fixture() {
  const recorded = z.object({ captured: z.json(), reply: semanticReplySchema, contextBytes: z.number() })
    .parse(JSON.parse(readFileSync(new URL('./fixtures/semantic-peer-command-c-captured.json', import.meta.url), 'utf8')) as unknown)
  const input = restoreSemanticInput(semanticJson(recorded.captured))
  const projected = projectSemanticReply(input, recorded.reply, 30_000, 3)
  // The expanded projector immediately above owns every field of this typed delivery.
  const delivery = semanticTextValue(projected.text) as SemanticDelivery
  return { ...recorded, input, delivery }
}

function command(publication: DevelopmentTaskContextPublication) {
  const observation = publication.peerToolObservation
  if (publication.peerContribution === undefined
    || observation?.kind !== 'command-observation' || observation.state !== 'completed') {
    throw new Error('captured command is not a completed peer command report')
  }
  return { publication, observation, grant: publication.peerContribution.grant }
}

function native(extra: number, widenGrant = true) {
  const recorded = fixture()
  const file = z.object({ block: developmentTaskContextBlockSchema }).parse(JSON.parse(readFileSync(
    new URL('./fixtures/semantic-native-command-context.json', import.meta.url), 'utf8')) as unknown)
  const source = file.block.sources[0]!
  const originalCommand = source.context.findLast(item => item.peerToolObservation?.kind === 'command-observation')!
  const originalGrant = command(originalCommand).grant
  // This independent scenario authorizes 32 samples from issuance; it never renews an exhausted live grant.
  const context = source.context.map((item): DevelopmentTaskContextPublication => {
    if (item.peerContribution === undefined || item.peerContribution.grant.grantId !== originalGrant.grantId || !widenGrant) return item
    return { ...item, peerContribution: { ...item.peerContribution, grant: { ...item.peerContribution.grant, maxSamples: 32 } } }
  })
  const { publication: template, observation, grant } = command(context.find(item => item.id === originalCommand.id)!)
  for (let index = 1; index <= extra; index++) {
    const next = { ...observation, sequence: observation.sequence + index,
      sourceId: brandString<typeof observation.sourceId>(sha(`iteration66-command-source-${String(index)}`)),
      exitCode: index % 2 === 1 ? 0 : 7,
      stdout: { state: 'included' as const, text: index % 2 === 1 ? 'CHECK_CURRENT_PASSED\n' : 'CHECK_CURRENT_FAILED\n', truncated: false } }
    const prefix = template.text.slice(0, template.text.indexOf('\n{') + 1)
    context.push({ ...template, id: 'context-peer-observation-' + sha(`iteration66-command-${String(index)}`),
      publishedAt: template.publishedAt + index, peerToolObservation: next, text: prefix + JSON.stringify(next) })
    expect(next.sequence).toBeLessThanOrEqual(grant.maxSamples)
    expect(template.publishedAt + index).toBeLessThan(grant.expiresAt)
  }
  const task: Task = { ...recorded.input.task, origin: { kind: 'root' },
    revision: recorded.input.task.revision + extra, context,
    ownerNodeId: brandString<Task['ownerNodeId']>('captured-owner'),
    hiddenRoomId: brandString<Task['hiddenRoomId']>('captured-room'), runtime: 'ready',
    createdBy: brandString<Task['createdBy']>('captured-human'), createdAt: 1, updatedAt: 1 }
  const input = prepareSemanticInput({ view: { task }, recipient: recorded.input.recipient,
    maxContextBytes: recorded.contextBytes, signal: new AbortController().signal })
  const relevant = input.sources.filter(item => z.object({ path: z.string() }).parse(item.attribution).path === 'policy.md')
  const update = recorded.reply.updates[0]!
  const reply = { version: 1, decisions: input.sources.map(item => ({ sourceId: item.sourceId, relevant: relevant.includes(item) })),
    updates: [{ text: update.text, sources: relevant.map((item, index) => ({
      sourceId: item.sourceId, quote: update.sources[index]!.quote,
    })) }] }
  return { ...recorded, input, reply, context }
}

function expandedWithoutHistory(input: SemanticInput, reply: unknown) {
  const expanded = expandedSchema.parse(semanticTextValue(projectSemanticReply(input, reply, 100_000, 3).text))
  return { ...expanded, coverage: { ...expanded.coverage,
    omittedSources: expanded.coverage.omittedSources.filter(item => item.reason !== 'superseded'),
    supersededSources: [{ source: { kind: 'task', taskId: input.task.id, revision: input.task.revision },
      count: input.omitted.filter(item => item.reason === 'superseded').length }],
  } }
}

it('reconstructs the actual C captured input and unchanged two-policy reply from admitted publications', () => {
  const original = native(0, false)
  expect(JSON.parse(semanticModelInput(original.input)) as unknown).toEqual(original.captured)
  expect(original.reply).toEqual(fixture().reply)
  expect(Buffer.byteLength(projectSemanticReply(original.input, original.reply, original.contextBytes, 5).text)).toBe(6538)
})

it.each([{ extra: 0, previousBytes: 6539 }, { extra: 1, previousBytes: 6730 },
  { extra: 2, previousBytes: 6922 }, { extra: 10, previousBytes: 8460 }])(
  'delivers the latest command after $extra derived updates with the original C allowance and two policy quotes', ({ extra, previousBytes }) => {
    const { input, reply, contextBytes, context } = native(extra)
    const previous = projectSemanticReply(input, reply, 100_000, 5)
    expect(Buffer.byteLength(previous.text)).toBe(previousBytes)
    if (extra > 0) expect(() => projectSemanticReply(input, reply, contextBytes, 5)).toThrow('exceed maxContextBytes')
    const current = projectSemanticReply(input, reply, contextBytes)
    expect(current.selectedSources).toEqual(previous.selectedSources)
    expect(current.omittedSources).toEqual(previous.omittedSources)
    expect(current.activation).toEqual(previous.activation)
    expect(input.mandatory).toHaveLength(1)
    expect(expandSemanticText(current.text)).toEqual(expandedWithoutHistory(input, reply))
    const displayed = displaySchema.parse(semanticTextValue(current.text))
    expect(displayed.coverage.supersededSources).toEqual([{ taskSourceIndex: 0, count: 2 + extra }])
    expect(displayed.sourceTable).toHaveLength(7)
    for (const item of current.omittedSources.filter(value => value.reason === 'superseded')) {
      if (item.source.kind !== 'publication') throw new Error('unexpected superseded Task')
      const id = item.source.publicationId
      expect(displayed.sourceTable.some(value => value.kind === 'publication' && value.publicationId === id)).toBe(false)
    }
    const latest = context.findLast(item => item.peerToolObservation?.kind === 'command-observation')!
    const evidence = z.object({ publication: z.json() }).parse(input.mandatory[0])
    expect(evidence.publication).toEqual(latest)
    expect(command(latest).observation.sequence).toBe(4 + extra)
    expect(command(latest).observation.exitCode).toBe(extra % 2 === 1 ? 0 : 7)
    const bytes = Buffer.byteLength(current.text)
    expect(projectSemanticReply(input, reply, bytes)).toEqual(current)
    expect(() => projectSemanticReply(input, reply, bytes - 1)).toThrow('exceed maxContextBytes')
  },
)

it('grows only the history count digits when current evidence, quotes, and recipient stay unchanged', () => {
  const { input, reply } = fixture()
  const original = projectSemanticReply(input, reply, 6552)
  for (const extra of [1, 2, 10]) {
    const next = { ...input, omitted: [...input.omitted, ...Array.from({ length: extra }, (_, index) => ({
      source: { kind: 'publication' as const, taskId: input.task.id, revision: input.task.revision,
        publicationId: `additional-historical-command-${String(index)}` }, reason: 'superseded' as const,
    }))] }
    const projected = projectSemanticReply(next, reply, 6552)
    expect(Buffer.byteLength(projected.text) - Buffer.byteLength(original.text)).toBe(extra === 10 ? 1 : 0)
    expect(projected.activation).toEqual(original.activation)
    expect(projected.omittedSources).toEqual(next.omitted.concat(original.omittedSources.slice(input.omitted.length)))
    expect(semanticModelInput(next)).not.toEqual(semanticModelInput(input))
  }
})

it('counts exact Task revisions separately and retains every other omission reason and superseded Task reference', () => {
  const { delivery } = fixture()
  const task: Extract<DevelopmentTaskContextSourceRef, { kind: 'task' }> = {
    kind: 'task', taskId: delivery.task.id, revision: delivery.task.revision,
  }
  const previous = { ...task, revision: task.revision - 1 }
  const parent = { ...task, taskId: brandString<typeof task.taskId>('parent-task') }
  const publication = (basis: typeof task, id: string): DevelopmentTaskContextSourceRef => ({ ...basis, kind: 'publication', publicationId: id })
  const retained = ['budget', 'withdrawn', 'unsupported', 'self-published', 'recipient-irrelevant'].map(reason => ({
    source: publication(task, reason), reason: z.enum(['budget', 'withdrawn', 'unsupported', 'self-published', 'recipient-irrelevant']).parse(reason),
  }))
  const original: SemanticDelivery = { ...delivery, coverage: { selectedSources: [task, previous, parent, publication(task, 'same-id')], omittedSources: [
    { source: publication(parent, 'same-id'), reason: 'superseded' },
    { source: publication(previous, 'same-id'), reason: 'superseded' },
    { source: publication(task, 'current-old-id'), reason: 'superseded' },
    { source: publication(previous, 'another-id'), reason: 'superseded' },
    ...retained, { source: parent, reason: 'superseded' },
  ] } }
  const result = semanticHistoryTableDelivery(original)
  expect(result.coverage.supersededSources).toEqual([
    { taskSourceIndex: 0, count: 1 }, { taskSourceIndex: 1, count: 2 }, { taskSourceIndex: 2, count: 1 },
  ])
  expect(result.sourceTable.filter(value => value.kind === 'publication' && value.publicationId === 'same-id'))
    .toEqual([{ kind: 'publication', publicationId: 'same-id', taskSourceIndex: 0 }])
  expect(result.sourceTable.some(value => value.kind === 'publication' && value.publicationId === 'current-old-id')).toBe(false)
  const expected = semanticMandatoryTableDelivery({ ...original, coverage: { ...original.coverage,
    omittedSources: [...retained, { source: parent, reason: 'superseded' }] } })
  expect(result.coverage.omittedSources).toEqual(expected.coverage.omittedSources)
  expect(result.mandatory).toEqual(expected.mandatory)
})

it('adds a missing legacy Task row for a history count without inventing selected coverage', () => {
  const { delivery } = fixture()
  const original = { ...delivery, mandatory: [], updates: [], coverage: { selectedSources: [],
    omittedSources: delivery.coverage.omittedSources.filter(item => item.reason === 'superseded') } }
  const result = semanticHistoryTableDelivery(original)
  expect(result.sourceTable).toEqual([{ kind: 'task', taskId: delivery.task.id, revision: delivery.task.revision }])
  expect(result.coverage).toEqual({ selectedSources: [], omittedSources: [], supersededSources: [{ taskSourceIndex: 0, count: 2 }] })
})

it('retains no-history evidence, opaque count-shaped JSON, withdrawals, and conflicting current command reports', () => {
  const { delivery } = fixture()
  const first = z.object({ publication: z.object({ peerToolObservation: z.record(z.string(), z.json()) }).loose() })
    .loose().parse(delivery.mandatory[0])
  const contradictory = { ...first, publication: { ...first.publication,
    peerToolObservation: { ...first.publication.peerToolObservation, exitCode: 0 } } }
  const opaque = { kind: 'unknown', coverage: { supersededSources: [{ taskSourceIndex: 91, count: 80 }] }, sourceIndex: 99 }
  const withdrawal = { kind: 'withdrawal', publication: { ended: 'revoked', text: 'Authorization withdrawn.' } }
  const original = { ...delivery, mandatory: [...delivery.mandatory, contradictory, opaque, withdrawal],
    coverage: { ...delivery.coverage, omittedSources: [] } }
  const result = semanticHistoryTableDelivery(original)
  const previous = semanticMandatoryTableDelivery(original)
  expect(result.coverage).toEqual({ ...previous.coverage, supersededSources: [] })
  expect(result.mandatory).toEqual(previous.mandatory)
  expect(result.sourceTable).toEqual(previous.sourceTable)
  expect(result.updates).toEqual(previous.updates)
  expect(result.authorizationTable).toEqual(previous.authorizationTable)
  expect(result.sourceReferences).toContain('these historical omissions are not current evidence')
})

it('cold-restores v6 and rejects changed counts, count bases, and relabeled v5 text from the same captured request', () => {
  const { input, reply, contextBytes } = native(10)
  const request = semanticRequestSchema.parse({ version: 1, key: 'a'.repeat(64), ordinal: 1,
    backend: { id: 'semantic', revision: 'b'.repeat(64) }, call: { provider: 'fixture', model: 'fixture', maxTokens: 2048 },
    system: 'Summarize authorized reports.', purpose: 'context-summary', maxContextBytes: contextBytes,
    messages: [{ id: 'request', role: 'user', source: { kind: 'plugin', plugin: 'dsh-development-task-context/semantic' },
      content: [{ type: 'text', text: semanticModelInput(input) }] }] })
  const projection = projectSemanticReply(input, reply, contextBytes)
  const result = semanticResultSchema.parse({ version: 6, key: request.key, requestSeq: 1, status: 'completed',
    rawOutput: [{ type: 'text', text: JSON.stringify(reply) }], finish: { kind: 'stop' }, projection,
    usage: null, elapsedMs: 1, error: null, rejectedChunk: null })
  expect(restoreSemanticProjection(semanticRequestSchema.parse(JSON.parse(JSON.stringify(request)) as unknown),
    semanticResultSchema.parse(JSON.parse(JSON.stringify(result)) as unknown))).toEqual(projection)
  for (const replacement of ['[{"count":13,"taskSourceIndex":0}]', '[{"count":12,"taskSourceIndex":1}]', '[]']) {
    const text = projection.text.replace(/"supersededSources":\[[^\]]*\]/, '"supersededSources":' + replacement)
    expect(text).not.toBe(projection.text)
    expect(() => restoreSemanticProjection(request, semanticResultSchema.parse({ ...result,
      projection: { ...projection, text } }))).toThrow('cached projection disagrees')
  }
  expect(() => restoreSemanticProjection({ ...request, maxContextBytes: 30_000 },
    semanticResultSchema.parse({ ...result, version: 5 }))).toThrow('cached projection disagrees')
  const old = projectSemanticReply(input, reply, 30_000, 5)
  expect(() => restoreSemanticProjection({ ...request, maxContextBytes: 30_000 },
    semanticResultSchema.parse({ ...result, projection: old }))).toThrow('cached projection disagrees')
  expect(() => restoreSemanticProjection({ ...request, maxContextBytes: Buffer.byteLength(projection.text) - 1 }, result))
    .toThrow('exceed maxContextBytes')
})
