/** Allowlisted text artifacts for controlled evaluation tools; this is not an OS security sandbox. */

import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, win32 } from 'node:path'

/** Explicit role-specific file access and complete UTF-8 byte limits. */
export interface WorkbenchConfig {
  readonly root: string
  readonly readableFiles: readonly string[]
  readonly writableFiles: readonly string[]
  readonly maxReadBytes: number
  readonly maxWriteBytes: number
}

/** Identity of the complete bytes read or committed by an operation. */
export interface WorkbenchReceipt {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** One complete UTF-8 artifact, without truncation. */
export interface WorkbenchFile extends WorkbenchReceipt {
  readonly text: string
}

/** File operations only; executing generated programs requires a separately verified isolation mechanism. */
export interface Workbench {
  /**
   * Read one permitted regular UTF-8 file without following links below the owned root.
   * @param path - exact role-allowlisted relative path.
   * @param signal - cancellation, checked before delivery.
   * @returns complete content and its byte identity.
   */
  read(path: string, signal: AbortSignal): Promise<WorkbenchFile>
  /**
   * Atomically replace one permitted file. Cancellation observed before rename leaves the old file unchanged.
   * Once rename starts its committed result is returned even if cancellation subsequently arrives.
   * @param path - exact role-allowlisted relative path; its parent must already exist.
   * @param text - complete replacement text.
   * @param signal - cancellation checked before the non-cancellable atomic commit.
   * @returns identity of the committed bytes.
   */
  write(path: string, text: string, signal: AbortSignal): Promise<WorkbenchReceipt>
}

/** File policy refusal; OS failures and cancellation retain their original errors. */
export class WorkbenchError extends Error {
  constructor(readonly code: 'invalid-path' | 'not-allowed' | 'invalid-root' | 'invalid-target' | 'symlink' | 'byte-limit') {
    super(`scope evaluation workbench: ${code}`)
    this.name = 'WorkbenchError'
  }
}

function relativeFile(path: string): void {
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new WorkbenchError('invalid-path')
  }
}

function receipt(path: string, data: Buffer): WorkbenchReceipt {
  return { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
}

/**
 * Create serialized read/write access to a fixture-owned directory; no tools or processes are launched.
 * The caller must prevent other actors from replacing directories during operations: path checks are not a kernel fence.
 * @param config - existing absolute root, exact role allowlists, and positive byte bounds.
 * @returns a workbench with detached allowlists and atomic same-directory writes.
 */
export async function createWorkbench(config: WorkbenchConfig): Promise<Workbench> {
  if (!isAbsolute(config.root)) throw new WorkbenchError('invalid-root')
  for (const limit of [config.maxReadBytes, config.maxWriteBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new WorkbenchError('byte-limit')
  }
  for (const file of [...config.readableFiles, ...config.writableFiles]) relativeFile(file)
  const readable = new Set(config.readableFiles)
  const writable = new Set(config.writableFiles)
  const { maxReadBytes, maxWriteBytes } = config
  const initialRoot = await fs.lstat(config.root)
  if (initialRoot.isSymbolicLink() || !initialRoot.isDirectory()) throw new WorkbenchError('invalid-root')
  const root = await fs.realpath(config.root)
  let tail = Promise.resolve()

  function enqueue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const result = tail.then(() => { signal.throwIfAborted(); return operation() })
    // Each caller receives its failure; a rejected operation does not poison subsequent file access.
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  async function target(path: string, allowed: ReadonlySet<string>, creating: boolean): Promise<string> {
    relativeFile(path)
    if (!allowed.has(path)) throw new WorkbenchError('not-allowed')
    const currentRoot = await fs.lstat(root)
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
      || currentRoot.dev !== initialRoot.dev || currentRoot.ino !== initialRoot.ino) throw new WorkbenchError('invalid-root')
    const parts = path.split('/')
    let current = root
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      let info
      try { info = await fs.lstat(current) } catch (error) {
        if (creating && index === parts.length - 1 && error instanceof Error && 'code' in error && error.code === 'ENOENT') return current
        throw error
      }
      if (info.isSymbolicLink()) throw new WorkbenchError('symlink')
      if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new WorkbenchError('invalid-target')
    }
    return current
  }

  return {
    read(path, signal) {
      return enqueue(signal, async () => {
        const file = await target(path, readable, false)
        signal.throwIfAborted()
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile()) throw new WorkbenchError('invalid-target')
          if (info.size > maxReadBytes) throw new WorkbenchError('byte-limit')
          const data = await handle.readFile()
          if (data.length > maxReadBytes) throw new WorkbenchError('byte-limit')
          signal.throwIfAborted()
          return { ...receipt(path, data), text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
        } finally { await handle.close() }
      })
    },
    write(path, text, signal) {
      return enqueue(signal, async () => {
        const data = Buffer.from(text, 'utf8')
        if (data.length > maxWriteBytes) throw new WorkbenchError('byte-limit')
        const file = await target(path, writable, true)
        const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
        const handle = await fs.open(temporary, 'wx', 0o600)
        try {
          try { await fs.writeFile(handle, data, { signal }) } finally { await handle.close() }
          await target(path, writable, true)
          signal.throwIfAborted()
          await fs.rename(temporary, file)
          return receipt(path, data)
        } finally { await fs.rm(temporary, { force: true }) }
      })
    },
  }
}
