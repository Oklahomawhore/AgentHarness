/** One reusable entry connects a native Session and an explicitly selected Claude Hook session. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScopeGroupEntry } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-claude-scope'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import { assertFixtureInventory, launchWebScaffold, readPersistedEvents, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot } from './support.ts'
import { captureContributionPanel, contributionHook, openContributionView, type ContributionView } from './contribution-scope-support.ts'

const MODE = webSnapshotMode()
const EXPECTED = join(import.meta.dirname, 'expected/claude-joint-scope')
const SOURCE = '[data-claude-contribution]'
const JOINT = '[data-claude-joint]'
const NATIVE_PANEL = '[data-native-scope-panel]'
const NATIVE_SHARE = '[data-native-contribution]'
const CLAUDE_SESSION = 'existing-claude-joint-browser'
const GOAL = '原生与 Claude 各自维护重试实现'
const NATIVE_FIRST = 'export const NATIVE_JOINT_retryCount = 3;\n'
const NATIVE_NEXT = 'export const NATIVE_JOINT_retryCount = 5;\n'
const CLAUDE_FIRST = 'export const CLAUDE_JOINT_delay = 250;\n'
const CLAUDE_STOPPED = 'export const CLAUDE_JOINT_stopped = true;\n'
const CLAUDE_PRIVATE = 'export const CLAUDE_BEFORE_JOIN_private = true;\n'
const READ_CONSENT = '我允许此会话在工作时接收整个目标的共享上下文；本项本身不允许自动开始新工作。'
const COLLECTION_CONSENT = '我允许分享上述目录中的所选文件操作。任务所有者批准后可自动启用，直到到期或我停止分享。'
const CLAUDE_READ = '我允许这个 Claude 会话在正常工作时接收该目标的共享上下文。'
const CLAUDE_COLLECTION = '我允许这个 Claude 会话在上述目录和限额内分享 Write/Edit 的完成结果。'

function response(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function write(content: string, ordinal: number): StreamChunk[] {
  const id = ToolCallId(`claude-joint-native-${String(ordinal)}`)
  const args = JSON.stringify({ file_path: 'project/native.ts', content })
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function managed(messages: readonly Message[]): Message[] {
  return messages.filter(message => message.source.kind === 'scope-agent-context')
}
function text(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
function publications(frame: string): { id: string; text: string }[] {
  const body = frame.match(/<development-task-context>\n([\s\S]*?)\n<\/development-task-context>/)?.[1]
  if (body === undefined) throw new Error('Actual context did not contain a Task document')
  const parsed: unknown = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || !('publications' in parsed) || !Array.isArray(parsed.publications)) {
    throw new Error('Actual context has no publications')
  }
  return parsed.publications.map((item: unknown) => {
    if (item === null || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string'
      || !('text' in item) || typeof item.text !== 'string') throw new Error('Actual publication is invalid')
    return { id: item.id, text: item.text }
  })
}
async function prompt(host: WebScaffold, page: Page, marker: string): Promise<SessionId> {
  if (await page.locator(NATIVE_PANEL).isVisible()) await page.keyboard.press('Escape')
  const settled = host.whenTurnSettled(30_000)
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill(`继续我的工作：${marker}`)
  await composer.press('Enter')
  const id = await settled
  await page.getByText(marker, { exact: true }).waitFor()
  return id
}

describe.skipIf(process.platform === 'win32')('web e2e: Claude joins a reusable shared scope', () => {
  let directory: string | undefined
  let browser: Browser | undefined
  const hosts: WebScaffold[] = []
  const views: ContributionView[] = []
  let owner: ContributionView
  let native: ContributionView
  let claude: ContributionView
  let generation: string
  const requests: Message[][] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Claude joint browser acceptance uses keyless controlled responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-claude-joint-web-'))
    const override = join(directory, 'native.override.json')
    const plan: ReplayOverrideDoc = [response('NATIVE_READY'), write(NATIVE_FIRST, 1), response('NATIVE_PUBLISHED'),
      response('NATIVE_RECEIVED_CLAUDE'), write(NATIVE_NEXT, 2), response('NATIVE_PUBLISHED_AGAIN'),
      response('NATIVE_AFTER_CLAUDE_LEFT')].map(chunks => ({ kind: 'chunks', chunks }))
    await writeFile(override, JSON.stringify(plan))
    hosts.push(await launchWebScaffold({ hermeticMcpClients: true }))
    hosts.push(await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 5,
      replayFixture: join(directory, 'native-override-only.jsonl'), replayOverride: override }))
    hosts.push(await launchWebScaffold({ hermeticMcpClients: true }))
    const [ownerHost, nativeHost, claudeHost] = hosts
    if (!ownerHost || !nativeHost || !claudeHost) throw new Error('Three independent Hosts are required')
    nativeHost.ctx.on('llm/stream', (options, next) => { requests.push(structuredClone(options.messages)); return next() })
    browser = await chromium.launch()
    owner = await openContributionView(browser, ownerHost, true); views.push(owner)
    native = await openContributionView(browser, nativeHost, false); views.push(native)
    claude = await openContributionView(browser, claudeHost, true); views.push(claude)
    const descriptor = JSON.parse(await readFile(join(claudeHost.harnessHome, 'claude-scope/connection.json'), 'utf8')) as { generation: string }
    generation = descriptor.generation
    if (MODE === 'refresh') await mkdir(EXPECTED, { recursive: true })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), ...hosts.toReversed().map(host => () => host.close()),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) {
        console.error('Claude joint cleanup failure', error instanceof AggregateError ? error.errors : error)
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Claude joint browser cleanup failed')
  }, 120_000)

  it('adopts one approval off-page, exchanges facts, and leaves retained reading without affecting the native member', async () => {
    onTestFailed(async () => {
      for (const [index, view] of views.entries()) {
        if (view.page.isClosed()) continue
        await saveFailureShot(view.page, `web-e2e-claude-joint-${String(index)}`)
        console.error('Claude joint browser failure', { index, errors: view.errors, warnings: view.tripwire.warnings,
          pageErrors: view.tripwire.pageErrors, aria: await view.page.locator('body').ariaSnapshot() })
      }
    })
    expect(new Set(hosts.map(host => host.harnessHome)).size).toBe(3)
    await connectFreshWorkspaceZh(native.page, native.scaffold.workspaceCwd, 'native-joint')
    const nativeCwd = join(native.scaffold.workspaceCwd, 'native-joint')
    await mkdir(join(nativeCwd, 'project'), { recursive: true })
    const nativeId = await prompt(native.scaffold, native.page, 'NATIVE_READY')
    const original = native.scaffold.ctx.agents.get(nativeId)
    if (original === undefined) throw new Error('Existing native Session is missing')
    const originalHistory = original.session.snapshotEvents()
    expect(managed(requests[0] ?? [])).toEqual([])

    const sourceCenter = claude.page.locator('[data-emergence-center]')
    await sourceCenter.getByLabel('项目路径', { exact: true }).fill(claude.scaffold.workspaceCwd)
    await sourceCenter.getByRole('button', { name: '配置 hooks', exact: true }).click()
    await sourceCenter.getByText('项目 hooks 已配置', { exact: true }).waitFor()
    const hookInput = { session_id: CLAUDE_SESSION, cwd: claude.scaffold.workspaceCwd }
    await contributionHook(claude.scaffold, generation, { ...hookInput, hook_event_name: 'SessionStart' })
    const claudeFile = join(claude.scaffold.workspaceCwd, 'claude.ts')
    const reportWrite = async (content: string) => {
      const tool = { ...hookInput, tool_name: 'Write', tool_use_id: randomUUID(), tool_input: { file_path: claudeFile, content } }
      await contributionHook(claude.scaffold, generation, { ...tool, hook_event_name: 'PreToolUse' })
      await writeFile(claudeFile, content)
      return contributionHook(claude.scaffold, generation, { ...tool, hook_event_name: 'PostToolUse' })
    }
    await reportWrite(CLAUDE_PRIVATE)
    await sourceCenter.getByRole('button', { name: '刷新会话', exact: true }).click()
    await sourceCenter.getByRole('radio', { name: new RegExp(CLAUDE_SESSION) }).check()
    const observed = (await claude.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionId === CLAUDE_SESSION)
    if (observed === undefined) throw new Error('Existing Claude Hook session was not observed')
    expect(observed.receiveSubscriptionId).toBeUndefined()
    expect(observed.joint).toBeUndefined()

    const center = owner.page.locator('[data-emergence-center]')
    await center.getByLabel('协作显示名').fill('Joint Scope Owner')
    await center.getByRole('button', { name: '保存身份', exact: true }).click()
    await center.getByText('协作身份已生效：Joint Scope Owner', { exact: true }).waitFor()
    await center.getByRole('button', { name: '新建任务', exact: true }).click()
    await center.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const taskForm = center.locator('form').filter({ has: owner.page.getByLabel('Task 名称') })
    await taskForm.getByLabel('Task 名称').fill(GOAL)
    await taskForm.getByLabel('初始共享上下文').fill('各自维护自己的实现；共享已授权的工具观察。')
    await taskForm.getByRole('button', { name: '创建任务', exact: true }).click()
    await taskForm.waitFor({ state: 'detached' })
    await center.getByRole('heading', { name: GOAL, exact: true }).waitFor()
    const access = center.locator('details:has(> summary:text-is("独立设备协作"))')
    await access.locator(':scope > summary').click()
    await center.locator('[data-scope-contribution-owner]').locator(':scope > summary').click()
    const applications = center.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('group')
    await applications.getByLabel('累计申请名额', { exact: true }).fill('2')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '邀请多人加入同一目标', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain('scope-group-entry')
    const entryText = await entryField.inputValue()
    const entry = JSON.parse(entryText) as ScopeGroupEntry
    const taskId = entry.taskId
    const identities = await Promise.all(hosts.map(host => host.ctx.scopeAccess.identity()))
    const [ownerIdentity, nativeIdentity, claudeIdentity] = identities
    if (!ownerIdentity || !nativeIdentity || !claudeIdentity) throw new Error('Independent public identities are missing')
    expect(new Set(identities.map(identity => identity.peerId)).size).toBe(3)

    await native.page.getByRole('button', { name: '协作', exact: true }).click()
    const scope = native.page.locator(NATIVE_PANEL)
    await scope.getByRole('radio', { name: '他人分享的目标', exact: true }).check()
    const sharing = native.page.locator(NATIVE_SHARE)
    await sharing.locator(':scope > summary').click()
    await sharing.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
    await sharing.getByRole('button', { name: '验证连接', exact: true }).click()
    await sharing.getByText(taskId, { exact: true }).waitFor()
    await sharing.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(join(nativeCwd, 'project'))
    await sharing.getByRole('checkbox', { name: '写入文件（write）', exact: true }).check()
    await sharing.getByLabel('授权有效期（小时）', { exact: true }).fill('1')
    await sharing.getByLabel('最多样本数', { exact: true }).fill('8')
    await sharing.getByLabel('每份样本字节上限', { exact: true }).fill('8192')
    await sharing.getByRole('checkbox', { name: COLLECTION_CONSENT, exact: true }).check()
    await sharing.getByRole('checkbox', { name: READ_CONSENT, exact: true }).check()
    await sharing.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
    const nativeRow = applications.locator('[data-group-application]').filter({ hasText: nativeIdentity.peerId })
    await nativeRow.getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await nativeRow.getByLabel('该会话的协作职责', { exact: true }).fill('维护原生客户端重试次数')
    await nativeRow.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
    await sharing.getByText('此次加入的读取已连接', { exact: true }).waitFor()
    expect(requests).toHaveLength(1)

    let source = claude.page.locator(SOURCE)
    await source.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
    await source.getByRole('button', { name: '核对申请入口', exact: true }).click()
    await source.getByRole('checkbox', { name: CLAUDE_READ, exact: true }).waitFor()
    await source.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(claude.scaffold.workspaceCwd)
    await source.getByLabel('授权有效期（小时）', { exact: true }).fill('2')
    await source.getByLabel('最多样本数', { exact: true }).fill('8')
    await source.getByLabel('每份样本字节上限', { exact: true }).fill('8192')
    expect(await source.getByRole('checkbox', { name: CLAUDE_READ, exact: true }).isChecked()).toBe(false)
    expect(await source.getByRole('checkbox', { name: CLAUDE_COLLECTION, exact: true }).isChecked()).toBe(false)
    expect(await source.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).isEnabled()).toBe(false)
    await source.getByRole('checkbox', { name: CLAUDE_READ, exact: true }).check()
    expect(await source.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).isEnabled()).toBe(false)
    await source.getByRole('checkbox', { name: CLAUDE_COLLECTION, exact: true }).check()
    await source.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
    await source.getByText('等待所有者批准读取与文件贡献。', { exact: true }).waitFor()
    const pending = await claude.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: observed.sessionKey })
    if (pending.capture?.application == null || pending.session.joint === undefined) throw new Error('Joint application not retained')
    expect(pending.session.joint.expectedReadRevision).toBe(observed.readRevision)
    expect(pending.capture.application.entry).toEqual(entry)
    const replacements: (readonly [string, string])[] = [
      [entry.ownerAddress, '{{ownerAddress}}'], [ownerIdentity.peerId, '{{ownerPeer}}'], [nativeIdentity.peerId, '{{nativePeer}}'],
      [claudeIdentity.peerId, '{{claudePeer}}'], [taskId, '{{taskId}}'],
      [pending.capture.selection.captureId, '{{captureId}}'], [pending.capture.selection.captureGeneration, '{{captureGeneration}}'],
      [await claude.page.evaluate(value => new Date(value).toLocaleString(), pending.capture.application.limits.expiresAt), '{{permissionExpires}}'],
    ]
    const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
    await expect.poll(() => source.getByRole('button', { name: '退出此次协作', exact: true }).isEnabled()).toBe(true)
    await captureContributionPanel(claude, SOURCE, join(EXPECTED, 'source-waiting.expected.md'), replacements, shots)
    const claudeRow = applications.locator('[data-group-application]').filter({ hasText: claudeIdentity.peerId })
    await claudeRow.getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await claude.page.close()
    await claudeRow.getByLabel('该会话的协作职责', { exact: true }).fill('维护 Claude 服务端重试延迟')
    await claudeRow.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
    await expect.poll(async () => (await claude.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: observed.sessionKey }))
      .session.joint?.state, { timeout: 15_000 }).toBe('active')
    const active = await claude.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: observed.sessionKey })
    const joined = active.session.joint
    if (joined?.subscriptionId === undefined || active.capture?.invitation == null) throw new Error('Background joint adoption failed')
    expect(active.capture.selection).toEqual(pending.capture.selection)
    expect(active.session.receiveSubscriptionId).toBe(joined.subscriptionId)
    expect(active.session.taskId).toBeUndefined()
    expect((await owner.scaffold.ctx.scopeAccess.groupApplications({ entryId: entry.entryId })).entries
      .map(item => item.result.status)).toEqual(['approved', 'approved'])
    expect(requests).toHaveLength(1)
    if (browser === undefined) throw new Error('Browser unexpectedly closed')
    claude = await openContributionView(browser, claude.scaffold, true); views.push(claude)
    await claude.page.getByRole('radio', { name: new RegExp(CLAUDE_SESSION) }).check()
    source = claude.page.locator(SOURCE)
    await source.getByText('此次协作的读取连接已就绪。', { exact: true }).waitFor()
    await expect.poll(() => source.getByRole('button', { name: '退出此次协作', exact: true }).isEnabled()).toBe(true)
    await captureContributionPanel(claude, JOINT, join(EXPECTED, 'joint-active.expected.md'), replacements, shots)

    await prompt(native.scaffold, native.page, 'NATIVE_PUBLISHED')
    expect(await readFile(join(nativeCwd, 'project/native.ts'), 'utf8')).toBe(NATIVE_FIRST)
    await expect.poll(() => owner.scaffold.ctx.developmentTasks.get({ taskId }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    const nativePublication = owner.scaffold.ctx.developmentTasks.get({ taskId }).context.find(item =>
      item.peerToolObservation?.observerPeerId === nativeIdentity.peerId)
    if (nativePublication === undefined) throw new Error('Native contribution is missing')
    const firstHook = await contributionHook(claude.scaffold, generation, { ...hookInput, hook_event_name: 'UserPromptSubmit' })
    const firstText = firstHook.output.hookSpecificOutput?.additionalContext ?? ''
    expect(publications(firstText)).toContainEqual({ id: nativePublication.id, text: nativePublication.text })
    expect(firstText).not.toContain(CLAUDE_PRIVATE.trim())
    expect((await reportWrite(CLAUDE_FIRST)).receipt.status).toBe('published')
    expect(await readFile(claudeFile, 'utf8')).toBe(CLAUDE_FIRST)
    await expect.poll(() => owner.scaffold.ctx.developmentTasks.get({ taskId }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(2)
    const claudePublication = owner.scaffold.ctx.developmentTasks.get({ taskId }).context.find(item =>
      item.peerToolObservation?.observerPeerId === claudeIdentity.peerId)
    if (claudePublication === undefined) throw new Error('Claude contribution is missing')
    await prompt(native.scaffold, native.page, 'NATIVE_RECEIVED_CLAUDE')
    const actual = requests.at(-1)
    if (actual === undefined) throw new Error('Native model request was not observed')
    expect(publications(text(managed(actual)))).toContainEqual({ id: claudePublication.id, text: claudePublication.text })
    expect(text(managed(actual))).not.toContain(CLAUDE_PRIVATE.trim())
    expect(managed(original.session.deriveMessages())).toEqual(managed(actual))

    await source.getByRole('button', { name: '停止贡献', exact: true }).click()
    await expect.poll(async () => (await claude.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: observed.sessionKey })).capture)
      .toBeNull()
    const stopped = await claude.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: observed.sessionKey })
    expect(stopped.session.joint?.id).toBe(joined.id)
    expect(stopped.session.joint?.state).toBe('active')
    expect(stopped.session.receiveSubscriptionId).toBe(joined.subscriptionId)
    const route = source.locator('[data-claude-joint-route]')
    await route.locator(':scope > summary').click()
    await route.getByLabel('新的连接地址', { exact: true }).fill(entry.ownerAddress)
    await route.getByRole('button', { name: '保存恢复地址', exact: true }).click()
    await expect.poll(async () => (await claude.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionKey === observed.sessionKey)
      ?.readRevision).toBe(stopped.session.readRevision + 1)
    await expect.poll(() => route.getByLabel('新的连接地址', { exact: true }).inputValue()).toBe('')
    await expect.poll(() => source.getByRole('button', { name: '退出此次协作', exact: true }).isEnabled()).toBe(true)
    await captureContributionPanel(claude, JOINT, join(EXPECTED, 'joint-sharing-stopped.expected.md'), replacements, shots)
    const reportsBefore = owner.scaffold.ctx.developmentTasks.get({ taskId }).context.filter(item => item.peerToolObservation !== undefined)
    await reportWrite(CLAUDE_STOPPED)
    expect(owner.scaffold.ctx.developmentTasks.get({ taskId }).context.filter(item => item.peerToolObservation !== undefined))
      .toEqual(reportsBefore)
    await prompt(native.scaffold, native.page, 'NATIVE_PUBLISHED_AGAIN')
    expect(await readFile(join(nativeCwd, 'project/native.ts'), 'utf8')).toBe(NATIVE_NEXT)
    await expect.poll(() => owner.scaffold.ctx.developmentTasks.get({ taskId }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(3)
    const afterStop = await contributionHook(claude.scaffold, generation, { ...hookInput, hook_event_name: 'UserPromptSubmit' })
    const retainedText = afterStop.output.hookSpecificOutput?.additionalContext ?? ''
    const newest = owner.scaffold.ctx.developmentTasks.get({ taskId }).context.filter(item =>
      item.peerToolObservation?.observerPeerId === nativeIdentity.peerId).at(-1)
    if (newest === undefined) throw new Error('Second native contribution is missing')
    expect(publications(retainedText)).toContainEqual({ id: newest.id, text: newest.text })
    expect(retainedText).not.toContain(CLAUDE_STOPPED.trim())

    await source.getByRole('button', { name: '退出此次协作', exact: true }).click()
    await source.getByText('此次协作的读取已结束。', { exact: true }).waitFor()
    const left = (await claude.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionKey === observed.sessionKey)
    expect(left?.joint).toMatchObject({ id: joined.id, state: 'ended', intent: 'leave' })
    expect((await claude.scaffold.ctx.scopeAccess.list()).subscriptions.find(item => item.id === joined.subscriptionId)?.state).toBe('left')
    const withdrawn = await contributionHook(claude.scaffold, generation, { ...hookInput, hook_event_name: 'UserPromptSubmit' })
    expect(withdrawn.receipt.status).toBe('withdrawn')
    expect(withdrawn.output.hookSpecificOutput?.additionalContext ?? '').not.toContain(NATIVE_NEXT.trim())
    expect(withdrawn.output.hookSpecificOutput?.additionalContext ?? '').not.toContain('<development-task-context>')
    await captureContributionPanel(claude, JOINT, join(EXPECTED, 'joint-left.expected.md'), replacements, shots)
    await prompt(native.scaffold, native.page, 'NATIVE_AFTER_CLAUDE_LEFT')
    const status = await native.scaffold.ctx.scopeAgentContext.status({ agentId: nativeId })
    expect(status.eligibility).toBe('eligible')
    if (status.eligibility === 'not-live') throw new Error('Native member disappeared')
    expect(status.state).toMatchObject({ mode: 'passive', automatic: null, usedBudget: 0 })
    expect(native.scaffold.ctx.agents.get(nativeId)).toBe(original)
    expect(original.session.snapshotEvents().slice(0, originalHistory.length)).toEqual(originalHistory)
    expect(original.session.snapshotEvents().filter(event => event.type === 'tool/call')
      .map(event => event.data.name)).toEqual(['write', 'write'])
    expect(requests).toHaveLength(7)
    expect(original.session.snapshotEvents().filter(event => event.type === 'turn/end')
      .map(event => event.data.reason.kind)).toEqual(Array.from({ length: 5 }, () => 'completed'))
    expect(await native.scaffold.ctx.sessions.flush(original.session)).toBe(true)
    const events = await readPersistedEvents(native.scaffold, nativeId)
    const detached = Session.create(nativeId, structuredClone([...events]), original.session.header)
    expect(managed(detached.deriveMessages())).toEqual(managed(requests.at(-1) ?? []))
    expect(text(managed(requests.at(-1) ?? []))).not.toContain(CLAUDE_FIRST.trim())
    for (const view of views) { expect(view.tripwire.pageErrors).toEqual([]); expect(view.tripwire.warnings).toEqual([]) }
    await assertFixtureInventory(EXPECTED, ['source-waiting.expected.md', 'joint-active.expected.md',
      'joint-sharing-stopped.expected.md', 'joint-left.expected.md'])
  }, 180_000)
})
