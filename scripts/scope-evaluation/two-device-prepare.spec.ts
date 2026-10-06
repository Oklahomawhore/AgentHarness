/** Preparation rejects overwrite and keeps each controlled program local to its owning device. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDevice, runPreparation } from './two-device-prepare.ts'

vi.mock('./native-dependencies.ts', () => ({ resolveNativeModules: () => ({
  Session: 'file:///built/session.js', Catalog: 'file:///built/catalog.js', Llm: 'file:///built/llm.js',
}) }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<{ repo: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scope-device-preparation-'))
  roots.push(root)
  const repo = join(root, 'repo')
  for (const folder of ['scripts/scope-evaluation', 'packages/test-support/llm-replay/lib']) {
    await mkdir(join(repo, folder), { recursive: true })
  }
  for (const name of ['scripts/scope-evaluation/two-device-observer.mjs', 'scripts/scope-evaluation/two-device-prepare.ts',
    'packages/test-support/llm-replay/lib/index.js']) await writeFile(join(repo, name), 'controlled test artifact\n')
  return { repo, root }
}
it('keeps private and post-leave writes local and prepares all thirteen requests without writing business files', async () => {
  const { repo, root } = await fixture()
  const [a, b] = await Promise.all(['A', 'B'].map(role => prepareDevice({ repo, root: join(root, role), role: role as 'A' | 'B' })))
  expect(a).toMatchObject({ role: 'A', expectedRequests: 6, modelTrialsExecuted: 0 })
  expect(b).toMatchObject({ role: 'B', expectedRequests: 7, modelTrialsExecuted: 0 })
  if (a === undefined || b === undefined || b.files.private === undefined) throw new Error('device preparation missing')
  const nonceA = /A_SHARED_([^";]+)/.exec(a.files.shared.text)?.[1]
  const nonceB = /B_SHARED_([^";]+)/.exec(b.files.shared.text)?.[1]
  expect(nonceA).toBeTruthy(); expect(nonceB).toBeTruthy(); expect(nonceA).not.toBe(nonceB)
  const responsesA = await readFile(join(a.root, 'responses.json'), 'utf8')
  const responsesB = await readFile(join(b.root, 'responses.json'), 'utf8')
  expect(responsesA).not.toContain(nonceB); expect(responsesB).not.toContain(nonceA)
  expect(responsesB.indexOf('B_PRIVATE')).toBeLessThan(responsesB.indexOf('B_READY'))
  expect(responsesB.indexOf('B_SHARED')).toBeGreaterThan(responsesB.indexOf('B_RECEIVED'))
  expect(responsesB.indexOf('B_AFTER')).toBeGreaterThan(responsesB.indexOf('B_PUBLISHED'))
  for (const device of [a, b]) {
    expect(await readdir(join(device.workspace, 'project'))).toEqual([])
    expect(await readFile(join(device.root, 'device.json'), 'utf8')).toBe(JSON.stringify(device, null, 2) + '\n')
    const overlay = await readFile(device.overlayPath, 'utf8')
    expect(overlay).toContain('"compression": "none"')
    expect(overlay).toContain('"mode": "native"')
    expect(overlay).toContain('"expectedRequests": ' + String(device.expectedRequests))
    expect(Object.values(device.stages).map(stage => stage.prompt).join(' ')).not.toMatch(/SHARED|PRIVATE|AFTER_/)
  }
})
it('refuses existing roots before changing their contents and rejects malformed commands', async () => {
  const { repo, root } = await fixture()
  const occupied = join(root, 'occupied')
  await mkdir(occupied)
  await writeFile(join(occupied, 'sentinel'), 'retain')
  await expect(prepareDevice({ repo, root: occupied, role: 'A' })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readdir(occupied)).toEqual(['sentinel'])
  expect(await readFile(join(occupied, 'sentinel'), 'utf8')).toBe('retain')
  await expect(prepareDevice({ repo, root: 'relative', role: 'B' })).rejects.toThrow('absolute paths')
  await expect(runPreparation(['--output', occupied, '--role', 'C'])).rejects.toThrow('usage:')
})
