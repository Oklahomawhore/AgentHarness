// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError, SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { DevWorkbenchEntryId, DevWorkbenchEntrySnapshot, DevWorkbenchSnapshot, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { DevWorkbenchPanel, type DevWorkbenchPanelProps } from '../src/client/DevWorkbenchPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

const ENTRY = 'agent' as DevWorkbenchEntryId

function entry(phase: DevWorkbenchEntrySnapshot['phase'] = 'idle'): DevWorkbenchEntrySnapshot {
  return {
    id: ENTRY,
    label: 'AgentHarness Agent',
    argv: ['uv', 'run', 'agentharness-agents'],
    cwd: '/workspace/agentharness-agents',
    views: [
      { id: 'agent' as never, label: 'Agent', url: 'http://127.0.0.1:3001/chat' },
      { id: 'local-debug' as never, label: 'Local-debug', url: 'http://127.0.0.1:3001/local-debug' },
    ],
    phase,
    stdout: 'server ready\n',
    stderr: '',
    stdoutLossy: false,
    stderrLossy: false,
  }
}

function props(
  row: DevWorkbenchEntrySnapshot = entry(),
  stored: {
    width?: number
    height?: number
    selectedEntryId?: DevWorkbenchEntryId
    selectedViewByEntry?: Record<string, never>
  } = {},
): DevWorkbenchPanelProps {
  const snapshot = { entries: [row], read: true }
  const preferences = { selectedViewByEntry: {}, ...stored }
  return {
    wide: true,
    useInventory: (selector: (value: typeof snapshot) => unknown) => selector(snapshot),
    usePreferences: (selector: (value: typeof preferences) => unknown) => selector(preferences),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    refresh: vi.fn(),
    setPanelSize: vi.fn(),
    selectEntry: vi.fn(),
    selectView: vi.fn(),
    t: makeTranslate(zh),
  } as unknown as DevWorkbenchPanelProps
}

describe('DevWorkbenchPanel', () => {
  it('keeps Stop available after starting while an older refresh reply settles', async () => {
    const runtime = await SlotTestRuntime.create()
    const stale = Promise.withResolvers<DevWorkbenchSnapshot>()
    const baseline = Promise.withResolvers<DevWorkbenchSnapshot>()
    let current = entry()
    const list = vi.fn(async (): Promise<DevWorkbenchSnapshot> => ({ entries: [current] }))
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.setLocale('zh')
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      new TestRemote(runtime.ctx, { devWorkbench: {
        list: async () => ({ ok: true as const, value: await list() }),
        start: async () => { current = entry('running'); return { ok: true as const, value: current } },
        stop: async () => ({ ok: true as const, value: entry('stopped') }),
      } })
      await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
      await runtime.mount({ inject, apply })
      runtime.renderSlot('sidebar.footer.action', { wide: true })
      fireEvent.click(await screen.findByRole('button', { name: zh['trigger.aria'] }))
      await screen.findByRole('button', { name: zh['action.start'] })
      await runtime.flush()
      const initialReads = list.mock.calls.length
      list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(baseline.promise)
      fireEvent.click(screen.getByTitle(zh['action.refresh']))
      await waitFor(() => { expect(list).toHaveBeenCalledTimes(initialReads + 1) })
      fireEvent.click(screen.getByRole('button', { name: zh['action.start'] }))
      await screen.findByRole('button', { name: zh['action.stop'] })
      await act(async () => { stale.resolve({ entries: [entry()] }); await stale.promise })
      expect(screen.getByRole('button', { name: zh['action.stop'] })).toBeTruthy()
      expect(screen.queryByRole('button', { name: zh['action.start'] })).toBeNull()
      await waitFor(() => { expect(list).toHaveBeenCalledTimes(initialReads + 2) })
    } finally {
      stale.resolve({ entries: [current] }); baseline.resolve({ entries: [current] })
      await runtime.dispose()
    }
  })

  it('discards a pending inventory failure after its plugin is disposed', async () => {
    const runtime = await SlotTestRuntime.create()
    const read = Promise.withResolvers<RemoteResult<DevWorkbenchSnapshot>>()
    const list = vi.fn(async (): Promise<RemoteResult<DevWorkbenchSnapshot>> => ({ ok: true, value: { entries: [entry()] } }))
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.setLocale('zh')
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      new TestRemote(runtime.ctx, { devWorkbench: { list } })
      await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
      const feature = await runtime.mount({ inject, apply })
      runtime.renderSlot('sidebar.footer.action', { wide: true })
      fireEvent.click(await screen.findByRole('button', { name: zh['trigger.aria'] }))
      await runtime.flush()
      const earlierReads = list.mock.calls.length
      list.mockReturnValueOnce(read.promise)
      fireEvent.click(screen.getByTitle(zh['action.refresh']))
      expect(list).toHaveBeenCalledTimes(earlierReads + 1)
      const readsAtDisposal = list.mock.calls.length
      await feature.dispose()
      await act(async () => {
        read.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Disposed inventory read failed', {}) })
        await read.promise
      })
      expect(diagnostics).not.toHaveBeenCalled()
      expect(list).toHaveBeenCalledTimes(readsAtDisposal)
    } finally {
      read.resolve({ ok: true, value: { entries: [] } })
      await runtime.dispose()
      diagnostics.mockRestore()
    }
  })

  it.each(['start', 'stop'] as const)('does not read Host state after a pending %s settles following plugin disposal', async (operation) => {
    const runtime = await SlotTestRuntime.create()
    const action = Promise.withResolvers<RemoteResult<DevWorkbenchEntrySnapshot>>()
    const row = entry(operation === 'start' ? 'idle' : 'running')
    const list = vi.fn(async () => ({ ok: true as const, value: { entries: [row] } }))
    const mutate = vi.fn(async () => await action.promise)
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.setLocale('zh')
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      new TestRemote(runtime.ctx, { devWorkbench: { list, start: mutate, stop: mutate } })
      await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
      const feature = await runtime.mount({ inject, apply })
      runtime.renderSlot('sidebar.footer.action', { wide: true })
      fireEvent.click(await screen.findByRole('button', { name: zh['trigger.aria'] }))
      await runtime.flush()
      fireEvent.click(screen.getByRole('button', { name: zh[operation === 'start' ? 'action.start' : 'action.stop'] }))
      expect(mutate).toHaveBeenCalledExactlyOnceWith(ENTRY)
      await feature.dispose()
      expect(document.querySelector('[data-dev-workbench]')).toBeNull()
      const readsAtDisposal = list.mock.calls.length
      await act(async () => {
        action.resolve({ ok: true, value: entry(operation === 'start' ? 'running' : 'stopped') })
        await action.promise
      })
      expect(list).toHaveBeenCalledTimes(readsAtDisposal)
      expect(mutate).toHaveBeenCalledOnce()
    } finally {
      action.resolve({ ok: true, value: row })
      await runtime.dispose()
    }
  })

  it.each(['success', 'failure'] as const)('keeps the replacement Host task visible after an old start %s', async (outcome) => {
    const runtime = await SlotTestRuntime.create()
    const oldStart = Promise.withResolvers<RemoteResult<DevWorkbenchEntrySnapshot>>()
    const laterList = Promise.withResolvers<{ readonly entries: readonly DevWorkbenchEntrySnapshot[] }>()
    let current = entry()
    let holdReads = false
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.setLocale('zh')
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      new TestRemote(runtime.ctx, { devWorkbench: {
        list: async () => ({ ok: true as const, value: holdReads ? await laterList.promise : { entries: [current] } }),
        start: async () => await oldStart.promise,
        stop: async () => ({ ok: true as const, value: current }),
      } })
      await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
      await runtime.mount({ inject, apply })
      runtime.renderSlot('sidebar.footer.action', { wide: true })
      fireEvent.click(await screen.findByRole('button', { name: zh['trigger.aria'] }))
      fireEvent.click(screen.getByRole('button', { name: zh['action.start'] }))
      current = { ...entry(), label: 'Replacement Host task', stdout: 'NEW_HOST' }
      await act(async () => { runtime.ctx.emit('connection/reset') })
      await screen.findByText('Replacement Host task')
      holdReads = true
      await act(async () => {
        oldStart.resolve(outcome === 'success' ? { ok: true, value: { ...entry('running'), stdout: 'OLD_HOST' } }
          : { ok: false, error: new RemoteError('gateway/internal', 'OLD_HOST_ACTION_FAILED', {}) })
      })
      expect(screen.queryByText('AgentHarness Agent')?.textContent ?? null).toBeNull()
      expect(screen.getByText('Replacement Host task')).toBeTruthy()
      expect(screen.queryByText('OLD_HOST')).toBeNull()
      expect(screen.queryByText(/OLD_HOST_ACTION_FAILED/)).toBeNull()
    } finally {
      oldStart.resolve({ ok: true, value: entry('running') })
      await act(async () => { laterList.resolve({ entries: [current] }) })
      await runtime.dispose()
    }
  })

  it.each(['idle', 'exited', 'failed'] as const)('controls %s task ranges and releases panel polling on disposal', async (phase) => {
    const runtime = await SlotTestRuntime.create()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.setLocale('zh')
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      let current: DevWorkbenchEntrySnapshot = phase === 'idle' ? entry() : {
        ...entry(phase), startedAt: 1, finishedAt: 2,
        readiness: { url: entry().views[0]!.url, state: 'checking' },
        ...phase === 'exited' ? { outcome: { exitCode: 0, signal: null } } : { error: 'Task startup failed' },
      }
      const start = vi.fn(async () => {
        current = { ...entry('running'), startedAt: 3,
          ...current.readiness === undefined ? {} : { readiness: { url: current.readiness.url, state: 'checking' as const } } }
        return { ok: true as const, value: current }
      })
      const stop = vi.fn(async () => {
        current = { ...current, phase: 'stopped', finishedAt: 4 }
        return { ok: true as const, value: current }
      })
      new TestRemote(runtime.ctx, {
        devWorkbench: { list: async () => ({ ok: true as const, value: { entries: [current] } }), start, stop },
      })
      await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
      await runtime.mount({ inject, apply })
      runtime.renderSlot('sidebar.footer.action', { wide: true })
      fireEvent.click(await screen.findByRole('button', { name: zh['trigger.aria'] }))
      if (phase !== 'idle') {
        expect(screen.queryByText(zh['readiness.waiting'])).toBeNull()
        expect(screen.getByText(zh['readiness.stopped'])).toBeTruthy()
        expect(document.querySelector('iframe')).toBeNull()
        expect(screen.getByRole('link', { name: zh['action.open'] }).getAttribute('href')).toBe(current.views[0]?.url)
        expect(screen.getByRole('button', { name: zh['action.restart'] })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: zh['action.stop'] }))
        await screen.findByRole('button', { name: new RegExp(zh['status.stopped']) })
        expect(stop).toHaveBeenCalledWith(ENTRY)
      }
      fireEvent.click(screen.getByRole('button', { name: phase === 'idle' ? zh['action.start'] : zh['action.restart'] }))
      await screen.findByRole('button', { name: new RegExp(zh['status.running']) })
      expect(start).toHaveBeenCalledWith(ENTRY)
      fireEvent.click(screen.getByRole('button', { name: zh['action.stop'] }))
      await screen.findByRole('button', { name: new RegExp(zh['status.stopped']) })
      expect(stop).toHaveBeenCalledWith(ENTRY)
      await runtime.dispose()
      expect(document.querySelector('[data-dev-workbench]')).toBeNull()
      expect(clearInterval).toHaveBeenCalled()
    } finally {
      await runtime.dispose()
      clearInterval.mockRestore()
    }
  })

  it('opens one opaque integrated panel with shared task views and logs', () => {
    render(<DevWorkbenchPanel {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    const panel = document.querySelector('[data-dev-workbench]')
    expect(document.querySelectorAll('[data-dev-workbench]')).toHaveLength(1)
    expect(panel?.parentElement).toBe(document.body)
    expect(screen.getByText('Local-debug')).toBeTruthy()
    expect(screen.getByText('server ready')).toBeTruthy()
    expect(screen.getByTitle(zh['panel.resize'])).toBeTruthy()
  })

  it('resizes from the lower-left corner while the right edge stays anchored', () => {
    const panelProps = props()
    render(<DevWorkbenchPanel {...panelProps} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    const panel = document.querySelector<HTMLElement>('[data-dev-workbench]')!
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 10, left: 100, top: 10, right: 1000, bottom: 610,
      width: 900, height: 600, toJSON: () => ({}),
    })
    fireEvent.pointerDown(screen.getByTitle(zh['panel.resize']), { clientX: 100, clientY: 610 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 670 })
    expect(panel.style.width).toBe('960px')
    expect(panel.style.height).toBe('660px')
    fireEvent.pointerUp(window)
    expect(panelProps.setPanelSize).toHaveBeenCalledWith(960, 660)
  })

  it.each(['close', 'unmount', 'empty'] as const)('cancels its active resize listeners on %s', (action) => {
    const panelProps = props()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const view = render(<DevWorkbenchPanel {...panelProps} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    const panel = document.querySelector<HTMLElement>('[data-dev-workbench]')!
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 10, left: 100, top: 10, right: 1000, bottom: 610,
      width: 900, height: 600, toJSON: () => ({}),
    })
    try {
      fireEvent.pointerDown(screen.getByTitle(zh['panel.resize']), { clientX: 100, clientY: 610 })
      fireEvent.pointerMove(window, { clientX: 40, clientY: 670 })
      if (action === 'close') fireEvent.click(screen.getByRole('button', { name: zh['panel.close'] }))
      else if (action === 'unmount') view.unmount()
      else view.rerender(<DevWorkbenchPanel {...panelProps} useInventory={selector => selector({ entries: [], read: true })} />)
      expect(document.querySelector('[data-dev-workbench]')).toBeNull()
      fireEvent.pointerMove(window, { clientX: 0, clientY: 710 })
      fireEvent.pointerUp(window)
      expect(panelProps.setPanelSize).not.toHaveBeenCalled()
      expect(clearInterval).toHaveBeenCalled()
    } finally { fireEvent.pointerCancel(window); clearInterval.mockRestore() }
  })

  it('restores persisted panel geometry and the selected browser view', () => {
    render(<DevWorkbenchPanel {...props(entry(), {
      width: 960,
      height: 660,
      selectedEntryId: ENTRY,
      selectedViewByEntry: { agent: 'local-debug' as never },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))

    const panel = document.querySelector<HTMLElement>('[data-dev-workbench]')!
    expect(panel.style.width).toBe('960px')
    expect(panel.style.height).toBe('660px')
    expect(screen.getByTitle('Local-debug').getAttribute('src')).toBe('http://127.0.0.1:3001/local-debug')
  })

  it('starts an idle task and stops a running task', () => {
    const idle = props()
    render(<DevWorkbenchPanel {...idle} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.start'] }))
    expect(idle.start).toHaveBeenCalledWith(ENTRY)

    cleanup()
    const running = props(entry('running'))
    render(<DevWorkbenchPanel {...running} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.stop'] }))
    expect(running.stop).toHaveBeenCalledWith(ENTRY)
  })

  it('waits for configured readiness before loading the browser view', () => {
    const checking = entry('running')
    const view = render(<DevWorkbenchPanel {...props({
      ...checking,
      readiness: { url: checking.views[0]!.url, state: 'checking', error: 'fetch failed' },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    expect(screen.getByText(zh['readiness.checking'])).toBeTruthy()
    expect(screen.getByText('fetch failed')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    view.rerender(<DevWorkbenchPanel {...props({
      ...checking, phase: 'exited', startedAt: 1, finishedAt: 2, outcome: { exitCode: 0, signal: null },
      readiness: { url: checking.views[0]!.url, state: 'ready', checkedAt: 1, statusCode: 200 },
    })} />)
    expect(screen.getByTitle('Agent').getAttribute('src')).toBe(checking.views[0]?.url)
    expect(screen.getByRole('link', { name: zh['action.open'] }).getAttribute('href')).toBe(checking.views[0]?.url)
  })
})
