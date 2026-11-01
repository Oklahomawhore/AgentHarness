/** Version-five mandatory references retain exact captured peer command evidence and all historical projection algorithms. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { semanticMandatoryTableDelivery } from '../src/semantic-mandatory-display.ts'
import { semanticTableDelivery, type SemanticDelivery } from '../src/semantic-display.ts'
import { projectSemanticReply, restoreSemanticInput, restoreSemanticProjection, semanticModelInput } from '../src/semantic-input.ts'
import { semanticJson, semanticReplySchema, semanticRequestSchema, semanticResultSchema } from '../src/semantic-schema.ts'
import { expandSemanticText, semanticTextValue } from './fixtures/semantic-display.ts'

const fixtureSchema = z.object({ captured: z.json(), reply: semanticReplySchema, contextBytes: z.number(),
  v4Bytes: z.number(), v4Sha256: z.string() })
const jsonRecord = z.record(z.string(), z.unknown())

function fixture(name = 'semantic-peer-command-captured.json') {
  const file = new URL(`./fixtures/${name}`, import.meta.url)
  const recorded = fixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  const input = restoreSemanticInput(semanticJson(recorded.captured))
  const expanded = projectSemanticReply(input, recorded.reply, 30_000, 3)
  // This value was produced by the typed expanded projector immediately above.
  const delivery = semanticTextValue(expanded.text) as SemanticDelivery
  return { ...recorded, input, expanded, delivery }
}

function changed(value: unknown, path: readonly string[], replacement: unknown): unknown {
  const result: unknown = structuredClone(value)
  let cursor = result
  for (const key of path.slice(0, -1)) {
    if (typeof cursor !== 'object' || cursor === null) throw new Error('fixture path is not an object')
    cursor = (cursor as Record<string, unknown>)[key]
  }
  const key = path.at(-1)
  if (key === undefined || typeof cursor !== 'object' || cursor === null) throw new Error('fixture leaf is not an object')
  const leaf = cursor as Record<string, unknown>
  leaf[key] = replacement
  return result
}

function text(value: unknown): string { return '<shared-work-updates>\n' + semanticJson(value) + '\n</shared-work-updates>' }

it.each([
  { role: 'B', name: 'semantic-peer-command-captured.json', expectedBytes: 6509 },
  { role: 'C', name: 'semantic-peer-command-c-captured.json', expectedBytes: 6538 },
])('fits the original two-source reply and complete command evidence inside the measured $role allowance', ({ name, expectedBytes }) => {
  const { input, reply, contextBytes, v4Bytes, v4Sha256, expanded } = fixture(name)
  const previous = projectSemanticReply(input, reply, 30_000, 4)
  expect(Buffer.byteLength(previous.text)).toBe(v4Bytes)
  expect(createHash('sha256').update(previous.text).digest('hex')).toBe(v4Sha256)
  expect(() => projectSemanticReply(input, reply, contextBytes, 4)).toThrow('exceed maxContextBytes')
  const current = projectSemanticReply(input, reply, contextBytes, 5)
  expect(expandSemanticText(current.text)).toEqual(semanticTextValue(expanded.text))
  expect(current.activation).toEqual(previous.activation)
  expect(current.selectedSources).toEqual(previous.selectedSources)
  expect(current.omittedSources).toEqual(previous.omittedSources)
  expect(Buffer.byteLength(current.text)).toBe(expectedBytes)
  const displayed = z.object({ mandatoryReferences: z.array(z.number()), mandatory: z.array(z.unknown()) })
    .parse(semanticTextValue(current.text))
  expect(displayed.mandatoryReferences).toEqual([0])
  const original = jsonRecord.parse(input.mandatory[0])
  const actual = jsonRecord.parse(displayed.mandatory[0])
  expect(jsonRecord.parse(actual.publication).peerToolObservation).toEqual(jsonRecord.parse(original.publication).peerToolObservation)
  expect(projectSemanticReply(input, reply, expectedBytes, 5)).toEqual(current)
  expect(() => projectSemanticReply(input, reply, expectedBytes - 1, 5)).toThrow('exceed maxContextBytes')
})

const unencoded = [
  { name: 'null', path: [], value: null },
  { name: 'array', path: [], value: [] },
  { name: 'unknown kind', path: ['kind'], value: 'opaque-command' },
  { name: 'unknown basis', path: ['basis'], value: 'unknown-basis' },
  { name: 'existing sourceIndex', path: ['sourceIndex'], value: 99 },
  { name: 'missing source', path: ['source'], value: null },
  { name: 'non-publication source', path: ['source', 'kind'], value: 'task' },
  { name: 'unrelated source', path: ['source', 'publicationId'], value: 'not-selected' },
  { name: 'unknown publication', path: ['publication'], value: null },
  { name: 'different publication identity', path: ['publication', 'id'], value: 'other-publication' },
  { name: 'missing command observation', path: ['publication', 'peerToolObservation'], value: null },
  { name: 'unknown observation kind', path: ['publication', 'peerToolObservation', 'kind'], value: 'custom' },
  { name: 'unknown command version', path: ['publication', 'peerToolObservation', 'version'], value: 8 },
  { name: 'missing peer contribution', path: ['publication', 'peerContribution'], value: null },
  { name: 'unknown peer contribution version', path: ['publication', 'peerContribution', 'version'], value: 2 },
  { name: 'missing grant', path: ['publication', 'peerContribution', 'grant'], value: null },
  { name: 'unknown grant version', path: ['publication', 'peerContribution', 'grant', 'version'], value: 2 },
  { name: 'another grant Task', path: ['publication', 'peerContribution', 'grant', 'taskId'], value: 'other-task' },
  { name: 'existing authorizationIndex', path: ['publication', 'peerContribution', 'grant', 'authorizationIndex'], value: 0 },
  { name: 'non-string authority', path: ['publication', 'peerContribution', 'grant', 'grantId'], value: 10 },
  { name: 'nonmatching grant', path: ['publication', 'peerContribution', 'grant', 'grantId'], value: 'other-grant' },
]
it.each(unencoded)('retains complete $name mandatory records without guessing references', ({ path, value }) => {
  const { delivery } = fixture()
  const mandatory = path.length === 0 ? value : changed(delivery.mandatory[0], path, value)
  const original = { ...delivery, mandatory: [mandatory] }
  expect(semanticMandatoryTableDelivery(original)).toEqual(semanticTableDelivery(original))
})

it.each([null, [], {}, { custom: 'opaque' }, { ownerPeerId: 10, contributorPeerId: 'peer', grantId: 'grant',
  generation: 'generation', captureId: 'capture', captureGeneration: 'capture-generation' }])(
  'keeps command evidence complete when existing quoted authorization cannot be reused: %j', (authorization) => {
    const { delivery } = fixture()
    const original = { ...delivery, updates: delivery.updates.map(update => ({ ...update,
      sources: update.sources.map(source => ({ ...source, attribution: { basis: 'current-task-report', authorization } })) })) }
    expect(semanticMandatoryTableDelivery(original)).toEqual(semanticTableDelivery(original))
  },
)

it('marks only encoded entries and leaves collision-shaped opaque JSON and withdrawals unchanged', () => {
  const { delivery } = fixture()
  const opaque = { kind: 'unknown', sourceIndex: 0, publication: { peerContribution: { grant: { authorizationIndex: 0 } } } }
  const withdrawal = { kind: 'withdrawal', sourceIndex: 91, publication: { ended: 'revoked', text: 'Retain withdrawn evidence.' } }
  const original = { ...delivery, mandatory: [...delivery.mandatory, opaque, withdrawal] }
  const encoded = semanticMandatoryTableDelivery(original)
  expect(encoded).toHaveProperty('mandatoryReferences', [0])
  expect(encoded.mandatory.slice(1)).toEqual([opaque, withdrawal])
  expect(expandSemanticText(text(encoded))).toEqual(original)
})

it('keeps one publication identifier distinct in current and inherited Task revisions', () => {
  const { delivery } = fixture()
  const original = jsonRecord.parse(delivery.mandatory[0])
  const source = jsonRecord.parse(original.source)
  const historical = { ...original, basis: 'frozen-parent-snapshot', source: { ...source, revision: 10 } }
  const publication = z.object({ kind: z.literal('publication'), taskId: z.string(), revision: z.number(), publicationId: z.string() })
    .parse(historical.source)
  // These refs originate from the existing typed fixture; only their frozen revision changes.
  const historicalSource = { ...delivery.coverage.selectedSources[1]!, revision: publication.revision }
  const extended = { ...delivery, mandatory: [...delivery.mandatory, historical],
    coverage: { ...delivery.coverage, selectedSources: [...delivery.coverage.selectedSources, historicalSource] } }
  const encoded = semanticMandatoryTableDelivery(extended)
  expect(encoded).toHaveProperty('mandatoryReferences', [0, 1])
  const indexes = encoded.mandatory.map(value => jsonRecord.parse(value).sourceIndex)
  expect(indexes[0]).not.toBe(indexes[1])
  expect(expandSemanticText(text(encoded))).toEqual(extended)
})

it('uses distinct authorization entries for different grants without losing grant-specific limits', () => {
  const { delivery } = fixture()
  const original = jsonRecord.parse(delivery.mandatory[0])
  const publication = jsonRecord.parse(original.publication)
  const contribution = jsonRecord.parse(publication.peerContribution)
  const grant = jsonRecord.parse(contribution.grant)
  const authorization = jsonRecord.parse(jsonRecord.parse(delivery.updates[0]?.sources[0]?.attribution).authorization)
  const other = { ...authorization, grantId: 'another-grant', generation: 'another-generation' }
  const second = { ...original, publication: { ...publication,
    peerContribution: { ...contribution, grant: { ...grant, ...other, maxSamples: 2, expiresAt: 42 } } } }
  const citation = delivery.updates[0]?.sources[0]
  if (citation === undefined) throw new Error('missing quoted source')
  const attributed = { ...citation, source: { ...citation.source, publicationId: 'different-owner-file', kind: 'publication' as const },
    attribution: { basis: 'current-task-report', authorization: other } }
  const extended: SemanticDelivery = { ...delivery, mandatory: [...delivery.mandatory, second],
    updates: [...delivery.updates, { text: 'Another authorized report.', sources: [attributed] }] }
  const encoded = semanticMandatoryTableDelivery(extended)
  expect(encoded).toHaveProperty('mandatoryReferences', [0, 1])
  const grants = encoded.mandatory.map((value) => {
    const publication = jsonRecord.parse(jsonRecord.parse(value).publication)
    return jsonRecord.parse(jsonRecord.parse(publication.peerContribution).grant)
  })
  expect(grants[0]?.authorizationIndex).not.toBe(grants[1]?.authorizationIndex)
  expect(expandSemanticText(text(encoded))).toEqual(extended)
})

it.each([
  { path: ['mandatoryReferences'], value: [0, 0] }, { path: ['mandatoryReferences'], value: [99] },
])('rejects ambiguous or missing marked mandatory positions during independent expansion: %j', ({ path, value }) => {
  const encoded = semanticMandatoryTableDelivery(fixture().delivery)
  expect(() => expandSemanticText(text(changed(encoded, path, value)))).toThrow('invalid mandatory indexes')
})


it('retains conflicting command outcomes and unknown grant fields without reconciling their meaning', () => {
  const { delivery } = fixture()
  const original = jsonRecord.parse(delivery.mandatory[0])
  const publication = jsonRecord.parse(original.publication)
  const contribution = jsonRecord.parse(publication.peerContribution)
  const command = jsonRecord.parse(publication.peerToolObservation)
  const conflicting = { ...original, publication: { ...publication,
    peerToolObservation: { ...command, exitCode: 0, stdout: { state: 'included', text: 'Contradictory report.', truncated: false } },
    peerContribution: { ...contribution, grant: { ...jsonRecord.parse(contribution.grant),
      unknownLimits: { sourceIndex: 7, authorizationIndex: 8, keep: ['all', 'values'] } } } } }
  const extended = { ...delivery, mandatory: [...delivery.mandatory, conflicting] }
  const encoded = semanticMandatoryTableDelivery(extended)
  expect(encoded).toHaveProperty('mandatoryReferences', [0, 1])
  expect(expandSemanticText(text(encoded))).toEqual(extended)
})

it.each([
  { path: ['mandatory', '0', 'sourceIndex'], value: 99 },
  { path: ['mandatory', '0', 'sourceIndex'], value: 0 },
  { path: ['mandatory', '0', 'source'], value: { kind: 'task' } },
  { path: ['mandatory', '0', 'publication', 'id'], value: 'collision' },
  { path: ['mandatory', '0', 'publication', 'peerContribution', 'grant', 'taskId'], value: 'collision' },
  { path: ['mandatory', '0', 'publication', 'peerContribution', 'grant', 'authorizationIndex'], value: 99 },
  { path: ['mandatory', '0', 'publication', 'peerContribution', 'grant', 'ownerPeerId'], value: 'collision' },
])('rejects invalid or ambiguous mandatory references during independent expansion: %j', ({ path, value }) => {
  const encoded = semanticMandatoryTableDelivery(fixture().delivery)
  expect(() => expandSemanticText(text(changed(encoded, path, value)))).toThrow()
})

it.each([1, 2, 3, 4] as const)('retains committed version %i bytes against the independent HEAD oracle', (version) => {
  const { input, reply, v4Sha256 } = fixture()
  const previous = projectSemanticReply(input, reply, 30_000, version)
  // Generated with a0fd794 semantic-input.ts; the three expanded generations share identical display bytes.
  const expected = version === 4 ? v4Sha256 : '8b8f3392a8ef4c9ca6c2725676257da751b533d38631c2370c3fabe106dd51d6'
  expect(createHash('sha256').update(previous.text).digest('hex')).toBe(expected)
  expect(Buffer.byteLength(previous.text)).toBe(version === 4 ? 7067 : 7925)
})

it('cold-restores each durable version and rejects altered or relabeled v5 evidence', () => {
  const { input, reply } = fixture()
  const request = semanticRequestSchema.parse({ version: 1, key: 'a'.repeat(64), ordinal: 1,
    backend: { id: 'semantic', revision: 'b'.repeat(64) }, call: { provider: 'fixture', model: 'fixture', maxTokens: 1000 },
    system: 'Summarize authorized reports.', purpose: 'context-summary', maxContextBytes: 30_000,
    messages: [{ id: 'request', role: 'user', source: { kind: 'plugin', plugin: 'dsh-development-task-context/semantic' },
      content: [{ type: 'text', text: semanticModelInput(input) }] }] })
  for (const version of [1, 2, 3, 4, 5] as const) {
    const projection = projectSemanticReply(input, reply, 30_000, version)
    const result = semanticResultSchema.parse({ version, key: request.key, requestSeq: 1, status: 'completed',
      rawOutput: [{ type: 'text', text: JSON.stringify(reply) }], finish: { kind: 'stop' }, projection,
      usage: null, elapsedMs: 1, error: null, rejectedChunk: null })
    expect(restoreSemanticProjection(request, result)).toEqual(projection)
    if (version === 1) {
      expect(semanticResultSchema.safeParse({ ...result, version: 5 }).success).toBe(false)
    } else {
      const relabeled = semanticResultSchema.parse({ ...result, version: version === 5 ? 4 : 5 })
      expect(() => restoreSemanticProjection(request, relabeled)).toThrow('cached projection disagrees')
    }
    if (version !== 5) continue
    const tampered = semanticResultSchema.parse({ ...result, projection: { ...projection,
      text: projection.text.replace('"mandatoryReferences":[0]', '"mandatoryReferences":[1]') } })
    expect(() => restoreSemanticProjection(request, tampered)).toThrow('cached projection disagrees')
    expect(() => restoreSemanticProjection({ ...request, maxContextBytes: 6508 }, result)).toThrow('exceed maxContextBytes')
  }
})
