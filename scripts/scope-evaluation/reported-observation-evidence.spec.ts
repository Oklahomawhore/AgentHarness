/** Independent JavaScript and Python decoding checks use explicit wire examples, never the production encoder. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { expandReportedGrants } from './reported-grant-evidence.mjs'

const observationLegend = 'Expand grantReferences first if present. Indices are zero-based. For each entry let '
  + 'p=publications[publicationIndex], g=p.peerContribution.grant. Restore p.text as preambles[preambleIndex]+"\\n"'
  + '+JSON.stringify({...result,sourceName:g.source.name,grantId:g.grantId,sequence,observerPeerId:g.contributorPeerId,'
  + 'sourceId,capture:{id:g.captureId,generation:g.captureGeneration}}), in that field order. All other fields are literal.'
const grantLegend = 'grantReferences.entries uses zero-based indices. Restore publications[publicationIndex]'
  + '[grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. All other fields are literal.'
const toolWarning = 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
  + 'The Task owner has not independently verified the tool execution or file contents.'
const recordedWarning = 'Previously recorded tool attempt shared with this scope. It was not re-executed or checked against '
  + 'the current file. Only selected completed records are shared; omitted or unfinished work is not included. ' + toolWarning
const commandWarning = 'Authenticated peer foreground command outcome. This records one execution, not verification of current code. '
  + 'The Task owner has not independently verified this execution.'
type JsonRecord = Record<string, unknown>
function isObject(value: unknown): value is JsonRecord { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function object(value: unknown): JsonRecord {
  if (!isObject(value)) throw new Error('fixture object missing')
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('fixture array missing')
  return value
}
function entry(body: JsonRecord): JsonRecord { return object(array(object(body.observationReferences).entries)[0]) }
function publication(body: JsonRecord): JsonRecord { return object(array(body.publications)[0]) }
function grant(body: JsonRecord): JsonRecord { return object(object(publication(body).peerContribution).grant) }

function fixture(version = 1, indexedGrant = false, failed = false, native = false) {
  const content = '原文 <tag> "quoted"\nnext\u0001🙂\ud800'
  const permission: JsonRecord = { kind: 'tool-observations', name: 'source', tools: ['Write', 'Edit'] }
  // Non-schema key order is part of the original canonical text and must survive expansion.
  let result: JsonRecord = { fields: { content, path: 'src/file.ts', rootIndex: 0 }, tool: 'Write',
    omissions: [], reportedStatus: 'success', version, kind: 'tool-observation' }
  let warning = toolWarning
  if (version === 2) {
    Object.assign(permission, { version: 2, initialization: 'recorded-local-tools' })
    result.origin = { executionDigest: 'e'.repeat(64), kind: 'recorded-local-tools', planDigest: 'a'.repeat(64) }
    warning = recordedWarning
  } else if (version === 3) {
    Object.assign(permission, { version: 3, fileContent: 'completed-native-file' })
    result.completedFile = { content: '当前\n', state: 'included', sha256: createHash('sha256').update('当前\n').digest('hex') }
  } else if (version === 4) {
    Object.assign(permission, { version: 4, commands: [{ command: 'node check.cjs', rootIndex: 0 }] })
    result = { kind: 'command-observation', version: 4, tool: 'Bash', fields: { rootIndex: 0, command: 'node check.cjs' },
      state: 'completed', exitCode: 7, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
      stdout: { state: 'included', text: 'failed\n', truncated: false }, stderr: { state: 'omitted', reason: 'budget', truncated: true } }
    warning = commandWarning
  }
  if (failed && version === 4) {
    permission.tools = []
    result = { fields: { command: 'node check.cjs', rootIndex: 0 }, version: 4, tool: 'Bash',
      kind: 'command-observation', state: 'unavailable', reason: 'completion-unavailable' }
  } else if (failed) {
    result.tool = 'Edit'
    result.fields = { path: 'src/file.ts', rootIndex: 0, replaceAll: false, error: 'missing original text' }
    result.reportedStatus = 'failure'
    result.omissions = ['oldString', 'newString']
    if (version === 3) result.completedFile = { state: 'omitted', reason: 'tool-failed' }
  }
  if (native) Object.assign(permission, { kind: 'native-work', version: 6,
    commands: permission.commands ?? [], completedTurns: true })
  const completeGrant = { version: 1, taskId: 'task', grantId: 'grant', generation: 'generation', ownerPeerId: 'owner',
    contributorPeerId: 'peer', captureId: 'capture', captureGeneration: 'capture-generation', source: permission,
    expiresAt: 10000, maxSamples: 20, maxSampleBytes: 8192 }
  const canonical = { ...result, sourceName: 'source', grantId: 'grant', sequence: 2, observerPeerId: 'peer',
    sourceId: 'b'.repeat(64), capture: { id: 'capture', generation: 'capture-generation' } }
  const original = { id: 'publication', source: { kind: 'publication', taskId: 'task', revision: 7, publicationId: 'publication' },
    publishedAt: 8, peerContribution: { version: 1, grant: completeGrant }, text: warning + '\n' + JSON.stringify(canonical) }
  const { text: _text, ...encoded } = original
  const body: JsonRecord = { task: { id: 'task', revision: 7 }, publications: [encoded,
    { id: 'opaque', text: 'literal unknown', observationReferences: { preambleIndex: 99 } }],
  observationReferences: { version: 1, legend: observationLegend, preambles: [warning],
    entries: [{ publicationIndex: 0, preambleIndex: 0, result, sequence: 2, sourceId: 'b'.repeat(64) }] } }
  if (indexedGrant) {
    publication(body).peerContribution = { version: 1 }
    body.grantReferences = { version: 1, legend: grantLegend, grants: [{ kind: 'peerContribution', value: completeGrant }],
      entries: [{ publicationIndex: 0, grantIndex: 0 }] }
  }
  const expected = { task: body.task, publications: [original, array(body.publications)[1]] }
  return { body, expected }
}

it.each([1, 2, 3, 4])('restores complete version %i report text in original JSON order with inline or indexed grant', (version) => {
  for (const revision of ['5', '6'] as const) for (const indexedGrant of [false, true]) {
    const { body, expected } = fixture(version, indexedGrant)
    const before = structuredClone(body)
    const decoded = expandReportedGrants(JSON.parse(JSON.stringify(body)) as unknown, revision)
    expect(decoded).toEqual(expected)
    expect(body).toEqual(before)
    const actualText = object(array(object(decoded).publications)[0]).text
    expect(actualText).toBe(object(expected.publications[0]).text)
  }
})
it.each([1, 2, 3, 4])('restores version %i failed Edit or unavailable command without inventing content', (version) => {
  const { body, expected } = fixture(version, true, true)
  for (const revision of ['5', '6'] as const) expect(expandReportedGrants(body, revision)).toEqual(expected)
})
it.each(['3', '4'] as const)('refuses observation references under legacy revision %s', (revision) => {
  expect(() => expandReportedGrants(fixture().body, revision)).toThrow('legacy reported revision cannot contain observation references')
})
it.each(['5', '6'] as const)('leaves literal unknown reports and nested lookalikes untouched under revision %s', (revision) => {
  const body = { publications: [{ text: 'unknown', peerContribution: { grant: { extension: 'kept' } },
    observationReferences: { version: 99 }, grantReferences: { version: 99 } }] }
  expect(expandReportedGrants(body, revision)).toEqual(body)
})

const invalid: [string, (body: JsonRecord) => void, string][] = [
  ['table version', (body) => { object(body.observationReferences).version = true }, 'unsupported observation reference version'],
  ['legend', (body) => { object(body.observationReferences).legend = 'guess' }, 'observation reference legend differs'],
  ['negative publication', (body) => { entry(body).publicationIndex = -1 }, 'observation publication index'],
  ['fractional preamble', (body) => { entry(body).preambleIndex = 0.5 }, 'observation preamble index'],
  ['boolean index', (body) => { entry(body).publicationIndex = true }, 'observation publication index'],
  ['missing publication', (body) => { entry(body).publicationIndex = 99 }, 'observation publication index'],
  ['dangling preamble', (body) => { entry(body).preambleIndex = 1 }, 'observation preamble index'],
  ['duplicate entry', (body) => { array(object(body.observationReferences).entries).push(structuredClone(entry(body))) }, 'duplicate observation'],
  ['duplicate preamble', (body) => { array(object(body.observationReferences).preambles).push(toolWarning) }, 'invalid observation preambles'],
  ['unused preamble', (body) => { array(object(body.observationReferences).preambles).push(commandWarning) }, 'unreferenced observation preamble'],
  ['reintroduced text', (body) => { publication(body).text = 'invented' }, 'reintroduces text'],
  ['arbitrary location', (body) => { entry(body).publicationIndex = 1; delete object(array(body.publications)[1]).text }, 'observation publication fields'],
  ['source identity', (body) => { object(publication(body).source).publicationId = 'another' }, 'observation publication identity'],
  ['grant Task', (body) => { grant(body).taskId = 'another' }, 'observation grant Task differs'],
  ['ended interval', (body) => { object(publication(body).peerContribution).ended = 'revoked' }, 'observation peer contribution fields'],
  ['unknown publication field', (body) => { publication(body).uri = 'unknown' }, 'observation publication fields'],
  ['unknown metadata', (body) => { object(entry(body).result).sourceName = 'spoofed' }, 'tool result fields'],
  ['wrong warning', (body) => { object(body.observationReferences).preambles = [commandWarning] }, 'observation preamble differs'],
  ['sample digest', (body) => { entry(body).sourceId = 'not-a-digest' }, 'invalid observation sample identity'],
  ['boolean sequence', (body) => { entry(body).sequence = true }, 'invalid observation sample identity'],
  ['ungranted tool', (body) => { object(grant(body).source).tools = ['Edit'] }, 'tool grant differs'],
  ['boolean root', (body) => { object(object(entry(body).result).fields).rootIndex = true }, 'invalid tool fields'],
  ['missing complete grant', (body) => { delete object(publication(body).peerContribution).grant }, 'observation peer contribution fields'],
  ['unknown source version', (body) => { object(grant(body).source).version = 99 }, 'invalid observation grant source version'],
  ['explicit source version one', (body) => { object(grant(body).source).version = 1 }, 'invalid observation grant source version'],
  ['source extra key', (body) => { object(grant(body).source).extension = true }, 'observation grant source fields'],
  ['source empty tools', (body) => { object(grant(body).source).tools = [] }, 'invalid observation grant tools'],
  ['source duplicate tools', (body) => { object(grant(body).source).tools = ['Write', 'Write'] }, 'invalid observation grant tools'],
  ['source null tool', (body) => { object(grant(body).source).tools = [null] }, 'invalid observation grant tools'],
  ['source Unicode length', (body) => { object(grant(body).source).name = '🙂'.repeat(129) }, 'invalid observation grant source'],
  ['grant Unicode length', (body) => { grant(body).grantId = '🙂'.repeat(129) }, 'invalid observation grant identity'],
  ['path Unicode length', (body) => { object(object(entry(body).result).fields).path = '🙂'.repeat(1025) }, 'invalid tool fields'],
  ['invalid recorded initialization', (body) => { Object.assign(object(grant(body).source),
    { version: 2, initialization: 'unknown' }) }, 'invalid observation grant initialization'],
  ['invalid completed permission', (body) => { Object.assign(object(grant(body).source),
    { version: 3, fileContent: 'unknown' }) }, 'invalid observation grant file content'],
  ['null command selector', (body) => { Object.assign(object(grant(body).source),
    { version: 4, commands: [null] }) }, 'observation grant command'],
  ['duplicate command selector', (body) => { Object.assign(object(grant(body).source),
    { version: 4, commands: [{ command: 'check', rootIndex: 0 }, { command: 'check', rootIndex: 0 }] }) },
  'duplicate observation grant command'],
  ['empty command selector', (body) => { Object.assign(object(grant(body).source),
    { version: 4, commands: [] }) }, 'invalid observation grant commands'],
  ['boolean command root', (body) => { Object.assign(object(grant(body).source),
    { version: 4, commands: [{ command: 'check', rootIndex: true }] }) }, 'invalid observation grant command'],
]
it.each(invalid)('rejects %s without recovering an attributed report', (_name, mutate, error) => {
  const { body } = fixture()
  mutate(body)
  for (const revision of ['5', '6'] as const) expect(() => expandReportedGrants(body, revision)).toThrow(error)
})
it('refuses a command that names an unauthorized working root', () => {
  const { body } = fixture(4)
  object(object(entry(body).result).fields).rootIndex = 1
  expect(() => expandReportedGrants(body, '5')).toThrow('command grant differs')
})

it.each([1, 3, 4])('preserves native work permission categories while expanding result version %i', (version) => {
  for (const indexed of [false, true]) for (const failed of [false, true]) {
    const { body, expected } = fixture(version, indexed, failed, true)
    expect(expandReportedGrants(body, '6')).toEqual(expected)
  }
})
const invalidNative: [string, (body: JsonRecord) => void, string][] = [
  ['old source tag', (body) => { object(grant(body).source).kind = 'tool-observations' }, 'invalid observation grant source version'],
  ['old source version', (body) => { object(grant(body).source).version = 4 }, 'invalid observation grant source version'],
  ['implicit answer consent', (body) => { delete object(grant(body).source).completedTurns }, 'observation grant source fields'],
  ['non-boolean consent', (body) => { object(grant(body).source).completedTurns = 1 }, 'invalid native work categories'],
  ['implicit commands', (body) => { delete object(grant(body).source).commands }, 'observation grant source fields'],
  ['empty categories', (body) => { Object.assign(object(grant(body).source), { tools: [], completedTurns: false }) }, 'invalid native work categories'],
  ['forbidden initialization', (body) => { object(grant(body).source).initialization = 'recorded-local-tools' }, 'observation grant source fields'],
  ['unselected file evidence', (body) => { object(grant(body).source).tools = [] }, 'tool grant differs'],
  ['unselected completed file', (body) => { object(grant(body).source).fileContent = 'completed-native-file' }, 'tool grant differs'],
  ['recorded result under combined authority', (body) => {
    Object.assign(object(entry(body).result), { version: 2, origin: { kind: 'recorded-local-tools',
      planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } })
  }, 'tool grant differs'],
]
it.each(invalidNative)('refuses native work %s without broadening a permission', (_name, mutate, error) => {
  const { body } = fixture(1, false, false, true)
  mutate(body)
  expect(() => expandReportedGrants(body, '6')).toThrow(error)
})

it('the independent Python decoder preserves exact text and rejects the same malformed tables', async () => {
  const cases: { body: JsonRecord; revision: string; expected?: unknown; error?: string }[] = []
  for (const version of [1, 2, 3, 4]) for (const indexed of [false, true]) {
    const { body, expected } = fixture(version, indexed)
    for (const revision of ['5', '6'] as const) cases.push({ body, revision, expected })
  }
  for (const version of [1, 2, 3, 4]) {
    const { body, expected } = fixture(version, true, true)
    for (const revision of ['5', '6'] as const) cases.push({ body, revision, expected })
  }
  for (const [_name, mutate, error] of invalid) {
    const { body } = fixture()
    mutate(body)
    for (const revision of ['5', '6'] as const) cases.push({ body, revision, error })
  }
  for (const revision of ['3', '4']) cases.push({ body: fixture().body, revision, error: 'legacy reported revision' })
  cases.push({ body: fixture().body, revision: '7', error: 'unsupported reported revision' })
  for (const version of [1, 3, 4]) for (const indexed of [false, true]) for (const failed of [false, true]) {
    const { body, expected } = fixture(version, indexed, failed, true)
    cases.push({ body, revision: '6', expected })
  }
  for (const [_name, mutate, error] of invalidNative) {
    const { body } = fixture(1, false, false, true)
    mutate(body)
    cases.push({ body, revision: '6', error })
  }
  const run = promisify(execFile)
  const pending = run(process.platform === 'win32' ? 'python' : 'python3',
    [fileURLToPath(new URL('./reported-observation-evidence.py', import.meta.url))],
    { timeout: 20000, maxBuffer: 1048576 })
  pending.child.stdin?.end(JSON.stringify(cases))
  const output = await pending
  expect(output.stderr).toBe('')
  expect(JSON.parse(output.stdout)).toEqual({ cases: cases.length, passed: cases.length })
})

it('refuses unknown future revisions before decoding current tables', () => {
  // @ts-expect-error -- Recorded evidence may contain an unrecognized backend revision.
  expect(() => expandReportedGrants(fixture().body, '7')).toThrow('unsupported reported revision')
})
