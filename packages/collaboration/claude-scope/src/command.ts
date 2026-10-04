/** One-shot Claude Hook application plugin; the normal dsh profile owns startup and exit. */

import { isAbsolute } from 'node:path'
import { Readable, promises as streamPromises } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  callClaudeScopeHook, ClaudeScopeCommandFailure, readBoundedUtf8,
  type ClaudeScopeTransportConfig,
} from './transport.ts'

/** Loader name for the one-shot command application. */
export const name = 'claude-scope-command'

/** Complete stdin, transport, stdout, and operation limits, explicitly selected by the profile. */
export interface Config extends ClaudeScopeTransportConfig {
  /** Deadline from application readiness through completed stdout write. */
  timeoutMs: number
}

/** Configuration accepts no implicit deployment defaults. */
export const Config: z<Config> = z.object({
  descriptorPath: z.string().required(),
  maxRequestBytes: z.natural().min(1).required(),
  maxResponseBytes: z.natural().min(1).required(),
  timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
})

/**
 * Read one Hook JSON, call its authenticated Host, and write only the output before exiting.
 * EOF ends input collection; it does not end the application. Disposal aborts and awaits work.
 * @param ctx - dsh application context carrying appReady and appExit.
 * @param config - explicit local transport, byte, and duration limits.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.descriptorPath)) throw new Error('claude-scope command descriptorPath must be absolute')
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('claude-scope command requires the dsh application lifecycle')
  const lifetime = new AbortController()
  let task = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelInput = (): void => { process.stdin.destroy() }
  ctx.effect(() => async () => {
    lifetime.abort(new ClaudeScopeCommandFailure('cancelled'))
    clearTimeout(timer)
    await task
  }, 'claude-scope command: settle operation')
  ctx.effect(() => ready.onReady(() => {
    timer = setTimeout(() => { lifetime.abort(new ClaudeScopeCommandFailure('request-timeout')) }, config.timeoutMs)
    lifetime.signal.addEventListener('abort', cancelInput, { once: true })
    task = run().then(() => {
      if (!lifetime.signal.aborted) exit(0)
    }, (error: unknown) => {
      const failure = lifetime.signal.aborted ? lifetime.signal.reason as unknown : error
      const code = failure instanceof ClaudeScopeCommandFailure ? failure.code : 'transport-failed'
      if (code === 'cancelled') return
      process.stderr.write(`${JSON.stringify({ claudeScopeError: code })}\n`)
      exit(1)
    }).finally(() => {
      clearTimeout(timer)
      lifetime.signal.removeEventListener('abort', cancelInput)
    })
  }), 'claude-scope command: start after readiness')

  async function run(): Promise<void> {
    const raw = await readBoundedUtf8(process.stdin as AsyncIterable<Uint8Array>, config.maxRequestBytes, 'input-too-large', lifetime.signal)
    let input: unknown
    try { input = JSON.parse(raw) as unknown } catch { throw new ClaudeScopeCommandFailure('input-invalid') }
    const { output } = await callClaudeScopeHook(config, input, lifetime.signal)
    const serialized = `${JSON.stringify(output)}\n`
    if (Buffer.byteLength(serialized) > config.maxResponseBytes) throw new ClaudeScopeCommandFailure('output-too-large')
    lifetime.signal.throwIfAborted()
    await streamPromises.pipeline(Readable.from([serialized]), process.stdout, { signal: lifetime.signal, end: false })
  }
}
