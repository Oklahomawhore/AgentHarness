// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeInvitation, ClaudeScopeSessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import { ScopeAccessPanel, type ScopeAccessPanelProps, type ScopeAccessValue } from '../src/client/ScopeAccessPanel.tsx'
import { zh } from '../src/client/locales.ts'

const invitation: ScopeInvitation = {
  version: 1, taskId: 'public-task' as ScopeInvitation['taskId'], ownerPeerId: 'owner-peer' as ScopeInvitation['ownerPeerId'],
  recipientPeerId: 'recipient-peer' as ScopeInvitation['recipientPeerId'], ownerAddress: '/ip4/127.0.0.1/tcp/10/p2p/owner-peer',
  grantId: 'grant-fixture' as ScopeInvitation['grantId'], generation: 'generation-fixture' as ScopeInvitation['generation'],
  expiresAt: 9999999999999, responsibility: 'frontend',
}
const session: ClaudeScopeSessionSummary = { sessionKey: 'session' as ClaudeScopeSessionSummary['sessionKey'],
  sessionId: 'claude-recipient', observedAt: 1, ended: false, readRevision: 0 }
const inventory: ScopeAccessValue = {
  identity: { peerId: invitation.recipientPeerId, addresses: [invitation.ownerAddress] },
  access: { grants: [], subscriptions: [] },
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each([
  { address: '/ip6/::1/tcp/43120/p2p/owner-peer', label: '[::1]:43120', local: true },
  { address: '/ip6/2001:db8::20/tcp/43120/p2p/owner-peer', label: '[2001:db8::20]:43120', local: false },
  { address: '/dns4/owner.example/tcp/43120/p2p/owner-peer', label: '/dns4/owner.example/tcp/43120/p2p/owner-peer', local: false },
])('keeps the exact published $address while displaying its local or network destination', async ({ address, label, local }) => {
  const { props } = await mount({ taskId: invitation.taskId, entry: { status: 'ready', pending: false,
    value: { ...inventory, identity: { ...inventory.identity, addresses: [address] } } } })
  const option = screen.getByRole<HTMLOptionElement>('option', {
    name: zh[local ? 'access.addressLocal' : 'access.addressNetwork'].replace('{address}', label),
  })
  expect(option.value).toBe(address)
  expect(screen.queryByText(zh['access.addressLocalHint']) !== null).toBe(local)
  inviteSelectedTask()
  await waitFor(() => { expect(props.inviteScope).toHaveBeenCalledOnce() })
  expect(vi.mocked(props.inviteScope).mock.calls[0]?.[0].ownerAddress).toBe(address)
})

it('keeps the invitation available when receive has no confirmed result', async () => {
  const receiveClaudeScope = vi.fn<ScopeAccessPanelProps['receiveClaudeScope']>(async () => undefined)
  const { props, rerender } = await mount({ receiveClaudeScope })
  fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
  fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.receive'] }))
  await waitFor(() => { expect(receiveClaudeScope).toHaveBeenCalledOnce() })
  expect(screen.getByLabelText<HTMLTextAreaElement>(zh['access.paste']).value).toBe(JSON.stringify(invitation))
  rerender(<ScopeAccessPanel {...props} entry={{ value: inventory, status: 'ready', pending: false,
    error: 'contribution/unknown-outcome' }} />)
  expect(screen.getByRole('alert').textContent).toBe(zh['access.failed'])
  expect(receiveClaudeScope).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, invitation })
})

it('uses the explicitly selected invitation duration for the owner request', async () => {
  const { props } = await mount({ taskId: invitation.taskId })
  const before = Date.now()
  fireEvent.change(screen.getByLabelText(zh['access.hours']), { target: { value: '2' } })
  inviteSelectedTask()
  await waitFor(() => { expect(props.inviteScope).toHaveBeenCalledOnce() })
  const expiresAt = vi.mocked(props.inviteScope).mock.calls[0]?.[0].expiresAt
  expect(expiresAt).toBeGreaterThanOrEqual(before + 7_200_000)
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7_200_000)
})

function renderPanel(overrides: Partial<ScopeAccessPanelProps> = {}) {
  const props: ScopeAccessPanelProps = {
    sessions: { status: 'ready', sessions: [session] },
    entry: { status: 'ready', pending: false, value: inventory }, readScopeAccess: vi.fn(),
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
})

it('retries a failed initial inventory read and enables receipt from confirmed state without remounting', async () => {
  const { container, props, rerender } = renderPanel({ entry: { status: 'error', pending: false, error: 'UNAVAILABLE' } })
  expect(screen.getByRole('alert').textContent).toContain(zh['access.loadFailed'])
  await expect(`${container.textContent}\n`).toMatchFileSnapshot('./expected/independent-inventory-error.zh.txt')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.receive'] }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh['access.retry'] }))
  expect(props.readScopeAccess).toHaveBeenCalledTimes(2)
  rerender(<ScopeAccessPanel {...props} entry={{ status: 'ready', pending: false, value: inventory }} />)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
  fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.receive'] }).disabled).toBe(false)
  expect(props.receiveClaudeScope).not.toHaveBeenCalled()
})

it.each(['receive', 'stop'] as const)('retries only the inventory after an unconfirmed %s outcome', async (operation) => {
  const joined: ClaudeScopeSessionSummary = { ...session, receiveSubscriptionId: 'read-subscription' as NonNullable<ClaudeScopeSessionSummary['receiveSubscriptionId']>,
    receiveTaskId: invitation.taskId, receiveState: 'pending' }
  const { props, rerender } = await mount({
    sessions: { status: 'ready', sessions: [operation === 'receive' ? session : joined] } })
  if (operation === 'receive') {
    fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
    fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: session.sessionKey } })
  }
  fireEvent.click(screen.getByRole('button', { name: zh[operation === 'receive' ? 'access.receive' : 'access.stop'] }))
  const mutation = operation === 'receive' ? props.receiveClaudeScope : props.stopClaudeReceive
  await waitFor(() => { expect(mutation).toHaveBeenCalledOnce() })
  rerender(<ScopeAccessPanel {...props} entry={{ status: 'error', pending: false, value: inventory, error: 'UNAVAILABLE' }} />)
  expect(screen.getByRole('alert').textContent).toContain(zh['access.loadFailed'])
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh[operation === 'receive' ? 'access.receive' : 'access.stop'] }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh['access.retry'] }))
  expect(props.readScopeAccess).toHaveBeenCalledTimes(2)
  expect(mutation).toHaveBeenCalledOnce()
})

it('requires a current published route for read invitations and invalidates a route lost on refresh', async () => {
  const network = '/ip4/192.0.2.10/tcp/43120/p2p/owner-peer'
  const { props, rerender } = await mount({ taskId: invitation.taskId, entry: { status: 'ready', pending: false,
    value: { ...inventory, identity: { ...inventory.identity, addresses: [invitation.ownerAddress, network] } } } })
  inviteSelectedTask()
  expect(props.inviteScope).not.toHaveBeenCalled()
  expect(screen.getByText(zh['access.responsibilityHint'])).toBeTruthy()
  fireEvent.change(screen.getByLabelText(zh['access.address']), { target: { value: network } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.invite'] }))
  await waitFor(() => { expect(vi.mocked(props.inviteScope).mock.calls[0]?.[0].ownerAddress).toBe(network) })
  rerender(<ScopeAccessPanel {...props} entry={{ status: 'ready', pending: false, value: inventory }} />)
  await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>(zh['access.address']).value).toBe('') })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.invite'] }).disabled).toBe(true)
})
