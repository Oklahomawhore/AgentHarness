import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import McpService, {
  McpError,
  type McpCallRequest,
  type McpServerId,
  type McpServerProvider,
} from '@deepseek-ai/dsh-mcp'

const signal = new AbortController().signal
const serverId = (value: string): McpServerId => value as McpServerId

async function runtime(maxServers = 2): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(McpService, { maxServers })
  return ctx
}

function provider(id: string): McpServerProvider & { call: ReturnType<typeof vi.fn> } {
  return {
    id: serverId(id),
    call: vi.fn(async (request: Omit<McpCallRequest, 'serverId'>) => ({
      content: [{ type: 'text', text: `${request.toolName}:${request.arguments.value as string}` }],
      structuredContent: { ok: true },
    })),
  }
}

describe('McpService', () => {
  it('routes raw calls and removes the exact live provider on disposal', async () => {
    const ctx = await runtime()
    const live = provider('gitee_ent')
    const dispose = ctx.mcp.registerServer(live)
    const disposeAlpha = ctx.mcp.registerServer(provider('alpha'))

    await expect(ctx.mcp.call({
      serverId: live.id,
      toolName: ' get_enterprise_issue_detail ',
      arguments: { value: 'IK9O1Y' },
    }, signal)).resolves.toEqual({
      content: [{ type: 'text', text: 'get_enterprise_issue_detail:IK9O1Y' }],
      structuredContent: { ok: true },
    })
    expect(live.call).toHaveBeenCalledWith({
      toolName: 'get_enterprise_issue_detail',
      arguments: { value: 'IK9O1Y' },
    }, signal)
    expect(ctx.mcp.listServers()).toEqual([{ id: serverId('alpha') }, { id: live.id }])

    dispose()
    expect(ctx.mcp.listServers()).toEqual([{ id: serverId('alpha') }])
    expect(() => ctx.mcp.call({ serverId: live.id, toolName: 'read', arguments: {} }, signal))
      .toThrow(McpError)
    disposeAlpha()
  })

  it('rejects duplicate, invalid, and over-limit registrations', async () => {
    const ctx = await runtime(1)
    ctx.mcp.registerServer(provider('first'))
    expect(() => ctx.mcp.registerServer(provider('first'))).toThrow('already registered')
    expect(() => ctx.mcp.registerServer(provider('second'))).toThrow('limit reached')

    const invalid = await runtime()
    expect(() => invalid.mcp.registerServer(provider('bad name'))).toThrow('must match')
    expect(() => new McpService(new Context(), { maxServers: 0 })).toThrow('positive safe integer')
    expect(() => new McpService(new Context(), { maxServers: 1.5 })).toThrow('positive safe integer')
  })

  it('rejects missing servers and blank tool names before provider dispatch', async () => {
    const ctx = await runtime()
    expect(() => ctx.mcp.call({ serverId: serverId('missing'), toolName: 'read', arguments: {} }, signal))
      .toThrow('not connected')
    const live = provider('live')
    ctx.mcp.registerServer(live)
    expect(() => ctx.mcp.call({ serverId: live.id, toolName: '  ', arguments: {} }, signal))
      .toThrow('must not be blank')
    expect(live.call).not.toHaveBeenCalled()
  })
})
