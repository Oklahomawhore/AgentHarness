/** Freeze a six-call study and launch its preflight or execution through a private dsh profile. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const here = fileURLToPath(new URL('.', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
async function json(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) }
async function modules(repo) {
  const anchors = { context: 'packages/collaboration/development-task-context/package.json',
    task: 'packages/collaboration/development-task/package.json', scope: 'packages/collaboration/claude-scope/package.json',
    sdk: 'packages/bundle/sdk-minimal/package.json' }
  const requested = {
    Launcher: ['scope', '@deepseek-ai/dsh-loader-smoke'], Llm: ['context', '@deepseek-ai/dsh-llm'],
    Rooms: ['context', '@deepseek-ai/dsh-development-room'], Tasks: ['context', '@deepseek-ai/dsh-development-task'],
    TaskSchema: ['task', '@deepseek-ai/dsh-development-task/schema'], Session: ['context', '@deepseek-ai/dsh-session'],
    Projection: ['context', '@deepseek-ai/dsh-session-projection'], Jsonl: ['context', '@deepseek-ai/dsh-session-persistence-jsonl'],
    Semantic: ['context', '@deepseek-ai/dsh-development-task-context/semantic'],
    DeepSeek: ['sdk', '@deepseek-ai/dsh-llm-deepseek'], Credentials: ['scope', '@deepseek-ai/dsh-credentials-local'],
  }
  const result = {}; const fingerprints = {}
  for (const [name, [owner, specifier]] of Object.entries(requested)) {
    const anchor = join(repo, anchors[owner]); const manifest = JSON.parse(await readFile(anchor, 'utf8'))
    const packageName = specifier.split('/').slice(0, 2).join('/')
    if (manifest.name !== packageName && !['dependencies', 'devDependencies', 'peerDependencies']
      .some(field => Object.hasOwn(manifest[field] ?? {}, packageName))) throw new Error(`Undeclared dependency ${specifier}`)
    const path = createRequire(anchor).resolve(specifier)
    if (!path.endsWith('.js') || !(await stat(path)).isFile()) throw new Error(`Missing built public artifact ${specifier}`)
    result[name] = pathToFileURL(path).href
    fingerprints[path] = hash(await readFile(path)); fingerprints[anchor] = hash(await readFile(anchor))
  }
  const cli = join(repo, 'apps/cli/lib/bin.js')
  fingerprints[cli] = hash(await readFile(cli))
  return { modules: result, fingerprints }
}
function parseArgs(args) {
  const [command, ...values] = args
  const allowed = command === 'prepare' ? ['repo', 'run', 'credentials-path', 'study'] : ['run']
  if (!['prepare', 'preflight', 'execute'].includes(command)) throw new Error('Use prepare, preflight, or execute')
  if (values.length % 2) throw new Error('Use --name value arguments')
  const options = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index].slice(2)
    if (!values[index].startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key)
      || !values[index + 1]) throw new Error('Unknown, repeated, or incomplete argument')
    options[key] = values[index + 1]
  }
  return { command, options }
}
function validateStudy(fixture) {
  assert.equal(fixture.version, 1, 'Unsupported study version')
  assert(['live', 'transport-calibration'].includes(fixture.execution?.kind), 'Explicit study provenance is required')
  const endpoint = new URL(fixture.execution.endpoint)
  assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Endpoint must not contain credentials or query')
  if (fixture.execution.kind === 'live') assert.equal(endpoint.href, 'https://api.deepseek.com/', 'Live pilot uses the official DeepSeek endpoint')
  else assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port
    && endpoint.pathname === '/', 'Transport calibration requires an explicit loopback HTTP endpoint')
  assert.equal(fixture.execution.apiKeyEnv, 'DEEPSEEK_API_KEY', 'Unexpected credential reference')
  assert.equal(fixture.semantic.provider, 'deepseek-official', 'Unexpected provider route')
  assert.equal(fixture.semantic.model, 'deepseek-flash', 'Unexpected study model')
  assert.equal(fixture.semantic.reasoningEffort, 'off', 'Thinking is disabled for this study')
  assert.equal(fixture.semantic.temperature, 0, 'Sampling policy changed')
  assert.equal(fixture.semantic.maxCalls, 6, 'The study has exactly six reservation slots')
  assert.equal(fixture.semantic.maxConcurrentCalls, 1, 'The study is serial')
  const positive = (value, max, label) => assert(Number.isSafeInteger(value) && value > 0 && value <= max, label)
  positive(fixture.semantic.maxInputBytes, 32768, 'Input byte limit exceeded')
  positive(fixture.semantic.maxOutputTokens, 2048, 'Output token limit exceeded')
  positive(fixture.semantic.maxOutputBytes, 262144, 'Output byte limit exceeded')
  positive(fixture.semantic.timeoutMs, 60000, 'Call deadline exceeded')
  positive(fixture.limits.maxContextBytes, 10000, 'Delivery byte limit exceeded')
  positive(fixture.limits.wallTimeoutMs, 480000, 'Wall deadline exceeded')
  positive(fixture.limits.cleanupTimeoutMs, 30000, 'Cleanup deadline exceeded')
  positive(fixture.limits.grantLifetimeMs, 900000, 'Grant lifetime exceeded')
  assert(Number.isFinite(fixture.limits.maxKnownCostUsd) && fixture.limits.maxKnownCostUsd > 0
    && fixture.limits.maxKnownCostUsd <= 1, 'Known-cost stop threshold must not exceed USD 1')
  assert.equal(fixture.reports.length, 4, 'Four reports are required')
  assert.deepEqual(fixture.cases.map(item => [item.id, item.afterSequence, item.recipient]), [
    ['A-frontend', 2, 'frontend'], ['A-qa', 2, 'qa'], ['B-frontend', 3, 'frontend'], ['B-qa', 3, 'qa'],
    ['C-frontend', 4, 'frontend'], ['C-qa', 4, 'qa'],
  ], 'The six-cell order must be frozen')
  for (const value of [fixture.objective, fixture.scope, fixture.recipients.frontend, fixture.recipients.qa]) {
    assert(typeof value === 'string' && value.trim(), 'Task and role descriptions must be nonempty')
  }
  assert.equal(fixture.pricing.currency, 'USD')
  for (const field of ['inputMissPerMillion', 'inputHitPerMillion', 'outputPerMillion']) {
    assert(Number.isFinite(fixture.pricing[field]) && fixture.pricing[field] > 0, 'Explicit positive price rates are required')
  }
  assert(/^\d{4}-\d{2}-\d{2}$/.test(fixture.pricing.checkedDate), 'Price verification date is required')
  return fixture
}
function profileEntries(mode, manifest, output) {
  const m = manifest.modules
  const entry = (id, name, config) => ({ id, name, ...(config === undefined ? {} : { config }) })
  const ordinary = [entry('llm', m.Llm), entry('rooms', m.Rooms, { nodeId: 'pilot-owner', presenceTtlMs: 60000,
    maxParticipants: 16, maxRooms: 32, maxTextBytes: 4096 }), entry('tasks', m.Tasks, { maxTasks: 32, maxEventsPerTask: 64,
    maxMergeParents: 8, maxContextBlockBytes: 65536, maxLineageTasks: 64, maxTextBytes: 8192, roomRetryIntervalMs: 10000 }),
  entry('sessions', m.Session), entry('projections', m.Projection),
  entry('ordinary-persistence', m.Jsonl, { root: join(output, 'ordinary'), compression: 'none' })]
  if (mode === 'execute') {
    ordinary.push(entry('credentials', m.Credentials, { path: manifest.credentialsPath ?? join(output, 'home', '.credentials.yaml'),
      dshHome: join(output, 'home'), watch: false, debounceMs: 100 }))
    ordinary.push(entry('deepseek', m.DeepSeek, { apiKeyEnv: manifest.fixture.execution.apiKeyEnv, baseURL: manifest.fixture.execution.endpoint,
      thinking: 'disabled', reasoningEffort: 'off', maxTokens: 2048, defaultContextWindow: 1000000,
      models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000,
        maxTokens: 2048, inputModalities: ['text'] }], streamIdleTimeoutMs: 60000, retryPolicy: { mode: 'normal', maxRetries: 0 } }))
  }
  const auditSessionId = 'semantic-pilot-six-call-audit'
  const isolated = [entry('audit-persistence', m.Jsonl, { root: join(output, 'audit'), compression: 'none' })]
  if (mode === 'execute') isolated.push(entry('semantic', m.Semantic, { auditSessionId, ...manifest.fixture.semantic }))
  isolated.push(entry('pilot', pathToFileURL(join(manifest.root, 'runner.mjs')).href, { mode, output,
    modules: m, fixturePath: join(manifest.root, 'fixtures.json'), auditSessionId }))
  ordinary.push({ id: 'private-audit', name: 'cordis:group', group: true, isolate: { sessionPersistence: true }, config: isolated })
  return [{ insert: ordinary }]
}
const { command, options } = parseArgs(process.argv.slice(2))
if (command === 'prepare') {
  if (!options.repo || !options.run || !isAbsolute(options.repo) || !isAbsolute(options.run)) throw new Error('prepare requires absolute --repo and --run')
  if (options['credentials-path'] !== undefined && !isAbsolute(options['credentials-path'])) throw new Error('credentials path must be absolute')
  const root = resolve(options.run)
  await mkdir(root, { recursive: false, mode: 0o700 })
  const resolved = await modules(options.repo)
  const studyPath = options.study === undefined ? join(here, 'fixtures.json') : options.study
  if (!isAbsolute(studyPath)) throw new Error('study path must be absolute')
  const fixture = validateStudy(JSON.parse(await readFile(studyPath, 'utf8')))
  for (const name of ['runner.mjs', 'rubric.json']) await copyFile(join(here, name), join(root, name))
  await json(join(root, 'fixtures.json'), fixture)
  const sourceHashes = Object.fromEntries(await Promise.all(['driver.mjs', 'runner.mjs', 'fixtures.json', 'rubric.json']
    .map(async name => [join(here, name), hash(await readFile(join(here, name)))])))
  const frozenHashes = Object.fromEntries(await Promise.all(['runner.mjs', 'fixtures.json', 'rubric.json']
    .map(async name => [join(root, name), hash(await readFile(join(root, name)))])))
  const manifest = { version: 1, createdAt: new Date().toISOString(), root, repo: options.repo, nodeVersion: process.version,
    nodePath: process.execPath, modules: resolved.modules, artifactFingerprints: resolved.fingerprints,
    fingerprintScope: 'explicit public entry JS, owning manifests, CLI entry and study sources; not entire transitive dependency closure',
    sourceHashes, frozenHashes, fixture, credentialsPath: options['credentials-path'] ?? null,
    credentialHandling: 'preflight never loads credentials; execute uses existing production credentials-local, describe metadata only in artifacts',
    evaluation: 'six auxiliary summary cells; live or transport-calibration provenance is explicit; no ordinary Agent, Noise/Claude capture, downstream adoption or N/E/S/R comparison' }
  await json(join(root, 'manifest.json'), manifest)
  process.stdout.write(`${JSON.stringify({ prepared: root, realCalls: 0 })}\n`)
} else {
  if (!options.run || !isAbsolute(options.run)) throw new Error(`${command} requires absolute --run`)
  const manifest = JSON.parse(await readFile(join(options.run, 'manifest.json'), 'utf8'))
  assert.equal(manifest.root, resolve(options.run), 'Prepared run must stay at its frozen location')
  validateStudy(manifest.fixture)
  if (process.execPath !== manifest.nodePath || process.version !== manifest.nodeVersion) throw new Error('Prepared Node runtime changed')
  for (const [path, expected] of Object.entries({ ...manifest.artifactFingerprints, ...manifest.frozenHashes, ...manifest.sourceHashes })) {
    if (hash(await readFile(path)) !== expected) throw new Error(`Frozen input changed: ${path}`)
  }
  const output = join(manifest.root, command)
  await mkdir(output, { mode: 0o700 }) // Existing phase is never silently retried with a new audit budget.
  const home = join(output, 'home'); const profileName = `scope-semantic-pilot-${command}`
  const profile = join(home, 'profiles', profileName)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await json(join(profile, 'package.json'), { name: profileName, private: true, dsh: { profile: { bundles: [], patchReload: 'startup' } } })
  await json(join(profile, 'cordis.patch.yml'), profileEntries(command, manifest, output))
  const { resolveExampleLaunch } = await import(manifest.modules.Launcher)
  const invocation = resolveExampleLaunch({ srcBin: join(manifest.repo, 'apps/cli/src/bin.ts'), mode: 'lib',
    configArgs: ['--profile', profileName], env: { DSH_HOME: home, DSH_AGENTS_HOME: join(output, 'agents'),
      DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' } })
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'UTC', TMPDIR: output,
    HOME: home, USERPROFILE: home, ...invocation.env }
  if (command === 'execute' && manifest.credentialsPath === null) {
    // Values only enter the explicitly selected execution process, never its evidence files.
    if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
  }
  await json(join(output, 'invocation.json'), { command: invocation.command, args: invocation.args, cwd: output,
    environmentKeys: Object.keys(env), phase: command, startedAt: new Date().toISOString() })
  const { open } = await import('node:fs/promises')
  const stdout = await open(join(output, 'host.stdout.log'), 'wx', 0o600)
  const stderr = await open(join(output, 'host.stderr.log'), 'wx', 0o600)
  const child = spawn(invocation.command, invocation.args, { cwd: output, env, stdio: ['ignore', stdout.fd, stderr.fd] })
  let timedOut = false
  let interrupted = null
  let killer
  const stop = () => {
    child.kill('SIGTERM')
    if (killer === undefined) killer = setTimeout(() => child.kill('SIGKILL'), manifest.fixture.limits.cleanupTimeoutMs)
  }
  const onInterrupt = () => { interrupted = 'SIGINT'; stop() }
  const onTerminate = () => { interrupted = 'SIGTERM'; stop() }
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate)
  const timeout = setTimeout(() => { timedOut = true; stop() },
    command === 'preflight' ? 30000 : manifest.fixture.limits.wallTimeoutMs + manifest.fixture.limits.cleanupTimeoutMs)
  let spawnError
  const exit = await new Promise((resolveExit) => {
    child.once('error', error => { spawnError = error.message })
    child.once('close', (code, signal) => resolveExit({ code, signal, ...(spawnError === undefined ? {} : { spawnError }) }))
  })
  clearTimeout(timeout); clearTimeout(killer)
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate)
  await stdout.close(); await stderr.close()
  await json(join(output, 'process-result.json'), { ...exit, timedOut, interrupted, finishedAt: new Date().toISOString() })
  process.stdout.write(`${JSON.stringify({ phase: command, output, ...exit, timedOut, interrupted })}\n`)
  process.exitCode = exit.code === 0 && !timedOut && interrupted === null ? 0 : 1
}
