/** The profile readiness marker appears only after its complete JSON has been written. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

interface ObserverContext {
  get(key: string): unknown
  effect(factory: () => unknown): void
  reflect: { store: Record<symbol, unknown> }
}
const observer = await import(new URL('../fixtures/scope-semantic-observer.mjs', import.meta.url).href) as {
  apply: (ctx: ObserverContext, config: { ready: string; project: string }) => void
}

it('publishes complete readiness JSON after the staged write finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-semantic-ready-'))
  const ready = join(root, 'ready.json')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const disposers: (() => unknown)[] = []
  let onReady: (() => Promise<void>) | undefined
  let publication: Promise<void> | undefined
  const group = { options: { id: 'development-task-context-audit', group: true, isolate: { sessionPersistence: true } }, subgroup: {} }
  const configured = { options: { id: 'development-task-context-backend', name: '@deepseek-ai/dsh-development-task-context/configured' }, disabled: false,
    parent: group.subgroup, fiber: { uid: 1, config: { selection: { mode: 'reported' } } } }
  const entries = [group, configured,
    { options: { id: 'scope-transport-libp2p' }, fiber: { config: { requestTimeoutMs: 35000, connectionTimeoutMs: 5000 } } },
    { options: { id: 'scope-access' }, fiber: { config: { requestTimeoutMs: 30000, waitTimeoutMs: 3000 } } },
    { options: { id: 'claude-scope' }, fiber: { config: { setup: { profileName: 'claude-hook-summaries', timeoutMs: 45000,
      hookTimeoutSeconds: 60 } } } },
  ]
  const services: Record<string, unknown> = {
    loader: { entries: () => entries },
    scopeAccess: { identity: async () => ({ peerId: 'fixture-peer', addresses: [] }) },
    developmentTaskContextBackend: { identity: { id: 'reported-files', revision: '6' } },
    appReady: { onReady(callback: () => Promise<void>) { onReady = callback } },
    webServer: { register: () => () => undefined },
  }
  vi.mocked(writeFile).mockImplementationOnce(async (file, content, options) => {
    assert(typeof content === 'string')
    const text = content
    await actual.writeFile(file, text.slice(0, Math.floor(text.length / 2)), options)
    entered.resolve(undefined)
    await release.promise
    await actual.writeFile(file, text)
  })
  try {
    observer.apply({
      get: key => services[key],
      effect(factory) {
        const disposer = factory()
        if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      },
      reflect: { store: { [Symbol('backend')]: { name: 'developmentTaskContextBackend',
        fiber: { parent: { fiber: configured.fiber } } } } },
    }, { ready, project: root })
    expect(onReady).toBeTypeOf('function')
    publication = onReady!()
    await Promise.race([entered.promise, publication.then(() => {
      throw new Error('Readiness publication ended before the write barrier')
    })])
    await expect(readFile(ready, 'utf8').then(text => JSON.parse(text) as unknown)).rejects.toMatchObject({ code: 'ENOENT' })
    const staged = await readdir(root)
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatch(/^ready\.json\..+\.tmp$/)
    release.resolve(undefined)
    await publication
    expect(JSON.parse(await readFile(ready, 'utf8')) as unknown).toMatchObject({
      backend: { id: 'reported-files', revision: '6' },
      configured: { enabled: true, groupId: 'development-task-context-audit', providerCount: 1 },
      transportTimeoutMs: 35000, accessTimeoutMs: 30000,
    })
    expect(await readdir(root)).toEqual(['ready.json'])
  } finally {
    release.resolve(undefined)
    try { await publication } finally {
      try { for (const dispose of disposers.reverse()) await dispose() } finally {
        vi.mocked(writeFile).mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
