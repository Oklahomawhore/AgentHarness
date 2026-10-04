/** Register, inspect, or explicitly execute a frozen ordinary-Agent JSON work study. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { gradeDataArtifacts } from './data-artifacts.ts'
import { createDataStudy, dataStudyConditions, parseDataStudyConfig } from './data-study.ts'
import { resolveNativeModules } from './native-dependencies.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const fingerprintSchema = z.record(z.string().refine(isAbsolute), z.string().regex(/^[a-f0-9]{64}$/))
const manifestSchema = z.object({ version: z.literal(1), id: z.literal('payment-json-work-v1'),
  root: z.string().refine(isAbsolute), repo: z.string().refine(isAbsolute), head: z.string(), createdAt: z.iso.datetime(),
  nodePath: z.string().refine(isAbsolute), nodeVersion: z.string(), seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  execution: z.enum(['live', 'transport-calibration']), config: z.unknown(), studySha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHashes: fingerprintSchema, artifactHashes: fingerprintSchema,
  conditions: z.tuple([z.literal('N'), z.literal('E'), z.literal('R')]),
  fingerprintScope: z.string(), scope: z.string(), maximumDispatches: z.number().int().positive(),
}).strict()
type Manifest = z.infer<typeof manifestSchema>

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
async function fingerprints(paths: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))] as const)))
}
async function fingerprintPaths(): Promise<{ source: string[]; artifacts: string[] }> {
  const source = (await readdir(here)).filter(name => /\.(?:ts|mjs)$/.test(name)).sort().map(name => join(here, name))
  const modules = resolveNativeModules(repo)
  const artifacts = [...Object.values(modules).map(url => fileURLToPath(url)), join(repo, 'apps/cli/lib/bin.js'),
    ...['collaboration/claude-scope', 'collaboration/scope-agent-contribution', 'bundle/sdk-minimal',
      'session/session-persistence-jsonl'].map(owner => join(repo, 'packages', owner, 'package.json'))]
  return { source, artifacts: [...new Set(artifacts)].sort() }
}
async function verify(manifest: Manifest): Promise<void> {
  if (manifest.repo !== repo || manifest.nodePath !== process.execPath || manifest.nodeVersion !== process.version) {
    throw new Error('prepared checkout or Node runtime changed')
  }
  const paths = await fingerprintPaths()
  for (const [expectedPaths, recorded] of [[paths.source, manifest.sourceHashes], [paths.artifacts, manifest.artifactHashes]] as const) {
    if (JSON.stringify(expectedPaths.slice().sort()) !== JSON.stringify(Object.keys(recorded).sort())) {
      throw new Error('frozen fingerprint inventory changed')
    }
  }
  for (const [path, expected] of Object.entries({ ...manifest.sourceHashes, ...manifest.artifactHashes })) {
    if (hash(await readFile(path)) !== expected) throw new Error(`frozen input changed: ${path}`)
  }
}

/** Freeze source identities and finite model routes without loading credentials or launching Hosts.
 * @param input - New absolute output directory, reproducible seed, and explicit route configuration.
 * @returns Prepared manifest; preparation performs zero model dispatches.
 */
export async function prepareDataStudy(input: {
  root: string
  seed: number
  execution: 'live' | 'transport-calibration'
  config: unknown
}): Promise<Manifest> {
  if (!isAbsolute(input.root)) throw new Error('study directory must be absolute')
  const config = parseDataStudyConfig(input.config, input.execution)
  const study = createDataStudy(input.seed, config)
  const paths = await fingerprintPaths()
  const manifest: Manifest = { version: 1, id: study.runtime.id, root: resolve(input.root), repo,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), createdAt: new Date().toISOString(),
    nodePath: process.execPath, nodeVersion: process.version, seed: input.seed, execution: input.execution, config,
    studySha256: hash(JSON.stringify(study)), sourceHashes: await fingerprints(paths.source),
    artifactHashes: await fingerprints(paths.artifacts),
    conditions: [...dataStudyConditions], maximumDispatches: 6 * config.ordinary.maxCalls + config.semantic.maxCalls,
    fingerprintScope: 'Evaluation root sources, resolved public JS entries, their resolver manifests and CLI entry; not the complete dependency graph.',
    scope: 'One synthetic post-update wave; B and C ordinary Agents work independently. N has no update, E original admitted reports, R recipient semantic projection. No shared-summary S, existing-Session withdrawal, representative benefit or cross-device claim.',
  }
  await mkdir(manifest.root, { mode: 0o700 })
  await json(join(manifest.root, 'manifest.json'), manifest)
  await json(join(manifest.root, 'registration.json'), { modelDispatches: 0, liveModelDispatches: 0,
    credentialRead: false, conditions: manifest.conditions, maximumDispatches: manifest.maximumDispatches,
    budgetScope: 'ordinary.maxCalls per recipient per condition; semantic.maxCalls for the R owner. No automatic retries or monetary cap.',
    cells: manifest.conditions.map(condition => ({ condition, status: 'unattempted' })) })
  return manifest
}

/** Validate the frozen registration without consulting model credentials or starting a provider.
 * @param root - Absolute directory created by prepareDataStudy.
 * @returns Validated registration and deterministic runtime/oracle separated by ownership.
 */
export async function inspectDataStudy(root: string): Promise<{ manifest: Manifest; study: ReturnType<typeof createDataStudy> }> {
  if (!isAbsolute(root)) throw new Error('study directory must be absolute')
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as unknown)
  if (manifest.root !== resolve(root)) throw new Error('prepared study must stay at its frozen location')
  const config = parseDataStudyConfig(manifest.config, manifest.execution)
  const study = createDataStudy(manifest.seed, config)
  if (manifest.studySha256 !== hash(JSON.stringify(study))) throw new Error('registered task or oracle changed')
  if (manifest.maximumDispatches !== 6 * config.ordinary.maxCalls + config.semantic.maxCalls) throw new Error('registered total dispatch limit changed')
  await verify(manifest)
  return { manifest, study }
}

/** Run one explicit phase; existing phases are never retried or replaced automatically.
 * @param command - Preflight checks frozen bytes only; execute launches the registered native experiment.
 * @param root - Absolute prepared study directory.
 * @returns Phase evidence, including whether an explicit execution completed without runtime failure.
 */
export async function runDataPhase(command: 'preflight' | 'execute', root: string): Promise<{ readonly failed: boolean; readonly [key: string]: unknown }> {
  const { manifest, study } = await inspectDataStudy(root)
  const output = join(root, command)
  await mkdir(output, { mode: 0o700 })
  if (command === 'preflight') {
    const result = { failed: false, phase: command, frozenInputsMatch: true, credentialRead: false, hostsStarted: 0,
      modelDispatches: 0, liveModelDispatches: 0, maximumDispatches: manifest.maximumDispatches,
      scope: 'Static registration and explicit built-entry hashes only; does not test credentials, network, model availability or runtime behavior.' }
    await json(join(output, 'result.json'), result)
    return result
  }
  const cancellation = new AbortController()
  const onInterrupt = (): void => { cancellation.abort(new Error('data study interrupted by SIGINT')) }
  const onTerminate = (): void => { cancellation.abort(new Error('data study interrupted by SIGTERM')) }
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate)
  const results = []
  try {
    const { runNativeData } = await import('./native-data-run.ts')
    for (const condition of dataStudyConditions) {
      cancellation.signal.throwIfAborted()
      await verify(manifest)
      cancellation.signal.throwIfAborted()
      const result = await runNativeData({ repo, nodePath: process.execPath, output: join(output, condition),
        condition, signal: cancellation.signal, study: study.runtime, execution: { kind: manifest.execution },
        grade: artifacts => gradeDataArtifacts({ ...artifacts, ...study.oracle }),
      })
      results.push(result)
      await json(join(output, `${condition}.json`), result)
      if (result.dispatchBlocked || result.failed) break
    }
    await verify(manifest)
    const failed = results.length !== dataStudyConditions.length || results.some(result => result.failed || result.dispatchBlocked)
    const evidence = { failed,
      phase: command, execution: manifest.execution, sourceUnchanged: true,
      completedConditions: results.length, skippedConditions: dataStudyConditions.slice(results.length), results,
      scope: manifest.scope }
    await json(join(output, 'result.json'), evidence)
    return evidence
  } catch (error) {
    await json(join(output, 'failure.json'), { phase: command, completedConditions: results.length,
      failed: true, error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate)
  }
}

function parseArgs(args: readonly string[]): { command: 'prepare' | 'preflight' | 'execute'; options: Record<string, string> } {
  const [command, ...values] = args
  if (command !== 'prepare' && command !== 'preflight' && command !== 'execute') throw new Error('use prepare, preflight, or execute')
  const allowed = command === 'prepare' ? ['run', 'seed', 'config', 'execution'] : ['run']
  if (values.length !== allowed.length * 2) throw new Error(`provide ${allowed.map(name => `--${name}`).join(', ')}`)
  const options: Record<string, string> = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--') || !allowed.includes(key.slice(2))
      || Object.hasOwn(options, key.slice(2)) || value.length === 0) throw new Error('unknown, repeated or incomplete argument')
    options[key.slice(2)] = value
  }
  return { command, options }
}
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2))
  const root = options['run']
  if (root === undefined) throw new Error('--run is required')
  if (command === 'prepare') {
    const seed = options['seed']; const path = options['config']; const execution = options['execution']
    if (seed === undefined || !/^(0|[1-9]\d*)$/.test(seed) || path === undefined || !isAbsolute(path)
      || (execution !== 'live' && execution !== 'transport-calibration')) throw new Error('invalid registration arguments')
    const manifest = await prepareDataStudy({ root, seed: Number(seed), execution,
      config: JSON.parse(await readFile(path, 'utf8')) as unknown })
    process.stdout.write(JSON.stringify({ prepared: manifest.root, liveModelDispatches: 0 }) + '\n')
  } else {
    const result = await runDataPhase(command, root)
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.failed) process.exitCode = 1
  }
}
