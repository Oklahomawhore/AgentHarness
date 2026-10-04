/** Observable local Claude sessions and project hook setup results. */

import type {
  ClaudeScopeJoinRequest, ClaudeScopeLeaveRequest, ClaudeScopeSessionSummary,
  ClaudeScopeSetupRequest, ClaudeScopeSetupResult, ClaudeScopeProjectSetupResult, ClaudeScopeRemoveSetupResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Authenticated Host operations used by the Claude connection panel. */
export interface ClaudeScopePort {
  sessions(): Promise<readonly ClaudeScopeSessionSummary[]>
  setup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeSetupResult>
  projectSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeProjectSetupResult>
  removeSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeRemoveSetupResult>
  join(request: ClaudeScopeJoinRequest): Promise<ClaudeScopeSessionSummary>
  leave(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary>
}

/** Observed Host state; setup and membership establish no model receipt. */
export interface ClaudeScopeState {
  readonly sessions: readonly ClaudeScopeSessionSummary[]
  readonly status: 'loading' | 'ready' | 'unavailable' | 'error'
  readonly project?: ClaudeScopeProjectSetupResult
}

/** Recipient identities and setup outcomes retained across panel remounts. */
export interface ClaudeScopeDirectory extends HostObservable<ClaudeScopeState> {
  refresh(): void
  reset(): void
  dispose(): void
  setup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeSetupResult>
  projectSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeProjectSetupResult>
  removeSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeRemoveSetupResult>
  join(request: ClaudeScopeJoinRequest): Promise<ClaudeScopeSessionSummary>
  leave(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary>
}

/**
 * Keep old reads and connection generations from replacing newer user actions.
 * @param port - generated Remote calls, unwrapped by the plugin assembly.
 * @param onError - diagnostic observer for background read failures.
 * @returns one stable observable source and its owned operations.
 */
export function createClaudeScopeDirectory(port: ClaudeScopePort, onError: (error: unknown) => void): ClaudeScopeDirectory {
  const listeners = new Set<() => void>()
  const mutations = new Map<string, symbol>()
  let snapshot: ClaudeScopeState = { sessions: [], status: 'loading' }
  let generation = 0
  let revision = 0
  let setupRevision = 0
  let active = true
  let inFlight: symbol | undefined
  let refreshAfterRead = false
  const report = (error: unknown): void => {
    try { onError(error) }
    catch { /* Diagnostic callbacks cannot interrupt state publication or read settlement. */ }
  }
  const publish = (next: ClaudeScopeState): void => {
    snapshot = next
    for (const listener of [...listeners]) {
      try { listener() }
      catch (error) { report(error) }
    }
  }
  const invalidateReads = (): void => {
    revision += 1
    if (inFlight !== undefined) refreshAfterRead = true
  }
  const ensureActive = (): void => {
    if (!active) throw new Error('Claude scope directory is disposed')
  }
  const refresh = (): void => {
    if (!active) return
    if (inFlight !== undefined) { invalidateReads(); return }
    const request = Symbol()
    const issued = generation
    const atRevision = revision
    inFlight = request
    const read = async (): Promise<void> => {
      try {
        const sessions = await port.sessions()
        if (active && issued === generation && atRevision === revision) publish({ ...snapshot, sessions, status: 'ready' })
      } catch (error) {
        if (!active || issued !== generation || atRevision !== revision) return
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        const unavailable = code === 'gateway/service-unavailable' || code === 'gateway/method-unavailable'
        if (!unavailable) report(error)
        publish({ ...snapshot, status: unavailable ? 'unavailable' : 'error' })
      } finally {
        if (inFlight === request) {
          inFlight = undefined
          if (refreshAfterRead) { refreshAfterRead = false; refresh() }
        }
      }
    }
    void read()
  }
  const mutate = async (
    request: ClaudeScopeJoinRequest | ClaudeScopeLeaveRequest,
    operation: () => Promise<ClaudeScopeSessionSummary>,
  ): Promise<ClaudeScopeSessionSummary> => {
    ensureActive()
    const issued = generation
    const token = Symbol()
    mutations.set(request.sessionKey, token)
    invalidateReads()
    try {
      const session = await operation()
      if (active && issued === generation && mutations.get(request.sessionKey) === token) {
        const retained = snapshot.sessions.some(item => item.sessionKey === session.sessionKey)
        const sessions = retained
          ? snapshot.sessions.map(item => item.sessionKey === session.sessionKey ? session : item)
          : [...snapshot.sessions, session]
        publish({ ...snapshot, sessions, status: 'ready' })
      }
      return session
    } finally {
      if (active && issued === generation) invalidateReads()
      if (mutations.get(request.sessionKey) === token) mutations.delete(request.sessionKey)
    }
  }
  const projectOperation = async <T>(
    operation: () => Promise<T>, project: (result: T) => ClaudeScopeProjectSetupResult,
  ): Promise<T> => {
    ensureActive()
    const issued = generation
    const atRevision = ++setupRevision
    const result = await operation()
    if (active && issued === generation && atRevision === setupRevision) publish({ ...snapshot, project: project(result) })
    return result
  }
  refresh()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    reset() {
      if (!active) return
      generation += 1
      inFlight = undefined
      refreshAfterRead = false
      mutations.clear()
      publish({ sessions: [], status: 'loading' })
      refresh()
    },
    dispose() { active = false; generation += 1; listeners.clear(); mutations.clear() },
    setup: request => projectOperation(() => port.setup(request), result => ({ ...result, state: 'configured' })),
    projectSetup: request => projectOperation(() => port.projectSetup(request), result => result),
    removeSetup: request => projectOperation(() => port.removeSetup(request), result => ({ ...result, state: 'not-configured' })),
    join: request => mutate(request, () => port.join(request)),
    leave: request => mutate(request, () => port.leave(request)),
  }
}
