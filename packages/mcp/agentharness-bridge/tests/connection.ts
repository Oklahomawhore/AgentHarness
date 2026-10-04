/** Private descriptor and authenticated fetch fixture shared by bridge tests. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { AgentHarnessRpcOptions } from '../src/rpc.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/**
 * Create a private descriptor and exchange fixture; only API requests reach the supplied fetcher.
 * @param fetcher - bounded API behavior under test.
 * @returns complete explicit RPC options.
 */
export async function connectionOptions(fetcher: typeof fetch): Promise<AgentHarnessRpcOptions> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'))
  directories.push(directory)
  const connectionPath = join(directory, 'connection.json')
  await writeFile(connectionPath, JSON.stringify({
    version: 1, generation: 'bridge-test', launchUrl: 'http://127.0.0.1:3080/?token=private-test-token',
  }), { mode: 0o600 })
  return {
    connectionPath, requestTimeoutMs: 1_000, maxDescriptorBytes: 16_384,
    maxRequestBytes: 32_768, maxResponseBytes: 32_768,
    fetch: async (input, init) => {
      if (init?.method === undefined || init.method === 'GET') {
        return new Response(null, {
          status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-fixture=v1.test.cookie; Path=/; HttpOnly' },
        })
      }
      if (new Headers(init?.headers).get('cookie') !== 'dsh-auth-fixture=v1.test.cookie') throw new Error('missing fixture cookie')
      return await fetcher(input, init)
    },
  }
}
