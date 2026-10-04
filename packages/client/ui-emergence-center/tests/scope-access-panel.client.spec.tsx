// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeInvitation, ClaudeScopeSessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import { ScopeAccessPanel, type ScopeAccessPanelProps } from '../src/client/ScopeAccessPanel.tsx'
import { zh } from '../src/client/locales.ts'

const invitation: ScopeInvitation = {
  version: 1, taskId: 'public-task' as ScopeInvitation['taskId'], ownerPeerId: 'owner-peer' as ScopeInvitation['ownerPeerId'],
  recipientPeerId: 'recipient-peer' as ScopeInvitation['recipientPeerId'], ownerAddress: '/ip4/127.0.0.1/tcp/10/p2p/owner-peer',
  grantId: 'grant-fixture' as ScopeInvitation['grantId'], generation: 'generation-fixture' as ScopeInvitation['generation'],
  expiresAt: 9999999999999, responsibility: 'frontend',
}
const session: ClaudeScopeSessionSummary = { sessionKey: 'session' as ClaudeScopeSessionSummary['sessionKey'],
  sessionId: 'claude-recipient', observedAt: 1, ended: false }
const inventory: Awaited<ReturnType<ScopeAccessPanelProps['readScopeAccess']>> = {
  identity: { peerId: invitation.recipientPeerId, addresses: [invitation.ownerAddress] },
  access: { grants: [], subscriptions: [] },
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderPanel(overrides: Partial<ScopeAccessPanelProps> = {}) {
  const props: ScopeAccessPanelProps = {
    sessions: { status: 'ready', sessions: [session] }, refreshSessions: vi.fn(),
    readScopeAccess: vi.fn(async () => inventory),
    inviteScope: vi.fn(async () => invitation), revokeScope: vi.fn(async () => {}),
    receiveClaudeScope: vi.fn(async () => session), stopClaudeReceive: vi.fn(async () => session),
    t: makeTranslate(zh), ...overrides,
  }
  const rendered = render(<ScopeAccessPanel {...props} />)
  const summary = screen.getByText(zh['access.title'])
  summary.parentElement!.setAttribute('open', '')
  return { ...rendered, props }
}

async function mount(overrides: Partial<ScopeAccessPanelProps> = {}) {
  const rendered = renderPanel(overrides)
  await screen.findByDisplayValue(invitation.recipientPeerId)
  return rendered
}

function inviteSelectedTask() {
  fireEvent.change(screen.getByLabelText(zh['access.recipient']), { target: { value: invitation.recipientPeerId } })
  fireEvent.change(screen.getByLabelText(zh['claude.responsibility']), { target: { value: ' frontend ' } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.invite'] }))
}

it('receives a device invitation without a local Task or capture-root permission', async () => {
  const { props, container } = await mount()
  expect(screen.queryByLabelText(zh['claude.roots'])).toBeNull()
  fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.receive'] }).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.receive'] }))
  await waitFor(() => { expect(props.receiveClaudeScope).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, invitation }) })
  await waitFor(() => { expect(props.refreshSessions).toHaveBeenCalledOnce() })
  await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/independent-receive.zh.txt')
})

it('pins a read invitation to the selected owner Task and keeps invalid input available for retry', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const { props } = await mount({ taskId: invitation.taskId })
  inviteSelectedTask()
  await screen.findByDisplayValue(JSON.stringify(invitation))
  expect(props.inviteScope).toHaveBeenCalledExactlyOnceWith({ taskId: invitation.taskId,
    recipientPeerId: invitation.recipientPeerId, ownerAddress: invitation.ownerAddress,
    responsibility: 'frontend', expiresAt: 1000 + 24 * 3600000 })
  fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: 'invalid invitation' } })
  fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.receive'] }))
  await screen.findByRole('alert')
  expect(screen.getByDisplayValue('invalid invitation')).toBeTruthy()
  expect(props.receiveClaudeScope).not.toHaveBeenCalled()
})

it('clears a completed invitation when the selected Task changes and does not restore it on return', async () => {
  const { props, rerender } = await mount({ taskId: invitation.taskId })
  inviteSelectedTask()
  await screen.findByDisplayValue(JSON.stringify(invitation))
  rerender(<ScopeAccessPanel {...props} taskId={'another-task' as ScopeInvitation['taskId']} />)
  expect(screen.queryByLabelText(zh['access.created'])).toBeNull()
  rerender(<ScopeAccessPanel {...props} />)
  expect(screen.queryByLabelText(zh['access.created'])).toBeNull()
})

it('discards a delayed invitation across an A to B to A Task selection', async () => {
  const completed = Promise.withResolvers<ScopeInvitation>()
  const inviteScope = vi.fn(() => completed.promise)
  const { props, rerender } = await mount({ taskId: invitation.taskId, inviteScope })
  inviteSelectedTask()
  expect(inviteScope).toHaveBeenCalledOnce()
  rerender(<ScopeAccessPanel {...props} taskId={'another-task' as ScopeInvitation['taskId']} />)
  rerender(<ScopeAccessPanel {...props} />)
  await act(async () => { completed.resolve(invitation); await completed.promise })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.invite'] }).disabled).toBe(false) })
  expect(screen.queryByLabelText(zh['access.created'])).toBeNull()
  expect(props.refreshSessions).toHaveBeenCalledOnce()
})

it('retries a failed initial inventory read and enables receipt without remounting', async () => {
  const readScopeAccess = vi.fn<ScopeAccessPanelProps['readScopeAccess']>()
    .mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(inventory)
  const { container, props } = renderPanel({ readScopeAccess })
  expect((await screen.findByRole('alert')).textContent).toContain(zh['access.loadFailed'])
  await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/independent-inventory-error.zh.txt')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.receive'] }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh['access.retry'] }))
  await screen.findByDisplayValue(invitation.recipientPeerId)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
  fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.receive'] }).disabled).toBe(false)
  expect(props.receiveClaudeScope).not.toHaveBeenCalled()
  expect(readScopeAccess).toHaveBeenCalledTimes(2)
})

it.each(['receive', 'stop'] as const)('refreshes sessions after %s even while inventory fails and retries only the read', async (operation) => {
  const delayed = Promise.withResolvers<Awaited<ReturnType<ScopeAccessPanelProps['readScopeAccess']>>>()
  const readScopeAccess = vi.fn<ScopeAccessPanelProps['readScopeAccess']>()
    .mockResolvedValueOnce(inventory).mockImplementationOnce(() => delayed.promise).mockResolvedValue(inventory)
  const joined: ClaudeScopeSessionSummary = { ...session, receiveSubscriptionId: 'read-subscription' as NonNullable<ClaudeScopeSessionSummary['receiveSubscriptionId']>,
    receiveTaskId: invitation.taskId, receiveState: 'pending' }
  const { props } = await mount({ readScopeAccess,
    sessions: { status: 'ready', sessions: [operation === 'receive' ? session : joined] } })
  if (operation === 'receive') {
    fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
    fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  }
  fireEvent.click(screen.getByRole('button', { name: zh[operation === 'receive' ? 'access.receive' : 'access.stop'] }))
  await waitFor(() => { expect(readScopeAccess).toHaveBeenCalledTimes(2) })
  expect(props.refreshSessions).toHaveBeenCalledOnce()
  await act(async () => { delayed.reject(new Error('status read failed')); await expect(delayed.promise).rejects.toThrow('status read failed') })
  expect((await screen.findByRole('alert')).textContent).toContain(zh['access.loadFailed'])
  const mutation = operation === 'receive' ? props.receiveClaudeScope : props.stopClaudeReceive
  expect(mutation).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: zh['access.retry'] }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(readScopeAccess).toHaveBeenCalledTimes(3)
  expect(mutation).toHaveBeenCalledOnce()
})

it('requires a current published route for read invitations and invalidates a route lost on refresh', async () => {
  const network = '/ip4/192.0.2.10/tcp/43120/p2p/owner-peer'
  const readScopeAccess = vi.fn<ScopeAccessPanelProps['readScopeAccess']>()
    .mockResolvedValueOnce({ ...inventory, identity: { ...inventory.identity, addresses: [invitation.ownerAddress, network] } })
    .mockResolvedValue({ ...inventory, identity: { ...inventory.identity, addresses: [invitation.ownerAddress] } })
  const { props } = await mount({ taskId: invitation.taskId, readScopeAccess })
  inviteSelectedTask()
  expect(props.inviteScope).not.toHaveBeenCalled()
  expect(screen.getByText(zh['access.responsibilityHint'])).toBeTruthy()
  fireEvent.change(screen.getByLabelText(zh['access.address']), { target: { value: network } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.invite'] }))
  await waitFor(() => { expect(readScopeAccess).toHaveBeenCalledTimes(2) })
  expect(vi.mocked(props.inviteScope).mock.calls[0]?.[0].ownerAddress).toBe(network)
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>(zh['access.address']).value).toBe('') })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.invite'] }).disabled).toBe(true)
})
