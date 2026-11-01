/** Real admitted withdrawal evidence remains deliverable after a long completed command history. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { semanticWithdrawalTableDelivery } from '../src/semantic-withdrawal-display.ts'
import { projectSemanticReply, restoreSemanticInput, restoreSemanticProjection, semanticModelInput } from '../src/semantic-input.ts'
import { semanticSummaryInput } from '../src/semantic-summary-input.ts'
import { semanticJson, semanticReplySchema, semanticRequestSchema, semanticResultSchema,
  semanticSummaryInputSchema } from '../src/semantic-schema.ts'
import type { SemanticDelivery } from '../src/semantic-display.ts'
import type { DevelopmentTaskContextSourceRef } from '../src/types.ts'
import { expandSemanticText, semanticTextValue } from './fixtures/semantic-display.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const expandedSchema = z.object({ mandatory: z.array(z.json()), coverage: z.object({
  selectedSources: z.array(z.json()), omittedSources: z.array(z.json()),
  supersededSources: z.array(z.json()), withdrawnSources: z.array(z.json()),
}) })

function fixture() {
  const value = z.object({ sourceSha256: z.string().length(64), captured: z.json(), reply: semanticReplySchema,
    contextBytes: z.number(), v6Bytes: z.number(), v6Sha256: z.string().length(64) }).parse(JSON.parse(readFileSync(
    new URL('./fixtures/semantic-command-withdrawal-captured.json', import.meta.url), 'utf8')) as unknown)
  return { ...value, input: restoreSemanticInput(semanticJson(value.captured)) }
}

it('delivers the complete real terminal notice after 49 reports while preserving all omitted identities and the old v6 hash', () => {
  const { input, reply, contextBytes, v6Bytes, v6Sha256 } = fixture()
  const previous = projectSemanticReply(input, reply, 100_000, 6)
  expect(Buffer.byteLength(previous.text)).toBe(v6Bytes)
  expect(v6Bytes).toBe(12475)
  expect(sha(previous.text)).toBe(v6Sha256)
  expect(contextBytes).toBe(7080)
  expect(() => projectSemanticReply(input, reply, contextBytes, 6)).toThrow('exceed maxContextBytes')
  const current = projectSemanticReply(input, reply, contextBytes)
  expect(current.selectedSources).toEqual(previous.selectedSources)
  expect(current.omittedSources).toEqual(previous.omittedSources)
  expect(current.activation).toEqual(previous.activation)
  expect(current.omittedSources).toHaveLength(49)
  expect(current.omittedSources.every(item => item.reason === 'withdrawn')).toBe(true)
  expect(input.sources).toEqual([])
  expect(input.mandatory).toHaveLength(1)
  const expanded = expandedSchema.parse(expandSemanticText(current.text))
  expect(expanded.mandatory).toEqual(input.mandatory)
  expect(expanded.coverage).toEqual({ selectedSources: input.selected, omittedSources: [], supersededSources: [],
    withdrawnSources: [{ source: { kind: 'task', taskId: input.task.id, revision: input.task.revision }, count: 49 }] })
  const displayed = z.object({ sourceTable: z.array(z.json()) }).parse(semanticTextValue(current.text))
  expect(displayed.sourceTable).toHaveLength(2)
  expect(current.text).not.toContain('VERIFY_SAMPLE_')
  expect(current.text).toContain('ended (left)')
  const bytes = Buffer.byteLength(current.text)
  expect(projectSemanticReply(input, reply, bytes)).toEqual(current)
  expect(() => projectSemanticReply(input, reply, bytes - 1)).toThrow('exceed maxContextBytes')
  const wire = semanticSummaryInputSchema.parse(JSON.parse(semanticSummaryInput(input)) as unknown)
  expect(wire.coverage.omittedSources).toEqual(input.omitted)
  expect(wire.coverage.supersededSources).toEqual([])
})

it('groups exact Task revisions while retaining same-ID current references, other omission reasons, and opaque evidence', () => {
  const { input } = fixture()
  const task = { kind: 'task' as const, taskId: input.task.id, revision: input.task.revision }
  const previous = { ...task, revision: task.revision - 1 }
  const parent = { ...task, taskId: brandString<typeof task.taskId>('parent-task') }
  const publication = (source: typeof task, publicationId: string): DevelopmentTaskContextSourceRef =>
    ({ ...source, kind: 'publication', publicationId })
  const current = publication(task, 'same-id')
  const otherReasons = ['budget', 'unsupported', 'self-published', 'recipient-irrelevant'] as const
  const kept = [{ source: parent, reason: 'withdrawn' as const }, ...otherReasons.map(reason => ({
    source: publication(task, reason), reason,
  }))]
  const delivery: SemanticDelivery = { task: input.task, recipient: input.recipient, inherited: input.inherited,
    mandatory: [...input.mandatory, { kind: 'unknown', coverage: { withdrawnSources: [{ count: 'opaque' }] } }], updates: [],
    coverage: { selectedSources: [task, current], omittedSources: [
      { source: publication(previous, 'same-id'), reason: 'withdrawn' },
      { source: publication(parent, 'same-id'), reason: 'withdrawn' },
      { source: publication(task, 'old-one'), reason: 'withdrawn' },
      { source: publication(task, 'old-two'), reason: 'withdrawn' },
      { source: publication(task, 'superseded'), reason: 'superseded' }, ...kept,
    ] } }
  const result = semanticWithdrawalTableDelivery(delivery)
  expect(result.mandatory).toEqual(delivery.mandatory)
  const expanded = expandedSchema.parse(expandSemanticText('<shared-work-updates>\n' + semanticJson(result) + '\n</shared-work-updates>'))
  expect(expanded.coverage.selectedSources).toEqual(delivery.coverage.selectedSources)
  expect(expanded.coverage.omittedSources).toEqual(kept)
  const counts = z.array(z.object({ source: z.json(), count: z.number() })).parse(expanded.coverage.withdrawnSources)
  expect(counts).toEqual([{ source: task, count: 2 }, { source: parent, count: 1 }, { source: previous, count: 1 }])
  expect(result.sourceTable).toContainEqual({ kind: 'publication', taskSourceIndex: 0, publicationId: 'same-id' })
  expect(result.coverage.withdrawnSources.map(item => item.taskSourceIndex))
    .toEqual([...result.coverage.withdrawnSources.map(item => item.taskSourceIndex)].sort((a, b) => a - b))
})

it('adds bounded explicit empty coverage to unchanged current C evidence and keeps its original allowance', () => {
  const recorded = z.object({ captured: z.json(), reply: semanticReplySchema, contextBytes: z.number() }).parse(JSON.parse(readFileSync(
    new URL('./fixtures/semantic-peer-command-c-captured.json', import.meta.url), 'utf8')) as unknown)
  const input = restoreSemanticInput(semanticJson(recorded.captured))
  const previous = projectSemanticReply(input, recorded.reply, recorded.contextBytes, 6)
  const current = projectSemanticReply(input, recorded.reply, recorded.contextBytes)
  const extra = Buffer.byteLength(current.text) - Buffer.byteLength(previous.text)
  expect(extra).toBeLessThan(210)
  expect(extra).toBeGreaterThan(0)
  expect(current.selectedSources).toEqual(previous.selectedSources)
  expect(current.omittedSources).toEqual(previous.omittedSources)
  expect(current.activation).toEqual(previous.activation)
  expect(expandedSchema.parse(expandSemanticText(current.text)).coverage.withdrawnSources).toEqual([])
})

it('cold-restores v6 and v7 exactly and rejects changed withdrawal counts, bases, terminal evidence, or result labels', () => {
  const { input, reply } = fixture()
  const request = semanticRequestSchema.parse({ version: 1, key: 'a'.repeat(64), ordinal: 1,
    backend: { id: 'semantic', revision: 'b'.repeat(64) }, call: { provider: 'fixture', model: 'fixture', maxTokens: 2048 },
    system: 'Summarize authorized reports.', purpose: 'context-summary', maxContextBytes: 100_000,
    messages: [{ id: 'request', role: 'user', source: { kind: 'plugin', plugin: 'dsh-development-task-context/semantic' },
      content: [{ type: 'text', text: semanticModelInput(input) }] }] })
  for (const version of [6, 7] as const) {
    const projection = projectSemanticReply(input, reply, request.maxContextBytes, version)
    const result = semanticResultSchema.parse({ version, key: request.key, requestSeq: 1, status: 'completed', projection,
      rawOutput: [{ type: 'text', text: JSON.stringify(reply) }], finish: { kind: 'stop' }, usage: null,
      elapsedMs: 1, error: null, rejectedChunk: null })
    expect(restoreSemanticProjection(semanticRequestSchema.parse(JSON.parse(JSON.stringify(request)) as unknown),
      semanticResultSchema.parse(JSON.parse(JSON.stringify(result)) as unknown))).toEqual(projection)
    expect(() => restoreSemanticProjection(request, semanticResultSchema.parse({ ...result, version: version === 6 ? 7 : 6 })))
      .toThrow('cached projection disagrees')
    if (version === 6) continue
    for (const text of [projection.text.replace('"count":49', '"count":48'),
      projection.text.replace('"withdrawnSources":[{"count":49,"taskSourceIndex":0}]',
        '"withdrawnSources":[{"count":49,"taskSourceIndex":1}]'), projection.text.replace('ended (left)', 'still active')]) {
      expect(text).not.toBe(projection.text)
      expect(() => restoreSemanticProjection(request, semanticResultSchema.parse({ ...result,
        projection: { ...projection, text } }))).toThrow('cached projection disagrees')
    }
  }
})
