/** Resolve platform coverage policy while retaining unsupported-entrypoint tests. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const probe = `
import { matchesGlob } from 'node:path'
import { pathToFileURL } from 'node:url'
const url = pathToFileURL(process.cwd() + '/vitest.config.ts')
await import(url.href)
const platform = process.argv[1]
Object.defineProperty(process, 'platform', { value: platform })
const { default: config } = await import(url.href + '?coverage-platform=' + platform)
const test = config.test
const file = 'packages/client/connection/src/local-access.ts'
const suite = 'packages/client/connection/tests/local-access.host.spec.ts'
const matches = (path, patterns) => patterns.some(pattern => matchesGlob(path, pattern))
console.log(JSON.stringify({
  excluded: matches(file, test.coverage.exclude),
  suiteSelected: !matches(suite, test.exclude) && test.projects.some(project =>
    matches(suite, project.test.include) && !matches(suite, project.test.exclude)),
  thresholds: test.coverage.thresholds,
}))
`

it.each(['darwin', 'linux', 'win32'])('keeps local Connection coverage and refusal tests on their supported %s paths', (platform) => {
  // Preload native tooling on the actual host before resolving the other platform's policy in its own process.
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', probe, platform], {
    cwd: root, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
    env: { ...process.env, DSH_COVERAGE_PARTITION_MODE: undefined, DSH_COVERAGE_EXEMPT_HEAVY: undefined },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  const resolved: unknown = JSON.parse(result.stdout)
  expect(resolved).toEqual({ excluded: platform === 'win32', suiteSelected: true,
    thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 } })
})
