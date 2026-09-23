// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DevWorkbenchEntryId, DevWorkbenchEntrySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { DevWorkbenchPanel, type DevWorkbenchPanelProps } from '../src/client/DevWorkbenchPanel.tsx'
import { zh } from '../src/client/locales.ts'

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
    render(<DevWorkbenchPanel {...props({
      ...checking,
      readiness: { url: checking.views[0]!.url, state: 'checking', error: 'fetch failed' },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    expect(screen.getByText(zh['readiness.checking'])).toBeTruthy()
    expect(screen.getByText('fetch failed')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })
})
