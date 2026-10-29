import type {
  DevWorkbenchEntryId,
  DevWorkbenchEntrySnapshot,
  DevWorkbenchSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** RPC operations used by the development workbench browser surface. */
export interface DevWorkbenchPort {
  list(): Promise<DevWorkbenchSnapshot>
  start(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot>
  stop(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot>
}

/** Last known Host workbench state. */
export interface DevWorkbenchInventorySnapshot extends DevWorkbenchSnapshot {
  readonly read: boolean
  readonly error?: string
}

/** Observable Host state with explicit read and lifecycle actions. */
export interface DevWorkbenchInventory extends HostObservable<DevWorkbenchInventorySnapshot> {
  refresh(): void
  start(id: DevWorkbenchEntryId): Promise<void>
  stop(id: DevWorkbenchEntryId): Promise<void>
  reset(): void
}

/**
 * Create a single-flight workbench state source owned by one client plugin run.
 * Completed actions supersede pending list replies and trigger one subsequent baseline read.
 * Actions from replaced Hosts settle without publication; current-Host action failures reject.
 * Reset discards obsolete action results and failures; current Host failures reject the action.
 * @param port - Host operations used to read and control configured tasks.
 * @param onError - Observer for refresh failures after stale reads are discarded.
 * @returns Stable observable state and task lifecycle actions.
 */
export function createDevWorkbenchInventory(
  port: DevWorkbenchPort,
  onError: (error: unknown) => void,
): DevWorkbenchInventory {
  const store = createSnapshotStore<DevWorkbenchInventorySnapshot>({ entries: [], read: false })
  let inFlight: Promise<void> | undefined
  let generation = 0

  const refresh = (): void => {
    if (inFlight !== undefined) return
    const issued = generation
    let observed = store.getSnapshot()
    inFlight = port.list().then(
      (next) => {
        if (issued !== generation || store.getSnapshot() !== observed) return
        observed = { entries: next.entries, read: true }
        store.set(observed)
      },
      (error: unknown) => {
        if (issued !== generation || store.getSnapshot() !== observed) return
        onError(error)
        observed = { ...store.getSnapshot(), error: error instanceof Error ? error.message : String(error) }
        store.set(observed)
      },
    ).then(() => {
      if (issued !== generation) return
      inFlight = undefined
      if (store.getSnapshot() !== observed) refresh()
    })
  }
  const run = async (
    operation: (id: DevWorkbenchEntryId) => Promise<DevWorkbenchEntrySnapshot>,
    id: DevWorkbenchEntryId,
  ): Promise<void> => {
    const issued = generation
    let entry: DevWorkbenchEntrySnapshot
    try { entry = await operation(id) }
    catch (error) {
      if (issued !== generation) return
      throw error
    }
    if (issued !== generation) return
    store.set({
      entries: store.getSnapshot().entries.map(current => current.id === id ? entry : current),
      read: true,
    })
    refresh()
  }

  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    refresh,
    start: id => run(entryId => port.start(entryId), id),
    stop: id => run(entryId => port.stop(entryId), id),
    reset() {
      generation += 1
      inFlight = undefined
      store.set({ entries: [], read: false })
    },
  }
}
