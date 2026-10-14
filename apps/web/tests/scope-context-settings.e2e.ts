/** Real Web profile save/restart with the same ordinary Session; controlled summaries do not establish model quality. */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { prepareDevice, type DevicePreparation } from '../../../scripts/scope-evaluation/two-device-prepare.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'
import { persisted, readRequests, readVerification, settled, startDevice, type ObservedRequest } from './two-device-profile-support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const MARKER = 'SETTINGS_SHARED_FACT_61'
const READY = 'SETTINGS_READY_61'
const OBJECTIVE = '保留原会话并使用明确选择的共享摘要'
const cleanup: (() => Promise<unknown>)[] = []
const record = z.record(z.string(), z.unknown())
const overlaySchema = z.array(z.object({ id: z.string().optional(), config: record.optional(),
  insert: z.array(record).optional() }).loose())
const requestsSchema = z.object({ requests: z.array(record) })
let failureCapture: (() => Promise<void>) | undefined

afterEach(async ({ task }) => {
  const failures: unknown[] = []
  try { if (task.result?.state === 'fail') await failureCapture?.() } catch (error) { failures.push(error) }
  failureCapture = undefined
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Web summary settings cleanup failed')
}, 120_000)

function reply(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

async function phase(base: DevicePreparation, name: string, responses: readonly string[]): Promise<DevicePreparation> {
  const root = join(base.root, name)
  await mkdir(root, { mode: 0o700 })
  const overlay = overlaySchema.parse(JSON.parse(await readFile(base.overlayPath, 'utf8')) as unknown)
  const inserted = overlay.flatMap(row => row.insert ?? [])
  const replay = inserted.find(row => row.id === 'two-device-replay')
  const observer = inserted.find(row => row.id === 'two-device-observer')
  if (replay === undefined || observer === undefined) throw new Error('Device preparation lacks its declared replay/observer')
  const program = join(root, 'responses.json')
  replay.config = { ...record.parse(replay.config), overrideFile: program }
  const evidencePath = join(root, 'evidence')
  observer.config = { ...record.parse(observer.config), directory: evidencePath, expectedRequests: responses.length }
  overlay.push({ insert: [{ id: 'settings-summary-fixture',
    name: new URL('./scope-context-settings.fixture.mjs', import.meta.url).href,
    config: { llmModule: pathToFileURL(join(REPO, 'packages/llm/llm/lib/index.js')).href,
      auditRoot: join(base.home, 'scope-context-audit'), output: join(root, 'summary.json'), marker: MARKER },
  }] })
  const overlayPath = join(root, 'web.cordis.yml')
  await writeFile(program, JSON.stringify(responses.map(text => ({ kind: 'chunks', chunks: reply(text) }))) + '\n')
  await writeFile(overlayPath, JSON.stringify(overlay, null, 2) + '\n')
  return { ...base, root, overlayPath, evidencePath, expectedRequests: responses.length }
}

async function summaries(device: DevicePreparation): Promise<z.infer<typeof requestsSchema>['requests']> {
  return requestsSchema.parse(JSON.parse(await readFile(join(device.root, 'summary.json'), 'utf8')) as unknown).requests
}

async function open(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.locator('[class*="frame"]').first().waitFor({ timeout: 30_000 })
  return page
}

async function submit(page: Page, device: DevicePreparation, prompt: string, answer: string, turn: number, count: number) {
  const input = page.locator('[data-composer-input][contenteditable="true"]').last()
  await input.fill(prompt)
  await input.press('Enter')
  await page.getByText(answer, { exact: true }).waitFor({ timeout: 30_000 })
  await settled(device, turn, count)
}

async function createTask(page: Page): Promise<string> {
  await page.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
  const center = page.locator('[data-emergence-center]')
  await center.getByLabel('协作显示名', { exact: true }).fill('摘要设置验收用户')
  await center.getByRole('button', { name: '保存身份', exact: true }).click()
  await center.getByRole('status').getByText('协作身份已生效：摘要设置验收用户', { exact: true }).waitFor()
  await center.getByRole('button', { name: '新建任务', exact: true }).click()
  await center.getByRole('button', { name: '新建独立任务', exact: true }).click()
  const form = center.locator('form').filter({ has: page.getByLabel('Task 名称', { exact: true }) })
  await form.getByLabel('Task 名称', { exact: true }).fill(OBJECTIVE)
  await form.getByLabel('初始共享上下文', { exact: true }).fill('Configure summaries for an existing Session.')
  await form.getByRole('button', { name: '创建任务', exact: true }).click()
  await form.waitFor({ state: 'detached' })
  await center.getByRole('heading', { name: OBJECTIVE, exact: true }).waitFor()
  await center.getByPlaceholder('发布可被后续派生或汇合任务继承的上下文；不要填写私聊或内部推理。').fill(MARKER)
  await center.getByRole('button', { name: '发布上下文', exact: true }).click()
  await center.getByText(MARKER, { exact: true }).waitFor()
  await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await page.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
  const local = page.locator('[data-native-local-contribution]')
  const select = local.getByRole('combobox', { name: '本机目标', exact: true })
  await select.selectOption({ label: OBJECTIVE })
  const taskId = await select.inputValue()
  await local.getByRole('button', { name: '连接当前会话', exact: true }).click()
  await local.getByText(`已连接：${OBJECTIVE}`, { exact: true }).waitFor()
  expect(await local.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).isChecked()).toBe(false)
  await page.keyboard.press('Escape')
  return taskId
}

async function card(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await dialog.getByRole('button', { name: '展开设置: 协作摘要', exact: true }).click()
  return dialog.getByRole('listitem').filter({ has: page.getByText('协作摘要', { exact: true }) })
}

function contextProjection(request: ObservedRequest | undefined) {
  const message = request?.messages.find(value => value.source.kind === 'development-task-context'
    && value.source.form === 'snapshot')
  const source = z.object({ kind: z.literal('development-task-context'), form: z.literal('snapshot'), version: z.literal(2),
    backend: z.object({ id: z.string() }), taskId: z.string() }).parse(message?.source)
  const blocks = z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1).parse(message?.content)
  return { backend: source.backend, taskId: source.taskId, text: blocks.map(block => block.text).join('\n') }
}

async function settingsGeometry(target: Locator) {
  return target.evaluate((element) => {
    const rect = (value: Element) => {
      const box = value.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
    }
    const describe = (value: Element) => {
      const style = getComputedStyle(value)
      const box = value.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return { tag: value.tagName, className: value.className, rect: rect(value), clientWidth: value.clientWidth,
        scrollWidth: value.scrollWidth, scrollTop: value.scrollTop, scrollLeft: value.scrollLeft,
        centerHit: hit === null ? null : { tag: hit.tagName, className: hit.className },
        receivesPointer: hit !== null && value.contains(hit),
        position: style.position, overflowX: style.overflowX, overflowY: style.overflowY,
        opacity: style.opacity, transform: style.transform, zIndex: style.zIndex,
        animations: value.getAnimations().map(animation => ({ playState: animation.playState, pending: animation.pending })) }
    }
    const ancestors: Element[] = []
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) ancestors.push(parent)
    const dialog = element.closest('[role="dialog"]')
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      target: describe(element), dialog: dialog === null ? null : describe(dialog), ancestors: ancestors.map(describe),
      chrome: dialog === null ? [] : [...dialog.querySelectorAll('nav, button')]
        .filter(value => !element.contains(value)).map(value => ({ ...describe(value), text: value.textContent })),
      controls: [...element.querySelectorAll('button, input, select')].map((control) => {
        const box = control.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { ...describe(control), id: control.id, label: control.getAttribute('aria-label'),
          text: control.textContent, centerHit: hit === null ? null : { tag: hit.tagName, className: hit.className },
          receivesPointer: hit !== null && control.contains(hit) }
      }) }
  })
}

async function screenshot(page: Page, target: Locator, directory: string, stage: string): Promise<void> {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const before = await settingsGeometry(target)
    // The ResizeObserver must commit the responsive frame before its animations can be observed.
    await expect.poll(() => page.locator('[data-sidebar-collapsed]').count()).toBe(viewport.width === 390 ? 1 : 0)
    // Resizing collapses the sidebar; its finite fade and grid transition must settle before judging the modal.
    await expect.poll(() => target.evaluate((element) => {
      const elements: Element[] = [element]
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) elements.push(parent)
      return elements.flatMap(value => value.getAnimations()).some(animation => animation.pending || animation.playState === 'running')
    })).toBe(false)
    await target.scrollIntoViewIfNeeded()
    const after = await settingsGeometry(target)
    const geometryPath = join(directory, `${stage}-${String(viewport.width)}.geometry.json`)
    await writeFile(geometryPath, JSON.stringify({ before, after }, null, 2) + '\n')
    await page.screenshot({ path: join(directory, `${stage}-${String(viewport.width)}.png`), fullPage: true })
    const afterScreenshot = await settingsGeometry(target)
    await writeFile(geometryPath, JSON.stringify({ before, after, afterScreenshot }, null, 2) + '\n')
    // Trial clicks may scroll ancestors; preserve the untouched post-screenshot state before checking reachability.
    await page.getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '关闭', exact: true }).click({ trial: true })
    const afterCloseTrial = await settingsGeometry(target)
    await writeFile(geometryPath, JSON.stringify({ before, after, afterScreenshot, afterCloseTrial }, null, 2) + '\n')
    expect(after.documentWidth).toBeLessThanOrEqual(viewport.width)
    expect(after.target.scrollWidth).toBeLessThanOrEqual(after.target.clientWidth)
    expect(after.dialog).not.toBeNull()
    if (after.dialog === null) throw new Error('Summary card is outside the settings dialog')
    expect(after.dialog.rect.x).toBeGreaterThanOrEqual(0)
    expect(after.dialog.rect.y).toBeGreaterThanOrEqual(0)
    expect(after.dialog.rect.right).toBeLessThanOrEqual(viewport.width)
    expect(after.dialog.rect.bottom).toBeLessThanOrEqual(viewport.height)
    expect(after.target.rect.x).toBeGreaterThanOrEqual(after.dialog.rect.x)
    expect(after.target.rect.right).toBeLessThanOrEqual(after.dialog.rect.right)
    await target.getByRole('button', { name: /设置: 协作摘要$/ }).click({ trial: true })
    const mode = target.getByRole('combobox', { name: '上下文提供方式', exact: true })
    if (await mode.count() > 0) await mode.click({ trial: true })
  }
  await writeFile(join(directory, `${stage}.aria.md`), await target.ariaSnapshot() + '\n')
  await page.setViewportSize({ width: 1440, height: 1000 })
}

// The supported Web profile composes native Claude setup only on macOS/Linux.
it.skipIf(process.platform === 'win32')('defers summaries until Web restart and preserves the existing Session', async () => {
  const parent = process.env.DSH_SCOPE_CONTEXT_SETTINGS_ARTIFACTS
  if (parent !== undefined) await mkdir(parent, { recursive: true })
  const directory = await realpath(await mkdtemp(join(parent ?? tmpdir(), 'dsh-summary-settings-')))
  if (parent === undefined) cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const base = await prepareDevice({ repo: REPO, root: join(directory, 'device'), role: 'A' })
  const first = await phase(base, 'reported', ['READY_61', 'REPORTED_61', 'STILL_REPORTED_61'])
  const second = await phase(base, 'semantic', ['SEMANTIC_61'])
  const browser = await chromium.launch()
  cleanup.push(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const pages: Page[] = []
  failureCapture = async () => {
    for (const [index, page] of pages.entries()) {
      if (!page.isClosed()) {
        await page.screenshot({ path: join(directory, `failure-${String(index)}.png`), fullPage: true })
        await writeFile(join(directory, `failure-${String(index)}.aria.md`), await page.locator('body').ariaSnapshot())
      }
    }
    console.error('Summary settings evidence directory:', directory)
  }
  const initial = await startDevice(REPO, first)
  cleanup.push(initial.stop)
  const page = await open(context, initial.url)
  pages.push(page)
  await page.getByRole('dialog', { name: '内测声明', exact: true }).getByRole('button', { name: '继续', exact: true }).click()
  await connectFreshWorkspaceZh(page, dirname(base.workspace), basename(base.workspace))
  await submit(page, first, READY, 'READY_61', 1, 1)
  const original = await persisted(first)
  const taskId = await createTask(page)
  await submit(page, first, 'Continue ordinary work.', 'REPORTED_61', 2, 2)
  const before = await readRequests(first)
  expect(contextProjection(before[1])).toMatchObject({ backend: { id: 'reported-files' }, taskId })
  expect(contextProjection(before[1]).text).toContain(MARKER)
  expect(await summaries(first)).toEqual([])
  const selection = await card(page)
  await selection.getByRole('combobox', { name: '上下文提供方式', exact: true }).selectOption('semantic')
  await selection.getByRole('combobox', { name: '摘要模型', exact: true }).selectOption(JSON.stringify(['settings-summary-fixture', 'summary']))
  await selection.getByLabel('摘要累计调用上限', { exact: true }).fill('1')
  expect(await summaries(first)).toEqual([])
  await selection.getByRole('button', { name: '保存', exact: true }).click()
  await selection.getByText('设置已保存，请手动重启 Host 以应用摘要选择。', { exact: true }).waitFor()
  const saved = await readFile(join(base.home, 'settings.yaml'), 'utf8')
  expect(saved).toContain('scope-context:')
  expect(saved).toContain('settings-summary-fixture')
  expect(saved).toContain('maxCalls: 1')
  expect(await summaries(first)).toEqual([])
  await screenshot(page, selection, directory, 'saved')
  await page.keyboard.press('Escape')
  await submit(page, first, 'Continue ordinary work after saving.', 'STILL_REPORTED_61', 3, 3)
  const reported = await readRequests(first)
  expect(contextProjection(reported[2])).toMatchObject({ backend: { id: 'reported-files' }, taskId })
  expect(contextProjection(reported[2]).text).toContain(MARKER)
  expect(await summaries(first)).toEqual([])
  const beforeRestart = await persisted(first)
  await page.close()
  await initial.stop()
  expect(await readVerification(first)).toMatchObject({ final: true, status: 'passed',
    observedRequests: 3, verifiedRequests: 3, activeStreams: 0, failures: [] })
  // Keep the real browser's persisted Session selection at its original origin over the sequential Host restart.
  const restarted = await startDevice(REPO, second, { port: Number(new URL(initial.url).port) })
  expect(new URL(restarted.url).origin).toBe(new URL(initial.url).origin)
  cleanup.push(restarted.stop)
  expect(restarted.pid).not.toBe(initial.pid)
  const restored = await open(context, restarted.url)
  pages.push(restored)
  const workspace = restored.getByRole('treeitem').filter({ has: restored.getByText(basename(base.workspace), { exact: true }) })
  if (await workspace.getAttribute('aria-expanded') === 'false') await workspace.click()
  const session = restored.getByRole('treeitem').filter({ hasText: READY })
  await session.click()
  await restored.getByText('STILL_REPORTED_61', { exact: true }).waitFor()
  expect(await summaries(second)).toEqual([])
  expect(await readFile(join(base.home, 'settings.yaml'), 'utf8')).toBe(saved)
  await submit(restored, second, 'Continue ordinary work after restarting.', 'SEMANTIC_61', 4, 1)
  const [actual] = await readRequests(second)
  if (actual === undefined) throw new Error('Restarted Session emitted no ordinary request')
  expect(actual.sessionId).toBe(reported[0]?.sessionId)
  expect(actual.header.cwd).toBe(base.workspace)
  expect(record.parse(actual.config)).toMatchObject({ provider: 'scope-calibration', model: 'controlled' })
  expect(actual.tools).toEqual(reported[0]?.tools)
  expect(contextProjection(actual)).toMatchObject({ backend: { id: 'semantic' }, taskId })
  expect(contextProjection(actual).text).toContain(MARKER)
  const afterRestart = await persisted(second)
  expect(afterRestart.header).toEqual(beforeRestart.header)
  expect(afterRestart.events.slice(0, beforeRestart.events.length)).toEqual(beforeRestart.events)
  expect(afterRestart.events.slice(0, original.events.length)).toEqual(original.events)
  expect(await summaries(second)).toHaveLength(1)
  const files = await readdir(base.sessionRoot, { recursive: true })
  expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(1)
  expect(await restored.getByRole('treeitem').filter({ hasText: 'scope-context-audit' }).count()).toBe(0)
  const current = await card(restored)
  await screenshot(restored, current, directory, 'restored')
  await restored.close()
  await restarted.stop()
  expect(await readVerification(second)).toMatchObject({ final: true, status: 'passed',
    observedRequests: 1, verifiedRequests: 1, activeStreams: 0, failures: [] })
  expect(await summaries(first)).toEqual([])
  expect(await summaries(second)).toHaveLength(1)
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ version: 1, fixture: 'controlled-models',
    sameMachineCalibration: true, processBoots: 2, originalSessionId: actual.sessionId, taskId, ordinaryRequests: 4,
    summaryRequests: 1, openingAndSavingSummaryRequests: 0, providerChangesOnlyAfterRestart: true,
    ordinaryRoutePreserved: true, syntheticPublicationEnteredThroughUi: true, automaticFileCaptureTested: false,
    cumulativeReenableTestedHere: false, auditIsolated: true, originalSessionDiskPrefixPreserved: true }, null, 2) + '\n')
}, 180_000)
