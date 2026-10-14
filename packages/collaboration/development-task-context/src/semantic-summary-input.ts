/** Version-two summary requests retain current evidence while counting superseded publication coverage. */
import type { SemanticInput } from './semantic-input.ts'
import { semanticJson } from './semantic-schema.ts'
import type { DevelopmentTaskContextSourceRef } from './types.ts'

/** Encode the actual summary-model input independently of the complete durable capture.
 * @param input - Complete selected evidence and historical coverage.
 * @returns Exact model text; only superseded publication identities are replaced with counts by Task revision.
 */
export function semanticSummaryInput(input: SemanticInput): string {
  const groups = new Map<string, { source: Extract<DevelopmentTaskContextSourceRef, { kind: 'task' }>; count: number }>()
  const omittedSources = input.omitted.filter(({ source, reason }) => {
    if (reason !== 'superseded' || source.kind !== 'publication') return true
    const task = { kind: 'task' as const, taskId: source.taskId, revision: source.revision }
    const key = semanticJson(task)
    const previous = groups.get(key)
    groups.set(key, { source: task, count: (previous?.count ?? 0) + 1 })
    return false
  })
  return semanticJson({ task: input.task, recipient: input.recipient, inherited: input.inherited,
    mandatory: input.mandatory, sources: input.sources, coverage: { selectedSources: input.selected,
      omittedSources, supersededSources: [...groups.values()] } })
}
