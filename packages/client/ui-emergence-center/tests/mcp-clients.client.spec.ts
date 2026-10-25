import { describe, expect, it, vi } from 'vitest'
import type { McpClientSetupSnapshot, McpClientSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
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
