/** Authenticated loopback transport for Claude command hooks. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  authenticateLocalConnection, LocalConnectionAccessError, publishLocalConnectionDescriptor,
} from '@deepseek-ai/dsh-client-connection/local-access'
import type { LocalConnectionAccess } from '@deepseek-ai/dsh-client-connection/local-access'
import type { ClaudeScopeHookResult } from './types.ts'

/** Host-owned location of the private local connection capability. */
export interface ClaudeScopeDescriptorConfig {
  /** Absolute file path in an owner-only directory; one live Host holds its kernel lease. */
  descriptorPath: string
}

/** Command-side limits on complete serialized files and RPC messages. */
export interface ClaudeScopeTransportConfig extends ClaudeScopeDescriptorConfig {
  /** Maximum descriptor, stdin, and serialized Typert request size in UTF-8 bytes. */
  maxRequestBytes: number
  /** Maximum complete Typert response envelope size in UTF-8 bytes. */
  maxResponseBytes: number
}

/** Stable diagnostic categories; messages never contain the local capability. */
export type ClaudeScopeCommandFailureCode =
  | 'input-invalid' | 'input-too-large' | 'descriptor-unavailable' | 'descriptor-invalid'
  | 'descriptor-too-large' | 'authentication-failed' | 'request-too-large' | 'platform-unsupported'
  | 'rpc-transport-rejected' | 'response-too-large' | 'rpc-rejected'
  | 'rpc-response-invalid' | 'output-too-large' | 'request-timeout' | 'cancelled' | 'transport-failed'

/** A classified command failure safe to write to stderr. */
export class ClaudeScopeCommandFailure extends Error {
  constructor(readonly code: ClaudeScopeCommandFailureCode) {
    super(code)
    this.name = 'ClaudeScopeCommandFailure'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string, code: ClaudeScopeCommandFailureCode): unknown {
  try { return JSON.parse(text) as unknown } catch { throw new ClaudeScopeCommandFailure(code) }
}

/**
 * Decode one bounded UTF-8 stream without truncating multibyte characters.
 * @param chunks - byte chunks supplied by a file, process, or response stream.
 * @param maxBytes - complete byte limit, including JSON syntax.
 * @param oversized - diagnostic for a value exceeding the limit.
 * @param signal - operation cancellation checked between chunks.
 * @returns the complete decoded text; invalid UTF-8 is rejected.
 */
export async function readBoundedUtf8(
  chunks: AsyncIterable<Uint8Array>, maxBytes: number, oversized: ClaudeScopeCommandFailureCode, signal: AbortSignal,
): Promise<string> {
  const retained: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of chunks) {
    signal.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new ClaudeScopeCommandFailure(oversized)
    retained.push(chunk)
  }
  signal.throwIfAborted()
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(retained, bytes))
}

/**
 * Publish the Host capability through Connection and remove it with this plugin.
 * @param ctx - Host Connection, WebServer, and dsh launcher lifecycle context.
 * @param config - leased descriptor path in an owner-only directory.
 * @returns the generation every Claude Remote Hook must match.
 */
export function createClaudeScopeDescriptor(ctx: Context, config: ClaudeScopeDescriptorConfig): { readonly generation: string } {
  return publishLocalConnectionDescriptor(ctx, config, 'claude-scope')
}

function parseResponse(value: unknown, rpcId: string): ClaudeScopeHookResult {
  if (!record(value) || value.type !== 'server-response' || value.rpcId !== rpcId || !record(value.result)) {
    throw new ClaudeScopeCommandFailure('rpc-response-invalid')
  }
  if (value.result.ok !== true) throw new ClaudeScopeCommandFailure('rpc-rejected')
  const response = value.result.value
  if (!record(response) || !record(response.output) || !record(response.receipt)
    || typeof response.receipt.status !== 'string'
    || !['observed', 'left', 'leased', 'published', 'reused', 'projected', 'withdrawn', 'omitted'].includes(response.receipt.status)
    || (response.receipt.reason !== undefined && typeof response.receipt.reason !== 'string')
    || (response.receipt.projectionId !== undefined && typeof response.receipt.projectionId !== 'string')) {
    throw new ClaudeScopeCommandFailure('rpc-response-invalid')
  }
  const output = response.output
  const specific = output.hookSpecificOutput
  if (Object.keys(output).some(key => key !== 'hookSpecificOutput')
    || (specific !== undefined && (!record(specific)
      || typeof specific.hookEventName !== 'string'
      || !['UserPromptSubmit', 'PostToolBatch'].includes(specific.hookEventName)
      || typeof specific.additionalContext !== 'string'
      || Object.keys(specific).some(key => key !== 'hookEventName' && key !== 'additionalContext')))) {
    throw new ClaudeScopeCommandFailure('rpc-response-invalid')
  }
  return { output, receipt: response.receipt as unknown as ClaudeScopeHookResult['receipt'] }
}

/**
 * Exchange the private launch token for a Connection cookie and invoke the fixed scope Remote.
 * @param config - local descriptor and complete-message byte limits.
 * @param input - parsed external Hook input, validated by the Host adapter.
 * @param signal - cancellation shared by file read, login, and RPC.
 * @returns the validated Hook output and Host receipt; receipt is never model context.
 */
export async function callClaudeScopeHook(
  config: ClaudeScopeTransportConfig, input: unknown, signal: AbortSignal,
): Promise<ClaudeScopeHookResult> {
  let connection: LocalConnectionAccess
  try {
    connection = await authenticateLocalConnection({
      descriptorPath: config.descriptorPath, maxDescriptorBytes: config.maxRequestBytes,
    }, signal)
  } catch (error) {
    if (error instanceof LocalConnectionAccessError) throw new ClaudeScopeCommandFailure(error.code)
    throw error
  }
  const rpcId = randomUUID()
  const method = 'claudeScope/hook'
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request: { generation: connection.generation, input } } } })
  if (Buffer.byteLength(body) > config.maxRequestBytes) throw new ClaudeScopeCommandFailure('request-too-large')
  const response = await fetch(`${connection.origin}/api/${method}`, {
    method: 'POST', redirect: 'manual', signal,
    headers: { 'content-type': 'application/json', cookie: connection.cookie }, body,
  })
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel()
    throw new ClaudeScopeCommandFailure('rpc-transport-rejected')
  }
  const text = await readBoundedUtf8(response.body, config.maxResponseBytes, 'response-too-large', signal)
  const result = parseResponse(parseJson(text, 'rpc-response-invalid'), rpcId)
  if (result.output.hookSpecificOutput !== undefined
    && (!record(input) || result.output.hookSpecificOutput.hookEventName !== input.hook_event_name)) {
    throw new ClaudeScopeCommandFailure('rpc-response-invalid')
  }
  return result
}
