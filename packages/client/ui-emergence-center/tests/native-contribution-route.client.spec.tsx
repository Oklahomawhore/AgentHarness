// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeContributionTransfer } from '@deepseek-ai/dsh-api-remotes/client'
import { NativeContributionRoute } from '../src/client/NativeContributionRoute.tsx'
import { zh } from '../src/client/locales.ts'
import { agentId, applicationEntry, capture } from './native-contribution-fixture.client.ts'

type Props = Parameters<typeof NativeContributionRoute>[0]
const t = makeTranslate(zh)
const relocated = { ...applicationEntry, ownerAddress: '/ip4/192.0.2.20/tcp/43120/p2p/owner-peer' }
afterEach(cleanup)

function mount(overrides: Partial<Props> = {}) {
  const props: Props = { agentId, current: { selection: capture.selection, routeRevision: 2, entry: applicationEntry },
    ready: true, preview: vi.fn(async () => relocated), recover: vi.fn(async () => {}), t, ...overrides }
  const view = render(<NativeContributionRoute {...props} />)
  fireEvent.click(screen.getByText(zh['native.route.title']))
  return { ...view, props }
}
function verify(text: string): void {
  fireEvent.change(screen.getByLabelText(zh['native.route.paste']), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: zh['native.route.verify'] }))
}
function apply(): HTMLButtonElement { return screen.getByRole('button', { name: zh['native.route.apply'] }) }

describe('native contribution route review', () => {
  it.each(['tool-observations', 'completed-turn-outcomes', 'native-work'] as const)(
    'recovers the original %s entry without changing its capture or collecting new permission', async (sourceKind) => {
      const entry = { ...applicationEntry, sourceKind }
      const replacement = { ...entry, ownerAddress: relocated.ownerAddress }
      const f = mount({ current: { selection: capture.selection, routeRevision: 2, entry },
        preview: vi.fn(async () => replacement) })
      verify('replacement entry')
      await waitFor(() => { expect(apply().disabled).toBe(false) })
      expect(screen.getByText(entry.ownerAddress)).toBeTruthy()
      expect(screen.getByText(replacement.ownerAddress)).toBeTruthy()
      expect(f.props.recover).not.toHaveBeenCalled()
      fireEvent.click(apply())
      expect(f.props.recover).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection,
        expectedRouteRevision: 2, expectedOwnerAddress: entry.ownerAddress, entry: replacement })
    },
  )

  it('retains invalid text with localized feedback and permits an explicit corrected review', async () => {
    const preview = vi.fn<Props['preview']>().mockRejectedValueOnce(new RemoteError('gateway/internal', 'private parser detail', {}))
      .mockResolvedValue(relocated)
    const f = mount({ preview })
    verify('invalid entry')
    await screen.findByText(zh['native.route.invalid'])
    expect(screen.queryByText('private parser detail')).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['native.route.paste']).value).toBe('invalid entry')
    expect(apply().disabled).toBe(true)
    verify('corrected entry')
    await waitFor(() => { expect(apply().disabled).toBe(false) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(preview).toHaveBeenNthCalledWith(1, 'invalid entry')
    expect(preview).toHaveBeenNthCalledWith(2, 'corrected entry')
    expect(f.props.recover).not.toHaveBeenCalled()
  })

  it('keeps a corrected route when an earlier parser request rejects after the text changes', async () => {
    const old = Promise.withResolvers<ScopeContributionTransfer>()
    const preview = vi.fn<Props['preview']>().mockReturnValueOnce(old.promise).mockResolvedValue(relocated)
    const f = mount({ preview })
    try {
      verify('old entry')
      expect(preview).toHaveBeenCalledOnce()
      verify('corrected entry')
      await waitFor(() => { expect(apply().disabled).toBe(false) })
      await act(async () => {
        old.reject(new RemoteError('gateway/internal', 'old parser failure', {}))
        await Promise.allSettled([old.promise])
      })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByText(relocated.ownerAddress)).toBeTruthy()
      fireEvent.click(apply())
      expect(f.props.recover).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection,
        expectedRouteRevision: 2, expectedOwnerAddress: applicationEntry.ownerAddress, entry: relocated })
    } finally { old.resolve(relocated); await Promise.allSettled([old.promise]) }
  })

  it('admits one route recovery while the sent request remains unresolved', async () => {
    const pending = Promise.withResolvers<undefined>()
    const recover = vi.fn<Props['recover']>(() => pending.promise)
    mount({ recover })
    try {
      verify('replacement entry')
      await waitFor(() => { expect(apply().disabled).toBe(false) })
      fireEvent.click(apply())
      fireEvent.click(apply())
      expect(recover).toHaveBeenCalledOnce()
    } finally { await act(async () => { pending.resolve(undefined); await pending.promise }) }
  })
})
