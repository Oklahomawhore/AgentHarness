/** Resolve only the selected proxy reference; calibration and direct routes never inherit ambient proxies. */
import type { DataModelRoute } from './data-study.ts'

/** Build the explicit proxy environment for a native model Host without retaining proxy values in registration.
 * @param network - Registered direct mode or the selected environment-variable reference.
 * @param environment - Launch environment; only network.urlEnv is read for proxy mode.
 * @param envProxySupported - Whether the running Node accepts --use-env-proxy.
 * @returns Child environment fields; HTTPS_PROXY may contain credentials and must not be logged or persisted.
 */
export function resolveDataNetwork(
  network: DataModelRoute['network'], environment: Readonly<NodeJS.ProcessEnv>, envProxySupported: boolean,
): NodeJS.ProcessEnv {
  if (network.kind === 'direct') return {}
  if (!envProxySupported) throw new Error('selected proxy networking requires Node support for --use-env-proxy')
  const value = environment[network.urlEnv]
  if (value === undefined || value.length === 0) throw new Error(`proxy environment reference ${network.urlEnv} is unavailable`)
  let url: URL
  try { url = new URL(value) } catch { throw new Error('selected proxy must be an absolute HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('selected proxy must use HTTP(S) without query or fragment')
  }
  return { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: url.href, NO_PROXY: 'localhost,127.0.0.1,::1' }
}
