/** Local contribution selection and path-free proposal derivation. */

import type { DevelopmentTaskContributionSource } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import { z } from 'zod'
import { resolveOpenApiSources } from './openapi.ts'
import type { ClaudeScopeContributionSource } from './types.ts'

/** Durable local selection; existing API selectors retain their exact representation. */
export const contributionSourceSchema: z.ZodType<ClaudeScopeContributionSource> = z.union([
  z.strictObject({ name: z.string().min(1), method: z.enum(['post', 'put', 'patch']),
    path: z.string().startsWith('/'), filePath: z.string().min(1) }),
  z.strictObject({ kind: z.literal('tool-observations'), tools: z.array(z.enum(['Write', 'Edit'])).min(1)
    .refine(values => new Set(values).size === values.length) }),
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
  if ('kind' in source) return { kind: source.kind, tools: [...source.tools].sort() }
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
  return 'kind' in source
    ? { kind: source.kind, name: 'session-work', tools: [...source.tools] }
    : { name: source.name, method: source.method, path: source.path }
}

/**
 * Keep application consent within the supported single-entry source kind; reusable native joins require native receiving.
 * @param entry - original application invitation.
 * @param source - parsed local collection selection.
 * @returns whether this entry permits applying for that kind of contribution.
 */
export function contributionEntryMatches(entry: ScopeContributionEntry, source: ClaudeScopeContributionSource): boolean {
  if (entry.kind === 'scope-group-entry') return false
  const mode = 'kind' in source ? source.kind : 'openapi'
  return (entry.kind === 'openapi-contribution-entry' ? 'openapi' : entry.sourceKind) === mode
}
