/** Reviewed JSON-file provider for project and enterprise development evidence. */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {
  DevelopmentEvidenceItem,
  DevelopmentEvidenceItemId,
  DevelopmentEvidenceProvider,
  DevelopmentEvidenceProviderId,
  DevelopmentEvidenceProviderOutcome,
  DevelopmentEvidenceProviderQuery,
} from '@deepseek-ai/dsh-development-evidence'
import { z } from 'zod'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'development-evidence-reviewed-file'
/** Evidence registry this provider contributes to. */
export const inject = ['developmentEvidence']

/** Reviewed-file provider deployment configuration. */
export interface Config {
  /** Unique lower-kebab provider identity. */
  readonly providerId: string
  /** Operator-facing provider label. */
  readonly label: string
  /** Absolute or process-relative reviewed JSON file path. */
  readonly path: string
  /** Maximum bytes read before JSON parsing. */
  readonly maxFileBytes: number
}

/** Loader-visible config schema. */
export const Config: s<Config> = s.object({
  providerId: s.string().required(),
  label: s.string().required(),
  path: s.string().required(),
  maxFileBytes: s.number().step(1).min(1).required(),
})

const itemSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  source: z.string().min(1),
  revision: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
})
const fileSchema = z.strictObject({ version: z.literal(1), items: z.array(itemSchema) })

/** One validated, immutable reviewed knowledge corpus. */
export class ReviewedFileEvidenceProvider implements DevelopmentEvidenceProvider {
  readonly id: DevelopmentEvidenceProviderId
  readonly label: string
  private readonly items: readonly DevelopmentEvidenceItem[]

  /**
   * Load and validate the complete corpus before registration.
   * @param config - provider identity, display label, file location, and read bound.
   */
  constructor(config: Config) {
    if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1) {
      throw new TypeError('development-evidence-reviewed-file: maxFileBytes must be a positive safe integer')
    }
    const path = resolve(config.path)
    const size = statSync(path).size
    if (size > config.maxFileBytes) {
      throw new Error(`development-evidence-reviewed-file: ${path} exceeds maxFileBytes`)
    }
    const parsed = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (new Set(parsed.items.map(item => item.id)).size !== parsed.items.length) {
      throw new Error('development-evidence-reviewed-file: item ids must be unique')
    }
    this.id = config.providerId as DevelopmentEvidenceProviderId
    this.label = config.label
    this.items = Object.freeze(parsed.items.map(({ id, title, summary, source, revision, tags }) => Object.freeze({
      id: id as DevelopmentEvidenceItemId,
      title,
      summary,
      source,
      revision,
      ...tags === undefined ? {} : { tags: Object.freeze([...tags]) },
    })))
  }

  /**
   * Rank reviewed citations by normalized substring and token matches.
   * @param request - normalized query and item limit.
   * @param signal - cancellation notification.
   * @returns available items or an explicit empty result.
   */
  query(
    request: DevelopmentEvidenceProviderQuery,
    signal: AbortSignal,
  ): Promise<DevelopmentEvidenceProviderOutcome> {
    signal.throwIfAborted()
    const normalizedQuery = normalize(request.query)
    const tokens = [...new Set(normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    const ranked = this.items.flatMap((item, order) => {
      const searchable = normalize([item.title, item.summary, ...(item.tags ?? [])].join(' '))
      const phraseScore = searchable.includes(normalizedQuery) ? 100 : 0
      const tokenScore = tokens.reduce((score, token) => score + (searchable.includes(token) ? 10 : 0), 0)
      const score = phraseScore + tokenScore
      return score === 0 ? [] : [{ item, score, order }]
    }).sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, request.limit)
      .map(match => match.item)
    return Promise.resolve(ranked.length === 0
      ? { status: 'empty' }
      : { status: 'available', items: ranked })
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

/** Register one fail-loud reviewed knowledge file with the evidence seam. */
export function apply(ctx: Context, config: Config): void {
  ctx.developmentEvidence.registerProvider(new ReviewedFileEvidenceProvider(config))
}
