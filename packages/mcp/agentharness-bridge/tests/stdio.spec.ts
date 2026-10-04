/** Profile argument parsing must finish before descriptor authentication or stdio ownership. */

import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, Config } from '../src/stdio.ts'

const policy = {
  connectionPath: '/not-read-on-help/private.json', requestTimeoutMs: 1500,
  maxDescriptorBytes: 16384, maxRequestBytes: 32768, maxResponseBytes: 32768,
  leaseRetryMs: 2000, leaseFallbackTtlMs: 15000, leaseMinHeartbeatMs: 500, leaseMaxHeartbeatMs: 30000,
} satisfies Config

afterEach(() => { internals.stdout = process.stdout; internals.stderr = process.stderr })

async function invoke(args: readonly string[], config: Config = policy) {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const capture = { write: (chunk: string) => { output += chunk; return true } }
  internals.stdout = capture
  internals.stderr = capture
  provideCmdline(ctx, { args, exit: (code) => { exits.push(code) } })
  try { await apply(ctx, config) } finally { await ctx.fiber.dispose() }
  return { exits, output }
}

describe('mcp profile parsing', () => {
  it('prints help with no descriptor read or transport readiness dependency', async () => {
    const result = await invoke(['--help'])
    expect(result.exits).toEqual([0])
    expect(result.output).toContain('dsh --profile mcp')
    expect(result.output).toContain('--connection')
  })

  it.each([['--unknown'], ['--connection'], ['--connection', 'relative.json'], ['--url', 'http://10.0.0.1']])
  ('rejects invalid arguments before transport ownership: %j', async (...args) => {
    expect((await invoke(args)).exits).toEqual([1])
  })

  it('rejects invalid heartbeat ordering through the accepted command action', async () => {
    expect((await invoke([], { ...policy, leaseMinHeartbeatMs: 30001 })).exits).toEqual([1])
  })

  it('rejects timer overflow and missing complete-message limits at configuration parsing', () => {
    expect(() => Config({ ...policy, requestTimeoutMs: 2147483648 })).toThrow()
    const { maxRequestBytes: _limit, ...incomplete } = policy
    expect(() => Config(incomplete as Config)).toThrow()
  })
})
