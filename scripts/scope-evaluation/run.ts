/** Offline fixture verification; this executable cannot select or invoke a model provider. */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtures } from './fixtures.ts'
import { grade } from './oracle.ts'
import { conditions, liveTrialRequirements, planTrials, sha256 } from './plan.ts'

const owner = dirname(fileURLToPath(import.meta.url))
const repo = resolve(owner, '../..')

interface Request {
  readonly output: string
  readonly seed: number
}

/** Parse the complete offline command; unknown options fail before any filesystem write.
 * @param args Process arguments after the executable.
 * @returns Explicit output location and deterministic fixture seed.
 */
export function parseRequest(args: readonly string[]): Request {
  if (args.length !== 4 || args[0] !== '--output' || args[2] !== '--seed') {
    throw new Error('usage: run.ts --output <new-directory> --seed <nonnegative-integer>')
  }
  const output = args[1]
  const rawSeed = args[3]
  if (output === undefined || output.length === 0 || rawSeed === undefined || !/^(0|[1-9]\d*)$/.test(rawSeed)) {
    throw new Error('output and seed must be explicit')
  }
  const seed = Number(rawSeed)
  planTrials(seed)
  return { output: resolve(output), seed }
}

/** Freeze source bytes and generated inputs before running controlled oracle checks.
 * @param request Fresh output directory and preregistered seed.
 * @returns Whether every correct fixture passed and every known client mutation failed.
 */
export async function runSelfCheck(request: Request): Promise<boolean> {
  const fixtures = createFixtures(request.seed)
  const sourceFiles = (await readdir(owner, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(?:ts|mjs|md|yaml)$/.test(entry.name))
    .map(entry => entry.name).sort()
  const sourceHashes: Record<string, string> = {}
  const sourceContents: Record<string, string> = {}
  for (const path of sourceFiles) {
    const content = await readFile(join(owner, path), 'utf8')
    sourceContents[path] = content
    sourceHashes[path] = sha256(content)
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).length > 0
  await mkdir(request.output)
  await mkdir(join(request.output, 'source'))
  for (const [path, content] of Object.entries(sourceContents)) {
    await writeFile(join(request.output, 'source', path), content, { flag: 'wx', mode: 0o600 })
  }
  const fixtureJson = `${JSON.stringify(fixtures, null, 2)}\n`
  const manifest = {
    schema: 'scope-evaluation-offline-v1',
    evidenceKind: 'controlled-fixture-self-check',
    createdAt: new Date().toISOString(),
    seed: request.seed,
    git: { head, dirty, sourceHashes },
    freezeScope: 'Top-level scope-evaluation sources and generated fixtures only; not dependencies or live runtime',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fixtureSha256: sha256(fixtureJson),
    conditions,
    plannedTrials: planTrials(request.seed),
    modelTrialsExecuted: 0,
    modelSessionsExecuted: 0,
    modelUsage: null,
    modelCost: null,
    liveRegistration: null,
    liveTrialRequirements,
  }
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(request.output, 'fixtures.json'), fixtureJson, { flag: 'wx', mode: 0o600 })
  await writeFile(join(request.output, 'manifest.json'), manifestJson, { flag: 'wx', mode: 0o600 })
  await writeFile(join(request.output, 'manifest.sha256'), `${sha256(manifestJson)}\n`, { flag: 'wx' })
  const records = []
  let passed = true
  for (const fixture of fixtures) {
    const correct = await grade({ fixture, clientSource: fixture.correctClientSource, testSource: fixture.correctTestSource })
    const mutants = []
    for (const mutant of fixture.mutants) {
      const result = await grade({ fixture, clientSource: mutant.clientSource, testSource: fixture.correctTestSource })
      mutants.push({ id: mutant.id, result })
      if (result.client.pass || !result.client.executionValid || !result.tests.pass
        || result.cleanup.childrenStarted !== result.cleanup.childrenClosed) passed = false
    }
    if (!correct.controlledPairPass || !correct.client.executionValid || !correct.tests.pass
      || correct.cleanup.childrenStarted !== correct.cleanup.childrenClosed) passed = false
    const record = { caseId: fixture.id, correct, mutants }
    records.push(record)
    await writeFile(join(request.output, `${fixture.id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  }
  const finalSourceFiles = (await readdir(owner, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(?:ts|mjs|md|yaml)$/.test(entry.name))
    .map(entry => entry.name).sort()
  const sourceUnchanged = JSON.stringify(finalSourceFiles) === JSON.stringify(sourceFiles)
    && (await Promise.all(sourceFiles.map(async path =>
      sha256(await readFile(join(owner, path), 'utf8')) === sourceHashes[path],
    ))).every(Boolean)
  if (!sourceUnchanged) passed = false
  const result = {
    sourceUnchanged,
    evidenceKind: 'controlled-fixture-self-check', passed, cases: records.length,
    modelTrialsExecuted: 0, modelUsage: null, modelCost: null,
    resultSha256: Object.fromEntries(await Promise.all(records.map(async (record) => {
      const name = `${record.caseId}.json`
      return [name, sha256(await readFile(join(request.output, name), 'utf8'))] as const
    }))),
  }
  await writeFile(join(request.output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  return passed
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  const request = parseRequest(process.argv.slice(2))
  const passed = await runSelfCheck(request)
  console.log(JSON.stringify({ output: request.output, passed, modelTrialsExecuted: 0 }))
  if (!passed) process.exitCode = 1
}
