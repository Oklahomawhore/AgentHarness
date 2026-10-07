/** Two native Web Sessions share explicitly permitted foreground command results through the ordinary join UI. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { chromium, type Locator, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import { verifyNativeContributionEntry } from './native-entry-support.ts'

const PANEL = '[data-native-scope-panel]'
const LOCAL = '[data-native-local-contribution]'
const REMOTE = '[data-native-contribution]'
const COMMAND = 'node verify.mjs'
const A_FILE = 'export const COMMAND_OWNER_INTERFACE = "ready";\n'
const A_LATER = 'export const COMMAND_OWNER_INTERFACE = "after-stop";\n'
const B_FILE = 'export const COMMAND_SOURCE_IMPLEMENTATION = 57;\n'
const PRIVATE = 'COMMAND_PRIVATE_CANARY_57'
const SUCCESS = 'COMMAND_SUCCESS_57'
const FAILURE = 'COMMAND_FAILURE_57'
const STDERR = 'COMMAND_STDERR_57'
const READ = '我允许此会话在工作时接收整个目标的共享上下文；本项本身不允许自动开始新工作。'
const LOCAL_CONSENT = '我允许将上述目录中所选文件操作的内容分享到这个目标，直到到期或我停止分享。'
const COMMAND_CONSENT = '我允许分享上述文件操作与已选命令结果。任务所有者批准后可自动启用，直到到期或我停止分享。'
const cleanup: (() => Promise<void>)[] = []
let failurePage: Page | undefined

afterEach(async (test) => {
  if (test.task.result?.state === 'fail' && failurePage !== undefined) {
    await saveFailureShot(failurePage, 'web-native-command-contribution')
  }
  failurePage = undefined
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Command browser cleanup failed: ${inspect(failures, { depth: 6 })}`)
})

function reply(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function tool(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsText = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function bash(id: string, command = COMMAND): StreamChunk[] {
  return tool(id, 'bash', { command, description: 'Verify the current project state', timeoutMs: 10000 })
}
const text = (messages: readonly Message[]): string => messages.flatMap(message => message.content)
  .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const managed = (messages: readonly Message[]): Message[] => messages.filter(message =>
  message.source.kind === 'scope-agent-context' || message.source.kind === 'development-task-context')

function toolResultText(messages: readonly Message[], callId: ToolCallId): string {
  const result = messages.flatMap(message => message.content)
    .find(block => block.type === 'tool-result' && block.toolCallId === callId)
  if (result?.type !== 'tool-result') throw new Error(`Request is missing the real tool result for ${callId}`)
  expect(result.isError).toBe(false)
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function panel(page: Page): Promise<Locator> {
  if (!await page.locator(PANEL).isVisible()) await page.getByRole('button', { name: '协作', exact: true }).click()
  return page.locator(PANEL)
}
async function prompt(host: WebScaffold, page: Page, marker: string): Promise<SessionId> {
  if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
  const settled = host.whenTurnSettled(30_000)
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill(`继续本轮工作：${marker}`)
  await composer.press('Enter')
  const id = await settled
  await page.getByText(marker, { exact: true }).waitFor()
  const agent = host.ctx.agents.get(id)
  if (agent === undefined) throw new Error('Current Agent disappeared')
  const events = agent.session.snapshotEvents()
  expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind,
    inspect(events.slice(-5), { depth: 8 })).toBe('completed')
  return id
}
async function localTask(host: WebScaffold, page: Page, name: string) {
  await page.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
  const center = page.locator('[data-emergence-center]')
  await center.getByLabel('协作显示名').fill(name)
  await center.getByRole('button', { name: '保存身份', exact: true }).click()
  await center.getByRole('status').getByText(`协作身份已生效：${name}`, { exact: true }).waitFor()
  await center.getByRole('button', { name: '新建任务', exact: true }).click()
  await center.getByRole('button', { name: '新建独立任务', exact: true }).click()
  const form = center.locator('form').filter({ has: page.getByLabel('Task 名称') })
  await form.getByLabel('Task 名称').fill(name)
  await form.getByLabel('初始共享上下文').fill('保持原有职责，仅使用明确授权的工作观察。')
  await form.getByRole('button', { name: '创建任务', exact: true }).click()
  await form.waitFor({ state: 'detached' })
  const task = host.ctx.developmentTasks.list({ limit: 200 }).find(item => item.objective === name)
  if (task === undefined) throw new Error('UI Task was not created')
  await center.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
  const scope = await panel(page)
  await scope.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
  const local = page.locator(LOCAL)
  await local.getByRole('combobox', { name: '本机目标', exact: true }).selectOption({ label: name })
  await local.getByRole('button', { name: '连接当前会话', exact: true }).click()
  await local.getByText(`已连接：${name}`, { exact: true }).waitFor()
  await local.getByRole('button', { name: '使用当前工作区建议', exact: true }).click()
  await expect.poll(() => local.getByLabel('授权有效期（小时）', { exact: true }).inputValue()).toBe('8')
  expect(await local.getByRole('checkbox', { name: '分享指定命令的执行结果', exact: true }).isChecked()).toBe(false)
  expect(await local.getByRole('checkbox', { name: LOCAL_CONSENT, exact: true }).isChecked()).toBe(false)
  await local.getByRole('checkbox', { name: '编辑文件（edit）', exact: true }).uncheck()
  await local.getByRole('checkbox', { name: LOCAL_CONSENT, exact: true }).check()
  await local.getByRole('button', { name: '允许并开始分享', exact: true }).click()
  await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  return task
}

interface FrozenRequest {
  readonly messages: Message[]
  readonly events: readonly SessionEvent[]
}
function observe(host: WebScaffold, frames: FrozenRequest[], current: () => SessionId | undefined): void {
  host.ctx.on('llm/stream', (options, next) => {
    const id = current()
    if (id !== undefined) {
      const agent = host.ctx.agents.get(id)
      if (agent === undefined) throw new Error('Observed Agent is absent')
      const events = structuredClone(agent.session.snapshotEvents())
      const messages = structuredClone(options.messages)
      expect(Session.create(id, events, agent.session.header).deriveMessages()).toEqual(messages)
      frames.push({ messages, events })
    }
    return next()
  })
}

async function screenshots(
  page: Page, host: WebScaffold, stage: string, replacements: readonly (readonly [string, string])[],
): Promise<void> {
  const directory = join(import.meta.dirname, 'expected/native-command-contribution')
  const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
  if (shots !== undefined) await mkdir(shots, { recursive: true })
  if (webSnapshotMode() === 'refresh') await mkdir(directory, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.locator(PANEL).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.locator(REMOTE).scrollIntoViewIfNeeded()
    if (shots !== undefined) await page.screenshot({ path: join(shots, `commands-${stage}-${width}.png`), fullPage: true })
    const last = page.locator(PANEL).getByRole('button').last()
    await last.scrollIntoViewIfNeeded()
    const box = await last.boundingBox()
    expect(box !== null && box.y >= 0 && box.y + box.height <= (width === 390 ? 844 : 1000)).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  const aria = await captureStableAria(page, REMOTE, host.workspaceCwd, { replacements: [...replacements] })
  await compareOrRefreshGolden(join(directory, `${stage}.expected.md`), aria, webSnapshotMode())
}

// The shipped native Web composition is unavailable on Windows.
it.skipIf(process.platform === 'win32')(
  'shares explicitly permitted native command results after joint approval and preserves local work on stop',
  async (test) => {
    if (webSnapshotMode() === 'record') throw new Error('Command acceptance uses controlled keyless replies')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-command-contribution-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const aOverride = join(directory, 'a.override.json')
    const bOverride = join(directory, 'b.override.json')
    const aReplies: ReplayOverrideDoc = [reply('COMMAND_A_READY'),
      tool('command-owner-write', 'write', { file_path: 'project/owner.ts', content: A_FILE }), reply('COMMAND_A_FILE'),
      reply('COMMAND_A_SUCCESS'), reply('COMMAND_A_FAILURE'),
      tool('command-owner-after', 'write', { file_path: 'project/owner.ts', content: A_LATER }), reply('COMMAND_A_WITHDRAWN')]
      .map(chunks => ({ kind: 'chunks', chunks }))
    const bReplies: ReplayOverrideDoc = [reply('COMMAND_B_READY'), bash('command-before'), reply('COMMAND_B_BEFORE'),
      tool('command-source-write', 'write', { file_path: 'project/source.ts', content: B_FILE }),
      bash('command-success'), reply('COMMAND_B_SUCCESS'), bash('command-failure'), reply('COMMAND_B_FAILURE'),
      bash('command-other', `${COMMAND} --private`), reply('COMMAND_B_OTHER'),
      bash('command-after-stop'), reply('COMMAND_B_STOPPED'), reply('COMMAND_B_READS'), reply('COMMAND_B_LEFT')]
      .map(chunks => ({ kind: 'chunks', chunks }))
    await writeFile(aOverride, JSON.stringify(aReplies)); await writeFile(bOverride, JSON.stringify(bReplies))
    const a = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
      replayFixture: join(directory, 'a-only.jsonl'), replayOverride: aOverride })
    cleanup.push(() => a.close())
    const b = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
      replayFixture: join(directory, 'b-only.jsonl'), replayOverride: bOverride })
    cleanup.push(() => b.close())
    const browser = await chromium.launch()
    cleanup.push(() => browser.close())
    const aPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const bPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    failurePage = bPage
    for (const [host, page, name] of [[a, aPage, 'commands-owner'], [b, bPage, 'commands-source']] as const) {
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
      await mkdir(join(host.workspaceCwd, name, 'project'), { recursive: true })
    }
    const aFrames: FrozenRequest[] = []
    const bFrames: FrozenRequest[] = []
    const aId = await prompt(a, aPage, 'COMMAND_A_READY')
    observe(a, aFrames, () => aId)
    const bId = await prompt(b, bPage, 'COMMAND_B_READY')
    observe(b, bFrames, () => bId)
    const aAgent = a.ctx.agents.get(aId)
    const bAgent = b.ctx.agents.get(bId)
    if (aAgent === undefined || bAgent === undefined || bAgent.session.header.cwd === undefined) {
      throw new Error('Ordinary Sessions missing')
    }
    const cwd = bAgent.session.header.cwd
    await writeFile(join(cwd, 'verify.mjs'), `import { readFileSync } from 'node:fs';
const mode = readFileSync(new URL('./mode.txt', import.meta.url), 'utf8').trim();
const privateRun = mode === 'before' || process.argv.includes('--private');
console.log(privateRun ? '${PRIVATE}' : mode === 'pass' ? '${SUCCESS}' : '${FAILURE}');
if (!privateRun && mode === 'fail') { console.error('${STDERR}'); process.exitCode = 7; }
`)
    await writeFile(join(cwd, 'mode.txt'), 'before')
    const aTask = await localTask(a, aPage, '拥有者负责接口验证')
    const bTask = await localTask(b, bPage, '参与者原有实现职责')
    const original = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    if (original.capture === null || original.assignment === null) throw new Error('Original local file permission missing')
    const bHistory = structuredClone(bAgent.session.snapshotEvents())
    const tools = bAgent.ctx.get('tools')
    if (tools === undefined) throw new Error('Original tool registry absent')
    const originalTools = structuredClone(tools.schemas())
    await prompt(b, bPage, 'COMMAND_B_BEFORE')
    expect(bAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data))
      .toMatchObject([{ callId: ToolCallId('command-before'), name: 'bash',
        arguments: JSON.stringify({ command: COMMAND, description: 'Verify the current project state', timeoutMs: 10000 }) }])
    expect(b.ctx.developmentTasks.get({ taskId: bTask.id }).context.filter(item => item.localToolObservation !== undefined)).toHaveLength(0)
    expect(toolResultText(bFrames.at(-1)?.messages ?? [], ToolCallId('command-before'))).toContain(PRIVATE)
    await prompt(a, aPage, 'COMMAND_A_FILE')
    await expect.poll(() => a.ctx.developmentTasks.get({ taskId: aTask.id }).context
      .filter(item => item.localToolObservation !== undefined).length, { timeout: test.task.timeout }).toBe(1)

    await aPage.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const access = aPage.locator('[data-emergence-center] details:has(> summary:text-is("独立设备协作"))')
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const ownerPanel = aPage.locator('[data-scope-contribution-owner]')
    if (await ownerPanel.getAttribute('open') === null) await ownerPanel.locator(':scope > summary').click()
    const applications = aPage.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('join')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '邀请一个会话加入', exact: true }).click()
    const entry = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entry.inputValue()).toContain('scope-join-entry')
    const entryText = await entry.inputValue()
    const bPanel = await panel(bPage)
    await bPanel.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
    await verifyNativeContributionEntry(bPage, entryText)
    const sharing = bPage.locator(REMOTE)
    await sharing.getByText(aTask.id, { exact: true }).waitFor()
    expect(await sharing.getByRole('textbox', { name: '允许采集的目录', exact: true }).inputValue()).toBe(cwd)
    expect(await sharing.getByRole('checkbox', { name: '分享指定命令的执行结果', exact: true }).isChecked()).toBe(false)
    await sharing.getByRole('checkbox', { name: '分享指定命令的执行结果', exact: true }).check()
    await sharing.getByRole('textbox', { name: '完整命令', exact: true }).fill(COMMAND)
    await sharing.getByRole('combobox', { name: '命令工作目录', exact: true }).selectOption('0')
    expect(await sharing.getByRole('checkbox', { name: COMMAND_CONSENT, exact: true }).isChecked()).toBe(false)
    await sharing.getByRole('checkbox', { name: READ, exact: true }).check()
    await sharing.getByRole('checkbox', { name: COMMAND_CONSENT, exact: true }).check()
    expect(await sharing.locator('[data-native-join-automatic] input[type="checkbox"]').isChecked()).toBe(false)
    expect(await sharing.locator('[data-native-initialization-consent] input[type="checkbox"]').isChecked()).toBe(false)
    await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    expect(await applications.getByText(COMMAND, { exact: true }).isVisible()).toBe(true)
    expect(await applications.getByText('目录 1', { exact: false }).isVisible()).toBe(true)
    expect(await applications.textContent()).not.toContain(cwd)
    const requested = (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture
    if (requested === null) throw new Error('Command application absent')
    expect(requested.proposal.source).toMatchObject({ version: 4, tools: ['Write'], commands: [{ command: COMMAND, rootIndex: 0 }] })
    await applications.getByLabel('该会话的协作职责', { exact: true }).fill('运行自己负责实现的检查，并使用共享接口。')
    await applications.getByRole('button', { name: '批准读取与所选工作贡献', exact: true }).click()
    await aPage.getByRole('button', { name: '关闭涌现协作中心', exact: true }).click()
    await sharing.getByText('正在采集已授权的工作结果', { exact: true }).waitFor()
    await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
    const ownerAddress = requested.entry.ownerAddress
    const replacements: (readonly [string, string])[] = [[entryText, '{{entry}}'], [aTask.id, '{{sharedTaskId}}'],
      [bTask.id, '{{localTaskId}}'], [ownerAddress, '{{ownerAddress}}'], [requested.entry.ownerPeerId, '{{ownerPeerId}}'],
      [await bPage.evaluate(value => new Date(value).toLocaleString(), requested.limits.expiresAt), '{{permissionExpiresLocal}}']]
    await screenshots(bPage, b, 'active', replacements)
    const reports = () => a.ctx.developmentTasks.get({ taskId: aTask.id }).context
      .filter(item => item.peerToolObservation !== undefined)
    await writeFile(join(cwd, 'mode.txt'), 'pass')
    await prompt(b, bPage, 'COMMAND_B_SUCCESS')
    await expect.poll(() => reports().length, { timeout: test.task.timeout }).toBe(2)
    await expect.poll(async () => (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture?.pendingSamples,
      { timeout: test.task.timeout }).toBe(0)
    expect(text(managed(bFrames.at(-1)?.messages ?? []))).toContain('COMMAND_OWNER_INTERFACE')
    expect(Buffer.byteLength(text(managed(bFrames.at(-1)?.messages ?? [])), 'utf8')).toBeLessThanOrEqual(8000)
    expect(await readFile(join(cwd, 'project/source.ts'), 'utf8')).toBe(B_FILE)
    await prompt(a, aPage, 'COMMAND_A_SUCCESS')
    const success = reports().find(item => item.peerToolObservation?.kind === 'command-observation')
    if (success?.peerToolObservation?.kind !== 'command-observation') throw new Error('Actual command publication absent')
    expect(success.peerContribution?.grant).toMatchObject({ captureId: requested.selection.captureId,
      captureGeneration: requested.selection.captureGeneration, source: requested.proposal.source })
    expect(success.peerToolObservation).toMatchObject({ version: 4, fields: { command: COMMAND, rootIndex: 0 }, state: 'completed',
      exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { state: 'included', text: `${SUCCESS}\n`, truncated: false },
      stderr: { state: 'included', text: '', truncated: false } })
    expect(text(managed(aFrames.at(-1)?.messages ?? []))).toContain(SUCCESS)
    expect(text(managed(aFrames.at(-1)?.messages ?? []))).not.toContain(PRIVATE)
    await writeFile(join(cwd, 'mode.txt'), 'fail')
    await prompt(b, bPage, 'COMMAND_B_FAILURE')
    await expect.poll(() => reports().length, { timeout: test.task.timeout }).toBe(3)
    await prompt(a, aPage, 'COMMAND_A_FAILURE')
    const failure = reports().find(item => item.peerToolObservation?.kind === 'command-observation'
      && item.peerToolObservation.state === 'completed' && item.peerToolObservation.exitCode === 7)
    if (failure === undefined) throw new Error('Nonzero completion did not reach owner authority')
    expect(failure.peerToolObservation).toMatchObject({ state: 'completed', exitCode: 7,
      stdout: { state: 'included', text: `${FAILURE}\n`, truncated: false },
      stderr: { state: 'included', text: `${STDERR}\n`, truncated: false } })
    const failureFrame = aFrames.at(-1)?.messages.find(message => message.source.kind === 'development-task-context')
    if (failureFrame?.source.kind !== 'development-task-context'
      || failureFrame.source.form !== 'snapshot' || failureFrame.source.version !== 2) {
      throw new Error('Natural owner request has no current local projection')
    }
    expect(text([failureFrame])).toContain(FAILURE)
    expect(text([failureFrame])).toContain(STDERR)
    expect(text([failureFrame])).not.toContain(PRIVATE)
    expect(text([failureFrame])).not.toContain(SUCCESS)
    const projection = failureFrame.source
    expect(projection.selectedSources.some(item => item.kind === 'publication' && item.publicationId === failure.id)).toBe(true)
    expect(projection.omittedSources.some(item => item.source.kind === 'publication'
      && item.source.publicationId === success.id && item.reason === 'superseded')).toBe(true)
    expect(Buffer.byteLength(text(managed(aFrames.at(-1)?.messages ?? [])), 'utf8')).toBeLessThanOrEqual(8000)
    await prompt(b, bPage, 'COMMAND_B_OTHER')
    expect(toolResultText(bFrames.at(-1)?.messages ?? [], ToolCallId('command-other'))).toContain(PRIVATE)
    expect(reports()).toHaveLength(3)
    await panel(bPage)
    if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click()
    await sharing.getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    // Source withdrawal is asynchronous and may need the configured reconciliation interval.
    await expect.poll(async () => (await b.ctx.scopeAgentContributions.status({ agentId: bId })).capture,
      { timeout: test.task.timeout }).toBeNull()
    await screenshots(bPage, b, 'stopped', replacements)
    await prompt(b, bPage, 'COMMAND_B_STOPPED')
    expect(reports()).toHaveLength(3)
    await prompt(a, aPage, 'COMMAND_A_WITHDRAWN')
    const withdrawn = text(managed(aFrames.at(-1)?.messages ?? []))
    expect(withdrawn).not.toContain(SUCCESS)
    expect(withdrawn).not.toContain(FAILURE)
    expect(withdrawn).not.toContain(STDERR)
    expect(withdrawn).not.toContain(PRIVATE)
    const withdrawnFrame = aFrames.at(-1)?.messages.find(message => message.source.kind === 'development-task-context')
    if (withdrawnFrame?.source.kind !== 'development-task-context'
      || withdrawnFrame.source.form !== 'snapshot' || withdrawnFrame.source.version !== 2) {
      throw new Error('Original owner Task projection absent after contribution withdrawal')
    }
    for (const publication of [success, failure]) {
      expect(withdrawnFrame.source.omittedSources.some(item => item.source.kind === 'publication'
        && item.source.publicationId === publication.id && item.reason === 'withdrawn')).toBe(true)
    }
    await prompt(b, bPage, 'COMMAND_B_READS')
    expect(text(managed(bFrames.at(-1)?.messages ?? []))).toContain('after-stop')
    const remaining = await b.ctx.scopeAgentContributions.localStatus({ agentId: bId })
    expect(remaining.assignment).toEqual(original.assignment)
    expect(remaining.capture?.selection).toEqual(original.capture.selection)
    expect(remaining.capture?.collecting).toBe(true)
    expect(b.ctx.developmentTasks.get({ taskId: bTask.id }).context.filter(item => item.localToolObservation !== undefined)).toHaveLength(1)
    const retainedReading = await panel(bPage)
    expect(await sharing.getByRole('button', { name: '退出此次协作', exact: true }).count()).toBe(0)
    await retainedReading.getByRole('button', { name: '离开共享上下文', exact: true }).click()
    await expect.poll(async () => {
      const status = await b.ctx.scopeAgentContext.status({ agentId: bId })
      return status.eligibility === 'eligible' && status.state.binding?.kind
    }, { timeout: test.task.timeout }).toBe('local-task')
    await prompt(b, bPage, 'COMMAND_B_LEFT')
    expect(text(managed(bFrames.at(-1)?.messages ?? []))).not.toContain('COMMAND_OWNER_INTERFACE')
    expect(tools.schemas()).toEqual(originalTools)
    expect(bAgent.session.snapshotEvents().slice(0, bHistory.length)).toEqual(bHistory)
    const status = await b.ctx.scopeAgentContext.status({ agentId: bId })
    if (status.eligibility !== 'eligible') throw new Error('Existing source Session lost eligibility')
    expect(status.state.usedBudget).toBe(0)
    expect(status.state.automatic).toBeNull()
    expect(aFrames).toHaveLength(aReplies.length - 1)
    expect(bFrames).toHaveLength(bReplies.length - 1)
    expect(bAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['bash', 'write', 'bash', 'bash', 'bash', 'bash'])
    for (const [host, agent, frames] of [[a, aAgent, aFrames], [b, bAgent, bFrames]] as const) {
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const reader = await host.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const stored = await reader.read()
        expect(stored.events).toEqual(agent.session.snapshotEvents())
        for (const frame of frames) {
          expect(stored.events.slice(0, frame.events.length)).toEqual(frame.events)
          expect(Session.create(reader.id, stored.events.slice(0, frame.events.length), reader.header).deriveMessages())
            .toEqual(frame.messages)
        }
      } finally { await reader.close() }
    }
  })
