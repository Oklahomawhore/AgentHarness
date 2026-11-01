import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host } from './helpers.ts'

afterEach(cleanup)

it('settles all Hosts and restores global mocks when their disposal reports failures', async () => {
  const hosts = [await host('cleanup-first'), await host('cleanup-second')]
  const originals = hosts.map(value => value.ctx.fiber.dispose.bind(value.ctx.fiber))
  const originalNow = Date.now
  const failures = [new Error('first disposed Host failed'), new Error('second disposed Host failed')]
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  for (const [index, value] of hosts.entries()) {
    vi.spyOn(value.ctx.fiber, 'dispose').mockImplementationOnce(async () => {
      if (index === 1) await release.promise
      await originals[index]!()
      throw failures[index]
    })
  }
  try {
    const stopping = cleanup()
    release.resolve(undefined)
    await expect(stopping).rejects.toMatchObject({ errors: failures })
    expect(Date.now).toBe(originalNow)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled(originals.map(dispose => dispose()))
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
