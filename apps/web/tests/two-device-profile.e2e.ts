/** Local calibration of two separate shipped dsh Web processes; this is not a two-physical-device result. */
import { verifyNativeContributionEntry } from './native-entry-support.ts'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { prepareDevice, type DeviceFile, type DevicePreparation, type DeviceStage } from '../../../scripts/scope-evaluation/two-device-prepare.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'
import { persisted, readRequests, readVerification, settled, startDevice,
  type ObservedRequest, type PersistedEvent } from './two-device-profile-support.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const PANEL = '[data-native-scope-panel]'
const LOCAL = '[data-native-local-contribution]'
const REMOTE = '[data-native-contribution]'
const CENTER = '[data-emergence-center]'
const LOCAL_CONSENT = '我允许将上述目录中所选文件操作的内容分享到这个目标，直到到期或我停止分享。'
const REMOTE_CONSENT = '我允许分享上述目录中的所选文件操作。任务所有者批准后可自动启用，直到到期或我停止分享。'
const READ_CONSENT = '我允许此会话在工作时接收整个目标的共享上下文；本项本身不允许自动开始新工作。'
const AUTOMATIC_CONSENT = '我允许本会话在我的职责内，按以下目标和额度自动响应共享变化；所有者批准加入后生效'
const cleanup: (() => Promise<unknown>)[] = []
let captureFailure: (() => Promise<void>) | undefined
const localTargetSchema = z.looseObject({ taskId: z.string(), taskBindingId: z.string(),
  bindingEpoch: z.object({ nodeId: z.string(), seq: z.number().int().nonnegative() }) })
const joinEventSchema = z.looseObject({ version: z.literal(4), phase: z.enum(['adopted', 'ended']),
  leaveAdopted: z.boolean().optional(),
  plan: z.looseObject({ kind: z.literal('local-task-scope'), bindingId: z.string(), target: localTargetSchema,
    automatic: z.null(), retainedLocal: z.object({ bindingId: z.string(), automatic: z.null() }) }) })
const callSchema = z.object({ name: z.string(), arguments: z.string() })
const resultSchema = z.looseObject({ message: z.looseObject({ content: z.array(z.looseObject({
  type: z.literal('tool-result'), isError: z.boolean().optional(),
})) }) })

afterEach(async ({ task }) => {
  const failures: unknown[] = []
  try { if (task.result?.state === 'fail') await captureFailure?.() } catch (error) { failures.push(error) }
  captureFailure = undefined
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Independent Web profile cleanup failed')
}, 120_000)

async function openPage(browser: Browser, url: string, device: DevicePreparation, observe: (page: Page) => void): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  observe(page)
  await page.goto(url, { waitUntil: 'load' })
  await page.locator('[class*="frame"]').first().waitFor({ timeout: 30_000 })
  const welcome = page.getByRole('dialog', { name: '内测声明', exact: true })
  await welcome.waitFor({ timeout: 15_000 })
  await welcome.getByRole('button', { name: '继续', exact: true }).click()
  await welcome.waitFor({ state: 'detached' })
  await connectFreshWorkspaceZh(page, dirname(device.workspace), basename(device.workspace))
  expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用', exact: true }).count()).toBe(0)
  return page
}

async function panel(page: Page): Promise<Locator> {
  if (!await page.locator(PANEL).isVisible()) await page.getByRole('button', { name: '协作', exact: true }).click()
  return page.locator(PANEL)
}
async function center(page: Page): Promise<Locator> {
  if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
  if (!await page.locator(CENTER).isVisible()) {
    await page.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
  }
  return page.locator(CENTER)
}
async function closeCenter(page: Page): Promise<void> {
  if (await page.locator(CENTER).isVisible()) {
    await page.locator(CENTER).getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
  }
}
async function submit(page: Page, device: DevicePreparation, stage: DeviceStage, turn: number, count: number): Promise<void> {
  await closeCenter(page)
  if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
  const input = page.locator('[data-composer-input][contenteditable="true"]').last()
  await input.fill(stage.prompt)
  await input.press('Enter')
  await page.getByText(stage.reply, { exact: true }).waitFor({ timeout: 30_000 })
  await settled(device, turn, count)
}

async function createAndConnect(page: Page, role: 'A' | 'B', objective: string): Promise<string> {
  const hub = await center(page)
  await hub.getByLabel('协作显示名', { exact: true }).fill(`独立用户 ${role}`)
  await hub.getByRole('button', { name: '保存身份', exact: true }).click()
  await hub.getByRole('status').getByText(`协作身份已生效：独立用户 ${role}`, { exact: true }).waitFor()
  await hub.getByRole('button', { name: '新建任务', exact: true }).click()
  await hub.getByRole('button', { name: '新建独立任务', exact: true }).click()
  const form = hub.locator('form').filter({ has: page.getByLabel('Task 名称', { exact: true }) })
  await form.getByLabel('Task 名称', { exact: true }).fill(objective)
  await form.getByLabel('初始共享上下文', { exact: true }).fill('各自保留本地职责，只交换明确获准的工作观察。')
  await form.getByRole('button', { name: '创建任务', exact: true }).click()
  await form.waitFor({ state: 'detached' })
  await hub.getByRole('heading', { name: objective, exact: true }).waitFor()
  await closeCenter(page)
  const scope = await panel(page)
  await scope.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
  const local = page.locator(LOCAL)
  const choose = local.getByRole('combobox', { name: '本机目标', exact: true })
  await choose.selectOption({ label: objective })
  const taskId = await choose.inputValue()
  expect(taskId).not.toBe('')
  await local.getByRole('button', { name: '连接当前会话', exact: true }).click()
  await local.getByText(`已连接：${objective}`, { exact: true }).waitFor()
  expect(await local.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).isChecked()).toBe(false)
  return taskId
}

async function localAssignment(page: Page) {
  const details = page.locator('[data-native-local-automatic] details')
  if (await details.getAttribute('open') === null) await details.getByText('连接详情', { exact: true }).click()
  return { taskId: await details.locator('dt:text-is("本机目标") + dd').innerText(),
    taskBindingId: await details.locator('dt:text-is("会话连接标识") + dd').innerText(),
    epoch: await details.locator('dt:text-is("连接代际") + dd').innerText() }
}

async function permission(form: Locator, root: string, consent: string): Promise<void> {
  await form.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(root)
  await form.getByRole('checkbox', { name: '写入文件（write）', exact: true }).check()
  await form.getByLabel('授权有效期（小时）', { exact: true }).fill('1')
  await form.getByLabel('最多样本数', { exact: true }).fill('8')
  await form.getByLabel('每份样本字节上限', { exact: true }).fill('8192')
  expect(await form.getByRole('checkbox', { name: consent, exact: true }).isChecked()).toBe(false)
  await form.getByRole('checkbox', { name: consent, exact: true }).check()
}

async function ownerApplications(page: Page): Promise<Locator> {
  const hub = await center(page)
  for (const selector of ['details:has(> summary:text-is("独立设备协作"))', '[data-scope-contribution-owner]']) {
    const details = hub.locator(selector)
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
  }
  return hub.locator('[data-contribution-applications]')
}

async function publication(page: Page, file: DeviceFile): Promise<string> {
  const hub = await center(page)
  const section = hub.locator('section').filter({ has: page.getByRole('heading', { name: '共享上下文', exact: true }) })
  let found: string | undefined
  await expect.poll(async () => {
    found = (await section.locator('article p').allTextContents()).find(text => text.includes(JSON.stringify(file.text)))
    return found
  }, { timeout: 20_000 }).not.toBeUndefined()
  if (found === undefined) throw new Error('Authorized native Write was not published in the owner UI')
  return found
}

function joinEvent(events: readonly PersistedEvent[]) {
  const event = events.findLast(item => item.type === 'scope-agent-context/join-read')
  if (event === undefined) throw new Error('Session has no recorded joint adoption')
  return joinEventSchema.parse(event.data)
}
function context(request: ObservedRequest, kind: 'scope-agent-context' | 'development-task-context') {
  return request.messages.filter(message => message.source.kind === kind)
}
function contextText(request: ObservedRequest, kind: 'scope-agent-context' | 'development-task-context'): string {
  return context(request, kind).flatMap(message => message.content).map(block => block.text ?? '').join('\n')
}
function requireRequest(requests: readonly ObservedRequest[], index: number): ObservedRequest {
  const request = requests[index]
  if (request === undefined) throw new Error(`Expected actual request ${String(index)} is absent`)
  return request
}

async function capturePanel(page: Page, device: DevicePreparation, stage: string): Promise<void> {
  const scope = await panel(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await expect.poll(async () => {
      const bounds = await scope.boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await scope.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await scope.getByRole('button').last().scrollIntoViewIfNeeded()
    await scope.getByRole('heading', { name: '当前会话协作', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(device.root, `${stage}-${String(viewport.width)}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await writeFile(join(device.root, `${stage}.aria.md`), await scope.ariaSnapshot() + '\n')
}

// The native Claude descriptor in the shipped Web profile does not support Windows.
it.skipIf(process.platform === 'win32')('calibrates two independent dsh Web processes through UI-owned scope joining', async () => {
  const artifactParent = process.env.DSH_TWO_DEVICE_ARTIFACTS
  if (artifactParent !== undefined) await mkdir(artifactParent, { recursive: true })
  const directory = await realpath(await mkdtemp(join(artifactParent ?? tmpdir(), 'dsh-two-device-local-')))
  if (artifactParent === undefined) cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const a = await prepareDevice({ repo: repository, root: join(directory, 'A'), role: 'A' })
  const b = await prepareDevice({ repo: repository, root: join(directory, 'B'), role: 'B' })
  const aProcess = await startDevice(repository, a)
  cleanup.push(aProcess.stop)
  const bProcess = await startDevice(repository, b)
  cleanup.push(bProcess.stop)
  expect(aProcess.pid).not.toBe(bProcess.pid)
  expect(aProcess.pid).not.toBe(process.pid)
  expect(bProcess.pid).not.toBe(process.pid)
  expect(a.home).not.toBe(b.home)
  expect(a.workspace).not.toBe(b.workspace)
  const browser = await chromium.launch()
  cleanup.push(() => browser.close())
  const pages: Page[] = []
  const pageErrors: string[] = []
  captureFailure = async () => {
    for (const [index, page] of pages.entries()) {
      if (page.isClosed()) continue
      await page.screenshot({ path: join(directory, `failure-${String(index)}.png`), fullPage: true })
      await writeFile(join(directory, `failure-${String(index)}.aria.md`), await page.locator('body').ariaSnapshot())
    }
    console.error('Local two-process evidence directory:', directory)
  }
  const observePage = (page: Page): void => {
    pages.push(page)
    page.on('pageerror', error => pageErrors.push(error.message))
  }
  const aPage = await openPage(browser, aProcess.url, a, observePage)
  const bPage = await openPage(browser, bProcess.url, b, observePage)
  await submit(aPage, a, a.stages.ready, 1, 1)
  await submit(bPage, b, b.stages.ready, 1, 2)
  const aOriginal = await persisted(a)
  const bOriginal = await persisted(b)
  const aObjective = '负责后端实现并保留本地工作'
  const bObjective = '负责客户端实现并保留本地工作'
  const aTask = await createAndConnect(aPage, 'A', aObjective)
  const bTask = await createAndConnect(bPage, 'B', bObjective)
  const bLocal = await localAssignment(bPage)
  expect(bLocal.taskId).toBe(bTask)
  expect(bLocal.taskBindingId).not.toBe('')
  expect(bLocal.epoch).not.toBe('')
  expect((await persisted(b)).events.some(event => event.type === 'scope-agent-context/state')).toBe(false)
  const local = aPage.locator(LOCAL)
  await permission(local, join(a.workspace, 'project'), LOCAL_CONSENT)
  await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
  await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
  const applications = await ownerApplications(aPage)
  await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
  await applications.getByRole('button', { name: '邀请一个会话加入', exact: true }).click()
  const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
  await expect.poll(() => entryField.inputValue()).toContain('scope-join-entry')
  const entryText = await entryField.inputValue()
  const entry = z.looseObject({ kind: z.literal('scope-join-entry'), taskId: z.string(), ownerPeerId: z.string() })
    .parse(JSON.parse(entryText) as unknown)
  expect(entry.taskId).toBe(aTask)
  const bPanel = await panel(bPage)
  await bPanel.getByText(`已连接：${bObjective}`, { exact: true }).waitFor()
  await bPanel.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
  const sharing = bPage.locator(REMOTE)
  await verifyNativeContributionEntry(bPage, entryText)
  await sharing.getByText(aTask, { exact: true }).waitFor()
  await permission(sharing, join(b.workspace, 'project'), REMOTE_CONSENT)
  expect(await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).isChecked()).toBe(false)
  expect(await sharing.getByRole('checkbox', { name: AUTOMATIC_CONSENT, exact: true }).isChecked()).toBe(false)
  await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).check()
  await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
  await sharing.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
  await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
  await applications.getByLabel('该会话的协作职责', { exact: true }).fill('只在各自负责的项目内完成工作。')
  await applications.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
  await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
  expect(await readRequests(a)).toHaveLength(1)
  expect(await readRequests(b)).toHaveLength(2)
  await capturePanel(bPage, b, 'joined-passive')

  await submit(aPage, a, a.stages.publish, 2, 3)
  expect(await readFile(join(a.workspace, a.files.shared.path), 'utf8')).toBe(a.files.shared.text)
  const aPublication = await publication(aPage, a.files.shared)
  await submit(bPage, b, b.stages.receive, 2, 3)
  const bFirst = requireRequest(await readRequests(b), 2)
  expect(contextText(bFirst, 'scope-agent-context')).toContain(JSON.stringify(aPublication))
  expect(contextText(bFirst, 'development-task-context')).toContain(bObjective)
  const adopted = joinEvent((await persisted(b)).events)
  expect(adopted).toMatchObject({ phase: 'adopted', plan: { automatic: null,
    target: { taskId: bLocal.taskId, taskBindingId: bLocal.taskBindingId }, retainedLocal: { automatic: null } } })
  const joinedTarget = adopted.plan.target
  expect(`${joinedTarget.bindingEpoch.nodeId}:${String(joinedTarget.bindingEpoch.seq)}`).toBe(bLocal.epoch)

  await submit(bPage, b, b.stages.publish, 3, 5)
  expect(await readFile(join(b.workspace, b.files.shared.path), 'utf8')).toBe(b.files.shared.text)
  const bPublication = await publication(aPage, b.files.shared)
  await submit(aPage, a, a.stages.receive, 3, 4)
  const aRead = requireRequest(await readRequests(a), 3)
  expect(contextText(aRead, 'development-task-context')).toContain(JSON.stringify(bPublication))
  const privateFile = b.files.private
  if (privateFile === undefined) throw new Error('B must have ordinary private work before joining')
  expect(await readFile(join(b.workspace, privateFile.path), 'utf8')).toBe(privateFile.text)
  expect(contextText(aRead, 'development-task-context')).not.toContain('B_PRIVATE_')
  await closeCenter(aPage)
  await panel(bPage)
  if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
  await sharing.getByRole('button', { name: '退出此次协作', exact: true }).click()
  await bPage.locator(PANEL).getByRole('textbox', { name: '粘贴协作入口', exact: true }).waitFor()
  await bPage.locator(PANEL).getByRole('radio', { name: '本机创建的目标', exact: true }).check()
  await bPage.locator(LOCAL).getByText(`已连接：${bObjective}`, { exact: true }).waitFor()
  expect(await bPage.locator(LOCAL).getByRole('button', { name: '允许并开始分享', exact: true }).isVisible()).toBe(true)
  expect(await localAssignment(bPage)).toEqual(bLocal)
  await capturePanel(bPage, b, 'left-local-retained')
  await submit(aPage, a, a.stages.afterLeave, 4, 6)
  await publication(aPage, a.files.afterLeave)
  await submit(bPage, b, b.stages.afterLeave, 4, 7)
  const aRequests = await readRequests(a)
  const bRequests = await readRequests(b)
  const last = requireRequest(bRequests, 6)
  expect(context(last, 'scope-agent-context').map(message => message.source.form)).toEqual(['withdrawn'])
  expect(contextText(last, 'scope-agent-context')).not.toContain('A_SHARED_')
  expect(contextText(last, 'scope-agent-context')).not.toContain('A_AFTER_LEAVE_')
  expect(contextText(last, 'development-task-context')).toContain(bObjective)
  const aStored = await persisted(a)
  const bStored = await persisted(b)
  expect(aStored.events.slice(0, aOriginal.events.length)).toEqual(aOriginal.events)
  expect(bStored.events.slice(0, bOriginal.events.length)).toEqual(bOriginal.events)
  expect(aStored.header).toEqual(aOriginal.header)
  expect(bStored.header).toEqual(bOriginal.header)
  expect(joinEvent(bStored.events)).toMatchObject({ phase: 'ended', leaveAdopted: true, plan: adopted.plan })
  for (const [device, requests, stored] of [[a, aRequests, aStored], [b, bRequests, bStored]] as const) {
    const first = requireRequest(requests, 0)
    for (const state of stored.events.filter(event => event.type === 'scope-agent-context/state')) {
      expect(state.data).toMatchObject({ automatic: null, usedBudget: 0 })
    }
    expect(new Set(requests.map(request => request.sessionId)).size).toBe(1)
    for (const request of requests) {
      expect(request.header.cwd).toBe(device.workspace)
      expect(request.tools).toEqual(first.tools)
      expect(request.messages.some(message => message.source.kind === 'scope-agent-pulse')).toBe(false)
    }
    expect(requests).toHaveLength(device.expectedRequests)
    const calls = stored.events.filter(event => event.type === 'tool/call').map(event => callSchema.parse(event.data))
    const files = [device.files.private, device.files.shared, device.files.afterLeave].filter(file => file !== undefined)
    expect(calls.map(call => call.name)).toEqual(files.map(() => 'write'))
    expect(calls.map(call => JSON.parse(call.arguments) as unknown))
      .toEqual(files.map(file => ({ file_path: file.path, content: file.text })))
    const results = stored.events.filter(event => event.type === 'tool/result').map(event => resultSchema.parse(event.data))
    expect(results).toHaveLength(files.length)
    for (const result of results) expect(result.message.content.every(block => block.isError !== true)).toBe(true)
    for (const file of files) expect(await readFile(join(device.workspace, file.path), 'utf8')).toBe(file.text)
  }
  expect(aRequests[0]?.sessionId).not.toBe(bRequests[0]?.sessionId)
  expect(aTask).not.toBe(bTask)
  expect(pageErrors).toEqual([])
  await browser.close()
  await bProcess.stop()
  await aProcess.stop()
  for (const device of [a, b]) {
    expect(await readVerification(device)).toMatchObject({ final: true, status: 'passed',
      observedRequests: device.expectedRequests, verifiedRequests: device.expectedRequests, failures: [] })
  }
  await writeFile(join(directory, 'calibration.json'), JSON.stringify({ version: 1, topology: 'two-processes-one-machine',
    physicalDevicesVerified: false, controlledRequests: aRequests.length + bRequests.length,
    roles: { A: { pid: aProcess.pid, taskId: aTask, sessionId: aRequests[0]?.sessionId },
      B: { pid: bProcess.pid, taskId: bTask, sessionId: bRequests[0]?.sessionId } },
    uiOwnedJoin: true, bidirectionalActualContext: true, localWorkRetainedAfterLeave: true }, null, 2) + '\n')
  console.log('Two-process local calibration evidence:', directory)
})
