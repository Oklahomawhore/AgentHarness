/** Explicit network selection reaches the real built dsh profile without inheriting host secrets. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { resolveDataNetwork } from './data-network.ts'
import { resolveNativeModules } from './native-dependencies.ts'
import { launchNativeHost } from './native-run.ts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const enabled = process.env.DSH_NATIVE_EVALUATION === '1' && process.platform !== 'win32'
const envProxySupported = process.allowedNodeEnvironmentFlags.has('--use-env-proxy')

async function readReady(path: string, signal: AbortSignal): Promise<unknown> {
  for (;;) {
    signal.throwIfAborted()
    try { return JSON.parse(await readFile(path, 'utf8')) as unknown } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await delay(25, undefined, { signal })
  }
}

for (const kind of ['direct', 'env-proxy'] as const) {
  it.skipIf(!enabled || kind === 'env-proxy' && !envProxySupported)(`passes explicit ${kind} networking through the built dsh launcher`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-network-spec-'))
    let connections = 0
    const proxy = createServer((socket) => { ++connections; socket.destroy() })
    let host: Awaited<ReturnType<typeof launchNativeHost>> | undefined
    const lifetime = new AbortController()
    try {
      await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
      const address = proxy.address()
      if (address === null || typeof address === 'string') throw new Error('fake proxy listener has no loopback port')
      const proxyUrl = `http://127.0.0.1:${address.port}/`
      vi.stubEnv('HTTPS_PROXY', 'http://ambient-proxy.invalid:8080/')
      vi.stubEnv('https_proxy', 'http://ambient-proxy.invalid:8080/')
      vi.stubEnv('NO_PROXY', '*')
      vi.stubEnv('NODE_USE_ENV_PROXY', '1')
      vi.stubEnv('DSH_AMBIENT_TEST_KEY', 'ambient-not-a-secret')
      const modules = resolveNativeModules(repo)
      if (modules.Credentials === undefined) throw new Error('built credentials module missing')
      const observation = join(root, 'network-observation.json')
      const fixture = join(root, 'observe-credentials.mjs')
      await writeFile(fixture, `import { rename, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
export { default } from ${JSON.stringify(modules.Credentials)}
await writeFile(${JSON.stringify(observation + '.tmp')}, JSON.stringify({
  httpsProxy: process.env.HTTPS_PROXY ?? null,
  lowerProxy: process.env.https_proxy ?? null,
  noProxy: process.env.NO_PROXY ?? null,
  nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY ?? null,
  selectedKey: process.env.DSH_SELECTED_TEST_KEY ?? null,
  ambientKey: process.env.DSH_AMBIENT_TEST_KEY ?? null,
  httpProxyEnabled: http.globalAgent.options.proxyEnv !== undefined,
  httpsProxyEnabled: https.globalAgent.options.proxyEnv !== undefined,
}), { flag: 'wx', mode: 0o600 })
await rename(${JSON.stringify(observation + '.tmp')}, ${JSON.stringify(observation)})
`, { flag: 'wx', mode: 0o600 })
      const environment = resolveDataNetwork(kind === 'direct' ? { kind } : { kind, urlEnv: 'selected_proxy' },
        { selected_proxy: proxyUrl }, envProxySupported)
      host = await launchNativeHost(root, 'network', { repo, nodePath: process.execPath, cleanupTimeoutMs: 10000,
        environment: { ...environment, DSH_SELECTED_TEST_KEY: 'selected-not-a-secret' } },
      { ...modules, Credentials: pathToFileURL(fixture).href })
      const stopped = host.closed.then((result) => { throw new Error(`dsh exited before readiness: ${result.code}: ${result.stderr}`) })
      void stopped.catch(() => {}) // The readiness race below owns this rejection.
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)])
      const [record] = await Promise.race([Promise.all([readReady(observation, signal), readReady(join(host.directory, 'identity.json'), signal)]), stopped])
      expect(record).toEqual({ httpsProxy: kind === 'env-proxy' ? proxyUrl : null, lowerProxy: kind === 'env-proxy' ? proxyUrl : null,
        noProxy: kind === 'env-proxy' ? 'localhost,127.0.0.1,::1,[::1]' : null,
        nodeUseEnvProxy: kind === 'env-proxy' ? '1' : null,
        selectedKey: 'selected-not-a-secret', ambientKey: null,
        httpProxyEnabled: kind === 'env-proxy', httpsProxyEnabled: kind === 'env-proxy' })
    } finally {
      lifetime.abort()
      try {
        if (host !== undefined) {
          const result = await host.stop()
          expect(result.signal).not.toBe('SIGKILL')
        }
      } finally {
        vi.unstubAllEnvs()
        try {
          if (proxy.listening) await new Promise<void>((resolve, reject) => {
            proxy.close((error) => { if (error) reject(error); else resolve() })
          })
        } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
    expect(connections).toBe(0)
  }, 45000)
}
