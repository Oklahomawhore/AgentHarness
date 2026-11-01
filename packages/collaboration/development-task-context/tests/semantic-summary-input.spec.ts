/** Version-two requests separate bounded model messages from complete captured provenance. */
import { readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { semanticSummaryInput } from '../src/semantic-summary-input.ts'
import { restoreSemanticInput, restoreSemanticRequestInput, restoreSemanticProjection, semanticModelInput,
  projectSemanticReply } from '../src/semantic-input.ts'
import { semanticJson, semanticReplySchema, semanticRequestSchema, semanticRequestKey,
  semanticResultSchema, semanticSummaryInputSchema } from '../src/semantic-schema.ts'

function fixture() {
  const recorded = z.object({ captured: z.json(), reply: semanticReplySchema }).parse(JSON.parse(readFileSync(
    new URL('./fixtures/semantic-peer-command-c-captured.json', import.meta.url), 'utf8')) as unknown)
  return { input: restoreSemanticInput(semanticJson(recorded.captured)), reply: recorded.reply }
}

function request(input = fixture().input) {
  const fields = { version: 2 as const, capturedInput: semanticModelInput(input),
    backend: { id: 'semantic' as const, revision: 'b'.repeat(64) },
    call: { provider: 'fixture', model: 'fixture', maxTokens: 2048 }, system: 'Summarize authorized reports.',
    maxContextBytes: 6552, messages: [{ id: MessageId('request'), role: 'user' as const,
      source: { kind: 'plugin' as const, plugin: 'dsh-development-task-context/semantic' as const },
      content: [{ type: 'text' as const, text: semanticSummaryInput(input) }] }] }
  return semanticRequestSchema.parse({ ...fields, key: semanticRequestKey(fields), ordinal: 1, purpose: 'context-summary' })
}

it('preserves complete current fields and counts only superseded publication coverage by exact Task revision', () => {
  const { input } = fixture()
  const original = JSON.parse(semanticModelInput(input)) as unknown
  const full = z.object({ coverage: z.object({
    selectedSources: z.array(z.json()), omittedSources: z.array(z.json()),
  }) }).loose().parse(original)
  const wire = semanticSummaryInputSchema.parse(JSON.parse(semanticSummaryInput(input)) as unknown)
  expect(wire).toEqual({ ...full, coverage: { selectedSources: full.coverage.selectedSources, omittedSources: [],
    supersededSources: [{ source: { kind: 'task', taskId: input.task.id, revision: input.task.revision }, count: 2 }] } })
  const task = { kind: 'task' as const, taskId: input.task.id, revision: input.task.revision }
  const parent = { ...task, taskId: brandString<typeof task.taskId>('parent') }
  const previous = { ...task, revision: task.revision - 1 }
  const next = { ...input, omitted: [...input.omitted,
    ...[previous, parent].map(source => ({ source: { ...source, kind: 'publication' as const, publicationId: 'same-id' },
      reason: 'superseded' as const })), { source: task, reason: 'superseded' as const },
    ...(['budget', 'withdrawn', 'unsupported', 'self-published', 'recipient-irrelevant'] as const).map(reason => ({
      source: { ...task, kind: 'publication' as const, publicationId: reason }, reason,
    }))], mandatory: [...input.mandatory, { kind: 'unknown', sourceIndex: 10, coverage: { supersededSources: 'opaque' } }] }
  const displayed = semanticSummaryInputSchema.parse(JSON.parse(semanticSummaryInput(next)) as unknown)
  expect(displayed.coverage.supersededSources).toEqual([
    { source: task, count: 2 }, { source: previous, count: 1 }, { source: parent, count: 1 },
  ])
  expect(displayed.coverage.omittedSources).toEqual(next.omitted.slice(4))
  expect(displayed.mandatory).toEqual(next.mandatory)
  expect(displayed.sources).toEqual(next.sources)
  const empty = semanticSummaryInputSchema.parse(JSON.parse(semanticSummaryInput({ ...input, omitted: [] })) as unknown)
  expect(empty.coverage.supersededSources).toEqual([])
})

it('binds distinct complete historical identities even when their actual model messages are identical', () => {
  const { input, reply } = fixture()
  const changed = { ...input, omitted: input.omitted.map(item => ({ ...item,
    source: item.source.kind === 'publication' ? { ...item.source, publicationId: item.source.publicationId + '-different' } : item.source })) }
  const first = request(input)
  const second = request(changed)
  expect(first.messages).toEqual(second.messages)
  expect(first.key).not.toEqual(second.key)
  const one = projectSemanticReply(input, reply, 6552)
  const two = projectSemanticReply(changed, reply, 6552)
  expect(one.text).toBe(two.text)
  expect(one.activation).toEqual(two.activation)
  expect(one.omittedSources).not.toEqual(two.omittedSources)
  for (const [capture, projection] of [[first, one], [second, two]] as const) {
    const result = semanticResultSchema.parse({ version: 7, key: capture.key, requestSeq: 1, status: 'completed', projection,
      rawOutput: [{ type: 'text', text: JSON.stringify(reply) }], finish: { kind: 'stop' }, usage: null,
      elapsedMs: 1, error: null, rejectedChunk: null })
    expect(restoreSemanticProjection(capture, result)).toEqual(projection)
    const other = capture === first ? second : first
    expect(() => restoreSemanticProjection(other, result)).toThrow('cached projection disagrees')
  }
})

it('round-trips complete request capture and refuses altered model counts, source bodies, or capture bodies', () => {
  const first = request()
  if (first.version !== 2) throw new Error('expected version-two fixture')
  const restored = semanticRequestSchema.parse(JSON.parse(JSON.stringify(first)) as unknown)
  expect(semanticModelInput(restoreSemanticRequestInput(restored))).toBe(first.capturedInput)
  for (const text of [first.messages[0]!.content[0]!.text.replace('"count":2', '"count":3'),
    first.messages[0]!.content[0]!.text.replace('maxRetries: 3', 'maxRetries: 9')]) {
    const changed = { ...first, messages: first.messages.map(message => ({ ...message, content: [{ type: 'text' as const, text }] })) }
    expect(() => restoreSemanticRequestInput(changed)).toThrow('model input disagrees')
  }
  expect(() => restoreSemanticRequestInput({ ...first, capturedInput: first.capturedInput.replace('maxRetries: 3', 'maxRetries: 9') }))
    .toThrow('model input disagrees')
  expect(() => restoreSemanticRequestInput({ ...first, capturedInput: '{}' })).toThrow()
})

it('retains the exact legacy key algorithm and supports an explicit v1 discriminator without changing it', () => {
  const { capturedInput: _capturedInput, version: _version, ...fields } = requestFields()
  const expected = '6930f484ea408c251c3f4cef70af9d96f8efd27184e2b40be5256ecca3bcf76f'
  expect(semanticRequestKey(fields)).toBe(expected)
  expect(semanticRequestKey({ ...fields, version: 1 })).toBe(expected)
  const original = semanticRequestSchema.parse({ ...fields, version: 1, key: expected, ordinal: 1, purpose: 'context-summary' })
  expect(semanticModelInput(restoreSemanticRequestInput(original))).toBe(fields.messages[0]!.content[0]!.text)
})

function requestFields() {
  const original = request()
  if (original.version !== 2) throw new Error('expected captured fixture')
  return { ...original, messages: original.messages.map(message => ({ ...message,
    content: [{ type: 'text' as const, text: original.capturedInput }] })) }
}
