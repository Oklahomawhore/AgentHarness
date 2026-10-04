/** Worker deployment choices are applied before the image's app-boot mounts entries. */
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerHost, type HostContext } from '../src/worker-host.ts'
import { IMAGE_MANIFEST_PATH, LOWERING_VERSION } from '../src/image-layout.ts'
import { packTar } from '../src/storage/tar.ts'

const realProcess = globalThis.process
const encoder = new TextEncoder()

afterEach(() => {
  ;(globalThis as { process: unknown }).process = realProcess
  vi.restoreAllMocks()
})

async function bootRows(rows: unknown[]): Promise<{ patches: unknown[]; source: unknown }> {
  const configPath = '/dsh/config/cordis.json'
  const image = gzipSync(packTar({
    'config/cordis.json': encoder.encode(JSON.stringify(rows)),
    [IMAGE_MANIFEST_PATH]: encoder.encode(JSON.stringify({ lowered: LOWERING_VERSION })),
  }))
  let observedPatches: unknown[] | undefined
  const dispose = vi.fn(() => Promise.resolve())
  const context: HostContext = {
    loader: { internal: undefined },
    logger: { exporter: () => undefined },
    get: (service) => {
      if (service === 'connection') return { createSharedFetchHandler: () => ({ fetch: () => Promise.resolve(new Response()) }) }
      if (service === 'typertGateway') return { wireStream: { open: () => undefined, failure: () => undefined } }
      return undefined
    },
    provide: () => {},
    fiber: { dispose },
  }
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const host = createWorkerHost({
    image,
    configPath,
    channel: { postMessage: () => {} },
    requestListener: () => Promise.reject(new Error('the boot fixture sends no HTTP requests')),
    staticModules: {
      '@deepseek-ai/dsh-app-boot': () => ({
        boot: (_name: string, path: string, patches: unknown[], prepare: (ctx: HostContext) => void) => {
          expect(path).toBe(configPath)
          observedPatches = patches
          prepare(context)
          return Promise.resolve(context)
        },
      }),
      '@deepseek-ai/dsh-cmdline': () => ({ provideCmdline: () => {} }),
      '@deepseek-ai/cordis': () => ({ Logger: { format: () => '' } }),
    },
  })
  try {
    await host.start()
    expect(context.loader.internal).toBeDefined()
    if (observedPatches === undefined || host.vfs === undefined) throw new Error('the worker did not reach app-boot')
    return { patches: observedPatches, source: JSON.parse(host.vfs.readFileSync(configPath, 'utf8') as string) as unknown }
  } finally {
    await host.stop()
    ;(globalThis as { process: unknown }).process = realProcess
    expect(dispose).toHaveBeenCalledOnce()
  }
}

describe('worker deployment boot patches', () => {
  it.each([false, true])('disables native integrations before app-boot (nested=%s)', async (nested) => {
    const mcp = { id: 'mcp-client-setup', name: '@deepseek-ai/dsh-host-mcp-client-setup', disabled: false }
    const claude = { id: 'claude-scope', name: '@deepseek-ai/dsh-claude-scope', disabled: false }
    const remotes = { id: 'remotes', name: '@deepseek-ai/dsh-api-remotes' }
    const peers = [{ id: 'scope-transport-libp2p', name: '@deepseek-ai/dsh-scope-transport/libp2p' }, { id: 'scope-access', name: '@deepseek-ai/dsh-scope-access' }, { id: 'scope-agent-context', name: '@deepseek-ai/dsh-scope-agent-context' }, { id: 'scope-agent-contribution', name: '@deepseek-ai/dsh-scope-agent-contribution' }]
    const mesh = ['development-mesh-websocket', 'development-room-mesh', 'development-task-mesh']
      .map(id => ({ id, name: `@deepseek-ai/dsh-${id}`, disabled: false }))
    const all = [mcp, claude, ...peers, ...mesh, remotes]
    const rows = nested ? [{ id: 'host', name: 'cordis:group', config: all }] : all
    const result = await bootRows(rows)
    expect(result.patches).toEqual([
      { id: 'mcp-client-setup', disabled: true }, { id: 'claude-scope', disabled: true }, ...[...peers, ...mesh].map(({ id }) => ({ id, disabled: true })),
    ])
    expect(result.source).toEqual(rows)
  })

  it('keeps unrelated storage routes while replacing native Task storage and its unsupported UI', async () => {
    const config = { backend: 'json', routes: { development_tasks: 'sqlite', settings: 'custom' } }
    const rows = [
      { id: 'storage-domain', config },
      { id: 'storage-sqlite', name: '@deepseek-ai/dsh-storage-sqlite' },
      { id: 'page', config: [{ id: 'ui-emergence-center', name: '@deepseek-ai/dsh-client-ui-emergence-center' }] },
    ]
    const result = await bootRows(rows)
    expect(result.patches).toEqual([
      { id: 'storage-domain', config: { backend: 'json', routes: { development_tasks: 'json', settings: 'custom' } } },
      { id: 'storage-sqlite', disabled: true },
      { id: 'ui-emergence-center', disabled: true },
    ])
    expect(result.source).toEqual(rows)
  })

  it('preserves a Task storage route that already selects another backend', async () => {
    const rows = [{ id: 'storage-domain', config: { backend: 'json', routes: { development_tasks: 'custom' } } }]
    const result = await bootRows(rows)
    expect(result.patches).toEqual([])
    expect(result.source).toEqual(rows)
  })

  it('does not invent a Claude entry when the composition omits it', async () => {
    const rows = [{ id: 'remotes', name: '@deepseek-ai/dsh-api-remotes' }]
    const result = await bootRows(rows)
    expect(result.patches).toEqual([])
    expect(result.source).toEqual(rows)
  })
})
