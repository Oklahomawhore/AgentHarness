// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClaudeScopeContributionDetail, ClaudeScopeSessionSummary, ScopeContributionEntry,
  ScopeContributionInvitation, ScopeContributionProposal } from '@deepseek-ai/dsh-api-remotes/client'
import { SourceContributionPanel, type SourceContributionActions } from '../src/client/SourceContributionPanel.tsx'
import { ContributionSourceSummary } from '../src/client/contribution-ui.tsx'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
const session: ClaudeScopeSessionSummary = { sessionKey: 'original-claude' as ClaudeScopeSessionSummary['sessionKey'],
  sessionId: 'existing-external-session', cwd: '/project', observedAt: 1, ended: false, readRevision: 4 }
const entry: ScopeContributionEntry = { version: 1, kind: 'scope-join-entry', sourceKind: 'claude-work',
  entryId: 'entry' as ScopeContributionEntry['entryId'], taskId: 'task' as ScopeContributionEntry['taskId'],
  ownerPeerId: 'owner' as ScopeContributionEntry['ownerPeerId'], ownerAddress: '/ip4/127.0.0.1/tcp/6000/p2p/owner',
  expiresAt: 2000000000000 }
const command = 'printf " exact text "\nnode check.mjs  --flag'
const publicSource = { kind: 'claude-work', version: 7, name: 'session-work', tools: ['Write', 'Edit'],
  commands: [{ command, rootIndex: 1 }], stopReports: true } satisfies ScopeContributionProposal['source']
const proposal: ScopeContributionProposal = { contributorPeerId: 'source' as ScopeContributionProposal['contributorPeerId'],
  captureId: 'capture' as ScopeContributionProposal['captureId'],
  captureGeneration: 'generation' as ScopeContributionProposal['captureGeneration'], source: publicSource }
const invitation: ScopeContributionInvitation = { version: 1, kind: 'claude-work-contribution', ownerAddress: entry.ownerAddress,
  grant: { ...proposal, version: 1, taskId: entry.taskId, ownerPeerId: entry.ownerPeerId,
    grantId: 'grant' as ScopeContributionInvitation['grant']['grantId'],
    generation: 'grant-generation' as ScopeContributionInvitation['grant']['generation'],
    expiresAt: entry.expiresAt, maxSamples: 8, maxSampleBytes: 4096 } }
const localSource = { kind: 'claude-work' as const, tools: publicSource.tools,
  commands: publicSource.commands, stopReports: true }
const capture: NonNullable<ClaudeScopeContributionDetail['capture']> = {
  selection: { captureId: proposal.captureId, captureGeneration: proposal.captureGeneration },
  proposal, proposalText: 'claude-work-proposal', roots: ['/project', '/project/checks'], source: localSource,
  invitation: null, application: null,
}
function actions(value: ScopeContributionEntry = entry): SourceContributionActions {
  const noop = async (): Promise<void> => {}
  return { readContribution: vi.fn(), requestContribution: vi.fn(noop), prepareContribution: vi.fn(noop),
    activateContribution: vi.fn(noop), stopContribution: vi.fn(noop), leaveJointContribution: vi.fn(noop),
    recoverJointContribution: vi.fn(noop), probeContributionEntry: vi.fn(async () => ({ status: 'ready' as const })),
    previewContributionText: vi.fn(async () => value) }
}
function observed(value: ClaudeScopeContributionDetail['capture'] = null, subject = session) {
  return { status: 'ready' as const, pending: false, value: { session: subject, capture: value } }
}
function change(key: keyof typeof zh, value: string): void {
  fireEvent.change(screen.getByLabelText(zh[key]), { target: { value } })
}
function checkbox(key: keyof typeof zh): HTMLInputElement { return screen.getByRole('checkbox', { name: zh[key] }) }
function button(): HTMLButtonElement { return screen.getByRole('button', { name: zh['claude.joint.request'] }) }
async function review(): Promise<void> {
  change('contribution.application.paste', 'entry-text')
  fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
  await screen.findByText(zh['claude.work.hint'])
  change('contribution.hours', '1'); change('contribution.maxSamples', '8'); change('contribution.maxBytes', '4096')
}
function confirm(): void {
  fireEvent.click(checkbox('claude.joint.readConsent')); fireEvent.click(checkbox('claude.work.consent'))
}
function selectCommands(): void {
  fireEvent.click(checkbox('claude.work.commands'))
  change('native.commands.command', command); change('native.commands.cwd', '1')
}
afterEach(cleanup)

describe('original Claude work permissions', () => {
  it('shows English consent before enabling automatic reply sharing on the original session', async () => {
    const port = actions()
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={makeTranslate(en)} />)
    fireEvent.change(screen.getByLabelText(en['contribution.application.paste']), { target: { value: 'entry-text' } })
    fireEvent.click(screen.getByRole('button', { name: en['contribution.application.verify'] }))
    await screen.findByText(en['claude.work.hint'])
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => !input.checked)).toBe(true)
    expect(screen.getByText(en['claude.work.stopHint'])).toBeTruthy()
    for (const [key, value] of [['contribution.hours', '1'], ['contribution.maxSamples', '8'],
      ['contribution.maxBytes', '4096'], ['contribution.roots', '']] as const) {
      fireEvent.change(screen.getByLabelText(en[key]), { target: { value } })
    }
    fireEvent.click(screen.getByRole('checkbox', { name: en['claude.work.stopReports'] }))
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: en['claude.joint.request'] })
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en['claude.joint.readConsent'] }))
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en['claude.work.consent'] }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(port.requestContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
      expectedCapture: null, entry, roots: [],
      source: { kind: 'claude-work', tools: [], commands: [], stopReports: true },
      receive: { expectedReadRevision: 4 }, limits: { expiresAt: expect.any(Number) as unknown, maxSamples: 8, maxSampleBytes: 4096 } })
  })

  it.each(['scope-join-entry', 'scope-group-entry'] as const)('keeps every category off for %s and submits Stop-only on the original session', async (kind) => {
    const selected: ScopeContributionEntry = kind === 'scope-group-entry'
      ? { ...entry, version: 2, kind, maxMembers: 3 } : entry
    const port = actions(selected)
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    await review()
    expect(port.probeContributionEntry).toHaveBeenCalledExactlyOnceWith({ entry: selected })
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => !input.checked)).toBe(true)
    confirm()
    expect(button().disabled).toBe(true)
    change('contribution.roots', '')
    fireEvent.click(checkbox('claude.work.stopReports'))
    expect(checkbox('claude.work.consent').checked).toBe(false)
    expect(checkbox('claude.joint.readConsent').checked).toBe(true)
    fireEvent.click(checkbox('claude.work.consent'))
    expect(button().disabled).toBe(false)
    fireEvent.click(button())
    expect(port.requestContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
      expectedCapture: null, entry: selected, roots: [],
      source: { kind: 'claude-work', tools: [], commands: [], stopReports: true },
      receive: { expectedReadRevision: 4 }, limits: { expiresAt: expect.any(Number) as unknown, maxSamples: 8, maxSampleBytes: 4096 } })
    expect(port.activateContribution).not.toHaveBeenCalled()
    expect(port.prepareContribution).not.toHaveBeenCalled()
    expect(screen.queryByText(zh['native.fileContent.consent'])).toBeNull()
    expect(screen.queryByText(zh['native.initialization.consent'])).toBeNull()
  })

  it('submits all selected categories once with exact command bytes and ordered directory indices', async () => {
    const port = actions()
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    await review()
    change('contribution.roots', '/project\n/project/checks')
    fireEvent.click(checkbox('claude.work.write')); fireEvent.click(checkbox('claude.work.edit'))
    selectCommands(); fireEvent.click(checkbox('claude.work.stopReports')); confirm()
    fireEvent.click(button())
    expect(port.requestContribution).toHaveBeenCalledOnce()
    expect(vi.mocked(port.requestContribution).mock.calls[0]?.[0]).toMatchObject({ sessionKey: session.sessionKey,
      roots: ['/project', '/project/checks'], source: localSource, receive: { expectedReadRevision: 4 } })
    const sent = vi.mocked(port.requestContribution).mock.calls[0]?.[0].source
    expect(sent).not.toHaveProperty('fileContent'); expect(sent).not.toHaveProperty('initialization')
    expect(sent).not.toHaveProperty('completedTurns')
  })

  it.each(['tools', 'commands', 'directory order', 'Stop', 'limit'] as const)('requires renewed collection consent after editing %s', async (field) => {
    const port = actions()
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    await review(); change('contribution.roots', '/project\n/project/checks')
    fireEvent.click(checkbox('claude.work.write')); selectCommands(); confirm()
    if (field === 'tools') fireEvent.click(checkbox('claude.work.edit'))
    if (field === 'commands') change('native.commands.command', command + ' ')
    if (field === 'directory order') change('contribution.roots', '/project/checks\n/project')
    if (field === 'Stop') fireEvent.click(checkbox('claude.work.stopReports'))
    if (field === 'limit') change('contribution.maxSamples', '9')
    expect(checkbox('claude.work.consent').checked).toBe(false)
    expect(checkbox('claude.joint.readConsent').checked).toBe(true)
    expect(button().disabled).toBe(true)
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it('rejects duplicate command directories and requires a directory for selected file tools', async () => {
    const port = actions()
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    await review(); change('contribution.roots', '/project\n/project')
    selectCommands(); confirm()
    expect(button().disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(zh['native.commands.cwd']).value).toBe('1')
    fireEvent.click(checkbox('claude.work.commands')); change('contribution.roots', '')
    fireEvent.click(checkbox('claude.work.write')); fireEvent.click(checkbox('claude.work.consent'))
    expect(button().disabled).toBe(true)
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it('clears category choices for another entry but retains them on an ordinary status refresh', async () => {
    const port = actions()
    const view = render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    await review(); fireEvent.click(checkbox('claude.work.stopReports')); confirm()
    view.rerender(<SourceContributionPanel session={session} entry={observed(null, { ...session, observedAt: 2 })} {...port} t={t} />)
    expect(checkbox('claude.work.stopReports').checked).toBe(true)
    expect(checkbox('claude.work.consent').checked).toBe(true)
    change('contribution.application.paste', 'another-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await act(async () => {})
    expect(checkbox('claude.work.stopReports').checked).toBe(false)
    expect(checkbox('claude.work.consent').checked).toBe(false)
  })

  it('prepares a contribution-only manual proposal with only explicitly selected categories', () => {
    const port = actions()
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    change('contribution.sourceKind', 'claude-work'); change('contribution.roots', '')
    const prepare = screen.getByRole<HTMLButtonElement>('button', { name: zh['contribution.prepare'] })
    expect(prepare.disabled).toBe(true)
    fireEvent.click(checkbox('claude.work.stopReports')); fireEvent.click(prepare)
    expect(port.prepareContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
      expectedCapture: null, roots: [], source: { kind: 'claude-work', tools: [], commands: [], stopReports: true } })
    expect(port.requestContribution).not.toHaveBeenCalled()
  })

  it('recovers the saved source and limits rather than creating a wider permission from new form defaults', async () => {
    const originalEntry: ScopeContributionEntry = { ...entry, kind: 'contribution-entry' }
    const nextEntry = { ...originalEntry, ownerAddress: '/ip4/127.0.0.1/tcp/7000/p2p/owner' }
    const port = actions(nextEntry)
    const application: NonNullable<typeof capture.application> = {
      entry: originalEntry, limits: { expiresAt: entry.expiresAt, maxSamples: 8, maxSampleBytes: 4096 }, state: 'waiting',
    }
    render(<SourceContributionPanel session={session} entry={observed({ ...capture, application })} {...port} t={t} />)
    change('contribution.application.paste', 'new-address-entry')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.verify'] }))
    await screen.findByText(nextEntry.ownerAddress)
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.retryAddress'] }))
    expect(port.requestContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
      expectedCapture: capture.selection, roots: capture.roots, source: localSource, entry: nextEntry, limits: application.limits })
  })

  it('accepts the explicit manual invitation without treating it as native work', async () => {
    const port = actions()
    vi.mocked(port.previewContributionText).mockResolvedValue(invitation)
    render(<SourceContributionPanel session={session} entry={observed(capture,
      { ...session, contributionState: 'prepared' })} {...port} t={t} />)
    change('contribution.pasteInvitation', 'owner-invitation')
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
    await screen.findByText(invitation.ownerAddress)
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.activate'] }))
    expect(port.activateContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
      expectedCapture: capture.selection, invitation })
  })

  it.each(['tools', 'command text', 'command directory', 'Stop', 'equal'] as const)(
    'matches the reviewed invitation using its %s permission', async (difference) => {
      const source = difference === 'tools' ? { ...publicSource, tools: ['Write'] as const }
        : difference === 'command text' ? { ...publicSource, commands: [{ command: command + ' ', rootIndex: 1 }] }
          : difference === 'command directory' ? { ...publicSource, commands: [{ command, rootIndex: 0 }] }
            : difference === 'Stop' ? { ...publicSource, stopReports: false } : publicSource
      const reviewed = { ...invitation, grant: { ...invitation.grant, source } }
      const next = { ...invitation, ownerAddress: '/ip4/127.0.0.1/tcp/7000/p2p/owner' }
      const port = actions()
      vi.mocked(port.previewContributionText).mockResolvedValue(reviewed)
      const subject = { ...session, contributionState: 'active' as const }
      const view = render(<SourceContributionPanel session={session}
        entry={observed({ ...capture, invitation }, subject)} {...port} t={t} />)
      change('contribution.pasteInvitation', 'reviewed-invitation')
      fireEvent.click(screen.getByRole('button', { name: zh['contribution.verifyInvitation'] }))
      await act(async () => {})
      view.rerender(<SourceContributionPanel session={session}
        entry={observed({ ...capture, invitation: next }, subject)} {...port} t={t} />)
      if (difference === 'equal') {
        expect(screen.queryByRole('button', { name: zh['contribution.confirmReconnect'] })).toBeNull()
        expect(screen.getByText(next.ownerAddress)).toBeTruthy()
        expect(port.activateContribution).not.toHaveBeenCalled()
        return
      }
      fireEvent.click(screen.getByRole('button', { name: zh['contribution.confirmReconnect'] }))
      expect(port.activateContribution).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey,
        expectedCapture: capture.selection, invitation: reviewed })
    },
  )

  it('applies to a contribution-only entry without adding reading permission', async () => {
    const contributionEntry: ScopeContributionEntry = { ...entry, kind: 'contribution-entry' }
    const port = actions(contributionEntry)
    render(<SourceContributionPanel session={session} entry={observed()} {...port} t={t} />)
    await review(); change('contribution.roots', '')
    fireEvent.click(checkbox('claude.work.stopReports'))
    expect(screen.queryByRole('checkbox', { name: zh['claude.joint.readConsent'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.application.request'] }))
    expect(port.requestContribution).toHaveBeenCalledOnce()
    const sent = vi.mocked(port.requestContribution).mock.calls[0]?.[0]
    expect(sent).toMatchObject({ sessionKey: session.sessionKey, entry: contributionEntry, roots: [],
      source: { kind: 'claude-work', tools: [], commands: [], stopReports: true } })
    expect(sent?.receive).toBeUndefined()
    expect(port.probeContributionEntry).not.toHaveBeenCalled()
  })

  it('shows the complete external permission and Stop disclosure without native completion claims', async () => {
    const { container } = render(<dl><ContributionSourceSummary source={publicSource} t={t} /></dl>)
    expect(screen.getByText(command, { collapseWhitespace: false }).textContent).toBe(command)
    expect(screen.getByText(zh['claude.work.stopHint'])).toBeTruthy()
    expect(screen.queryByText(zh['native.outcomes.scope'])).toBeNull()
    await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/claude-work-permission.zh.txt')
  })
})
