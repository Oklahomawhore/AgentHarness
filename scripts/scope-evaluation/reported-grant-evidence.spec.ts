/** An independent evidence decoder restores complete grants without interpreting opaque fields. */
import { expect, it } from 'vitest'
import { expandReportedGrants } from './reported-grant-evidence.mjs'

const legend = 'grantReferences.entries uses zero-based indices. Restore publications[publicationIndex]'
  + '[grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. All other fields are literal.'
function encoded() {
  return { publications: [{ id: 'first', source: { kind: 'publication', publicationId: 'first' }, text: 'literal', peerContribution: { version: 1 } },
    { kind: 'reported-file', version: 1, authority: { kind: 'local', version: 1 }, content: 'complete file' },
    { opaque: { grantIndex: 99, grantReferences: { unknown: true } } }],
  grantReferences: { version: 1, legend, grants: [
    { kind: 'peerContribution', value: { taskId: 'task', grantId: 'peer', source: { tools: ['Write'] }, extra: ['kept'] } },
    { kind: 'authority', value: { taskId: 'other-task', grantId: 'local', maxSamples: 8 } },
  ], entries: [{ publicationIndex: 0, grantIndex: 0 }, { publicationIndex: 1, grantIndex: 1 }] } }
}
it('restores full cross-authority grants and leaves opaque lookalikes literal without mutating the input', () => {
  const input = encoded()
  const before = structuredClone(input)
  expect(expandReportedGrants(input, '4')).toEqual({ publications: [
    { ...input.publications[0], peerContribution: { version: 1, grant: input.grantReferences.grants[0]?.value } },
    { ...input.publications[1], authority: { kind: 'local', version: 1, grant: input.grantReferences.grants[1]?.value } },
    input.publications[2],
  ] })
  expect(input).toEqual(before)
})
it.each(['3', '4', '5', '6'] as const)('retains literal full grants when revision %s has no table', (revision) => {
  const body = { publications: [{ peerContribution: { grant: { extra: 'literal' } }, grantIndex: 0 }] }
  expect(expandReportedGrants(body, revision)).toEqual(body)
})
it('refuses a table relabeled as legacy revision 3', () => {
  expect(() => expandReportedGrants(encoded(), '3')).toThrow('legacy reported revision')
})
function entry(body: ReturnType<typeof encoded>, index: number) {
  const value = body.grantReferences.entries[index]
  if (value === undefined) throw new Error('fixture entry missing')
  return value
}
const invalid: [string, (body: ReturnType<typeof encoded>) => void, string][] = [
  ['table version', (body: ReturnType<typeof encoded>) => { body.grantReferences.version = 2 }, 'unsupported grant reference version'],
  ['legend', (body: ReturnType<typeof encoded>) => { body.grantReferences.legend = 'guess' }, 'legend differs'],
  ['negative index', (body: ReturnType<typeof encoded>) => { entry(body, 0).publicationIndex = -1 }, 'publication index'],
  ['fractional index', (body: ReturnType<typeof encoded>) => { entry(body, 0).grantIndex = 0.5 }, 'grant index'],
  ['large index', (body: ReturnType<typeof encoded>) => { entry(body, 0).grantIndex = 2 }, 'grant index'],
  ['duplicate index', (body: ReturnType<typeof encoded>) => { entry(body, 1).publicationIndex = 0 }, 'duplicate publication'],
  ['missing entry', (body: ReturnType<typeof encoded>) => { body.grantReferences.entries.pop() }, 'unreferenced grant'],
  ['missing parent', (body: ReturnType<typeof encoded>) => { entry(body, 0).publicationIndex = 2 }, 'indexed grant parent'],
  ['unknown path', (body: ReturnType<typeof encoded>) => { Object.assign(body.grantReferences.grants[0] ?? {}, { kind: 'constructor' }) }, 'unsupported grant path'],
]
it.each(invalid)('refuses %s instead of fabricating grant attribution', (_name, mutate, error) => {
  const body = encoded()
  mutate(body)
  expect(() => expandReportedGrants(body, '4')).toThrow(error)
})
it('refuses an inline grant even when it equals the indexed grant', () => {
  const body = encoded()
  Object.assign(body.publications[0]?.peerContribution ?? {}, { grant: body.grantReferences.grants[0]?.value })
  expect(() => expandReportedGrants(body, '4')).toThrow('reintroduces a grant')
})

it.each([
  ['unknown derived kind', { kind: 'future-file' }, 1, 'unsupported indexed derived'],
  ['unknown derived version', { version: 2 }, 1, 'unsupported indexed derived'],
  ['unknown authority', { authority: { kind: 'future', version: 1 } }, 1, 'unsupported indexed derived'],
  ['unknown metadata version', { peerContribution: { version: 2 } }, 0, 'unsupported indexed metadata'],
  ['ambiguous metadata', { localContribution: { version: 1, grant: { taskId: 'other' } } }, 0, 'ambiguous indexed'],
  ['mismatched identity', { source: { kind: 'publication', publicationId: 'other' } }, 0, 'identity differs'],
] as const)('refuses references into %s that the producer must leave literal', (_name, changes, index, error) => {
  const body = encoded()
  Object.assign(body.publications[index] ?? {}, changes)
  expect(() => expandReportedGrants(body, '4')).toThrow(error)
})
