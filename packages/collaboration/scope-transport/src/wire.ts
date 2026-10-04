/** One complete bounded JSON envelope per libp2p stream direction. */
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { Libp2p } from 'libp2p'
import { ScopeTransportError, type ScopeTransportErrorCode } from '@deepseek-ai/dsh-scope-transport'

/** Stream type of the pinned libp2p provider. */
export type RpcStream = Awaited<ReturnType<Libp2p['dialProtocol']>>

type FailureCode = 'remote-failed' | 'invalid-json' | 'request-too-large' | 'response-too-large'
/** Transport-owned response envelope, separate from protocol-owned result fields. */
export type ResponseEnvelope = { version: 1; ok: true; payload: unknown } | { version: 1; ok: false; code: FailureCode }

/** Smallest request size admitting a complete JSON null payload. */
export const minimumRequestBytes = Buffer.byteLength(JSON.stringify({ version: 1, payload: null }))
/** A complete failure envelope must fit even when a handler result does not. */
export const minimumResponseBytes = Buffer.byteLength(JSON.stringify({ version: 1, ok: false, code: 'response-too-large' }))

/**
 * Snapshot and serialize a lossless JSON envelope before an asynchronous operation starts.
 * @param value - complete envelope to validate and copy.
 * @param limit - maximum complete UTF-8 byte length.
 * @param oversized - classified size failure.
 * @returns encoded bytes, never a truncated JSON value.
 */
export function encode(value: unknown, limit: number, oversized: ScopeTransportErrorCode): Uint8Array {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new ScopeTransportError('scope-transport/invalid-json')
  const bytes = Buffer.from(JSON.stringify(snapshot))
  if (bytes.byteLength > limit) throw new ScopeTransportError(oversized)
  return bytes
}

/**
 * Read exactly one JSON value through EOF, rejecting excess bytes and malformed UTF-8.
 * @param stream - stream whose abort is linked to signal by its owner.
 * @param limit - complete inbound UTF-8 envelope budget.
 * @param oversized - classified size failure.
 * @param signal - request lifetime.
 * @returns parsed lossless JSON value.
 */
export async function readJson(
  stream: RpcStream, limit: number, oversized: ScopeTransportErrorCode, signal: AbortSignal,
): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of stream) {
    signal.throwIfAborted()
    length += chunk.byteLength
    if (length > limit) throw new ScopeTransportError(oversized)
    chunks.push(chunk.subarray())
  }
  signal.throwIfAborted()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown } catch {
    throw new ScopeTransportError('scope-transport/invalid-json')
  }
  if (snapshotJsonValue(value) === undefined) throw new ScopeTransportError('scope-transport/invalid-json')
  return value
}

/**
 * Flush one envelope and half-close the writable side, preserving the response/read direction.
 * @param stream - writable request or response stream.
 * @param bytes - already bounded serialized envelope.
 * @param signal - request lifetime.
 */
export async function writeJson(stream: RpcStream, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!stream.send(bytes)) await stream.onDrain({ signal })
  await stream.close({ signal })
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode the complete request envelope, excluding caller-asserted identity fields.
 * @param value - untrusted parsed JSON.
 * @returns protocol-owned payload.
 */
export function requestPayload(value: unknown): unknown {
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'payload')) {
    throw new ScopeTransportError('scope-transport/invalid-json')
  }
  return value.payload
}

/**
 * Decode one response or throw its fixed transport failure.
 * @param value - untrusted parsed JSON.
 * @returns protocol-owned response payload.
 */
export function responsePayload(value: unknown): unknown {
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 3) throw new ScopeTransportError('scope-transport/invalid-json')
  if (value.ok === true && Object.hasOwn(value, 'payload')) return value.payload
  if (value.ok === false && typeof value.code === 'string'
    && ['remote-failed', 'invalid-json', 'request-too-large', 'response-too-large'].includes(value.code)) {
    throw new ScopeTransportError(`scope-transport/${value.code}` as ScopeTransportErrorCode)
  }
  throw new ScopeTransportError('scope-transport/invalid-json')
}

/**
 * Construct a fixed failure response without exposing handler exceptions.
 * @param error - local parser, budget, or callback failure.
 * @returns bounded transport-owned failure fields.
 */
export function failureEnvelope(error: unknown): ResponseEnvelope {
  const code = error instanceof ScopeTransportError && [
    'scope-transport/invalid-json', 'scope-transport/request-too-large', 'scope-transport/response-too-large',
  ].includes(error.code) ? error.code.slice('scope-transport/'.length) as FailureCode : 'remote-failed'
  return { version: 1, ok: false, code }
}
