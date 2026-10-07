// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NativeRecordedContext } from '../src/client/NativeRecordedContext.tsx'
import { en, zh } from '../src/client/locales.ts'
import { recordedContext } from './native-scope-fixture.client.ts'

afterEach(cleanup)

describe('recorded shared context counts', () => {
  it.each([zh, en])('separates shared bytes, budget omissions and other source exclusions', (dictionary) => {
    const t = makeTranslate(dictionary)
    const view = render(<NativeRecordedContext recorded={recordedContext} t={t} />)
    const region = screen.getByRole('region', { name: t('native.recorded.title') })
    expect(within(region).getByText(t('native.recorded.summary', { bytes: 6023, count: 3 }))).not.toBeNull()
    expect(within(region).getByText(t('native.recorded.budget', { count: 4 }))).not.toBeNull()
    expect(within(region).getByText(t('native.recorded.reason.self-published'))).not.toBeNull()
    expect(within(region).getByText(t('native.recorded.count', { count: 2 }))).not.toBeNull()
    expect(within(region).getByText(t('native.recorded.reason.superseded'))).not.toBeNull()
    expect(within(region).queryByText(t('native.recorded.reason.unsupported'))).toBeNull()
    expect(within(region).getByText(t('native.recorded.capacityOwner'))).not.toBeNull()
    expect(within(region).getByText(t('native.recorded.bytesHint'))).not.toBeNull()
    expect(within(region).getByText(t('native.recorded.limit'))).not.toBeNull()
    expect(view.container.textContent).not.toContain(recordedContext.bindingId)
    expect(view.container.textContent).not.toContain(recordedContext.subscriptionId)
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('does not count self omission as a capacity loss or display empty exclusion details', () => {
    const t = makeTranslate(zh)
    const value = { ...recordedContext, omittedSourceCounts: { ...recordedContext.omittedSourceCounts, budget: 0, superseded: 0 } }
    const view = render(<NativeRecordedContext recorded={value} t={t} />)
    expect(screen.getByText(t('native.recorded.budget', { count: 0 }))).not.toBeNull()
    expect(screen.getByText(t('native.recorded.count', { count: 2 }))).not.toBeNull()
    expect(screen.queryByText(t('native.recorded.capacityOwner'))).toBeNull()
    view.rerender(<NativeRecordedContext recorded={{ ...value, omittedSourceCounts: {
      ...value.omittedSourceCounts, 'self-published': 0,
    } }} t={t} />)
    expect(view.container.querySelector('details')).toBeNull()
    expect(screen.getByText(t('native.recorded.summary', { bytes: 6023, count: 3 }))).not.toBeNull()
  })
})
