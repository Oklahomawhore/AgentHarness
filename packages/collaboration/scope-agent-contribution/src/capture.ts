/** Backend-native file authorization and bounded original tool reports. */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolFsMutation } from '@deepseek-ai/dsh-tool-fs'
import type { DevelopmentTaskToolObservationResult } from '@deepseek-ai/dsh-development-task/types'
import { toolObservationResultSchema } from '@deepseek-ai/dsh-development-task/schema'

/**
 * Render a relative canonical URI path only after the actual provider authorizes containment.
 * @param fs - the same provider that resolved both targets and executes the mutation.
 * @param roots - explicitly permitted canonical directories.
 * @param target - actual filesystem tool target, never reconstructed from a tool name.
 * @returns root ordinal and relative path without exposing an absolute filesystem path.
 */
export function nativeToolPath(fs: FileSystem, roots: readonly FsTarget[],
  target: FsTarget): { rootIndex: number; path: string } | undefined {
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex]
    if (root === undefined || !fs.contains(root, target) || root.targetKey === target.targetKey) continue
    const parent = new URL(fs.fileUrl(root))
    const child = new URL(fs.fileUrl(target))
    const prefix = parent.pathname.endsWith('/') ? parent.pathname : parent.pathname + '/'
    if (parent.protocol !== 'file:' || child.protocol !== 'file:' || parent.host !== child.host || !child.pathname.startsWith(prefix)) continue
    const path = child.pathname.slice(prefix.length).split('/').map(part => decodeURIComponent(part)).join('/')
    return { rootIndex, path }
  }
  return undefined
}

/**
 * Render original admitted parameters with explicit whole-field omissions; failure never asserts applied file contents.
 * @param mutation - actual tool-fs attempt without any prior file contents.
 * @param path - authorized relative canonical target.
 * @param failed - final durable tool outcome, including late cancellation.
 * @param fits - complete owner-bound payload byte check.
 * @returns complete structured report, or undefined if even its attribution cannot fit.
 */
export function nativeToolReport(mutation: ToolFsMutation, path: { rootIndex: number; path: string }, failed: boolean,
  fits: (report: DevelopmentTaskToolObservationResult) => boolean): DevelopmentTaskToolObservationResult | undefined {
  type Field = DevelopmentTaskToolObservationResult['omissions'][number]
  const candidates: readonly (readonly [Field, string])[] = mutation.tool === 'write'
    ? [['content', mutation.input.content]] : [['oldString', mutation.input.oldString], ['newString', mutation.input.newString]]
  const omissions: Field[] = candidates.map(([name]) => name)
  if (failed) omissions.push('error')
  const values: Record<Field, string | undefined> = { content: undefined, oldString: undefined, newString: undefined, error: undefined }
  const render = (): DevelopmentTaskToolObservationResult => {
    const common = { kind: 'tool-observation' as const, version: 1 as const,
      reportedStatus: failed ? 'failure' as const : 'success' as const, omissions: [...omissions] }
    return mutation.tool === 'write'
      ? { ...common, tool: 'Write', fields: { ...path, ...(values.content === undefined ? {} : { content: values.content }) } }
      : { ...common, tool: 'Edit', fields: { ...path, replaceAll: mutation.input.replaceAll,
        ...(values.oldString === undefined ? {} : { oldString: values.oldString }),
        ...(values.newString === undefined ? {} : { newString: values.newString }) } }
  }
  if (!toolObservationResultSchema.safeParse(render()).success || !fits(render())) return undefined
  if (!failed) for (const [field, value] of candidates) {
    const index = omissions.indexOf(field)
    values[field] = value
    omissions.splice(index, 1)
    if (!fits(render())) { values[field] = undefined; omissions.splice(index, 0, field) }
  }
  return render()
}
