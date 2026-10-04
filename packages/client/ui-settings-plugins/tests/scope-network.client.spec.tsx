// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { ScopeNetworkCard, type ScopeNetworkCardProps } from '../src/client/ScopeNetworkCard.tsx'
import { ScopeNetworkCardController, type ScopeNetworkSettings } from '../src/client/scope-network-card-controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const local = ['/ip4/127.0.0.1/tcp/0']
const lan = ['/ip4/0.0.0.0/tcp/41901']

function bench(addresses = local) {
  const stub = stubSettingsScope<ScopeNetworkSettings>()
  const mutate = vi.fn<SettingsScope<ScopeNetworkSettings>['mutate']>()
  const host = { ...stub, scope: { ...stub.scope, mutate }, mutate }
  host.publish({ status: 'ready', mode: 'host', writable: true, revision: 3,
    value: { listenAddresses: [...addresses] }, base: { listenAddresses: [...addresses] }, user: {} })
  const controller = new ScopeNetworkCardController(host.scope)
  const face = controller.inject()
  const state = () => face.hooks.scopeNetworkCard.getSnapshot()
  const commit = (ops: readonly SettingsPathOpView[]) => {
    const op = ops[0]
    if (op?.op !== 'set' || !Array.isArray(op.value) || !op.value.every(value => typeof value === 'string')) {
      throw new Error('Expected one listenAddresses array mutation')
    }
    host.publish({ revision: 4, value: { listenAddresses: [...op.value] }, user: { listenAddresses: [...op.value] } })
  }
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => { commit(ops); return Promise.resolve() })
  return { host, controller, face, state, commit }
}

function chooseLan(subject: ReturnType<typeof bench>): void {
  subject.face.chooseMode('lan')
  subject.face.editPort('41901')
}

function mount(subject: ReturnType<typeof bench>, locale = en) {
  const { hooks, ...actions } = subject.face
  const props = { ...actions, t: (key: keyof typeof en) => locale[key],
    useScopeNetworkCard: bindSnapshotSelector(hooks.scopeNetworkCard) } as ScopeNetworkCardProps
  render(<ul><ScopeNetworkCard {...props} /></ul>)
  fireEvent.click(screen.getByRole('button', { name: `${locale.expand}: ${locale.scopeNetworkTitle}` }))
}

describe('collaboration network preferences', () => {
  it('starts with the saved local choice and requires an explicit LAN port', () => {
    const subject = bench()
    expect(subject.state()).toMatchObject({ mode: 'local', dirty: false, saved: false })
    subject.face.chooseMode('lan')
    expect(subject.state()).toMatchObject({ mode: 'lan', port: '', invalid: true, dirty: true })
    subject.face.save()
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.controller.dispose()
  })

  it.each(['', '0', '-1', '65536', '1.5', '1e3', 'abc'])('does not save the invalid port %j', (port) => {
    const subject = bench()
    subject.face.editPort(port)
    subject.face.save()
    expect(subject.state().invalid).toBe(true)
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.controller.dispose()
  })

  it('saves exactly one address with the draft revision and only confirms persistence', async () => {
    const subject = bench()
    chooseLan(subject)
    subject.face.save()
    await vi.waitFor(() =>{  expect(subject.state().saving).toBe(false) })
    expect(subject.host.mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['listenAddresses'], value: lan },
    ], 3)
    expect(subject.state()).toMatchObject({ mode: 'lan', saved: true, dirty: false })
    expect(subject.state()).not.toHaveProperty('applied')
    subject.controller.resetConnection()
    expect(subject.state().saved).toBe(false)
    subject.controller.dispose()
  })

  it('disables external listeners only after an explicit local-mode save', async () => {
    const subject = bench(lan)
    subject.face.chooseMode('local')
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.face.save()
    await vi.waitFor(() =>{  expect(subject.state().saved).toBe(true) })
    expect(subject.host.scope.getSnapshot().value?.listenAddresses).toEqual(local)
    subject.controller.dispose()
  })

  it.each([
    ['/ip6/::1/tcp/42100'],
    ['/ip4/127.0.0.1/tcp/0', '/ip4/192.168.1.10/tcp/42100'],
  ])('preserves custom listener %j until explicit replacement', async (...addresses) => {
    const subject = bench(addresses)
    expect(subject.state()).toMatchObject({ mode: 'custom', customAddresses: addresses, dirty: false })
    subject.face.save()
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.face.chooseMode('local')
    subject.face.discard()
    expect(subject.state().customAddresses).toEqual(addresses)
    subject.face.chooseMode('local')
    subject.face.save()
    await vi.waitFor(() =>{  expect(subject.state().saved).toBe(true) })
    expect(subject.host.scope.getSnapshot().value?.listenAddresses).toEqual(local)
    subject.controller.dispose()
  })

  it.each([{ mode: 'memory' as const, writable: true }, { mode: 'host' as const, writable: false }])(
    'never writes from %j', (permission) => {
      const subject = bench()
      subject.host.publish(permission)
      chooseLan(subject)
      subject.face.save()
      expect(subject.state()).toMatchObject({ writable: false, dirty: false, saved: false })
      expect(subject.host.mutate).not.toHaveBeenCalled()
      subject.controller.dispose()
    },
  )

  it('refuses a draft after another editor changes the revision', () => {
    const subject = bench()
    chooseLan(subject)
    subject.host.publish({ revision: 4, value: { listenAddresses: ['/ip6/::1/tcp/42100'] } })
    subject.face.save()
    expect(subject.state()).toMatchObject({ conflicted: true, saved: false, dirty: true })
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.face.discard()
    expect(subject.state()).toMatchObject({ mode: 'custom', conflicted: false, dirty: false })
    subject.controller.dispose()
  })

  it('retains the draft when a concurrent mutation wins after dispatch', async () => {
    const subject = bench()
    const held = Promise.withResolvers<undefined>()
    subject.host.mutate.mockImplementation(() => held.promise)
    chooseLan(subject)
    subject.face.save()
    subject.host.publish({ revision: 4, value: { listenAddresses: ['/ip6/::1/tcp/42100'] } })
    held.resolve(undefined)
    await vi.waitFor(() =>{  expect(subject.state().saving).toBe(false) })
    expect(subject.state()).toMatchObject({ failed: true, saved: false, mode: 'lan', port: '41901' })
    subject.face.save()
    expect(subject.state().conflicted).toBe(true)
    expect(subject.host.mutate).toHaveBeenCalledTimes(1)
    subject.controller.dispose()
  })

  it('keeps failed writes visible and permits retry of the same retained draft', async () => {
    const subject = bench()
    subject.host.mutate.mockRejectedValueOnce(new Error('fixture transport failure'))
    chooseLan(subject)
    subject.face.save()
    await vi.waitFor(() =>{  expect(subject.state().failed).toBe(true) })
    expect(subject.state()).toMatchObject({ saving: false, port: '41901', saved: false })
    subject.face.save()
    await vi.waitFor(() =>{  expect(subject.state().saved).toBe(true) })
    expect(subject.host.mutate).toHaveBeenCalledTimes(2)
    subject.controller.dispose()
  })

  it('retains a sent-write lock across reset and does not confirm the old response', async () => {
    const subject = bench()
    const held = Promise.withResolvers<undefined>()
    subject.host.mutate.mockImplementation(async (ops: readonly SettingsPathOpView[]) => {
      await held.promise
      subject.commit(ops)
    })
    chooseLan(subject)
    subject.face.save()
    subject.controller.resetConnection()
    subject.face.discard()
    subject.face.chooseMode('local')
    subject.face.save()
    expect(subject.state().saving).toBe(true)
    expect(subject.host.mutate).toHaveBeenCalledTimes(1)
    held.resolve(undefined)
    await vi.waitFor(() =>{  expect(subject.state().saving).toBe(false) })
    expect(subject.state()).toMatchObject({ saved: false, failed: true, conflicted: true })
    subject.face.discard()
    expect(subject.state()).toMatchObject({ mode: 'lan', failed: false, conflicted: false })
    subject.controller.dispose()
  })

  it('removes the observer and suppresses late save presentation on dispose', async () => {
    const subject = bench()
    const held = Promise.withResolvers<undefined>()
    subject.host.mutate.mockImplementation(() => held.promise)
    chooseLan(subject)
    subject.face.save()
    const pending = subject.state()
    subject.controller.dispose()
    expect(subject.host.listenerCount()).toBe(0)
    held.resolve(undefined)
    await held.promise
    expect(subject.state()).toBe(pending)
    subject.face.chooseMode('local')
    expect(subject.state()).toBe(pending)
  })
})

describe('collaboration network card', () => {
  it('shows the default scope, requires a port, and retains restart guidance after saving', async () => {
    const subject = bench()
    mount(subject, zh)
    expect(screen.getByRole('combobox', { name: zh.scopeNetworkMode })).toHaveProperty('value', 'local')
    expect(screen.queryByRole('spinbutton')).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lan' } })
    expect(screen.getByRole('spinbutton', { name: zh.scopeNetworkPort })).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    expect(screen.getByText(zh.scopeNetworkPermission)).toBeTruthy()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '41901' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(screen.getByRole('status').textContent).toBe(zh.scopeNetworkSaved)
    expect(screen.getByRole('button', { name: `${zh.expand}: ${zh.scopeNetworkTitle}` })).toBeTruthy()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    subject.controller.dispose()
  })

  it('shows custom addresses without a save or normalization', () => {
    const addresses = ['/ip6/::1/tcp/41000', '/ip4/192.168.1.12/tcp/41000']
    const subject = bench(addresses)
    mount(subject)
    expect(screen.getByRole('textbox', { name: en.scopeNetworkCustom })).toHaveProperty('value', addresses.join('\n'))
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(subject.host.mutate).not.toHaveBeenCalled()
    subject.controller.dispose()
  })

  it('disables controls and explains the local-page requirement in memory mode', () => {
    const subject = bench()
    subject.host.publish({ mode: 'memory' })
    mount(subject)
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true)
    expect(screen.getByText(en.scopeNetworkRemote)).toBeTruthy()
    expect(screen.queryByText(en.scopeNetworkSaved)).toBeNull()
    subject.controller.dispose()
  })

  it('keeps a rejected save open with its draft and error', async () => {
    const subject = bench()
    subject.host.mutate.mockRejectedValue(new Error('fixture rejected'))
    mount(subject)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lan' } })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '41901' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.save })) })
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByRole('spinbutton')).toHaveProperty('value', '41901')
    expect(screen.queryByText(en.scopeNetworkSaved)).toBeNull()
    subject.controller.dispose()
  })
})
