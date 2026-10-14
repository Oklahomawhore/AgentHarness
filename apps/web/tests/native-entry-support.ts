/** Main Session entry interaction shared by native collaboration browser cases. */
import type { Page } from 'playwright'
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
