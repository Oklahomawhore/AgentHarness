/** Standalone MCP stdio Consumer; dsh owns process startup, signals, and bounded exit. */

import { hostname, userInfo } from 'node:os'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Command } from 'commander'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createAgentHarnessBridge } from './index.ts'
import { AgentHarnessBridgePresenceLease } from './presence.ts'
import { bridgeOrigin } from './rpc.ts'

/** Cordis Consumer name for the mcp application. */
export const name = 'agentharness-bridge-stdio'

/** Only the launcher supplies application arguments. */
export const inject = ['cmdlineArgs']

/** Complete deployment policy; CLI fields override identity and connection selection only. */
export interface Config {
  /** Absolute private Host connection descriptor path. */
  connectionPath: string
  /** Optional loopback origin pin, never an alternative to authentication. */
  url?: string
  /** Stable local participant name; omission resolves once from the OS user and hostname. */
  participantId?: string
  /** Display name; omission resolves once from the OS user and hostname. */
  displayName?: string
  /** Milliseconds for complete descriptor authentication and each RPC. */
  requestTimeoutMs: number
  /** Maximum descriptor bytes. */
  maxDescriptorBytes: number
  /** Maximum complete outgoing RPC JSON bytes. */
  maxRequestBytes: number
  /** Maximum complete incoming RPC JSON bytes. */
  maxResponseBytes: number
  /** Milliseconds between failed presence attempts. */
  leaseRetryMs: number
  /** Milliseconds used when the Host omits a valid TTL. */
  leaseFallbackTtlMs: number
  /** Minimum renewal interval in milliseconds. */
  leaseMinHeartbeatMs: number
  /** Maximum renewal interval in milliseconds. */
  leaseMaxHeartbeatMs: number
}

/** Shipped defaults live in the bundle patch; the Consumer requires explicit limits. */
export const Config: s<Config> = s.object({
  connectionPath: s.string().required(),
  url: s.string(), participantId: s.string(), displayName: s.string(),
  requestTimeoutMs: s.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  maxDescriptorBytes: s.natural().min(1).required(),
  maxRequestBytes: s.natural().min(1).required(),
  maxResponseBytes: s.natural().min(1).required(),
  leaseRetryMs: s.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  leaseFallbackTtlMs: s.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  leaseMinHeartbeatMs: s.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  leaseMaxHeartbeatMs: s.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
})

interface Options { connection?: string; url?: string; participantId?: string; displayName?: string }
interface Resolved extends Config { participantId: string; displayName: string }

function resolve(config: Readonly<Config>, options: Options): Resolved {
  const connectionPath = options.connection ?? config.connectionPath
  if (!isAbsolute(connectionPath)) throw new Error('MCP connection path must be absolute')
  if (config.leaseMinHeartbeatMs > config.leaseMaxHeartbeatMs) {
    throw new Error('MCP minimum heartbeat must not exceed its maximum')
  }
  const localIdentity = `${userInfo().username}-${hostname()}`
  const normalized = `mcp-${localIdentity}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/g, '').slice(0, 80)
  const participantId = options.participantId ?? config.participantId ?? normalized
  const displayName = options.displayName ?? config.displayName ?? `${userInfo().username} (${hostname()})`
  if (participantId.trim() === '' || displayName.trim() === '') throw new Error('MCP identity must not be empty')
  const url = options.url ?? config.url
  return {
    ...config, connectionPath, participantId, displayName,
    ...(url === undefined ? {} : { url: bridgeOrigin(url) }),
  }
}

/**
 * Parse the profile invocation and own exactly one stdio transport and presence lease.
 * @param ctx - launcher-provided command line, readiness, and bounded exit services.
 * @param config - explicit connection, identity, timing, and byte policy.
 * @returns after the protocol transport connects; presence begins after application readiness.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let selected: Resolved | undefined
  const program = new Command().name('dsh --profile mcp')
    .description('Serve the authenticated local AgentHarness MCP bridge over stdio.')
    .option('--connection <path>', 'absolute private Host connection descriptor')
    .option('--url <origin>', 'require the descriptor to authenticate this loopback origin')
    .option('--participant-id <id>', 'local participant identity')
    .option('--display-name <name>', 'local participant display name')
    .action((options: Options) => {
      try { selected = resolve(config, options) } catch {
        program.error('invalid MCP connection, identity, or lease configuration')
      }
    })
  parseCmdline(ctx, program)
  if (selected === undefined) return
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('MCP stdio requires the dsh application lifecycle')
  exitOnStdinEnd(ctx, 'mcp.stdin')
  const lifetime = new AbortController()
  const server = createAgentHarnessBridge({ ...selected, signal: lifetime.signal })
  const lease = new AgentHarnessBridgePresenceLease({
    ...selected, retryMs: selected.leaseRetryMs, fallbackTtlMs: selected.leaseFallbackTtlMs,
    minHeartbeatMs: selected.leaseMinHeartbeatMs, maxHeartbeatMs: selected.leaseMaxHeartbeatMs,
  })
  const transport = new StdioServerTransport()
  let opening: Promise<void> = Promise.resolve()
  let cancelClosed = (): void => {}
  ctx.effect(() => async () => {
    lifetime.abort()
    cancelClosed()
    try { await opening } catch {
      // connect failure is reported by Loader; disposal still closes partially acquired resources.
    }
    const results = await Promise.allSettled([server.close(), lease.dispose()])
    if (results.some(result => result.status === 'rejected')) throw new Error('MCP stdio cleanup failed')
  }, 'mcp: settle stdio and presence')
  opening = server.connect(transport)
  await opening
  if (lifetime.signal.aborted) return
  const protocolClose = transport.onclose
  transport.onclose = () => {
    protocolClose?.()
    if (!lifetime.signal.aborted) cancelClosed = ready.onReady(() => { exit(0) })
  }
  ctx.effect(() => ready.onReady(() => {
    if (!lifetime.signal.aborted) void lease.start()
  }), 'mcp: start presence after readiness')
}
