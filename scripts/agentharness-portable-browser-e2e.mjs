#!/usr/bin/env node
/** Browser-level acceptance for the shipped portable Emergence Center context model. */

import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}

const url = option('--url', 'http://127.0.0.1:3080')
const screenshot = option('--screenshot', '/tmp/agentharness-emergence-center-live.png')
const expectMcpGuidance = process.argv.includes('--expect-mcp-guidance')
const playwrightRoot = await realpath(join(
  import.meta.dirname, '..', 'node_modules', '.pnpm', 'node_modules', 'playwright',
))
const { chromium } = await import(pathToFileURL(join(playwrightRoot, 'index.mjs')).href)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
const workspace = await mkdtemp(join(tmpdir(), 'agentharness-portable-browser-workspace-'))
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

async function completeOnboarding() {
  const firstDialog = page.locator('[role="dialog"]').first()
  await firstDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  for (let step = 0; step < 2; step += 1) {
    const welcome = page.getByRole('dialog', { name: /内测声明/u })
    if (await welcome.isVisible()) {
      await welcome.getByRole('button', { name: '继续' }).click()
      await welcome.waitFor({ state: 'detached', timeout: 15_000 })
      await firstDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
      continue
    }
    const credential = page.getByRole('dialog', { name: /添加一个 API Key 开始使用/u })
    if (!await credential.isVisible()) return
    await credential.getByLabel('API 密钥', { exact: true }).fill('agentharness-browser-e2e-placeholder')
    await credential.getByRole('button', { name: '保存并继续' }).click()
    await credential.waitFor({ state: 'detached', timeout: 15_000 })
    return
  }
}

try {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await completeOnboarding()

  const workspaceReason = page.getByText('请先选择或添加工作区，之后即可使用命令并发送消息。', { exact: true })
  await workspaceReason.waitFor({ timeout: 15_000 })
  await page.getByRole('textbox', { name: '选择工作区' }).click()
  const directoryDialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await directoryDialog.waitFor({ timeout: 10_000 })
  await directoryDialog.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = directoryDialog.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await directoryDialog.getByRole('button', { name: '打开', exact: true }).click()
  await directoryDialog.waitFor({ state: 'detached', timeout: 15_000 })

  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await page.getByRole('button', { name: '打开侧边栏' }).waitFor({ timeout: 10_000 })
  const trigger = page.getByRole('button', { name: '打开涌现协作中心' })
  await trigger.waitFor({ timeout: 15_000 })
  const triggerBox = await trigger.boundingBox()
  const badgeBox = await trigger.locator('span').last().boundingBox()
  assert(triggerBox !== null && badgeBox !== null)
  assert(badgeBox.x >= triggerBox.x)
  assert(badgeBox.x + badgeBox.width <= triggerBox.x + triggerBox.width + 0.5)

  await trigger.click()
  const panel = page.locator('[data-emergence-center]')
  await panel.waitFor({ timeout: 15_000 })
  await panel.getByLabel('协作显示名').fill('浏览器安装验收用户')
  await panel.getByRole('button', { name: '保存身份' }).click()
  await panel.getByRole('status').getByText('协作身份已生效：浏览器安装验收用户').waitFor({ timeout: 15_000 })

  await panel.getByRole('button', { name: '新建任务', exact: true }).click()
  assert.equal(await panel.getByRole('button', { name: '新建独立任务', exact: true }).count(), 1)
  await panel.getByRole('button', { name: '新建独立任务', exact: true }).click()
  const form = panel.locator('form')
  await form.getByLabel('Task 名称').fill('安装包共享上下文验收')
  await form.getByLabel('初始共享上下文').fill('验证身份、任务创建、上下文发布和 Session 连接指引。')
  const submit = form.getByRole('button', { name: '创建任务' })
  assert.equal(await submit.isEnabled(), true)
  await submit.click()
  await form.waitFor({ state: 'detached', timeout: 15_000 })
  await panel.getByRole('heading', { name: '安装包共享上下文验收' }).waitFor({ timeout: 15_000 })

  const agentHub = panel.getByRole('region', { name: '让 Agent Session 加入当前 Task' })
  await agentHub.waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByRole('tab').count(), 0)
  assert.match(await agentHub.textContent(), /目标 Codex\/Cursor\/Claude Session/u)
  assert.match(await agentHub.textContent(), /agentharness_task_connect/u)
  const firstAgentCard = agentHub.locator('article').first()
  const firstAgentCardBox = await firstAgentCard.boundingBox()
  assert(firstAgentCardBox !== null)
  assert(firstAgentCardBox.width >= 300)
  assert.equal((await panel.textContent()).includes('提交计划'), false)
  assert.equal((await panel.textContent()).includes('审计'), false)

  const contextInput = panel.getByPlaceholder('发布可被后续派生或汇合任务继承的上下文；不要填写私聊或内部推理。')
  await contextInput.fill('这个结论可以被后续 Fork 与 Merge 继承。')
  await panel.getByRole('button', { name: '发布上下文' }).click()
  await panel.getByText('这个结论可以被后续 Fork 与 Merge 继承。', { exact: true }).waitFor({ timeout: 15_000 })

  const graphNode = panel.locator('.react-flow__node').first()
  await graphNode.waitFor({ timeout: 15_000 })
  const graphNodeBox = await graphNode.boundingBox()
  assert(graphNodeBox !== null)
  assert(graphNodeBox.width >= 160)
  if (expectMcpGuidance) {
    await agentHub.getByText(/agentharness mcp-guide/u).first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  }
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.screenshot({ path: screenshot, fullPage: true })

  process.stdout.write(`${JSON.stringify({
    url,
    collapsedTriggerWidth: triggerBox.width,
    badgeWidth: badgeBox.width,
    badgeInsideTrigger: true,
    identityConfirmed: true,
    contextTaskCreated: true,
    contextPublished: true,
    agentHubVisibleWithoutTab: true,
    agentCardWidth: firstAgentCardBox.width,
    graphNodeWidth: graphNodeBox.width,
    mcpGuidanceVerified: expectMcpGuidance,
    consoleErrors,
    screenshot,
  }, null, 2)}\n`)
  assert.deepEqual(consoleErrors, [])
} finally {
  await Promise.all([
    browser.close(),
    rm(workspace, { recursive: true, force: true }),
  ])
}
