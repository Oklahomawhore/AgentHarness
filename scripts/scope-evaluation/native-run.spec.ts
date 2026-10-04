/** Real named-profile calibration; reviewed programs only, with no model credentials. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createFixtures } from './fixtures.ts'
import { runControlledNative } from './native-run.ts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
for (const condition of ['N', 'R'] as const) {
  it.skipIf(process.platform === 'win32' || process.env.DSH_NATIVE_EVALUATION !== '1')(`runs four real dsh Hosts and file tools in ${condition}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-evaluation-spec-'))
    const fixture = createFixtures(20261003)[0]
    if (fixture === undefined) throw new Error('F1 fixture missing')
    try {
      const result = await runControlledNative({ fixture, condition, output: join(root, 'result'),
        repo: resolve(repo), nodePath: process.execPath, timeoutMs: 90000 })
      expect(result.cleanup).toEqual({ started: 4, closed: 4, forced: 0 })
      expect(result.roles.B.requests).toBe(4)
      expect(result.roles.C.requests).toBe(4)
      expect(result.modelUsage).toBeNull()
      expect(result.modelTrialsExecuted).toBe(0)
      expect(result.artifacts).not.toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 100000)
}

it.skipIf(process.platform === 'win32' || process.env.DSH_NATIVE_EVALUATION !== '1')('cancels both real loops at their held tool return and closes all four Hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-evaluation-cancel-'))
  const fixture = createFixtures(20261003)[0]
  if (fixture === undefined) throw new Error('F1 fixture missing')
  try {
    const result = await runControlledNative({ fixture, condition: 'R', output: join(root, 'result'),
      repo: resolve(repo), nodePath: process.execPath, timeoutMs: 90000, cancelAtBarrier: true })
    expect(result.cleanup).toEqual({ started: 4, closed: 4, forced: 0 })
    expect(result.roles.B.requests).toBe(1)
    expect(result.roles.C.requests).toBe(1)
    expect(result.artifacts).toBeNull()
    expect(result.cancelled).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 100000)
