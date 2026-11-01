/** The real Claude Loader tree waits for the descriptor's atomic publication. */
import { lstat, readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { commandHost } from './fixtures/command-host.ts'

const publication = vi.hoisted(() => ({ beforeCommit: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (typeof args[1] === 'string' && args[1].endsWith('/connection.json')) await publication.beforeCommit?.(args[1])
    return actual.rename(...args)
  } }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  publication.beforeCommit = undefined
  if (failures.length !== 0) throw new AggregateError(failures, 'Claude descriptor fixture cleanup failed')
})

describe.skipIf(process.platform === 'win32')('Claude descriptor startup', () => {
  it('settles Loader only after descriptor publication while retaining post-startup state recovery', async () => {
    const entered = Promise.withResolvers<string>()
    const release = Promise.withResolvers<undefined>()
    publication.beforeCommit = async (path) => {
      entered.resolve(path)
      await release.promise
    }
    let loaderSettled = false
    const opening = commandHost(false, 'text', () => { loaderSettled = true })
    void opening.catch(() => {}) // Cleanup joins a failed opening even when an earlier assertion rejects.
    cleanups.push(async () => {
      release.resolve(undefined)
      const host = await opening
      await host.dispose()
    })
    let completed = false
    void opening.then(() => { completed = true }, () => {})
    const path = await entered.promise
    expect(loaderSettled).toBe(false)
    expect(completed).toBe(false)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    release.resolve(undefined)
    const host = await opening
    expect(loaderSettled).toBe(true)
    expect(host.descriptorPath).toBe(path)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(host.descriptor)
    expect(await host.ctx.claudeScope.sessions()).toEqual([])
    expect(host.exitCodes).toEqual([])
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
