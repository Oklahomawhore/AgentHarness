/** Version-four display tables preserve complete delivery JSON while removing repeated references and authorization. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { semanticTableDelivery, type SemanticDelivery } from '../src/semantic-display.ts'
import { projectSemanticReply, restoreSemanticInput, restoreSemanticProjection, semanticModelInput } from '../src/semantic-input.ts'
import { semanticDigest, semanticJson, semanticRequestSchema, semanticResultSchema } from '../src/semantic-schema.ts'
import { expandSemanticText, semanticTextValue } from './fixtures/semantic-display.ts'

function fixture() {
  const task = { id: 'current-task', revision: 7, objective: 'Payment behavior', scope: 'Shared project', origin: { kind: 'root' } }
  const authorization = { taskId: task.id, participantId: 'owner-agent', bindingId: 'binding',
    expectedBindingEpoch: { nodeId: 'owner', seq: 1 }, captureId: 'capture', captureGeneration: 'generation',
    source: { kind: 'tool-observations', version: 4, name: 'project-work', tools: ['Write', 'Edit'],
      commands: [{ command: 'pnpm verify', rootIndex: 0 }] } }
  const refs = [
    { kind: 'publication', taskId: task.id, revision: 7, publicationId: 'same-publication' },
    { kind: 'publication', taskId: task.id, revision: 7, publicationId: 'correction' },
    { kind: 'publication', taskId: 'parent-task', revision: 7, publicationId: 'same-publication' },
    { kind: 'publication', taskId: task.id, revision: 6, publicationId: 'same-publication' },
  ]
  const sources = refs.map((source, index) => ({ source, sourceId: semanticDigest(source),
    body: `报告 ${String(index)}: <required accountId>; retry at most once.`,
    attribution: { basis: index < 2 ? 'current-task-report' : 'frozen-parent-snapshot', publishedBy: 'owner-agent',
      sequence: index + 1, localAuthorization: index < 2 ? authorization : { ...authorization, taskId: source.taskId } },
  }))
  const command = { kind: 'publication', taskId: task.id, revision: 7, publicationId: 'command-failure' }
  const captured = { task, recipient: { participantId: 'receiver', sessionLabel: 'Implement client policy' },
    inherited: [{ parent: { taskId: 'parent-task', revision: 7 }, objective: 'Parent API', scope: 'Original reports' },
      { parent: { taskId: task.id, revision: 6 }, objective: 'Frozen client policy', scope: 'Original reports' }], sources,
    mandatory: [{ kind: 'command-evidence', basis: 'current-task-as-reported', source: command,
      publication: { id: command.publicationId, text: 'Custom command warning. Preserve this verbatim. 中文',
        grant: authorization, observation: { exitCode: 7, signal: null, aborted: false, timedOut: false,
          stdout: { state: 'included', text: 'FAILED <checks>', truncated: true },
          stderr: { state: 'omitted', reason: 'budget' } } } },
    { sourceIndex: 999, authorizationIndex: 99, source: { custom: 'opaque source' }, notice: 'Do not reinterpret these keys.' }],
    coverage: { selectedSources: [{ kind: 'task', taskId: task.id, revision: 7 },
      { kind: 'task', taskId: 'parent-task', revision: 7 }, { kind: 'task', taskId: task.id, revision: 6 }, command],
    omittedSources: [{ source: { kind: 'publication', taskId: task.id, revision: 7, publicationId: 'old-pass' }, reason: 'superseded' },
      { source: { kind: 'publication', taskId: task.id, revision: 7, publicationId: 'withdrawn' }, reason: 'withdrawn' }] } }
  const input = restoreSemanticInput(semanticJson(captured))
  const response = { version: 1, decisions: sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
    updates: sources.map(source => ({ text: source.body, sources: [{ sourceId: source.sourceId, quote: source.body }] })) }
  return { captured, input, response }
}

function projected() {
  const { input, response } = fixture()
  return { input, response, expanded: projectSemanticReply(input, response, 30_000, 3),
    compact: projectSemanticReply(input, response, 30_000, 4) }
}

it('preserves all expanded delivery fields, opaque mandatory JSON, and version-three activation', () => {
  const { expanded, compact } = projected()
  expect(expandSemanticText(compact.text)).toEqual(semanticTextValue(expanded.text))
  expect(compact.selectedSources).toEqual(expanded.selectedSources)
  expect(compact.omittedSources).toEqual(expanded.omittedSources)
  expect(compact.activation).toEqual(expanded.activation)
  expect(Buffer.byteLength(compact.text)).toBeLessThan(Buffer.byteLength(expanded.text))
  expect(compact.text).toContain('Indexes are zero-based.')
  expect(compact.text).toContain('Do not reinterpret these keys.')
})

it('keeps the same publication identifier distinct across Tasks and frozen revisions', () => {
  const { expanded, compact } = projected()
  const decoded = z.object({ updates: z.array(z.object({ sources: z.array(z.object({ source: z.json() })) })) })
    .parse(expandSemanticText(compact.text))
  const refs = decoded.updates.flatMap(update => update.sources.map(source => source.source))
  expect(refs).toContainEqual({ kind: 'publication', taskId: 'current-task', revision: 7, publicationId: 'same-publication' })
  expect(refs).toContainEqual({ kind: 'publication', taskId: 'parent-task', revision: 7, publicationId: 'same-publication' })
  expect(refs).toContainEqual({ kind: 'publication', taskId: 'current-task', revision: 6, publicationId: 'same-publication' })
  expect(expandSemanticText(compact.text)).toEqual(semanticTextValue(expanded.text))
})

it('shares identical authorization objects and one source across multiple quoted updates', () => {
  const { input, response } = fixture()
  const repeated = { ...response, updates: [...response.updates, ...response.updates] }
  const legacy = projectSemanticReply(input, repeated, 30_000, 3)
  const compact = projectSemanticReply(input, repeated, 30_000, 4)
  const display = z.object({ authorizationTable: z.array(z.json()), sourceTable: z.array(z.json()) })
    .parse(semanticTextValue(compact.text))
  expect(display.authorizationTable).toHaveLength(2)
  expect(display.sourceTable).toHaveLength(compact.selectedSources.length + compact.omittedSources.length)
  expect(expandSemanticText(compact.text)).toEqual(semanticTextValue(legacy.text))
})

it.each([null, ['legacy'], { basis: 'old-format', localAuthorization: { authorizationIndex: 77 } },
  { basis: 'current-task-report', localAuthorization: null, authorization: 'legacy reference' },
  { basis: 'frozen-parent-snapshot', authorization: { authorizationIndex: 77, custom: 'retain complete object' }, sourceIndex: 91 },
].map(attribution => ({ attribution })))(
  'retains unknown or collision-shaped attribution %j without recursive interpretation', ({ attribution }) => {
    const { captured, response } = fixture()
    const input = restoreSemanticInput(semanticJson({ ...captured,
      sources: captured.sources.map(source => ({ ...source, attribution })) }))
    const expanded = projectSemanticReply(input, response, 30_000, 3)
    const compact = projectSemanticReply(input, response, 30_000, 4)
    expect(expandSemanticText(compact.text)).toEqual(semanticTextValue(expanded.text))
    expect(compact.activation).toEqual(expanded.activation)
  },
)

it('represents a legacy publication basis without adding it to selected coverage', () => {
  const { captured, response } = fixture()
  const input = restoreSemanticInput(semanticJson({ ...captured,
    coverage: { ...captured.coverage, selectedSources: [] } }))
  const compact = projectSemanticReply(input, response, 30_000, 4)
  expect(compact.selectedSources.every(source => source.kind === 'publication')).toBe(true)
  expect(expandSemanticText(compact.text)).toEqual(semanticTextValue(projectSemanticReply(input, response, 30_000, 3).text))
})

it('counts complete UTF-8 framing and escaped source text at the exact limit', () => {
  const { input, response, compact } = projected()
  const limit = Buffer.byteLength(compact.text, 'utf8')
  expect(compact.text.length).toBeLessThan(limit)
  expect(compact.text).toContain('\\u003c')
  expect(projectSemanticReply(input, response, limit, 4)).toEqual(compact)
  expect(() => projectSemanticReply(input, response, limit - 1, 4)).toThrow('exceed maxContextBytes')
})

it('rejects conflicting attribution for one exact source instead of losing an earlier value', () => {
  const { input } = fixture()
  const source = input.selected[0]
  if (source === undefined) throw new Error('missing Task reference')
  const delivery: SemanticDelivery = { task: input.task, recipient: input.recipient, inherited: input.inherited, mandatory: [],
    coverage: { selectedSources: input.selected, omittedSources: [] }, updates: [{ text: 'Reported work', sources: [
      { source, quote: 'first', attribution: { author: 'one' } }, { source, quote: 'second', attribution: { author: 'two' } },
    ] }] }
  expect(() => semanticTableDelivery(delivery)).toThrow('conflicting attribution')
})

it('cold-reconstructs the exact v4 text from sorted captured input and rejects changed table references', () => {
  const { input, response, compact } = projected()
  const request = semanticRequestSchema.parse({ version: 1, key: 'a'.repeat(64), ordinal: 1,
    backend: { id: 'semantic', revision: 'b'.repeat(64) }, call: { provider: 'fixture', model: 'fixture', maxTokens: 1000 },
    system: 'Summarize authorized reports.', purpose: 'context-summary', maxContextBytes: 30_000,
    messages: [{ id: 'request', role: 'user', source: { kind: 'plugin', plugin: 'dsh-development-task-context/semantic' },
      content: [{ type: 'text', text: semanticModelInput(input) }] }] })
  const result = semanticResultSchema.parse({ version: 4, key: request.key, requestSeq: 1, status: 'completed',
    rawOutput: [{ type: 'text', text: JSON.stringify(response) }], finish: { kind: 'stop' }, projection: compact,
    usage: null, elapsedMs: 1, error: null, rejectedChunk: null })
  expect(restoreSemanticProjection(request, result)).toEqual(compact)
  const changed = semanticResultSchema.parse({ ...result, projection: { ...compact,
    text: compact.text.replace('"sourceIndex":4', '"sourceIndex":5') } })
  expect(changed.projection?.text).not.toEqual(compact.text)
  expect(() => restoreSemanticProjection(request, changed)).toThrow('cached projection disagrees')
  for (const version of [1, 2, 3] as const) {
    const original = projectSemanticReply(input, response, 30_000, version)
    const historical = semanticResultSchema.parse({ ...result, version, projection: original })
    expect(restoreSemanticProjection(request, historical)).toEqual(original)
    if (version === 1) {
      expect(semanticResultSchema.safeParse({ ...historical, version: 4 }).success).toBe(false)
    } else {
      const relabeled = semanticResultSchema.parse({ ...historical, version: 4 })
      expect(() => restoreSemanticProjection(request, relabeled)).toThrow('cached projection disagrees')
    }
  }
})
