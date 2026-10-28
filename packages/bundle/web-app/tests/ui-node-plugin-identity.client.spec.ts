import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as EmergenceCenter from '@deepseek-ai/dsh-client-ui-emergence-center'
import * as DevWorkbench from '@deepseek-ai/dsh-client-ui-dev-workbench'
import PluginInventoryGateway from '@deepseek-ai/dsh-host-plugin-inventory'
import { expect, it } from 'vitest'

it('keeps the workbench active when the emergence UI runtime is removed', async () => {
  const rows = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  const modules = new Map([
    ['@deepseek-ai/dsh-client-ui-emergence-center', EmergenceCenter],
    ['@deepseek-ai/dsh-client-ui-dev-workbench', DevWorkbench],
  ])
  const ctx = new Context()
  try {
    ctx.baseUrl = new URL('../', import.meta.url).href
    await ctx.plugin(Loader)
    // This in-memory composition imports the actual source namespaces without Node's internal loader hooks.
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const plugin = modules.get(specifier)
        if (plugin === undefined) throw new Error(`Unexpected UI import: ${specifier}`)
        return plugin
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.plugin(PluginInventoryGateway)
    const inventory: unknown = ctx.get('pluginInventory')
    if (!(inventory instanceof PluginInventoryGateway)) throw new Error('Plugin inventory must be mounted')

    for (const moduleName of modules.keys()) {
      const row = rows.find(entry => entry.name === moduleName)
      if (row === undefined) throw new Error(`Web composition must provide ${moduleName}`)
      await ctx.loader.create(row)
    }
    await ctx.loader.await()
    const before = await inventory.list()
    expect(before.entries).toHaveLength(2)
    for (const moduleName of modules.keys()) {
      expect(before.entries.find(entry => entry.moduleName === moduleName)).toMatchObject({
        enabled: true, fiberPhase: 'active',
      })
    }

    const runtime = ctx.registry.get(EmergenceCenter)
    if (runtime === undefined) throw new Error('Emergence UI runtime must be active')
    const fibers = [...runtime.fibers]
    ctx.registry.delete(EmergenceCenter)
    await Promise.all(fibers.map(fiber => fiber.await()))

    const after = await inventory.list()
    expect(after.entries.find(entry => entry.moduleName === '@deepseek-ai/dsh-client-ui-emergence-center'))
      .toMatchObject({ enabled: true, fiberPhase: null })
    expect(after.entries.find(entry => entry.moduleName === '@deepseek-ai/dsh-client-ui-dev-workbench'))
      .toMatchObject({ enabled: true, fiberPhase: 'active' })
  } finally {
    await ctx.fiber.dispose()
  }
})
