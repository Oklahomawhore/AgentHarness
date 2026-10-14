/** Grant-table decoding is independent of the encoder and retains complete model-visible publication values. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { encodeReportedGrants } from '../src/reported-grants.ts'

const LEGEND = 'grantReferences.entries uses zero-based indices. Restore '
  + 'publications[publicationIndex][grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. '
  + 'All other fields are literal.'
const recordSchema = z.record(z.string(), z.unknown())
const encodingSchema = z.strictObject({ publications: z.array(z.unknown()), grantReferences: z.strictObject({
  version: z.literal(1), legend: z.literal(LEGEND),
  grants: z.array(z.strictObject({ kind: z.enum(['localContribution', 'peerContribution', 'authority']), value: recordSchema })),
  entries: z.array(z.strictObject({ publicationIndex: z.number().int().nonnegative(), grantIndex: z.number().int().nonnegative() })),
}).optional() })
function expand(value: unknown): readonly unknown[] {
  const encoded = encodingSchema.parse(value)
  const publications = structuredClone(encoded.publications)
  const references = encoded.grantReferences
  if (references === undefined) return publications
  const positions = new Set<number>()
  for (const entry of references.entries) {
    expect(positions.has(entry.publicationIndex)).toBe(false)
    positions.add(entry.publicationIndex)
    const row = references.grants[entry.grantIndex]
    if (row === undefined) throw new Error('missing grant row')
    const publication = recordSchema.parse(publications[entry.publicationIndex])
    const metadata = recordSchema.parse(publication[row.kind])
    expect(Object.hasOwn(metadata, 'grant')).toBe(false)
    publications[entry.publicationIndex] = { ...publication, [row.kind]: { ...metadata, grant: structuredClone(row.value) } }
  }
  return publications
}
function serialized(value: unknown): string { return JSON.stringify(value).replaceAll('<', '\\u003c') }
function bytes(value: unknown): number { return Buffer.byteLength(serialized(value), 'utf8') }
const grant = {
  version: 1, taskId: 'task-674539e6-525d-4b66-bcd0-b4fad6073bfa',
  ownerPeerId: '12D3KooWHd7MPFtFpdwpGbPMt5ujBZyhYFCqNNq2sSHbHvfF6wSk',
  contributorPeerId: '12D3KooWSeF5byQUr7kdfLHgUeddGHyPmEjsCFiGuTbGJRB5Yqvp',
  grantId: '622f9e6428ad178b068bb58e7ec5182a0083654782dfb2b1e2c91ca3a792035e',
  generation: '122dbc305dbd0cecdbb32da169190c2300c455c3cae9a0eda70435da8376bea3',
  captureId: 'c0dc6b5c-0e7d-48d3-b3d4-8b1c35f86225', captureGeneration: 'fa57840a-c0d7-4e6e-becb-93dc663c0499',
  source: { kind: 'tool-observations', name: 'work 中文🙂', tools: ['Write', 'Edit', 'Bash'] },
  expiresAt: 4_000_000_000_000, maxSamples: 16, maxSampleBytes: 8192,
}
function original(index: number, field: 'localContribution' | 'peerContribution' = 'peerContribution', value: object = grant) {
  const id = `publication-${index}`
  return { source: { kind: 'publication', taskId: grant.taskId, revision: 7, publicationId: id },
    id, text: `Warning unchanged.\n{"sequence":${String(index)},"content":"<原文🙂>"}`, publishedAt: index,
    [field]: { version: 1, grant: value } }
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
}

it('retains full publication and grant extensions without mutating or reinterpreting literal fields', () => {
  const fullGrant = { ...grant, extension: { authority: '<完整许可>', grantIndex: 999 } }
  const input = [0, 1, 2].map(index => ({ ...original(index, 'peerContribution', fullGrant),
    source: { ...original(index).source, futureSourceField: 'literal' },
    peerContribution: { version: 1, grant: fullGrant, ended: index === 2 ? 'left' : undefined,
      grantIndex: 'literal', grantReferences: { version: 9 }, unknown: ['kept'] },
    grantReferences: { version: 8, entries: [{ publicationIndex: 999 }] },
  }))
  // JSON is the renderer's data format; optional fields do not exist in its serialized publications.
  const publications = z.array(z.unknown()).parse(JSON.parse(JSON.stringify(input)) as unknown)
  const before = structuredClone(publications)
  freeze(publications)
  const encoded = encodeReportedGrants(publications)
  expect(encoded.grantReferences).toMatchObject({ version: 1, legend: LEGEND,
    grants: [{ kind: 'peerContribution', value: fullGrant }],
    entries: [{ publicationIndex: 0, grantIndex: 0 }, { publicationIndex: 1, grantIndex: 0 }, { publicationIndex: 2, grantIndex: 0 }] })
  expect(expand(JSON.parse(serialized(encoded)) as unknown)).toEqual(before)
  expect(publications).toEqual(before)
  expect(bytes(encoded)).toBeLessThan(bytes({ publications }))
})

it.each(['localContribution', 'peerContribution'] as const)('shares repeated complete %s grants with deterministic references', (field) => {
  const publications = [original(0, field), original(1, field)]
  const encoded = encodeReportedGrants(publications)
  expect(encoded.grantReferences?.grants).toEqual([{ kind: field, value: grant }])
  expect(expand(encoded)).toEqual(publications)
  expect(encodeReportedGrants(structuredClone(publications))).toEqual(encoded)
})

it.each(['reported-file', 'completed-native-file'] as const)('retains %s authority and every derived evidence field', (kind) => {
  const publications = ['local', 'peer'].flatMap(authorityKind => [0, 1].map(index => ({
    kind, version: 1, authority: { kind: authorityKind, version: 1, grant, ended: 'revoked', future: ['literal'] },
    content: '完整原文 <🙂>', warning: 'Reported evidence only.', file: { rootIndex: 0, path: 'file.txt' },
    source: original(index).source, dependencies: { count: 2, digest: 'a'.repeat(64), first: { sequence: 1 }, last: { sequence: 2 } },
  })))
  const encoded = encodeReportedGrants(publications)
  expect(encoded.grantReferences?.grants).toEqual([{ kind: 'authority', value: grant }])
  expect(expand(encoded)).toEqual(publications)
})

it('separates complete grants and field locations while comparing reordered object keys by their values', () => {
  const reordered = Object.fromEntries(Object.entries(grant).reverse())
  const other = { ...grant, maxSamples: grant.maxSamples - 1 }
  const publications = [original(0), original(1, 'peerContribution', reordered), original(2, 'peerContribution', other),
    original(3, 'peerContribution', other), original(4, 'localContribution'), original(5, 'localContribution')]
  const encoded = encodeReportedGrants(publications)
  expect(encoded.grantReferences?.grants).toEqual([
    { kind: 'peerContribution', value: grant }, { kind: 'peerContribution', value: other }, { kind: 'localContribution', value: grant },
  ])
  expect(encoded.grantReferences?.entries.map(entry => entry.grantIndex)).toEqual([0, 0, 1, 1, 2, 2])
  expect(expand(encoded)).toEqual(publications)
})

const unsupported: readonly unknown[] = [
  null, [], 'ordinary text',
  { id: 'plain', text: 'peerContribution and grantIndex are ordinary words', grantReferences: { version: 1 } },
  { ...original(0), kind: 'future-report', version: 1 },
  { ...original(0), kind: 'reported-file', version: 2, authority: { kind: 'peer', version: 1, grant } },
  { ...original(0), kind: 'reported-file', version: 1, authority: null },
  { ...original(0), kind: 'reported-file', version: 1, authority: { kind: 'future', version: 1, grant } },
  { ...original(0), source: null }, { ...original(0), source: { kind: 'other' } },
  { ...original(0), id: 0 }, { ...original(0), id: 'mismatched' },
  { source: original(0).source, id: original(0).id, text: 'plain publication' },
  { ...original(0), localContribution: { version: 1, grant } },
  { ...original(0), peerContribution: null }, { ...original(0), peerContribution: { version: 2, grant } },
  { ...original(0), peerContribution: { version: 1, grant: [] } },
]
describe('unknown and unprofitable publications remain literal', () => {
  it.each(unsupported.map((publication, index) => ({ index, publication })))('preserves value $index beside encoded reports', ({ publication }) => {
    const publications = [publication, original(1), original(2), original(3)]
    const encoded = encodeReportedGrants(publications)
    expect(encoded.grantReferences).toBeDefined()
    expect(encoded.publications[0]).toBe(publication)
    expect(encoded.grantReferences?.entries.every(entry => entry.publicationIndex > 0)).toBe(true)
    expect(expand(encoded)).toEqual(publications)
  })
  it.each([[], unsupported, [original(0)], [original(0, 'peerContribution', {}), original(1, 'peerContribution', {})]]
    .map(publications => ({ publications })))(
    'returns the original list when the complete table and legend cannot save bytes', ({ publications }) => {
      const encoded = encodeReportedGrants(publications)
      expect(encoded).toEqual({ publications })
      expect(encoded.publications).toBe(publications)
    })
})

it('counts escaped UTF-8 bytes for the full table and legend before choosing the smaller representation', () => {
  const plain = [original(0, 'peerContribution', { note: 'x'.repeat(100) }),
    original(1, 'peerContribution', { note: 'x'.repeat(100) })]
  const escaped = [original(0, 'peerContribution', { note: '<'.repeat(100) }),
    original(1, 'peerContribution', { note: '<'.repeat(100) })]
  expect(encodeReportedGrants(plain)).toEqual({ publications: plain })
  const encoded = encodeReportedGrants(escaped)
  expect(encoded.grantReferences).toBeDefined()
  const wire = serialized(encoded)
  expect(wire).toContain('\\u003c原文🙂>')
  expect(wire).toContain(LEGEND)
  expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(wire.length)
  expect(bytes(encoded)).toBeLessThan(bytes({ publications: escaped }))
  expect(expand(JSON.parse(wire) as unknown)).toEqual(escaped)
})
