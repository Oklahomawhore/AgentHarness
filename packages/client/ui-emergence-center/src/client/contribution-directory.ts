/** Owned management reads and mutation settlement for source captures and owner grants. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Last confirmed management value; pending survives component remounts. */
export interface ContributionEntry<T> {
  readonly status: 'loading' | 'ready' | 'error'
  readonly pending: boolean
  readonly value?: T
  readonly error?: string
}

/** Keyed local management observations, never an authorization authority. */
export interface ContributionDirectory<K extends string, T> extends HostObservable<Readonly<Partial<Record<K, ContributionEntry<T>>>>> {
  refresh(key: K): Promise<void>
  invalidate(key: K): void
  more(key: K): Promise<void>
  mutate<R>(key: K, operation: () => Promise<R>): Promise<R | undefined>
  reset(): void
  dispose(): void
}

function code(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'contribution/unknown-outcome'
}

/**
 * Serialize UI mutations per selection and reread authority even after a lost reply.
 * @param read - read-only Host inventory or capture detail.
 * @param onError - local diagnostic observer, isolated from subscribers.
 * @returns stable observable management directory owned by the Client plugin.
 */
export function createContributionDirectory<K extends string, T>(
  read: (key: K, previous?: T) => Promise<T>, onError: (error: unknown) => void,
): ContributionDirectory<K, T> {
  const listeners = new Set<() => void>()
  const records = new Map<K, { revision: number; pending: boolean; read?: { revision: number; append: boolean; promise: Promise<void> } }>()
  // The generic mapped keys are all optional; TypeScript cannot infer that for {}.
  const empty = (): Readonly<Partial<Record<K, ContributionEntry<T>>>> => ({}) as Readonly<Partial<Record<K, ContributionEntry<T>>>>
  let snapshot = empty()
  let generation = 0
  let active = true
  const alive = (): boolean => active
  const report = (error: unknown): void => {
    try { onError(error) } catch { /* Diagnostics cannot interrupt management settlement. */ }
  }
  const publish = (key: K, value: ContributionEntry<T>): void => {
    snapshot = { ...snapshot, [key]: value }
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { report(error) }
    }
  }
  const record = (key: K) => {
    let value = records.get(key)
    if (value === undefined) { value = { revision: 0, pending: false }; records.set(key, value) }
    return value
  }
  const load = (key: K, clearError: boolean, append = false): Promise<void> => {
    if (!active) return Promise.resolve()
    const state = record(key)
    if (state.read?.revision === state.revision) {
      if (state.read.append === append) return state.read.promise
      state.revision += 1
    }
    const issued = generation
    const revision = state.revision
    const current = (): boolean => active && generation === issued && state.revision === revision
    const prior: ContributionEntry<T> | undefined = snapshot[key]
    const { error: _error, ...retained } = prior ?? { status: 'loading' as const, pending: state.pending }
    publish(key, { ...retained, status: 'loading', pending: state.pending,
      ...(!clearError && prior?.error !== undefined ? { error: prior.error } : {}) })
    const promise = (async () => {
      try {
        const value = await Promise.resolve().then(() => read(key, append ? snapshot[key]?.value : undefined))
        if (current()) publish(key, { ...snapshot[key], value, status: 'ready', pending: state.pending })
      } catch (error) {
        if (current()) { report(error); publish(key, { ...snapshot[key], status: 'error', pending: state.pending, error: code(error) }) }
      } finally {
        if (state.read?.revision === revision) delete state.read
      }
    })()
    state.read = { revision, append, promise }
    return promise
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh: key => load(key, true),
    invalidate(key) {
      if (!active || !records.has(key)) return
      record(key).revision += 1
      void load(key, false)
    },
    more: key => load(key, true, true),
    async mutate(key, operation) {
      if (!active) return
      const state = record(key)
      if (state.pending) return
      const issued = generation
      const current = (): boolean => active && generation === issued
      state.pending = true
      state.revision += 1
      const prior: ContributionEntry<T> | undefined = snapshot[key]
      const { error: _error, ...retained } = prior ?? { status: 'loading' as const, pending: true }
      publish(key, { ...retained, pending: true })
      let result: Awaited<ReturnType<typeof operation>> | undefined
      try { result = await operation() }
      catch (error) {
        if (current()) {
          report(error)
          publish(key, { ...snapshot[key], status: snapshot[key]?.status ?? 'loading', pending: true, error: code(error) })
        }
      } finally {
        // A connection reset cannot cancel a mutation already sent to the Host.
        if (alive()) {
          state.revision += 1
          while (alive()) {
            const observedGeneration = generation
            const observedRevision = state.revision
            await load(key, false)
            if (!alive()) break
            if (observedGeneration !== generation || observedRevision !== state.revision) continue
            state.pending = false
            publish(key, { ...snapshot[key], status: snapshot[key]?.status ?? 'error', pending: false })
            break
          }
        }
      }
      return current() ? result : undefined
    },
    reset() {
      if (!active) return
      generation += 1
      const keys = [...records.keys()]
      snapshot = empty()
      for (const key of keys) {
        record(key).revision += 1
        void load(key, true)
      }
    },
    dispose() { active = false; generation += 1; records.clear(); listeners.clear() },
  }
}
