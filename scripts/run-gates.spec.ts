import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  defaultConcurrency,
  formatGateResultReason,
  gatesForMode,
  runGate,
  runGates,
  type Gate,
  type GateResult,
} from './run-gates.ts'

function gate(id: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: ['-e', ''],
    ...options,
  }
}

function resultFor(subject: Gate, status: GateResult['status'] = 'passed'): GateResult {
  return {
    gate: subject,
    status,
    durationMs: 10,
    output: [],
    exitCode: status === 'passed' ? 0 : 1,
    signalCode: null,
  }
}

function withPnpmEntrypoint<T>(action: () => T, entrypoint = '/private/pnpm.cjs'): T {
  const previous = process.env.npm_execpath
  process.env.npm_execpath = entrypoint
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
    else process.env.npm_execpath = previous
  }
}

function withEnv<T>(name: string, value: string | undefined, action: () => T): T {
  const previous = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

describe('gate graph validation', () => {
  it.each([
    'ci-primary',
    'ci-linux-primary',
    'ci-static',
    'ci-lint-contracts-ready',
    'ci-coverage',
    'ci-bench',
    'ci-snapshot',
    'ci-artifacts',
    'ci-consumers',
    'ci-windows-blocking',
    'ci-windows-complete',
    'ci-windows-observational',
    'node-compat',
    'check-all',
    'hygiene',
    'doc-sync',
    'doc-quick',
  ] as const)('constructs and executes preflight for a valid non-empty %s graph', async (mode) => {
    const subject = withPnpmEntrypoint(() => gatesForMode(mode))
    const execute = vi.fn(async (item: Gate) => resultFor(item))

    await expect(runGates(subject, subject.length, execute)).resolves.toHaveLength(subject.length)
  })

  it('builds the native addon before benchmarks through the ci-bench script chain', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-bench'))
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(scripts['check:ci:bench']).toBe('tsx scripts/run-gates.ts ci-bench')
    expect(subject).toHaveLength(1)
    expect(subject[0]).toMatchObject({
      id: 'bench',
      displayCommand: 'pnpm run test:bench',
      args: ['/private/pnpm.cjs', 'run', 'test:bench'],
    })
    expect(scripts['test:bench']).toBe('npm run build:bench && npm run build:web && npm run test:bench:built')
    expect(scripts['build:bench']).toBe(
      'npm run build:native-system && npm run build:lib && tsdown --config benchmarks/tsdown.config.ts',
    )
    expect(scripts['build:native-system']).toBe('tsx native/system/scripts/build.ts --host-addon-only')
    expect(scripts['test:bench:built']).toBe('vitest run --config vitest.bench.config.ts')
  })

  it('keeps the public repository link policy in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('public-repository-links')
  })

  it('keeps package-group subsystem ownership in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('subsystem-pages')
  })

  it('keeps the package README Summary limit in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('package-readme-summaries')
  })

  it('derives the quick documentation aggregate from marked doc-sync leaves', () => {
    const full = withPnpmEntrypoint(() => gatesForMode('doc-sync'))
    const quick = withPnpmEntrypoint(() => gatesForMode('doc-quick'))

    expect(quick).toEqual(full.filter(gate => gate.quick === true))
  })

  it('keeps the hygiene aggregate aligned with the package script checks', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('hygiene').map(subject => subject.id))

    expect(ids).toEqual([
      'rescope-vendor', 'publint', 'constraints', 'package-dependencies', 'application-entrypoints',
      'dsh-package-licenses', 'package-invariants', 'built-package-invariants', 'node-next-types',
      'optional-dependency-imports', 'client-packages', 'client-ui-i18n', 'no-bare-dispatcher', 'cordis-config',
      'runtime-closure', 'vendored-links',
    ])
    expect(defaultConcurrency('hygiene', ids.length, 8)).toEqual({
      workers: 4,
      source: '8 available CPU(s), hygiene cap 4',
    })
  })

  it('schedules the longest documentation leaves before short checks', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids.slice(0, 10)).toEqual([
      'doc-typecheck', 'docs-site-build', 'doc-graphs', 'markdown-links', 'type-equivalence',
      'cordis-catalog', 'cordis-inspect-catalog', 'mermaid', 'scoped-events', 'translation-pairing',
    ])
  })

  it('launches a native pnpm entrypoint directly', () => {
    const entrypoint = String.raw`C:\Program Files\pnpm\pnpm.exe`
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-windows-blocking')[0], entrypoint)

    expect(subject).toMatchObject({
      command: entrypoint,
      args: ['run', 'build'],
    })
  })

  it.each(['ci-primary', 'ci-static', 'check-all'] as const)(
    'keeps the DSH package license policy in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('dsh-package-licenses')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all', 'hygiene'] as const)(
    'keeps package dependency enforcement in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('package-dependencies')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all'] as const)(
    'keeps the client dependency policy in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('client-packages')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all'] as const)(
    'keeps weighted approval policy tests in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('approval-policy')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all', 'hygiene'] as const)(
    'keeps hard-coded Client UI copy enforcement in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('client-ui-i18n')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all', 'hygiene'] as const)(
    'keeps application entrypoint enforcement in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('application-entrypoints')
    },
  )

  it('keeps native Windows coverage blocking and behind the complete build', () => {
    const complete = withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))
    const observational = withPnpmEntrypoint(() => gatesForMode('ci-windows-observational'))
      .filter(gate => gate.id !== 'build' && gate.id !== 'docs-site-build')
    const byId = new Map(complete.map(subject => [subject.id, subject]))

    expect(byId.get('coverage')?.allowFailure).not.toBe(true)
    expect(byId.get('coverage')?.needs).toContain('build')
    expect(byId.get('coverage-exempt-heavy')?.allowFailure).not.toBe(true)
    expect(byId.get('coverage')?.needs).toContain('build')
    expect(byId.get('coverage-exempt-heavy')?.needs).toContain('build')
    expect(byId.get('coverage-exempt-heavy')?.args).toContain(
      'packages/experimental/webworker-packer/tests/image-loadable.spec.ts',
    )
    expect(observational).not.toHaveLength(0)
    for (const gate of observational) {
      const completeGate = byId.get(gate.id)
      expect(completeGate?.allowFailure).toBe(true)
      expect(completeGate?.after).toEqual(expect.arrayContaining([
        'coverage',
        'coverage-exempt-heavy',
      ]))
      expect(completeGate?.needs).toEqual(gate.needs)
    }
  })

  it('runs the Windows built-bin smoke after other observational gates settle', () => {
    const observational = withPnpmEntrypoint(() => gatesForMode('ci-windows-observational'))
    const builtBin = observational.find(gate => gate.id === 'built-bin-smoke')

    expect(builtBin?.after).toEqual(
      observational.filter(gate => gate.id !== 'built-bin-smoke').map(gate => gate.id),
    )

    const completeBuiltBin = withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))
      .find(gate => gate.id === 'built-bin-smoke')
    expect(completeBuiltBin?.after).toContain('windows-site')
    expect(completeBuiltBin?.after).not.toContain('docs-site-build')
  })

  it('applies one configured test, polling, and hook timeout to both coverage gates', () => {
    const gates = withEnv('DSH_COVERAGE_TEST_TIMEOUT_MS', '15000', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete')))

    for (const id of ['coverage', 'coverage-exempt-heavy']) {
      expect(gates.find(subject => subject.id === id)?.args).toEqual(expect.arrayContaining([
        '--testTimeout=15000',
        '--expect.poll.timeout=15000',
        '--hookTimeout=15000',
      ]))
    }
  })

  it('keeps Vitest timeout defaults when the coverage override is absent', () => {
    const gates = withEnv('DSH_COVERAGE_TEST_TIMEOUT_MS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete')))

    for (const id of ['coverage', 'coverage-exempt-heavy']) {
      expect(gates.find(subject => subject.id === id)?.args).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^--(?:testTimeout|expect\.poll\.timeout|hookTimeout)=/),
      ]))
    }
  })

  it('rejects an invalid coverage timeout before starting a gate', () => {
    expect(() => withEnv('DSH_COVERAGE_TEST_TIMEOUT_MS', '0', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))))
      .toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must be a positive integer')
  })

  it('selects partitioned coverage only when explicitly configured', () => {
    const coverage = withEnv('DSH_COVERAGE_PARTITIONS', '3', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete').find(subject => subject.id === 'coverage')))

    expect(coverage).toMatchObject({
      displayCommand: 'DSH_COVERAGE_PARTITIONS=3 pnpm run test:coverage:partitioned',
      args: ['/private/pnpm.cjs', 'run', 'test:coverage:partitioned'],
      env: { DSH_COVERAGE_EXEMPT_HEAVY: '1' },
      streamOutput: true,
    })
  })

  it('rejects an invalid coverage partition count before starting a gate', () => {
    expect(() => withEnv('DSH_COVERAGE_PARTITIONS', '1', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))))
      .toThrow('DSH_COVERAGE_PARTITIONS must be an integer greater than 1')
  })

  it.each([
    ['empty', [], /gate graph has no gates/],
    ['duplicate ids', [gate('same'), gate('same')], /duplicate gate id "same"/],
    ['unknown dependencies', [gate('subject', { needs: ['missing'] })], /depends on unknown gate "missing"/],
    ['unknown ordering predecessors', [gate('subject', { after: ['missing'] })], /waits for unknown gate "missing"/],
    ['cycles', [gate('first', { needs: ['second'] }), gate('second', { needs: ['first'] })], /dependency cycle: first -> second -> first/],
    ['mixed cycles', [gate('first', { after: ['second'] }), gate('second', { needs: ['first'] })], /dependency cycle: first -> second -> first/],
  ] as const)('rejects %s before starting a child', async (_label, invalid, message) => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([...invalid], 1, execute)).rejects.toThrow(message)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an invalid worker count before starting a child', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([gate('subject')], 0, execute)).rejects.toThrow('max concurrency must be a positive integer')
    expect(execute).not.toHaveBeenCalled()
  })

  it('skips dependents after their prerequisite fails', async () => {
    const dependent = gate('dependent', { needs: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, 'failed'))

    const results = await runGates([dependent, root], 1, execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(root)
    expect(results[0]).toMatchObject({ gate: dependent, status: 'skipped', error: 'dependency failed or skipped: root' })
  })

  it('runs an ordered follower after its predecessor fails', async () => {
    const follower = gate('follower', { after: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, subject === root ? 'failed' : 'passed'))

    const results = await runGates([follower, root], 2, execute)

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['root', 'follower'])
    expect(results.map(result => result.status)).toEqual(['passed', 'failed'])
  })

  it('runs an ordered follower after its predecessor is skipped', async () => {
    const follower = gate('follower', { after: ['dependent'] })
    const dependent = gate('dependent', { needs: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, subject === root ? 'failed' : 'passed'))

    const results = await runGates([follower, dependent, root], 2, execute)

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['root', 'follower'])
    expect(results.map(result => result.status)).toEqual(['passed', 'skipped', 'failed'])
  })
})

describe('Oxlint gate', () => {
  it('uses the package script when no worker bound is configured', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'pnpm run lint:contracts-ready',
      command: process.execPath,
      args: ['/private/pnpm.cjs', 'run', 'lint:contracts-ready'],
    })
  })

  it('surfaces the configured worker bound on the shared package script', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', '4', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'DSH_OXLINT_THREADS=4 pnpm run lint:contracts-ready',
      command: process.execPath,
      args: ['/private/pnpm.cjs', 'run', 'lint:contracts-ready'],
    })
  })
})

describe('Typert contract preparation', () => {
  it('prepares primary source consumers once before they run', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-primary')))

    expect(subject.find(item => item.id === 'typert-contracts')).toMatchObject({
      displayCommand: 'pnpm run build:lib:host',
      args: ['/private/pnpm.cjs', 'run', 'build:lib:host'],
    })
    for (const [id, script] of [
      ['typecheck', 'typecheck:contracts-ready'],
      ['lint', 'lint:contracts-ready'],
      ['doc-typecheck', 'doc-typecheck:contracts-ready'],
    ] as const) {
      expect(subject.find(item => item.id === id)).toMatchObject({
        displayCommand: `pnpm run ${script}`,
        args: ['/private/pnpm.cjs', 'run', script],
        needs: ['typert-contracts'],
      })
    }
    expect(subject.find(item => item.id === 'build')?.needs).toEqual([
      'typecheck',
      'lint',
      'doc-typecheck',
    ])
  })

  it('reuses contracts from the validated consumer build', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-consumers'))

    expect(subject.find(item => item.id === 'lint-and-duplication')).toMatchObject({
      displayCommand: 'pnpm run check:ci:lint:contracts-ready',
      args: ['/private/pnpm.cjs', 'run', 'check:ci:lint:contracts-ready'],
    })
    expect(subject.find(item => item.id === 'doc-typecheck')).toMatchObject({
      displayCommand: 'pnpm run doc-typecheck:contracts-ready',
      args: ['/private/pnpm.cjs', 'run', 'doc-typecheck:contracts-ready'],
    })
  })

  it('keeps standalone doc sync responsible for preparation', () => {
    const docTypecheck = withPnpmEntrypoint(() =>
      gatesForMode('doc-sync').find(item => item.id === 'doc-typecheck'))

    expect(docTypecheck?.displayCommand).toBe('pnpm run doc-typecheck')
  })
})

describe('Node compatibility graph', () => {
  it('runs the jsdom environment smoke on every advertised Node line', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('node-compat'))

    expect(subject.find(item => item.id === 'vitest-jsdom-smoke')).toMatchObject({
      label: 'Vitest jsdom smoke',
      args: [
        '/private/pnpm.cjs',
        'exec',
        'vitest',
        'run',
        'scripts/vitest-environment.compat.spec.ts',
      ],
    })
  })
})

describe('Node 24 lane ownership', () => {
  it('keeps the static lane source-only', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-static'))

    expect(subject.map(item => item.id)).not.toContain('build')
    expect(subject.map(item => item.id)).not.toContain('doc-typecheck')
  })

  it('owns the build and orders its artifact consumers', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-consumers'))

    expect(defaultConcurrency('ci-consumers', subject.length, 4)).toEqual({
      workers: 11,
      source: 'ci-consumers gate count',
    })
    expect(subject.map(item => item.id)).toEqual([
      'build',
      'node-compat',
      'publint',
      'built-package-invariants',
      'lint-and-duplication',
      'snapshot',
      'expected-output',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ])
    expect(subject.find(item => item.id === 'publint')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'build')?.env).toEqual({
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    expect(subject.find(item => item.id === 'node-compat')?.env).toEqual({
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    expect(subject.find(item => item.id === 'built-package-invariants')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'lint-and-duplication')?.needs).toEqual(['built-package-invariants'])
    for (const id of [
      'snapshot',
      'expected-output',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ]) {
      expect(subject.find(item => item.id === id)?.needs).toEqual(['built-package-invariants'])
    }
    expect(subject.find(item => item.id === 'snapshot')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'expected-output')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'doc-typecheck')?.env).toEqual({
      DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1',
    })
    expect(subject.find(item => item.id === 'built-bin-smoke')?.args).toEqual(
      expect.arrayContaining([
        'packages/subprocess/subprocess-local/tests/spawn-runner-built.e2e.ts',
        'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
        'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
        'packages/experimental/agent-team/tests/built-lib.e2e.ts',
      ]),
    )
    expect(subject.find(item => item.id === 'web-snapshot')).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
      after: [
        'publint',
        'lint-and-duplication',
        'snapshot',
        'expected-output',
        'doc-typecheck',
        'node-next-types',
        'built-bin-smoke',
      ],
    })
  })
})

describe('Linux primary graph', () => {
  it('adds the same compare-only web gate after built client artifacts', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-linux-primary'))
    const web = subject.find(item => item.id === 'web-snapshot')

    expect(web).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
      needs: ['built-package-invariants'],
    })
  })
})

describe('gate process outcomes', () => {
  it('reports a failed spawn without inventing an exit or signal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-missing-'))
    try {
      const result = await runGate(gate('missing', { command: join(directory, 'missing-command') }))
      expect(result).toMatchObject({ status: 'failed', exitCode: null, signalCode: null, output: [] })
      expect(result.error).toContain('failed to start command:')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('streams selected gate output without retaining it', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const result = await runGate(gate('streamed', {
        args: ['-e', "process.stdout.write('live output')"],
        streamOutput: true,
      }))

      expect(result.status).toBe('passed')
      expect(result.output).toEqual([])
      expect(write).toHaveBeenCalledWith('live output')
    } finally {
      write.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('reports signal termination independently from exit status', async () => {
    const result = await runGate(gate('terminated', {
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
    }))

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.signalCode).toBe('SIGTERM')
    expect(formatGateResultReason(result)).toBe('signal SIGTERM')
  })
})

describe('complete aggregate execution', () => {
  it('retains a running sibling and starts queued independent work after a failure', async () => {
    const first = gate('first')
    const sibling = gate('sibling')
    const queued = gate('queued')
    const dependent = gate('dependent', { needs: ['first'] })
    const follower = gate('follower', { after: ['first'] })
    const firstDone = Promise.withResolvers<GateResult>()
    const siblingDone = Promise.withResolvers<GateResult>()
    const queuedStarted = Promise.withResolvers<undefined>()
    const execute = vi.fn((subject: Gate) => {
      if (subject.id === first.id) return firstDone.promise
      if (subject.id === sibling.id) return siblingDone.promise
      if (subject.id === queued.id) queuedStarted.resolve(undefined)
      return Promise.resolve(resultFor(subject))
    })
    const complete = runGates([first, sibling, queued, dependent, follower], 2, execute)
    const release = async () => {
      firstDone.resolve(resultFor(first, 'failed'))
      siblingDone.resolve(resultFor(sibling))
      await complete
    }
    onTestFinished(release)
    try {
      expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['first', 'sibling'])
      firstDone.resolve({ ...resultFor(first, 'failed'), output: [{ stream: 'stderr', text: 'first error' }] })
      await queuedStarted.promise
      expect(execute.mock.calls.map(([subject]) => subject.id)).toContain('queued')
    } finally {
      await release()
    }
    const results = await complete
    expect(results.map(result => result.status)).toEqual(['failed', 'passed', 'passed', 'skipped', 'passed'])
    expect(results[0]?.output).toEqual([{ stream: 'stderr', text: 'first error' }])
    expect(results[3]?.error).toBe('dependency failed or skipped: first')
    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['first', 'sibling', 'queued', 'follower'])
  })

  // The real CLI starts every short-lived leaf through pnpm; one worker makes the first failure deterministic.
  it('continues every independent CLI check after the first failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-complete-'))
    const pnpm = join(directory, 'pnpm.mjs')
    try {
      writeFileSync(pnpm, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
writeFileSync(join(process.env.DSH_GATE_FIXTURE_ROOT, process.pid + '.json'), JSON.stringify(args), { flag: 'wx' })
process.exitCode = args[1] === 'verify-md-links' ? 7 : 0
`)
      const expected = withPnpmEntrypoint(() => gatesForMode('doc-quick'), pnpm)
      const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(import.meta.dirname, 'run-gates.ts'), 'doc-quick'], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, npm_execpath: pnpm, DSH_GATE_FIXTURE_ROOT: directory,
          DSH_GATE_CONCURRENCY: '1', DSH_GATE_FAIL_FAST: '1' },
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).toBe(1)
      const calls = readdirSync(directory).filter(name => name.endsWith('.json'))
        .map(name => readFileSync(join(directory, name), 'utf8')).sort()
      expect(calls).toEqual(expected.map(subject => JSON.stringify(subject.args.slice(1))).sort())
      expect(result.stdout).toContain('0 skipped')
      expect(result.stdout).toContain(`${expected.length - 1} passed, 1 failed`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)
})
