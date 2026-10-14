/** Bounded reads from a static, explicitly selected calibration export. */
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { evidenceDigest } from './two-device-verify-replay.mjs'

/** Resource ceilings for one static endpoint export. */
export const exportLimitsSchema = z.strictObject({
  maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive(),
  maxEntries: z.number().int().positive(), maxDepth: z.number().int().nonnegative().max(8),
})
/** Caller-selected finite file and directory limits. */
export type ExportLimits = z.infer<typeof exportLimitsSchema>
/** Default ceilings match the observer's finite artifacts, without trusting manifest limits. */
export const exportLimits: ExportLimits = { maxFileBytes: 67108864, maxTotalBytes: 134217728, maxEntries: 128, maxDepth: 2 }
/** Refuse path traversal and platform-dependent separators. @param path Export-relative path. @returns Safe unchanged path. */
export function exportRelativePath(path: string): string {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.includes(':')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('unsafe export-relative path')
  return path
}
/** Resolve two disjoint user-selected roots, regardless of the recorded original device paths.
 * @param a First export directory.
 * @param b Second export directory.
 * @returns Canonical independent directories.
 */
export async function exportRoots(a: string, b: string): Promise<readonly [string, string]> {
  const roots = await Promise.all([a, b].map(async (path) => {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('export root must be a non-symlink directory')
    return realpath(path)
  }))
  const [first, second] = roots
  if (first === undefined || second === undefined) throw new Error('two export roots are required')
  for (const [parent, child] of [[first, second], [second, first]] as const) {
    const path = relative(parent, child)
    if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) {
      throw new Error('export roots must be independent directories')
    }
  }
  return [first, second]
}
/** Reads only paths explicitly selected by the checker; exports must remain static during verification. */
export class ExportReader {
  private bytes = 0
  private entries = 0
  readonly hashes: Record<string, { bytes: number; sha256: string }> = {}
  constructor(readonly root: string, private readonly limits: ExportLimits) {}
  private async path(name: string): Promise<string> {
    const parts = exportRelativePath(name).split('/')
    let path = this.root
    for (const [index, part] of parts.entries()) {
      path = join(path, part)
      const info = await lstat(path)
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        throw new Error('export path contains a symlink or non-directory ancestor')
      }
    }
    return path
  }
  /** Read a finite regular file without following its final link.
   * @param name Relative allowed file.
   * @param maximum Per-artifact upper bound.
   * @returns Exact original bytes.
   */
  async read(name: string, maximum: number): Promise<Buffer> {
    const path = await this.path(name)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > Math.min(maximum, this.limits.maxFileBytes)
        || this.bytes + stat.size > this.limits.maxTotalBytes) throw new Error('export file or total byte limit exceeded')
      const buffer = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null)
        if (read.bytesRead === 0) break
        size += read.bytesRead
      }
      const after = await handle.stat()
      if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('export changed during read')
      const value = buffer.subarray(0, size)
      this.bytes += size
      this.hashes[name] = { bytes: size, sha256: evidenceDigest(value) }
      return value
    } finally { await handle.close() }
  }
  /** Decode exact UTF-8 without replacement characters. @param name Allowed file. @param maximum Byte bound. @returns Text. */
  async text(name: string, maximum: number): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.read(name, maximum))
  }
  /** Parse one bounded JSON document. @param name Allowed file. @returns Untrusted parsed JSON. */
  async json(name: string): Promise<unknown> { return JSON.parse(await this.text(name, 1048576)) as unknown }
  /** Enumerate only Session logs in the owned layout. @returns Relative JSONL paths. */
  async sessions(): Promise<string[]> {
    const found: string[] = []
    const walk = async (name: string, depth: number): Promise<void> => {
      const directory = await this.path(name)
      const entries = await opendir(directory)
      for await (const entry of entries) {
        if (++this.entries > this.limits.maxEntries) throw new Error('export directory entry limit exceeded')
        if (entry.isSymbolicLink()) throw new Error('export Session directory contains a symlink')
        const child = `${name}/${entry.name}`
        if (entry.isDirectory()) {
          if (depth >= this.limits.maxDepth) throw new Error('export Session directory depth exceeded')
          await walk(child, depth + 1)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(child)
        else if (entry.name.endsWith('.zstd') || !entry.isFile()) throw new Error('unsupported Session artifact')
      }
    }
    await walk('sessions', 0)
    return found.sort()
  }
}
