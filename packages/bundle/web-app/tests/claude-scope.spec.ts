import { fileURLToPath } from 'node:url'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Config } from '@deepseek-ai/dsh-claude-scope'
import { expect, it } from 'vitest'

const rows = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  .flatMap(patch => patch.insert ?? [])
const row = rows.find(entry => entry.id === 'claude-scope')
if (row === undefined) throw new Error('Web composition must provide the Claude scope adapter')

it.each(['darwin', 'linux', 'win32'])('gates the descriptor adapter on the %s platform', (platform) => {
  expect(interpolate({ process: { platform } }, row.disabled)).toBe(platform === 'win32')
  expect(rows.find(entry => entry.id === 'development-task-context-backend')?.name)
    .toBe('@deepseek-ai/dsh-development-task-context/reported')
  expect(rows.some(entry => entry.name === '@deepseek-ai/dsh-development-task-context/facts')).toBe(false)
})

it.each([
  { mode: 'source', execArgv: ['--import', 'tsx/esm'], entry: '/checkout with spaces/src/bin.ts', cwd: '/checkout with spaces' },
  { mode: 'portable', execArgv: [], entry: '/portable/lib/bin.js', cwd: '/portable' },
])('resolves valid hook setup from the $mode launch without carrying Web CLI arguments', async ({ execArgv, entry, cwd }) => {
  const resolved: unknown = interpolate({
    dshHomePath: (path = '') => `/harness-home${path === '' ? '' : '/' + path}`,
    process: { execPath: '/node runtime/node', execArgv, argv: ['/node runtime/node', entry, 'web', '--port', '4000'], cwd: () => cwd },
  }, row.config)
  const parsed = await Config['~standard'].validate(resolved)
  expect(parsed.issues).toBeUndefined()
  expect(parsed).toMatchObject({ value: {
    descriptorPath: '/harness-home/claude-scope/connection.json',
    setup: {
      home: '/harness-home', profileName: 'claude-hook', launchCommand: '/node runtime/node',
      launchArgs: [...execArgv, entry], launchCwd: cwd,
    },
  } })
})
