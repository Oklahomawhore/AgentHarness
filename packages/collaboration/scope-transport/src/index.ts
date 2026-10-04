/** Service Definition for authenticated, bounded request streams between explicitly addressed peers. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ScopeTransportHandler, ScopeTransportIdentity, ScopeTransportLimits, ScopeTransportTarget } from './types.ts'

export type * from './types.ts'
export { ScopeTransportError, type ScopeTransportErrorCode } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated transport; application handlers own scope authorization. */
    scopeTransport: ScopeTransport
  }
}

/** Transport supplies authenticated identity and cancellation, not application read or write grants. */
export default abstract class ScopeTransport extends Service {
  constructor(ctx: Context) { super(ctx, 'scopeTransport') }

  /**
   * Wait for startup and read public connection information.
   * @returns persistent peer identity and direct addresses; rejects after disposal or failed startup.
   */
  abstract identity(): Promise<ScopeTransportIdentity>

  /**
   * Read the local provider's concurrency and request deadline configuration.
   * @returns local limits so consumers can reserve capacity for ordinary requests; no remote capacity claim.
   */
  abstract limits(): ScopeTransportLimits

  /**
   * Register one versioned protocol. The consumer must own the returned disposer with ctx.effect.
   * @param protocol - unique negotiated protocol name.
   * @param handler - authorizes each authenticated sender; must settle when its signal aborts.
   * @returns idempotent disposer that rejects new requests and cancels this registration's admitted work.
   */
  abstract register(protocol: string, handler: ScopeTransportHandler): () => void

  /**
   * Send one bounded JSON request over a fresh stream; transport errors never expose remote handler text.
   * @param target - explicit address containing the expected authenticated peer identity.
   * @param protocol - remote negotiated protocol name.
   * @param payload - lossless JSON value, copied before the first await.
   * @param signal - cancellation for dialing, exchange, and response admission.
   * @returns decoded protocol-owned JSON; rejects on cancellation, timeout, size, connection, or remote failure.
   */
  abstract request(target: ScopeTransportTarget, protocol: string, payload: unknown, signal: AbortSignal): Promise<unknown>
}
