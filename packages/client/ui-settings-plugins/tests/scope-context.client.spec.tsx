// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelProviderGroup, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { ScopeContextCard, type ScopeContextCardProps } from '../src/client/ScopeContextCard.tsx'
import { ScopeContextCardController, type ScopeContextSettings } from '../src/client/scope-context-card-controller.ts'
import { en, zh } from '../src/client/locales.ts'

const controllers: ScopeContextCardController[] = []
afterEach(() => { cleanup(); for (const controller of controllers.splice(0)) controller.dispose() })
const reported: ScopeContextSettings = { mode: 'reported', provider: '', model: '', maxCalls: 100 }
const semantic: ScopeContextSettings = { mode: 'semantic', provider: 'summary-owner', model: 'summary-model', maxCalls: 20 }
const groups: ModelProviderGroup[] = [{ id: semantic.provider, name: 'Summary provider',
  models: [{ id: semantic.model, name: 'Summary model' }] }]
const key = JSON.stringify([semantic.provider, semantic.model])
type Catalog = Awaited<ReturnType<ConstructorParameters<typeof ScopeContextCardController>[1]>>

function bench(value: ScopeContextSettings | undefined = reported) {
  const stub = stubSettingsScope<ScopeContextSettings>()
  const mutate = vi.fn<SettingsScope<ScopeContextSettings>['mutate']>()
  const host = { ...stub, scope: { ...stub.scope, mutate }, mutate }
  host.publish({ status: 'ready', mode: 'host', writable: true, revision: 3,
    ...(value === undefined ? {} : { value, base: value, user: {} }) })
  const catalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue({ ok: true, value: { default: { provider: 'ordinary', model: 'ordinary' }, routableProviders: [semantic.provider], groups, failures: [] } })
  const controller = new ScopeContextCardController(host.scope, catalog)
  controllers.push(controller)
  const face = controller.inject()
  const state = () => face.hooks.scopeContextCard.getSnapshot()
  const commit = (ops: readonly SettingsPathOpView[]) => {
    const entries = ops.map((op) => {
      if (op.op !== 'set' || op.path.length !== 1) throw new Error('Expected atomic summary preference fields')
      return [op.path[0], op.value]
    })
    const next = Object.fromEntries(entries) as ScopeContextSettings
    host.publish({ revision: (host.scope.getSnapshot().revision ?? 0) + 1, value: next, user: next })
  }
  mutate.mockImplementation((ops) => { commit(ops); return Promise.resolve() })
  return { host, catalog, controller, face, state, commit }
}
async function select(subject: ReturnType<typeof bench>) {
  subject.face.chooseMode('semantic')
  await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
  subject.face.chooseModel(key)
  subject.face.editMaxCalls('20')
}
function mount(subject: ReturnType<typeof bench>, locale = en) {
  const { hooks, ...actions } = subject.face
  const props = { ...actions, t: (name: keyof typeof en) => locale[name],
    useScopeContextCard: bindSnapshotSelector(hooks.scopeContextCard) } as ScopeContextCardProps
  render(<ul><ScopeContextCard {...props} /></ul>)
  fireEvent.click(screen.getByRole('button', { name: `${locale.expand}: ${locale.scopeContextTitle}` }))
}

describe('collaboration summary preferences', () => {
  it('keeps unavailable preferences non-writable until a Host snapshot arrives', () => {
    const scope = stubSettingsScope<ScopeContextSettings>()
    const catalog = vi.fn<() => Promise<Catalog>>()
    const controller = new ScopeContextCardController(scope.scope, catalog)
    controllers.push(controller)
    const face = controller.inject()
    expect(face.hooks.scopeContextCard.getSnapshot()).toMatchObject({ available: false, maxCalls: '', invalid: true })
    face.chooseMode('semantic'); face.save()
    expect(catalog).not.toHaveBeenCalled()
    scope.publish({ status: 'ready', mode: 'host', writable: true, revision: 1, value: reported })
    expect(face.hooks.scopeContextCard.getSnapshot()).toMatchObject({ available: true, maxCalls: '100', invalid: false })
  })

  it('requires an observed revision before writing a draft', () => {
    const stub = stubSettingsScope<ScopeContextSettings>()
    const mutate = vi.fn<SettingsScope<ScopeContextSettings>['mutate']>()
    stub.publish({ status: 'ready', mode: 'host', writable: true, value: reported })
    const controller = new ScopeContextCardController({ ...stub.scope, mutate }, vi.fn())
    controllers.push(controller)
    const face = controller.inject()
    face.editMaxCalls('2'); face.save()
    expect(face.hooks.scopeContextCard.getSnapshot().conflicted).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps reported mode and performs no implicit catalog or settings request', () => {
    const subject = bench()
    subject.face.save()
    expect(subject.state()).toMatchObject({ mode: 'reported', dirty: false, saved: false })
    expect(subject.catalog).not.toHaveBeenCalled()
    expect(subject.host.mutate).not.toHaveBeenCalled()
  })

  it('requires an explicit advertised route and writes the four fields atomically at the draft revision', async () => {
    const subject = bench()
    subject.face.chooseMode('semantic')
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
    expect(subject.state().invalid).toBe(true)
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.face.chooseModel('unknown')
    expect(subject.state().model).toBe('')
    await select(subject)
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().saved).toBe(true) })
    expect(subject.host.mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['mode'], value: 'semantic' },
      { op: 'set', path: ['provider'], value: 'summary-owner' },
      { op: 'set', path: ['model'], value: 'summary-model' },
      { op: 'set', path: ['maxCalls'], value: 20 },
    ], 3)
    expect(subject.state()).toMatchObject({ dirty: false, saved: true })
    expect(subject.state()).not.toHaveProperty('applied')
  })

  it('retains restart confirmation across duplicate Host refreshes until a newer revision arrives', async () => {
    const subject = bench()
    await select(subject)
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().saved).toBe(true) })
    subject.host.publish({ revision: 4, value: { ...semantic } })
    expect(subject.state()).toMatchObject({ saved: true, dirty: false })
    subject.host.publish({ revision: 5, value: { ...semantic, maxCalls: 21 } })
    expect(subject.state()).toMatchObject({ saved: false, maxCalls: '21', dirty: false })
  })

  it.each(['', '0', '-1', '1.2', '1e3', '9007199254740992', 'abc'])('rejects invalid cumulative limit %j', async (limit) => {
    const subject = bench()
    await select(subject)
    subject.face.editMaxCalls(limit); subject.face.save()
    expect(subject.state().invalid).toBe(true)
    expect(subject.host.mutate).not.toHaveBeenCalled()
  })

  it.each([{ mode: 'memory' as const, writable: true }, { mode: 'host' as const, writable: false },
    { status: 'loading' as const }])('does not edit Host settings from %j', (permission) => {
    const subject = bench()
    subject.host.publish(permission)
    subject.face.chooseMode('semantic'); subject.face.editMaxCalls('1'); subject.face.save()
    expect(subject.state()).toMatchObject({ writable: false, dirty: false })
    expect(subject.host.mutate).not.toHaveBeenCalled()
  })

  it('retains a removed model for inspection and lets the owner disable summaries while the catalog fails', async () => {
    const subject = bench(semantic)
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
    subject.catalog.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'catalog unavailable', {}) })
    subject.controller.refreshCatalog()
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('error') })
    expect(subject.state().candidates).toEqual([expect.objectContaining({ key, available: false })])
    subject.face.chooseModel(key); subject.face.save()
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.face.chooseMode('reported'); subject.face.save()
    await vi.waitFor(() => { expect(subject.state().saved).toBe(true) })
    expect(subject.host.scope.getSnapshot().value).toEqual({ ...semantic, mode: 'reported' })
  })

  it('invalidates a selected route until a refreshed catalog confirms it and ignores an older response', async () => {
    const subject = bench()
    await select(subject)
    const old = Promise.withResolvers<Catalog>()
    subject.catalog.mockReturnValueOnce(old.promise).mockResolvedValue({ ok: true, value: { default: { provider: 'ordinary', model: 'ordinary' }, routableProviders: [], groups: [], failures: [] } })
    subject.controller.refreshCatalog()
    subject.face.save()
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.face.retryCatalog()
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
    old.resolve({ ok: true, value: { default: { provider: 'ordinary', model: 'ordinary' }, routableProviders: [semantic.provider], groups, failures: [] } })
    await old.promise
    expect(subject.state()).toMatchObject({ invalid: true, candidates: [expect.objectContaining({ available: false })] })
  })

  it('retains a draft after a rejected catalog and can explicitly retry', async () => {
    const subject = bench()
    subject.catalog.mockRejectedValueOnce(new Error('offline'))
    subject.face.chooseMode('semantic')
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('error') })
    subject.face.retryCatalog()
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
    expect(subject.state()).toMatchObject({ mode: 'semantic', dirty: true })
  })

  it('requires discard when another settings revision replaces an unsent draft', async () => {
    const subject = bench()
    await select(subject)
    subject.host.publish({ revision: 4, value: { ...reported, maxCalls: 4 } })
    subject.face.save()
    expect(subject.host.mutate).not.toHaveBeenCalled()
    expect(subject.state().conflicted).toBe(true)
    subject.face.discard()
    expect(subject.state()).toMatchObject({ mode: 'reported', maxCalls: '4', dirty: false, conflicted: false })
  })

  it('keeps an in-flight save locked through reconnection and refuses its obsolete confirmation', async () => {
    const subject = bench()
    await select(subject)
    const pending = Promise.withResolvers<undefined>()
    subject.host.mutate.mockImplementation(() => pending.promise)
    subject.face.save(); subject.controller.resetConnection()
    subject.face.discard(); subject.face.chooseMode('reported'); subject.face.save()
    expect(subject.state()).toMatchObject({ saving: true, mode: 'semantic', conflicted: true })
    expect(subject.host.mutate).toHaveBeenCalledTimes(1)
    subject.commit(subject.host.mutate.mock.calls[0]![0]); pending.resolve(undefined)
    await vi.waitFor(() => { expect(subject.state().saving).toBe(false) })
    expect(subject.state()).toMatchObject({ saved: false, failed: true, conflicted: true })
    subject.face.discard()
    expect(subject.state()).toMatchObject({ dirty: false, failed: false })
  })

  it('does not confirm a write whose readback contains a concurrent winner', async () => {
    const subject = bench()
    await select(subject)
    subject.host.mutate.mockImplementation(() => {
      subject.host.publish({ revision: 5, value: { ...semantic, maxCalls: 3 } })
      return Promise.resolve()
    })
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().saving).toBe(false) })
    expect(subject.state()).toMatchObject({ failed: true, saved: false, dirty: true, maxCalls: '20' })
  })

  it('does not publish a successful write after the card has been disposed', async () => {
    const subject = bench()
    await select(subject)
    const pending = Promise.withResolvers<undefined>()
    subject.host.mutate.mockImplementation(() => pending.promise)
    subject.face.save()
    subject.controller.dispose()
    const snapshot = subject.state()
    subject.commit(subject.host.mutate.mock.calls[0]![0]); pending.resolve(undefined)
    await pending.promise
    expect(subject.state()).toBe(snapshot)
  })

  it('preserves failed writes for correction and ignores disposed pending writes and catalog failures', async () => {
    const subject = bench()
    await select(subject)
    subject.host.mutate.mockRejectedValueOnce(new Error('write failed'))
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().failed).toBe(true) })
    const pending = Promise.withResolvers<undefined>()
    const catalog = Promise.withResolvers<Catalog>()
    subject.host.mutate.mockImplementation(() => pending.promise)
    subject.face.save()
    subject.catalog.mockReturnValueOnce(catalog.promise); subject.controller.refreshCatalog()
    subject.controller.dispose()
    const state = subject.state()
    pending.reject(new Error('closed')); catalog.reject(new Error('closed'))
    await Promise.allSettled([pending.promise, catalog.promise])
    subject.face.discard(); subject.controller.resetConnection(); subject.controller.refreshCatalog()
    subject.face.chooseMode('reported'); subject.face.save()
    expect(subject.state()).toBe(state)
  })

  it('keeps an invalid limit visible when switching off summaries and permits correction', async () => {
    const subject = bench(semantic)
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
    mount(subject)
    fireEvent.change(screen.getByLabelText(en.scopeContextMaxCalls), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(en.scopeContextMode), { target: { value: 'reported' } })
    expect(screen.getByLabelText(en.scopeContextMaxCalls)).toBeTruthy()
    expect(screen.getByText(en.scopeContextInvalid)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.scopeContextMaxCalls), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await Promise.resolve() })
    expect(subject.host.scope.getSnapshot().value).toEqual({ ...semantic, mode: 'reported' })
  })

  it('shows partial catalog failure while permitting an explicitly advertised route', async () => {
    const subject = bench()
    subject.catalog.mockResolvedValue({ ok: true, value: { default: { provider: 'ordinary', model: 'ordinary' },
      routableProviders: [semantic.provider], groups, failures: [{ id: 'offline', name: 'Offline provider', message: 'offline' }] } })
    mount(subject)
    fireEvent.change(screen.getByLabelText(en.scopeContextMode), { target: { value: 'invalid-dom-value' } })
    expect(subject.state().mode).toBe('reported')
    fireEvent.change(screen.getByLabelText(en.scopeContextMode), { target: { value: 'semantic' } })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(en.scopeContextPartial)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.scopeContextModel), { target: { value: key } })
    expect(subject.state().invalid).toBe(false)
  })

  it.each([en, zh])('renders explicit route, budget, consent and restart-only save in both locales', async (locale) => {
    const subject = bench()
    mount(subject, locale)
    fireEvent.change(screen.getByLabelText(locale.scopeContextMode), { target: { value: 'semantic' } })
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByLabelText(locale.scopeContextModel), { target: { value: key } })
    fireEvent.change(screen.getByLabelText(locale.scopeContextMaxCalls), { target: { value: '20' } })
    expect(screen.getByText(locale.scopeContextDisclosure)).toBeTruthy()
    expect(screen.getByText(locale.scopeContextBudgetHint)).toBeTruthy()
    expect(screen.getByText(locale.scopeContextRestart)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: locale.save }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('status').textContent).toBe(locale.scopeContextSaved)
    expect(screen.queryByLabelText(locale.scopeContextMode)).toBeNull()
  })

  it('renders unavailable models, a catalog error and a retained save failure without closing the card', async () => {
    const subject = bench(semantic)
    await vi.waitFor(() => { expect(subject.state().catalogStatus).toBe('ready') })
    mount(subject)
    subject.catalog.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: en.scopeContextRetry }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(en.scopeContextLoadFailed)).toBeTruthy()
    expect(screen.getByRole('option', { name: `${semantic.provider} / ${semantic.model} (${en.scopeContextUnavailable})` })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.scopeContextMode), { target: { value: 'reported' } })
    subject.host.mutate.mockRejectedValueOnce(new Error('write failed'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByLabelText(en.scopeContextMode)).toBeTruthy()
    act(() => { subject.controller.resetConnection() })
    expect(screen.getByText(en.scopeContextConflict)).toBeTruthy()
  })
})
