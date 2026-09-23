import type { DevWorkbenchEntryId } from '@deepseek-ai/dsh-api-remotes/client'
import type { DevWorkbenchInventory } from './inventory.ts'
import type { DevWorkbenchPreferences } from './preferences.ts'

/** Business operations and live state injected into the workbench panel. */
export interface DevWorkbenchPanelFace {
  hooks: { inventory: DevWorkbenchInventory; preferences: DevWorkbenchPreferences }
  start(id: DevWorkbenchEntryId): Promise<void>
  stop(id: DevWorkbenchEntryId): Promise<void>
  refresh(): void
  setPanelSize: DevWorkbenchPreferences['setPanelSize']
  selectEntry: DevWorkbenchPreferences['selectEntry']
  selectView: DevWorkbenchPreferences['selectView']
}
