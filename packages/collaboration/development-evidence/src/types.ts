/** Client-independent types for bounded development evidence retrieval. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one registered evidence provider. */
export type DevelopmentEvidenceProviderId = Branded<'DevelopmentEvidenceProviderId'>

/** Provider-owned stable identity of one retrievable evidence item. */
export type DevelopmentEvidenceItemId = Branded<'DevelopmentEvidenceItemId'>

/** One bounded citation returned by an evidence provider. */
export interface DevelopmentEvidenceItem {
  /** Provider-owned stable item identity. */
  readonly id: DevelopmentEvidenceItemId
  /** Human-readable citation title. */
  readonly title: string
  /** Bounded evidence excerpt or reviewed summary. */
  readonly summary: string
  /** Provider-owned source locator, such as a URL, document token, or log query. */
  readonly source: string
  /** Provider-owned content revision used to preserve retrieval attribution. */
  readonly revision: string
  /** Optional normalized discovery labels. */
  readonly tags?: readonly string[]
}

/** Query passed from the registry to each selected provider. */
export interface DevelopmentEvidenceProviderQuery {
  /** Trimmed natural-language lookup text. */
  readonly query: string
  /** Maximum items the provider may return. */
  readonly limit: number
}

/** Provider-local retrieval result before the registry adds provider identity. */
export type DevelopmentEvidenceProviderOutcome =
  | { readonly status: 'available'; readonly items: readonly DevelopmentEvidenceItem[] }
  | { readonly status: 'empty' }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean }

/** One source of enterprise, project, or operational evidence. */
export interface DevelopmentEvidenceProvider {
  /** Unique lower-kebab provider identity. */
  readonly id: DevelopmentEvidenceProviderId
  /** Display label suitable for an operator-facing source list. */
  readonly label: string
  /**
   * Retrieve bounded citations without publishing them to a room or model.
   * @param request - normalized query and result limit.
   * @param signal - cancellation and registry timeout notification.
   * @returns explicit availability, empty, access-denied, or failure state.
   */
  query(request: DevelopmentEvidenceProviderQuery, signal: AbortSignal): Promise<DevelopmentEvidenceProviderOutcome>
}

/** Caller request for one aggregated evidence lookup. */
export interface DevelopmentEvidenceQueryRequest {
  /** Natural-language lookup text. */
  readonly query: string
  /** Optional exact provider allowlist; omission queries every registered provider. */
  readonly providerIds?: readonly DevelopmentEvidenceProviderId[]
  /** Optional requested item limit per provider, capped by registry config. */
  readonly limit?: number
}

/** One provider's sanitized result in an aggregated lookup. */
export type DevelopmentEvidenceProviderSnapshot =
  | { readonly providerId: DevelopmentEvidenceProviderId; readonly label: string; readonly status: 'available'; readonly items: readonly DevelopmentEvidenceItem[] }
  | { readonly providerId: DevelopmentEvidenceProviderId; readonly label: string; readonly status: 'empty' }
  | { readonly providerId: DevelopmentEvidenceProviderId; readonly label: string; readonly status: 'denied'; readonly reason: string }
  | { readonly providerId: DevelopmentEvidenceProviderId; readonly label: string; readonly status: 'failed'; readonly reason: string; readonly retryable: boolean }

/** Complete deterministic result of one lookup across selected providers. */
export interface DevelopmentEvidenceQuerySnapshot {
  /** Normalized lookup text used for every provider. */
  readonly query: string
  /** Results sorted by provider identity. */
  readonly providers: readonly DevelopmentEvidenceProviderSnapshot[]
}

/** Current registry entry visible to diagnostics and invariants. */
export interface DevelopmentEvidenceProviderRegistration {
  readonly id: DevelopmentEvidenceProviderId
  readonly label: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One evidence provider entered or left the runtime registry.
     * @param provider - stable provider identity and display label.
     * @param state - whether the provider is now registered or unregistered.
     * @mode emit
     */
    'development-evidence/provider-changed'(
      provider: DevelopmentEvidenceProviderRegistration,
      state: 'registered' | 'unregistered',
    ): void
  }
}
