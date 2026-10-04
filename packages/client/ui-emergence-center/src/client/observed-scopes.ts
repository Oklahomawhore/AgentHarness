/** Owner-side approval state for remote Agent bindings in one selected Task. */

import type {
  DevelopmentTaskApproveObservedIntervalRequest, DevelopmentTaskEndObservedIntervalRequest,
  DevelopmentTaskGetRequest, DevelopmentTaskId, DevelopmentTaskObservedCandidate,
  DevelopmentTaskObservedInterval, DevelopmentTaskObservedReceipt,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Authenticated owner operations; candidates alone grant no observation permission. */
export interface ObservedScopePort {
  candidates(request: DevelopmentTaskGetRequest): Promise<readonly DevelopmentTaskObservedCandidate[]>
  intervals(request: DevelopmentTaskGetRequest): Promise<readonly DevelopmentTaskObservedInterval[]>
  approve(request: DevelopmentTaskApproveObservedIntervalRequest): Promise<DevelopmentTaskObservedInterval>
  end(request: DevelopmentTaskEndObservedIntervalRequest): Promise<DevelopmentTaskObservedReceipt>
}

/** Owner query results for one Task, with explicit loading and failure state. */
export interface ObservedScopeState {
  readonly taskId?: DevelopmentTaskId
  readonly candidates: readonly DevelopmentTaskObservedCandidate[]
  readonly intervals: readonly DevelopmentTaskObservedInterval[]
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
}

/** A selection-scoped source that rejects stale reads and connection generations. */
export interface ObservedScopeDirectory extends HostObservable<ObservedScopeState> {
  focus(taskId: DevelopmentTaskId | undefined): void
  refresh(): void
  reset(): void
  dispose(): void
  approve(request: DevelopmentTaskApproveObservedIntervalRequest): Promise<DevelopmentTaskObservedInterval>
  end(request: DevelopmentTaskEndObservedIntervalRequest): Promise<DevelopmentTaskObservedReceipt>
}

/**
 * Retain owner responses without letting an older read reverse a completed decision.
 * @param port - owner queries and mutations over generated Remotes.
 * @param onError - diagnostic callback for failed background reads.
 * @returns a stable source owned by the registering UI plugin.
 */
export function createObservedScopeDirectory(port: ObservedScopePort, onError: (error: unknown) => void): ObservedScopeDirectory {
  const listeners = new Set<() => void>()
  let snapshot: ObservedScopeState = { candidates: [], intervals: [], status: 'idle' }
  let active = true
  let generation = 0
  let revision = 0
  let reading: symbol | undefined
  let readAgain = false
  const report = (error: unknown): void => {
    try { onError(error) }
    catch { /* Diagnostics cannot interrupt query settlement or other subscribers. */ }
  }
  const publish = (next: ObservedScopeState): void => {
    snapshot = next
    for (const listener of [...listeners]) {
      try { listener() }
      catch (error) { report(error) }
    }
  }
  const refresh = (): void => {
    const taskId = snapshot.taskId
    if (!active || taskId === undefined) return
    revision += 1
    if (reading !== undefined) { readAgain = true; return }
    const token = Symbol()
    const issued = generation
    const atRevision = revision
    reading = token
    const read = async (): Promise<void> => {
      try {
        const [candidates, intervals] = await Promise.all([port.candidates({ taskId }), port.intervals({ taskId })])
        if (active && issued === generation && atRevision === revision) publish({ taskId, candidates, intervals, status: 'ready' })
      } catch (error) {
        if (active && issued === generation && atRevision === revision) {
          report(error)
          publish({ ...snapshot, status: 'error' })
        }
      } finally {
        if (reading === token) {
          reading = undefined
          if (readAgain) { readAgain = false; refresh() }
        }
      }
    }
    void read()
  }
  const focus = (taskId: DevelopmentTaskId | undefined): void => {
    if (!active) return
    if (snapshot.taskId === taskId) { refresh(); return }
    generation += 1
    reading = undefined
    readAgain = false
    publish({ ...(taskId === undefined ? {} : { taskId }), candidates: [], intervals: [], status: taskId === undefined ? 'idle' : 'loading' })
    refresh()
  }
  const isCurrent = (issued: number, taskId: DevelopmentTaskId): boolean =>
    active && issued === generation && snapshot.taskId === taskId
  const mutate = async <T>(
    taskId: DevelopmentTaskId, operation: () => Promise<T>, interval: (value: T) => DevelopmentTaskObservedInterval,
  ): Promise<T> => {
    if (!active) throw new Error('Observed scope directory is disposed')
    const issued = generation
    revision += 1
    if (reading !== undefined) readAgain = true
    try {
      const value = await operation()
      if (isCurrent(issued, taskId)) {
        revision += 1
        const received = interval(value)
        const previous = snapshot.intervals.find(item => item.id === received.id)
        const next = previous?.state === 'ended' ? previous : received
        publish({ ...snapshot, intervals: [...snapshot.intervals.filter(item => item.id !== next.id), next], status: 'ready' })
      }
      return value
    } finally {
      if (isCurrent(issued, taskId)) refresh()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    focus, refresh,
    reset() {
      if (!active) return
      generation += 1
      reading = undefined
      readAgain = false
      publish({ candidates: [], intervals: [], status: 'idle' })
    },
    dispose() { active = false; generation += 1; listeners.clear() },
    approve: request => mutate(request.taskId, () => port.approve(request), value => value),
    end: request => mutate(request.taskId, () => port.end(request), (receipt) => {
      const previous = snapshot.intervals.find(item => item.id === receipt.intervalId)
      return {
        ...request, id: receipt.intervalId, state: 'ended', endReceipt: receipt,
        ...(previous?.approvalReceipt === undefined ? {} : { approvalReceipt: previous.approvalReceipt }),
      }
    }),
  }
}
