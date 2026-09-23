/** Provider registry and bounded aggregation for development evidence. */

import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {
  DevelopmentEvidenceItem,
  DevelopmentEvidenceProvider,
  DevelopmentEvidenceProviderId,
  DevelopmentEvidenceProviderOutcome,
  DevelopmentEvidenceProviderRegistration,
  DevelopmentEvidenceProviderSnapshot,
  DevelopmentEvidenceQueryRequest,
  DevelopmentEvidenceQuerySnapshot,
} from './types.ts'

export type * from './types.ts'

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/

/** Resource and latency policy enforced across every evidence provider. */
export interface Config {
  /** Maximum UTF-8 bytes accepted in a lookup query. */
  readonly maxQueryBytes: number
  /** Maximum citations retained from one provider. */
  readonly maxItemsPerProvider: number
  /** Maximum UTF-8 bytes accepted in each citation text field. */
  readonly maxItemTextBytes: number
  /** Maximum tags retained on one citation. */
  readonly maxTagsPerItem: number
  /** Maximum time allotted to one provider lookup. */
  readonly providerTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Enterprise, project, and operational evidence provider registry. */
    developmentEvidence: DevelopmentEvidenceService
  }
}

/** Stable registry or query validation failure. */
export class DevelopmentEvidenceError extends Error {
  /** @param code - caller-routable failure classification. */
  constructor(message: string, readonly code:
    | 'DUPLICATE_PROVIDER'
    | 'PROVIDER_NOT_FOUND'
    | 'INVALID_REQUEST'
    | 'LIMIT_EXCEEDED') {
    super(message)
    this.name = 'DevelopmentEvidenceError'
  }
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`development-evidence: ${field} must be a positive safe integer`)
  }
  return value
}

/** Service Definition for explicit, source-attributed development evidence retrieval. */
export class DevelopmentEvidenceService extends Service {
  static Config: s<Config> = s.object({
    maxQueryBytes: s.number().step(1).min(1).required(),
    maxItemsPerProvider: s.number().step(1).min(1).required(),
    maxItemTextBytes: s.number().step(1).min(1).required(),
    maxTagsPerItem: s.number().step(1).min(1).required(),
    providerTimeoutMs: s.number().step(1).min(1).required(),
  })

  private readonly providers = new Map<DevelopmentEvidenceProviderId, DevelopmentEvidenceProvider>()
  private readonly config: Config

  /** Validate deployment bounds before providers can register. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'developmentEvidence')
    this.config = {
      maxQueryBytes: positive(config.maxQueryBytes, 'maxQueryBytes'),
      maxItemsPerProvider: positive(config.maxItemsPerProvider, 'maxItemsPerProvider'),
      maxItemTextBytes: positive(config.maxItemTextBytes, 'maxItemTextBytes'),
      maxTagsPerItem: positive(config.maxTagsPerItem, 'maxTagsPerItem'),
      providerTimeoutMs: positive(config.providerTimeoutMs, 'providerTimeoutMs'),
    }
  }

  /**
   * Register one provider for its plugin lifetime.
   * @param provider - unique provider implementation.
   * @returns disposer that unregisters the provider.
   */
  registerProvider(provider: DevelopmentEvidenceProvider): () => void {
    if (!PROVIDER_ID.test(provider.id)) {
      throw new DevelopmentEvidenceError('provider id must use lower-kebab-case', 'INVALID_REQUEST')
    }
    const label = this.text(provider.label, 'provider label')
    if (this.providers.has(provider.id)) {
      throw new DevelopmentEvidenceError(`evidence provider "${provider.id}" is already registered`, 'DUPLICATE_PROVIDER')
    }
    const registration = Object.freeze({ id: provider.id, label })
    const normalized: DevelopmentEvidenceProvider = Object.freeze({
      id: provider.id,
      label,
      query: provider.query.bind(provider),
    })
    const dispose = this.ctx.effect(function* (this: DevelopmentEvidenceService) {
      this.providers.set(provider.id, normalized)
      this.ctx.emit('development-evidence/provider-changed', registration, 'registered')
      yield () => {
        this.providers.delete(provider.id)
        this.ctx.emit('development-evidence/provider-changed', registration, 'unregistered')
      }
    }.bind(this), 'developmentEvidence.registerProvider()')
    return () => { void dispose() }
  }

  /**
   * Read the current provider directory in deterministic order.
   * @returns detached provider registrations sorted by id.
   */
  listProviders(): readonly DevelopmentEvidenceProviderRegistration[] {
    return Object.freeze([...this.providers.values()]
      .map(provider => Object.freeze({ id: provider.id, label: provider.label }))
      .sort((left, right) => left.id.localeCompare(right.id)))
  }

  /**
   * Query every selected provider while preserving empty, denied, and failed outcomes.
   * @param request - query, optional provider allowlist, and optional per-provider limit.
   * @param signal - optional caller cancellation.
   * @returns deterministic provider results with all citation fields bounded.
   */
  async query(request: DevelopmentEvidenceQueryRequest, signal?: AbortSignal): Promise<DevelopmentEvidenceQuerySnapshot> {
    const query = this.text(request.query, 'query', this.config.maxQueryBytes)
    const limit = request.limit === undefined
      ? this.config.maxItemsPerProvider
      : Math.min(positive(request.limit, 'limit'), this.config.maxItemsPerProvider)
    const providers = this.selectProviders(request.providerIds)
    const snapshots = await Promise.all(providers.map(provider => this.queryProvider(provider, query, limit, signal)))
    return Object.freeze({ query, providers: Object.freeze(snapshots) })
  }

  private selectProviders(ids: readonly DevelopmentEvidenceProviderId[] | undefined): DevelopmentEvidenceProvider[] {
    if (ids === undefined) return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id))
    if (new Set(ids).size !== ids.length) {
      throw new DevelopmentEvidenceError('providerIds must not contain duplicates', 'INVALID_REQUEST')
    }
    return ids.map((id) => {
      const provider = this.providers.get(id)
      if (provider === undefined) throw new DevelopmentEvidenceError(`evidence provider "${id}" is not registered`, 'PROVIDER_NOT_FOUND')
      return provider
    })
  }

  private async queryProvider(
    provider: DevelopmentEvidenceProvider,
    query: string,
    limit: number,
    upstream: AbortSignal | undefined,
  ): Promise<DevelopmentEvidenceProviderSnapshot> {
    using timer = deadline(upstream, this.config.providerTimeoutMs, 'DEVELOPMENT_EVIDENCE_PROVIDER_TIMEOUT')
    try {
      const outcome = await this.settle(provider.query({ query, limit }, timer.signal), timer.signal)
      return this.snapshot(provider, outcome)
    } catch (error) {
      const timedOut = timeoutOf(timer.signal, 'DEVELOPMENT_EVIDENCE_PROVIDER_TIMEOUT')
      const reason = timedOut === undefined ? this.errorText(error) : `provider timed out after ${timedOut.timeoutMs}ms`
      return Object.freeze({ providerId: provider.id, label: provider.label, status: 'failed', reason, retryable: true })
    }
  }

  private async settle<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortError(signal.reason)
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(abortError(signal.reason)) }, { once: true })
      }),
    ])
  }

  private snapshot(
    provider: DevelopmentEvidenceProvider,
    outcome: DevelopmentEvidenceProviderOutcome,
  ): DevelopmentEvidenceProviderSnapshot {
    switch (outcome.status) {
      case 'available': {
        const items = outcome.items.slice(0, this.config.maxItemsPerProvider).map(item => this.item(item))
        if (items.length === 0) return Object.freeze({ providerId: provider.id, label: provider.label, status: 'empty' })
        return Object.freeze({ providerId: provider.id, label: provider.label, status: 'available', items: Object.freeze(items) })
      }
      case 'empty':
        return Object.freeze({ providerId: provider.id, label: provider.label, status: 'empty' })
      case 'denied':
        return Object.freeze({ providerId: provider.id, label: provider.label, status: 'denied', reason: this.text(outcome.reason, 'denial reason') })
      case 'failed':
        return Object.freeze({ providerId: provider.id, label: provider.label, status: 'failed', reason: this.text(outcome.reason, 'failure reason'), retryable: outcome.retryable })
      default:
        return assertNever(outcome, 'DevelopmentEvidenceProviderOutcome.status')
    }
  }

  private item(item: DevelopmentEvidenceItem): DevelopmentEvidenceItem {
    const tags = item.tags?.slice(0, this.config.maxTagsPerItem)
      .map(tag => this.text(tag, 'evidence tag'))
    return Object.freeze({
      id: this.text(item.id, 'evidence item id') as DevelopmentEvidenceItem['id'],
      title: this.text(item.title, 'evidence title'),
      summary: this.text(item.summary, 'evidence summary'),
      source: this.text(item.source, 'evidence source'),
      revision: this.text(item.revision, 'evidence revision'),
      ...tags === undefined ? {} : { tags: Object.freeze(tags) },
    })
  }

  private text(value: string, field: string, maxBytes = this.config.maxItemTextBytes): string {
    const normalized = value.trim()
    if (normalized.length === 0) throw new DevelopmentEvidenceError(`${field} must not be blank`, 'INVALID_REQUEST')
    if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
      throw new DevelopmentEvidenceError(`${field} exceeds its configured byte limit`, 'LIMIT_EXCEEDED')
    }
    return normalized
  }

  private errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'provider failed'
    const bytes = Buffer.from(raw.trim() || 'provider failed')
    return bytes.length <= this.config.maxItemTextBytes
      ? bytes.toString()
      : bytes.subarray(0, this.config.maxItemTextBytes).toString()
  }
}

export default DevelopmentEvidenceService

function assertNever(value: never, label: string): never {
  throw new TypeError(`unexpected ${label}: ${JSON.stringify(value)}`)
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('development evidence query aborted', { cause: reason })
}
