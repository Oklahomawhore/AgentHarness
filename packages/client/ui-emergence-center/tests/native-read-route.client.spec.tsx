// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NativeReadRoute } from '../src/client/NativeReadRoute.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('keeps blank, unchanged and unavailable read routes from submitting a recovery command', () => {
  const current = '/ip4/127.0.0.1/tcp/4567/p2p/owner'
  const replacement = '/ip4/127.0.0.1/tcp/4568/p2p/owner'
  const update = vi.fn(async () => false)
  const props = { current, ready: true, update, t: makeTranslate(zh) }
  const f = render(<NativeReadRoute {...props} />)
  fireEvent.click(screen.getByText(zh['native.route.title']))
  const input = screen.getByLabelText<HTMLInputElement>(zh['native.route.new'])
  const submit = screen.getByRole('button', { name: zh['native.route.apply'] })
  const form = submit.closest('form')!
  for (const value of ['', '  ', ` ${current} `]) {
    fireEvent.change(input, { target: { value } })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.submit(form)
  }
  expect(update).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: ` ${replacement} ` } })
  f.rerender(<NativeReadRoute {...props} ready={false} />)
  expect(input.disabled).toBe(true)
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.submit(form)
  expect(update).not.toHaveBeenCalled()
  f.rerender(<NativeReadRoute {...props} />)
  fireEvent.submit(form)
  expect(update).toHaveBeenCalledExactlyOnceWith(replacement)
  expect(input.value).toBe(` ${replacement} `)
})
