/** Hosted, keyless validation of the AgentHarness pull request and main branch. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, TestRunner } from 'vitest'
import { gatesForMode } from '../run-gates.ts'
import { COVERAGE_PARTITIONS_ENV, COVERAGE_TEST_TIMEOUT_ENV } from '../coverage-partitions.ts'

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  name: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  'runs-on': string
  'timeout-minutes'?: number
  'continue-on-error'?: boolean
  if?: string
  needs?: string[]
  defaults?: { run: { shell: string } }
  strategy?: { 'fail-fast': boolean; matrix: Record<string, unknown> }
  steps: Step[]
}
const root = resolve(import.meta.dirname, '../..')
const source = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const ci = load(source) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: Record<string, unknown>
  env: Record<string, string>
  jobs: Record<string, Job>
}

describe('AgentHarness hosted CI', () => {
  it('runs ordinary pull requests and main pushes without privileged PR events', () => {
    expect(ci.on).toEqual({ pull_request: {}, push: { branches: ['main'] }, workflow_dispatch: {} })
    expect(ci.permissions).toEqual({ contents: 'read' })
    expect(ci.concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true })
    expect(ci.env.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(source).not.toMatch(/secrets\.|self-hosted|DSH_CI_FAILOVER|refs\/heads\/master|pull_request_target/)
    expect(source).not.toMatch(/sdk-live|test:e2e|release:publish|--update-snapshots|DSH_SNAPSHOT: (?:record|refresh)/)
  })

  it('retains static, complete coverage, and built-consumer gates in independent Linux jobs', () => {
    const linux = ci.jobs.linux!
    expect(linux['runs-on']).toBe('ubuntu-24.04')
    expect(linux.strategy).toEqual({ 'fail-fast': false, matrix: { include: [
      { lane: 'static', command: 'check:ci:static' },
      { lane: 'coverage', command: 'check:ci:coverage' },
      { lane: 'consumers', command: 'check:ci:consumers' },
    ] } })
    expect(linux.steps).toContainEqual(expect.objectContaining({
      uses: 'actions/checkout@v6', with: { 'fetch-depth': 0, 'persist-credentials': false },
    }))
    expect(linux.steps).toContainEqual({ name: 'Prepare bubblewrap', if: "matrix.lane != 'static'", run: 'bash scripts/prepare-ci-bubblewrap.sh' })
    expect(linux.steps).toContainEqual({ name: 'Install Chromium', if: "matrix.lane == 'consumers'",
      run: 'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium' })
    expect(linux.steps).toContainEqual({ uses: 'actions/setup-python@v6.3.0', if: "matrix.lane == 'consumers'",
      with: { 'python-version': '3.10', cache: 'pip' } })
    expect(linux.steps).toContainEqual({ name: 'Install Python collaboration tooling', if: "matrix.lane == 'consumers'",
      run: 'python -m pip install uv==0.11.23' })
    expect(linux.steps).toContainEqual({ name: 'Verify npm install layout', if: "matrix.lane == 'static'", run: 'pnpm run verify-npm-install-layout' })
    expect(linux.steps.at(-1)?.run).toBe('pnpm run ${{ matrix.command }}')
    expect(linux.steps.at(-1)?.env?.DSH_ARCHIVE_BASE_REF)
      .toBe('${{ github.event.pull_request.base.sha || github.event.before || github.sha }}')
  })

  it('keeps all supported Node compatibility versions and loader composition', () => {
    const node = ci.jobs['node-compat']!
    expect(node.strategy).toEqual({ 'fail-fast': false, matrix: { node: ['22.19', '24.9', '26'] } })
    expect(node.steps.map(step => step.run)).toContain('pnpm run check:node-compat')
    expect(node.steps.map(step => step.run)).toContain('pnpm exec vitest run packages/boot/app-boot/tests/loader-shape.compat.spec.ts')
  })

  it('requires the native Windows kernel and the complete Windows gate inventory', () => {
    const windows = ci.jobs['windows-native']!
    expect(windows['runs-on']).toBe('windows-2025')
    expect(windows.defaults).toEqual({ run: { shell: 'pwsh' } })
    expect(windows.steps.map(step => step.run)).toContain('pnpm run check:ci:windows-complete')
    expect(windows.steps.map(step => step.run).join('\n')).toContain('AllowDevelopmentWithoutDevLicense')
    expect(windows['continue-on-error']).toBeUndefined()
    expect(ci.jobs['all-checks-passed']!.needs).toContain('windows-native')
  })

  it.each([
    { job: 'linux', mode: 'ci-coverage' },
    { job: 'windows-native', mode: 'ci-windows-complete' },
  ] as const)('applies the $job coverage budget to test, polling, and hook waits', ({ job, mode }) => {
    const budget = ci.jobs[job]!.env![COVERAGE_TEST_TIMEOUT_ENV]!
    expect(budget).toBe('30000')
    expect(ci.env[COVERAGE_TEST_TIMEOUT_ENV]).toBeUndefined()
    const previous = [
      ['npm_execpath', process.env.npm_execpath],
      [COVERAGE_TEST_TIMEOUT_ENV, process.env[COVERAGE_TEST_TIMEOUT_ENV]],
      [COVERAGE_PARTITIONS_ENV, process.env[COVERAGE_PARTITIONS_ENV]],
    ] as const
    try {
      process.env.npm_execpath = '/fixture/pnpm.cjs'
      process.env[COVERAGE_TEST_TIMEOUT_ENV] = budget
      Reflect.deleteProperty(process.env, COVERAGE_PARTITIONS_ENV)
      for (const id of ['coverage', 'coverage-exempt-heavy']) {
        const args = gatesForMode(mode).find(gate => gate.id === id)!.args
        expect(args).toContain(`--testTimeout=${budget}`)
        expect(args).toContain(`--expect.poll.timeout=${budget}`)
        expect(args).toContain(`--hookTimeout=${budget}`)
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }
    for (const [key, value] of previous) expect(process.env[key]).toBe(value)
  })

  it.each([undefined, '', '30000', '0'])('resolves actual Vitest project budgets for environment %j', (raw) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-vitest-project-budget-'))
    temporaryRoots.push(directory)
    const output = join(directory, 'budgets.json')
    const driver = join(directory, 'resolve.mjs')
    writeFileSync(driver, [
      "import { writeFileSync } from 'node:fs'",
      `const { createVitest } = await import(${JSON.stringify(import.meta.resolve('vitest/node'))})`,
      'let runner',
      'try {',
      `  runner = await createVitest('test', { root: ${JSON.stringify(root)}, config: ${JSON.stringify(join(root, 'vitest.config.ts'))}, watch: false })`,
      '  const budget = config => ({ testTimeout: config.testTimeout, hookTimeout: config.hookTimeout, pollTimeout: config.expect?.poll?.timeout })',
      '  writeFileSync(process.argv[2], JSON.stringify({ root: budget(runner.config),',
      '    projects: runner.projects.map(project => ({ name: project.name, ...budget(project.config) })) }))',
      '} finally { await runner?.close() }',
      '',
    ].join('\n'))
    const env = { ...process.env }
    if (raw === undefined) Reflect.deleteProperty(env, COVERAGE_TEST_TIMEOUT_ENV)
    else env[COVERAGE_TEST_TIMEOUT_ENV] = raw
    const child = spawnSync(process.execPath, [driver, output], {
      cwd: root, env, encoding: 'utf8', timeout: TestRunner.getCurrentTest()!.timeout,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    if (raw === '0') {
      expect(child.status).not.toBe(0)
      expect(child.stderr).toContain(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer`)
    } else {
      expect(child.status, child.stderr).toBe(0)
      const budget = raw === '30000'
        ? { testTimeout: 30000, hookTimeout: 30000, pollTimeout: 30000 }
        : { testTimeout: 5000, hookTimeout: 10000 }
      expect(JSON.parse(readFileSync(output, 'utf8')) as unknown).toEqual({ root: budget, projects: [
        { name: 'thread-safe', ...budget }, { name: 'process-bound', ...budget },
      ] })
    }
  })

  it('keeps benchmarks isolated with a browser and complete Python SDK tests', () => {
    const benchmarks = ci.jobs.benchmarks!
    expect(benchmarks['runs-on']).toBe('ubuntu-24.04')
    expect(benchmarks['timeout-minutes']).toBe(30)
    expect(benchmarks.needs).toBeUndefined()
    const setup = benchmarks.steps.find(step => step.uses === 'actions/setup-node@v6')
    expect(setup?.with?.cache).toBe('pnpm')
    expect(setup?.if).toBeUndefined()
    expect(benchmarks.steps).toContainEqual({ run: 'pnpm run check:ci:bench', env: { DSH_GATE_VERBOSE: '1' } })
    expect(benchmarks.steps.map(step => step.run)).toContain('pnpm --filter @deepseek-ai/dsh-benchmarks exec playwright install --with-deps chromium')
    expect(ci.jobs['python-sdk']!.steps.map(step => step.run))
      .toContain('uv run --python 3.10 --group test --project python/sdk pytest')
  })

  it('removes source-import and runtime-mode overrides before installed-wheel validation', () => {
    const posix = stepScript(builder, 'build', 'Run installed-wheel keyless black-box tests (POSIX)')
    expect(posix).toContain('env -u PYTHONPATH -u DSH_RUNTIME_MODE')
    const windows = stepScript(builder, 'build', 'Run installed-wheel keyless black-box tests (Windows)')
    for (const variable of ['PYTHONPATH', 'DSH_RUNTIME_MODE']) {
      expect(windows).toContain(`$env:${variable} = $null`)
    }
    expect(windows).not.toMatch(/\$env:(?:PYTHONPATH|DSH_RUNTIME_MODE) = ['"]{2}/)
  })

  it('shares one native wheel builder between CI and release without model-account access', () => {
    const runtime = ci.jobs['python-runtime']!
    expect(runtime.uses).toBe('./.github/workflows/build-exe-for-python-sdk.yml')
    expect(runtime.strategy).toBeUndefined()
    expect(runtime.steps).toBeUndefined()
    expect(builder.on.workflow_call).toEqual({ inputs: {
      targets: { type: 'string', required: false, default: '' },
      release: { type: 'boolean', required: false, default: false },
    } })
    expect(builder.concurrency['cancel-in-progress']).toBe('${{ !inputs.release }}')
    expect(builder.jobs.build!.defaults).toEqual({ run: { shell: '${{ matrix.shell }}' } })
    expect(builderSource).not.toMatch(/secrets\.|sdk-live|test:e2e|self-hosted|--update-snapshots/)
    expect(release.jobs.build!.uses).toBe(runtime.uses)
    expect(release.jobs.build!.with).toEqual({
      targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64', release: true,
    })
    const installed = builder.jobs.build!.steps.filter(step => step.name?.startsWith('Run installed-wheel keyless'))
    expect(installed).toHaveLength(2)
    for (const step of installed) {
      expect(step.run).toContain('--scenario all --installed-wheel')
      expect(step.run).toContain('dist-python/')
      expect(step.run).not.toContain('--find-links')
    }
    expect(builder.jobs.build!.steps.find(step => step.name === 'Check macOS payload architecture and deployment target')?.run)
      .toContain('--platform "$PLATFORM" "$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('declares coverage artifact dependencies and keeps optional Wine outside required graphs', () => {
    const previous = process.env.npm_execpath
    try {
      // Graph construction needs a pnpm entrypoint; these probes never launch it.
      process.env.npm_execpath = '/fixture/pnpm.cjs'
      const gates = gatesForMode('ci-coverage')
      expect(gates.find(gate => gate.id === 'build')?.args).toEqual(['/fixture/pnpm.cjs', 'run', 'build'])
      for (const id of ['coverage', 'coverage-exempt-heavy']) {
        expect(gates.find(gate => gate.id === id)?.needs).toContain('build')
        expect(gates.find(gate => gate.id === id)?.needs).toContain('native-system')
      }
      expect(gates.find(gate => gate.id === 'native-system')?.needs).toContain('build')
      for (const mode of ['ci-linux-primary', 'ci-windows-complete'] as const) {
        expect(gatesForMode(mode).map(gate => gate.displayCommand).join('\n')).not.toMatch(/wine/i)
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
      else process.env.npm_execpath = previous
    }
    expect(process.env.npm_execpath).toBe(previous)
  })

  it('requires every executable job and rejects absent, failed, cancelled or skipped dependencies', () => {
    const aggregate = ci.jobs['all-checks-passed']!
    expect(aggregate.needs?.sort()).toEqual(Object.keys(ci.jobs).filter(id => id !== 'all-checks-passed').sort())
    expect(aggregate.if).toBe('${{ !cancelled() }}')
    // This unary boolean expression has identical Actions and JavaScript semantics.
    for (const cancelled of [true, false]) {
      expect(runInNewContext(aggregate.if!.slice(3, -2), { cancelled: () => cancelled }, { timeout: 1000 })).toBe(!cancelled)
    }
    expect(aggregate.steps[0]?.env).toEqual({ RESULTS: "${{ join(needs.*.result, ',') }}" })
    expect(aggregate.steps[0]?.run).toBeTruthy()
    if (process.platform === 'win32') return // POSIX verdict runs exclusively on hosted Linux.
    for (const [results, status] of [['success,success', 0], ['success,failure', 1], ['success,skipped', 1],
      ['success,cancelled', 1], ['success,', 1], ['', 1]] as const) {
      const child = spawnSync('bash', ['-euo', 'pipefail', '-c', aggregate.steps[0]!.run!], {
        env: { PATH: process.env.PATH, RESULTS: results }, encoding: 'utf8', timeout: 10000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stderr + child.stdout).toBe(status)
    }
  })
})

interface NativeWorkflow {
  on: Record<string, unknown>
  concurrency: Record<string, unknown>
  jobs: Record<string, Job>
}
const builderSource = readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8')
const builder = load(builderSource) as NativeWorkflow
const release = load(readFileSync(resolve(root, '.github/workflows/python-release.yml'), 'utf8')) as NativeWorkflow
const platformSource = readFileSync(resolve(root, 'python/sdk-runtime/platforms.json'), 'utf8')
const platforms = JSON.parse(platformSource) as Record<string, { tag: string; executable: string }>
const temporaryRoots: string[] = []
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function stepScript(workflow: NativeWorkflow, job: string, name: string): string {
  const run = workflow.jobs[job]?.steps.find(step => step.name === name)?.run
  if (run === undefined) throw new Error(`Missing ${job} step ${name}`)
  return run
}

function scriptFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-native-wheel-policy-'))
  temporaryRoots.push(directory)
  mkdirSync(join(directory, 'python/sdk-runtime'), { recursive: true })
  writeFileSync(join(directory, 'python/sdk-runtime/platforms.json'), platformSource)
  const output = join(directory, 'github-output')
  const run = (script: string, env: Record<string, string>) => {
    const child = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: directory, env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env }, encoding: 'utf8', timeout: 10000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    return child
  }
  return { directory, output, run }
}

// The committed planning and inventory steps execute on hosted Linux; macOS also supports their POSIX shell.
describe.skipIf(process.platform === 'win32')('native wheel workflow steps', () => {
  const planning = stepScript(builder, 'plan', 'Compute matrix from targets input')
  const inventory = stepScript(release, 'validate', 'Check release contents')

  it('plans all five native carriers with the declared wheel tags and native Windows shell', () => {
    const fixture = scriptFixture()
    const result = fixture.run(planning, { TARGETS: '' })
    expect(result.status, result.stderr).toBe(0)
    const matrix = JSON.parse(readFileSync(fixture.output, 'utf8').replace(/^matrix=/, '')) as Array<{
      platform: string
      target: string
      runner: string
      shell: string
      tag: string
      executable: string
    }>
    expect(matrix.map(cell => cell.platform)).toEqual(['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'win-x64'])
    expect(matrix.map(cell => cell.runner)).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel', 'windows-2025'])
    for (const cell of matrix) {
      expect(cell.target).toBe(`node24-${cell.platform}`)
      expect(cell.tag).toBe(platforms[cell.platform]!.tag)
      expect(cell.executable).toBe(platforms[cell.platform]!.executable)
      expect(cell.shell).toBe(cell.platform === 'win-x64' ? 'pwsh' : 'bash')
    }
  })

  it('uses the executable names emitted by the real builder dry run', () => {
    const fixture = scriptFixture()
    expect(fixture.run(planning, { TARGETS: 'node24-macos-arm64,node24-macos-x64' }).status).toBe(0)
    const matrix = JSON.parse(readFileSync(fixture.output, 'utf8').replace(/^matrix=/, '')) as Array<{
      target: string
      executable: string
    }>
    for (const cell of matrix) {
      const child = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'scripts/build-exe-for-python-sdk.ts'),
        '--dry-run', '--skip-build', `--targets=${cell.target}`], {
        cwd: root, env: { ...process.env, npm_execpath: join(fixture.directory, 'pnpm.cjs') },
        encoding: 'utf8', timeout: 10000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stderr + child.stdout).toBe(0)
      expect(child.stdout).toContain(`--output ${join(root, 'dist-exe', cell.executable)}`)
    }
  })

  it('runs the installed addon script without attempting another workspace installation', () => {
    const fixture = scriptFixture()
    const manager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager: string }
    writeFileSync(join(fixture.directory, 'package.json'), JSON.stringify({ name: 'ci-installed-addon-fixture', packageManager: manager.packageManager,
      scripts: { install: 'node rebuild.mjs' }, dependencies: { 'deliberately-uninstalled': 'file:missing' },
    }))
    writeFileSync(join(fixture.directory, 'rebuild.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('rebuilt', process.env.npm_config_build_from_source)\n")
    const step = stepScript(builder, 'build', 'Rebuild Linux node-pty against manylinux 2.28')
    const command = /bash -euxo pipefail -c \\\n\s+'([^']+)'/.exec(step)?.[1]
    expect(command).toBeDefined()
    const result = fixture.run(command!, { HOST_NODE_ROOT: resolve(process.execPath, '../..'), PNPM_SETUP_ROOT: fixture.directory })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(readFileSync(join(fixture.directory, 'rebuilt'), 'utf8')).toBe('true')
  })

  it.each(['node24-win-x64,node24-win-x64', 'node24-linux-x64,', ',', 'linux-x64', 'node25-linux-x64', 'node24-win-arm64'])(
    'refuses invalid target selection %s before emitting a matrix', (targets) => {
      const fixture = scriptFixture()
      const result = fixture.run(planning, { TARGETS: targets })
      expect(result.status).not.toBe(0)
      expect(readFileSync(fixture.output, 'utf8')).toBe('')
    },
  )

  it('plans an explicit subset and rejects a platform declaration without a matching runner', () => {
    const fixture = scriptFixture()
    expect(fixture.run(planning, { TARGETS: 'node24-win-x64, node24-macos-x64' }).status).toBe(0)
    const matrix = JSON.parse(readFileSync(fixture.output, 'utf8').replace(/^matrix=/, '')) as Array<{ platform: string }>
    expect(matrix.map(cell => cell.platform)).toEqual(['win-x64', 'macos-x64'])
    writeFileSync(join(fixture.directory, 'python/sdk-runtime/platforms.json'), JSON.stringify({ ...platforms,
      'unmapped-platform': { tag: 'unmapped', executable: 'unmapped' },
    }))
    const rejected = fixture.run(planning, { TARGETS: '' })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('Native runner inventory differs')
  })

  it.each(['complete', 'missing', 'extra', 'at-limit', 'below-limit'] as const)(
    'checks the complete local wheel inventory with %s artifacts', (variant) => {
      const fixture = scriptFixture()
      const version = '1.2.3'
      const names = [`deepseek_harness_sdk-${version}-py3-none-any.whl`,
        ...Object.values(platforms).map(value => `deepseek_harness_runtime_bin-${version}-py3-none-${value.tag}.whl`)]
      const dist = join(fixture.directory, 'dist')
      mkdirSync(dist)
      for (const name of names) writeFileSync(join(dist, name), '')
      if (variant === 'missing') rmSync(join(dist, names.at(-1)!))
      if (variant === 'extra') writeFileSync(join(dist, 'unexpected.whl'), '')
      if (variant === 'at-limit' || variant === 'below-limit') {
        truncateSync(join(dist, names[0]!), variant === 'at-limit' ? 100000000 : 99999999)
      }
      const result = fixture.run(inventory, { VERSION: version })
      expect(result.status, result.stderr).toBe(variant === 'complete' || variant === 'below-limit' ? 0 : 1)
    },
  )
})
