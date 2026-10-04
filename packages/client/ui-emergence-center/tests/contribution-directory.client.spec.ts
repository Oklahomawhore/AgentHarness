import { describe, expect, it, vi } from 'vitest'
import { createContributionDirectory } from '../src/client/contribution-directory.ts'

describe('contribution management directory', () => {
  it('discards reads started before and during a mutation and recovers a committed lost reply', async () => {
    const old = Promise.withResolvers<string>()
    const during = Promise.withResolvers<string>()
    const mutation = Promise.withResolvers<string>()
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(during.promise).mockResolvedValue('committed')
    const directory = createContributionDirectory<string, string>(read, vi.fn())
    const first = directory.refresh('session')
    await Promise.resolve()
    const changed = directory.mutate('session', () => mutation.promise)
    const second = directory.refresh('session')
    await Promise.resolve()
    mutation.reject(new Error('reply lost'))
    await changed
    old.resolve('before'); during.resolve('before')
    await Promise.all([first, second])
    expect(directory.getSnapshot().session).toEqual({ status: 'ready', value: 'committed', pending: false, error: 'contribution/unknown-outcome' })
    directory.dispose()
  })

  it('replaces an in-flight read after a committed background change without opening unknown selections', async () => {
    const old = Promise.withResolvers<string>()
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('approved')
    const directory = createContributionDirectory<string, string>(read, vi.fn())
    const first = directory.refresh('session')
    await Promise.resolve()
    directory.invalidate('unknown')
    expect(read).toHaveBeenCalledOnce()
    directory.invalidate('session')
    await directory.refresh('session')
    old.resolve('waiting'); await first
    expect(directory.getSnapshot().session).toEqual({ status: 'ready', value: 'approved', pending: false })
    expect(directory.getSnapshot().unknown).toBeUndefined()
    directory.dispose(); directory.invalidate('session')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('retains observations after failed confirmation, and explicitly retries without repeating a mutation', async () => {
    const read = vi.fn().mockResolvedValueOnce('old').mockRejectedValueOnce(new Error('offline')).mockResolvedValue('new')
    const directory = createContributionDirectory<string, string>(read, vi.fn())
    await directory.refresh('s')
    const operation = vi.fn(async () => 'success')
    await directory.mutate('s', operation)
    expect(directory.getSnapshot().s).toMatchObject({ status: 'error', value: 'old', pending: false })
    await directory.refresh('s')
    expect(directory.getSnapshot().s).toEqual({ status: 'ready', value: 'new', pending: false })
    expect(operation).toHaveBeenCalledOnce()
    directory.dispose()
  })

  it('keeps a mutation pending across observers and rejects duplicate actions', async () => {
    const pending = Promise.withResolvers<string>()
    const directory = createContributionDirectory<string, string>(async () => 'confirmed', vi.fn())
    await directory.refresh('s')
    const mutation = directory.mutate('s', () => pending.promise)
    const listener = vi.fn()
    const unsubscribe = directory.subscribe(listener)
    expect(directory.getSnapshot().s?.pending).toBe(true)
    const duplicate = vi.fn(async () => 'duplicate')
    await directory.mutate('s', duplicate)
    expect(duplicate).not.toHaveBeenCalled()
    pending.resolve('done'); await mutation
    expect(directory.getSnapshot().s?.pending).toBe(false)
    unsubscribe(); directory.dispose()
  })

  it('preserves loaded pages on failure and only appends on explicit more', async () => {
    const read = vi.fn(async (_key: string, previous?: readonly number[]) => [...previous ?? [], previous ? 2 : 1])
    const directory = createContributionDirectory(read, vi.fn())
    await directory.refresh('task')
    read.mockRejectedValueOnce(new Error('offline'))
    await directory.more('task')
    expect(directory.getSnapshot().task).toMatchObject({ status: 'error', value: [1] })
    await directory.more('task')
    expect(directory.getSnapshot().task?.value).toEqual([1, 2])
    await directory.refresh('task')
    expect(directory.getSnapshot().task?.value).toEqual([1])
    directory.dispose()
  })

  it.each(['reply', 'lost-reply'])('retains the sent-mutation lock across reset and confirms its eventual %s', async (outcome) => {
    let authority = 'old'
    const gate = Promise.withResolvers<string>()
    const read = vi.fn(async () => authority)
    const directory = createContributionDirectory<string, string>(read, vi.fn())
    await directory.refresh('s')
    const mutation = directory.mutate('s', () => gate.promise)
    directory.reset(); await directory.refresh('s')
    expect(directory.getSnapshot().s).toMatchObject({ value: 'old', status: 'ready', pending: true })
    const duplicate = vi.fn(async () => 'duplicate')
    await directory.mutate('s', duplicate)
    expect(duplicate).not.toHaveBeenCalled()
    authority = 'committed'
    if (outcome === 'reply') gate.resolve('old-generation-result')
    else gate.reject(new Error('lost reply'))
    expect(await mutation).toBeUndefined()
    expect(directory.getSnapshot().s).toMatchObject({ value: 'committed', status: 'ready', pending: false })
    expect(read).toHaveBeenCalledTimes(3)
    directory.dispose()
  })

  it('keeps mutation ownership until a replacement confirmation read settles after reset', async () => {
    const oldFinal = Promise.withResolvers<string>()
    const newFinal = Promise.withResolvers<string>()
    const entered = Promise.withResolvers<undefined>()
    const read = vi.fn().mockResolvedValueOnce('old').mockImplementationOnce(() => {
      entered.resolve(undefined)
      return oldFinal.promise
    }).mockReturnValueOnce(newFinal.promise)
    const directory = createContributionDirectory<string, string>(read, vi.fn())
    await directory.refresh('s')
    const mutation = directory.mutate('s', async () => 'committed')
    await entered.promise
    const priorConfirmation = directory.refresh('s')
    directory.reset()
    oldFinal.resolve('old connection confirmation')
    await priorConfirmation
    expect(directory.getSnapshot().s).toMatchObject({ status: 'loading', pending: true })
    const duplicate = vi.fn(async () => 'duplicate')
    await directory.mutate('s', duplicate)
    expect(duplicate).not.toHaveBeenCalled()
    newFinal.resolve('current authority')
    await mutation
    expect(directory.getSnapshot().s).toMatchObject({ value: 'current authority', status: 'ready', pending: false })
    expect(read).toHaveBeenCalledTimes(3)
    directory.dispose()
  })

  it('contains throwing observers and drops old work after reset and disposal', async () => {
    const late = Promise.withResolvers<string>()
    const read = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue('new connection')
    const directory = createContributionDirectory<string, string>(read, () => { throw new Error('diagnostic') })
    directory.subscribe(() => { throw new Error('subscriber') })
    const good = vi.fn(); directory.subscribe(good)
    const initial = directory.refresh('s'); await Promise.resolve()
    directory.reset(); await directory.refresh('s')
    late.resolve('old connection'); await initial
    expect(directory.getSnapshot().s?.value).toBe('new connection')
    expect(good).toHaveBeenCalled()
    directory.dispose()
    const operation = vi.fn(async () => 'inactive')
    await directory.mutate('s', operation); await directory.refresh('s')
    expect(operation).not.toHaveBeenCalled()
  })
})
