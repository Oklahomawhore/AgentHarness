/** Bounded reads of explicitly granted OpenAPI declarations, without reference resolution. */

import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type {
  DevelopmentTaskOpenApiFacts,
  DevelopmentTaskOpenApiObservationResult,
} from '@deepseek-ai/dsh-development-task/types'
import type { ClaudeScopeOpenApiSource } from './types.ts'

type Sample = Exclude<DevelopmentTaskOpenApiObservationResult, { readonly state: 'revoked' }>
type Unavailable = Extract<Sample, { readonly state: 'unavailable' }>
type InvalidReason = Extract<Sample, { readonly state: 'invalid' }>['reason']
type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

function unavailable(reason: Unavailable['reason']): Unavailable { return { state: 'unavailable', reason } }

/**
 * Resolve explicit file-read grants independently from tool-field collection permission.
 * @param sources - exact local files and operation selectors authorized by the caller.
 * @param canonicalRoots - already resolved collection roots; every file must be a descendant.
 * @param signal - cancellation checked after each filesystem operation.
 * @returns normalized grants to existing regular files; throws for ambiguous or inaccessible grants.
 */
export async function resolveOpenApiSources(
  sources: readonly ClaudeScopeOpenApiSource[], canonicalRoots: readonly string[], signal: AbortSignal,
): Promise<readonly ClaudeScopeOpenApiSource[]> {
  const resolved: ClaudeScopeOpenApiSource[] = []
  const names = new Set<string>()
  const targets = new Set<string>()
  for (const source of sources) {
    signal.throwIfAborted()
    const name = source.name.trim()
    if (name === '' || !isAbsolute(source.filePath) || !/^\/[^?#]*$/u.test(source.path)) {
      throw new Error('claude-scope: OpenAPI grants require a name, absolute file, and operation path')
    }
    let path: string
    let info: BigIntStats
    try {
      path = await realpath(source.filePath)
      signal.throwIfAborted()
      info = await lstat(path, { bigint: true })
    } catch {
      signal.throwIfAborted()
      throw new Error('claude-scope: OpenAPI grant file is inaccessible')
    }
    signal.throwIfAborted()
    if (!info.isFile() || !canonicalRoots.some(root => within(root, path))) {
      throw new Error('claude-scope: OpenAPI grant requires a regular file inside the allowed roots')
    }
    const logical = JSON.stringify([name, source.method, source.path])
    const target = JSON.stringify([path, source.method, source.path])
    if (names.has(logical) || targets.has(target)) throw new Error('claude-scope: duplicate OpenAPI operation grant')
    names.add(logical)
    targets.add(target)
    resolved.push({ name, filePath: path, method: source.method, path: source.path })
  }
  signal.throwIfAborted()
  return resolved
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function readSample(source: ClaudeScopeOpenApiSource, maxBytes: number, signal: AbortSignal): Promise<Buffer | Unavailable> {
  signal.throwIfAborted()
  if (await realpath(source.filePath) !== source.filePath) return unavailable('changed-during-read')
  signal.throwIfAborted()
  const pathBefore = await lstat(source.filePath, { bigint: true })
  signal.throwIfAborted()
  if (!pathBefore.isFile()) return unavailable('not-readable')
  if (pathBefore.size > BigInt(maxBytes)) return unavailable('too-large')
  // NONBLOCK prevents a raced FIFO replacement from hanging before fstat rejects it.
  const file = await open(source.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    signal.throwIfAborted()
    const before = await file.stat({ bigint: true })
    signal.throwIfAborted()
    if (!sameFile(pathBefore, before)) return unavailable('changed-during-read')
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      signal.throwIfAborted()
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > maxBytes) return unavailable('too-large')
    const after = await file.stat({ bigint: true })
    signal.throwIfAborted()
    const pathAfter = await lstat(source.filePath, { bigint: true })
    signal.throwIfAborted()
    const canonicalAfter = await realpath(source.filePath)
    signal.throwIfAborted()
    if (canonicalAfter !== source.filePath || !sameFile(before, after) || !sameFile(after, pathAfter)
      || BigInt(length) !== after.size) return unavailable('changed-during-read')
    return bytes.subarray(0, length)
  } finally {
    await file.close()
  }
}

function optionalBoolean(value: JsonObject, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean'
}

function allowedKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key) || key.startsWith('x-'))
}

function annotations(value: JsonObject): boolean {
  return (value.title === undefined || typeof value.title === 'string')
    && (value.description === undefined || typeof value.description === 'string')
}

function requiredFields(schema: unknown): readonly string[] | undefined {
  if (!object(schema) || schema.type !== 'object' || !annotations(schema)
    || !allowedKeys(schema, ['type', 'required', 'properties', 'title', 'description'])) return undefined
  if (schema.properties !== undefined) {
    if (!object(schema.properties)) return undefined
    for (const property of Object.values(schema.properties)) {
      if (!object(property) || !annotations(property) || typeof property.type !== 'string'
        || !['string', 'boolean', 'integer', 'number'].includes(property.type)
        || !allowedKeys(property, ['type', 'title', 'description'])) return undefined
    }
  }
  if (schema.required === undefined) return []
  if (!Array.isArray(schema.required) || !schema.required.every((field: unknown): field is string => typeof field === 'string')
    || new Set(schema.required).size !== schema.required.length) return undefined
  return [...schema.required].sort()
}

function declarations(value: unknown, source: ClaudeScopeOpenApiSource): DevelopmentTaskOpenApiFacts | InvalidReason {
  if (!object(value) || typeof value.openapi !== 'string' || !/^3\.1\.\d+$/u.test(value.openapi)
    || !object(value.info) || typeof value.info.title !== 'string' || typeof value.info.version !== 'string'
    || !object(value.paths) || value.jsonSchemaDialect !== undefined) return 'unsupported-document'
  const item = value.paths[source.path]
  if (item === undefined) return 'operation-missing'
  if (!object(item) || item.$ref !== undefined) return 'unsupported-operation'
  const operation = item[source.method]
  if (operation === undefined) return 'operation-missing'
  if (!object(operation) || operation.$ref !== undefined || !optionalBoolean(operation, 'deprecated')
    || (operation.operationId !== undefined && typeof operation.operationId !== 'string')) return 'unsupported-operation'
  let requestBodyRequired = false
  let fields: readonly string[] = []
  if (operation.requestBody !== undefined) {
    const body = operation.requestBody
    if (!object(body) || !allowedKeys(body, ['required', 'content', 'description']) || !annotations(body)
      || !optionalBoolean(body, 'required') || !object(body.content)
      || Object.keys(body.content).length !== 1 || !object(body.content['application/json'])) return 'unsupported-operation'
    const media = body.content['application/json']
    if (!allowedKeys(media, ['schema', 'example', 'examples'])) return 'unsupported-operation'
    const required = requiredFields(media.schema)
    if (required === undefined) return 'unsupported-operation'
    fields = required
    requestBodyRequired = body.required === true
  }
  if (!object(operation.responses)) return 'unsupported-operation'
  const statuses: string[] = []
  for (const [status, response] of Object.entries(operation.responses)) {
    if (status.startsWith('x-')) continue
    if (!(status === 'default' || /^[1-5](?:\d{2}|XX)$/u.test(status)) || !object(response)
      || response.$ref !== undefined || typeof response.description !== 'string') return 'unsupported-operation'
    statuses.push(status)
  }
  if (statuses.length === 0) return 'unsupported-operation'
  return {
    ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
    requestBodyRequired, requiredRequestFields: fields, responseStatuses: statuses.sort(), deprecated: operation.deprecated === true,
  }
}

/**
 * Sample supported declarations from the exact granted file without following references.
 * The digest covers the same complete bytes parsed below. Facts describe those declarations,
 * not deployed behavior or complete payload validation. Path and stat checks detect ordinary
 * replacement and concurrent writes; they are not kernel isolation from a malicious same-user process.
 * @param source - canonical exact-file grant returned by resolveOpenApiSources.
 * @param maxBytes - positive configured bound on the complete file; no partial digest is returned.
 * @param signal - caller cancellation; cancellation rejects after the held file is closed.
 * @returns valid declarations, invalid bytes with their digest, or an unavailable sample without facts.
 */
export async function sampleOpenApiSource(source: ClaudeScopeOpenApiSource, maxBytes: number, signal: AbortSignal): Promise<Sample> {
  let bytes: Buffer | Unavailable
  try { bytes = await readSample(source, maxBytes, signal) }
  catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof Error) || !('code' in error)) throw error
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return unavailable('missing-file')
    if (error.code === 'ELOOP') return unavailable('changed-during-read')
    return unavailable('not-readable')
  }
  signal.throwIfAborted()
  if (!Buffer.isBuffer(bytes)) return bytes
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return { state: 'invalid', sha256, reason: 'invalid-json' } }
  const result = declarations(value, source)
  return typeof result === 'string' ? { state: 'invalid', sha256, reason: result } : { state: 'valid', sha256, facts: result }
}
