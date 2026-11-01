import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('routes current Tasks to SQLite with a one-time copy from their existing JSON backend', () => {
  const patches = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  expect(patches.find(row => row.id === 'storage-domain')).toMatchObject({
    config: { backend: 'json', routes: { development_context_tasks: 'sqlite' } },
  })
  expect(patches.flatMap(row => row.insert ?? []).find(row => row.id === 'storage-sqlite')).toMatchObject({
    config: { bootstrapFrom: 'json' },
  })
  expect(patches.find(row => row.id === 'storage-domain')?.config).not.toHaveProperty('routes.development_tasks')
})
