/** Browser-local workbench geometry and selection preferences. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DevWorkbenchEntryId, DevWorkbenchViewId } from '@deepseek-ai/dsh-api-remotes/client'

/** Persisted workbench choices restored across reloads. */
export interface DevWorkbenchPreferencesSnapshot {
  width?: number
  height?: number
  selectedEntryId?: DevWorkbenchEntryId
  selectedViewByEntry: Record<string, DevWorkbenchViewId>
}

/** Observable preferences plus their complete write set. */
export interface DevWorkbenchPreferences extends HostObservable<DevWorkbenchPreferencesSnapshot> {
  setPanelSize(width: number, height: number): void
  selectEntry(id: DevWorkbenchEntryId): void
  selectView(entryId: DevWorkbenchEntryId, viewId: DevWorkbenchViewId): void
}

const INITIAL: DevWorkbenchPreferencesSnapshot = { selectedViewByEntry: {} }

function isPreferences(value: unknown): value is DevWorkbenchPreferencesSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const validDimension = (dimension: unknown): boolean =>
    dimension === undefined || (typeof dimension === 'number' && Number.isFinite(dimension) && dimension > 0)
  if (!validDimension(candidate.width) || !validDimension(candidate.height)) return false
  if (candidate.selectedEntryId !== undefined && typeof candidate.selectedEntryId !== 'string') return false
  const views = candidate.selectedViewByEntry
  return typeof views === 'object'
    && views !== null
    && !Array.isArray(views)
    && Object.entries(views).every(([entryId, viewId]) => entryId.length > 0 && typeof viewId === 'string')
}

/**
 * Create the root-scoped persisted workbench preferences.
 * Invalid localStorage values reset before any component reads them.
 * @returns Observable preferences and mutation methods.
 */
export function createDevWorkbenchPreferences(): DevWorkbenchPreferences {
  const store = createSnapshotStore<DevWorkbenchPreferencesSnapshot>(INITIAL, {
    persist: { name: 'dsh.dev-workbench.view.v1' },
  })
  if (!isPreferences(store.getSnapshot())) store.set(INITIAL)
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    setPanelSize(width, height) {
      store.update((draft) => {
        draft.width = width
        draft.height = height
      })
    },
    selectEntry(id) {
      store.update((draft) => { draft.selectedEntryId = id })
    },
    selectView(entryId, viewId) {
      store.update((draft) => { draft.selectedViewByEntry[entryId] = viewId })
    },
  }
}
