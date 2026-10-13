/** Version-six coverage counts superseded publications while retaining current evidence and complete audit metadata. */
import { semanticMandatoryTableDelivery } from './semantic-mandatory-display.ts'
import type { SemanticDelivery, SemanticTableDelivery } from './semantic-display.ts'
import { semanticJson } from './semantic-schema.ts'
import type { DevelopmentTaskContextSourceRef } from './types.ts'

/** Model-facing history counts identify exact Task revisions; full omitted publication identities remain in projection metadata. */
export interface SemanticHistoryTableDelivery extends SemanticTableDelivery {
  readonly mandatoryReferences?: readonly number[]
  readonly coverage: SemanticTableDelivery['coverage'] & {
    readonly supersededSources: readonly { readonly taskSourceIndex: number; readonly count: number }[]
  }
}

/** Count only superseded publication omissions without changing selected sources, mandatory records, or other omission reasons.
 * @param delivery - Expanded validated delivery with complete source coverage.
 * @returns Version-six display tables; counts never reconstruct or stand in for current publication evidence.
 */
export function semanticHistoryTableDelivery(delivery: SemanticDelivery): SemanticHistoryTableDelivery {
  const groups = new Map<string, { source: Extract<DevelopmentTaskContextSourceRef, { kind: 'task' }>; count: number }>()
  const omittedSources = delivery.coverage.omittedSources.filter(({ source, reason }) => {
    if (reason !== 'superseded' || source.kind !== 'publication') return true
    const task = { kind: 'task' as const, taskId: source.taskId, revision: source.revision }
    const key = semanticJson(task)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { source: task, count: 1 })
    else group.count++
    return false
  })
  const base = semanticMandatoryTableDelivery({ ...delivery, coverage: { ...delivery.coverage, omittedSources } })
  const sourceTable = [...base.sourceTable]
  const taskIndexes = new Map(sourceTable.flatMap((source, index) => source.kind === 'task'
    ? [[semanticJson({ kind: source.kind, taskId: source.taskId, revision: source.revision }), index] as const] : []))
  const supersededSources = [...groups].map(([key, group]) => {
    let taskSourceIndex = taskIndexes.get(key)
    if (taskSourceIndex === undefined) {
      taskSourceIndex = sourceTable.length
      sourceTable.push(group.source)
    }
    return { taskSourceIndex, count: group.count }
  }).sort((a, b) => a.taskSourceIndex - b.taskSourceIndex)
  return { ...base, sourceTable, coverage: { ...base.coverage, supersededSources },
    sourceReferences: base.sourceReferences + ' coverage.supersededSources counts superseded publications per taskSourceIndex; '
      + 'these historical omissions are not current evidence.' }
}
