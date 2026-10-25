import { describe, expect, it, vi } from 'vitest'
import type {
  DevWorkbenchEntryId,
  DevWorkbenchEntrySnapshot,
  DevWorkbenchSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createDevWorkbenchInventory } from '../src/client/inventory.ts'

const ENTRY = 'agent' as DevWorkbenchEntryId

function row(phase: DevWorkbenchEntrySnapshot['phase']): DevWorkbenchEntrySnapshot {
  return {
    id: ENTRY,
    label: 'AgentHarness Agent',
    argv: ['uv', 'run', 'agentharness-agents'],
    cwd: '/workspace/agentharness-agents',
    views: [],
    phase,
    stdout: '',
    stderr: '',
    stdoutLossy: false,
    stderrLossy: false,
  }
}

describe('createDevWorkbenchInventory', () => {
  it('single-flights reads and publishes task actions', async () => {
    let resolveList!: (value: DevWorkbenchSnapshot) => void
    const list = vi.fn(() => new Promise<DevWorkbenchSnapshot>((resolve) => { resolveList = resolve }))
    const start = vi.fn(async () => row('running'))
    const stop = vi.fn(async () => row('stopped'))
    const source = createDevWorkbenchInventory({ list, start, stop }, vi.fn())
    const listener = vi.fn()
    source.subscribe(listener)

    source.refresh()
    source.refresh()
    expect(list).toHaveBeenCalledOnce()
    resolveList({ entries: [row('idle')] })
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot()).toMatchObject({ read: true, entries: [{ phase: 'idle' }] })

    await source.start(ENTRY)
    expect(source.getSnapshot()).toMatchObject({ entries: [{ phase: 'running' }] })
    await source.stop(ENTRY)
    expect(source.getSnapshot()).toMatchObject({ entries: [{ phase: 'stopped' }] })
    expect(listener).toHaveBeenCalled()
  })

  it('keeps prior rows on read failure and ignores a stale read after reset', async () => {
    const report = vi.fn()
    let rejectList!: (error: unknown) => void
    const list = vi.fn(() => new Promise<DevWorkbenchSnapshot>((_resolve, reject) => { rejectList = reject }))
    const source = createDevWorkbenchInventory({
      list,
      start: async () => row('running'),
      stop: async () => row('stopped'),
    }, report)

    source.refresh()
    source.reset()
    rejectList(new Error('offline'))
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot()).toEqual({ entries: [], read: false })
    expect(report).not.toHaveBeenCalled()

    source.refresh()
    rejectList(new Error('still offline'))
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot().error).toBe('still offline')
    expect(report).toHaveBeenCalledOnce()
  })

  it('keeps a reset baseline while an older successful read finishes', async () => {
    const stale = Promise.withResolvers<DevWorkbenchSnapshot>()
    const current = Promise.withResolvers<DevWorkbenchSnapshot>()
    const pending = Promise.withResolvers<DevWorkbenchSnapshot>()
    const list = vi.fn(() => pending.promise).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
    const source = createDevWorkbenchInventory({ list, start: async () => row('running'), stop: async () => row('stopped') }, vi.fn())
    source.refresh()
    source.reset()
    source.refresh()
    stale.resolve({ entries: [row('failed')] })
    await Promise.resolve()
    await Promise.resolve()
    source.refresh()
    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual({ entries: [], read: false })
    const other = { ...row('idle'), id: 'other' as DevWorkbenchEntryId }
    current.resolve({ entries: [row('idle'), other] })
    await vi.waitFor(() => { expect(source.getSnapshot().read).toBe(true) })
    await source.start(ENTRY)
    expect(source.getSnapshot().entries).toEqual([row('running'), other])
  })

  it('isolates subscriber errors and keeps each repeated subscription independently removable', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const source = createDevWorkbenchInventory({ list: vi.fn(), start: vi.fn(), stop: vi.fn() }, vi.fn())
      const broken = source.subscribe(() => { throw new Error('render failure') })
      const listener = vi.fn()
      const first = source.subscribe(listener)
      const second = source.subscribe(listener)
      source.reset()
      expect(listener).toHaveBeenCalledTimes(2)
      expect(diagnostic).toHaveBeenCalledWith('[client-store] subscriber failed:', expect.any(Error))
      first()
      source.reset()
      expect(listener).toHaveBeenCalledTimes(3)
      second()
      broken()
      source.reset()
      expect(listener).toHaveBeenCalledTimes(3)
      expect(Object.isFrozen(source.getSnapshot().entries)).toBe(true)
    } finally { diagnostic.mockRestore() }
  })

  it('retains transport failures without requiring an Error instance', async () => {
    const source = createDevWorkbenchInventory({
      list: vi.fn().mockRejectedValue('offline'), start: vi.fn(), stop: vi.fn(),
    }, vi.fn())
    source.refresh()
    await vi.waitFor(() => { expect(source.getSnapshot().error).toBe('offline') })
  })
})
