/** Local contribution selection and path-free proposal derivation. */

import type { DevelopmentTaskContributionSource } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import { z } from 'zod'
import { claudeWorkSourceSchema } from '@deepseek-ai/dsh-development-task/schema'
import { resolveOpenApiSources } from './openapi.ts'
import type { ClaudeScopeContributionSource } from './types.ts'

/** Durable local selection; existing API selectors retain their exact representation. */
export const contributionSourceSchema: z.ZodType<ClaudeScopeContributionSource> = z.union([
  z.strictObject({ name: z.string().min(1), method: z.enum(['post', 'put', 'patch']),
    path: z.string().startsWith('/'), filePath: z.string().min(1) }),
  z.strictObject({ kind: z.literal('tool-observations'), tools: z.array(z.enum(['Write', 'Edit'])).min(1)
    .refine(values => new Set(values).size === values.length) }),
  z.strictObject({ kind: z.literal('claude-work'), tools: z.array(z.enum(['Write', 'Edit'])),
    commands: z.array(z.strictObject({ command: z.string(), rootIndex: z.number().int().nonnegative() })), stopReports: z.boolean() })
    .refine(value => claudeWorkSourceSchema.safeParse({ ...value, version: 7, name: 'session-work' }).success),
])

/**
 * Resolve explicit local collection without reading tool targets or conversation files.
 * @param input - parsed local source permission.
 * @param roots - canonical allowed collection roots.
 * @param signal - current management lifetime.
 * @returns normalized selection; API sources still require an existing regular file.
 */
export async function resolveContributionSource(
  input: ClaudeScopeContributionSource, roots: readonly string[], signal: AbortSignal,
): Promise<ClaudeScopeContributionSource> {
  const source = contributionSourceSchema.parse(input)
  signal.throwIfAborted()
  if ('kind' in source) {
    if (source.kind === 'claude-work') {
      if (source.commands.some(command => command.rootIndex >= roots.length)) throw new Error('Command root is not selected')
      if (roots.length === 0 && (source.tools.length > 0 || source.commands.length > 0)) throw new Error('Tool collection requires roots')
      return { ...source, tools: [...source.tools].sort(), commands: [...source.commands]
        .sort((a, b) => a.rootIndex - b.rootIndex || a.command.localeCompare(b.command)) }
    }
    return { kind: source.kind, tools: [...source.tools].sort() }
  }
  const [resolved] = await resolveOpenApiSources([source], roots, signal)
  if (resolved === undefined) throw new Error('claude-scope: contribution source is missing')
  return resolved
}

/**
 * Exclude local paths from the owner approval request.
 * @param source - resolved local permission.
 * @returns exact public source selector; capture identity distinguishes work streams.
 */
export function contributionProposalSource(source: ClaudeScopeContributionSource): DevelopmentTaskContributionSource {
  if ('kind' in source && source.kind === 'claude-work') return { ...source, version: 7 as const, name: 'session-work' }
  return 'kind' in source
    ? { kind: source.kind, name: 'session-work', tools: [...source.tools] }
    : { name: source.name, method: source.method, path: source.path }
}

/**
 * Match the collection source; the containing Session separately validates joint receiving consent.
 * @param entry - original application invitation.
 * @param source - parsed local collection selection.
 * @returns whether this entry permits applying for that kind of contribution.
 */
export function contributionEntryMatches(entry: ScopeContributionEntry, source: ClaudeScopeContributionSource): boolean {
  const mode = 'kind' in source ? source.kind : 'openapi'
  return (entry.kind === 'openapi-contribution-entry' ? 'openapi' : entry.sourceKind) === mode
}
