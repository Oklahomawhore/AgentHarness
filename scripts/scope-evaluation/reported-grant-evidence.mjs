/** Independent expansion of complete reported grants and observations for offline and SDK evidence checks. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const legend = 'grantReferences.entries uses zero-based indices. Restore publications[publicationIndex]'
  + '[grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. All other fields are literal.'
function object(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}
function keys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields differ`)
}
function fields(value, required, optional, label) {
  object(value, label)
  assert.ok(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), `${label} fields differ`)
}
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum }
function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function permissionSource(value) {
  object(value, 'observation grant source')
  const version = Object.hasOwn(value, 'version') ? value.version : 1
  assert.ok(!Object.hasOwn(value, 'version') || [2, 3, 4].includes(version), 'invalid observation grant source version')
  fields(value, ['kind', 'name', 'tools', ...version === 1 ? [] : ['version'],
    ...version === 2 ? ['initialization'] : version === 3 ? ['fileContent'] : version === 4 ? ['commands'] : []],
  version === 4 ? ['fileContent'] : [], 'observation grant source')
  assert.ok(value.kind === 'tool-observations' && typeof value.name === 'string'
    && value.name.trim() !== '' && value.name.length <= 256, 'invalid observation grant source')
  assert.ok(Array.isArray(value.tools) && value.tools.length >= (version === 4 ? 0 : 1) && value.tools.length <= 2
    && value.tools.every(tool => ['Write', 'Edit'].includes(tool)) && new Set(value.tools).size === value.tools.length,
  'invalid observation grant tools')
  assert.ok(version !== 2 || value.initialization === 'recorded-local-tools', 'invalid observation grant initialization')
  assert.ok(!Object.hasOwn(value, 'fileContent') || value.fileContent === 'completed-native-file'
    && value.tools.length > 0, 'invalid observation grant file content')
  if (version === 4) {
    assert.ok(Array.isArray(value.commands) && value.commands.length > 0, 'invalid observation grant commands')
    const selectors = new Set()
    for (const command of value.commands) {
      fields(command, ['command', 'rootIndex'], [], 'observation grant command')
      assert.ok(typeof command.command === 'string' && command.command.trim() !== '' && !command.command.includes('\0')
        && integer(command.rootIndex), 'invalid observation grant command')
      selectors.add(JSON.stringify([command.command, command.rootIndex]))
    }
    assert.equal(selectors.size, value.commands.length, 'duplicate observation grant command')
  }
  return value
}
const observationLegend = 'Expand grantReferences first if present. Indices are zero-based. For each entry let '
  + 'p=publications[publicationIndex], g=p.peerContribution.grant. Restore p.text as preambles[preambleIndex]+"\\n"'
  + '+JSON.stringify({...result,sourceName:g.source.name,grantId:g.grantId,sequence,observerPeerId:g.contributorPeerId,'
  + 'sourceId,capture:{id:g.captureId,generation:g.captureGeneration}}), in that field order. All other fields are literal.'
const toolWarning = 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
  + 'The Task owner has not independently verified the tool execution or file contents.'
const recordedWarning = 'Previously recorded tool attempt shared with this scope. It was not re-executed or checked against '
  + 'the current file. Only selected completed records are shared; omitted or unfinished work is not included. ' + toolWarning
const commandWarning = 'Authenticated peer foreground command outcome. This records one execution, not verification of current code. '
  + 'The Task owner has not independently verified this execution.'

function output(value) {
  object(value, 'command output')
  keys(value, value.state === 'included' ? ['state', 'text', 'truncated'] : ['state', 'reason', 'truncated'], 'command output')
  assert.ok(typeof value.truncated === 'boolean' && (value.state === 'included' ? typeof value.text === 'string'
    : value.state === 'omitted' && value.reason === 'budget'), 'invalid command output')
}
function resultWarning(result, source) {
  object(result, 'observation result')
  if (result.kind === 'command-observation') {
    const common = ['kind', 'version', 'tool', 'fields', 'state']
    keys(result, [...common, ...result.state === 'completed'
      ? ['exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'] : ['reason']], 'command result')
    fields(result.fields, ['command', 'rootIndex'], [], 'command selector')
    assert.ok(result.version === 4 && result.tool === 'Bash' && integer(result.fields.rootIndex)
      && typeof result.fields.command === 'string' && result.fields.command.trim() !== '' && !result.fields.command.includes('\0'),
    'invalid command result')
    assert.ok(source.version === 4 && Array.isArray(source.commands) && source.commands.some(selector =>
      selector.command === result.fields.command && selector.rootIndex === result.fields.rootIndex), 'command grant differs')
    if (result.state === 'completed') {
      assert.ok((result.exitCode === null || Number.isSafeInteger(result.exitCode))
        && (result.signal === null || typeof result.signal === 'string' && result.signal !== '')
        && typeof result.timedOut === 'boolean' && typeof result.aborted === 'boolean' && integer(result.timeoutMs, 1),
      'invalid command completion')
      output(result.stdout)
      output(result.stderr)
    } else assert.ok(result.state === 'unavailable' && ['tool-failed', 'completion-unavailable'].includes(result.reason),
      'invalid unavailable command')
    return commandWarning
  }
  keys(result, ['kind', 'version', 'reportedStatus', 'omissions', 'tool', 'fields',
    ...result.version === 2 ? ['origin'] : result.version === 3 ? ['completedFile'] : []], 'tool result')
  assert.ok(result.kind === 'tool-observation' && [1, 2, 3].includes(result.version)
    && ['Write', 'Edit'].includes(result.tool) && ['success', 'failure'].includes(result.reportedStatus), 'invalid tool result')
  const version = source.version ?? 1
  assert.ok(Array.isArray(source.tools) && source.tools.includes(result.tool)
    && (version === 4 ? result.version === (source.fileContent === undefined ? 1 : 3)
      : version === 3 ? result.version === 3 : result.version === 1 || version === 2 && result.version === 2), 'tool grant differs')
  const bodyFields = result.tool === 'Write' ? ['content'] : ['oldString', 'newString']
  fields(result.fields, ['rootIndex', 'path', ...result.tool === 'Edit' ? ['replaceAll'] : []], [...bodyFields, 'error'], 'tool fields')
  assert.ok(integer(result.fields.rootIndex) && typeof result.fields.path === 'string' && result.fields.path.length <= 2048
    && !/[\\:\u0000-\u001f\u007f]/u.test(result.fields.path)
    && result.fields.path.split('/').every(segment => !['', '.', '..'].includes(segment))
    && (result.tool !== 'Edit' || typeof result.fields.replaceAll === 'boolean'), 'invalid tool fields')
  for (const key of [...bodyFields, 'error']) if (Object.hasOwn(result.fields, key)) {
    assert.equal(typeof result.fields[key], 'string', 'invalid tool field text')
  }
  const omissions = result.omissions
  assert.ok(Array.isArray(omissions) && new Set(omissions).size === omissions.length
    && bodyFields.every(key => Object.hasOwn(result.fields, key) !== omissions.includes(key))
    && omissions.every(key => [...bodyFields, 'error'].includes(key) && !Object.hasOwn(result.fields, key))
    && (result.reportedStatus === 'success' ? !Object.hasOwn(result.fields, 'error') && !omissions.includes('error')
      : bodyFields.every(key => !Object.hasOwn(result.fields, key))), 'invalid tool omissions')
  if (result.version === 2) {
    fields(result.origin, ['kind', 'planDigest', 'executionDigest'], [], 'recorded origin')
    assert.ok(result.origin.kind === 'recorded-local-tools' && digest(result.origin.planDigest) && digest(result.origin.executionDigest),
      'invalid recorded origin')
  }
  if (result.version === 3) {
    const file = object(result.completedFile, 'completed file')
    keys(file, file.state === 'included' ? ['state', 'content', 'sha256'] : ['state', 'reason'], 'completed file')
    assert.ok(file.state === 'included' ? typeof file.content === 'string' && !file.content.includes('\r') && file.content.isWellFormed()
      && createHash('sha256').update(file.content).digest('hex') === file.sha256
      : file.state === 'omitted' && ['tool-failed', 'budget', 'unavailable'].includes(file.reason), 'invalid completed file')
    assert.ok(result.reportedStatus === 'failure' ? file.state === 'omitted' && file.reason === 'tool-failed'
      : file.state === 'included' || file.reason !== 'tool-failed', 'completed file status differs')
  }
  return result.version === 2 ? recordedWarning : toolWarning
}
function expandObservations(body) {
  if (!Object.hasOwn(body, 'observationReferences')) return
  const table = object(body.observationReferences, 'observation references')
  keys(table, ['version', 'legend', 'preambles', 'entries'], 'observation references')
  assert.equal(table.version, 1, 'unsupported observation reference version')
  assert.equal(table.legend, observationLegend, 'observation reference legend differs')
  assert.ok(Array.isArray(table.preambles) && table.preambles.length > 0
    && table.preambles.every(value => [toolWarning, recordedWarning, commandWarning].includes(value))
    && new Set(table.preambles).size === table.preambles.length, 'invalid observation preambles')
  assert.ok(Array.isArray(table.entries) && table.entries.length > 0, 'observation entries must be nonempty')
  const used = new Set()
  const publications = new Set()
  for (const entry of table.entries) {
    object(entry, 'observation entry')
    keys(entry, ['publicationIndex', 'preambleIndex', 'result', 'sequence', 'sourceId'], 'observation entry')
    assert.ok(integer(entry.publicationIndex) && entry.publicationIndex < body.publications.length, 'observation publication index out of range')
    assert.ok(integer(entry.preambleIndex) && entry.preambleIndex < table.preambles.length, 'observation preamble index out of range')
    assert.ok(!publications.has(entry.publicationIndex), 'duplicate observation publication entry')
    publications.add(entry.publicationIndex)
    used.add(entry.preambleIndex)
    const publication = object(body.publications[entry.publicationIndex], 'observation publication')
    assert.ok(!Object.hasOwn(publication, 'text'), 'observation publication reintroduces text')
    keys(publication, ['source', 'id', 'publishedAt', 'peerContribution'], 'observation publication')
    const source = object(publication.source, 'observation publication source')
    keys(source, ['kind', 'taskId', 'revision', 'publicationId'], 'observation publication source')
    assert.ok(source.kind === 'publication' && typeof publication.id === 'string' && source.publicationId === publication.id
      && integer(source.revision, 1) && integer(publication.publishedAt), 'observation publication identity differs')
    const parent = object(publication.peerContribution, 'observation peer contribution')
    keys(parent, ['version', 'grant'], 'observation peer contribution')
    assert.equal(parent.version, 1, 'unsupported observation metadata version')
    const grant = object(parent.grant, 'observation peer grant')
    keys(grant, ['version', 'taskId', 'grantId', 'generation', 'ownerPeerId', 'contributorPeerId', 'captureId', 'captureGeneration',
      'source', 'expiresAt', 'maxSamples', 'maxSampleBytes'], 'observation peer grant')
    assert.ok(grant.version === 1 && grant.taskId === source.taskId, 'observation grant Task differs')
    for (const key of ['taskId', 'grantId', 'generation', 'ownerPeerId', 'contributorPeerId', 'captureId', 'captureGeneration']) {
      assert.ok(typeof grant[key] === 'string' && grant[key].trim() !== '' && grant[key].length <= 256, 'invalid observation grant identity')
    }
    assert.ok(['expiresAt', 'maxSamples', 'maxSampleBytes'].every(key => integer(grant[key], 1)), 'invalid observation grant limits')
    const permission = permissionSource(grant.source)
    assert.ok(integer(entry.sequence, 1) && entry.sequence < Number.MAX_SAFE_INTEGER && digest(entry.sourceId), 'invalid observation sample identity')
    assert.equal(table.preambles[entry.preambleIndex], resultWarning(entry.result, permission), 'observation preamble differs from result')
    publication.text = table.preambles[entry.preambleIndex] + '\n' + JSON.stringify({ ...entry.result,
      sourceName: permission.name, grantId: grant.grantId, sequence: entry.sequence, observerPeerId: grant.contributorPeerId,
      sourceId: entry.sourceId, capture: { id: grant.captureId, generation: grant.captureGeneration } })
  }
  assert.equal(used.size, table.preambles.length, 'unreferenced observation preamble')
  delete body.observationReferences
}

/** Restore explicitly indexed grants and observations; unknown literal publications remain untouched.
 * @param value - JSON decoded from the actual model-visible reported frame.
 * @param revision - Backend identity from the same recorded projection.
 * @returns A detached payload with complete grants and exact observation text; legacy payloads remain literal.
 */
export function expandReportedGrants(value, revision) {
  assert.ok(['3', '4', '5', '6'].includes(revision), 'unsupported reported revision')
  const body = object(structuredClone(value), 'reported payload')
  assert.ok(Array.isArray(body.publications), 'reported publications must be an array')
  if (Object.hasOwn(body, 'observationReferences')) {
    assert.ok(['5', '6'].includes(revision), 'legacy reported revision cannot contain observation references')
  }
  expandGrants(body, revision)
  expandObservations(body)
  return body
}
function expandGrants(body, revision) {
  if (!Object.hasOwn(body, 'grantReferences')) return
  assert.ok(revision !== '3', 'legacy reported revision cannot contain grant references')
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
}
