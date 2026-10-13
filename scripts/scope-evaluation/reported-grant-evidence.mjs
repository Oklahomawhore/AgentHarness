/** Independent expansion of complete reported grants for offline and SDK evidence checks. */
import assert from 'node:assert/strict'

const legend = 'grantReferences.entries uses zero-based indices. Restore publications[publicationIndex]'
  + '[grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. All other fields are literal.'
function object(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}
function keys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields differ`)
}

/** Expand only explicitly indexed grant fields; unknown literal publication fields remain untouched.
 * @param value - JSON decoded from the actual model-visible reported frame.
 * @param revision - Backend identity from the same recorded projection.
 * @returns A detached payload with complete grants and no reference table; legacy payloads remain literal.
 */
export function expandReportedGrants(value, revision) {
  assert.ok(revision === '3' || revision === '4', 'unsupported reported revision')
  const body = object(structuredClone(value), 'reported payload')
  assert.ok(Array.isArray(body.publications), 'reported publications must be an array')
  if (!Object.hasOwn(body, 'grantReferences')) return body
  assert.equal(revision, '4', 'legacy reported revision cannot contain grant references')
  const table = object(body.grantReferences, 'grant references')
  keys(table, ['version', 'legend', 'grants', 'entries'], 'grant references')
  assert.equal(table.version, 1, 'unsupported grant reference version')
  assert.equal(table.legend, legend, 'grant reference legend differs')
  assert.ok(Array.isArray(table.grants) && table.grants.length > 0, 'grant rows must be nonempty')
  assert.ok(Array.isArray(table.entries) && table.entries.length > 0, 'grant entries must be nonempty')
  for (const row of table.grants) {
    object(row, 'grant row')
    keys(row, ['kind', 'value'], 'grant row')
    assert.ok(['localContribution', 'peerContribution', 'authority'].includes(row.kind), 'unsupported grant path')
    object(row.value, 'complete grant')
  }
  const publications = new Set()
  const used = new Set()
  for (const entry of table.entries) {
    object(entry, 'grant entry')
    keys(entry, ['publicationIndex', 'grantIndex'], 'grant entry')
    assert.ok(Number.isSafeInteger(entry.publicationIndex) && entry.publicationIndex >= 0
      && entry.publicationIndex < body.publications.length, 'publication index is out of range')
    assert.ok(Number.isSafeInteger(entry.grantIndex) && entry.grantIndex >= 0
      && entry.grantIndex < table.grants.length, 'grant index is out of range')
    assert.ok(!publications.has(entry.publicationIndex), 'duplicate publication grant entry')
    publications.add(entry.publicationIndex)
    used.add(entry.grantIndex)
    const row = table.grants[entry.grantIndex]
    const publication = object(body.publications[entry.publicationIndex], 'indexed publication')
    const parent = object(publication[row.kind], 'indexed grant parent')
    assert.equal(parent.version, 1, 'unsupported indexed metadata version')
    if (Object.hasOwn(publication, 'kind')) {
      assert.ok(['reported-file', 'completed-native-file'].includes(publication.kind) && publication.version === 1
        && row.kind === 'authority' && ['local', 'peer'].includes(parent.kind), 'unsupported indexed derived publication')
    } else {
      const source = object(publication.source, 'indexed publication source')
      assert.ok(source.kind === 'publication' && typeof publication.id === 'string'
        && source.publicationId === publication.id, 'indexed publication identity differs')
      const local = Object.hasOwn(publication, 'localContribution')
      const peer = Object.hasOwn(publication, 'peerContribution')
      assert.ok(local !== peer && row.kind === (local ? 'localContribution' : 'peerContribution'), 'ambiguous indexed contribution')
    }
    assert.ok(!Object.hasOwn(parent, 'grant'), 'indexed publication reintroduces a grant')
    parent.grant = structuredClone(row.value)
  }
  assert.equal(used.size, table.grants.length, 'unreferenced grant row')
  delete body.grantReferences
  return body
}
