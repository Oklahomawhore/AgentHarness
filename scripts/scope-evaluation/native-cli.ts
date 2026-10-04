/** Explicit controlled native calibration command; invokes no external model provider. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createFixtures } from './fixtures.ts'
import { grade } from './oracle.ts'
import { sha256 } from './plan.ts'
import { resolveNativeModules } from './native-dependencies.ts'
import { runControlledNative } from './native-run.ts'

const directory = dirname(fileURLToPath(import.meta.url))
const repo = resolve(directory, '../..')
const dockerSchema = z.object({ imageDigest: z.string(), dockerPath: z.string(), dockerHost: z.string(),
  memoryBytes: z.number().int().positive(), cpus: z.number().positive(), pidsLimit: z.number().int().positive(),
  tmpBytes: z.number().int().positive(), maxWireBytes: z.number().int().positive(), maxDiagnosticBytes: z.number().int().positive(),
  cleanupTimeoutMs: z.number().int().positive() }).strict()

/** Run F1 N/R and a real cancellation control, recording exact source and built-module identities.
 * @param args Explicit --output, --seed, and --docker-config arguments in that order.
 * @returns true only when all three calibrations and both sealed artifact checks pass.
 */
export async function runNativeCommand(args: readonly string[]): Promise<boolean> {
  const [outputFlag, outputArg, seedFlag, seedArg, dockerFlag, dockerFile] = args
  if (args.length !== 6 || outputFlag !== '--output' || seedFlag !== '--seed' || dockerFlag !== '--docker-config'
    || outputArg === undefined || seedArg === undefined || dockerFile === undefined || !/^(0|[1-9]\d*)$/.test(seedArg)) {
    throw new Error('usage: native-cli.ts --output <new-directory> --seed <integer> --docker-config <explicit-json>')
  }
  const fixture = createFixtures(Number(seedArg))[0]
  if (fixture === undefined) throw new Error('F1 fixture missing')
  const docker = dockerSchema.parse(JSON.parse(await readFile(dockerFile, 'utf8')) as unknown)
  const output = resolve(outputArg)
  await mkdir(output, { mode: 0o700 })
  const sourceFiles = (await readdir(directory)).filter(name => /\.(?:ts|mjs)$/.test(name)).sort()
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name =>
    [name, sha256(await readFile(join(directory, name), 'utf8'))] as const)))
  const modules = resolveNativeModules(repo)
  const moduleHashes = Object.fromEntries(await Promise.all(Object.entries(modules).map(async ([name, url]) =>
    [name, { url, sha256: sha256(await readFile(fileURLToPath(url), 'utf8')) }] as const)))
  const manifest = { kind: 'controlled-native-calibration', caseId: 'F1', conditions: ['N', 'R'], seed: fixture.seed,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    node: process.version, sourceHashes, moduleHashes, fixtureSha256: sha256(JSON.stringify(fixture)),
    dockerImage: docker.imageDigest, modelTrialsExecuted: 0, modelUsage: null, modelCost: null,
    scope: 'Same registered golden programs in both conditions; no quality comparison. C public tests exercise the initial client.',
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const results = []
  for (const condition of ['N', 'R'] as const) {
    results.push(await runControlledNative({ fixture, condition, output: join(output, condition), repo,
      nodePath: process.execPath, timeoutMs: 120000,
      grade: (clientSource, testSource) => grade({ fixture, clientSource, testSource,
        nodePath: process.execPath, timeoutMs: 15000, docker }),
    }))
  }
  results.push(await runControlledNative({ fixture, condition: 'R', output: join(output, 'cancel'), repo,
    nodePath: process.execPath, timeoutMs: 90000, cancelAtBarrier: true }))
  const sourceUnchanged = (await Promise.all(sourceFiles.map(async name =>
    sha256(await readFile(join(directory, name), 'utf8')) === sourceHashes[name]))).every(Boolean)
  const passed = sourceUnchanged && results.every(result => result.cancelled || result.oracle?.controlledPairPass === true)
  await writeFile(join(output, 'result.json'), JSON.stringify({ kind: 'controlled-native-run', passed,
    sourceUnchanged, modelTrialsExecuted: 0, modelUsage: null, modelCost: null, results }, null, 2) + '\n', { flag: 'wx' })
  return passed
}
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const passed = await runNativeCommand(process.argv.slice(2))
  process.stdout.write(JSON.stringify({ passed, modelTrialsExecuted: 0 }) + '\n')
  if (!passed) process.exitCode = 1
}
