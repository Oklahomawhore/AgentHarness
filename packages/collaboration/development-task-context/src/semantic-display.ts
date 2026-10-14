/** Lossless source and authorization tables for version-four semantic delivery; opaque mandatory JSON stays intact. */
import { semanticJson } from './semantic-schema.ts'
import type { SemanticInput } from './semantic-input.ts'
import type { DevelopmentTaskContextOmission, DevelopmentTaskContextSourceRef } from './types.ts'

/** Validated summary and complete evidence before display compaction. */
export interface SemanticDelivery extends Pick<SemanticInput, 'task' | 'recipient' | 'inherited' | 'mandatory'> {
  readonly updates: readonly {
    readonly text: string
    readonly sources: readonly { readonly source: DevelopmentTaskContextSourceRef; readonly quote: string; readonly attribution: unknown }[]
  }[]
  readonly coverage: {
    readonly selectedSources: readonly DevelopmentTaskContextSourceRef[]
    readonly omittedSources: readonly DevelopmentTaskContextOmission[]
  }
}

/** One exact Task revision or publication, with quoted-source attribution when present. */
export type SemanticDisplaySource = (Extract<DevelopmentTaskContextSourceRef, { kind: 'task' }> | {
  readonly kind: 'publication'
  readonly taskSourceIndex: number
  readonly publicationId: string
}) & { readonly attribution?: unknown }

/** Version-four display JSON; table indexes affect representation, never coverage or authorization. */
export interface SemanticTableDelivery extends Omit<SemanticDelivery, 'updates' | 'coverage'> {
  readonly sourceReferences: string
  readonly sourceTable: readonly SemanticDisplaySource[]
  readonly authorizationTable: readonly unknown[]
  readonly updates: readonly {
    readonly text: string
    readonly sources: readonly { readonly sourceIndex: number; readonly quote: string }[]
  }[]
  readonly coverage: {
    readonly selectedSources: readonly number[]
    readonly omittedSources: readonly { readonly sourceIndex: number; readonly reason: DevelopmentTaskContextOmission['reason'] }[]
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Represent repeated references once while retaining complete source identities and opaque evidence.
 * @param delivery - Validated expanded delivery, including every selected and omitted source.
 * @returns Deterministic tables whose expansion recovers the same JSON delivery. Mandatory records remain unchanged.
 */
export function semanticTableDelivery(delivery: SemanticDelivery): SemanticTableDelivery {
  const references: DevelopmentTaskContextSourceRef[] = []
  const referenceIndexes = new Map<string, number>()
  const reference = (source: DevelopmentTaskContextSourceRef): number => {
    const key = semanticJson(source)
    const existing = referenceIndexes.get(key)
    if (existing !== undefined) return existing
    const index = references.length
    referenceIndexes.set(key, index)
    references.push(source)
    return index
  }
  const coverage = {
    selectedSources: delivery.coverage.selectedSources.map(reference),
    omittedSources: delivery.coverage.omittedSources.map(item => ({ sourceIndex: reference(item.source), reason: item.reason })),
  }
  const attributions = new Map<number, unknown>()
  const updates = delivery.updates.map(update => ({ text: update.text, sources: update.sources.map((citation) => {
    const sourceIndex = reference(citation.source)
    if (attributions.has(sourceIndex) && semanticJson(attributions.get(sourceIndex)) !== semanticJson(citation.attribution)) {
      throw new Error('semantic display: conflicting attribution for one source')
    }
    attributions.set(sourceIndex, citation.attribution)
    return { sourceIndex, quote: citation.quote }
  }) }))
  // A captured legacy input can cite a publication without selecting its Task; the table does not add it to coverage.
  for (const source of references) if (source.kind === 'publication') {
    reference({ kind: 'task', taskId: source.taskId, revision: source.revision })
  }
  const authorizationTable: unknown[] = []
  const authorizationIndexes = new Map<string, number>()
  const authorization = (value: unknown): { authorizationIndex: number } => {
    const key = semanticJson(value)
    let index = authorizationIndexes.get(key)
    if (index === undefined) {
      index = authorizationTable.length
      authorizationIndexes.set(key, index)
      authorizationTable.push(value)
    }
    return { authorizationIndex: index }
  }
  const attribution = (value: unknown): unknown => {
    if (!record(value) || (value.basis !== 'current-task-report' && value.basis !== 'frozen-parent-snapshot')) return value
    return { ...value,
      ...(record(value.authorization) ? { authorization: authorization(value.authorization) } : {}),
      ...(record(value.localAuthorization) ? { localAuthorization: authorization(value.localAuthorization) } : {}),
    }
  }
  const sourceTable = references.map((source, index): SemanticDisplaySource => ({
    ...(source.kind === 'task' ? source : { kind: 'publication',
      taskSourceIndex: reference({ kind: 'task', taskId: source.taskId, revision: source.revision }), publicationId: source.publicationId }),
    ...(attributions.has(index) ? { attribution: attribution(attributions.get(index)) } : {}),
  }))
  return { task: delivery.task, recipient: delivery.recipient, inherited: delivery.inherited, mandatory: delivery.mandatory,
    sourceReferences: 'Indexes are zero-based. sourceIndex addresses sourceTable; taskSourceIndex identifies its exact Task revision. '
      + 'authorizationIndex addresses authorizationTable.',
    sourceTable, authorizationTable, updates, coverage }
}
