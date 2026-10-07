/** Persisted semantic inputs and raw model replies retain exact evidence or fail closed during replay. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DevelopmentTaskContextInput } from '../src/types.ts'
import { prepareSemanticInput, projectSemanticReply, restoreSemanticInput, restoreSemanticProjection, semanticModelInput,
  type SemanticInput } from '../src/semantic-input.ts'
import { semanticDigest, semanticJson, semanticRequestSchema, semanticResultSchema } from '../src/semantic-schema.ts'

function fixture() {
  const source = { kind: 'publication' as const, taskId: 'task', revision: 2, publicationId: 'report' }
  const sourceId = semanticDigest(source)
  const captured = {
    task: { id: 'task', revision: 2, objective: 'Maintain payments', scope: 'Client', origin: { kind: 'root' } },
    recipient: { participantId: 'reader', sessionLabel: 'Frontend' }, inherited: [], mandatory: [],
    sources: [{ sourceId, source, body: 'retry limit 3; 原始证据', attribution: { basis: 'current-task-report' } }],
    coverage: { selectedSources: [{ kind: 'task', taskId: 'task', revision: 2 }], omittedSources: [] },
  }
  const input = restoreSemanticInput(semanticJson(captured))
  return { source, sourceId, captured, input }
}

function reply(input: SemanticInput) {
  return { version: 1, decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
    updates: input.sources.map(source => ({ text: 'Use the reported retry limit.',
      sources: [{ sourceId: source.sourceId, quote: source.body }] })) }
}

function audit(input = fixture().input) {
  const response = reply(input)
  const projection = projectSemanticReply(input, response, 20_000)
  const request = semanticRequestSchema.parse({
    version: 1, key: 'a'.repeat(64), ordinal: 1, backend: { id: 'semantic', revision: 'b'.repeat(64) },
    call: { provider: 'fixture', model: 'fixture', maxTokens: 1000 }, system: 'Summarize the authorized evidence.',
    messages: [{ id: 'captured-request', role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-development-task-context/semantic' },
      content: [{ type: 'text', text: semanticModelInput(input) }] }],
    purpose: 'context-summary', maxContextBytes: 20_000,
  })
  const result = semanticResultSchema.parse({ version: 2, key: request.key, requestSeq: 1, status: 'completed',
    rawOutput: [{ type: 'text', text: JSON.stringify(response) }], finish: { kind: 'stop' }, projection,
    usage: null, elapsedMs: 1, error: null, rejectedChunk: null })
  return { request, result, response, projection }
}

it.each(['unknown', 'repeated', 'missing'] as const)('rejects an untrusted %s relevance decision', (kind) => {
  const { input, sourceId } = fixture()
  const decisions = kind === 'missing' ? [] : kind === 'unknown' ? [{ sourceId: '0'.repeat(64), relevant: false }]
    : [{ sourceId, relevant: false }, { sourceId, relevant: false }]
  expect(() => projectSemanticReply(input, { version: 1, decisions, updates: [] }, 20_000))
    .toThrow(kind === 'missing' ? 'missing source relevance decision' : 'unknown or repeated decision source')
})

it('rejects a relevant decision without an attributed update', () => {
  const { input, sourceId } = fixture()
  expect(() => projectSemanticReply(input, {
    version: 1, decisions: [{ sourceId, relevant: true }], updates: [],
  }, 20_000)).toThrow('relevant source has no quoted update')
})

it.each(['unknown', 'irrelevant', 'repeated', 'changed-quote'] as const)('rejects an untrusted %s quoted source', (kind) => {
  const { input, sourceId } = fixture()
  const reference = { sourceId: kind === 'unknown' ? '0'.repeat(64) : sourceId,
    quote: kind === 'changed-quote' ? 'retry limit 9' : 'retry limit 3' }
  expect(() => projectSemanticReply(input, { version: 1,
    decisions: [{ sourceId, relevant: kind !== 'irrelevant' }],
    updates: [{ text: 'Use the reported retry limit.', sources: kind === 'repeated' ? [reference, reference] : [reference] }],
  }, 20_000)).toThrow('invalid source, relevance, or exact quote')
})

it.each(['duplicate', 'unrelated', 'identity'] as const)('rejects %s source evidence in persisted prompt JSON', (kind) => {
  const { captured, source } = fixture()
  const changed = kind === 'duplicate'
    ? { ...captured, coverage: { ...captured.coverage, omittedSources: [{ source, reason: 'budget' }] } }
    : { ...captured, sources: captured.sources.map(item => kind === 'identity'
      ? { ...item, sourceId: '0'.repeat(64) } : { ...item, source: { ...source, taskId: 'unrelated' } }) }
  expect(() => restoreSemanticInput(semanticJson(changed)))
    .toThrow(kind === 'identity' ? 'source identity does not match' : 'duplicate or unrelated captured source')
})

it('reconstructs omitted-source coverage and an absent historical recipient label exactly', () => {
  const { captured, source } = fixture()
  const input = restoreSemanticInput(semanticJson({ ...captured, recipient: { participantId: 'reader' },
    coverage: { ...captured.coverage, omittedSources: [{ source: { ...source, publicationId: 'omitted' }, reason: 'withdrawn' }] },
  }))
  expect(input.recipient).toEqual({ participantId: 'reader' })
  const { request, result, projection } = audit(input)
  expect(restoreSemanticProjection(request, result)).toEqual(projection)
  expect(projection.omittedSources).toEqual([{ source: { ...source, publicationId: 'omitted' }, reason: 'withdrawn' }])
})

it('preserves permitted opaque legacy attribution and mandatory JSON rather than discarding it during replay', () => {
  const { captured } = fixture()
  const mandatory = [null, ['legacy notice'], { basis: 'old-format', notice: 'do not infer current state' },
    { basis: 'current-task-as-reported', source: { taskId: 'parent', revision: 2 } },
    { basis: 'current-task-as-reported', source: { taskId: 'task', revision: 1 } },
    { basis: 'current-task-as-reported', source: ['legacy source'] }]
  const input = restoreSemanticInput(semanticJson({ ...captured, mandatory,
    sources: captured.sources.map(item => ({ ...item, attribution: ['legacy attribution'] })),
  }))
  const { request, result, projection } = audit(input)
  expect(restoreSemanticProjection(request, result)).toEqual(projection)
  expect(projection.text).toContain(semanticJson(mandatory))
  expect(projection.text).toContain('legacy attribution')
  const changed = restoreSemanticInput(semanticJson({ ...captured, mandatory: [...mandatory, 'new historical notice'] }))
  expect(audit(changed).projection.activation).not.toEqual(projection.activation)
})

it('retains task-source references accepted by the persisted input format without inventing publication identifiers', () => {
  const { captured } = fixture()
  const source = { kind: 'task', taskId: captured.task.id, revision: captured.task.revision }
  const input = restoreSemanticInput(semanticJson({ ...captured,
    sources: [{ sourceId: semanticDigest(source), source, body: 'retry limit 3', attribution: { basis: 'current-task-report' } }],
    coverage: { selectedSources: [], omittedSources: [] },
  }))
  const { request, result, projection } = audit(input)
  expect(restoreSemanticProjection(request, result)).toEqual(projection)
  expect(projection.selectedSources).toEqual([source])
  expect(projection.text).not.toContain('publicationId')
})

it.each([null, 'stop', [], { kind: 'length' }].map(finish => ({ finish })))(
  'rejects an incomplete persisted finish %j', ({ finish }) => {
    const { request, result } = audit()
    const parsed = semanticResultSchema.parse({ ...result, finish })
    expect(() => restoreSemanticProjection(request, parsed)).toThrow('complete model finish')
  },
)

it('refuses to replay a persisted failed computation as a completed projection', () => {
  const { request, result } = audit()
  const failed = semanticResultSchema.parse({ ...result, status: 'failed', projection: null, error: 'interrupted' })
  expect(() => restoreSemanticProjection(request, failed)).toThrow('complete model finish')
})

it.each([null, [], 1, { type: 'image', text: 'untrusted' }, { type: 'text', text: 1 }].map(block => ({ block })))(
  'rejects invalid raw-output JSON block %j before rebuilding a cached result', ({ block }) => {
    const { request, result } = audit()
    const parsed = semanticResultSchema.parse({ ...result, rawOutput: [block] })
    expect(() => restoreSemanticProjection(request, parsed)).toThrow('invalid block')
  },
)

it('reassembles text chunks while retaining reasoning only in the original audit record', () => {
  const { request, result, response, projection } = audit()
  const text = JSON.stringify(response)
  const parsed = semanticResultSchema.parse({ ...result, rawOutput: [
    { type: 'text', text: text.slice(0, 17) }, { type: 'reasoning', text: 'PRIVATE_SUMMARY_REASONING' },
    { type: 'text', text: text.slice(17) },
  ] })
  expect(restoreSemanticProjection(request, parsed)).toEqual(projection)
  expect(projection.text).not.toContain('PRIVATE_SUMMARY_REASONING')
  expect(parsed.rawOutput).toContainEqual({ type: 'reasoning', text: 'PRIVATE_SUMMARY_REASONING' })
})

it('rejects an absent captured prompt at both the durable parser and the typed replay helper', () => {
  const { request } = audit()
  const emptyRequests = [{ ...request, messages: [] }, { ...request,
    messages: request.messages.map(message => ({ ...message, content: [] })),
  }]
  for (const empty of emptyRequests) {
    expect(semanticRequestSchema.safeParse(empty).success).toBe(false)
    expect(() => restoreSemanticProjection(empty, audit().result)).toThrow('missing captured prompt')
  }
})


it('round-trips a captured frozen-parent basis and its original publication without a model call', () => {
  const { input } = fixture()
  const parent = { taskId: brandString<typeof input.task.id>('parent-task'), revision: 7 }
  const value: DevelopmentTaskContextInput = { view: {
    task: { ...input.task, origin: { kind: 'root' }, runtime: 'ready', context: [], createdAt: 1, updatedAt: 2,
      createdBy: input.recipient.participantId,
      ownerNodeId: brandString<DevelopmentTaskContextInput['view']['task']['ownerNodeId']>('owner-node'),
      hiddenRoomId: brandString<DevelopmentTaskContextInput['view']['task']['hiddenRoomId']>('task-room') },
    inherited: { id: brandString<NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id']>('frozen-parent'),
      createdAt: 1, sources: [{ parent, objective: 'Original payment API', scope: 'Parent responsibility',
        context: [{ id: 'parent-report', publishedAt: 1, text: 'retry limit 3; frozen original evidence',
          publishedBy: brandString<typeof input.recipient.participantId>('parent-author') }] }] },
  }, recipient: input.recipient, maxContextBytes: 20_000, signal: new AbortController().signal }
  const prepared = prepareSemanticInput(value)
  const restored = restoreSemanticInput(semanticModelInput(prepared))
  expect(restored).toEqual(prepared)
  expect(restored.inherited).toEqual([{ parent, objective: 'Original payment API', scope: 'Parent responsibility' }])
  expect(restored.sources).toHaveLength(1)
  expect(restored.sources[0]?.source).toEqual({ kind: 'publication', ...parent, publicationId: 'parent-report' })
  expect(restored.sources[0]?.attribution).toMatchObject({ basis: 'frozen-parent-snapshot' })
  const { request, result, projection } = audit(restored)
  expect(restoreSemanticProjection(request, result)).toEqual(projection)
  expect(projection.selectedSources).toContainEqual({ kind: 'task', ...parent })
})
