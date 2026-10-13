/** Version-seven delivery counts withdrawn publication identities while preserving complete terminal evidence. */
import { semanticHistoryTableDelivery, type SemanticHistoryTableDelivery } from './semantic-history-display.ts'
import type { SemanticDelivery } from './semantic-display.ts'
import { semanticJson } from './semantic-schema.ts'
import type { DevelopmentTaskContextSourceRef } from './types.ts'

/** Withdrawal counts refer to exact Task revisions; full publication identities remain in projection metadata. */
export interface SemanticWithdrawalTableDelivery extends SemanticHistoryTableDelivery {
  readonly coverage: SemanticHistoryTableDelivery['coverage'] & {
    readonly withdrawnSources: readonly { readonly taskSourceIndex: number; readonly count: number }[]
  }
}

/** Count withdrawn publication omissions without reducing terminal records or changing authorization and scheduling evidence.
 * @param delivery - Validated delivery with complete selected and omitted source metadata.
 * @returns Version-seven display with withdrawal counts and unchanged mandatory records.
 */
export function semanticWithdrawalTableDelivery(delivery: SemanticDelivery): SemanticWithdrawalTableDelivery {
  const groups = new Map<string, { source: Extract<DevelopmentTaskContextSourceRef, { kind: 'task' }>; count: number }>()
  const omittedSources = delivery.coverage.omittedSources.filter((item) => {
    if (item.reason !== 'withdrawn' || item.source.kind !== 'publication') return true
    const source = { kind: 'task' as const, taskId: item.source.taskId, revision: item.source.revision }
    const key = semanticJson(source)
    groups.set(key, { source, count: (groups.get(key)?.count ?? 0) + 1 })
    return false
  })
  const base = semanticHistoryTableDelivery({ ...delivery, coverage: { ...delivery.coverage, omittedSources } })
  const sourceTable = [...base.sourceTable]
  const withdrawnSources = [...groups.values()].map(({ source, count }) => {
    let taskSourceIndex = sourceTable.findIndex(row => row.kind === 'task'
      && row.taskId === source.taskId && row.revision === source.revision)
    if (taskSourceIndex === -1) {
      taskSourceIndex = sourceTable.length
      sourceTable.push(source)
    }
    return { taskSourceIndex, count }
  }).sort((a, b) => a.taskSourceIndex - b.taskSourceIndex)
  return { ...base, sourceTable, coverage: { ...base.coverage, withdrawnSources },
    sourceReferences: base.sourceReferences
      + ' coverage.withdrawnSources counts withdrawn publications per taskSourceIndex; their bodies are excluded.' }
}
