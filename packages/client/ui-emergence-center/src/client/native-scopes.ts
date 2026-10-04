/** Current-Session scope reads and mutations, isolated from stale connection and projection responses. */
import type {
  RemoteResult, ScopeAgentAutomaticPolicy, ScopeAgentBindRequest, ScopeAgentBindingId,
  ScopeAgentBindLocalRequest, ScopeAgentLeaveLocalTaskRequest, ScopeAgentLocalTaskTarget,
  ScopeAgentBindingRequest, ScopeAgentBindingStatus, ScopeAgentResumeRequest, ScopeAgentStatusResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Generated Remote operations used by one mounted Session entry. */
export interface NativeScopePort {
  readonly status: (request: { agentId: SessionId }) => Promise<RemoteResult<ScopeAgentStatusResult>>
  readonly bindLocal: (request: ScopeAgentBindLocalRequest) => Promise<RemoteResult<ScopeAgentBindingStatus>>
  readonly leaveLocalTask: (request: ScopeAgentLeaveLocalTaskRequest) => Promise<RemoteResult<ScopeAgentBindingStatus>>
  readonly bind: (request: ScopeAgentBindRequest) => Promise<RemoteResult<ScopeAgentBindingStatus>>
  readonly pause: (request: ScopeAgentBindingRequest) => Promise<RemoteResult<ScopeAgentBindingStatus>>
  readonly resume: (request: ScopeAgentResumeRequest) => Promise<RemoteResult<ScopeAgentBindingStatus>>
  readonly leave: (request: ScopeAgentBindingRequest) => Promise<RemoteResult<ScopeAgentBindingStatus>>
}

/** Local freshness and outcome; none of these fields assert remote authorization or model adoption. */
export interface NativeScopeSnapshot {
  readonly phase: 'loading' | 'ready' | 'disconnected' | 'unavailable' | 'error'
  readonly observation: ScopeAgentStatusResult | null
  readonly pending: boolean
  readonly issue: string | null
}

/** Explicit local action whose binding expectation belongs to the displayed form. */
export type NativeScopeAction =
  | { readonly kind: 'bind'; readonly request: Omit<ScopeAgentBindRequest, 'agentId'> }
  | { readonly kind: 'bindLocal'; readonly request: Omit<ScopeAgentBindLocalRequest, 'agentId'> }
  | { readonly kind: 'leaveLocalTask'; readonly request: Omit<ScopeAgentLeaveLocalTaskRequest, 'agentId'> }
  | { readonly kind: 'pause' | 'leave'; readonly expectedBindingId: ScopeAgentBindingId }
  | { readonly kind: 'resume'; readonly expectedBindingId: ScopeAgentBindingId; readonly automatic: ScopeAgentAutomaticPolicy }

/** Subscribed state plus explicit, single-flight mutations. */
export interface NativeScopeSource extends HostObservable<NativeScopeSnapshot> {
  /** Reconcile status without repeating any mutation. */
  readonly refresh: () => void
  /** Send one displayed intent, then refresh its actual outcome. */
  readonly act: (action: NativeScopeAction) => Promise<boolean>
}

/** All live observations are subscribed only while a framework hook observes this source. */
export interface NativeScopeDependencies {
  readonly agentId: SessionId
  readonly port: NativeScopePort
  readonly projection: HostObservable<unknown>
  readonly session: HostObservable<{ readonly running: boolean }>
  readonly connection: HostObservable<{ readonly id: number } | undefined>
  readonly subscribeAssignments: (listener: () => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
}

/**
 * Compare the Task assignment generation without treating a reused binding ID as consent.
 * @param left - the latest Host observation, or null when disconnected.
 * @param right - the target captured by the displayed intent.
 * @returns whether both observations select the exact same assignment.
 */
export function sameLocalTarget(left: ScopeAgentLocalTaskTarget | null, right: ScopeAgentLocalTaskTarget): boolean {
  return left !== null && left.taskId === right.taskId && left.taskBindingId === right.taskBindingId
    && left.expectedBindingEpoch.nodeId === right.expectedBindingEpoch.nodeId
    && left.expectedBindingEpoch.seq === right.expectedBindingEpoch.seq
}

/**
 * Isolate one Session's local status and actions across stream changes and connection resets.
 * @param deps - exact Session identity, Remote methods, and framework observations.
 * @returns a hook source that never starts a cold Agent or retries an uncertain mutation.
 */
export function createNativeScopeSource(deps: NativeScopeDependencies): NativeScopeSource {
  let snapshot: NativeScopeSnapshot = { phase: 'loading', observation: null, pending: false, issue: null }
  let active = false
  let generation = 0
  let revision = 0
  let reading: symbol | undefined
  let readAgain = false
  let mutation: symbol | undefined
  let watermark = -1
  let running = deps.session.getSnapshot().running
  let connection = deps.connection.getSnapshot()
  let disposers: readonly (() => void)[] = []
  const observing = (): boolean => active
  const listeners = new Set<() => void>()
  const publish = (next: NativeScopeSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) {
      try { listener() }
      catch (error) { console.error('[native-scope] subscriber failed:', error) }
    }
  }
  const refresh = (): void => {
    if (!active || connection === undefined) return
    revision++
    publish({ ...snapshot, phase: 'loading' })
    if (mutation !== undefined) { readAgain = true; return }
    if (reading !== undefined) { readAgain = true; return }
    const token = Symbol()
    reading = token
    readAgain = false
    const issued = generation
    const atRevision = revision
    const current = (): boolean => active && issued === generation && atRevision === revision
    const read = async (): Promise<void> => {
      try {
        const result = await deps.port.status({ agentId: deps.agentId })
        if (!current()) return
        if (!result.ok) {
          const absent = result.error.code === 'gateway/service-unavailable' || result.error.code === 'gateway/method-unavailable'
          publish({ ...snapshot, phase: absent ? 'unavailable' : 'error', observation: null })
          return
        }
        const value = result.value
        if (value.eligibility !== 'not-live') {
          if (value.asOfSeq < watermark) { publish({ ...snapshot, phase: 'error' }); return }
          watermark = value.asOfSeq
        }
        publish({ ...snapshot, phase: 'ready', observation: value })
      } catch {
        if (current()) publish({ ...snapshot, phase: 'error', observation: null })
      } finally {
        if (reading === token) {
          reading = undefined
          if (readAgain) { readAgain = false; refresh() }
        }
      }
    }
    void read()
  }
  const reset = (): void => {
    generation++
    revision++
    reading = undefined
    readAgain = false
    watermark = -1
    connection = deps.connection.getSnapshot()
    // A sent mutation can still commit. Keep its single-flight lock until settlement.
    publish({ phase: connection === undefined ? 'disconnected' : 'loading', observation: null,
      pending: mutation !== undefined, issue: mutation === undefined ? null : 'unknown' })
    refresh()
  }
  const start = (): void => {
    active = true
    running = deps.session.getSnapshot().running
    connection = deps.connection.getSnapshot()
    disposers = [
      deps.projection.subscribe(refresh),
      deps.subscribeAssignments(refresh),
      deps.session.subscribe(() => {
        const next = deps.session.getSnapshot().running
        if (next !== running) { running = next; refresh() }
      }),
      deps.connection.subscribe(reset),
      deps.subscribeReset(reset),
    ]
    reset()
  }
  const stop = (): void => {
    active = false
    generation++
    for (const dispose of disposers) dispose()
    disposers = []
    reading = undefined
    readAgain = false
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => { listeners.delete(listener); if (listeners.size === 0) stop() }
    },
    refresh,
    async act(action) {
      if (!active || connection === undefined || snapshot.phase !== 'ready' || mutation !== undefined) return false
      const observed = snapshot.observation
      if (observed === null || observed.eligibility === 'not-live') return false
      const expected = 'request' in action ? action.request.expectedBindingId : action.expectedBindingId
      if ((observed.state.binding?.id ?? null) !== expected) {
        publish({ ...snapshot, issue: 'scope-agent/stale-binding' }); refresh(); return false
      }
      const localAction = action.kind === 'bindLocal' || action.kind === 'leaveLocalTask'
      if (localAction && !sameLocalTarget(observed.localTask, action.request)) {
        publish({ ...snapshot, issue: 'scope-agent/stale-task' }); refresh(); return false
      }
      if (action.kind === 'bind' && observed.localTask !== null) return false
      if (action.kind !== 'leave' && action.kind !== 'pause' && action.kind !== 'leaveLocalTask'
        && observed.eligibility !== 'eligible' && !(localAction && observed.eligibility === 'task-conflict')) return false
      const token = Symbol()
      mutation = token
      const issued = generation
      const current = (): boolean => observing() && issued === generation
      const ownsMutation = (): boolean => mutation === token
      revision++
      publish({ ...snapshot, pending: true, issue: null })
      try {
        const result = action.kind === 'bind' ? await deps.port.bind({ ...action.request, agentId: deps.agentId })
          : action.kind === 'bindLocal' ? await deps.port.bindLocal({ ...action.request, agentId: deps.agentId })
            : action.kind === 'leaveLocalTask' ? await deps.port.leaveLocalTask({ ...action.request, agentId: deps.agentId })
              : action.kind === 'resume' ? await deps.port.resume({ agentId: deps.agentId,
                expectedBindingId: action.expectedBindingId, automatic: action.automatic })
                : await deps.port[action.kind]({ agentId: deps.agentId, expectedBindingId: action.expectedBindingId })
        if (!current()) return false
        if (!result.ok) {
          publish({ ...snapshot, issue: result.error.code.startsWith('scope-agent/') ? result.error.code : 'unknown' })
          return false
        }
        return true
      } catch {
        if (current()) publish({ ...snapshot, issue: 'unknown' })
        return false
      } finally {
        if (ownsMutation()) {
          mutation = undefined
          if (observing()) { publish({ ...snapshot, pending: false }); refresh() }
        }
      }
    },
  }
}
