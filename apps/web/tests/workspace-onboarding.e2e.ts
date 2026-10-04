// Web e2e: a fresh shipped Web composition keeps Workspace onboarding inside
// the page and explains why the composer controls are unavailable before the
// first Workspace exists. Zero model calls: opening the browse dialog issues
// only directory-list RPCs.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

describe('web e2e: fresh Workspace onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the shipped in-page directory browser and explains the locked composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-onboarding'))
    await page.getByText('选择一个工作区开始', { exact: true }).waitFor({ timeout: 15_000 })
    const composer = page.getByRole('textbox', { name: '选择工作区', exact: true })
    expect(await composer.getAttribute('contenteditable')).toBe('false')
    expect(await composer.getAttribute('aria-haspopup')).toBe('menu')
    expect(await composer.getAttribute('tabindex')).toBe('0')

    const commands = page.getByRole('button', { name: '指令' })
    const send = page.getByRole('button', { name: '发送消息' })
    expect(await commands.isDisabled()).toBe(true)
    expect(await send.isDisabled()).toBe(true)

    await composer.focus()
    await composer.press('Enter')
    const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('button', { name: '新建文件夹' }).isVisible()).toBe(true)
    expect(await dialog.getByRole('button', { name: '打开', exact: true }).isVisible()).toBe(true)
    await dialog.getByRole('button', { name: '取消' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })

    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
