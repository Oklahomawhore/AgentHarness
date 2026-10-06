/** Source-plane preparation and normalization for the Python-driven built dsh scope snapshot. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../packages/test-support/session-snapshot/src/launcher.ts'
import { parseSnapshotManifest, usesSeparateWriterSnapshot } from '../../packages/test-support/session-snapshot/src/manifest.ts'
import { writerSnapshotName } from '../../packages/test-support/session-snapshot/src/session-files.ts'
import { normalizeSessionSnapshots } from '../../packages/test-support/session-snapshot/src/normalize.ts'

const [mode, scenarioName, root, logPath] = process.argv.slice(2)
if (!['scope-route-recovery', 'scope-context-live', 'task-context-peer-facts', 'task-context-semantic', 'scope-native-contribution', 'scope-owner-participation', 'scope-dual-contribution', 'scope-local-joint', 'scope-group-join', 'scope-capture-self-omission', 'scope-prejoin-initialization', 'scope-owner-idle', 'scope-joint-automatic', 'scope-semantic-idle', 'scope-automatic-withdrawal'].includes(scenarioName ?? '')) {
  throw new Error('python scope fixture requires scope-route-recovery, scope-context-live, task-context-peer-facts, task-context-semantic, scope-native-contribution, scope-owner-participation, scope-dual-contribution, scope-local-joint, scope-group-join, scope-capture-self-omission, scope-prejoin-initialization, scope-owner-idle, scope-joint-automatic, scope-semantic-idle, or scope-automatic-withdrawal')
}
if (root === undefined) throw new Error('python scope fixture requires its temporary root')
const cwd = resolve(root)
const scenario = fileURLToPath(new URL(`../../snapshots/sdk/${scenarioName}/`, import.meta.url))
if (mode === 'prepare') {
  const patchRoot = join(cwd, '.snapshot-patches')
  const replayFixture = join(cwd, '.replay-fixtures', 'session.v3.jsonl')
  await mkdir(patchRoot, { recursive: true })
  await mkdir(dirname(replayFixture), { recursive: true })
  await writeFile(replayFixture, (await readFile(join(scenario, 'session.v3.jsonl'), 'utf8')).replaceAll('{{cwd}}', cwd))
  const patches = ['cordis.yml', 'cordis.snapshot.yml'].map((name, index) =>
    materializeProfilePatch(join(scenario, name), cwd, patchRoot, index))
  process.stdout.write(JSON.stringify({ patches, replayFixture, replayOverride: join(scenario, 'replay.override.json') }) + '\n')
} else if (mode === 'normalize') {
  if (logPath === undefined) throw new Error('python scope fixture requires its persisted Session')
  const log = await readFile(logPath, 'utf8')
  const firstLine = log.split('\n')[0]
  if (firstLine === undefined) throw new Error('python scope fixture has no Session header')
  const header = JSON.parse(firstLine) as { id: string; version: number }
  const normalized = normalizeSessionSnapshots([log], { sessionIds: [header.id], cwd })[0]
  if (normalized === undefined) throw new Error('python scope fixture normalization produced no Session')
  const manifest = parseSnapshotManifest(await readFile(join(scenario, 'snapshot.yml'), 'utf8'))
  const expected = usesSeparateWriterSnapshot(manifest) ? writerSnapshotName(0, manifest.writerRevision) : 'session.v3.jsonl'
  const reference = normalizeSessionSnapshots([await readFile(join(scenario, expected), 'utf8')], { sessionIds: [], cwd: '{{cwd}}' })[0]
  const records = normalized.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  records[0] = { type: 'session', version: header.version, ...records[0] }
  process.stdout.write(JSON.stringify({ session: records.map(row => JSON.stringify(row)).join('\n') + '\n',
    equivalent: normalized === reference, comparison: normalized, reference }) + '\n')
} else {
  throw new Error('python scope fixture mode must be prepare or normalize')
}
