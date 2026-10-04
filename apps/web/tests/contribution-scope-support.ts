/** Browser helpers for independent contribution flows with private Host identities. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { expect } from 'vitest'
import type { ClaudeScopeHookRequest, ClaudeScopeHookResult } from '@deepseek-ai/dsh-claude-scope'
import { captureStableAria, compareOrRefreshGolden, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

/** A separate browser context keeps each Host's authentication cookie isolated. */
export interface ContributionView {
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly tripwire: ReturnType<typeof watchConsole>
  readonly errors: string[]
}

/** Open one Host without sharing authentication cookies with another Host.
 * @param browser - test-owned browser, closed after every Host has finished using it.
 * @param scaffold - private Host whose authenticated URL is loaded.
 * @param collaboration - whether to open the collaboration center rather than the conversation.
 * @returns the page and its console evidence.
 */
export async function openContributionView(browser: Browser, scaffold: WebScaffold, collaboration: boolean): Promise<ContributionView> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const page = await context.newPage()
  const tripwire = watchConsole(page)
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  const url = new URL(scaffold.authenticatedUrl)
  if (collaboration) url.hash = 'agentharness=collaboration'
  await page.goto(url.href, { waitUntil: 'load' })
  await page.locator(collaboration ? '[data-emergence-center]' : '[class*="frame"]').first().waitFor({ timeout: 30_000 })
  return { scaffold, page, tripwire, errors }
}

/** Submit a fixture-controlled Claude hook through the authenticated product RPC endpoint.
 * @param scaffold - source Host receiving the hook.
 * @param generation - descriptor generation issued by that Host.
 * @param input - bounded fixture input, never a real Claude transcript.
 * @returns the actual Host output and receipt; neither proves external model adoption.
 */
export async function contributionHook(scaffold: WebScaffold, generation: string,
  input: ClaudeScopeHookRequest['input']): Promise<ClaudeScopeHookResult> {
  const response = await scaffold.hostFetch('/api/claudeScope/hook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'claudeScope/hook', payload: { args: { request: { generation, input } } } }),
  })
  expect(response.ok).toBe(true)
  const body = await response.json() as { result: { ok: true; value: ClaudeScopeHookResult } | { ok: false; error: unknown } }
  if (!body.result.ok) throw new Error(`Hook failed: ${JSON.stringify(body.result.error)}`)
  return body.result.value
}

/** Compare a panel's accessible content and check desktop and narrow-screen bounds.
 * @param view - visible page whose panel is settled.
 * @param selector - one panel with the product controls being exercised.
 * @param expectedPath - owner-local expected Markdown file.
 * @param replacements - explicitly generated fixture identities and timestamps only.
 * @param screenshotDirectory - optional diagnostics directory owned by this test invocation.
 * @returns after the original desktop viewport has been restored.
 */
export async function captureContributionPanel(view: ContributionView, selector: string, expectedPath: string,
  replacements: readonly (readonly [string, string])[], screenshotDirectory?: string): Promise<void> {
  await compareOrRefreshGolden(expectedPath,
    await captureStableAria(view.page, selector, view.scaffold.workspaceCwd, { replacements }), webSnapshotMode())
  if (screenshotDirectory !== undefined) await mkdir(screenshotDirectory, { recursive: true })
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await view.page.setViewportSize(viewport)
    const panel = view.page.locator(selector)
    await panel.scrollIntoViewIfNeeded()
    const bounds = await panel.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (screenshotDirectory !== undefined) await view.page.screenshot({
      path: join(screenshotDirectory, `${expectedPath.split('/').at(-1)!}-${String(viewport.width)}.png`), fullPage: true,
    })
  }
  await view.page.setViewportSize({ width: 1440, height: 1000 })
}
