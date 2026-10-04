/** Private descriptor publication and same-user loopback Connection authentication. */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './index.ts'

/** Host-owned location of a private local Connection capability. */
export interface LocalConnectionDescriptorConfig {
  /** Absolute path in an owner-only directory; one live publisher holds its kernel lease. */
  readonly descriptorPath: string
}

/** Complete-file limit for a local capability read. */
export interface LocalConnectionAuthenticationConfig extends LocalConnectionDescriptorConfig {
  /** Maximum complete serialized descriptor size in UTF-8 bytes. */
  readonly maxDescriptorBytes: number
}

/** Versioned capability file; launchUrl is secret and must not enter diagnostics. */
export interface LocalConnectionDescriptor {
  /** Private descriptor format version. */
  readonly version: 1
  /** Publisher generation; a successor Host replaces it. */
  readonly generation: string
  /** Loopback root URL containing this Host's launch token. */
  readonly launchUrl: string
}

/** Authenticated local authority; cookie is secret and belongs only in request headers. */
export interface LocalConnectionAccess {
  /** Exact loopback origin accepted during the root exchange. */
  readonly origin: string
  /** One Connection browser-session cookie for this origin. */
  readonly cookie: string
  /** Publisher generation observed in the private descriptor. */
  readonly generation: string
}

/** Safe diagnostic categories; values never include paths, tokens, or cookies. */
export type LocalConnectionAccessFailureCode =
  | 'descriptor-unavailable' | 'descriptor-invalid' | 'descriptor-too-large'
  | 'authentication-failed' | 'transport-failed' | 'platform-unsupported'

/** A local capability or authentication failure with a credential-free message. */
export class LocalConnectionAccessError extends Error {
  /**
   * Construct one safe diagnostic.
   * @param code - public failure category without credential material.
   */
  constructor(readonly code: LocalConnectionAccessFailureCode) {
    super(code)
    this.name = 'LocalConnectionAccessError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function assertPrivate(info: { mode: number; uid: number }, mode: number): void {
  if (process.platform === 'win32') return
  if ((info.mode & 0o777) !== mode || info.uid !== process.getuid?.()) {
    throw new LocalConnectionAccessError('descriptor-invalid')
  }
}

function parseJson(text: string, code: LocalConnectionAccessFailureCode): unknown {
  try { return JSON.parse(text) as unknown } catch { throw new LocalConnectionAccessError(code) }
}

/**
 * Decode one bounded UTF-8 stream without truncating multibyte characters.
 * @param chunks - byte chunks supplied by a file, process, or response stream.
 * @param maxBytes - complete byte limit, including JSON syntax.
 * @param oversized - diagnostic for a value exceeding the limit.
 * @param signal - operation cancellation checked between chunks.
 * @returns the complete decoded text; invalid UTF-8 is rejected.
 */
async function readBoundedUtf8(
  chunks: AsyncIterable<Uint8Array>, maxBytes: number, oversized: LocalConnectionAccessFailureCode, signal: AbortSignal,
): Promise<string> {
  const retained: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of chunks) {
    signal.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new LocalConnectionAccessError(oversized)
    retained.push(chunk)
  }
  signal.throwIfAborted()
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(retained, bytes))
}

/**
 * Publish the current Host capability after application readiness and remove it on disposal.
 * Uses the composing frontend's existing Connection index authorization; registers no routes.
 * @param ctx - Host context with Connection, WebServer, and dsh launcher lifecycle services.
 * @param config - leased descriptor path in an owner-only directory.
 * @param label - feature name used in lifecycle diagnostics; must not contain credentials.
 * @returns the generation consumers may bind to their own Remote requests.
 */
export function publishLocalConnectionDescriptor(
  ctx: Context, config: LocalConnectionDescriptorConfig, label: string,
): { readonly generation: string } {
  if (process.platform === 'win32') throw new LocalConnectionAccessError('platform-unsupported')
  if (!isAbsolute(config.descriptorPath)) throw new Error(`${label} descriptorPath must be absolute`)
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error(`${label} requires the dsh application lifecycle`)
  const generation = randomUUID()
  const lifetime = new AbortController()
  let publication = Promise.resolve()
  let lease: FileHandle | undefined
  ctx.effect(() => ready.onReady(() => {
    publication = publish().catch((error: unknown) => {
      if (lifetime.signal.aborted) return
      ctx.logger.error('%s could not publish its private connection descriptor: %s', label,
        error instanceof LocalConnectionAccessError ? error.code : 'publication-failed')
      exit(1)
    })
  }), `${label}: descriptor readiness`)
  ctx.effect(() => async () => {
    lifetime.abort()
    await publication
    if (lease === undefined) return
    try {
      let current: unknown
      try { current = parseJson(await readFile(config.descriptorPath, 'utf8'), 'descriptor-invalid') } catch (error) {
        if (missing(error)) return
        throw error
      }
      if (record(current) && current.generation === generation) await unlink(config.descriptorPath)
    } finally {
      await lease.close()
    }
  }, `${label}: descriptor disposal`)
  async function publish(): Promise<void> {
    const directory = dirname(config.descriptorPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new LocalConnectionAccessError('descriptor-invalid')
    assertPrivate(info, 0o700)
    lifetime.signal.throwIfAborted()
    const lockPath = `${config.descriptorPath}.lock`
    const candidate = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      await tryLockExclusive(candidate.fd)
      const held = await candidate.stat()
      const current = await lstat(lockPath)
      assertPrivate(held, 0o600)
      if (!current.isFile() || current.ino !== held.ino || current.dev !== held.dev) throw new Error(`${label} descriptor lease was replaced`)
      lease = candidate
    } catch (error) {
      await candidate.close()
      throw error
    }
    lifetime.signal.throwIfAborted()
    const descriptor: LocalConnectionDescriptor = {
      version: 1, generation,
      launchUrl: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`),
    }
    const temporary = join(directory, `.local-connection-${generation}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600, signal: lifetime.signal })
      lifetime.signal.throwIfAborted()
      await rename(temporary, config.descriptorPath)
    } finally {
      try { await unlink(temporary) } catch (error) { if (!missing(error)) throw error }
    }
  }
  return Object.freeze({ generation })
}

async function readDescriptor(config: LocalConnectionAuthenticationConfig, signal: AbortSignal): Promise<LocalConnectionDescriptor> {
  signal.throwIfAborted()
  if (!isAbsolute(config.descriptorPath)) throw new LocalConnectionAccessError('descriptor-invalid')
  const directory = await lstat(dirname(config.descriptorPath))
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new LocalConnectionAccessError('descriptor-invalid')
  assertPrivate(directory, 0o700)
  const info = await lstat(config.descriptorPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new LocalConnectionAccessError('descriptor-invalid')
  assertPrivate(info, 0o600)
  const file = await open(config.descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let value: unknown
  try {
    const opened = await file.stat()
    assertPrivate(opened, 0o600)
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new LocalConnectionAccessError('descriptor-invalid')
    signal.throwIfAborted()
    const stream = file.createReadStream({ autoClose: false, signal })
    value = parseJson(await readBoundedUtf8(stream as AsyncIterable<Uint8Array>, config.maxDescriptorBytes, 'descriptor-too-large', signal), 'descriptor-invalid')
  } finally {
    await file.close()
  }
  if (!record(value) || value.version !== 1 || typeof value.generation !== 'string' || value.generation.length === 0
    || typeof value.launchUrl !== 'string') throw new LocalConnectionAccessError('descriptor-invalid')
  let url: URL
  try { url = new URL(value.launchUrl) } catch { throw new LocalConnectionAccessError('descriptor-invalid') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.hash !== '' || [...url.searchParams].length !== 1 || !url.searchParams.get('token')) {
    throw new LocalConnectionAccessError('descriptor-invalid')
  }
  return { version: 1, generation: value.generation, launchUrl: url.href }
}

/**
 * Read a private descriptor and exchange its launch token for a Connection cookie.
 * Grants the installed same-user client the normal Connection authority, not a scoped Task permission.
 * No background work survives completion; callers own request timeouts and cookie retention.
 * @param config - private descriptor location and complete-file byte limit.
 * @param signal - caller cancellation shared by descriptor reading and authentication.
 * @param fetcher - Fetch implementation; defaults to the process Fetch implementation.
 * @returns the authenticated origin, cookie, and descriptor generation.
 */
export async function authenticateLocalConnection(
  config: LocalConnectionAuthenticationConfig, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<LocalConnectionAccess> {
  signal.throwIfAborted()
  if (process.platform === 'win32') throw new LocalConnectionAccessError('platform-unsupported')
  let descriptor: LocalConnectionDescriptor
  try { descriptor = await readDescriptor(config, signal) } catch (error) {
    if (error instanceof LocalConnectionAccessError || signal.aborted) throw error
    throw new LocalConnectionAccessError('descriptor-unavailable')
  }
  try {
    signal.throwIfAborted()
    const login = await fetcher(descriptor.launchUrl, { redirect: 'manual', signal })
    const cookies = login.headers.getSetCookie()
    await login.body?.cancel()
    signal.throwIfAborted()
    const cookie = cookies.find(value => /^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_.-]+;/u.test(value))?.split(';', 1)[0]
    if (login.status !== 303 || login.headers.get('location') !== '/' || cookie === undefined) {
      throw new LocalConnectionAccessError('authentication-failed')
    }
    return { origin: new URL(descriptor.launchUrl).origin, cookie, generation: descriptor.generation }
  } catch (error) {
    if (error instanceof LocalConnectionAccessError || signal.aborted) throw error
    throw new LocalConnectionAccessError('transport-failed')
  }
}
