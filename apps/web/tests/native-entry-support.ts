/** Main Session entry interaction shared by native collaboration browser cases. */
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'

/**
 * Paste once in the visible main entry, then use the disclosed file permission workflow.
 * @param page - page with its current Session collaboration panel open on the remote target.
 * @param text - owner-issued contribution, joint, or group entry.
 */
export async function verifyNativeContributionEntry(page: Page, text: string): Promise<void> {
  const panel = page.locator('[data-native-scope-panel]')
  const input = panel.getByRole('textbox', { name: '粘贴协作入口', exact: true })
  expect(await input.isVisible()).toBe(true)
  await input.fill(text)
  await panel.locator('[data-native-contribution]').getByRole('button', { name: '验证连接', exact: true }).click()
}

/**
 * Check numeric control frames against their labels independently of panel padding and native input metrics.
 * @param panel - visible collaboration panel whose numeric fields must fit their assigned columns.
 */
export async function assertNativeNumberFieldsFit(panel: Locator): Promise<void> {
  const overflowing = await panel.locator('input[type="number"]').evaluateAll(inputs => inputs.flatMap((input) => {
    if (input.getClientRects().length === 0) return []
    const label = input.closest('label')
    const frame = input.parentElement
    if (label === null || frame === null) throw new Error('Expected a labeled numeric field')
    const bounds = frame.getBoundingClientRect()
    const labelBounds = label.getBoundingClientRect()
    return bounds.left < labelBounds.left || bounds.right > labelBounds.right
      ? [{ id: input.id, left: bounds.left, right: bounds.right, labelLeft: labelBounds.left, labelRight: labelBounds.right }] : []
  }))
  expect(overflowing).toEqual([])
}
