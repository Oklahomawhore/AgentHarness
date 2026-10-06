/** Existing native Sessions exchange authorized file work while retaining each destination’s permissions. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
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
async function permission(form: Locator, root: string, consent: string): Promise<void> {
  expect(await form.getByRole('checkbox', { name: '写入文件（write）', exact: true }).isChecked()).toBe(false)
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
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
    await sharing.getByRole('button', { name: '验证连接', exact: true }).click()
    await sharing.getByText(task.id, { exact: true }).waitFor()
    const bRoot = join(b.workspaceCwd, 'remote-native/project')
    await permission(sharing, bRoot, REMOTE_CONSENT)
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
    expect(await sharing.getByRole('button', { name: '退出此次协作', exact: true }).count()).toBe(0)
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
        expect(adopted[0]?.data).toMatchObject({ version: automaticJoin ? 2 : 1, adoptionId: pending.receiving?.adoptionId })
        if (automaticJoin) expect(adopted[0]?.data).toMatchObject({ plan: { automatic: REMOTE_POLICY } })
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
    await sharing.locator(':scope > summary').click()
    await bPanel.getByText('本会话保留本地目标，远端读取暂不可用；仍可另行申请文件贡献。', { exact: true }).waitFor()
    expect(await bPanel.getByRole('button', { name: '连接此会话', exact: true }).isDisabled()).toBe(true)
    expect(await bPanel.getByText('本机会话设置已更新；后续请求将在线核验读取权限。', { exact: true }).count()).toBe(0)
    await sharing.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
    await sharing.getByRole('button', { name: '验证连接', exact: true }).click()
    await sharing.getByText(ownerTask.id, { exact: true }).waitFor()
    await permission(sharing, root, REMOTE_CONSENT)
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
      [entryText, '{{contributionEntry}}'], [localCapture.grant.bindingId, '{{localBindingId}}'],
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
