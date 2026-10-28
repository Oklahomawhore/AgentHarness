import { describe, expect, it, vi } from 'vitest'
import type { McpClientSetupResult, McpClientSetupSnapshot, McpClientSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { createMcpClientSetupDirectory } from '../src/client/mcp-clients.ts'

const CURSOR: McpClientSnapshot = {
  id: 'cursor',
  label: 'Cursor',
  detected: true,
  mechanism: 'json',
  state: 'not-configured',
  canSetup: true,
  participantId: 'agentharness-test-cursor',
  displayName: 'Test / Cursor',
  restartRequired: false,
}

describe('MCP client setup directory', () => {
  it('publishes detection and replaces exactly the configured client', async () => {
    const port = {
      list: vi.fn(async () => ({ clients: [CURSOR] })),
      setup: vi.fn(async () => ({
        outcome: 'configured' as const,
        client: { ...CURSOR, state: 'configured' as const, canSetup: false, restartRequired: true },
      })),
    }
    const directory = createMcpClientSetupDirectory(port, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })

    const result = await directory.setup({ clientId: 'cursor' })
    expect(result.outcome).toBe('configured')
    expect(directory.getSnapshot().clients).toEqual([expect.objectContaining({ id: 'cursor', state: 'configured' })])
  })

  it('retains an actionable error when the Host registry cannot be read', async () => {
    const onError = vi.fn()
    const directory = createMcpClientSetupDirectory({
      list: vi.fn(async () => { throw new Error('unavailable') }),
      setup: vi.fn(),
    }, onError)

    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    expect(directory.getSnapshot().error).toBe('unavailable')
    expect(onError).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'])('discards an old connection %s while the reset read remains in flight', async (outcome) => {
    const stale = Promise.withResolvers<McpClientSetupSnapshot>()
    const current = Promise.withResolvers<McpClientSetupSnapshot>()
    const list = vi.fn(() => current.promise).mockReturnValueOnce(stale.promise)
    const report = vi.fn()
    const directory = createMcpClientSetupDirectory({ list, setup: vi.fn() }, report)
    directory.refresh()
    expect(list).toHaveBeenCalledOnce()
    directory.reset()
    if (outcome === 'success') stale.resolve({ clients: [CURSOR] })
    else stale.reject(new Error('old connection'))
    await Promise.resolve()
    await Promise.resolve()
    directory.refresh()
    expect(list).toHaveBeenCalledTimes(2)
    expect(directory.getSnapshot()).toEqual({ clients: [], read: false })
    expect(report).not.toHaveBeenCalled()
    current.resolve({ clients: [] })
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
  })

  it.each(['pending', 'ready'])('returns a sent setup result without replacing the %s reset registry', async (phase) => {
    const sent = Promise.withResolvers<McpClientSetupResult>()
    const current = Promise.withResolvers<McpClientSetupSnapshot>()
    const result: McpClientSetupResult = {
      outcome: 'configured', client: { ...CURSOR, state: 'configured', restartRequired: true },
    }
    const list = vi.fn<() => Promise<McpClientSetupSnapshot>>(() => current.promise)
      .mockResolvedValueOnce({ clients: [CURSOR] })
    const setup = vi.fn(() => sent.promise)
    const directory = createMcpClientSetupDirectory({ list, setup }, vi.fn())
    const next: McpClientSetupSnapshot = { clients: [{ ...CURSOR, id: 'claude-code' }] }
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const operation = directory.setup({ clientId: CURSOR.id })
    try {
      expect(setup).toHaveBeenCalledExactlyOnceWith({ clientId: CURSOR.id })
      directory.reset()
      expect(list).toHaveBeenCalledTimes(2)
      if (phase === 'ready') {
        current.resolve(next)
        await vi.waitFor(() => { expect(directory.getSnapshot()).toEqual({ ...next, read: true }) })
      }
      const reset = directory.getSnapshot()
      sent.resolve(result)
      await expect(operation).resolves.toBe(result)
      expect(directory.getSnapshot()).toBe(reset)
      if (phase === 'pending') {
        expect(reset).toEqual({ clients: [], read: false })
        current.resolve(next)
        await vi.waitFor(() => { expect(directory.getSnapshot()).toEqual({ ...next, read: true }) })
      }
    } finally {
      current.resolve(next)
      sent.resolve(result)
      await operation
    }
  })

  it.each(['success', 'failure'])('preserves setup across an older same-connection list %s and releases the read', async (outcome) => {
    const stale = Promise.withResolvers<McpClientSetupSnapshot>()
    const current = Promise.withResolvers<McpClientSetupSnapshot>()
    const sent = Promise.withResolvers<McpClientSetupResult>()
    const result: McpClientSetupResult = {
      outcome: 'configured', client: { ...CURSOR, state: 'configured', canSetup: false, restartRequired: true },
    }
    const next: McpClientSetupSnapshot = { clients: [result.client] }
    const list = vi.fn<() => Promise<McpClientSetupSnapshot>>(() => current.promise)
      .mockResolvedValueOnce({ clients: [CURSOR] }).mockReturnValueOnce(stale.promise)
    const report = vi.fn()
    const directory = createMcpClientSetupDirectory({ list, setup: () => sent.promise }, report)
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    await vi.waitFor(() => { directory.refresh(); expect(list).toHaveBeenCalledTimes(2) })
    const operation = directory.setup({ clientId: CURSOR.id })
    try {
      sent.resolve(result)
      await expect(operation).resolves.toBe(result)
      const configured = directory.getSnapshot()
      expect(configured.clients).toEqual(next.clients)
      if (outcome === 'success') stale.resolve({ clients: [CURSOR] })
      else stale.reject(new Error('Earlier inspection failed'))
      await vi.waitFor(() => { directory.refresh(); expect(list).toHaveBeenCalledTimes(3) })
      expect(directory.getSnapshot()).toBe(configured)
      expect(report).not.toHaveBeenCalled()
      current.resolve(next)
      await vi.waitFor(() => { expect(directory.getSnapshot().clients).toBe(next.clients) })
    } finally {
      sent.resolve(result)
      stale.resolve({ clients: [CURSOR] })
      current.resolve(next)
      await operation
      await vi.waitFor(() => {
        if (list.mock.calls.length < 3) directory.refresh()
        expect(list.mock.calls.length).toBeGreaterThanOrEqual(3)
      })
      await vi.waitFor(() => { expect(directory.getSnapshot().clients).toBe(next.clients) })
    }
  })

  it('publishes both concurrent setup results in the same connection', async () => {
    const first = Promise.withResolvers<McpClientSetupResult>()
    const second = Promise.withResolvers<McpClientSetupResult>()
    const other: McpClientSnapshot = { ...CURSOR, id: 'claude-code' }
    const cursor: McpClientSetupResult = { outcome: 'configured', client: { ...CURSOR, state: 'configured', canSetup: false } }
    const claude: McpClientSetupResult = { outcome: 'configured', client: { ...other, state: 'configured', canSetup: false } }
    const setup = vi.fn<() => Promise<McpClientSetupResult>>(() => second.promise).mockReturnValueOnce(first.promise)
    const directory = createMcpClientSetupDirectory({ list: async () => ({ clients: [CURSOR, other] }), setup }, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    const cursorOperation = directory.setup({ clientId: CURSOR.id })
    const claudeOperation = directory.setup({ clientId: other.id })
    try {
      expect(setup).toHaveBeenCalledTimes(2)
      first.resolve(cursor)
      await expect(cursorOperation).resolves.toBe(cursor)
      expect(directory.getSnapshot().clients).toEqual([cursor.client, other])
      second.resolve(claude)
      await expect(claudeOperation).resolves.toBe(claude)
      expect(directory.getSnapshot().clients).toEqual([cursor.client, claude.client])
    } finally {
      first.resolve(cursor)
      second.resolve(claude)
      await Promise.all([cursorOperation, claudeOperation])
    }
  })

  it('adds a newly configured client and preserves other clients when replacing it', async () => {
    const other: McpClientSnapshot = { ...CURSOR, id: 'claude-code' }
    const configured = { ...CURSOR, state: 'configured' as const }
    const directory = createMcpClientSetupDirectory({
      list: async () => ({ clients: [other] }),
      setup: async () => ({ outcome: 'configured', client: configured }),
    }, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().read).toBe(true) })
    await directory.setup({ clientId: 'cursor' })
    await directory.setup({ clientId: 'cursor' })
    expect(directory.getSnapshot().clients).toEqual([other, configured])
    expect(Object.isFrozen(directory.getSnapshot().clients[0])).toBe(true)
  })

  it('retains a non-Error transport failure for a current read', async () => {
    const directory = createMcpClientSetupDirectory({ list: vi.fn().mockRejectedValue('offline'), setup: vi.fn() }, vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().error).toBe('offline') })
  })
})
