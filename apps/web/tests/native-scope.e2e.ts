/** Browser acceptance for one native Session receiving background context from an independent owner. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScopeInvitation } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { compareOrRefreshGolden, captureStableAria, assertFixtureInventory,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOTS = join(import.meta.dirname, 'snapshots/native-scope')
const DESKTOP = { width: 1440, height: 1000 }
const NARROW = { width: 390, height: 844 }
const ACCESS = '[data-emergence-center] details:has(> summary:text-is("独立设备协作"))'
const PANEL = '[data-native-scope-panel]'
const ACTIVITY = '[data-native-scope-activity]'
const OBJECTIVE = '订单接口的原生会话协作'
const FACT_ONE = 'ORDER_CONTEXT_ONE: orderCode is required.'
const FACT_TWO = 'ORDER_CONTEXT_TWO: sku is required.'
const FACT_THREE = 'ORDER_CONTEXT_THREE: itemId is required.'

function replay(): ReplayOverrideDoc {
  return [1, 2, 3, 4, 5].map(index => ({ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: `NATIVE_RESULT_${String(index)}` },
    { type: 'block-end', index: 0, block: { type: 'text', text: `NATIVE_RESULT_${String(index)}` } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }))
}

function textOf(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function layouts(page: Page, stage: string): Promise<void> {
  const directory = process.env.DSH_NATIVE_SCOPE_SHOTS
  if (directory !== undefined) await mkdir(directory, { recursive: true })
  for (const viewport of [DESKTOP, NARROW]) {
    await page.setViewportSize(viewport)
    const panel = page.locator(PANEL)
    await panel.waitFor()
    await expect.poll(async () => {
      const bounds = await panel.boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (directory !== undefined) {
      await page.screenshot({ path: join(directory, `${stage}-${String(viewport.width)}.png`), fullPage: true })
      if (stage === 'budget' && viewport.width === NARROW.width) {
        await page.locator(ACTIVITY).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(directory, `${stage}-activity-${String(viewport.width)}.png`), fullPage: true })
      }
    }
  }
  await page.setViewportSize(DESKTOP)
}

describe.skipIf(process.platform === 'win32')('web e2e: native Session scope controls', () => {
  let owner: WebScaffold
  let receiver: WebScaffold
  let browser: Browser
  let ownerPage: Page
  let page: Page
  let replayDir: string
  let sessionId: SessionId
  let invitation: ScopeInvitation
  const requests: Message[][] = []
  const trips: ReturnType<typeof watchConsole>[] = []
  const errors: string[] = []
  const firstAutomaticRequest = Promise.withResolvers<undefined>()
  const releaseAutomaticRequest = Promise.withResolvers<undefined>()

  async function observation() {
    const result = await receiver.ctx.scopeAgentContext.status({ agentId: sessionId })
    if (result.eligibility === 'not-live') throw new Error('The selected native Agent stopped being live')
    return result
  }
  async function state() { return (await observation()).state }

  async function openPanel(): Promise<Locator> {
    if (!await page.locator(PANEL).isVisible()) await page.getByRole('button', { name: '协作', exact: true }).click()
    await page.locator(PANEL).waitFor()
    return page.locator(PANEL)
  }

  async function closePanel(): Promise<void> {
    if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
    await page.locator(PANEL).waitFor({ state: 'hidden' })
  }

  async function prompt(text: string, index: number): Promise<void> {
    await closePanel()
    const settled = receiver.whenTurnSettled(30_000)
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(text)
    await composer.press('Enter')
    const id = await settled
    if (index === 1) sessionId = id
    else expect(id).toBe(sessionId)
    await page.getByText(`NATIVE_RESULT_${String(index)}`, { exact: true }).waitFor()
    expect(requests).toHaveLength(index)
  }

  async function publish(text: string): Promise<void> {
    const panel = ownerPage.locator('[data-emergence-center]')
    await panel.getByPlaceholder('发布可被后续派生或汇合任务继承的上下文；不要填写私聊或内部推理。').fill(text)
    await panel.getByRole('button', { name: '发布上下文', exact: true }).click()
    await panel.getByText(text, { exact: true }).waitFor()
  }

  async function automatic(panel: Locator, extra = '1'): Promise<void> {
    await panel.getByRole('radio', { name: '允许自动协作', exact: true }).check()
    await panel.getByRole('textbox', { name: '本地协作目标', exact: true }).fill('按已授权的订单接口事实更新前端。')
    await panel.getByLabel('允许新增的自动启动次数', { exact: true }).fill(extra)
    await panel.getByLabel('每轮最多步数', { exact: true }).fill('1')
    await panel.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
  }

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Native scope acceptance uses keyless controlled model responses')
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-native-scope-ui-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(replay()))
    // Each production composition owns a separate private home, database and transport key.
    owner = await launchWebScaffold({ hermeticMcpClients: true })
    receiver = await launchWebScaffold({ hermeticMcpClients: true,
      replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride, paceMs: 5 })
    receiver.ctx.on('llm/stream', async function* (options, next) {
      requests.push(structuredClone(options.messages))
      if (requests.length === 3) {
        firstAutomaticRequest.resolve(undefined)
        await releaseAutomaticRequest.promise
      }
      yield* next()
    })
    expect(owner.harnessHome).not.toBe(receiver.harnessHome)
    browser = await chromium.launch()
    // Browser contexts must be separate because cookies are not scoped by port.
    ownerPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    page = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const view of [ownerPage, page]) {
      trips.push(watchConsole(view))
      view.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    }
    const ownerUrl = new URL(owner.authenticatedUrl)
    ownerUrl.hash = 'agentharness=collaboration'
    await ownerPage.goto(ownerUrl.href, { waitUntil: 'load' })
    await ownerPage.locator('[data-emergence-center]').waitFor({ timeout: 30_000 })
    await page.goto(receiver.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, receiver.workspaceCwd, 'native-scope-receiver')
    if (MODE === 'refresh') await mkdir(SNAPSHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    releaseAutomaticRequest.resolve(undefined)
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => receiver?.close(), () => owner?.close(),
      () => replayDir === undefined ? Promise.resolve() : rm(replayDir, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Native scope browser cleanup failed')
  })

  it('authorizes passive and finite automatic work while keeping sync messages out of Chat', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-native-scope'))
    const ownerPanel = ownerPage.locator('[data-emergence-center]')
    await ownerPanel.getByLabel('协作显示名').fill('Native scope Owner')
    await ownerPanel.getByRole('button', { name: '保存身份', exact: true }).click()
    await ownerPanel.getByRole('status').getByText('协作身份已生效：Native scope Owner', { exact: true }).waitFor()
    await ownerPanel.getByRole('button', { name: '新建任务', exact: true }).click()
    await ownerPanel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = ownerPanel.locator('form').filter({ has: ownerPage.getByLabel('Task 名称') })
    await form.getByLabel('Task 名称').fill(OBJECTIVE)
    await form.getByLabel('初始共享上下文').fill(FACT_ONE)
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    const ownerAccess = ownerPage.locator(ACCESS)
    await ownerAccess.locator(':scope > summary').click()
    const recipient = await receiver.ctx.scopeAccess.identity()
    await ownerAccess.getByRole('textbox', { name: '接收设备身份', exact: true }).fill(recipient.peerId)
    await ownerAccess.getByRole('textbox', { name: '此会话的职责', exact: true }).fill('frontend')
    await ownerAccess.getByRole('button', { name: '生成只读邀请', exact: true }).click()
    await ownerAccess.getByText('已授予读取权限', { exact: true }).waitFor()
    const invitationText = await ownerAccess.getByRole('textbox', { name: '将此邀请交给接收人', exact: true }).inputValue()
    invitation = JSON.parse(invitationText) as ScopeInvitation

    await prompt('NATIVE_USER_ONE: 开始前端工作。', 1)
    let panel = await openPanel()
    expect(await panel.getByRole('radio', { name: '只在我工作时更新', exact: true }).isChecked()).toBe(true)
    const input = panel.getByRole('textbox', { name: '粘贴只读邀请', exact: true })
    await input.fill('{broken')
    expect(await panel.getByRole('button', { name: '连接此会话', exact: true }).isDisabled()).toBe(true)
    expect(await input.inputValue()).toBe('{broken')
    expect((await state()).binding).toBeNull()
    await input.fill(invitationText)
    await layouts(page, 'invitation')
    await panel.getByRole('button', { name: '连接此会话', exact: true }).click()
    await expect.poll(async () => (await state()).mode).toBe('passive')
    expect(requests).toHaveLength(1)
    expect((await observation()).activity).toEqual({ request: null, completed: null, evaluation: null })
    expect(await panel.locator(ACTIVITY).count()).toBe(0)
    expect((await state()).automatic).toBeNull()
    expect(receiver.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(receiver.ctx.developmentTasks.assignmentList()).toEqual([])
    await prompt('NATIVE_USER_TWO: 使用当前接口继续。', 2)
    const context = requests[1]!.filter(message => message.source.kind === 'scope-agent-context')
    expect(context).toHaveLength(1)
    expect(textOf(context[0]!)).toContain(FACT_ONE)
    expect(await page.getByText(FACT_ONE, { exact: false }).count()).toBe(0)

    await publish(FACT_TWO)
    panel = await openPanel()
    expect((await observation()).activity).toEqual({ request: null, completed: null, evaluation: null })
    expect(await panel.locator(ACTIVITY).count()).toBe(0)
    await automatic(panel)
    const autoSettled = receiver.whenTurnSettled(30_000)
    await panel.getByRole('button', { name: '确认启用自动协作', exact: true }).click()
    await firstAutomaticRequest.promise
    const dispatched = (await observation()).activity.request
    expect(dispatched).not.toBeNull()
    expect(dispatched).toMatchObject({ turn: 3, step: 1 })
    expect((await observation()).activity.completed).toBeNull()
    await panel.getByText('本轮已记录自动请求：第 3 轮、第 1 步。', { exact: true }).waitFor()
    expect(await panel.locator('[data-native-scope-activity-request]').count()).toBe(1)
    expect(await panel.locator('[data-native-scope-activity-completed]').count()).toBe(0)
    expect(await panel.locator(ACTIVITY).textContent()).not.toContain('ORDER_CONTEXT_')
    releaseAutomaticRequest.resolve(undefined)
    expect(await autoSettled).toBe(sessionId)
    const firstCompleted = (await observation()).activity.completed
    expect(firstCompleted).toMatchObject({ ...dispatched, turn: 3, step: 1 })
    await panel.getByText(`最近完成自动响应：第 3 轮，共享版本 ${String(firstCompleted!.taskRevision)}。`, { exact: true }).waitFor()
    expect(await panel.locator('[data-native-scope-activity-request]').count()).toBe(0)
    expect((await observation()).activity.request).toBeNull()
    expect(requests).toHaveLength(3)
    expect(requests[2]!.some(message => message.source.kind === 'scope-agent-pulse')).toBe(true)
    expect(requests[2]!.filter(message => message.source.kind === 'scope-agent-context').map(textOf).join('\n')).toContain(FACT_TWO)
    await publish(FACT_THREE)
    await expect.poll(async () => (await state()).pauseReason).toBe('budget')
    await panel.getByText('自动启动额度已用完。增加有限额度后才能恢复。', { exact: true }).waitFor()
    await layouts(page, 'budget')
    expect((await state()).usedBudget).toBe(1)
    expect(requests).toHaveLength(3)
    const replacements = [[invitation.ownerAddress, '{{ownerAddress}}'], [invitation.ownerPeerId, '{{ownerPeerId}}'],
      [invitation.recipientPeerId, '{{recipientPeerId}}'], [invitation.taskId, '{{taskId}}'],
      [String(invitation.expiresAt), '{{expiresAt}}'], [invitation.grantId, '{{grantId}}'], [invitation.generation, '{{generation}}']] as const
    await compareOrRefreshGolden(join(SNAPSHOTS, 'budget.expected.md'),
      await captureStableAria(page, PANEL, receiver.workspaceCwd, { replacements }), MODE)

    await automatic(panel, '2')
    const resumed = receiver.whenTurnSettled(30_000)
    await panel.getByRole('button', { name: '确认启用自动协作', exact: true }).click()
    expect(await resumed).toBe(sessionId)
    expect(requests).toHaveLength(4)
    expect(requests[3]!.filter(message => message.source.kind === 'scope-agent-context').map(textOf).join('\n')).toContain(FACT_THREE)
    expect((await state()).automatic?.activationLimit).toBe(3)
    expect((await state()).usedBudget).toBe(2)
    await expect.poll(async () => (await observation()).activity.completed?.turn).toBe(4)
    const secondCompleted = (await observation()).activity.completed
    expect(secondCompleted?.taskRevision).toBeGreaterThan(firstCompleted!.taskRevision)
    expect(secondCompleted?.requestSeq).toBeGreaterThan(firstCompleted!.requestSeq)
    await panel.getByText(`最近完成自动响应：第 4 轮，共享版本 ${String(secondCompleted!.taskRevision)}。`, { exact: true }).waitFor()
    expect(await panel.locator(ACTIVITY).textContent()).not.toContain('ORDER_CONTEXT_')
    await panel.getByRole('button', { name: '暂停自动协作', exact: true }).click()
    await expect.poll(async () => (await state()).pauseReason).toBe('user')
    await ownerAccess.getByRole('button', { name: '撤销读取权限', exact: true }).click()
    await ownerAccess.getByText('已撤销', { exact: true }).waitFor()
    await expect.poll(async () => {
      const result = await receiver.ctx.scopeAgentContext.status({ agentId: sessionId })
      return result.eligibility === 'not-live' ? result.eligibility : result.subscriptionState
    }, { timeout: 15_000 }).toBe('revoked')
    await panel.getByText('邀请已撤销，请离开后使用新邀请。', { exact: true }).waitFor()
    await layouts(page, 'revoked')
    expect(requests).toHaveLength(4)
    await panel.getByRole('button', { name: '离开共享上下文', exact: true }).click()
    await expect.poll(async () => (await state()).mode).toBe('left')
    await panel.locator(ACTIVITY).waitFor({ state: 'detached' })
    expect((await observation()).activity).toEqual({ request: null, completed: null, evaluation: null })
    const retainedEvidence = receiver.ctx.sessionProjections.stateOf(receiver.ctx.agents.get(sessionId)!.session, 'scopeAgentEvidence')
    expect(retainedEvidence?.completed?.request.turn).toBe(4)
    await prompt('NATIVE_USER_THREE: 继续本地工作。', 5)
    const withdrawn = requests[4]!.filter(message => message.source.kind === 'scope-agent-context')
    expect(withdrawn).toHaveLength(1)
    expect(withdrawn[0]!.source).toMatchObject({ form: 'withdrawn' })
    expect(withdrawn.map(textOf).join('\n')).not.toContain('ORDER_CONTEXT_')
    expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(3)
    expect(await page.getByText('NATIVE_RESULT_3', { exact: true }).count()).toBe(1)
    expect(await page.getByText('NATIVE_RESULT_4', { exact: true }).count()).toBe(1)
    expect(await page.getByText('ORDER_CONTEXT_', { exact: false }).count()).toBe(0)
    const processes = page.locator('[data-turn-process]')
    for (let index = 0; index < await processes.count(); index++) {
      const process = processes.nth(index)
      if (await process.getAttribute('aria-expanded') !== 'true') await process.click()
    }
    expect(await page.locator('[data-context-source]').filter({ hasText: /^scope-agent-(context|pulse)$/ }).count()).toBe(0)
    panel = await openPanel()
    expect(await panel.locator(ACTIVITY).count()).toBe(0)
    expect((await observation()).activity).toEqual({ request: null, completed: null, evaluation: null })
    await panel.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '轨迹', exact: true }).getAttribute('aria-selected')).toBe('true')
    await page.locator('tr[data-kind="context"]').filter({ hasText: 'Shared scope context withdrawn' }).last().click()
    await page.getByRole('tab', { name: '来源', exact: true }).click()
    const sourceTree = page.getByRole('tabpanel').getByRole('tree')
    expect(await sourceTree.textContent()).toContain('scope-agent-context')
    expect(await sourceTree.textContent()).toContain('withdrawn')
    const events = receiver.ctx.agents.get(sessionId)!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(2)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(3)
    expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')).toBe(true)
    expect(errors).toEqual([])
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(SNAPSHOTS, ['budget.expected.md'])
  }, 180_000)
})
