// Two isolated Web Hosts exercise the read-invitation UI without a model request.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { ClaudeScopeHookResult } from '@deepseek-ai/dsh-claude-scope'
import type { ScopeInvitation } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-scope-access'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/independent-scope', import.meta.url))
const ACCESS_SELECTOR = '[data-emergence-center] details:has(> summary:text-is("独立设备协作"))'
const SESSION_CHOSEN = 'browser-independent-receiver'
const SESSION_UNSELECTED = 'browser-independent-other'
const OBJECTIVE = '独立设备只读协作验收'
const PUBLICATION = '订单接口新增可选 coupon 字段，sku 仍为必填。'
const DESKTOP = { width: 1680, height: 1000 }
const NARROW = { width: 390, height: 844 }

interface BrowserHost {
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly tripwire: ReturnType<typeof watchConsole>
  readonly consoleErrors: string[]
}

async function openHost(browser: Browser, scaffold: WebScaffold): Promise<BrowserHost> {
  // newPage creates an isolated browser context: cookies are not port-scoped.
  const page = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  const consoleErrors: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  const url = new URL(scaffold.authenticatedUrl)
  url.hash = 'agentharness=collaboration'
  await page.goto(url.href, { waitUntil: 'load' })
  await page.locator('[data-emergence-center]').waitFor({ timeout: 30_000 })
  await page.locator(ACCESS_SELECTOR).locator(':scope > summary').click()
  try {
    await page.locator(ACCESS_SELECTOR).getByRole('textbox', { name: '本机设备身份', exact: true }).waitFor()
  } catch (error) {
    await saveFailureShot(page, 'web-e2e-independent-scope-boot')
    const diagnostics = await Promise.all(['identity', 'list'].map(async (method) => {
      const response = await scaffold.hostFetch(`/api/scopeAccess/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `diagnostic-${method}`,
          method: `scopeAccess/${method}`, payload: { args: {} } }),
      })
      const result: unknown = await response.json()
      return { method, status: response.status, result }
    }))
    throw new Error(`Independent scope inventory did not load: ${JSON.stringify(diagnostics)}\n`
      + await page.locator(ACCESS_SELECTOR).ariaSnapshot(), { cause: error })
  }
  return { scaffold, page, tripwire, consoleErrors }
}

async function hook(scaffold: WebScaffold, generation: string, sessionId: string,
  event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolBatch'): Promise<ClaudeScopeHookResult> {
  const response = await scaffold.hostFetch('/api/claudeScope/hook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `${event}-${sessionId}`, method: 'claudeScope/hook', payload: { args: { request: {
      generation, input: { hook_event_name: event, session_id: sessionId, cwd: scaffold.workspaceCwd },
    } } } }),
  })
  expect(response.ok).toBe(true)
  const body = await response.json() as {
    result: { ok: true; value: ClaudeScopeHookResult } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`Claude hook RPC failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

async function captureLayouts(host: BrowserHost, stage: string, focus: Locator): Promise<void> {
  const directory = process.env.DSH_INDEPENDENT_SCOPE_SHOTS
  if (directory !== undefined) await mkdir(directory, { recursive: true })
  for (const viewport of [DESKTOP, NARROW]) {
    await host.page.setViewportSize(viewport)
    await focus.scrollIntoViewIfNeeded()
    const access = host.page.locator(ACCESS_SELECTOR)
    const bounds = await access.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(await host.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await access.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (directory !== undefined) {
      await host.page.screenshot({ path: join(directory, `${stage}-${viewport.width}.png`), fullPage: true })
    }
  }
  await host.page.setViewportSize(DESKTOP)
}

describe.skipIf(process.platform === 'win32')('web e2e: independent scope read invitation', () => {
  let ownerScaffold: WebScaffold | undefined
  let receiverScaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let owner: BrowserHost
  let receiver: BrowserHost
  let receiverGeneration: string

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Independent scope browser acceptance is keyless; use replay or refresh')
    // The scaffold owns lifetime environment overrides. Boot serially and unwind in reverse order.
    ownerScaffold = await launchWebScaffold({ hermeticMcpClients: true })
    receiverScaffold = await launchWebScaffold({ hermeticMcpClients: true })
    expect(receiverScaffold.harnessHome).not.toBe(ownerScaffold.harnessHome)
    const descriptor = JSON.parse(await readFile(join(receiverScaffold.harnessHome, 'claude-scope', 'connection.json'), 'utf8')) as {
      generation: string
    }
    receiverGeneration = descriptor.generation
    for (const sessionId of [SESSION_CHOSEN, SESSION_UNSELECTED]) {
      expect((await hook(receiverScaffold, receiverGeneration, sessionId, 'SessionStart')).receipt.status).toBe('observed')
    }
    browser = await chromium.launch()
    owner = await openHost(browser, ownerScaffold)
    receiver = await openHost(browser, receiverScaffold)
    if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => receiverScaffold?.close(), () => ownerScaffold?.close()]) {
      try { await close() }
      catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Independent scope browser cleanup failed')
  })

  it('invites a peer, updates one chosen session, and withdraws it through the real UI', async () => {
    onTestFailed(async () => {
      await saveFailureShot(owner.page, 'web-e2e-independent-scope-owner')
      await saveFailureShot(receiver.page, 'web-e2e-independent-scope-receiver')
    })
    const ownerPanel = owner.page.locator('[data-emergence-center]')
    const receiverPanel = receiver.page.locator('[data-emergence-center]')
    const ownerAccess = owner.page.locator(ACCESS_SELECTOR)
    const receiverAccess = receiver.page.locator(ACCESS_SELECTOR)
    const recipientPeerId = await receiverAccess.getByRole('textbox', { name: '本机设备身份', exact: true }).inputValue()
    const ownerPeerId = await ownerAccess.getByRole('textbox', { name: '本机设备身份', exact: true }).inputValue()
    expect(recipientPeerId).not.toBe(ownerPeerId)
    expect(recipientPeerId.length).toBeGreaterThan(0)

    await ownerPanel.getByLabel('协作显示名').fill('只读邀请 Owner')
    await ownerPanel.getByRole('button', { name: '保存身份', exact: true }).click()
    await ownerPanel.getByRole('status').getByText('协作身份已生效：只读邀请 Owner', { exact: true }).waitFor()
    await ownerPanel.getByRole('button', { name: '新建任务', exact: true }).click()
    await ownerPanel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = ownerPanel.locator('form').filter({ has: owner.page.getByLabel('Task 名称') })
    await form.getByLabel('Task 名称').fill(OBJECTIVE)
    await form.getByLabel('初始共享上下文').fill('后端维护订单接口，接收方负责前端。')
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    await ownerPanel.getByRole('heading', { name: OBJECTIVE, exact: true }).waitFor()
    const task = owner.scaffold.ctx.developmentTasks.list({ limit: 200 }).find(item => item.objective === OBJECTIVE)
    if (task === undefined) throw new Error('The UI did not persist its Root Task')
    expect(task.origin.kind).toBe('root')

    await ownerAccess.getByRole('textbox', { name: '接收设备身份', exact: true }).fill(recipientPeerId)
    await ownerAccess.getByRole('textbox', { name: '此会话的职责', exact: true }).fill('frontend')
    await ownerAccess.getByRole('button', { name: '生成只读邀请', exact: true }).click()
    await ownerAccess.getByText('已授予读取权限', { exact: true }).waitFor()
    const invitationText = await ownerAccess.getByRole('textbox', { name: '将此邀请交给接收人', exact: true }).inputValue()
    const invitation = JSON.parse(invitationText) as ScopeInvitation
    expect(invitation).toMatchObject({ ownerPeerId, recipientPeerId, taskId: task.id, responsibility: 'frontend' })
    const replacements = [
      [String(invitation.expiresAt), '{{expiresAt}}'], [invitation.ownerAddress, '{{ownerAddress}}'],
      [ownerPeerId, '{{ownerPeerId}}'], [recipientPeerId, '{{recipientPeerId}}'], [task.id, '{{taskId}}'],
    ] as const
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'owner-invited.expected.md'),
      await captureStableAria(owner.page, ACCESS_SELECTOR, owner.scaffold.workspaceCwd, { replacements }), MODE)
    await captureLayouts(owner, 'owner-invited', ownerAccess.getByRole('textbox', { name: '将此邀请交给接收人', exact: true }))

    expect(receiver.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    await receiverAccess.getByText('选择本机创建的独立 Task 后可发出邀请。接收邀请不需要本地 Task 副本。', { exact: true }).waitFor()
    await receiverAccess.getByRole('textbox', { name: '粘贴收到的邀请', exact: true }).fill(invitationText)
    const connect = receiverAccess.getByRole('button', { name: '连接所选会话', exact: true })
    expect(await connect.isDisabled()).toBe(true)
    await receiverAccess.getByRole('combobox', { name: '选择一个会话', exact: true }).selectOption({ label: SESSION_CHOSEN })
    await connect.click()
    await receiverAccess.getByText('已连接，等待下一次权限核验', { exact: true }).waitFor()
    const sessions = await receiver.scaffold.ctx.claudeScope.sessions()
    expect(sessions.find(item => item.sessionId === SESSION_CHOSEN)).toMatchObject({ receiveTaskId: task.id, receiveState: 'pending' })
    expect(sessions.find(item => item.sessionId === SESSION_UNSELECTED)?.receiveSubscriptionId).toBeUndefined()
    expect(sessions.every(item => item.taskId === undefined)).toBe(true)

    const initial = await hook(receiver.scaffold, receiverGeneration, SESSION_CHOSEN, 'UserPromptSubmit')
    expect(initial.receipt.status).toBe('projected')
    expect(initial.output.hookSpecificOutput?.additionalContext).toContain(OBJECTIVE)
    expect(initial.output.hookSpecificOutput?.additionalContext).not.toContain(PUBLICATION)
    await ownerPanel.getByPlaceholder('发布可被后续派生或汇合任务继承的上下文；不要填写私聊或内部推理。').fill(PUBLICATION)
    await ownerPanel.getByRole('button', { name: '发布上下文', exact: true }).click()
    await ownerPanel.getByText(PUBLICATION, { exact: true }).waitFor()
    const updated = await hook(receiver.scaffold, receiverGeneration, SESSION_CHOSEN, 'PostToolBatch')
    expect(updated.receipt.status).toBe('projected')
    expect(updated.receipt.projectionId).not.toBe(initial.receipt.projectionId)
    expect(updated.output.hookSpecificOutput?.additionalContext).toContain(PUBLICATION)
    expect(updated.output.hookSpecificOutput?.additionalContext).toContain('"revision":2')
    expect(Buffer.byteLength(updated.output.hookSpecificOutput?.additionalContext ?? '', 'utf8')).toBeLessThanOrEqual(8000)
    const other = await hook(receiver.scaffold, receiverGeneration, SESSION_UNSELECTED, 'UserPromptSubmit')
    expect(other.output).toEqual({})
    expect(other.receipt.status).toBe('omitted')
    expect(receiver.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(await receiverPanel.locator('.react-flow__node').count()).toBe(0)
    await receiverPanel.getByRole('button', { name: '刷新', exact: true }).click()
    await receiverAccess.getByText('最近一次上下文已准备', { exact: true }).waitFor()
    const receiverText = await receiverPanel.textContent()
    expect(receiverText).toContain('只读接收无需新建 Task。请在上方查看所选会话的接收状态。')
    expect(receiverText).not.toContain('这里还没有本地 Task。可从顶部新建 Task 来管理共享上下文；向其他人的 Task 贡献工作变化无需新建。')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'receiver-active.expected.md'),
      await captureStableAria(receiver.page, ACCESS_SELECTOR, receiver.scaffold.workspaceCwd, { replacements }), MODE)
    await captureLayouts(receiver, 'receiver-active', receiverAccess.getByText('最近一次上下文已准备', { exact: true }))

    await ownerAccess.getByRole('button', { name: '撤销读取权限', exact: true }).click()
    await ownerAccess.getByText('已撤销', { exact: true }).waitFor()
    const withdrawn = await hook(receiver.scaffold, receiverGeneration, SESSION_CHOSEN, 'UserPromptSubmit')
    expect(withdrawn.receipt.status).toBe('withdrawn')
    const withdrawnText = withdrawn.output.hookSpecificOutput?.additionalContext
    expect(withdrawnText).toContain('"status":"revoked"')
    expect(withdrawnText).toContain('Do not treat earlier shared-scope projections as current facts or current permission.')
    expect(withdrawnText).not.toContain(PUBLICATION)
    await receiverPanel.getByRole('button', { name: '刷新', exact: true }).click()
    await receiverAccess.getByText('邀请已撤销', { exact: true }).waitFor()
    await captureLayouts(receiver, 'receiver-revoked', receiverAccess.getByText('邀请已撤销', { exact: true }))
    await receiverAccess.getByRole('button', { name: '停止接收', exact: true }).click()
    await receiverAccess.getByRole('button', { name: '停止接收', exact: true }).waitFor({ state: 'detached' })
    expect((await receiver.scaffold.ctx.claudeScope.sessions()).every(item => item.receiveSubscriptionId === undefined)).toBe(true)
    expect(receiver.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])

    for (const host of [owner, receiver]) {
      expect(host.consoleErrors).toEqual([])
      expect(host.tripwire.warnings).toEqual([])
      expect(host.tripwire.pageErrors).toEqual([])
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['owner-invited.expected.md', 'receiver-active.expected.md'])
  })
})
