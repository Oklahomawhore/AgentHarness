/** Native portable target coverage and archive/diagnostic routing in the acceptance workflow. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, string>
}
interface Job {
  name: string
  'runs-on': string
  'continue-on-error'?: boolean
  strategy: {
    'fail-fast': boolean
    matrix: { include: { runner: string; target: string }[] }
  }
  steps: Step[]
}
const workflow = load(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/agentharness-portable.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}
const posix = workflow.jobs['browser-installer-mcp']!
const windows = workflow.jobs['windows-installer-mcp']!

describe('native portable acceptance targets', () => {
  it('builds and boots every supported target on its native runner', () => {
    expect(posix['runs-on']).toBe('${{ matrix.runner }}')
    expect(posix.strategy.matrix.include).toEqual([
      { runner: 'ubuntu-24.04', target: 'linux-x64' },
      { runner: 'ubuntu-24.04-arm', target: 'linux-arm64' },
      { runner: 'macos-15', target: 'darwin-arm64' },
      { runner: 'macos-15-intel', target: 'darwin-x64' },
    ])
    expect(windows['runs-on']).toBe('windows-2025')
    expect(windows.steps.find(step => step.name === 'Pack the Windows x64 runtime')?.run).toContain('--target win32-x64')
    expect(posix.strategy['fail-fast']).toBe(false)
    expect(posix['continue-on-error']).toBeUndefined()
    expect(windows['continue-on-error']).toBeUndefined()
    for (const job of [posix, windows]) {
      expect(job.steps.find(step => step.name === 'Verify native target coverage')?.run)
        .toBe('pnpm exec vitest run scripts/tests/agentharness-portable-targets.spec.ts')
    }
  })

  it.each(['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'])(
    'uses the same %s target for native packing and the served archive', (target) => {
      const pack = posix.steps.find(step => step.name === 'Pack the source-free portable runtime')?.run
      const serve = posix.steps.find(step => step.name === 'Start the loopback release server')?.run
      expect(pack?.replaceAll('${{ matrix.target }}', target)).toContain(`--target "${target}"`)
      expect(pack?.replaceAll('${{ matrix.target }}', target)).toContain(`/agentharness-portable/${target}"`)
      expect(serve?.replaceAll('${{ matrix.target }}', target)).toContain(`/agentharness-${target}.tgz"`)
    },
  )

  it('keeps every matrix job and diagnostic artifact distinct within one run', () => {
    const diagnostics = posix.steps.find(step => step.uses === 'actions/upload-artifact@v4')?.with?.name
    const windowsDiagnostics = windows.steps.find(step => step.uses === 'actions/upload-artifact@v4')?.with?.name
    expect(diagnostics).toBeDefined()
    expect(windowsDiagnostics).toBeDefined()
    const names = posix.strategy.matrix.include.map(({ target }) => posix.name.replaceAll('${{ matrix.target }}', target))
    const artifacts = posix.strategy.matrix.include.map(({ target }) => diagnostics!.replaceAll('${{ matrix.target }}', target))
    expect(new Set([...names, windows.name]).size).toBe(5)
    expect(new Set([...artifacts, windowsDiagnostics]).size).toBe(5)
  })
})
