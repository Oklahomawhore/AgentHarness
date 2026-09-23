/** Browser assembly for the configurable development workbench. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DevWorkbenchPanel } from './DevWorkbenchPanel.tsx'
import { createDevWorkbenchInventory } from './inventory.ts'
import { en, NS, zh } from './locales.ts'
import { createDevWorkbenchPreferences } from './preferences.ts'
import type { DevWorkbenchPanelFace } from './slots.ts'

export type { DevWorkbenchPanelFace } from './slots.ts'
export type { DevWorkbenchPanelProps } from './DevWorkbenchPanel.tsx'

/** Required services for the footer action, localized copy, and Host Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.devWorkbench']

/** Mount one live inventory source and the integrated resizable panel. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dev-workbench: dictionaries')
  const inventory = createDevWorkbenchInventory({
    list: async () => {
      const result = await ctx.remote.devWorkbench.list()
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    },
    start: async (id) => {
      const result = await ctx.remote.devWorkbench.start(id)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    },
    stop: async (id) => {
      const result = await ctx.remote.devWorkbench.stop(id)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    },
  }, (error) => { console.error('[ui-dev-workbench] refresh failed:', error) })
  const preferences = createDevWorkbenchPreferences()

  ctx.on('connection/reset', () => { inventory.reset(); inventory.refresh() })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dev-workbench',
    order: 35,
    locale: NS,
    inject: (): DevWorkbenchPanelFace => ({
      hooks: { inventory, preferences },
      start: id => inventory.start(id),
      stop: id => inventory.stop(id),
      refresh: () => { inventory.refresh() },
      setPanelSize: (width, height) => { preferences.setPanelSize(width, height) },
      selectEntry: (id) => { preferences.selectEntry(id) },
      selectView: (entryId, viewId) => { preferences.selectView(entryId, viewId) },
    }),
  }, DevWorkbenchPanel))
  inventory.refresh()
}
