// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContributionSourceSummary, ContributionTransferText, contributionErrorKey } from '../src/client/contribution-ui.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  cleanup()
  if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', clipboard)
})

describe('Contribution presentation', () => {
  it.each([
    ['claude-scope/stale-capture', 'contribution.error.stale'],
    ['claude-scope/contribution-superseded', 'contribution.error.stale'],
    ['scope-contribution/stale-selection', 'contribution.error.stale'],
    ['claude-scope/session-unavailable', 'contribution.error.session'],
    ['claude-scope/local-permission-invalid', 'contribution.error.permission'],
    ['scope-contribution/invalid-permission', 'contribution.error.permission'],
    ['claude-scope/source-conflict', 'contribution.error.conflict'],
    ['scope-contribution/source-conflict', 'contribution.error.conflict'],
    ['claude-scope/invitation-mismatch', 'contribution.error.text'],
    ['scope-contribution/invalid-text', 'contribution.error.text'],
    ['claude-scope/grant-ended', 'contribution.error.ended'],
    ['scope-contribution/grant-ended', 'contribution.error.ended'],
    ['scope-contribution/capacity', 'contribution.error.capacity'],
    ['claude-scope/contribution-unavailable', 'contribution.error.unavailable'],
    ['scope-contribution/unavailable', 'contribution.error.unavailable'],
    ['gateway/internal', 'contribution.error.unknown'],
  ])('presents the recovery category for %s', (code, key) => {
    expect(contributionErrorKey(code)).toBe(key)
  })

  it('describes a Stop-only Claude permission without implying file tools or commands', () => {
    render(<dl><ContributionSourceSummary source={{ kind: 'claude-work', version: 7, name: 'Final replies',
      tools: [], commands: [], stopReports: true }} t={t} /></dl>)
    expect(screen.getAllByText(zh['claude.work.notSelected'])).toHaveLength(2)
    expect(screen.getByText(zh['claude.work.selected'])).toBeTruthy()
    expect(screen.getByText(zh['claude.work.stopHint'])).toBeTruthy()
  })

  it('selects canonical transfer text and reports accepted or denied clipboard writes', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('clipboard denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const original = '{"ownerAddress":"first"}'
    const updated = '{"ownerAddress":"current"}'
    const label = zh['contribution.application.entryText']
    const view = render(<ContributionTransferText text={original} label={label} t={t} />)
    const input = screen.getByLabelText<HTMLTextAreaElement>(label)
    fireEvent.focus(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, original.length])
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.copy'] }))
    await screen.findByRole('button', { name: zh['contribution.copied'] })
    expect(writeText).toHaveBeenLastCalledWith(original)
    view.rerender(<ContributionTransferText text={updated} label={label} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['contribution.copy'] }))
    await screen.findByText(zh['contribution.copyFailed'])
    expect(writeText).toHaveBeenLastCalledWith(updated)
    view.rerender(<ContributionTransferText text={original} label={label} t={t} />)
    expect(screen.queryByText(zh['contribution.copyFailed'])).toBeNull()
    expect(screen.getByRole('button', { name: zh['contribution.copy'] })).toBeTruthy()
  })

  it.each([
    { restored: false, denied: false }, { restored: true, denied: false },
    { restored: false, denied: true }, { restored: true, denied: true },
  ])('ignores a previous entry clipboard reply after replacement (restored=$restored, denied=$denied)', async ({ restored, denied }) => {
    const pending = Promise.withResolvers<undefined>()
    const writeText = vi.fn(() => pending.promise)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const label = zh['contribution.application.entryText']
    const original = '{"ownerAddress":"old-route"}'
    const updated = '{"ownerAddress":"recovered-route"}'
    const view = render(<ContributionTransferText text={original} label={label} t={t} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: zh['contribution.copy'] }))
      view.rerender(<ContributionTransferText text={updated} label={label} t={t} />)
      if (restored) view.rerender(<ContributionTransferText text={original} label={label} t={t} />)
      await act(async () => {
        if (denied) pending.reject(new Error('clipboard denied'))
        else pending.resolve(undefined)
        await Promise.allSettled([pending.promise])
      })
      expect(writeText).toHaveBeenCalledExactlyOnceWith(original)
      expect(screen.getByLabelText<HTMLTextAreaElement>(label).value).toBe(restored ? original : updated)
      expect(screen.queryByRole('button', { name: zh['contribution.copied'] })).toBeNull()
      expect(screen.queryByText(zh['contribution.copyFailed'])).toBeNull()
      expect(screen.getByRole('button', { name: zh['contribution.copy'] })).toBeTruthy()
    } finally { pending.resolve(undefined); await Promise.allSettled([pending.promise]) }
  })
})
