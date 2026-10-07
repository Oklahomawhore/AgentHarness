// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScopeAgentContributionPermissionDraft } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { NativePermissionSuggestion } from '../src/client/NativePermissionSuggestion.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const agentId = SessionId('suggestion-session')
const draft: ScopeAgentContributionPermissionDraft = {
  agentId, roots: ['/workspace'], tools: ['write', 'edit'], durationHours: 3, maxSamples: 12, maxSampleBytes: 2048,
}
function fixture() {
  const result = Promise.withResolvers<ScopeAgentContributionPermissionDraft | null>()
  const props = { agentId, identity: 'entry/assignment', revision: 'unedited', disabled: false,
    suggestNativeContributionPermission: vi.fn(() => result.promise), apply: vi.fn(), t: makeTranslate(zh) }
  return { ...render(<NativePermissionSuggestion {...props} />), props, result }
}
const button = (): HTMLButtonElement => screen.getByRole('button', { name: zh['native.suggestion.use'] })

describe('explicit local permission suggestion', () => {
  it('reads only after a click and returns the configured values without granting permission', async () => {
    const f = fixture()
    expect(f.props.suggestNativeContributionPermission).not.toHaveBeenCalled()
    fireEvent.click(button())
    expect(f.props.suggestNativeContributionPermission).toHaveBeenCalledExactlyOnceWith(agentId)
    expect(button().disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(zh['native.suggestion.loading'])
    await act(async () => { f.result.resolve(draft); await f.result.promise })
    expect(f.props.apply).toHaveBeenCalledExactlyOnceWith(draft)
    expect(button().disabled).toBe(false)
  })

  it.each(['unavailable', 'failed'] as const)('keeps manual input available when suggestions are %s', async (state) => {
    const f = fixture()
    fireEvent.click(button())
    await act(async () => {
      if (state === 'unavailable') f.result.resolve(null)
      else f.result.reject(new Error('Local service unavailable'))
      await f.result.promise.catch(() => undefined)
    })
    expect(f.props.apply).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(zh[`native.suggestion.${state}`])
    expect(button().disabled).toBe(false)
  })

  it.each(['entry', 'edit', 'session', 'permission', 'unmount'] as const)(
    'ignores late success and failure after %s changes', async (change) => {
      for (const rejected of [false, true]) {
        const f = fixture()
        fireEvent.click(button())
        if (change === 'unmount') f.unmount()
        else f.rerender(<NativePermissionSuggestion {...f.props}
          identity={change === 'entry' ? 'other-entry/assignment' : f.props.identity}
          revision={change === 'edit' ? 'user-edited' : f.props.revision}
          agentId={change === 'session' ? SessionId('other-session') : agentId}
          disabled={change === 'permission'} />)
        await act(async () => {
          if (rejected) f.result.reject(new Error('Late failure'))
          else f.result.resolve(draft)
          await f.result.promise.catch(() => undefined)
        })
        expect(f.props.apply).not.toHaveBeenCalled()
        expect(screen.queryByText(zh['native.suggestion.failed'])).toBeNull()
        f.unmount()
      }
    },
  )

  it('preserves a pending suggestion during an unchanged status refresh', async () => {
    const f = fixture()
    fireEvent.click(button())
    f.rerender(<NativePermissionSuggestion {...f.props} />)
    await act(async () => { f.result.resolve(draft); await f.result.promise })
    expect(f.props.apply).toHaveBeenCalledExactlyOnceWith(draft)
  })
})
