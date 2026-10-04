// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  DevelopmentNodeId, DevelopmentParticipantId, DevelopmentTaskBindingId, DevelopmentTaskId,
  DevelopmentTaskObservedCandidate, DevelopmentTaskObservedInterval, DevelopmentTaskObservedIntervalId,
  DevelopmentTaskObservedReceipt,
} from '@deepseek-ai/dsh-api-remotes/client'
import { ObservedScopePanel } from '../src/client/ObservedScopePanel.tsx'
import { createObservedScopeDirectory, type ObservedScopeDirectory, type ObservedScopePort } from '../src/client/observed-scopes.ts'
import { zh } from '../src/client/locales.ts'

const TASK = 'task-owner' as DevelopmentTaskId
const SOURCE = 'node-source' as DevelopmentNodeId
const IDENTITY = {
  taskId: TASK, sourceNodeId: SOURCE, participantId: 'claude' as DevelopmentParticipantId,
  bindingId: 'session-binding' as DevelopmentTaskBindingId, expectedBindingEpoch: { nodeId: SOURCE, seq: 3 },
}
const CANDIDATE: DevelopmentTaskObservedCandidate = { ...IDENTITY, sessionLabel: 'Claude API' }
const RECEIPT: DevelopmentTaskObservedReceipt = {
  taskId: TASK, ownerNodeId: 'node-owner' as DevelopmentNodeId, intervalId: 'interval' as DevelopmentTaskObservedIntervalId,
  revision: 2, event: { nodeId: 'node-owner' as DevelopmentNodeId, seq: 2 },
}
const ACTIVE: DevelopmentTaskObservedInterval = { ...IDENTITY, id: RECEIPT.intervalId, state: 'active', approvalReceipt: RECEIPT }
const END = { ...RECEIPT, revision: 3, event: { ...RECEIPT.event, seq: 3 } }
const ENDED: DevelopmentTaskObservedInterval = { ...ACTIVE, state: 'ended', endReceipt: END }
const directories: ObservedScopeDirectory[] = []
afterEach(() => { cleanup(); directories.splice(0).forEach((directory) => { directory.dispose() }) })

function Harness({ directory }: { directory: ObservedScopeDirectory }) {
  const state = useSyncExternalStore(listener => directory.subscribe(listener), () => directory.getSnapshot())
  return <ObservedScopePanel taskId={TASK} state={state} approve={request => directory.approve(request)}
    end={request => directory.end(request)} refresh={() => { directory.refresh() }} t={makeTranslate(zh)} />
}

async function mount(overrides: Partial<ObservedScopePort> = {}) {
  let current: readonly DevelopmentTaskObservedInterval[] = []
  const port = {
    candidates: async () => [CANDIDATE], intervals: async () => current,
    approve: vi.fn(async () => { current = [ACTIVE]; return ACTIVE }),
    end: vi.fn(async () => { current = [ENDED]; return END }), ...overrides,
  } satisfies ObservedScopePort
  const directory = createObservedScopeDirectory(port, vi.fn())
  directories.push(directory)
  directory.focus(TASK)
  const rendered = render(<Harness directory={directory} />)
  await waitFor(() => { expect(directory.getSnapshot().status).not.toBe('loading') })
  return { ...rendered, directory, port }
}

describe('Remote observation owner controls', () => {
  it('approves exactly one replicated binding and then ends its interval', async () => {
    const { port, container } = await mount()
    expect(screen.getByText(zh['observed.candidate'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['observed.approve'] }))
    await screen.findByText(zh['observed.active'])
    expect(port.approve).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    expect(screen.queryByRole('button', { name: zh['observed.approve'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['observed.end'] }))
    await screen.findByText(zh['observed.ended'])
    expect(port.end).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    expect(screen.queryByRole('button', { name: zh['observed.approve'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['observed.end'] })).toBeNull()
    await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/observed-ended.zh.txt')
  })

  it('disables repeated decisions while owner approval is pending', async () => {
    const decision = Promise.withResolvers<DevelopmentTaskObservedInterval>()
    const approve = vi.fn(() => decision.promise)
    await mount({ approve })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: zh['observed.approve'] })
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(approve).toHaveBeenCalledOnce()
    decision.resolve(ACTIVE)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['observed.refresh'] }).disabled).toBe(false) })
  })

  it('shows a localized failure while preserving the saved owner state for retry', async () => {
    await mount({ approve: async () => { throw new Error('internal transport details') } })
    fireEvent.click(screen.getByRole('button', { name: zh['observed.approve'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh['observed.actionFailed'])
    expect(screen.queryByText('internal transport details')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['observed.approve'] }).disabled).toBe(false)
  })
})
