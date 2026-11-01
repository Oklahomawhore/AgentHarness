/** Bounded lossless transport encoding; decoded projections retain their original digest and durable representation. */

import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import { z } from 'zod'
import { readResponseSchema } from './state.ts'

type ReadResponse = ReturnType<typeof readResponseSchema.parse>

interface Limits {
  readonly maxResponseBytes: number
  readonly maxDecodedResponseBytes: number
}

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const envelopeSchema = z.object({ encoding: z.literal('gzip-base64'), data: z.string() }).strict()

function budgetError(error: unknown, representation: 'encoded' | 'decoded'): unknown {
  return error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE'
    ? new Error(`scope-access: ${representation} response exceeds budget`, { cause: error }) : error
}

/**
 * Encode a complete response without changing its projection or source accounting.
 * @param response - validated response whose authority is rechecked by the caller before sending.
 * @param limits - configured complete encoded and decoded JSON byte ceilings.
 * @returns the original response when it fits, otherwise a strictly bounded gzip envelope.
 * @throws when either complete representation exceeds its ceiling or compression fails.
 */
export async function encodeReadResponse(response: ReadResponse, limits: Limits): Promise<unknown> {
  const serialized = JSON.stringify(response)
  const length = Buffer.byteLength(serialized, 'utf8')
  if (length > limits.maxDecodedResponseBytes) throw new Error('scope-access: decoded response exceeds budget')
  if (length <= limits.maxResponseBytes) return response
  let compressed: Buffer
  try { compressed = await compress(serialized, { maxOutputLength: limits.maxResponseBytes }) } catch (error) {
    throw budgetError(error, 'encoded')
  }
  const envelope = { encoding: 'gzip-base64', data: compressed.toString('base64') }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > limits.maxResponseBytes) {
    throw new Error('scope-access: encoded response exceeds budget')
  }
  return envelope
}

/**
 * Validate complete wire bytes before bounded decompression and original response parsing.
 * @param raw - untrusted response received on the encoded-read protocol only.
 * @param limits - configured complete encoded and decoded JSON byte ceilings.
 * @returns the original validated response, including its exact projection digest and ordered coverage.
 * @throws for unsupported envelopes, malformed bytes, invalid projections, or either exceeded ceiling.
 */
export async function decodeReadResponse(raw: unknown, limits: Limits): Promise<ReadResponse> {
  const length = Buffer.byteLength(JSON.stringify(raw), 'utf8')
  if (length > limits.maxResponseBytes) throw new Error('scope-access: encoded response exceeds budget')
  if (typeof raw !== 'object' || raw === null || !('encoding' in raw)) {
    if (length > limits.maxDecodedResponseBytes) throw new Error('scope-access: decoded response exceeds budget')
    return readResponseSchema.parse(raw)
  }
  const envelope = envelopeSchema.parse(raw)
  const compressed = Buffer.from(envelope.data, 'base64')
  if (compressed.toString('base64') !== envelope.data) throw new Error('scope-access: noncanonical response base64')
  let decoded: Buffer
  try { decoded = await decompress(compressed, { maxOutputLength: limits.maxDecodedResponseBytes }) } catch (error) {
    throw budgetError(error, 'decoded')
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
  return readResponseSchema.parse(value)
}
