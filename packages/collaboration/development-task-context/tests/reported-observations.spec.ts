/** Independent exact expansion of original peer observation text and complete grants. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { peerPublication } from '@deepseek-ai/dsh-development-task/src/peer.ts'
import { encodeReportedGrants } from '../src/reported-grants.ts'
import { encodeReportedObservations } from '../src/reported-observations.ts'

const LEGEND = 'Expand grantReferences first if present. Indices are zero-based. '
  + 'For each entry let p=publications[publicationIndex], g=p.peerContribution.grant. '
  + 'Restore p.text as preambles[preambleIndex]+"\\n"+JSON.stringify({...result,sourceName:g.source.name,grantId:g.grantId,'
  + 'sequence,observerPeerId:g.contributorPeerId,sourceId,capture:{id:g.captureId,generation:g.captureGeneration}}), '
  + 'in that field order. All other fields are literal.'
const record = z.record(z.string(), z.unknown())
const grant = {
  version: 1, taskId: 'task-674539e6-525d-4b66-bcd0-b4fad6073bfa',
  ownerPeerId: '12D3KooWHd7MPFtFpdwpGbPMt5ujBZyhYFCqNNq2sSHbHvfF6wSk',
  contributorPeerId: '12D3KooWSeF5byQUr7kdfLHgUeddGHyPmEjsCFiGuTbGJRB5Yqvp',
  grantId: '622f9e6428ad178b068bb58e7ec5182a0083654782dfb2b1e2c91ca3a792035e',
  generation: '122dbc305dbd0cecdbb32da169190c2300c455c3cae9a0eda70435da8376bea3',
  captureId: 'c0dc6b5c-0e7d-48d3-b3d4-8b1c35f86225', captureGeneration: 'fa57840a-c0d7-4e6e-becb-93dc663c0499',
  source: { kind: 'tool-observations', version: 4, name: 'work 中文🙂', tools: ['Write', 'Edit'],
    commands: [{ command: 'node check.js', rootIndex: 0 }] },
  expiresAt: 4_000_000_000_000, maxSamples: 16, maxSampleBytes: 8192,
}
const write = { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
  fields: { rootIndex: 0, path: 'file.txt', content: 'const value = "<原文🙂>";\n' } }
const command = { kind: 'command-observation', version: 4, tool: 'Bash', fields: { rootIndex: 0, command: 'node check.js' },
  state: 'completed', exitCode: 3, signal: null, timedOut: false, aborted: false, timeoutMs: 20_000,
  stdout: { state: 'included', text: 'body "quoted"\n<中文🙂>', truncated: true },
  stderr: { state: 'omitted', reason: 'budget', truncated: false } }
function publication(sequence: number, result: unknown = write, permission: unknown = grant) {
  const request = peerContributionRequestSchema.parse({ grant: permission, sequence,
    sourceId: createHash('sha256').update(String(sequence)).digest('hex'), result })
  const { peerToolObservation: _observation, ...value } = peerPublication(request, sequence)
  return { source: { kind: 'publication', taskId: grant.taskId, revision: 7, publicationId: value.id }, ...value }
}
function wire(value: unknown): string { return JSON.stringify(value).replaceAll('<', '\\u003c') }
function bytes(value: unknown): number { return Buffer.byteLength(wire(value), 'utf8') }
function expand(value: ReturnType<typeof encodeReportedObservations>): unknown[] {
  const publications = value.publications.map(publication => record.parse(structuredClone(publication)))
  for (const entry of value.grantReferences?.entries ?? []) {
    const row = value.grantReferences?.grants[entry.grantIndex]
    const publication = publications[entry.publicationIndex]
    if (row === undefined || publication === undefined) throw new Error('missing grant location')
    const metadata = record.parse(publication[row.kind])
    expect(Object.hasOwn(metadata, 'grant')).toBe(false)
    publication[row.kind] = { ...metadata, grant: structuredClone(row.value) }
  }
  const references = value.observationReferences
  if (references === undefined) return publications
  expect(references.version).toBe(1)
  expect(references.legend).toBe(LEGEND)
  const positions = new Set<number>()
  for (const entry of references.entries) {
    expect(positions.has(entry.publicationIndex)).toBe(false)
    positions.add(entry.publicationIndex)
    const publication = publications[entry.publicationIndex]
    if (publication === undefined) throw new Error('missing observation location')
    const grant = record.parse(record.parse(publication.peerContribution).grant)
    const source = record.parse(grant.source)
    expect(Object.hasOwn(publication, 'text')).toBe(false)
    publication.text = `${String(references.preambles[entry.preambleIndex])}\n${JSON.stringify({ ...entry.result,
      sourceName: source.name, grantId: grant.grantId, sequence: entry.sequence, observerPeerId: grant.contributorPeerId,
      sourceId: entry.sourceId, capture: { id: grant.captureId, generation: grant.captureGeneration } })}`
  }
  return publications
}
function replaceObservation(value: ReturnType<typeof publication>, change: (observation: Record<string, unknown>) => unknown) {
  const [preamble, json] = value.text.split('\n')
  if (json === undefined) throw new Error('missing observation')
  return { ...value, text: `${String(preamble)}\n${JSON.stringify(change(record.parse(JSON.parse(json) as unknown)))}` }
}

it('round-trips complete command and file text, ordered result keys, attribution, and warnings', () => {
  const publications = [publication(1), publication(2, command), publication(3, {
    ...write, tool: 'Edit', fields: { rootIndex: 0, path: 'file.txt', oldString: '<原文🙂>', newString: '"other"', replaceAll: false },
  })]
  const before = structuredClone(publications)
  const encoded = encodeReportedObservations(publications)
  expect(encoded.observationReferences?.entries).toHaveLength(3)
  expect(encoded.observationReferences?.preambles).toHaveLength(2)
  expect(encoded.observationReferences?.entries.map(entry => entry.preambleIndex)).toEqual([0, 1, 0])
  expect(encoded.grantReferences?.grants).toHaveLength(1)
  expect(expand(encoded)).toEqual(before)
  expect(expand(encoded).map(value => record.parse(value).text)).toEqual(before.map(value => value.text))
  expect(encoded.observationReferences?.entries[1]?.result).toEqual(peerContributionRequestSchema.parse({
    grant, sequence: 2, sourceId: 'a'.repeat(64), result: command,
  }).result)
  expect(bytes(encoded)).toBeLessThan(bytes(encodeReportedGrants(publications)))
  expect(publications).toEqual(before)
  expect(encodeReportedObservations(structuredClone(publications))).toEqual(encoded)
  expect(wire(encoded)).toContain('\\u003c')
})

it('supports recorded origins, completed file bytes and unavailable command fields without reinterpretation', () => {
  const file = 'full original\n<"quoted"🙂>'
  const recorded = publication(1, { ...write, version: 2,
    origin: { kind: 'recorded-local-tools', planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } },
  { ...grant, source: { kind: 'tool-observations', name: grant.source.name, tools: ['Write'],
    version: 2, initialization: 'recorded-local-tools' } })
  const completed = publication(2, { ...write, version: 3,
    completedFile: { state: 'included', content: file, sha256: createHash('sha256').update(file).digest('hex') } },
  { ...grant, source: { kind: 'tool-observations', name: grant.source.name, tools: ['Write'], version: 3, fileContent: 'completed-native-file' } })
  const unavailable = publication(3, { kind: 'command-observation', version: 4, tool: 'Bash', fields: command.fields,
    state: 'unavailable', reason: 'completion-unavailable' })
  const input = [recorded, completed, unavailable, publication(4), publication(5)]
  const encoded = encodeReportedObservations(input)
  expect(encoded.observationReferences?.entries).toHaveLength(5)
  expect(encoded.observationReferences?.preambles).toHaveLength(3)
  expect(expand(encoded)).toEqual(input)
})

const original = publication(1)
const unsupported = [
  null, [], 'ordinary', {}, { ...original, extension: 'literal' },
  { ...original, source: { ...original.source, publicationId: 'different' } },
  { ...original, source: { ...original.source, taskId: 'different' } },
  { ...original, peerContribution: { version: 1, grant, ended: 'revoked' } },
  { ...original, text: 'plain text' }, { ...original, text: 'warning\n[]' },
  { ...original, text: 'warning\nnull' }, { ...original, text: original.text + ' ' },
  { ...original, text: 'changed warning\n' + original.text.slice(original.text.indexOf('\n') + 1) },
  { ...original, text: original.text.replaceAll('"', '\\"') },
  { ...original, peerContribution: { version: 1, grant: { ...grant, extension: 'unknown' } } },
  replaceObservation(original, value => ({ ...value, sourceName: 'other' })),
  replaceObservation(original, value => ({ ...value, grantId: 'other' })),
  replaceObservation(original, value => ({ ...value, observerPeerId: 'other' })),
  replaceObservation(original, value => ({ ...value, capture: { id: grant.captureId, generation: 'other' } })),
  replaceObservation(original, value => ({ ...value, sequence: 0 })),
  replaceObservation(original, value => ({ ...value, sourceId: 'partial' })),
  replaceObservation(original, value => ({ ...value, unknown: 'literal' })),
  replaceObservation(original, value => ({ sourceName: value.sourceName, ...value })),
  replaceObservation(original, value => ({ ...value, fields: { ...write.fields, content: undefined } })),
  { ...original, peerContribution: { version: 1, grant: { ...grant, source: { ...grant.source, tools: ['Edit'] } } } },
  replaceObservation(publication(2, command), value => ({ ...value, fields: { ...command.fields, command: 'unauthorized' } })),
  { ...original, peerContribution: { version: 1, grant: { ...grant, source: { name: 'api', method: 'post', path: '/orders' } } },
    text: 'warning\n' + JSON.stringify({ state: 'unavailable', reason: 'missing-file', sequence: 1, sourceId: 'a'.repeat(64) }) },
]
it.each(unsupported.map((value, index) => ({ value, index })))('keeps unsupported value $index literal beside compressed publications', ({ value }) => {
  const input = [value, publication(2), publication(3, command), publication(4)]
  const encoded = encodeReportedObservations(input)
  expect(encoded.observationReferences).toBeDefined()
  expect(encoded.observationReferences?.entries.every(entry => entry.publicationIndex > 0)).toBe(true)
  const baseline = encodeReportedGrants(input)
  expect(encoded.publications[0]).toEqual(baseline.publications[0])
})

it('uses the original or grant-only encoding when the complete observation table does not save bytes', () => {
  expect(encodeReportedObservations([])).toEqual({ publications: [] })
  const input = [publication(1)]
  expect(encodeReportedObservations(input)).toEqual(encodeReportedGrants(input))
  const literal = [1, 2].map(index => ({ ...publication(index), text: 'literal' }))
  expect(encodeReportedObservations(literal)).toEqual(encodeReportedGrants(literal))
})

it('can retain inline grants when escaped result text alone pays for the complete observation table', () => {
  const input = [publication(1, { ...write, fields: { ...write.fields, content: '\\"'.repeat(800) } })]
  const encoded = encodeReportedObservations(input)
  expect(encoded.grantReferences).toBeUndefined()
  expect(encoded.observationReferences?.entries).toHaveLength(1)
  expect(expand(encoded)).toEqual(input)
  expect(bytes(encoded)).toBeLessThan(bytes({ publications: input }))
})

it('keeps the original result key order rather than adopting schema parse order', () => {
  const input = [1, 2, 3].map(index => replaceObservation(publication(index), (value) => {
    const { sourceName, grantId, sequence, observerPeerId, sourceId, capture, ...result } = value
    return { ...Object.fromEntries(Object.entries(result).reverse()), sourceName, grantId, sequence, observerPeerId, sourceId, capture }
  }))
  const encoded = encodeReportedObservations(input)
  expect(encoded.observationReferences?.entries).toHaveLength(3)
  expect(expand(encoded)).toEqual(input)
  expect(isDeepStrictEqual(input, expand(encoded))).toBe(true)
})

it('retains the full combined permission while encoding its file and command reports and leaving final answers literal', () => {
  const permission = { ...grant, source: { ...grant.source, kind: 'native-work', version: 6, completedTurns: true } }
  const text = 'Review remains pending.'
  const request = peerContributionRequestSchema.parse({ grant: permission, sequence: 3, sourceId: 'f'.repeat(64),
    result: { kind: 'completed-turn-outcome', version: 5, text, sha256: createHash('sha256').update(text).digest('hex') } })
  const { peerTurnOutcome: _outcome, ...answer } = peerPublication(request, 3)
  const input = [publication(1, write, permission), publication(2, command, permission),
    { source: { kind: 'publication', taskId: grant.taskId, revision: 7, publicationId: answer.id }, ...answer }]
  const encoded = encodeReportedObservations(input)
  expect(encoded.observationReferences?.entries).toHaveLength(2)
  expect(encoded.grantReferences?.grants).toHaveLength(1)
  expect(encoded.grantReferences?.grants[0]?.value).toMatchObject({ source: permission.source })
  expect(expand(encoded)).toEqual(input)
  expect(record.parse(encoded.publications[2]).text).toBe(answer.text)
})
