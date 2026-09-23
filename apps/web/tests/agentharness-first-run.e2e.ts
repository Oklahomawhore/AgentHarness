// AgentHarness launcher acceptance: collaboration is visible before a model key, and
// credential setup waits for an explicit conversation attempt.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'


describe('AgentHarness first-run browser journey', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const url = new URL(scaffold.authenticatedUrl)
    url.hash = 'agentharness=collaboration'
    await page.goto(url.href, { waitUntil: 'load' })
    await page.locator('[data-emergence-center]').waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens Tasks first and asks for a key only when conversation is activated', async () => {
    expect(await page.getByRole('dialog', { name: '内测声明' }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)
    if (process.env.AGENTHARNESS_CAPTURE_README_SCREENSHOT === '1') {
      await page.screenshot({ path: join(process.cwd(), 'assets/agentharness-first-run.png'), fullPage: true })
    }
    await page.getByRole('button', { name: '关闭涌现协作中心' }).click()

    const project = join(scaffold.workspaceCwd, 'first-run')
    await mkdir(project, { recursive: true })
    await page.getByRole('textbox', { name: '选择工作区' }).click()
    const chooser = page.getByRole('dialog', { name: '选择工作区目录' })
    await chooser.getByRole('button', { name: '编辑路径' }).click()
    const path = chooser.getByRole('textbox', { name: '编辑路径' })
    await path.fill(project)
    await path.press('Enter')
    await chooser.getByRole('button', { name: '打开', exact: true }).click()
    await chooser.waitFor({ state: 'detached', timeout: 15_000 })
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await input.waitFor({ timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)
    await input.click()
    const credential = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    await credential.waitFor({ timeout: 15_000 })
    await credential.getByLabel('API 密钥', { exact: true }).fill('sk-agentharness-first-run-fixture')
    await credential.getByRole('button', { name: '保存并继续' }).click()
    await credential.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8'))
      .toContain('DEEPSEEK_API_KEY: sk-agentharness-first-run-fixture')
  }, 60_000)
})
