/** Existing native Sessions exchange authorized file work while retaining each destination’s permissions. */
import { verifyNativeContributionEntry } from './native-entry-support.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import type { ScopeGroupEntry } from '@deepseek-ai/dsh-scope-access/types'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, readPersistedEvents, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOTS = join(import.meta.dirname, 'snapshots/native-owner-contribution')
const PANEL = '[data-native-scope-panel]'
const LOCAL = '[data-native-local-contribution]'
const REMOTE = '[data-native-contribution]'
const AUTOMATIC = '[data-native-local-automatic]'
const OBJECTIVE = '两位用户共同维护重试行为'
const A_CODE = 'export const OWNER_NATIVE_retryDelay = 250;\n'
const B_CODE = 'export const REMOTE_NATIVE_retryCount = 3;\n'
const B_CODE_UPDATED = 'export const REMOTE_NATIVE_retryCount = 5;\n'
const B_CODE_PAUSED = 'export const REMOTE_NATIVE_retryCount = 7;\n'
const LOCAL_CONSENT = '我允许将上述目录中所选文件操作的内容分享到这个目标，直到到期或我停止分享。'
const READ_CONSENT = '我允许此会话在工作时接收整个目标的共享上下文；本项本身不允许自动开始新工作。'
const AUTOMATIC_CONSENT = '我允许本会话在我的职责内，按以下目标和额度自动响应共享变化；所有者批准加入后生效'
const REMOTE_GOAL = '在我负责的客户端范围核对共享接口，不改文件。'
const OWNER_RESPONSIBILITY = '协调双方的重试实现。'
const REMOTE_POLICY = { goal: REMOTE_GOAL, activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 0 }
const REMOTE_CONSENT = '我允许分享上述目录中的所选文件操作。任务所有者批准后可自动启用，直到到期或我停止分享。'
const DESKTOP = { width: 1440, height: 1000 }
const MOBILE = { width: 390, height: 844 }

function response(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function writeResponse(role: 'owner' | 'remote', content: string, ordinal = 1): StreamChunk[] {
  const id = ToolCallId(`two-user-${role}-${String(ordinal)}`)
  const args = JSON.stringify({ file_path: `project/${role}.ts`, content })
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function context(messages: readonly Message[], kind: 'development-task-context' | 'scope-agent-context'): Message[] {
  return messages.filter(message => message.source.kind === kind)
}
function textOf(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
async function prompt(host: WebScaffold, page: Page, marker: string): Promise<SessionId> {
  if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
  const settled = host.whenTurnSettled(30_000)
  const [id] = await Promise.all([settled, (async () => {
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(`继续本轮工作：${marker}`)
    await composer.press('Enter')
  })()])
  await page.getByText(marker, { exact: true }).waitFor()
  return id
}
async function panel(page: Page): Promise<Locator> {
  if (!await page.locator(PANEL).isVisible()) await page.getByRole('button', { name: '协作', exact: true }).click()
  return page.locator(PANEL)
}
async function permission(form: Locator, root: string, consent: string, prefilled = false): Promise<void> {
  expect(await form.getByRole('checkbox', { name: '写入文件（write）', exact: true }).isChecked()).toBe(prefilled)
  expect(await form.getByRole('checkbox', { name: consent, exact: true }).isChecked()).toBe(false)
  await form.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(root)
  await form.getByRole('checkbox', { name: '写入文件（write）', exact: true }).check()
  await form.getByLabel('授权有效期（小时）', { exact: true }).fill('1')
  await form.getByLabel('最多样本数', { exact: true }).fill('8')
  await form.getByLabel('每份样本字节上限', { exact: true }).fill('8192')
  await form.getByRole('checkbox', { name: consent, exact: true }).check()
}
async function captureStage(page: Page, workspace: string, stage: string,
  replacements: readonly (readonly [string, string])[] = [], surface = LOCAL, snapshots = SNAPSHOTS): Promise<void> {
  const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
  if (shots !== undefined) await mkdir(shots, { recursive: true })
  for (const viewport of [DESKTOP, MOBILE]) {
    await page.setViewportSize(viewport)
    await expect.poll(async () => {
      const bounds = await page.locator(PANEL).boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.locator(PANEL).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (shots !== undefined) await page.screenshot({ path: join(shots, `${snapshots === SNAPSHOTS ? '' : 'join-automatic-'}${stage}-${String(viewport.width)}.png`), fullPage: true })
    if (viewport === MOBILE) {
      const last = page.locator(PANEL).getByRole('button').last()
      await last.scrollIntoViewIfNeeded()
      await expect.poll(async () => {
        const button = await last.boundingBox()
        const bounds = await page.locator(PANEL).boundingBox()
        return button !== null && bounds !== null && button.y >= Math.max(0, bounds.y)
          && button.y + button.height <= Math.min(viewport.height, bounds.y + bounds.height)
      }).toBe(true)
    }
  }
  await page.setViewportSize(DESKTOP)
  const aria = await captureStableAria(page, surface, workspace, { replacements: [...replacements] })
  await compareOrRefreshGolden(join(snapshots, `${stage}.expected.md`), aria, MODE)
}
function assertReconstructed(host: WebScaffold, id: SessionId, request: readonly Message[],
  kind: 'development-task-context' | 'scope-agent-context'): void {
  const agent = host.ctx.agents.get(id)
  if (agent === undefined) throw new Error('Current native Agent is absent')
  const detached = Session.create(id, structuredClone(agent.session.snapshotEvents()), agent.session.header)
  expect(context(detached.deriveMessages(), kind)).toEqual(context(request, kind))
}

async function recordedCompletion(host: WebScaffold, page: Page, id: SessionId): Promise<void> {
  const observed = await host.ctx.scopeAgentContext.status({ agentId: id })
  if (observed.eligibility !== 'eligible' || observed.activity.completed === null) throw new Error('Completed automatic evidence missing')
  const completed = observed.activity.completed
  expect(observed.activity.request).toBeNull()
  await page.locator(PANEL).getByText(`最近完成自动响应：第 ${String(completed.turn)} 轮，共享版本 ${String(completed.taskRevision)}。`, { exact: true }).waitFor()
  const visible = await page.locator('[data-native-scope-activity]').textContent()
  for (const privateText of [A_CODE.trim(), B_CODE.trim(), B_CODE_UPDATED.trim(), B_CODE_PAUSED.trim()]) {
    expect(visible).not.toContain(privateText)
  }
}

describe.skipIf(process.platform === 'win32').each([false, true])('web e2e: owner-local and remote native collaboration (join automatic: %s)', (automaticJoin) => {
  const snapshots = automaticJoin ? join(import.meta.dirname, 'snapshots/native-joint-automatic') : SNAPSHOTS
  async function capture(page: Page, workspace: string, stage: string,
    replacements: readonly (readonly [string, string])[] = [], surface = LOCAL): Promise<void> {
    if (automaticJoin && surface === LOCAL) return
    await captureStage(page, workspace, stage, replacements, surface, snapshots)
  }
  let owner: WebScaffold | undefined
  let remote: WebScaffold | undefined
  let browser: Browser | undefined
  let directory: string | undefined
  let ownerPage: Page
  let remotePage: Page
  const ownerRequests: Message[][] = []
  const remoteRequests: Message[][] = []
  const trips: ReturnType<typeof watchConsole>[] = []
  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Native owner acceptance uses controlled keyless responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-owner-web-'))
    const ownerOverride = join(directory, 'owner.override.json')
    const remoteOverride = join(directory, 'remote.override.json')
    const ownerReplay: ReplayOverrideDoc = [response('OWNER_READY'), writeResponse('owner', A_CODE), response('OWNER_WORK_DONE'),
      response('OWNER_ADOPTED_REMOTE'), response('OWNER_AUTO_INITIAL'), response('OWNER_AUTO_UPDATED'),
      response('OWNER_PAUSED_READ'), response('OWNER_AUTO_RESUMED'), response('OWNER_REMOTE_WITHDRAWN'), response('OWNER_WITHDRAWN')].map(chunks => ({ kind: 'chunks', chunks }))
    const remoteReplay: ReplayOverrideDoc = [response('REMOTE_READY'),
      ...(automaticJoin ? [response('REMOTE_JOIN_AUTO')] : []), writeResponse('remote', B_CODE), response('REMOTE_WORK_DONE'),
      writeResponse('remote', B_CODE_UPDATED, 2), response('REMOTE_SECOND_DONE'),
      writeResponse('remote', B_CODE_PAUSED, 3), response('REMOTE_THIRD_DONE'),
      ...(automaticJoin ? [response('REMOTE_RESUMED_AFTER_STOP')] : []), response('REMOTE_STOPPED_READ'), response('REMOTE_READ_LEFT')].map(chunks => ({ kind: 'chunks', chunks }))
    await writeFile(ownerOverride, JSON.stringify(ownerReplay))
    await writeFile(remoteOverride, JSON.stringify(remoteReplay))
    owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
    remote = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'remote-override-only.jsonl'), replayOverride: remoteOverride })
    owner.ctx.on('llm/stream', (options, next) => { ownerRequests.push(structuredClone(options.messages)); return next() })
    remote.ctx.on('llm/stream', (options, next) => { remoteRequests.push(structuredClone(options.messages)); return next() })
    browser = await chromium.launch()
    ownerPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    remotePage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const [page, host, name] of [[ownerPage, owner, 'owner-native'], [remotePage, remote, 'remote-native']] as const) {
      trips.push(watchConsole(page))
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
      await mkdir(join(host.workspaceCwd, name, 'project'), { recursive: true })
    }
    if (MODE === 'refresh') await mkdir(snapshots, { recursive: true })
  }, 120_000)
  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => remote?.close(), () => owner?.close(),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Two-user browser cleanup failed')
  }, 120_000)
  it('joins through one UI entry and joint approval, separates finite owner work, and stops sharing before independently leaving reading', async () => {
    if (owner === undefined || remote === undefined) throw new Error('Hosts were not started')
    const a = owner
    const b = remote
    onTestFailed(() => saveFailureShot(ownerPage, 'web-e2e-native-owner-contribution'))
    expect(a.harnessHome).not.toBe(b.harnessHome)
    const [aIdentity, bIdentity] = await Promise.all([a.ctx.scopeAccess.identity(), b.ctx.scopeAccess.identity()])
    expect(aIdentity.peerId).not.toBe(bIdentity.peerId)
    const ownerAddress = aIdentity.addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner has no direct address')
    const aId = await prompt(a, ownerPage, 'OWNER_READY')
    const bId = await prompt(b, remotePage, 'REMOTE_READY')
    const originalRemote = b.ctx.agents.get(bId)
    if (originalRemote === undefined) throw new Error('Original remote Agent is absent')
    await ownerPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const center = ownerPage.locator('[data-emergence-center]')
    await center.getByLabel('协作显示名').fill('目标发起者')
    await center.getByRole('button', { name: '保存身份', exact: true }).click()
    await center.getByRole('status').getByText('协作身份已生效：目标发起者', { exact: true }).waitFor()
    await center.getByRole('button', { name: '新建任务', exact: true }).click()
    await center.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const create = center.locator('form').filter({ has: ownerPage.getByLabel('Task 名称') })
    await create.getByLabel('Task 名称').fill(OBJECTIVE)
    await create.getByLabel('初始共享上下文').fill('协调重试设置，只有明确授权的文件工作可以自动进入共享上下文。')
    await create.getByRole('button', { name: '创建任务', exact: true }).click()
    await create.waitFor({ state: 'detached' })
    const task = a.ctx.developmentTasks.list({ limit: 200 }).find(value => value.objective === OBJECTIVE)
    if (task === undefined) throw new Error('UI did not create its Task')
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
    const aPanel = await panel(ownerPage)
    await aPanel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
    const local = ownerPage.locator(LOCAL)
    await local.getByRole('combobox', { name: '本机目标', exact: true }).selectOption({ label: OBJECTIVE })
    await capture(ownerPage, a.workspaceCwd, 'unconnected')
    await local.getByRole('button', { name: '连接当前会话', exact: true }).click()
    await local.getByText(`已连接：${OBJECTIVE}`, { exact: true }).waitFor()
    expect((await a.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture).toBeNull()
    expect(ownerRequests).toHaveLength(1)
    expect(await local.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).isChecked()).toBe(false)
    await capture(ownerPage, a.workspaceCwd, 'connected')
    const aRoot = join(a.workspaceCwd, 'owner-native/project')
    await permission(local, aRoot, LOCAL_CONSENT)
    await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
    await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    const aCapture = (await a.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture
    if (aCapture === null) throw new Error('Local capture was not authorized')
    expect(aCapture.grant.taskId).toBe(task.id)
    expect(aCapture.collecting).toBe(true)
    const replacements: (readonly [string, string])[] = [[task.id, '{{taskId}}'],
      [await ownerPage.evaluate(value => new Date(value).toLocaleString(), aCapture.grant.expiresAt), '{{permissionExpiresLocal}}']]
    await capture(ownerPage, a.workspaceCwd, 'active', replacements)

    await ownerPage.keyboard.press('Escape')
    await ownerPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const access = ownerPage.locator('[data-emergence-center] details:has(> summary:text-is("独立设备协作"))')
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const ownerSharing = ownerPage.locator('[data-scope-contribution-owner]')
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    const applications = ownerPage.locator('[data-contribution-applications]')
    expect(await applications.getByRole('combobox', { name: '入口用途', exact: true }).inputValue()).toBe('join')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '邀请一个会话加入', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain('scope-join-entry')
    const entryText = await entryField.inputValue()
    const bPanel = await panel(remotePage)
    const sharing = remotePage.locator(REMOTE)
    await verifyNativeContributionEntry(remotePage, entryText)
    await sharing.getByText(task.id, { exact: true }).waitFor()
    const bRoot = join(b.workspaceCwd, 'remote-native/project')
    if (!automaticJoin) {
      const suggestions = sharing.getByRole('button', { name: '使用当前工作区建议', exact: true })
      await expect.poll(() => suggestions.isEnabled()).toBe(true)
      await suggestions.click()
      await expect.poll(() => sharing.getByRole('textbox', { name: '允许采集的目录', exact: true }).inputValue())
        .toBe(originalRemote.session.header.cwd)
      expect(await sharing.getByLabel('授权有效期（小时）', { exact: true }).inputValue()).toBe('8')
      expect(await sharing.getByLabel('最多样本数', { exact: true }).inputValue()).toBe('100')
      expect(await sharing.getByLabel('每份样本字节上限', { exact: true }).inputValue()).toBe('8192')
      for (const name of [READ_CONSENT, REMOTE_CONSENT, AUTOMATIC_CONSENT, '分享修改后的完整文件内容']) {
        expect(await sharing.getByRole('checkbox', { name, exact: true }).isChecked()).toBe(false)
      }
      expect(await sharing.locator('[data-native-initialization-consent] input[type="checkbox"]').isChecked()).toBe(false)
      expect((await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
      expect(remoteRequests).toHaveLength(1)
      expect(await sharing.getByRole('checkbox', { name: '编辑文件（edit）', exact: true }).isChecked()).toBe(true)
      await sharing.getByRole('checkbox', { name: '编辑文件（edit）', exact: true }).uncheck()
    }
    await permission(sharing, bRoot, REMOTE_CONSENT, !automaticJoin)
    expect(await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).isChecked()).toBe(false)
    expect(await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).isDisabled()).toBe(true)
    await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).check()
    const joinAutomatic = sharing.locator('[data-native-join-automatic]')
    expect(await joinAutomatic.getByRole('checkbox', { name: AUTOMATIC_CONSENT, exact: true }).isChecked()).toBe(false)
    expect(await joinAutomatic.getByLabel('本地协作目标', { exact: true }).count()).toBe(0)
    if (automaticJoin) {
      await joinAutomatic.getByRole('checkbox', { name: AUTOMATIC_CONSENT, exact: true }).check()
      expect(await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).isDisabled()).toBe(true)
      await joinAutomatic.getByLabel('本地协作目标', { exact: true }).fill(REMOTE_GOAL)
      await joinAutomatic.getByLabel('允许新增的自动启动次数', { exact: true }).fill('3')
      await joinAutomatic.getByLabel('每轮最多步数', { exact: true }).fill('2')
      await joinAutomatic.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    }
    await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
    await sharing.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
    const pending = (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture
    if (pending === null) throw new Error('Remote source consent was not saved')
    expect(pending.entry.kind).toBe('scope-join-entry')
    expect(pending.receiving?.state).toBe('waiting')
    expect(pending.receiving?.automatic).toEqual(automaticJoin ? REMOTE_POLICY : undefined)
    expect(remoteRequests).toHaveLength(1)
    const jointReplacements: (readonly [string, string])[] = [[task.id, '{{taskId}}'], [ownerAddress, '{{ownerAddress}}'],
      [aIdentity.peerId, '{{ownerPeerId}}'], [bIdentity.peerId, '{{sourcePeerId}}'], [entryText, '{{joinEntry}}'],
      [await remotePage.evaluate(value => new Date(value).toLocaleString(), pending.limits.expiresAt), '{{permissionExpiresLocal}}']]
    await capture(remotePage, b.workspaceCwd, 'joint-pending', jointReplacements, REMOTE)
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    expect(await applications.getByRole('button', { name: '批准读取与文件贡献', exact: true }).isDisabled()).toBe(true)
    await applications.getByLabel('该会话的协作职责', { exact: true }).fill(OWNER_RESPONSIBILITY)
    if (automaticJoin) {
      const [joined] = await Promise.all([b.whenTurnSettled(30_000),
        applications.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()])
      expect(joined).toBe(bId)
      await remotePage.getByText('REMOTE_JOIN_AUTO', { exact: true }).waitFor()
    } else await applications.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
    await applications.getByText('读取仍获授权；贡献结束不会自动撤销读取权限。', { exact: true }).waitFor()
    await sharing.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
    const remoteActive = await b.ctx.scopeAgentContributions.status({ agentId: bId })
    expect(remoteActive.capture?.selection).toEqual(pending.selection)
    expect(remoteActive.capture?.receiving?.invitation?.recipientPeerId).toBe(bIdentity.peerId)
    const readStatus = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (readStatus.eligibility !== 'eligible') throw new Error('Remote Agent is not eligible')
    expect(b.ctx.agents.get(bId)).toBe(originalRemote)
    expect(remoteActive.capture?.receiving?.invitation?.responsibility).toBe(OWNER_RESPONSIBILITY)
    expect(remoteActive.capture?.receiving?.automatic).toEqual(automaticJoin ? REMOTE_POLICY : undefined)
    expect(readStatus.state).toMatchObject(automaticJoin
      ? { mode: 'enabled', automatic: REMOTE_POLICY, usedBudget: 1 }
      : { mode: 'passive', automatic: null, usedBudget: 0 })
    expect(readStatus.state.binding?.kind).not.toBe('local-task')
    expect(remoteRequests).toHaveLength(automaticJoin ? 2 : 1)
    if (automaticJoin) {
      const automaticRequest = remoteRequests[1]
      if (automaticRequest === undefined) throw new Error('Joined automatic request missing')
      const pulse = automaticRequest.filter(message => message.source.kind === 'scope-agent-pulse')
      expect(pulse).toHaveLength(1)
      expect(textOf(pulse)).toContain(REMOTE_GOAL)
      expect(textOf(pulse)).not.toContain(OWNER_RESPONSIBILITY)
      expect(context(automaticRequest, 'scope-agent-context')).toHaveLength(1)
      assertReconstructed(b, bId, automaticRequest, 'scope-agent-context')
      await recordedCompletion(b, remotePage, bId)
    }
    await capture(remotePage, b.workspaceCwd, 'joint-active', jointReplacements, REMOTE)
    if (automaticJoin) {
      await bPanel.getByRole('button', { name: '暂停自动协作', exact: true }).click()
      const pausedJoined = await b.ctx.scopeAgentContext.status({ agentId: bId })
      if (pausedJoined.eligibility !== 'eligible') throw new Error('Joined Agent stopped being eligible')
      expect(pausedJoined.state).toMatchObject({ mode: 'paused', automatic: REMOTE_POLICY, usedBudget: 1, pauseReason: 'user' })
      expect(pausedJoined.state.binding).toEqual(readStatus.state.binding)
      expect((await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture?.collecting).toBe(true)
    }
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()

    expect(await prompt(a, ownerPage, 'OWNER_WORK_DONE')).toBe(aId)
    expect(await readFile(join(aRoot, 'owner.ts'), 'utf8')).toBe(A_CODE)
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(1)
    const localPublication = a.ctx.developmentTasks.get({ taskId: task.id }).context.find(item => item.localToolObservation !== undefined)
    expect(localPublication?.localToolObservation).toMatchObject({ tool: 'Write', reportedStatus: 'success', fields: { path: 'owner.ts' } })
    expect(localPublication?.localContribution?.grant).toEqual(aCapture.grant)
    expect(await prompt(b, remotePage, 'REMOTE_WORK_DONE')).toBe(bId)
    const bFirst = remoteRequests[automaticJoin ? 2 : 1]
    if (bFirst === undefined) throw new Error('Remote first work request missing')
    expect(textOf(context(bFirst, 'scope-agent-context'))).toContain(A_CODE.trim())
    expect(textOf(context(bFirst, 'scope-agent-context'))).not.toContain(B_CODE.trim())
    expect(await readFile(join(bRoot, 'remote.ts'), 'utf8')).toBe(B_CODE)
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    const peerPublication = a.ctx.developmentTasks.get({ taskId: task.id }).context.find(item => item.peerToolObservation !== undefined)
    expect(peerPublication?.peerToolObservation).toMatchObject({ observerPeerId: bIdentity.peerId,
      tool: 'Write', reportedStatus: 'success', fields: { path: 'remote.ts' } })
    expect(await prompt(a, ownerPage, 'OWNER_ADOPTED_REMOTE')).toBe(aId)
    const aAdopted = ownerRequests[3]
    if (aAdopted === undefined) throw new Error('Owner next request missing')
    expect(textOf(context(aAdopted, 'development-task-context'))).toContain(B_CODE.trim())
    expect(textOf(context(aAdopted, 'development-task-context'))).toContain(bIdentity.peerId)
    assertReconstructed(a, aId, aAdopted, 'development-task-context')
    const bLast = remoteRequests[automaticJoin ? 3 : 2]
    if (bLast === undefined) throw new Error('Remote final work request missing')
    assertReconstructed(b, bId, bLast, 'scope-agent-context')

    await panel(ownerPage)
    const automatic = ownerPage.locator(AUTOMATIC)
    expect(await automatic.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).isChecked()).toBe(false)
    await automatic.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).check()
    await automatic.getByLabel('本地协作目标', { exact: true }).fill('共享重试实现变化后核对双方接口，不改文件。')
    await automatic.getByLabel('允许新增的自动启动次数', { exact: true }).fill('4')
    await automatic.getByLabel('每轮最多步数', { exact: true }).fill('2')
    await automatic.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    const [initialAutomatic] = await Promise.all([a.whenTurnSettled(30_000),
      automatic.getByRole('button', { name: '确认启用自动协作', exact: true }).click()])
    expect(initialAutomatic).toBe(aId)
    await ownerPage.getByText('OWNER_AUTO_INITIAL', { exact: true }).waitFor()
    const enabled = await a.ctx.scopeAgentContext.status({ agentId: aId })
    if (enabled.eligibility === 'not-live') throw new Error('Owner Agent stopped being live')
    expect(enabled.state).toMatchObject({ mode: 'enabled', usedBudget: 1, automatic: { activationLimit: 4 } })
    expect(enabled.state.binding).toMatchObject({ kind: 'local-task', target: { taskId: task.id, taskBindingId: aCapture.grant.bindingId } })
    await recordedCompletion(a, ownerPage, aId)
    await capture(ownerPage, a.workspaceCwd, 'automatic', replacements)

    const [changedAutomatic, remoteChanged] = await Promise.all([a.whenTurnSettled(30_000),
      prompt(b, remotePage, 'REMOTE_SECOND_DONE')])
    expect(remoteChanged).toBe(bId)
    expect(changedAutomatic).toBe(aId)
    await ownerPage.getByText('OWNER_AUTO_UPDATED', { exact: true }).waitFor()
    const autoUpdated = ownerRequests[5]
    if (autoUpdated === undefined) throw new Error('Owner automatic request missing')
    const managed = context(autoUpdated, 'development-task-context')
    expect(managed).toHaveLength(1)
    expect(managed[0]?.source).toMatchObject({ version: 3, form: 'snapshot', projection: { taskId: task.id } })
    expect(textOf(managed)).toContain(B_CODE_UPDATED.trim())
    expect(textOf(managed)).toContain(bIdentity.peerId)
    expect(autoUpdated.some(message => message.source.kind === 'scope-agent-pulse')).toBe(true)
    expect(context(autoUpdated, 'scope-agent-context')).toEqual([])
    expect(ownerRequests).toHaveLength(6)
    await recordedCompletion(a, ownerPage, aId)
    await automatic.getByRole('button', { name: '暂停自动协作', exact: true }).click()
    await automatic.getByText('自动协作已暂停', { exact: true }).waitFor()
    const paused = await a.ctx.scopeAgentContext.status({ agentId: aId })
    if (paused.eligibility === 'not-live') throw new Error('Owner Agent stopped being live')
    expect(paused.state).toMatchObject({ mode: 'paused', usedBudget: 2, pauseReason: 'user' })
    expect(paused.localTask).toEqual(enabled.localTask)
    expect((await a.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture)
      .toMatchObject({ selection: aCapture.selection, collecting: true })
    await capture(ownerPage, a.workspaceCwd, 'paused', replacements)
    expect(await prompt(b, remotePage, 'REMOTE_THIRD_DONE')).toBe(bId)
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(3)
    expect(ownerRequests).toHaveLength(6)
    expect(await prompt(a, ownerPage, 'OWNER_PAUSED_READ')).toBe(aId)
    const pausedRequest = ownerRequests[6]
    if (pausedRequest === undefined) throw new Error('Paused ordinary owner request missing')
    expect(textOf(context(pausedRequest, 'development-task-context'))).toContain(B_CODE_PAUSED.trim())
    const stillPaused = await a.ctx.scopeAgentContext.status({ agentId: aId })
    if (stillPaused.eligibility === 'not-live') throw new Error('Owner Agent stopped being live')
    expect(stillPaused.state).toMatchObject({ mode: 'paused', usedBudget: 2, pendingActivation: null })

    await panel(ownerPage)
    const [resumed] = await Promise.all([a.whenTurnSettled(30_000),
      automatic.getByRole('button', { name: '恢复自动工作（剩余 2 次）', exact: true }).click()])
    expect(resumed).toBe(aId)
    await ownerPage.getByText('OWNER_AUTO_RESUMED', { exact: true }).waitFor()
    const resumedStatus = await a.ctx.scopeAgentContext.status({ agentId: aId })
    if (resumedStatus.eligibility === 'not-live') throw new Error('Owner Agent stopped being live')
    expect(resumedStatus.state).toMatchObject({ mode: 'enabled', usedBudget: 3, automatic: { activationLimit: 4 } })
    await automatic.getByRole('button', { name: '关闭自动工作，保留读取', exact: true }).click()
    await automatic.getByText('工作时更新', { exact: true }).waitFor()
    const passive = await a.ctx.scopeAgentContext.status({ agentId: aId })
    if (passive.eligibility === 'not-live') throw new Error('Owner Agent stopped being live')
    expect(passive.state).toMatchObject({ mode: 'passive', usedBudget: 3, automatic: null })
    expect(passive.activity).toEqual({ request: null, completed: null, evaluation: null })
    await ownerPage.locator('[data-native-scope-activity]').waitFor({ state: 'detached' })
    expect((await a.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture?.collecting).toBe(true)
    await panel(remotePage)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    await sharing.getByText('尚未允许分享文件工作', { exact: true }).waitFor()
    await expect.poll(async () => {
      const value = await b.ctx.scopeAgentContributions.status({ agentId: bId })
      return { capture: value.capture, continuation: value.receivingContinuation }
    }).toEqual({ capture: null, continuation: undefined })
    const readingAfterStop = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (readingAfterStop.eligibility !== 'eligible') throw new Error('Original remote Agent disappeared')
    expect(readingAfterStop.state.binding).toEqual(readStatus.state.binding)
    expect(readingAfterStop.state).toMatchObject(automaticJoin
      ? { mode: 'paused', automatic: REMOTE_POLICY, usedBudget: 1, pauseReason: 'user' }
      : { mode: 'passive', automatic: null, usedBudget: 0 })
    // The empty capture label can precede the receiving-continuation cleanup notification.
    await sharing.getByRole('button', { name: '退出此次协作', exact: true }).waitFor({ state: 'detached' })
    await capture(remotePage, b.workspaceCwd, 'joint-sharing-stopped', jointReplacements, REMOTE)
    if (automaticJoin) {
      const [resumedRead] = await Promise.all([b.whenTurnSettled(30_000),
        bPanel.getByRole('button', { name: '恢复自动工作（剩余 2 次）', exact: true }).click()])
      expect(resumedRead).toBe(bId)
      await remotePage.getByText('REMOTE_RESUMED_AFTER_STOP', { exact: true }).waitFor()
      const resumedReadStatus = await b.ctx.scopeAgentContext.status({ agentId: bId })
      if (resumedReadStatus.eligibility !== 'eligible') throw new Error('Stopped source lost its read connection')
      expect(resumedReadStatus.state).toMatchObject({ mode: 'enabled', automatic: REMOTE_POLICY, usedBudget: 2 })
      expect(resumedReadStatus.state.binding).toEqual(readStatus.state.binding)
      expect((await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
      const resumedRequest = remoteRequests[8]
      if (resumedRequest === undefined) throw new Error('Automatic read after sharing stop missing')
      expect(textOf(context(resumedRequest, 'scope-agent-context'))).toContain(A_CODE.trim())
      expect(resumedRequest.some(message => message.source.kind === 'scope-agent-pulse')).toBe(true)
      await recordedCompletion(b, remotePage, bId)
      await capture(remotePage, b.workspaceCwd, 'joint-auto-resumed', jointReplacements, REMOTE)
      await bPanel.getByRole('button', { name: '暂停自动协作', exact: true }).click()
      const pausedAfterStop = await b.ctx.scopeAgentContext.status({ agentId: bId })
      if (pausedAfterStop.eligibility !== 'eligible') throw new Error('Stopped source lost its original Agent')
      expect(pausedAfterStop.state).toMatchObject({ mode: 'paused', usedBudget: 2, pauseReason: 'user' })
    }
    await ownerPage.keyboard.press('Escape')
    await ownerPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    await applications.getByText('关联贡献授权已结束', { exact: true }).waitFor()
    await applications.getByText('读取仍获授权；贡献结束不会自动撤销读取权限。', { exact: true }).waitFor()
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
    expect(await prompt(b, remotePage, 'REMOTE_STOPPED_READ')).toBe(bId)
    const stoppedRead = remoteRequests[automaticJoin ? 9 : 7]
    if (stoppedRead === undefined) throw new Error('Reading after contribution-only stop missing')
    expect(textOf(context(stoppedRead, 'scope-agent-context'))).toContain(A_CODE.trim())
    expect(textOf(context(stoppedRead, 'scope-agent-context'))).not.toContain(B_CODE_PAUSED.trim())
    expect(await prompt(a, ownerPage, 'OWNER_REMOTE_WITHDRAWN')).toBe(aId)
    const ownerAfterRemoteStop = ownerRequests[8]
    if (ownerAfterRemoteStop === undefined) throw new Error('Owner remote-withdrawal request missing')
    const ownerAfterStopText = textOf(context(ownerAfterRemoteStop, 'development-task-context'))
    const remoteTerminal = a.ctx.developmentTasks.get({ taskId: task.id }).context.find(publication =>
      publication.peerContribution?.grant.captureId === pending.selection.captureId && publication.peerContribution.ended === 'left')
    if (remoteTerminal === undefined) throw new Error('Remote contribution termination missing from owner log')
    expect(ownerAfterStopText).toContain(remoteTerminal.id)
    expect(ownerAfterStopText).toContain('"selfPublishedOmissions":1')
    expect(ownerAfterStopText).toContain('"withdrawnOmissions":3')
    expect(ownerAfterStopText).not.toContain(A_CODE.trim())
    expect(ownerAfterStopText).not.toContain(B_CODE_PAUSED.trim())
    await panel(remotePage)
    await bPanel.getByRole('button', { name: '离开共享上下文', exact: true }).click()
    await expect.poll(async () => {
      const value = await b.ctx.scopeAgentContext.status({ agentId: bId })
      return value.eligibility === 'eligible' ? value.state.mode : null
    }).toBe('left')
    await remotePage.locator('[data-native-scope-activity]').waitFor({ state: 'detached' })
    await capture(remotePage, b.workspaceCwd, 'joint-read-left', jointReplacements, REMOTE)
    expect(await prompt(b, remotePage, 'REMOTE_READ_LEFT')).toBe(bId)
    const bWithdrawn = remoteRequests[automaticJoin ? 10 : 8]
    if (bWithdrawn === undefined) throw new Error('Remote request after independent read leave missing')
    expect(textOf(context(bWithdrawn, 'scope-agent-context'))).not.toContain(A_CODE.trim())
    expect(textOf(context(bWithdrawn, 'scope-agent-context'))).not.toContain(B_CODE_PAUSED.trim())
    assertReconstructed(b, bId, bWithdrawn, 'scope-agent-context')
    const remoteLeft = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (remoteLeft.eligibility !== 'eligible') throw new Error('Remote Agent disappeared after reading leave')
    expect(remoteLeft.state).toMatchObject({ mode: 'left', pendingActivation: null, usedBudget: automaticJoin ? 2 : 0 })
    expect(b.ctx.agents.get(bId)).toBe(originalRemote)
    await panel(ownerPage)
    await automatic.getByRole('button', { name: '退出本地目标', exact: true }).click()
    await local.getByRole('button', { name: '连接当前会话', exact: true }).waitFor()
    const stopped = await a.ctx.scopeAgentContributions.localStatus({ agentId: aId })
    expect(stopped.capture).toBeNull()
    expect(stopped.assignment).toBeNull()
    const left = await a.ctx.scopeAgentContext.status({ agentId: aId })
    if (left.eligibility === 'not-live') throw new Error('Owner Agent stopped being live')
    expect(left.localTask).toBeNull()
    expect(left.state).toMatchObject({ mode: 'left', pendingActivation: null, usedBudget: 3 })
    expect(left.activity).toEqual({ request: null, completed: null, evaluation: null })
    await ownerPage.locator('[data-native-scope-activity]').waitFor({ state: 'detached' })
    await capture(ownerPage, a.workspaceCwd, 'stopped', replacements)
    expect(await prompt(a, ownerPage, 'OWNER_WITHDRAWN')).toBe(aId)
    const aWithdrawn = ownerRequests[9]
    if (aWithdrawn === undefined) throw new Error('Owner withdrawal request missing')
    expect(textOf(context(aWithdrawn, 'development-task-context'))).not.toContain(A_CODE.trim())
    expect(textOf(context(aWithdrawn, 'development-task-context'))).not.toContain(B_CODE.trim())
    expect(textOf(context(aWithdrawn, 'development-task-context'))).not.toContain(B_CODE_PAUSED.trim())
    assertReconstructed(a, aId, aWithdrawn, 'development-task-context')
    for (const [host, id, canary, request, kind] of [
      [a, aId, B_CODE.trim(), aWithdrawn, 'development-task-context'],
      [b, bId, A_CODE.trim(), bWithdrawn, 'scope-agent-context'],
    ] as const) {
      const agent = host.ctx.agents.get(id)
      if (agent === undefined) throw new Error('Original Agent missing')
      expect(JSON.stringify(agent.session.snapshotEvents())).toContain(canary)
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const diskEvents = await readPersistedEvents(host, id)
      expect(diskEvents).toEqual(agent.session.snapshotEvents())
      expect(JSON.stringify(diskEvents)).toContain(canary)
      if (host === b) {
        const adopted = diskEvents.filter(event => event.type === 'scope-agent-context/join-read' && event.data.phase === 'adopted')
        expect(adopted).toHaveLength(1)
        expect(adopted[0]?.data).toMatchObject({ version: 4, adoptionId: pending.receiving?.adoptionId,
          plan: { kind: 'scope', automatic: automaticJoin ? REMOTE_POLICY : null,
            subscription: { version: 2, originalCapture: pending.selection } } })
        expect(diskEvents.filter(event => event.type === 'scope-agent-context/request')).toHaveLength(automaticJoin ? 2 : 0)
      }
      const restored = Session.create(id, structuredClone([...diskEvents]), agent.session.header)
      expect(context(restored.deriveMessages(), kind)).toEqual(context(request, kind))
    }
    expect(ownerRequests).toHaveLength(10)
    expect(remoteRequests).toHaveLength(automaticJoin ? 11 : 9)
    expect(b.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(snapshots, automaticJoin ? [
      'joint-pending.expected.md', 'joint-active.expected.md', 'joint-sharing-stopped.expected.md',
      'joint-auto-resumed.expected.md', 'joint-read-left.expected.md',
    ] : ['unconnected.expected.md', 'connected.expected.md', 'active.expected.md', 'automatic.expected.md', 'paused.expected.md', 'stopped.expected.md',
      'joint-pending.expected.md', 'joint-active.expected.md', 'joint-sharing-stopped.expected.md', 'joint-read-left.expected.md'])
  }, 180_000)
})

// Each destination owns consent and withdrawal while the source retains its original Task and automatic goal.
describe.skipIf(process.platform === 'win32')('web e2e: independent local and peer file capture', () => {
  const snapshots = join(import.meta.dirname, 'snapshots/native-parallel-contribution')
  const localGoal = '继续维护我负责的重试实现；外发文件工作不改变本地目标。'
  let owner: WebScaffold | undefined
  let source: WebScaffold | undefined
  let browser: Browser | undefined
  let directory: string | undefined
  let ownerPage: Page
  let sourcePage: Page
  const ownerRequests: Message[][] = []
  const sourceRequests: Message[][] = []
  const trips: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Parallel native capture acceptance uses controlled keyless responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-parallel-web-'))
    const ownerOverride = join(directory, 'owner.override.json')
    const sourceOverride = join(directory, 'source.override.json')
    const ownerReplay: ReplayOverrideDoc = [response('PARALLEL_OWNER_READY'), response('PARALLEL_OWNER_RECEIVED'),
      response('PARALLEL_OWNER_WITHDRAWN')].map(chunks => ({ kind: 'chunks', chunks }))
    const sourceReplay: ReplayOverrideDoc = [response('PARALLEL_SOURCE_READY'), response('PARALLEL_LOCAL_AUTO'),
      writeResponse('remote', B_CODE), response('PARALLEL_SHARED_WRITE'),
      writeResponse('remote', B_CODE_UPDATED, 2), response('PARALLEL_LOCAL_WRITE')].map(chunks => ({ kind: 'chunks', chunks }))
    await writeFile(ownerOverride, JSON.stringify(ownerReplay))
    await writeFile(sourceOverride, JSON.stringify(sourceReplay))
    owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
    source = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'source-override-only.jsonl'), replayOverride: sourceOverride })
    owner.ctx.on('llm/stream', (options, next) => { ownerRequests.push(structuredClone(options.messages)); return next() })
    source.ctx.on('llm/stream', (options, next) => { sourceRequests.push(structuredClone(options.messages)); return next() })
    browser = await chromium.launch()
    ownerPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    sourcePage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const [page, host, name] of [[ownerPage, owner, 'parallel-owner'], [sourcePage, source, 'parallel-source']] as const) {
      trips.push(watchConsole(page))
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
      await mkdir(join(host.workspaceCwd, name, 'project'), { recursive: true })
    }
    if (MODE === 'refresh') await mkdir(snapshots, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => source?.close(), () => owner?.close(),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Parallel capture browser cleanup failed')
  }, 120_000)

  it('shares one existing Session’s file work to both Tasks and stops the peer destination without clearing its local work', async () => {
    if (owner === undefined || source === undefined) throw new Error('Parallel Hosts were not started')
    const a = owner
    const b = source
    onTestFailed(() => saveFailureShot(sourcePage, 'web-e2e-native-parallel-contribution'))
    expect(a.harnessHome).not.toBe(b.harnessHome)
    const aId = await prompt(a, ownerPage, 'PARALLEL_OWNER_READY')
    const bId = await prompt(b, sourcePage, 'PARALLEL_SOURCE_READY')
    const originalAgent = b.ctx.agents.get(bId)
    if (originalAgent === undefined) throw new Error('Existing source Agent is missing')
    const tasks = []
    for (const [host, id, objective] of [[a, aId, '接收对方明确授权的文件工作'], [b, bId, '独立维护客户端重试实现']] as const) {
      const participantId = (await host.ctx.scopeAgentContributions.localStatus({ agentId: id })).participantId
      if (participantId === null) throw new Error('Existing Session has no local participant')
      const task = await host.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: participantId,
        objective, scope: '保留本地职责与文件权限，跨设备贡献另行授权。' })
      await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      tasks.push(task)
    }
    const [ownerTask, sourceTask] = tasks
    if (ownerTask === undefined || sourceTask === undefined) throw new Error('Both independently owned Tasks are required')
    const [aIdentity, bIdentity] = await Promise.all([a.ctx.scopeAccess.identity(), b.ctx.scopeAccess.identity()])
    expect(aIdentity.peerId).not.toBe(bIdentity.peerId)
    const ownerAddress = aIdentity.addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner address is missing')
    const bPanel = await panel(sourcePage)
    await bPanel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
    const local = sourcePage.locator(LOCAL)
    await local.getByText(`已连接：${sourceTask.objective}`, { exact: true }).waitFor()
    const root = join(b.workspaceCwd, 'parallel-source/project')
    await permission(local, root, LOCAL_CONSENT)
    await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
    await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    const localBefore = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    const localCapture = localBefore.capture
    if (localCapture === null || localBefore.assignment === null) throw new Error('Local capture was not established')
    const automatic = sourcePage.locator(AUTOMATIC)
    await automatic.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).check()
    await automatic.getByLabel('本地协作目标', { exact: true }).fill(localGoal)
    await automatic.getByLabel('允许新增的自动启动次数', { exact: true }).fill('2')
    await automatic.getByLabel('每轮最多步数', { exact: true }).fill('2')
    await automatic.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    const [automaticId] = await Promise.all([b.whenTurnSettled(30_000),
      automatic.getByRole('button', { name: '确认启用自动协作', exact: true }).click()])
    expect(automaticId).toBe(bId)
    await sourcePage.getByText('PARALLEL_LOCAL_AUTO', { exact: true }).waitFor()
    await automatic.getByRole('button', { name: '暂停自动协作', exact: true }).click()
    await automatic.getByText('自动协作已暂停', { exact: true }).waitFor()
    const receivingBefore = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (receivingBefore.eligibility !== 'eligible') throw new Error('Local scheduler is unavailable')
    expect(receivingBefore.state).toMatchObject({ mode: 'paused', usedBudget: 1, automatic: { goal: localGoal } })

    await ownerPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const center = ownerPage.locator('[data-emergence-center]')
    const access = center.locator('details:has(> summary:text-is("独立设备协作"))')
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const ownerSharing = center.locator('[data-scope-contribution-owner]')
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    const applications = center.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('contribution')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '生成一次申请入口', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain('contribution-entry')
    const entryText = await entryField.inputValue()
    await bPanel.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
    const sharing = sourcePage.locator(REMOTE)
    await bPanel.getByText('共享范围只增加获准上下文，不替换本地目标或文件许可。', { exact: true }).waitFor()
    expect(await bPanel.getByRole('button', { name: '连接此会话', exact: true }).isDisabled()).toBe(true)
    expect(await bPanel.getByText('本机会话设置已更新；后续请求将在线核验读取权限。', { exact: true }).count()).toBe(0)
    await verifyNativeContributionEntry(sourcePage, entryText)
    await sharing.getByText(ownerTask.id, { exact: true }).waitFor()
    await permission(sharing, root, REMOTE_CONSENT, true)
    expect(await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).count()).toBe(0)
    await sharing.getByRole('button', { name: '申请并允许批准后自动启用', exact: true }).click()
    await sharing.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
    const requested = (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture
    if (requested === null) throw new Error('Peer capture was not requested')
    expect(requested.receiving).toBeNull()
    expect(requested.selection).not.toEqual(localCapture.selection)
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await applications.getByRole('button', { name: '批准并让来源自动启用', exact: true }).click()
    await sharing.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    expect((await a.ctx.scopeAccess.contributionApplications({ taskId: ownerTask.id })).entries).toHaveLength(1)
    expect(sourceRequests).toHaveLength(2)
    expect((await b.ctx.scopeAccess.list()).subscriptions).toEqual([])
    expect((await b.ctx.scopeAgentContext.status({ agentId: bId })).eligibility).toBe('eligible')
    const replacements: (readonly [string, string])[] = [[ownerTask.id, '{{ownerTaskId}}'], [sourceTask.id, '{{sourceTaskId}}'],
      [ownerAddress, '{{ownerAddress}}'], [aIdentity.peerId, '{{ownerPeerId}}'], [bIdentity.peerId, '{{sourcePeerId}}'],
      [String(requested.entry.expiresAt), '{{entryExpiresAt}}'], [localCapture.grant.bindingId, '{{localBindingId}}'],
      [`${localCapture.grant.expectedBindingEpoch.nodeId}:${String(localCapture.grant.expectedBindingEpoch.seq)}`, '{{localBindingEpoch}}'],
    ]
    const expiry = async (value: number): Promise<readonly [string, string]> => [
      await sourcePage.evaluate(timestamp => new Date(timestamp).toLocaleString(), value), '{{permissionExpiresLocal}}',
    ]
    await captureStage(sourcePage, b.workspaceCwd, 'both-active',
      [...replacements, await expiry(requested.limits.expiresAt)], PANEL, snapshots)
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()

    expect(await prompt(b, sourcePage, 'PARALLEL_SHARED_WRITE')).toBe(bId)
    expect(await readFile(join(root, 'remote.ts'), 'utf8')).toBe(B_CODE)
    await expect.poll(() => b.ctx.developmentTasks.get({ taskId: sourceTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(1)
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: ownerTask.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    const localPublication = b.ctx.developmentTasks.get({ taskId: sourceTask.id }).context
      .find(item => item.localToolObservation !== undefined)
    expect(localPublication?.localContribution?.grant).toEqual(localCapture.grant)
    const peerPublication = a.ctx.developmentTasks.get({ taskId: ownerTask.id }).context
      .find(item => item.peerToolObservation !== undefined)
    expect(peerPublication?.peerToolObservation).toMatchObject({ observerPeerId: bIdentity.peerId,
      tool: 'Write', reportedStatus: 'success', fields: { path: 'remote.ts' } })
    expect(peerPublication?.peerContribution?.grant).toMatchObject(requested.selection)
    expect(await prompt(a, ownerPage, 'PARALLEL_OWNER_RECEIVED')).toBe(aId)
    const received = ownerRequests[1]
    if (received === undefined) throw new Error('Owner context request is missing')
    expect(textOf(context(received, 'development-task-context'))).toContain(B_CODE.trim())
    assertReconstructed(a, aId, received, 'development-task-context')
    for (const request of sourceRequests) expect(context(request, 'scope-agent-context')).toEqual([])

    await panel(sourcePage)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    await sharing.getByText('尚未允许分享文件工作', { exact: true }).waitFor()
    await expect.poll(async () => (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
    const localAfter = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    expect(localAfter.assignment).toEqual(localBefore.assignment)
    expect(localAfter.capture).toMatchObject({ selection: localCapture.selection, collecting: true, grant: localCapture.grant })
    const receivingAfter = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (receivingAfter.eligibility !== 'eligible') throw new Error('Local scheduler was lost')
    expect(receivingAfter.state).toEqual(receivingBefore.state)
    expect(receivingAfter.localTask).toEqual(receivingBefore.localTask)
    await bPanel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
    await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    await captureStage(sourcePage, b.workspaceCwd, 'peer-stopped-local-retained',
      [...replacements, await expiry(localCapture.grant.expiresAt)], LOCAL, snapshots)
    const ownerRevision = a.ctx.developmentTasks.get({ taskId: ownerTask.id }).revision
    expect(await prompt(b, sourcePage, 'PARALLEL_LOCAL_WRITE')).toBe(bId)
    expect(await readFile(join(root, 'remote.ts'), 'utf8')).toBe(B_CODE_UPDATED)
    await expect.poll(() => b.ctx.developmentTasks.get({ taskId: sourceTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(2)
    expect((await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })).capture?.selection).toEqual(localCapture.selection)
    expect(a.ctx.developmentTasks.get({ taskId: ownerTask.id }).revision).toBe(ownerRevision)
    expect(await prompt(a, ownerPage, 'PARALLEL_OWNER_WITHDRAWN')).toBe(aId)
    const withdrawn = ownerRequests[2]
    const sourceLast = sourceRequests.at(-1)
    if (withdrawn === undefined || sourceLast === undefined) throw new Error('Final model requests are missing')
    expect(textOf(context(withdrawn, 'development-task-context'))).not.toContain(B_CODE.trim())
    expect(textOf(context(withdrawn, 'development-task-context'))).not.toContain(B_CODE_UPDATED.trim())
    expect(b.ctx.agents.get(bId)).toBe(originalAgent)
    expect(b.ctx.developmentTasks.list({ limit: 32 })).toHaveLength(1)
    for (const [host, id, request] of [[a, aId, withdrawn], [b, bId, sourceLast]] as const) {
      const agent = host.ctx.agents.get(id)
      if (agent === undefined) throw new Error('Original Session was replaced')
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const events = await readPersistedEvents(host, id)
      expect(events).toEqual(agent.session.snapshotEvents())
      const restored = Session.create(id, structuredClone([...events]), agent.session.header)
      expect(context(restored.deriveMessages(), 'development-task-context')).toEqual(context(request, 'development-task-context'))
      expect(events.filter(event => event.type === 'scope-agent-context/join-read')).toEqual([])
    }
    await panel(sourcePage)
    await local.getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    await local.getByText('尚未允许分享文件工作', { exact: true }).waitFor()
    const localStopped = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    expect(localStopped.capture).toBeNull()
    expect(localStopped.assignment).toEqual(localBefore.assignment)
    const receivingStopped = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (receivingStopped.eligibility !== 'eligible') throw new Error('Local scheduler was cleared by capture stop')
    expect(receivingStopped.state).toEqual(receivingBefore.state)
    expect((await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
    expect(sourceRequests).toHaveLength(6)
    expect(ownerRequests).toHaveLength(3)
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(snapshots, ['both-active.expected.md', 'peer-stopped-local-retained.expected.md'])
  }, 180_000)
})

// A shared scope adds information to an existing local responsibility and retains its separate file permission.
describe.skipIf(process.platform === 'win32')('web e2e: joint scope retains existing local responsibility', () => {
  const snapshots = join(import.meta.dirname, 'snapshots/native-local-joint')
  const localGoal = '维护我负责的客户端重试逻辑，结合共享接口事实。'
  const corrected = 'export const OWNER_NATIVE_retryDelay = 500;\n'
  let owner: WebScaffold | undefined
  let source: WebScaffold | undefined
  let browser: Browser | undefined
  let directory: string | undefined
  let ownerPage: Page
  let sourcePage: Page
  const ownerRequests: Message[][] = []
  const sourceRequests: Message[][] = []
  const trips: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Retained-local joining uses controlled keyless responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-local-joint-web-'))
    const ownerOverride = join(directory, 'owner.override.json')
    const sourceOverride = join(directory, 'source.override.json')
    const ownerReplay: ReplayOverrideDoc = [response('LOCAL_JOIN_OWNER_READY'), writeResponse('owner', A_CODE),
      response('LOCAL_JOIN_OWNER_PREPARED'), response('LOCAL_JOIN_OWNER_RECEIVED'), writeResponse('owner', corrected, 2),
      response('LOCAL_JOIN_OWNER_CORRECTED'), response('LOCAL_JOIN_OWNER_AFTER_LEAVE')].map(chunks => ({ kind: 'chunks', chunks }))
    const sourceReplay: ReplayOverrideDoc = [response('LOCAL_JOIN_SOURCE_READY'), response('LOCAL_JOIN_ORIGINAL_AUTO'),
      writeResponse('remote', 'export const localRetryStatus = "prepared";\n'), response('LOCAL_JOIN_SOURCE_PREPARED'),
      response('LOCAL_JOIN_PASSIVE_READ'), writeResponse('remote', B_CODE, 2), response('LOCAL_JOIN_SHARED_WRITE'),
      response('LOCAL_JOIN_FIRST_RESPONSE'), response('LOCAL_JOIN_CORRECTED_RESPONSE'), response('LOCAL_JOIN_WITHDRAWN_READ'),
      writeResponse('remote', B_CODE_UPDATED, 3), response('LOCAL_JOIN_LOCAL_AFTER_LEAVE')].map(chunks => ({ kind: 'chunks', chunks }))
    await writeFile(ownerOverride, JSON.stringify(ownerReplay))
    await writeFile(sourceOverride, JSON.stringify(sourceReplay))
    owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
    source = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'source-override-only.jsonl'), replayOverride: sourceOverride })
    owner.ctx.on('llm/stream', (options, next) => { ownerRequests.push(structuredClone(options.messages)); return next() })
    source.ctx.on('llm/stream', (options, next) => { sourceRequests.push(structuredClone(options.messages)); return next() })
    browser = await chromium.launch()
    ownerPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    sourcePage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const [page, host, name] of [[ownerPage, owner, 'local-joint-owner'], [sourcePage, source, 'local-joint-source']] as const) {
      trips.push(watchConsole(page))
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
      await mkdir(join(host.workspaceCwd, name, 'project'), { recursive: true })
    }
    if (MODE === 'refresh') await mkdir(snapshots, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => source?.close(), () => owner?.close(),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Retained-local joint browser cleanup failed')
  }, 120_000)

  it('joins once, admits current facts beside local context, and preserves local work after remote departure', async () => {
    if (owner === undefined || source === undefined) throw new Error('Both independently owned Hosts are required')
    const a = owner
    const b = source
    onTestFailed(() => saveFailureShot(sourcePage, 'web-e2e-native-local-joint'))
    const aId = await prompt(a, ownerPage, 'LOCAL_JOIN_OWNER_READY')
    const bId = await prompt(b, sourcePage, 'LOCAL_JOIN_SOURCE_READY')
    const originalAgent = b.ctx.agents.get(bId)
    if (originalAgent === undefined) throw new Error('Original source Agent is missing')
    expect(a.harnessHome).not.toBe(b.harnessHome)
    const tasks = []
    for (const [host, id, page, name, objective] of [
      [a, aId, ownerPage, 'local-joint-owner', '维护后端重试接口'],
      [b, bId, sourcePage, 'local-joint-source', '维护客户端重试实现'],
    ] as const) {
      const participantId = (await host.ctx.scopeAgentContributions.localStatus({ agentId: id })).participantId
      if (participantId === null) throw new Error('Original Session has no participant')
      const task = await host.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: participantId,
        objective, scope: '各自保留职责和文件权限，加入共享范围只增加获准事实。' })
      await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      tasks.push(task)
      const current = await panel(page)
      await current.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
      const local = page.locator(LOCAL)
      await local.getByText(`已连接：${objective}`, { exact: true }).waitFor()
      await permission(local, join(host.workspaceCwd, name, 'project'), LOCAL_CONSENT)
      await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
      await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    }
    const [ownerTask, localTask] = tasks
    if (ownerTask === undefined || localTask === undefined) throw new Error('Local responsibilities were not created')
    const localBefore = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    const originalCapture = localBefore.capture
    if (originalCapture === null || localBefore.assignment === null) throw new Error('Original capture or assignment is missing')
    const localAutomatic = sourcePage.locator(AUTOMATIC)
    await localAutomatic.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).check()
    await localAutomatic.getByLabel('本地协作目标', { exact: true }).fill(localGoal)
    await localAutomatic.getByLabel('允许新增的自动启动次数', { exact: true }).fill('4')
    await localAutomatic.getByLabel('每轮最多步数', { exact: true }).fill('2')
    await localAutomatic.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    await Promise.all([b.whenTurnSettled(30_000), localAutomatic.getByRole('button', { name: '确认启用自动协作', exact: true }).click()])
    await sourcePage.getByText('LOCAL_JOIN_ORIGINAL_AUTO', { exact: true }).waitFor()
    await localAutomatic.getByRole('button', { name: '暂停自动协作', exact: true }).click()
    await localAutomatic.getByText('自动协作已暂停', { exact: true }).waitFor()
    const before = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (before.eligibility !== 'eligible' || before.localTask === null) throw new Error('Original local scheduling target is missing')
    expect(before.state).toMatchObject({ mode: 'paused', usedBudget: 1, automatic: { goal: localGoal, activationLimit: 4 } })
    await prompt(a, ownerPage, 'LOCAL_JOIN_OWNER_PREPARED')
    await prompt(b, sourcePage, 'LOCAL_JOIN_SOURCE_PREPARED')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: ownerTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(1)
    await expect.poll(() => b.ctx.developmentTasks.get({ taskId: localTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(1)

    await ownerPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const center = ownerPage.locator('[data-emergence-center]')
    const access = center.locator('details:has(> summary:text-is("独立设备协作"))')
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const ownerSharing = center.locator('[data-scope-contribution-owner]')
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    const applications = center.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('join')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '邀请一个会话加入', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain('scope-join-entry')
    const entryText = await entryField.inputValue()
    const sourcePanel = await panel(sourcePage)
    await sourcePanel.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
    const sharing = sourcePage.locator(REMOTE)
    await verifyNativeContributionEntry(sourcePage, entryText)
    await sharing.getByText(ownerTask.id, { exact: true }).waitFor()
    await permission(sharing, join(b.workspaceCwd, 'local-joint-source/project'), REMOTE_CONSENT, true)
    expect(await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).isChecked()).toBe(false)
    expect(await sharing.getByRole('checkbox', { name: AUTOMATIC_CONSENT, exact: true }).isChecked()).toBe(false)
    const history = sharing.getByRole('checkbox', { name: '同时分享本次范围内已记录的工具操作', exact: true })
    expect(await history.isChecked()).toBe(false)
    await history.check()
    await sharing.getByLabel('最多样本数', { exact: true }).fill('7')
    expect(await history.isChecked()).toBe(false)
    expect(await sharing.getByRole('checkbox', { name: REMOTE_CONSENT, exact: true }).isChecked()).toBe(false)
    await sharing.getByLabel('最多样本数', { exact: true }).fill('8')
    await history.check()
    expect(await history.isChecked(), 'Historical permission remains selected after its explicit second confirmation').toBe(true)
    await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).check()
    expect(await history.isChecked(), 'Separate receiving consent must not clear historical file permission').toBe(true)
    expect(await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).isDisabled()).toBe(true)
    await sharing.getByRole('checkbox', { name: REMOTE_CONSENT, exact: true }).check()
    expect(await history.isChecked(), 'Renewed collection consent must preserve separately selected history').toBe(true)
    const requestCall = vi.spyOn(b.ctx.scopeAgentContributions, 'request')
    try {
      await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
      await sharing.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
      expect(requestCall).toHaveBeenCalledOnce()
      expect(requestCall.mock.calls[0]?.[0].initialization, 'Actual Host request retains the displayed historical consent').toEqual({
        kind: 'recorded-local-tools', expectedLocalCapture: originalCapture.selection, localTask: localBefore.assignment,
      })
    } finally { requestCall.mockRestore() }
    const requested = (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture
    if (requested === null) throw new Error('Joint source permission was not recorded')
    expect(requested.receiving).toMatchObject({ localTask: before.localTask, state: 'waiting' })
    expect(requested.receiving?.automatic).toBeUndefined()
    expect(requested.initialization).toMatchObject({ state: 'pending', request: { kind: 'recorded-local-tools',
      expectedLocalCapture: originalCapture.selection, localTask: localBefore.assignment } })
    const [aIdentity, bIdentity] = await Promise.all([a.ctx.scopeAccess.identity(), b.ctx.scopeAccess.identity()])
    const replacements: (readonly [string, string])[] = [[ownerTask.id, '{{ownerTaskId}}'], [localTask.id, '{{localTaskId}}'],
      [aIdentity.peerId, '{{ownerPeerId}}'], [bIdentity.peerId, '{{sourcePeerId}}'],
      [String(requested.entry.expiresAt), '{{entryExpiresAt}}'],
      [originalCapture.grant.bindingId, '{{localBindingId}}'],
      [`${originalCapture.grant.expectedBindingEpoch.nodeId}:${String(originalCapture.grant.expectedBindingEpoch.seq)}`, '{{localBindingEpoch}}'],
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), requested.limits.expiresAt), '{{permissionExpiresLocal}}']]
    for (const address of aIdentity.addresses) replacements.unshift([address, '{{ownerAddress}}'])
    await captureStage(sourcePage, b.workspaceCwd, 'local-joint-pending', replacements, PANEL, snapshots)
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await applications.getByText('允许分享加入前已记录的工具操作，以及后续获准的新操作。', { exact: true }).waitFor()
    await applications.getByLabel('该会话的协作职责', { exact: true }).fill('维护客户端重试实现；原本地目标保持不变。')
    await applications.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
    await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
    const joined = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (joined.eligibility !== 'eligible' || joined.state.binding?.kind !== 'local-task-scope') throw new Error('Composite reading was not adopted')
    expect(joined.localTask).toEqual(before.localTask)
    expect(joined.state).toMatchObject({ mode: 'passive', automatic: null, usedBudget: 1,
      binding: { retainedLocal: { automatic: before.state.automatic } } })
    expect(sourceRequests).toHaveLength(4)
    expect((await a.ctx.scopeAccess.contributionApplications({ taskId: ownerTask.id })).entries).toHaveLength(1)
    expect((await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })).capture?.selection).toEqual(originalCapture.selection)
    await sharing.getByText('任务所有者已确认本次选中的 1 条既有记录。', { exact: true }).waitFor()
    const initialized = (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture?.initialization
    expect(initialized).toMatchObject({ state: 'frozen', coverage: {
      recorded: 1, selected: 1, omitted: 0, unconfirmed: 0, inFlight: 0, acknowledged: 1,
    } })
    expect(a.ctx.developmentTasks.get({ taskId: ownerTask.id }).context
      .filter(item => item.peerToolObservation?.version === 2)).toHaveLength(1)
    await captureStage(sourcePage, b.workspaceCwd, 'local-joint-passive', replacements, PANEL, snapshots)
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
    expect(await prompt(b, sourcePage, 'LOCAL_JOIN_PASSIVE_READ')).toBe(bId)
    const passive = sourceRequests[4]
    if (passive === undefined) throw new Error('Joined passive request is missing')
    expect(textOf(context(passive, 'scope-agent-context'))).toContain(A_CODE.trim())
    expect(textOf(context(passive, 'development-task-context'))).toContain(localTask.objective)
    for (const kind of ['scope-agent-context', 'development-task-context'] as const) assertReconstructed(b, bId, passive, kind)
    await prompt(a, ownerPage, 'LOCAL_JOIN_OWNER_RECEIVED')
    const historicalRequest = ownerRequests[3]
    if (historicalRequest === undefined) throw new Error('Owner historical request is missing')
    const historicalPublication = a.ctx.developmentTasks.get({ taskId: ownerTask.id }).context
      .find(item => item.peerToolObservation?.version === 2)
    if (historicalPublication === undefined) throw new Error('Recorded source publication is missing')
    expect(historicalPublication.peerToolObservation).toMatchObject({ tool: 'Write',
      fields: { content: 'export const localRetryStatus = "prepared";\n' } })
    expect(textOf(context(historicalRequest, 'development-task-context'))).toContain(JSON.stringify(historicalPublication.text))
    expect(textOf(context(historicalRequest, 'development-task-context'))).not.toContain(B_CODE.trim())
    assertReconstructed(a, aId, historicalRequest, 'development-task-context')
    await prompt(b, sourcePage, 'LOCAL_JOIN_SHARED_WRITE')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: ownerTask.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(2)
    await expect.poll(() => b.ctx.developmentTasks.get({ taskId: localTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(2)

    await panel(sourcePage)
    await sourcePanel.getByRole('radio', { name: '允许自动协作', exact: true }).check()
    await sourcePanel.getByLabel('本地协作目标', { exact: true }).fill(localGoal)
    await sourcePanel.getByLabel('允许新增的自动启动次数', { exact: true }).fill('2')
    await sourcePanel.getByLabel('每轮最多步数', { exact: true }).fill('2')
    await sourcePanel.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    await Promise.all([b.whenTurnSettled(30_000), sourcePanel.getByRole('button', { name: '确认启用自动协作', exact: true }).click()])
    await sourcePage.getByText('LOCAL_JOIN_FIRST_RESPONSE', { exact: true }).waitFor()
    const correcting = b.whenTurnSettled(30_000)
    await prompt(a, ownerPage, 'LOCAL_JOIN_OWNER_CORRECTED')
    const ownerLive = ownerRequests[4]
    if (ownerLive === undefined) throw new Error('Owner live request is missing')
    expect(textOf(context(ownerLive, 'development-task-context'))).toContain(B_CODE.trim())
    expect(await correcting).toBe(bId)
    await sourcePage.getByText('LOCAL_JOIN_CORRECTED_RESPONSE', { exact: true }).waitFor()
    const changed = sourceRequests[8]
    if (changed === undefined) throw new Error('Shared correction was not admitted to an automatic request')
    expect(textOf(context(changed, 'scope-agent-context'))).toContain(corrected.trim())
    expect(textOf(context(changed, 'development-task-context'))).toContain(localTask.objective)
    const afterResponses = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (afterResponses.eligibility !== 'eligible') throw new Error('Combined scheduling was lost')
    expect(afterResponses.state.usedBudget).toBe(3)
    expect(afterResponses.activity.completed?.localTaskRevision).toBeDefined()
    for (const kind of ['scope-agent-context', 'development-task-context'] as const) assertReconstructed(b, bId, changed, kind)
    await panel(sourcePage)
    await recordedCompletion(b, sourcePage, bId)
    await captureStage(sourcePage, b.workspaceCwd, 'local-joint-automatic', replacements, PANEL, snapshots)

    await panel(ownerPage)
    await ownerPage.locator(LOCAL).getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    await ownerPage.locator(LOCAL).getByText('尚未允许分享文件工作', { exact: true }).waitFor()
    await prompt(b, sourcePage, 'LOCAL_JOIN_WITHDRAWN_READ')
    const withdrawn = sourceRequests[9]
    if (withdrawn === undefined) throw new Error('Withdrawal request is missing')
    expect(textOf(context(withdrawn, 'scope-agent-context'))).not.toContain(A_CODE.trim())
    expect(textOf(context(withdrawn, 'scope-agent-context'))).not.toContain(corrected.trim())
    expect(textOf(context(withdrawn, 'development-task-context'))).toContain(localTask.objective)
    await panel(sourcePage)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('button', { name: '退出此次协作', exact: true }).click()
    await expect.poll(async () => (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
    await expect.poll(async () => {
      const current = await b.ctx.scopeAgentContext.status({ agentId: bId })
      return current.eligibility === 'not-live' ? null : current.state.binding?.kind
    }).toBe('local-task')
    const restored = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (restored.eligibility !== 'eligible') throw new Error('Local responsibility was not restored')
    expect(restored.state).toMatchObject({ binding: { kind: 'local-task' }, mode: 'paused', usedBudget: 3, automatic: before.state.automatic })
    expect(restored.localTask).toEqual(before.localTask)
    expect(restored.state.binding?.id).toBe(joined.state.binding.retainedLocal.bindingId)
    const remaining = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    expect(remaining.assignment).toEqual(localBefore.assignment)
    expect(remaining.capture).toMatchObject({ selection: originalCapture.selection, collecting: true, grant: originalCapture.grant })
    await sourcePanel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
    await sourcePage.locator(AUTOMATIC).getByText('自动协作已暂停', { exact: true }).waitFor()
    const localExpiry = await sourcePage.evaluate(value => new Date(value).toLocaleString(), originalCapture.grant.expiresAt)
    await captureStage(sourcePage, b.workspaceCwd, 'local-joint-left-local-kept',
      [[localExpiry, '{{permissionExpiresLocal}}'], ...replacements], LOCAL, snapshots)
    const remoteRevision = a.ctx.developmentTasks.get({ taskId: ownerTask.id }).revision
    await prompt(b, sourcePage, 'LOCAL_JOIN_LOCAL_AFTER_LEAVE')
    await expect.poll(() => b.ctx.developmentTasks.get({ taskId: localTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(3)
    expect(a.ctx.developmentTasks.get({ taskId: ownerTask.id }).revision).toBe(remoteRevision)
    expect(await readFile(join(b.workspaceCwd, 'local-joint-source/project/remote.ts'), 'utf8')).toBe(B_CODE_UPDATED)
    await prompt(a, ownerPage, 'LOCAL_JOIN_OWNER_AFTER_LEAVE')
    expect(textOf(context(ownerRequests.at(-1)!, 'development-task-context'))).not.toContain(B_CODE.trim())
    expect(b.ctx.agents.get(bId)).toBe(originalAgent)
    expect((await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })).assignment).toEqual(localBefore.assignment)
    for (const [host, id, request] of [[a, aId, ownerRequests.at(-1)], [b, bId, sourceRequests.at(-1)]] as const) {
      const agent = host.ctx.agents.get(id)
      if (agent === undefined || request === undefined) throw new Error('Existing Session or final request is missing')
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const events = await readPersistedEvents(host, id)
      expect(events).toEqual(agent.session.snapshotEvents())
      const replay = Session.create(id, structuredClone([...events]), agent.session.header)
      for (const kind of ['scope-agent-context', 'development-task-context'] as const) {
        expect(context(replay.deriveMessages(), kind)).toEqual(context(request, kind))
      }
    }
    expect(sourceRequests).toHaveLength(12)
    expect(ownerRequests).toHaveLength(7)
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(snapshots, ['local-joint-pending.expected.md', 'local-joint-passive.expected.md',
      'local-joint-automatic.expected.md', 'local-joint-left-local-kept.expected.md'])
  }, 180_000)
})

// Three independently owned Sessions use one entry without replacing their original responsibilities.
describe.skipIf(process.platform === 'win32')('web e2e: reusable group entry joins existing responsibilities', () => {
  const snapshots = join(import.meta.dirname, 'snapshots/native-group-join')
  const goal = '维护我负责的客户端重试实现，响应已核实的协作事实。'
  const bInitial = 'export const GROUP_B_local = "prepared";\n'
  const cInitial = 'export const GROUP_C_local = "prepared";\n'
  const bShared = 'export const GROUP_B_retries = 3;\n'
  const cShared = 'export const GROUP_C_delay = 250;\n'
  const cCorrected = 'export const GROUP_C_delay = 500;\n'
  const bAfter = 'export const GROUP_B_retries = 7;\n'
  const cAfter = 'export const GROUP_C_delay = 750;\n'
  const hosts: WebScaffold[] = []
  const pages: Page[] = []
  const requests: Message[][][] = [[], [], []]
  const trips: ReturnType<typeof watchConsole>[] = []
  let browser: Browser | undefined
  let directory: string | undefined

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Group acceptance uses controlled keyless responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-group-web-'))
    const plans = [
      [response('GROUP_A_READY')],
      [response('GROUP_B_READY'), response('GROUP_B_ORIGINAL_AUTO'), writeResponse('remote', bInitial), response('GROUP_B_PREPARED'),
        writeResponse('remote', bShared, 2), response('GROUP_B_SHARED'), response('GROUP_B_FIRST_RESPONSE'),
        response('GROUP_B_CORRECTED_RESPONSE'), writeResponse('remote', bAfter, 3), response('GROUP_B_LOCAL_AFTER')],
      [response('GROUP_C_READY'), writeResponse('remote', cInitial), response('GROUP_C_PREPARED'), response('GROUP_C_READ_B'),
        writeResponse('remote', cShared, 2), response('GROUP_C_SHARED'), writeResponse('remote', cCorrected, 3),
        response('GROUP_C_CORRECTED'), response('GROUP_C_WITHDRAWN_B'), writeResponse('remote', cAfter, 4), response('GROUP_C_CONTINUED')],
    ]
    browser = await chromium.launch()
    for (const [index, chunks] of plans.entries()) {
      const name = `group-${String(index)}`
      const override = join(directory, `${name}.override.json`)
      const replay: ReplayOverrideDoc = chunks.map(value => ({ kind: 'chunks', chunks: value }))
      await writeFile(override, JSON.stringify(replay))
      const host = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
        replayFixture: join(directory, `${name}-override-only.jsonl`), replayOverride: override })
      hosts.push(host)
      const observed = requests[index]
      if (observed === undefined) throw new Error('Missing request inventory')
      host.ctx.on('llm/stream', (options, next) => { observed.push(structuredClone(options.messages)); return next() })
      const page = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
      pages.push(page); trips.push(watchConsole(page))
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
      await mkdir(join(host.workspaceCwd, name, 'project'), { recursive: true })
    }
    if (MODE === 'refresh') await mkdir(snapshots, { recursive: true })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), ...hosts.toReversed().map(host => () => host.close()),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Three-owner group browser cleanup failed')
  }, 120_000)

  it('approves each member once, exchanges facts without recall, and leaves one while preserving the other', async () => {
    const [a, b, c] = hosts
    const [aPage, bPage, cPage] = pages
    const [aRequests, bRequests, cRequests] = requests
    if (!a || !b || !c || !aPage || !bPage || !cPage || !aRequests || !bRequests || !cRequests) {
      throw new Error('Three independently owned Hosts are required')
    }
    onTestFailed(() => saveFailureShot(bPage, 'web-e2e-native-group-join'))
    expect(new Set(hosts.map(host => host.harnessHome)).size).toBe(3)
    const ids = [await prompt(a, aPage, 'GROUP_A_READY'), await prompt(b, bPage, 'GROUP_B_READY'),
      await prompt(c, cPage, 'GROUP_C_READY')]
    const [aId, bId, cId] = ids
    if (!aId || !bId || !cId) throw new Error('Original Session identities are missing')
    const originals = ids.map((id, index) => hosts[index]?.ctx.agents.get(id))
    const tasks = []
    for (const [host, id, page, index, objective] of [
      [a, aId, aPage, 0, '共同维护重试接口'], [b, bId, bPage, 1, '维护客户端重试实现'],
      [c, cId, cPage, 2, '维护服务端重试策略'],
    ] as const) {
      const participantId = (await host.ctx.scopeAgentContributions.localStatus({ agentId: id })).participantId
      if (participantId === null) throw new Error('Original Session has no participant')
      const task = await host.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: participantId,
        objective, scope: '共享事实用于共同目标，各自保留职责和执行权限。' })
      await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      tasks.push(task)
      if (index === 0) continue
      const scope = await panel(page)
      await scope.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
      const local = page.locator(LOCAL)
      await local.getByText(`已连接：${objective}`, { exact: true }).waitFor()
      await permission(local, join(host.workspaceCwd, `group-${String(index)}/project`), LOCAL_CONSENT)
      await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
      await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    }
    const [sharedTask, bTask, cTask] = tasks
    if (!sharedTask || !bTask || !cTask) throw new Error('Local responsibilities are missing')
    const bLocal = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    const cLocal = await c.ctx.scopeAgentContributions.localStatus({ agentId: cId })
    if (bLocal.capture === null || cLocal.capture === null) throw new Error('Original file permissions are missing')
    const automatic = bPage.locator(AUTOMATIC)
    await automatic.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).check()
    await automatic.getByLabel('本地协作目标', { exact: true }).fill(goal)
    await automatic.getByLabel('允许新增的自动启动次数', { exact: true }).fill('4')
    await automatic.getByLabel('每轮最多步数', { exact: true }).fill('2')
    await automatic.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    await Promise.all([b.whenTurnSettled(30_000), automatic.getByRole('button', { name: '确认启用自动协作', exact: true }).click()])
    await bPage.getByText('GROUP_B_ORIGINAL_AUTO', { exact: true }).waitFor()
    await automatic.getByRole('button', { name: '暂停自动协作', exact: true }).click()
    await automatic.getByText('自动协作已暂停', { exact: true }).waitFor()
    const bBefore = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (bBefore.eligibility !== 'eligible') throw new Error('Original local policy is missing')
    expect(bBefore.state).toMatchObject({ mode: 'paused', usedBudget: 1, automatic: { goal, activationLimit: 4 } })
    await prompt(b, bPage, 'GROUP_B_PREPARED'); await prompt(c, cPage, 'GROUP_C_PREPARED')
    for (const [host, task] of [[b, bTask], [c, cTask]] as const) {
      await expect.poll(() => host.ctx.developmentTasks.get({ taskId: task.id }).context
        .filter(item => item.localToolObservation !== undefined).length).toBe(1)
    }

    await aPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const center = aPage.locator('[data-emergence-center]')
    const access = center.locator('details:has(> summary:text-is("独立设备协作"))')
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const ownerSharing = center.locator('[data-scope-contribution-owner]')
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    const applications = center.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('group')
    await applications.getByLabel('累计申请名额', { exact: true }).fill('2')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '邀请多人加入同一目标', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain('scope-group-entry')
    const entryText = await entryField.inputValue()
    const transferredEntry = JSON.parse(entryText) as ScopeGroupEntry
    const identities = await Promise.all(hosts.map(host => host.ctx.scopeAccess.identity()))
    const ownerIdentity = identities[0]
    if (ownerIdentity === undefined) throw new Error('Owner identity is missing')
    const replacements: (readonly [string, string])[] = [[sharedTask.id, '{{sharedTaskId}}'],
      [bTask.id, '{{bTaskId}}'], [cTask.id, '{{cTaskId}}'], [String(transferredEntry.expiresAt), '{{entryExpiresAt}}']]
    for (const address of ownerIdentity.addresses) replacements.push([address, '{{ownerAddress}}'])
    for (const [index, identity] of identities.entries()) replacements.push([identity.peerId, `{{peer${String(index)}}}`])
    for (const [host, id, page, index, original] of [[b, bId, bPage, 1, bLocal], [c, cId, cPage, 2, cLocal]] as const) {
      const scope = await panel(page)
      await scope.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
      const sharing = page.locator(REMOTE)
      await verifyNativeContributionEntry(page, entryText)
      await sharing.getByText(sharedTask.id, { exact: true }).waitFor()
      await permission(sharing, join(host.workspaceCwd, `group-${String(index)}/project`), REMOTE_CONSENT, true)
      expect(await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).isChecked()).toBe(false)
      expect(await sharing.getByRole('checkbox', { name: AUTOMATIC_CONSENT, exact: true }).isChecked()).toBe(false)
      await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).check()
      await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
      await sharing.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
      const requested = (await host.ctx.scopeAgentContributions.status({ agentId: id })).capture
      const identity = identities[index]
      if (requested === null || identity === undefined) throw new Error('Member application is missing')
      expect(requested.receiving?.automatic).toBeUndefined()
      replacements.push([requested.selection.captureId, `{{member${String(index)}Capture}}`],
        [requested.selection.captureGeneration, `{{member${String(index)}CaptureGeneration}}`])
      expect(requested.receiving?.localTask?.taskId).toBe(original.assignment?.taskId)
      const member = applications.locator('[data-group-application]').filter({ hasText: identity.peerId })
      await member.getByText('收到申请，等待你的批准', { exact: true }).waitFor()
      await member.getByLabel('该会话的协作职责', { exact: true }).fill(index === 1 ? '维护客户端重试实现' : '维护服务端重试策略')
      await member.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
      await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
      const joined = await host.ctx.scopeAgentContext.status({ agentId: id })
      if (joined.eligibility !== 'eligible') throw new Error('Joined Session is no longer eligible')
      expect(joined.state).toMatchObject({ binding: { kind: 'local-task-scope' }, mode: 'passive', automatic: null })
      expect((await host.ctx.scopeAgentContributions.localStatus({ agentId: id })).capture?.selection).toEqual(original.capture?.selection)
      replacements.push([await page.evaluate(value => new Date(value).toLocaleString(), requested.limits.expiresAt),
        '{{expiresLocal}}'])
    }
    expect(bRequests).toHaveLength(4); expect(cRequests).toHaveLength(3)
    const groups = await a.ctx.scopeAccess.groupEntries({ taskId: sharedTask.id })
    const group = groups.entries[0]
    if (group === undefined) throw new Error('Reusable entry disappeared')
    expect(groups.entries).toHaveLength(1)
    const members = (await a.ctx.scopeAccess.groupApplications({ entryId: group.entry.entryId })).entries
    expect(members).toHaveLength(2)
    expect(new Set(members.map(item => item.applicationId)).size).toBe(2)
    expect(members.map(item => item.result.status)).toEqual(['approved', 'approved'])
    expect((await a.ctx.scopeAccess.contributionApplications({ taskId: sharedTask.id })).entries).toEqual([])
    await applications.getByRole('button', { name: '关闭新申请入口', exact: true }).click()
    await applications.getByText('入口已关闭，不再接受新申请', { exact: true }).waitFor()
    await applications.getByText('累计申请：2 / 2', { exact: true }).waitFor()
    replacements.push([await aPage.evaluate(value => new Date(value).toLocaleString(), group.entry.expiresAt), '{{expiresLocal}}'])
    const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
    if (shots !== undefined) await mkdir(shots, { recursive: true })
    for (const viewport of [DESKTOP, MOBILE]) {
      await aPage.setViewportSize(viewport)
      expect(await aPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await applications.getByRole('heading', { name: '多人协作入口', exact: true }).scrollIntoViewIfNeeded()
      if (shots !== undefined) await aPage.screenshot({
        path: join(shots, `group-owner-closed-entry-${String(viewport.width)}.png`), fullPage: true,
      })
      await applications.getByRole('button', { name: '结束该成员协作', exact: true }).last().scrollIntoViewIfNeeded()
      if (shots !== undefined) await aPage.screenshot({ path: join(shots, `group-owner-closed-${String(viewport.width)}.png`), fullPage: true })
    }
    await aPage.setViewportSize(DESKTOP)
    expect(await applications.locator('[data-group-application]').evaluateAll(elements =>
      elements.map(element => element.getAttribute('data-group-application')))).toEqual(members.map(item => item.applicationId))
    const memberIds = new Set<string>(members.flatMap(item => [
      item.proposal.contributorPeerId, item.proposal.captureId, item.proposal.captureGeneration,
    ]))
    const ownerReplacements: (readonly [string, string])[] = replacements.filter(([value]) => !memberIds.has(value))
    for (const [index, member] of members.entries()) {
      const ordinal = String(index + 1)
      ownerReplacements.push([member.proposal.contributorPeerId, `{{listedMember${ordinal}Peer}}`],
        [member.proposal.captureId, `{{listedMember${ordinal}Capture}}`],
        [member.proposal.captureGeneration, `{{listedMember${ordinal}Generation}}`])
    }
    const ownerAria = await captureStableAria(aPage, '[data-contribution-applications]', a.workspaceCwd, { replacements: ownerReplacements })
    await compareOrRefreshGolden(join(snapshots, 'group-owner-closed.expected.md'), ownerAria, MODE)
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
    await captureStage(cPage, c.workspaceCwd, 'group-c-passive', replacements, PANEL, snapshots)

    await prompt(b, bPage, 'GROUP_B_SHARED')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: sharedTask.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    await prompt(c, cPage, 'GROUP_C_READ_B')
    const cRead = cRequests[3]
    if (cRead === undefined) throw new Error('Passive peer request is missing')
    expect(textOf(context(cRead, 'scope-agent-context'))).toContain(bShared.trim())
    expect(textOf(context(cRead, 'scope-agent-context'))).not.toContain(cInitial.trim())
    expect(textOf(context(cRead, 'development-task-context'))).toContain(cTask.objective)
    for (const kind of ['scope-agent-context', 'development-task-context'] as const) assertReconstructed(c, cId, cRead, kind)
    await prompt(c, cPage, 'GROUP_C_SHARED')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: sharedTask.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(2)
    const bPanel = await panel(bPage)
    await bPanel.getByRole('radio', { name: '允许自动协作', exact: true }).check()
    await bPanel.getByLabel('本地协作目标', { exact: true }).fill(goal)
    await bPanel.getByLabel('允许新增的自动启动次数', { exact: true }).fill('2')
    await bPanel.getByLabel('每轮最多步数', { exact: true }).fill('2')
    await bPanel.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    await Promise.all([b.whenTurnSettled(30_000), bPanel.getByRole('button', { name: '确认启用自动协作', exact: true }).click()])
    await bPage.getByText('GROUP_B_FIRST_RESPONSE', { exact: true }).waitFor()
    const first = bRequests[6]
    if (first === undefined) throw new Error('Authorized group response is missing')
    expect(textOf(context(first, 'scope-agent-context'))).toContain(cShared.trim())
    const awakened = b.whenTurnSettled(30_000)
    await prompt(c, cPage, 'GROUP_C_CORRECTED')
    expect(await awakened).toBe(bId)
    await bPage.getByText('GROUP_B_CORRECTED_RESPONSE', { exact: true }).waitFor()
    const correction = bRequests[7]
    if (correction === undefined) throw new Error('Peer correction did not reach automatic response')
    expect(textOf(context(correction, 'scope-agent-context'))).toContain(cCorrected.trim())
    expect(textOf(context(correction, 'development-task-context'))).toContain(bTask.objective)
    for (const kind of ['scope-agent-context', 'development-task-context'] as const) assertReconstructed(b, bId, correction, kind)
    const after = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (after.eligibility !== 'eligible' || after.state.binding?.kind !== 'local-task-scope') {
      throw new Error('Combined policy was lost')
    }
    const bSubscriptionId = after.state.binding.subscriptionId
    expect(after.state.usedBudget).toBe(3)
    expect(cRequests).toHaveLength(8)
    await panel(bPage); await recordedCompletion(b, bPage, bId)
    await captureStage(bPage, b.workspaceCwd, 'group-b-automatic', replacements, PANEL, snapshots)
    const visible = await bPage.locator(PANEL).textContent()
    expect(visible).not.toContain(cCorrected.trim())
    const sharing = bPage.locator(REMOTE)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('button', { name: '退出此次协作', exact: true }).click()
    await expect.poll(async () => (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
    await expect.poll(async () => {
      const status = await b.ctx.scopeAgentContext.status({ agentId: bId })
      return status.eligibility === 'not-live' ? null : status.state.binding?.kind
    }).toBe('local-task')
    const restored = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (restored.eligibility !== 'eligible') throw new Error('Original local policy was not restored')
    expect(restored.state).toMatchObject({ binding: { kind: 'local-task' }, mode: 'paused', usedBudget: 3,
      automatic: bBefore.state.automatic })
    expect(restored.localTask).toEqual(bBefore.localTask)
    expect((await b.ctx.scopeAccess.list()).subscriptions.find(item => item.id === bSubscriptionId)).toMatchObject({ state: 'left' })
    expect((await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })).assignment).toEqual(bLocal.assignment)
    expect((await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })).capture?.selection).toEqual(bLocal.capture.selection)
    const remaining = await c.ctx.scopeAgentContext.status({ agentId: cId })
    if (remaining.eligibility !== 'eligible' || remaining.state.binding?.kind !== 'local-task-scope') {
      throw new Error('Other member was removed')
    }
    const cSubscriptionId = remaining.state.binding.subscriptionId
    expect((await c.ctx.scopeAccess.list()).subscriptions.find(item => item.id === cSubscriptionId)).toMatchObject({ state: 'active' })
    expect(remaining.state).toMatchObject({ mode: 'passive', usedBudget: 0, binding: { kind: 'local-task-scope' } })
    expect((await c.ctx.scopeAgentContributions.status({ agentId: cId })).capture?.collecting).toBe(true)
    await bPanel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
    replacements.push([bLocal.capture.grant.bindingId, '{{bLocalBindingId}}'],
      [`${bLocal.capture.grant.expectedBindingEpoch.nodeId}:${String(bLocal.capture.grant.expectedBindingEpoch.seq)}`, '{{bLocalEpoch}}'],
      [await bPage.evaluate(value => new Date(value).toLocaleString(), bLocal.capture.grant.expiresAt), '{{expiresLocal}}'])
    await captureStage(bPage, b.workspaceCwd, 'group-b-left-local-kept', replacements, LOCAL, snapshots)
    const revision = a.ctx.developmentTasks.get({ taskId: sharedTask.id }).revision
    await prompt(b, bPage, 'GROUP_B_LOCAL_AFTER')
    const bFinal = bRequests.at(-1)
    if (bFinal === undefined) throw new Error('Departed member’s final local request is missing')
    expect(textOf(context(bFinal, 'scope-agent-context'))).not.toContain(cShared.trim())
    expect(textOf(context(bFinal, 'scope-agent-context'))).not.toContain(cCorrected.trim())
    expect(textOf(context(bFinal, 'development-task-context'))).toContain(bTask.objective)
    expect(a.ctx.developmentTasks.get({ taskId: sharedTask.id }).revision).toBe(revision)
    await expect.poll(() => b.ctx.developmentTasks.get({ taskId: bTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(3)
    await prompt(c, cPage, 'GROUP_C_WITHDRAWN_B')
    const withdrawn = cRequests[8]
    if (withdrawn === undefined) throw new Error('Remaining member request is missing')
    expect(textOf(context(withdrawn, 'scope-agent-context'))).not.toContain(bShared.trim())
    expect(textOf(context(withdrawn, 'scope-agent-context'))).not.toContain(bAfter.trim())
    expect(textOf(context(withdrawn, 'development-task-context'))).toContain(cTask.objective)
    await prompt(c, cPage, 'GROUP_C_CONTINUED')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: sharedTask.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(4)
    expect(await readFile(join(b.workspaceCwd, 'group-1/project/remote.ts'), 'utf8')).toBe(bAfter)
    expect(await readFile(join(c.workspaceCwd, 'group-2/project/remote.ts'), 'utf8')).toBe(cAfter)
    expect((await c.ctx.scopeAgentContributions.localStatus({ agentId: cId })).assignment).toEqual(cLocal.assignment)
    for (const [index, host, id, observed] of [[1, b, bId, bRequests], [2, c, cId, cRequests]] as const) {
      const agent = host.ctx.agents.get(id)
      const final = observed.at(-1)
      if (agent === undefined || final === undefined) throw new Error('Original Session or final request is missing')
      expect(agent).toBe(originals[index])
      expect(host.ctx.developmentTasks.list({ limit: 32 })).toHaveLength(1)
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const events = await readPersistedEvents(host, id)
      expect(events).toEqual(agent.session.snapshotEvents())
      const replay = Session.create(id, structuredClone([...events]), agent.session.header)
      for (const kind of ['scope-agent-context', 'development-task-context'] as const) {
        expect(context(replay.deriveMessages(), kind)).toEqual(context(final, kind))
      }
    }
    const bMember = members.find(item => item.proposal.contributorPeerId === identities[1]?.peerId)
    const cMember = members.find(item => item.proposal.contributorPeerId === identities[2]?.peerId)
    if (bMember === undefined || cMember === undefined) throw new Error('Independent application identities were lost')
    const departed = (await a.ctx.scopeAccess.groupApplications({ entryId: group.entry.entryId })).entries
      .find(item => item.applicationId === bMember.applicationId)
    expect(departed?.result).toMatchObject({ status: 'ended', readState: 'active' })
    await aPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    const departedRow = applications.locator(`[data-group-application="${bMember.applicationId}"]`)
    await departedRow.getByText('读取仍获授权；贡献结束不会自动撤销读取权限。', { exact: true }).waitFor()
    await departedRow.getByRole('button', { name: '结束该成员协作', exact: true }).click()
    await departedRow.getByText('读取权限已撤销。', { exact: true }).waitFor()
    expect(await departedRow.getByRole('button', { name: '结束该成员协作', exact: true }).count()).toBe(0)
    const ownerAfter = (await a.ctx.scopeAccess.groupApplications({ entryId: group.entry.entryId })).entries
    expect(ownerAfter.find(item => item.applicationId === bMember.applicationId)?.result).toMatchObject({ status: 'ended', readState: 'revoked' })
    expect(ownerAfter.find(item => item.applicationId === cMember.applicationId)?.result).toMatchObject({ status: 'approved', readState: 'active' })
    expect((await c.ctx.scopeAccess.list()).subscriptions.find(item => item.id === cSubscriptionId)).toMatchObject({ state: 'active' })
    expect((await c.ctx.scopeAgentContributions.status({ agentId: cId })).capture?.collecting).toBe(true)
    expect(aRequests).toHaveLength(1); expect(bRequests).toHaveLength(10); expect(cRequests).toHaveLength(11)
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(snapshots, ['group-owner-closed.expected.md', 'group-c-passive.expected.md',
      'group-b-automatic.expected.md', 'group-b-left-local-kept.expected.md'])
  }, 240_000)
})

// First-use joint receiving retains useful complete groups when the owner offers more text than this Session accepts.
describe.skipIf(process.platform === 'win32')('web e2e: recipient budget without preexisting local capture', () => {
  const snapshots = join(import.meta.dirname, 'snapshots/native-recipient-budget')
  const groups = [1, 2, 3].map(index => `export const WEB_OWNER_BUDGET_${String(index)} = '${'界'.repeat(750)}';\n`)
  const beforeCode = 'export const WEB_PRIVATE_BEFORE = true;\n'
  const sharedCode = 'export const WEB_B_SHARED = true;\n'
  const afterCode = 'export const WEB_LOCAL_AFTER = true;\n'
  let owner: WebScaffold | undefined
  let source: WebScaffold | undefined
  let browser: Browser | undefined
  let directory: string | undefined
  let ownerPage: Page
  let sourcePage: Page
  const aRequests: Message[][] = []
  const bRequests: Message[][] = []
  const trips: ReturnType<typeof watchConsole>[] = []
  function fileReply(path: string, content: string, ordinal: number): StreamChunk[] {
    const id = ToolCallId(`recipient-budget-${String(ordinal)}`)
    const args = JSON.stringify({ file_path: `project/${path}`, content })
    return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } },
      { type: 'finish', reason: { kind: 'tool-calls' } }]
  }
  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Recipient budget acceptance uses controlled keyless responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-recipient-budget-web-'))
    const ownerOverride = join(directory, 'owner.override.json')
    const sourceOverride = join(directory, 'source.override.json')
    await writeFile(ownerOverride, JSON.stringify([response('BUDGET_OWNER_READY'),
      ...groups.map((value, index) => fileReply(`group-${String(index + 1)}.ts`, value, index)), response('BUDGET_OWNER_WRITTEN'),
      response('BUDGET_OWNER_RECEIVED')].map(chunks => ({ kind: 'chunks', chunks }))))
    await writeFile(sourceOverride, JSON.stringify([fileReply('before.ts', beforeCode, 10), response('BUDGET_SOURCE_READY'),
      response('BUDGET_SOURCE_READ'), fileReply('shared.ts', sharedCode, 11), response('BUDGET_SOURCE_SHARED'),
      fileReply('after.ts', afterCode, 12), response('BUDGET_SOURCE_LEFT')].map(chunks => ({ kind: 'chunks', chunks }))))
    const aOverlay = join(directory, 'owner.patch.yml')
    const bOverlay = join(directory, 'source.patch.yml')
    const accessConfig = {
      maxGrants: 1024, maxSubscriptions: 256, maxProjections: 8192, maxContextBytes: 12000,
      maxResponseBytes: 60000, maxDecodedResponseBytes: 2097152,
      requestTimeoutMs: 5000, maxInvitationLifetimeMs: 604800000, maxConcurrentReads: 16,
      waitTimeoutMs: 3000, maxConcurrentWaits: 4, maxConcurrentContributions: 4, maxContributionRequestBytes: 16384,
      maxContributionApplications: 256, maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 86400000,
    }
    await writeFile(aOverlay, JSON.stringify([
      { id: 'scope-access', config: accessConfig },
      { id: 'development-task-context', config: { maxContextBytesPerStep: 12000 } },
      { id: 'scope-agent-context', config: { maxContextBytes: 12000, maxLocalContextBytes: 6000, coalesceMs: 50, retryDelayMs: 1000 } },
    ]))
    await writeFile(bOverlay, JSON.stringify([{ id: 'scope-access', config: accessConfig }]))
    owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5, extraOverlayPath: aOverlay,
      replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
    source = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5, extraOverlayPath: bOverlay,
      replayFixture: join(directory, 'source-override-only.jsonl'), replayOverride: sourceOverride })
    owner.ctx.on('llm/stream', (options, next) => { aRequests.push(structuredClone(options.messages)); return next() })
    source.ctx.on('llm/stream', (options, next) => { bRequests.push(structuredClone(options.messages)); return next() })
    browser = await chromium.launch()
    ownerPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    sourcePage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const [page, host, name] of [[ownerPage, owner, 'budget-owner'], [sourcePage, source, 'budget-source']] as const) {
      trips.push(watchConsole(page))
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
      await mkdir(join(host.workspaceCwd, name, 'project'), { recursive: true })
    }
    if (MODE === 'refresh') await mkdir(snapshots, { recursive: true })
  }, 120_000)
  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => source?.close(), () => owner?.close(),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Recipient budget browser cleanup failed')
  }, 120_000)
  it('joins once without local capture, admits complete facts in 8000 bytes, and retains original work after leaving', async (test) => {
    if (owner === undefined || source === undefined) throw new Error('Both independently owned Hosts are required')
    const a = owner
    const b = source
    onTestFailed(() => saveFailureShot(sourcePage, 'web-e2e-native-recipient-budget'))
    const aId = await prompt(a, ownerPage, 'BUDGET_OWNER_READY')
    const bId = await prompt(b, sourcePage, 'BUDGET_SOURCE_READY')
    const originalAgent = b.ctx.agents.get(bId)
    if (originalAgent === undefined) throw new Error('Original source Agent is missing')
    const tools = originalAgent.ctx.get('tools')
    if (tools === undefined) throw new Error('Original tools are missing')
    const originalTools = structuredClone(tools.schemas())
    const tasks = []
    for (const [host, id, objective] of [[a, aId, '维护完整后端文件事实'], [b, bId, '保留原有客户端职责']] as const) {
      const participantId = (await host.ctx.scopeAgentContributions.localStatus({ agentId: id })).participantId
      if (participantId === null) throw new Error('Existing Session has no participant')
      const task = await host.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: participantId,
        objective, scope: '独立职责只增加明确授权的共享信息。' })
      await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      const status = await host.ctx.scopeAgentContext.status({ agentId: id })
      if (status.eligibility !== 'eligible' || status.localTask === null) throw new Error('Original Task target is absent')
      await host.ctx.scopeAgentContext.bindLocal({ agentId: id, expectedBindingId: null, ...status.localTask, automatic: null })
      tasks.push(task)
    }
    const [sharedTask, localTask] = tasks
    if (sharedTask === undefined || localTask === undefined) throw new Error('Both Tasks are required')
    const localBefore = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    expect(localBefore.capture).toBeNull()
    const originalHistory = structuredClone(originalAgent.session.snapshotEvents())
    const aPanel = await panel(ownerPage)
    await aPanel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
    const local = ownerPage.locator(LOCAL)
    await local.getByText(`已连接：${sharedTask.objective}`, { exact: true }).waitFor()
    await permission(local, join(a.workspaceCwd, 'budget-owner/project'), LOCAL_CONSENT)
    await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
    await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    await ownerPage.keyboard.press('Escape')
    await ownerPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const center = ownerPage.locator('[data-emergence-center]')
    const access = center.locator('details:has(> summary:text-is("独立设备协作"))')
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const ownerSharing = center.locator('[data-scope-contribution-owner]')
    if (await ownerSharing.getAttribute('open') === null) await ownerSharing.locator(':scope > summary').click()
    const applications = center.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('join')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '邀请一个会话加入', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain('scope-join-entry')
    const entryText = await entryField.inputValue()
    const bPanel = await panel(sourcePage)
    // The initial target follows the asynchronous local-status response until a radio change is dispatched.
    await bPanel.getByText(`已连接：${localTask.objective}`, { exact: true }).waitFor()
    expect(await bPanel.getByRole('radio', { name: '本机创建的目标', exact: true }).isChecked()).toBe(true)
    await bPanel.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
    expect(await bPanel.getByRole('textbox', { name: '粘贴协作入口', exact: true }).isVisible()).toBe(true)
    const sharing = sourcePage.locator(REMOTE)
    expect(await sharing.getAttribute('open')).toBeNull()
    const entryTokens: (readonly [string, string])[] = [[sharedTask.id, '{{sharedTaskId}}'], [localTask.id, '{{localTaskId}}']]
    await captureStage(sourcePage, b.workspaceCwd, 'entry-main', entryTokens, PANEL, snapshots)
    await verifyNativeContributionEntry(sourcePage, entryText)
    await sharing.getByText(sharedTask.id, { exact: true }).waitFor()
    expect((await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
    expect((await b.ctx.scopeAccess.list()).subscriptions).toEqual([])
    expect((await a.ctx.scopeAccess.list()).grants).toEqual([])
    expect(a.ctx.developmentTasks.peerContributions({ taskId: sharedTask.id })).toEqual([])
    expect(originalAgent.session.snapshotEvents()).toEqual(originalHistory)
    expect(aRequests).toHaveLength(1); expect(bRequests).toHaveLength(2)
    const issued = (await a.ctx.scopeAccess.contributionApplications({ taskId: sharedTask.id })).entries[0]
    if (issued === undefined) throw new Error('Owner-issued entry is absent')
    const joinRequest = sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true })
    expect(await joinRequest.isDisabled()).toBe(true)
    await captureStage(sourcePage, b.workspaceCwd, 'entry-permission', [...entryTokens,
      [issued.entry.ownerAddress, '{{ownerAddress}}'], [issued.entry.ownerPeerId, '{{ownerPeerId}}'],
      [String(issued.entry.expiresAt), '{{entryExpiresAt}}'],
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), issued.entry.expiresAt), '{{entryExpiresLocal}}']],
    PANEL, snapshots)
    await permission(sharing, join(b.workspaceCwd, 'budget-source/project'), REMOTE_CONSENT)
    expect(await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).isChecked()).toBe(false)
    expect(await joinRequest.isDisabled()).toBe(true)
    await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).check()
    expect(await sharing.getByRole('checkbox', { name: AUTOMATIC_CONSENT, exact: true }).isChecked()).toBe(false)
    await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
    await sharing.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
    const requested = (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture
    if (requested === null) throw new Error('Explicit source permission was not stored')
    expect(requested.initialization).toBeUndefined()
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await applications.getByLabel('该会话的协作职责', { exact: true }).fill('在原客户端职责内使用完整文件事实。')
    await sourcePage.keyboard.press('Escape')
    expect(await sourcePage.locator(PANEL).isVisible()).toBe(false)
    await applications.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
    // Approval is observed on the source's configured application-poll cadence before joint adoption commits.
    await expect.poll(async () => {
      const status = await b.ctx.scopeAgentContext.status({ agentId: bId })
      return status.eligibility === 'eligible' && status.state.binding?.kind === 'local-task-scope'
    }, { timeout: test.task.timeout }).toBe(true)
    await panel(sourcePage)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
    const joined = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (joined.eligibility !== 'eligible' || joined.state.binding?.kind !== 'local-task-scope') throw new Error('Joint receiving absent')
    const subscriptionId = joined.state.binding.subscriptionId
    expect(joined.state).toMatchObject({ automatic: null, mode: 'passive', usedBudget: 0 })
    expect(bRequests).toHaveLength(2)
    expect(await bPanel.locator('[data-native-recorded-context]').count()).toBe(0)
    expect((await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })).capture).toBeNull()
    await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
    const reports = () => a.ctx.developmentTasks.get({ taskId: sharedTask.id }).context
      .filter(item => item.localToolObservation !== undefined)
    a.ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (agent.id === aId && step > 1) await expect.poll(() => reports().length).toBe(step - 1)
      return next()
    }, { prepend: true })
    await prompt(a, ownerPage, 'BUDGET_OWNER_WRITTEN')
    await expect.poll(() => reports().length).toBe(3)
    const raw = await b.ctx.scopeAccess.retrieve(joined.state.binding.subscriptionId, new AbortController().signal)
    if (raw.status !== 'active') throw new Error('Unrestricted owner projection unavailable')
    expect(Buffer.byteLength(raw.projection.text, 'utf8')).toBeGreaterThan(8000)
    for (const report of reports()) expect(raw.projection.text).toContain(JSON.stringify(report.text))
    await prompt(b, sourcePage, 'BUDGET_SOURCE_READ')
    const request = bRequests[2]
    if (request === undefined) throw new Error('First joined ordinary request missing')
    const frame = context(request, 'scope-agent-context')[0]
    if (frame?.source.kind !== 'scope-agent-context' || frame.source.form !== 'snapshot') {
      throw new Error('Budget withdrew all shared context')
    }
    const projection = frame.source.projection
    const selected = reports().filter(report => projection.selectedSources
      .some(ref => ref.kind === 'publication' && ref.publicationId === report.id))
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(3)
    for (const report of selected) expect(projection.text).toContain(JSON.stringify(report.text))
    expect(projection.omittedSources.some(item => item.reason === 'budget')).toBe(true)
    const localFrames = context(request, 'development-task-context')
    const localBytes = Buffer.byteLength(textOf(localFrames), 'utf8')
    const remoteFrameBytes = Buffer.byteLength(textOf([frame]), 'utf8')
    const framingBytes = remoteFrameBytes - Buffer.byteLength(projection.text, 'utf8')
    expect(localBytes).toBeLessThanOrEqual(4000)
    expect(framingBytes).toBeGreaterThan(0)
    expect(projection.maxContextBytes).toBe(8000 - localBytes - framingBytes)
    expect(localBytes + remoteFrameBytes).toBeLessThanOrEqual(8000)
    expect(textOf(localFrames)).toContain(localTask.objective)
    for (const kind of ['scope-agent-context', 'development-task-context'] as const) assertReconstructed(b, bId, request, kind)
    await panel(sourcePage)
    const recorded = sourcePage.getByRole('region', { name: '已记录共享上下文', exact: true })
    await recorded.getByText(`共享内容 ${String(remoteFrameBytes)} 字节 · 纳入 ${String(projection.selectedSources.length)} 条来源记录。`,
      { exact: true }).waitFor()
    const budgetOmissions = projection.omittedSources.filter(item => item.reason === 'budget').length
    await recorded.getByText(`因容量限制未纳入 ${String(budgetOmissions)} 条来源记录。`, { exact: true }).waitFor()
    const otherReasons = [
      ['self-published', '接收方自身发布的来源'], ['unsupported', '不支持的来源'], ['superseded', '已被更新替代'],
      ['withdrawn', '已撤回'], ['recipient-irrelevant', '按职责筛选排除'],
    ] as const
    const excluded = otherReasons.filter(([reason]) => projection.omittedSources.some(item => item.reason === reason))
    if (excluded.length > 0) {
      await recorded.getByText('其他未纳入原因', { exact: true }).click()
      for (const [reason, label] of excluded) {
        const count = projection.omittedSources.filter(item => item.reason === reason).length
        expect(await recorded.locator('dl > div').filter({ has: sourcePage.getByText(label, { exact: true }) })
          .locator('dd').innerText()).toBe(`${String(count)} 条`)
      }
    }
    expect(await recorded.textContent()).not.toContain('WEB_OWNER_BUDGET_')
    expect(await recorded.textContent()).not.toContain('模型已采用')
    expect(bRequests).toHaveLength(3)
    const identity = await a.ctx.scopeAccess.identity()
    const replacements: (readonly [string, string])[] = [[sharedTask.id, '{{sharedTaskId}}'], [localTask.id, '{{localTaskId}}'],
      [identity.peerId, '{{ownerPeerId}}'], [String(issued.entry.expiresAt), '{{entryExpiresAt}}'],
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), requested.limits.expiresAt), '{{permissionExpiresLocal}}']]
    replacements.unshift([issued.entry.ownerAddress, '{{ownerAddress}}'])
    await captureStage(sourcePage, b.workspaceCwd, 'budget-passive', replacements, PANEL, snapshots)
    await prompt(b, sourcePage, 'BUDGET_SOURCE_SHARED')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: sharedTask.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    await prompt(a, ownerPage, 'BUDGET_OWNER_RECEIVED')
    const ownerRead = aRequests.at(-1)
    if (ownerRead === undefined) throw new Error('Owner did not receive B work')
    expect(textOf(context(ownerRead, 'development-task-context'))).toContain('WEB_B_SHARED')
    expect(textOf(context(ownerRead, 'development-task-context'))).not.toContain('WEB_PRIVATE_BEFORE')
    assertReconstructed(a, aId, ownerRead, 'development-task-context')
    await panel(sourcePage)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('button', { name: '退出此次协作', exact: true }).click()
    await expect.poll(async () => (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture).toBeNull()
    await prompt(b, sourcePage, 'BUDGET_SOURCE_LEFT')
    const last = bRequests.at(-1)
    if (last === undefined) throw new Error('Post-leave ordinary request missing')
    const withdrawn = context(last, 'scope-agent-context')[0]
    expect(withdrawn?.source.kind === 'scope-agent-context' && withdrawn.source.form).toBe('withdrawn')
    expect(textOf(context(last, 'scope-agent-context'))).not.toContain('WEB_OWNER_BUDGET_')
    expect(textOf(context(last, 'development-task-context'))).toContain(localTask.objective)
    const restored = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (restored.eligibility !== 'eligible') throw new Error('Original local task no longer eligible')
    expect(restored.state).toMatchObject({ binding: { kind: 'local-task' }, automatic: null, usedBudget: 0 })
    expect(restored.localTask).toEqual(joined.localTask)
    const remaining = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    expect(remaining.assignment).toEqual(localBefore.assignment)
    expect(remaining.capture).toBeNull()
    expect(b.ctx.agents.get(bId)).toBe(originalAgent)
    expect(originalAgent.session.snapshotEvents().slice(0, originalHistory.length)).toEqual(originalHistory)
    expect(tools.schemas()).toEqual(originalTools)
    expect(originalAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['write', 'write', 'write'])
    expect((await b.ctx.scopeAccess.list()).subscriptions.find(item => item.id === subscriptionId)?.state).toBe('left')
    expect(await readFile(join(b.workspaceCwd, 'budget-source/project/after.ts'), 'utf8')).toBe(afterCode)
    expect(aRequests).toHaveLength(6)
    expect(bRequests).toHaveLength(7)
    for (const kind of ['scope-agent-context', 'development-task-context'] as const) assertReconstructed(b, bId, last, kind)
    await panel(sourcePage)
    expect(await sourcePage.locator('[data-native-recorded-context]').count()).toBe(0)
    await captureStage(sourcePage, b.workspaceCwd, 'budget-left', replacements, PANEL, snapshots)
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(snapshots, ['entry-main.expected.md', 'entry-permission.expected.md',
      'budget-passive.expected.md', 'budget-left.expected.md'])
  }, 120_000)
})
