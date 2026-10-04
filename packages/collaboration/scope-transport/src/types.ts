/** Provider-neutral authenticated request stream types. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Public peer identifier derived from the persistent device key. */
export type ScopePeerId = Branded<'ScopePeerId'>

/** Public identity and currently bound direct addresses; never credential material. */
export interface ScopeTransportIdentity {
  readonly peerId: ScopePeerId
  readonly addresses: readonly string[]
}

/** Explicit destination whose address must identify the same authenticated peer. */
export interface ScopeTransportTarget {
  readonly peerId: ScopePeerId
  readonly address: string
}

/** One decoded request; peerId comes from the encrypted connection, never the payload. */
export interface ScopeTransportRequest {
  readonly peerId: ScopePeerId
  readonly payload: unknown
  readonly signal: AbortSignal
}

/**
 * Authorize and process a request. Payloads and results must be lossless JSON values.
 * Implementations must settle after signal cancellation; transport disposal awaits them.
 * @param request - authenticated sender, untrusted payload, and stream lifetime.
 * @returns protocol-owned JSON; thrown errors become a fixed remote-failed response without their text.
 */
export type ScopeTransportHandler = (request: ScopeTransportRequest) => Promise<unknown>

/** Local deployment limits; these values do not describe or reserve a remote peer's capacity. */
export interface ScopeTransportLimits {
  /** Maximum admitted inbound requests across all local protocols. */
  readonly maxInboundRequests: number
  /** Maximum local outbound requests, including dialing. */
  readonly maxOutboundRequests: number
  /** Complete local request or handler deadline in milliseconds. */
  readonly requestTimeoutMs: number
}
