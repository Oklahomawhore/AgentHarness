// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClaudeScopeSessionKey, ClaudeScopeSessionSummary, DevelopmentTaskId } from '@deepseek-ai/dsh-api-remotes/client'
import { ClaudeScopePanel } from '../src/client/ClaudeScopePanel.tsx'
import { createClaudeScopeDirectory, type ClaudeScopeDirectory, type ClaudeScopePort } from '../src/client/claude-scopes.ts'
import { zh } from '../src/client/locales.ts'

const TASK = 'task-local' as DevelopmentTaskId
const A: ClaudeScopeSessionSummary = { sessionKey: 'a' as ClaudeScopeSessionKey, sessionId: 'claude-a', cwd: '/project', observedAt: 1, ended: false, readRevision: 0 }
const B: ClaudeScopeSessionSummary = { ...A, sessionKey: 'b' as ClaudeScopeSessionKey, sessionId: 'claude-b' }
const PROJECT = { projectPath: '/project', settingsPath: '/project/.claude/settings.local.json', profileName: 'scope-hook' }
const t = makeTranslate(zh)
const directories: ClaudeScopeDirectory[] = []
afterEach(() => { cleanup(); directories.splice(0).forEach((directory) => { directory.dispose() }) })

function Harness({ directory, localTask }: { directory: ClaudeScopeDirectory; localTask: boolean }) {
  const state = useSyncExternalStore(callback => directory.subscribe(callback), () => directory.getSnapshot())
  return <ClaudeScopePanel state={state} taskId={TASK} localTask={localTask} setup={request => directory.setup(request)}
    check={request => directory.projectSetup(request)} remove={request => directory.removeSetup(request)}
    join={request => directory.join(request)} leave={request => directory.leave(request)}
    refresh={() => { directory.refresh() }} contributions={{}} readContribution={() => {}}
    requestContribution={async () => {}} prepareContribution={async () => {}}
    activateContribution={async () => {}} stopContribution={async () => {}}
    leaveJointContribution={async () => {}} recoverJointContribution={async () => {}}
    probeContributionEntry={async () => ({ status: 'ready' })}
    previewContributionText={async () => { throw new Error('unused') }} t={t} />
}

async function mount(overrides: Partial<ClaudeScopePort> = {}, localTask = true) {
  const port = {
    sessions: vi.fn(async () => [A, B]),
    setup: vi.fn(async () => ({ ...PROJECT, outcome: 'configured' as const })),
    projectSetup: vi.fn(async () => ({ ...PROJECT, state: 'configured' as const })),
    removeSetup: vi.fn(async () => ({ ...PROJECT, outcome: 'removed' as const })),
    join: vi.fn(async (request: Parameters<ClaudeScopePort['join']>[0]) => ({ ...(request.sessionKey === B.sessionKey ? B : A), taskId: TASK, responsibility: request.responsibility })),
    leave: vi.fn(async () => A),
    ...overrides,
  }
  const directory = createClaudeScopeDirectory(port, vi.fn())
  directories.push(directory)
  const rendered = render(<Harness directory={directory} localTask={localTask} />)
  await waitFor(() => { expect(directory.getSnapshot().status).not.toBe('loading') })
  return { ...rendered, port, directory }
}

function selectB() {
  fireEvent.click(screen.getByRole('radio', { name: /claude-b/u }))
  fireEvent.change(screen.getByLabelText(zh['claude.responsibility']), { target: { value: '  Implement API  ' } })
}

describe('Claude project and session controls', () => {
  it('keeps ended sessions selectable while their exact joint cleanup needs recovery', async () => {
    const ended: ClaudeScopeSessionSummary = { ...A, ended: true, joint: {
      id: 'ended-joint' as NonNullable<ClaudeScopeSessionSummary['joint']>['id'],
      capture: { captureId: 'capture' as NonNullable<ClaudeScopeSessionSummary['joint']>['capture']['captureId'],
        captureGeneration: 'generation' as NonNullable<ClaudeScopeSessionSummary['joint']>['capture']['captureGeneration'] },
      expectedReadRevision: 0, state: 'ended', intent: 'leave', cleanupPending: true,
    } }
    await mount({ sessions: async () => [ended] })
    const choice = screen.getByRole<HTMLInputElement>('radio', { name: /claude-a/u })
    expect(choice.disabled).toBe(false)
    fireEvent.click(choice)
    expect(screen.getByText(zh['claude.joint.ending'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['claude.joint.leave'] })).toBeTruthy()
  })

  it('checks, configures, and removes only project hooks while retaining joined-session controls', async () => {
    const { port } = await mount({
      sessions: async () => [{ ...A, taskId: TASK }],
      projectSetup: vi.fn<ClaudeScopePort['projectSetup']>(async () => ({ ...PROJECT, state: 'not-configured' })),
    })
    fireEvent.change(screen.getByLabelText(zh['claude.projectPath']), { target: { value: ' /project ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.check'] }))
    await screen.findByText(zh['claude.notConfigured'])
    expect(port.projectSetup).toHaveBeenCalledWith({ projectPath: '/project' })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.configure'] }))
    await screen.findByText(zh['claude.configured'])
    expect(port.setup).toHaveBeenCalledWith({ projectPath: '/project' })
    expect(screen.getByText(PROJECT.settingsPath)).toBeTruthy()
    expect(screen.getByText(zh['claude.afterSetup'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.remove'] }))
    await screen.findByText(zh['claude.notConfigured'])
    expect(port.removeSetup).toHaveBeenCalledWith({ projectPath: '/project' })
    expect(screen.getByText(zh['claude.removeHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /claude-a/u }))
    expect(screen.getByRole('button', { name: zh['claude.leave'] })).toBeTruthy()
    expect(port.leave).not.toHaveBeenCalled()
  })

  it('requires a separate choice for identical working directories and grants only the chosen session', async () => {
    const { port, container } = await mount()
    const radios = screen.getAllByRole<HTMLInputElement>('radio')
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(screen.queryByRole('button', { name: zh['claude.join'] })).toBeNull()
    selectB()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['claude.roots']).value).toBe('/project')
    fireEvent.change(screen.getByLabelText(zh['claude.roots']), { target: { value: ' /project/src\n/project/tests\n/project/src\n' } })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.join'] }))
    await screen.findByRole('button', { name: zh['claude.updateGrant'] })
    expect(port.join).toHaveBeenCalledExactlyOnceWith({ sessionKey: B.sessionKey, taskId: TASK, responsibility: 'Implement API', roots: ['/project/src', '/project/tests'], bashCommands: [] })
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /claude-a/u }).checked).toBe(false)
    await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/claude-joined.zh.txt')
  })

  it('keeps the selected grant after join and leave failures and allows retry', async () => {
    const join = vi.fn().mockRejectedValueOnce(new Error('private host diagnostic')).mockResolvedValue({ ...B, taskId: TASK })
    const leave = vi.fn().mockRejectedValueOnce(new Error('private host diagnostic')).mockResolvedValue(B)
    await mount({ join, leave })
    selectB()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.join'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh['claude.actionFailed'])
    expect(screen.queryByText('private host diagnostic')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.join'] }))
    await screen.findByRole('button', { name: zh['claude.leave'] })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.leave'] }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: zh['claude.updateGrant'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.leave'] }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: zh['claude.leave'] })).toBeNull() })
    expect(leave).toHaveBeenNthCalledWith(1, { sessionKey: B.sessionKey })
    expect(leave).toHaveBeenNthCalledWith(2, { sessionKey: B.sessionKey })
  })

  it.each([
    ['project-invalid', 'claude.projectInvalid'],
    ['configuration-conflict', 'claude.configurationConflict'],
    ['configuration-invalid', 'claude.configurationInvalid'],
    ['configuration-too-large', 'claude.configurationTooLarge'],
    ['write-failed', 'claude.writeFailed'],
  ] as const)('localizes setup failure %s without exposing raw diagnostics', async (code, key) => {
    await mount({ setup: async () => { throw Object.assign(new Error('sensitive path details'), { code: `claude-scope/${code}` }) } })
    fireEvent.change(screen.getByLabelText(zh['claude.projectPath']), { target: { value: '/project' } })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.configure'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh[key])
    expect(screen.queryByText('sensitive path details')).toBeNull()
  })

  it('offers removal for a conflicted project and retains configuration when removal fails', async () => {
    const projectSetup = vi.fn().mockResolvedValueOnce({ ...PROJECT, state: 'conflict', detail: 'raw internal error' }).mockResolvedValue({ ...PROJECT, state: 'configured' })
    await mount({ projectSetup, removeSetup: async () => { throw new Error('unavailable') } })
    fireEvent.change(screen.getByLabelText(zh['claude.projectPath']), { target: { value: '/project' } })
    fireEvent.click(screen.getByRole('button', { name: zh['claude.check'] }))
    await screen.findByText(zh['claude.configurationConflict'])
    expect(screen.queryByText('raw internal error')).toBeNull()
    expect(screen.getByRole('button', { name: zh['claude.remove'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.remove'] }))
    await screen.findByRole('alert')
    expect(screen.getByText(zh['claude.configurationConflict'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.check'] }))
    await screen.findByText(zh['claude.configured'])
    fireEvent.click(screen.getByRole('button', { name: zh['claude.remove'] }))
    await screen.findByRole('alert')
    expect(screen.getByText(zh['claude.configured'])).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.remove'] }).disabled).toBe(false)
  })

  it('prevents repeated pending grants and preserves fields until settlement', async () => {
    const grant = Promise.withResolvers<ClaudeScopeSessionSummary>()
    const join = vi.fn(() => grant.promise)
    await mount({ join })
    selectB()
    fireEvent.click(screen.getByRole('button', { name: zh['claude.join'] }))
    const button = screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.joining'] })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(join).toHaveBeenCalledOnce()
    grant.resolve({ ...B, taskId: TASK })
    await screen.findByRole('button', { name: zh['claude.updateGrant'] })
  })

  it('permits remote Task grants with owner approval and still blocks ended sessions', async () => {
    await mount({ sessions: async () => [{ ...A, ended: true }, { ...B, taskId: TASK }] }, false)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /claude-a/u }).disabled).toBe(true)
    selectB()
    expect(screen.getByText(zh['claude.remoteApproval'])).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.updateGrant'] }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.leave'] }).disabled).toBe(false)
  })

  it.each([false, true])('shows remote withdrawal pending and permits retry even when ended=%s', async (ended) => {
    const pending: ClaudeScopeSessionSummary = { ...B, ended, sharingState: 'withdrawal-pending', withdrawalTaskId: TASK, sharingIssue: 'owner-unavailable' }
    const leave = vi.fn(async () => ({ ...B, ended }))
    await mount({ sessions: async () => [pending], leave }, false)
    fireEvent.click(screen.getByRole('radio', { name: /claude-b/u }))
    expect(screen.getByText(zh['claude.withdrawalPending'])).toBeTruthy()
    expect(screen.getByText(zh['claude.issue.owner-unavailable'])).toBeTruthy()
    if (!ended) {
      fireEvent.change(screen.getByLabelText(zh['claude.responsibility']), { target: { value: 'API' } })
      expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['claude.join'] }).disabled).toBe(true)
    }
    fireEvent.click(screen.getByRole('button', { name: zh['claude.retryWithdrawal'] }))
    await waitFor(() => { expect(screen.queryByText(zh['claude.withdrawalHint'])).toBeNull() })
    expect(leave).toHaveBeenCalledExactlyOnceWith({ sessionKey: B.sessionKey })
  })

  it('shows unavailable capability without offering unusable setup controls', async () => {
    await mount({ sessions: async () => { throw Object.assign(new Error('service'), { code: 'gateway/service-unavailable' }) } })
    expect(screen.getByText(zh['claude.unavailable'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['claude.projectPath'])).toBeNull()
    expect(screen.getByRole('button', { name: zh['claude.refresh'] })).toBeTruthy()
  })
})
