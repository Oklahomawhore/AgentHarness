import { describe, expect, it, vi } from 'vitest'
import type { McpClientSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
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
})
