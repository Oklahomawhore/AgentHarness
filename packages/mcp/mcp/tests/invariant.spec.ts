import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import McpService, { type McpServerId } from '@deepseek-ai/dsh-mcp'
import * as McpInvariant from '@deepseek-ai/dsh-mcp/invariant'
import { describe, expect, it } from 'vitest'

describe('MCP registry lifecycle invariant', () => {
  it.each(['registered', 'unregistered'] as const)('rejects a contradictory %s notification only while its companion is mounted', async (state) => {
    const ctx = new Context()
    try {
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await ctx.plugin(McpService, { maxServers: 1 })
      const companion = ctx.plugin(McpInvariant)
      await companion
      const id = 'live_transport' as McpServerId
      const observations: { state: string; members: readonly McpServerId[] }[] = []
      ctx.on('mcp/server-changed', (_server, next) => {
        observations.push({ state: next, members: ctx.mcp.listServers().map(server => server.id) })
      })
      const dispose = ctx.mcp.registerServer({ id, async call() { return { content: [] } } })
      expect(observations).toEqual([{ state: 'registered', members: [id] }])
      await expect(ctx.mcp.call({ serverId: id, toolName: 'read', arguments: {} }, new AbortController().signal))
        .resolves.toEqual({ content: [] })
      if (state === 'registered') {
        dispose()
        expect(observations).toEqual([{ state: 'registered', members: [id] }, { state: 'unregistered', members: [] }])
      }
      expect(() => { ctx.emit('mcp/server-changed', { id }, state) })
        .toThrow(`server event reports "${id}" as ${state} but registry membership disagrees`)
      await companion.dispose()
      expect(() => { ctx.emit('mcp/server-changed', { id }, state) }).not.toThrow()
      dispose()
      expect(ctx.mcp.listServers()).toEqual([])
      expect(observations).toContainEqual({ state: 'unregistered', members: [] })
    } finally { await ctx.fiber.dispose() }
  })
})
