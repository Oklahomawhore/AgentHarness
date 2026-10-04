/** Public artifact resolution runs without the driver's tsx source-path resolver. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Resolve explicit dependency-owner public exports in a loader-free inspection process.
 * @param repo Absolute checkout with freshly built workspace packages.
 * @returns Public runtime module URLs; TypeScript source URLs are refused.
 */
export function resolveNativeModules(repo: string): Readonly<Record<string, string>> {
  const text = execFileSync(process.execPath, [fileURLToPath(new URL('./native-resolve.mjs', import.meta.url)), repo], {
    encoding: 'utf8', env: {}, timeout: 10000, maxBuffer: 262144,
  })
  return z.record(z.string(), z.string().startsWith('file:').refine(value => /\.m?js$/.test(value)))
    .parse(JSON.parse(text) as unknown)
}
