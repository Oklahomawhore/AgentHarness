/** Source-fair selection attempts for bounded literal reports; source association does not establish causal relevance. */

/** One already filtered, indivisible publication group and its exact snapshot/source partition. */
export interface ReportedSelectionGroup<T> {
  readonly value: T
  readonly source: string
  readonly kind: 'terminal' | 'command' | 'completed-answer' | 'file' | 'other'
  readonly publishedAt: number
}

/**
 * Prioritize withdrawals, then current commands and completed answers across sources, command file progress, and remaining groups.
 * An oversized group is skipped atomically; each source yields after one successful admission or exhausting its queue.
 * @param groups - Complete eligible groups in captured source order; source keys separate frozen snapshots and authorizations.
 * @param admit - Try the full rendered group against the actual budget, retaining it only on success.
 */
export function selectReportedGroups<T>(groups: readonly ReportedSelectionGroup<T>[], admit: (value: T) => boolean): void {
  const ordered = groups.map((group, ordinal) => ({ ...group, ordinal }))
    .sort((left, right) => right.publishedAt - left.publishedAt || left.ordinal - right.ordinal)
  type Group = (typeof ordered)[number]
  const pending = new Set(ordered)
  const acceptedCommands = new Set<string>()
  const attempt = (group: Group): boolean => {
    pending.delete(group)
    const accepted = admit(group.value)
    if (accepted && group.kind === 'command') acceptedCommands.add(group.source)
    return accepted
  }
  const queues = (candidates: readonly Group[]): Group[][] => {
    const sources = new Map<string, Group[]>()
    for (const group of candidates) {
      const queue = sources.get(group.source)
      if (queue === undefined) sources.set(group.source, [group])
      else queue.push(group)
    }
    return [...sources.values()]
  }
  const visit = (queue: Group[]): void => {
    let group: Group | undefined
    while ((group = queue.shift()) !== undefined) if (attempt(group)) return
  }
  const roundRobin = (buckets: Group[][]): void => {
    while (buckets.some(queue => queue.length > 0)) for (const queue of buckets) visit(queue)
  }
  for (const group of ordered) if (group.kind === 'terminal') attempt(group)
  roundRobin(queues(ordered.filter(group => group.kind === 'command' || group.kind === 'completed-answer')))
  for (const queue of queues(ordered.filter(group => group.kind === 'file' && acceptedCommands.has(group.source)))) visit(queue)
  roundRobin(queues(ordered.filter(group => pending.has(group))))
}
