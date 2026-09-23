#!/usr/bin/env node
/** Stdio entry for the AgentHarness MCP bridge. */

import { hostname, userInfo } from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createAgentHarnessBridge, AgentHarnessBridgePresenceLease } from './index.ts'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function identity(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 80) : `agent-${normalized || 'local'}`
}

const displayName = option('--display-name') ?? `${userInfo().username} (${hostname()})`
const options = {
  url: option('--url') ?? process.env.AGENTHARNESS_URL ?? 'http://127.0.0.1:3080',
  participantId: option('--participant-id') ?? identity(`mcp-${userInfo().username}-${hostname()}`),
  displayName,
}
const server = createAgentHarnessBridge(options)
const lease = new AgentHarnessBridgePresenceLease(options)
const transport = new StdioServerTransport()

await server.connect(transport)
await lease.start()

let shutdownTask: Promise<void> | undefined
const shutdown = (closeServer: boolean): Promise<void> => {
  shutdownTask ??= (async () => {
    await lease.dispose()
    if (closeServer) await server.close()
  })()
  return shutdownTask
}

const protocolClose = transport.onclose
transport.onclose = () => {
  protocolClose?.()
  void shutdown(false)
}

process.once('SIGTERM', () => {
  void shutdown(true).then(() => { process.exitCode = 0 })
})
process.once('SIGINT', () => {
  void shutdown(true).then(() => { process.exitCode = 130 })
})
