// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
  WebBootEntry,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const PROVIDER_CLIENT_ID = 'provider/client'
const RUNTIME_CLIENT_ID = 'runtime/client'
const win = globalThis as DshWindow
const transportGlobal = globalThis as {
  __DSH_TRANSPORT__?: { loadBundle(url: string): Promise<void> }
}
const moduleFace = modulesClient as unknown as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete transportGlobal.__DSH_TRANSPORT__
  document.body.innerHTML = ''
})

/** Install the stable facade shape that the Host injects before AppWebEntry runs. */
function installFacade(
  create?: (options: ClientModuleCreateOptions) => modulesClient.ClientModuleSystem,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: create ?? (options => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleFace,
    }, options)),
  }
  win.__ModuleLoader__ = target
  return target
}

async function expectBootFailure(setup: () => void, message: string): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  setup()
  const entry = new AppWebEntry(container)
  await entry.run()
  expect(container.textContent).toContain(message)
  expect(error).toHaveBeenCalledOnce()
  await entry.dispose()
}

describe('bootstrap failure rendering', () => {
  it('renders a missing bootstrap facade', async () => {
    await expectBootFailure(
      () => { delete win.__ModuleLoader__ },
      'window.__ModuleLoader__ bootstrap facade is missing',
    )
  })

  it('renders a create failure owned by the facade', async () => {
    await expectBootFailure(() => {
      installFacade(() => { throw new Error('facade create failed') })
    }, 'facade create failed')
  })

  it('renders a malformed boot manifest', async () => {
    await expectBootFailure(() => {
      installFacade()
      delete win.__DSH_BOOT__
    }, 'window.__DSH_BOOT__ is missing or not an object')
  })

  it('renders a module-system construction failure', async () => {
    await expectBootFailure(() => {
      installFacade()
      const duplicate = { id: 'duplicate', url: '/duplicate/client.js', rev: '1' }
      win.__DSH_BOOT__ = {
        rev: 'graph',
        entries: [duplicate, duplicate],
        batches: [{ phase: 'application', url: '/batch.js', rev: 'batch', entries: ['duplicate'] }],
      }
    }, 'duplicate graph entry "duplicate"')
  })
})

describe('mounted client lifecycle', () => {
  it.each(['replacement', 'optional disable', 'remove', 'failed replacement', 'failed import', 'disable after failure'] as const)('follows client entry %s without mounting a partial application', async (operation) => {
    const events: string[] = []
    let failApply = false
    let failImport = false
    let provider: Context | undefined
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries = [MODULES_ID, 'renderer', 'lifecycle-provider'].map(id => ({ id, url: `/${id}.js?rev=1`, rev: '1' }))
    win.__DSH_BOOT__ = { rev: 'graph', entries, batches: [{ phase: 'application', url: '/application.js',
      rev: 'batch', entries: entries.map(row => row.id) }] }
    const providerRegistration: ClientBundleRegistration = { id: 'lifecycle-provider', factory: () => {
      if (failImport) throw new Error('fixture import failed')
      return { apply: (ctx: Context) => {
        if (failApply) throw new Error('fixture apply failed')
        provider = ctx
        ctx.effect(() => () => { events.push('provider-unload') })
      } }
    } }
    const entry = new AppWebEntry(container, {
      loadBundle: async () => {
        target.load({ id: 'renderer', factory: () => ({ apply: (ctx: Context) => {
          ctx.reflect.provide('uiRenderer', { mount: (element: HTMLElement) => {
            events.push('mount')
            element.textContent = 'mounted'
            return () => { events.push('unmount'); element.textContent = '' }
          } })
        } }) })
        target.load(providerRegistration)
      },
    })
    try {
      await entry.run()
      expect(container.textContent).toBe('mounted')
      if (provider === undefined) throw new Error('fixture provider did not activate')
      const loader = provider.get('loader')
      if (loader === undefined) throw new Error('fixture provider has no Loader')
      const modules = provider.get('modules')
      if (modules === undefined) throw new Error('fixture provider has no module system')
      const owner = [...loader.entries()].find(item => item.options.name === 'lifecycle-provider')
      if (owner === undefined || owner.fiber === undefined) throw new Error('fixture provider has no entry')
      if (operation === 'optional disable') {
        await owner.update({ disabled: true })
        expect(events).toEqual(['mount', 'provider-unload'])
        expect(container.textContent).toBe('mounted')
        return
      }
      if (operation === 'remove') {
        await loader.remove(owner.id)
        await expect.poll(() => container.textContent).toBe('mounted')
        expect(events).toEqual(['mount', 'unmount', 'provider-unload', 'mount'])
        return
      }
      const oldFiber = owner.fiber
      const runtime = oldFiber.runtime
      if (runtime === null) throw new Error('fixture provider has no runtime')
      owner.ctx.registry.delete(runtime.callback)
      while (oldFiber.inertia !== undefined) await oldFiber.inertia
      expect(events.slice(0, 3)).toEqual(['mount', 'unmount', 'provider-unload'])
      expect(container.textContent).toContain('Loading plugins…')
      delete owner.fiber
      if (operation === 'failed replacement' || operation === 'disable after failure') {
        failApply = true
        await expect(owner.refresh()).rejects.toThrow('fixture apply failed')
        expect(container.textContent).toContain('Failed to load plugins')
        expect(container.textContent).toContain('lifecycle-provider')
        failApply = false
      }
      if (operation === 'failed import') {
        modules.invalidate('lifecycle-provider', 'broken')
        failImport = true
        target.load(providerRegistration)
        await expect(owner.refresh()).rejects.toThrow('fixture import failed')
        expect(container.textContent).toContain('Failed to load plugins')
        expect(container.textContent).toContain('lifecycle-provider')
        modules.invalidate('lifecycle-provider', 'recovered')
        failImport = false
        target.load(providerRegistration)
      }
      if (operation === 'disable after failure') await owner.update({ disabled: true })
      else await owner.refresh()
      await loader.await()
      await expect.poll(() => container.textContent).toBe('mounted')
      expect(events).toEqual(['mount', 'unmount', 'provider-unload', 'mount'])
    } finally {
      await entry.dispose()
    }
  })
})

describe('plugin activation', () => {
  it('prefetches a parser-loaded immediate row through the injected bundle transport', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      {
        id: 'runtime',
        url: '/runtime.js',
        rev: '1',
        external: [PROVIDER_CLIENT_ID],
        immediately: true,
      },
      { id: 'provider', url: '/provider.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    const applicationUrl = '/application.js'
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{ phase: 'application', url: applicationUrl, rev: 'batch', entries: entries.map(row => row.id) }],
    }
    const loaded: string[] = []
    const registrations: ClientBundleRegistration[] = [
      {
        id: 'consumer',
        factory: require => ({
          apply: () => {
            expect((require(RUNTIME_CLIENT_ID) as { marker: string }).marker).toBe('provider')
          },
        }),
      },
      {
        id: 'provider',
        factory: () => ({ apply: () => {}, marker: 'provider' }),
      },
      {
        id: 'runtime',
        factory: require => ({
          apply: () => {},
          marker: (require(PROVIDER_CLIENT_ID) as { marker: string }).marker,
        }),
      },
      {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
          },
        }),
      },
    ]
    transportGlobal.__DSH_TRANSPORT__ = {
      loadBundle: async (url) => {
        loaded.push(url)
        if (url !== applicationUrl) throw new Error(`missing fixture batch ${url}`)
        for (const registration of registrations) target.load(registration)
      },
    }

    const entry = new AppWebEntry(container)
    await entry.run()

    expect(loaded).toEqual([applicationUrl])
    await entry.dispose()
  })

  it('allows a modules-dependent row to be created before the modules row', async () => {
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{
        phase: 'application',
        url: '/application.js',
        rev: 'batch',
        entries: entries.map(row => row.id),
      }],
    }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/consumer.js', {
        id: 'consumer',
        factory: () => ({
          inject: ['modules'],
          apply: (ctx: Context) => {
            expect(ctx.modules).toBeDefined()
            events.push('consumer')
          },
        }),
      }],
      ['/renderer.js', {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
        for (const registration of registrations.values()) target.load(registration)
      },
    })

    await entry.run()

    expect(target.mode).toBe('live')
    expect(events).toEqual(['consumer', 'mount'])
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })
})
