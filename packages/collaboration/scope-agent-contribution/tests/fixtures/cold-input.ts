/** Committed fixture inputs captured before shutdown can terminate their original source permission. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TestHost } from './hosts.ts'

/** Original file bytes and, when present, the fixture's one completed Session. */
export interface ColdInputs {
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  readonly events: readonly SessionEvent[]
}

/**
 * Read only named committed domains and the fixture Agent's flushed JSONL, never atomic-write temporary files.
 * @param host - private Host whose scenario has reached its required receipt or pending-sample checkpoint.
 * @param domains - exact durable domains needed by this recovery scenario.
 * @param agent - completed source Agent, or null when this owner has no Session.
 * @returns original inputs retained independently of subsequent Host disposal; not a cross-domain atomic backup.
 */
export async function captureColdInputs(host: TestHost, domains: readonly string[], agent: Agent | null): Promise<ColdInputs> {
  let events: readonly SessionEvent[] = []
  if (agent !== null) {
    expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
    events = agent.session.snapshotEvents()
    expect(await host.readEvents(agent)).toEqual(events)
  }
  const files = await Promise.all(domains.map(async (domain) => {
    const path = join('domains', `${domain}.json`)
    return { path, bytes: await readFile(join(host.root, path)) }
  }))
  if (agent !== null) {
    const logs = (await readdir(host.sessionsRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
    expect(logs).toHaveLength(1)
    const log = logs[0]
    if (log === undefined) throw new Error('Committed source Session missing')
    files.push({ path: join('sessions', log), bytes: await readFile(join(host.sessionsRoot, log)) })
  }
  return { files, events }
}

/**
 * Populate a private cold Host root from bytes captured before its predecessor shut down.
 * @param root - caller-owned empty directory; the caller has awaited the predecessor's disposal.
 * @param inputs - unchanged committed domain and Session bytes.
 * @returns after every recovery input has been written.
 */
export async function writeColdInputs(root: string, inputs: ColdInputs): Promise<void> {
  for (const file of inputs.files) {
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes)
  }
}
