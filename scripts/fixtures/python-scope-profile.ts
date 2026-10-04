/** Source-plane preparation and normalization for the Python-driven built dsh scope snapshot. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../packages/test-support/session-snapshot/src/launcher.ts'
import { normalizeSessionSnapshots } from '../../packages/test-support/session-snapshot/src/normalize.ts'

const [mode, scenarioName, root, logPath] = process.argv.slice(2)
if (!['scope-context-live', 'task-context-peer-facts', 'task-context-semantic', 'scope-native-contribution', 'scope-owner-participation', 'scope-owner-idle'].includes(scenarioName ?? '')) {
  throw new Error('python scope fixture requires scope-context-live, task-context-peer-facts, task-context-semantic, scope-native-contribution, scope-owner-participation, or scope-owner-idle')
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
  const reference = normalizeSessionSnapshots([await readFile(join(scenario, 'session.v3.jsonl'), 'utf8')], { sessionIds: [], cwd: '{{cwd}}' })[0]
  const records = normalized.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  records[0] = { type: 'session', version: header.version, ...records[0] }
  process.stdout.write(JSON.stringify({ session: records.map(row => JSON.stringify(row)).join('\n') + '\n',
    equivalent: normalized === reference, comparison: normalized, reference }) + '\n')
} else {
  throw new Error('python scope fixture mode must be prepare or normalize')
}
