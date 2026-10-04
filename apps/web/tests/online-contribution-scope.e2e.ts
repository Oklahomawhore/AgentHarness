/** Independent source approvals project API samples and directory tool observations into passive native requests. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-claude-scope'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { assertFixtureInventory, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot } from './support.ts'
import { captureContributionPanel, contributionHook, openContributionView, type ContributionView } from './contribution-scope-support.ts'

const MODE = webSnapshotMode()
const SNAPSHOTS = join(import.meta.dirname, 'snapshots/online-contribution-scope')
const SOURCE = '[data-claude-contribution]'
const OWNER = '[data-contribution-applications]'
const ACCESS = '[data-emergence-center] details:has(> summary:text-is("独立设备协作"))'
const OBJECTIVE = '一次入口的订单接口协作'
const SESSION = 'browser-online-contribution-source'

function declaration(field: string): string {
  return JSON.stringify({ openapi: '3.1.1', info: { title: 'Orders', version: '1' }, paths: {
    '/orders': { post: { operationId: 'createOrder', requestBody: { required: true,
      content: { 'application/json': { schema: { type: 'object', required: [field] } } } },
    responses: { '201': { description: 'Created' } } } },
  } })
}

function replay(count: number, prefix: string): ReplayOverrideDoc {
  return Array.from({ length: count }, (_, offset) => offset + 1).map(index => ({ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: `${prefix}_${String(index)}` },
    { type: 'block-end', index: 0, block: { type: 'text', text: `${prefix}_${String(index)}` } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }))
}

function expectCompleted(scaffold: WebScaffold, sessionId: SessionId, responses: readonly string[]): void {
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Expected recipient Agent is no longer live')
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
    .toEqual(responses.map(() => 'completed'))
  expect(events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual(responses)
}

function contextText(messages: readonly Message[]): string {
  const context = messages.filter(message => message.source.kind === 'scope-agent-context')
  expect(context).toHaveLength(1)
  return context.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function renderedPublications(text: string): { id: string; text: string }[] {
  const json = text.match(/<development-task-context>\n([\s\S]*?)\n<\/development-task-context>/)?.[1]
  if (json === undefined) throw new Error('Actual model context has no Task document')
  const document: unknown = JSON.parse(json)
  if (document === null || typeof document !== 'object' || !('publications' in document) || !Array.isArray(document.publications)) {
    throw new Error('Actual model context has no publication array')
  }
  return document.publications.map((publication: unknown) => {
    if (publication === null || typeof publication !== 'object' || !('id' in publication) || typeof publication.id !== 'string'
      || !('text' in publication) || typeof publication.text !== 'string') throw new Error('Actual model publication is invalid')
    return { id: publication.id, text: publication.text }
  })
}

describe.skipIf(process.platform === 'win32')('web e2e: online contribution approval', () => {
  let ownerHost: WebScaffold | undefined
  let sourceHost: WebScaffold | undefined
  let receiverHost: WebScaffold | undefined
  let browser: Browser | undefined
  let owner: ContributionView
  let source: ContributionView
  let receiver: ContributionView
  let directory: string
  let generation: string
  let filePath: string
  let taskId: DevelopmentTaskId
  const requests: Message[][] = []
  const views: ContributionView[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Online contribution acceptance uses keyless controlled responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-online-contribution-ui-'))
    const replayOverride = join(directory, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(replay(2, 'ONLINE_CONTRIBUTION_RESULT')))
    ownerHost = await launchWebScaffold({ hermeticMcpClients: true })
    sourceHost = await launchWebScaffold({ hermeticMcpClients: true })
    receiverHost = await launchWebScaffold({ hermeticMcpClients: true,
      replayFixture: join(directory, 'override-only.jsonl'), replayOverride, paceMs: 5 })
    receiverHost.ctx.on('llm/stream', (options, next) => { requests.push(structuredClone(options.messages)); return next() })
    expect(new Set([ownerHost.harnessHome, sourceHost.harnessHome, receiverHost.harnessHome]).size).toBe(3)
    browser = await chromium.launch()
    owner = await openContributionView(browser, ownerHost, true)
    views.push(owner)
    source = await openContributionView(browser, sourceHost, true)
    views.push(source)
    receiver = await openContributionView(browser, receiverHost, false)
    views.push(receiver)
    filePath = join(sourceHost.workspaceCwd, 'openapi.json')
    await writeFile(filePath, declaration('not-yet-shared'))
    const descriptorText = await readFile(join(sourceHost.harnessHome, 'claude-scope/connection.json'), 'utf8')
    const descriptor = JSON.parse(descriptorText) as { generation: string }
    generation = descriptor.generation
    if (MODE === 'refresh') await mkdir(SNAPSHOTS, { recursive: true })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => receiverHost?.close(), () => sourceHost?.close(), () => ownerHost?.close(),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) {
        console.error('online contribution cleanup error', error instanceof AggregateError ? error.errors : error)
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Online contribution cleanup failed')
  })

  beforeEach(() => {
    onTestFailed(async () => {
      for (const [index, view] of views.entries()) {
        if (view.page.isClosed()) continue
        await saveFailureShot(view.page, `web-e2e-online-contribution-${String(index)}`)
        console.error('online contribution diagnostics', { index, errors: view.errors,
          warnings: view.tripwire.warnings, pageErrors: view.tripwire.pageErrors,
          aria: await view.page.locator('body').ariaSnapshot() })
      }
    })
  })

  it('retrieves OpenAPI approval with the source page closed and projects the next sampled declaration', async () => {
    const ownerPanel = owner.page.locator('[data-emergence-center]')
    await ownerPanel.getByLabel('协作显示名').fill('Online Contribution Owner')
    await ownerPanel.getByRole('button', { name: '保存身份', exact: true }).click()
    await ownerPanel.getByRole('status').getByText('协作身份已生效：Online Contribution Owner', { exact: true }).waitFor()
    await ownerPanel.getByRole('button', { name: '新建任务', exact: true }).click()
    await ownerPanel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = ownerPanel.locator('form').filter({ has: owner.page.getByLabel('Task 名称') })
    await form.getByLabel('Task 名称').fill(OBJECTIVE)
    await form.getByLabel('初始共享上下文').fill('Orders 来源维护接口，前端接收经过授权的当前声明。')
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    await ownerPanel.getByRole('heading', { name: OBJECTIVE, exact: true }).waitFor()
    taskId = owner.scaffold.ctx.developmentTasks.list({ limit: 200 }).find(task => task.objective === OBJECTIVE)!.id
    const access = owner.page.locator(ACCESS)
    await access.locator(':scope > summary').click()
    await owner.page.locator('[data-scope-contribution-owner]').locator(':scope > summary').click()
    const applications = owner.page.locator(OWNER)
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('contribution')
    await applications.getByRole('combobox', { name: '贡献来源', exact: true }).selectOption('openapi')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '生成一次申请入口', exact: true }).click()
    const entryText = await applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true }).inputValue()
    const entry = JSON.parse(entryText) as ScopeContributionEntry
    expect(entry).toMatchObject({ kind: 'contribution-entry', sourceKind: 'openapi' })
    expect(entry.taskId).toBe(taskId)

    const sourcePanel = source.page.locator('[data-emergence-center]')
    await sourcePanel.getByLabel('项目路径', { exact: true }).fill(source.scaffold.workspaceCwd)
    await sourcePanel.getByRole('button', { name: '配置 hooks', exact: true }).click()
    await sourcePanel.getByText('项目 hooks 已配置', { exact: true }).waitFor()
    await contributionHook(source.scaffold, generation, {
      hook_event_name: 'SessionStart', session_id: SESSION, cwd: source.scaffold.workspaceCwd,
    })
    await sourcePanel.getByRole('button', { name: '刷新会话', exact: true }).click()
    await sourcePanel.getByRole('radio', { name: new RegExp(SESSION) }).check()
    const sourceSession = (await source.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionId === SESSION)!
    const contribution = source.page.locator(SOURCE)
    await contribution.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
    await contribution.getByRole('button', { name: '核对申请入口', exact: true }).click()
    await contribution.getByLabel('API 文件', { exact: true }).fill(filePath)
    await contribution.getByLabel('来源名称', { exact: true }).fill('Orders')
    await contribution.getByRole('combobox', { name: 'HTTP 方法', exact: true }).selectOption('post')
    await contribution.getByLabel('API 路径', { exact: true }).fill('/orders')
    await contribution.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(source.scaffold.workspaceCwd)
    await contribution.getByLabel('授权有效期（小时）', { exact: true }).fill('2')
    await contribution.getByLabel('最多样本数', { exact: true }).fill('4')
    await contribution.getByLabel('每份样本字节上限', { exact: true }).fill('4096')
    await contribution.getByRole('button', { name: '申请并在批准后启用', exact: true }).click()
    await contribution.getByRole('status').getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
    const pending = await source.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: sourceSession.sessionKey })
    expect(pending.capture?.invitation).toBeNull()
    expect(pending.capture?.application?.state).toBe('waiting')
    if (pending.capture === null || pending.capture.application === null) throw new Error('Application was not retained')
    const limits = pending.capture.application.limits
    const localTime = (timestamp: number) => owner.page.evaluate(value => new Date(value).toLocaleString(), timestamp)
    const entryExpiresLocal = await localTime(entry.expiresAt)
    const permissionExpiresLocal = await localTime(limits.expiresAt)
    expect(permissionExpiresLocal).not.toBe(entryExpiresLocal)
    const replacements: (readonly [string, string])[] = [
      [taskId, '{{taskId}}'], [entry.entryId, '{{entryId}}'], [entry.ownerPeerId, '{{ownerPeerId}}'],
      [entry.ownerAddress, '{{ownerAddress}}'], [String(entry.expiresAt), '{{entryExpiresAt}}'],
      [entryExpiresLocal, '{{entryExpiresLocal}}'], [permissionExpiresLocal, '{{permissionExpiresLocal}}'],
      [pending.capture.proposal.contributorPeerId, '{{contributorPeerId}}'],
    ]
    await captureContributionPanel(source, SOURCE, join(SNAPSHOTS, 'source-waiting.expected.md'),
      replacements, process.env.DSH_ONLINE_CONTRIBUTION_SHOTS)
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await captureContributionPanel(owner, OWNER, join(SNAPSHOTS, 'owner-pending.expected.md'),
      replacements, process.env.DSH_ONLINE_CONTRIBUTION_SHOTS)
    expect(owner.scaffold.ctx.developmentTasks.peerContributions({ taskId })).toEqual([])
    await source.page.close()
    expect(source.page.isClosed()).toBe(true)
    await applications.getByRole('button', { name: '批准并让来源自动启用', exact: true }).click()
    await applications.getByRole('status').getByText('已批准，来源将自动取回授权', { exact: true }).waitFor()
    // contributionDetail is read-only: it neither schedules recovery nor starts application polling.
    await expect.poll(async () => {
      const detail = await source.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: sourceSession.sessionKey })
      return detail.session.contributionState
    }, { timeout: 15_000 }).toBe('active')
    const active = await source.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: sourceSession.sessionKey })
    const grants = owner.scaffold.ctx.developmentTasks.peerContributions({ taskId })
    expect(grants).toHaveLength(1)
    expect(active.capture?.selection).toEqual(pending.capture.selection)
    expect(active.capture?.application).toBeNull()
    expect(active.capture?.invitation?.grant).toEqual(grants[0]!.grant)
    expect(grants[0]!.grant).toMatchObject({ ...limits, captureId: pending.capture.selection.captureId })
    expect(owner.scaffold.ctx.developmentTasks.get({ taskId }).context.filter(item => item.peerObservation !== undefined)).toHaveLength(0)

    // Read access is a separate explicit invitation; it does not enable source collection or automatic model turns.
    await connectFreshWorkspaceZh(receiver.page, receiver.scaffold.workspaceCwd, 'online-contribution-recipient')
    const composer = receiver.page.locator('[data-composer-input][contenteditable="true"]').last()
    const firstTurn = receiver.scaffold.whenTurnSettled(30_000)
    await composer.fill('ONLINE_USER: 开始前端工作。')
    await composer.press('Enter')
    const sessionId = await firstTurn
    const identity = await receiver.scaffold.ctx.scopeAccess.identity()
    await access.getByLabel('接收设备身份', { exact: true }).fill(identity.peerId)
    await access.getByLabel('此会话的职责', { exact: true }).fill('frontend')
    await access.getByRole('button', { name: '生成只读邀请', exact: true }).click()
    const readText = await access.getByRole('textbox', { name: '将此邀请交给接收人', exact: true }).inputValue()
    await receiver.page.getByRole('button', { name: '协作', exact: true }).click()
    const native = receiver.page.locator('[data-native-scope-panel]')
    await native.getByLabel('粘贴只读邀请', { exact: true }).fill(readText)
    await native.getByRole('button', { name: '连接此会话', exact: true }).click()
    await expect.poll(async () => {
      const status = await receiver.scaffold.ctx.scopeAgentContext.status({ agentId: sessionId })
      return status.eligibility === 'not-live' ? undefined : status.state.mode
    }).toBe('passive')
    await receiver.page.keyboard.press('Escape')
    const content = declaration('onlineOrderCode')
    const input = { session_id: SESSION, cwd: source.scaffold.workspaceCwd, tool_name: 'Write',
      tool_use_id: randomUUID(), tool_input: { file_path: filePath, content } }
    await contributionHook(source.scaffold, generation, { ...input, hook_event_name: 'PreToolUse' })
    await writeFile(filePath, content)
    await contributionHook(source.scaffold, generation, { ...input, hook_event_name: 'PostToolUse' })
    const nextTurn = receiver.scaffold.whenTurnSettled(30_000)
    await composer.fill('ONLINE_USER: 继续前端工作。')
    await composer.press('Enter')
    expect(await nextTurn).toBe(sessionId)
    expect(requests).toHaveLength(2)
    expectCompleted(receiver.scaffold, sessionId, ['ONLINE_CONTRIBUTION_RESULT_1', 'ONLINE_CONTRIBUTION_RESULT_2'])
    const facts = requests[1]!.filter(message => message.source.kind === 'scope-agent-context')
      .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(facts).toContain('"requiredRequestFields":["onlineOrderCode"]')
    expect(facts).not.toContain('not-yet-shared')
    expect(source.page.isClosed()).toBe(true)
    expect(source.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(receiver.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    const events = receiver.scaffold.ctx.agents.get(sessionId)!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(0)
    for (const view of views) {
      expect(view.errors).toEqual([])
      expect(view.tripwire.warnings).toEqual([])
      expect(view.tripwire.pageErrors).toEqual([])
    }
    await receiver.page.close()
    await receiver.scaffold.close()
    receiverHost = undefined
  }, 180_000)

  it('shares two allowed files from one independent session without file registration and withdraws both', async () => {
    if (browser === undefined || sourceHost === undefined) throw new Error('Hosts were not started')
    const replayOverride = join(directory, 'directory.override.json')
    await writeFile(replayOverride, JSON.stringify(replay(3, 'DIRECTORY_CONTRIBUTION_RESULT')))
    receiverHost = await launchWebScaffold({ hermeticMcpClients: true,
      replayFixture: join(directory, 'directory-override-only.jsonl'), replayOverride, paceMs: 5 })
    receiverHost.ctx.on('llm/stream', (options, next) => { requests.push(structuredClone(options.messages)); return next() })
    const toolSource = await openContributionView(browser, sourceHost, true)
    const toolReceiver = await openContributionView(browser, receiverHost, false)
    views.push(toolSource, toolReceiver)
    const requestOffset = requests.length
    const session = 'browser-directory-contribution-source'
    const objective = '目录授权的代码与文档协作'
    const ownerPanel = owner.page.locator('[data-emergence-center]')
    await ownerPanel.getByLabel('协作显示名').fill('Directory Contribution Owner')
    await ownerPanel.getByRole('button', { name: '保存身份', exact: true }).click()
    await ownerPanel.getByRole('status').getByText('协作身份已生效：Directory Contribution Owner', { exact: true }).waitFor()
    await ownerPanel.getByRole('button', { name: '新建任务', exact: true }).click()
    await ownerPanel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = ownerPanel.locator('form').filter({ has: owner.page.getByLabel('Task 名称') })
    await form.getByLabel('Task 名称').fill(objective)
    await form.getByLabel('初始共享上下文').fill('接收已授权的代码和文档工具观察，保留来源及完成状态。')
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    await ownerPanel.getByRole('heading', { name: objective, exact: true }).waitFor()
    const toolTask = owner.scaffold.ctx.developmentTasks.list({ limit: 200 }).find(task => task.objective === objective)
    if (toolTask === undefined) throw new Error('Directory contribution Task was not created')
    const access = owner.page.locator(ACCESS)
    if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
    const owned = owner.page.locator('[data-scope-contribution-owner]')
    if (await owned.getAttribute('open') === null) await owned.locator(':scope > summary').click()
    const applications = owner.page.locator(OWNER)
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('contribution')
    await applications.getByRole('combobox', { name: '贡献来源', exact: true }).selectOption('tool-observations')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '生成一次申请入口', exact: true }).click()
    const entryField = applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => entryField.inputValue()).toContain(toolTask.id)
    const entryText = await entryField.inputValue()
    const entry = JSON.parse(entryText) as ScopeContributionEntry
    expect(entry).toMatchObject({ kind: 'contribution-entry', sourceKind: 'tool-observations', taskId: toolTask.id })

    const root = join(toolSource.scaffold.workspaceCwd, 'directory-work')
    await mkdir(join(root, 'code'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })
    const codePath = join(root, 'code/retry.ts')
    const documentPath = join(root, 'docs/coordination.md')
    const oldDocument = 'Retries are not documented yet.'
    const newDocument = 'DOC_CHANGE: retry only after an explicit retryable response.'
    const code = 'export const CODE_CHANGE_retryLimit = 3;\n'
    await writeFile(documentPath, oldDocument)
    expect((await contributionHook(toolSource.scaffold, generation, {
      hook_event_name: 'SessionStart', session_id: session, cwd: toolSource.scaffold.workspaceCwd,
    })).receipt.status).toBe('observed')
    const sourcePanel = toolSource.page.locator('[data-emergence-center]')
    await sourcePanel.getByLabel('项目路径', { exact: true }).fill(toolSource.scaffold.workspaceCwd)
    await sourcePanel.getByRole('button', { name: '配置 hooks', exact: true }).click()
    await sourcePanel.getByText('项目 hooks 已配置', { exact: true }).waitFor()
    await sourcePanel.getByRole('button', { name: '刷新会话', exact: true }).click()
    await sourcePanel.getByRole('radio', { name: new RegExp(session) }).check()
    const sourceSession = (await toolSource.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionId === session)
    if (sourceSession === undefined) throw new Error('Directory contribution session was not observed')
    const contribution = toolSource.page.locator(SOURCE)
    await contribution.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
    await contribution.getByRole('button', { name: '核对申请入口', exact: true }).click()
    await expect.poll(() => contribution.getByRole('combobox', { name: '贡献来源', exact: true }).inputValue())
      .toBe('tool-observations')
    expect(await contribution.getByLabel('API 文件', { exact: true }).count()).toBe(0)
    await contribution.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(root)
    await contribution.getByLabel('授权有效期（小时）', { exact: true }).fill('2')
    await contribution.getByLabel('最多样本数', { exact: true }).fill('4')
    await contribution.getByLabel('每份样本字节上限', { exact: true }).fill('4096')
    await contribution.getByRole('button', { name: '申请并在批准后启用', exact: true }).click()
    await contribution.getByRole('status').getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
    const pending = await toolSource.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: sourceSession.sessionKey })
    if (pending.capture === null || pending.capture.application === null) throw new Error('Directory application was not retained')
    expect(pending.capture.source).toEqual({ kind: 'tool-observations', tools: ['Edit', 'Write'] })
    expect(pending.capture.roots).toHaveLength(1)
    expect(pending.capture.proposalText).not.toContain(root)
    expect(pending.capture.proposalText).not.toContain(session)
    const replacements: (readonly [string, string])[] = [
      [toolTask.id, '{{taskId}}'], [entry.entryId, '{{entryId}}'], [entry.ownerPeerId, '{{ownerPeerId}}'],
      [entry.ownerAddress, '{{ownerAddress}}'], [String(entry.expiresAt), '{{entryExpiresAt}}'],
      [await owner.page.evaluate(value => new Date(value).toLocaleString(), entry.expiresAt), '{{entryExpiresLocal}}'],
      [await owner.page.evaluate(value => new Date(value).toLocaleString(), pending.capture.application.limits.expiresAt),
        '{{permissionExpiresLocal}}'],
      [pending.capture.proposal.contributorPeerId, '{{contributorPeerId}}'],
    ]
    await captureContributionPanel(toolSource, SOURCE, join(SNAPSHOTS, 'source-tool-waiting.expected.md'),
      replacements, process.env.DSH_ONLINE_CONTRIBUTION_SHOTS)
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await captureContributionPanel(owner, OWNER, join(SNAPSHOTS, 'owner-tool-pending.expected.md'),
      replacements, process.env.DSH_ONLINE_CONTRIBUTION_SHOTS)
    await toolSource.page.close()
    await applications.getByRole('button', { name: '批准并让来源自动启用', exact: true }).click()
    await expect.poll(async () => (await toolSource.scaffold.ctx.claudeScope.contributionDetail({
      sessionKey: sourceSession.sessionKey,
    })).session.contributionState, { timeout: 15_000 }).toBe('active')
    const active = await toolSource.scaffold.ctx.claudeScope.contributionDetail({ sessionKey: sourceSession.sessionKey })
    if (active.capture?.invitation == null) throw new Error('Directory contribution was not activated')
    const grant = active.capture.invitation.grant
    expect(grant.source).toEqual({ kind: 'tool-observations', name: 'session-work', tools: ['Edit', 'Write'] })
    expect(JSON.stringify(grant)).not.toContain(root)

    await connectFreshWorkspaceZh(toolReceiver.page, toolReceiver.scaffold.workspaceCwd, 'directory-contribution-recipient')
    const composer = toolReceiver.page.locator('[data-composer-input][contenteditable="true"]').last()
    const initialTurn = toolReceiver.scaffold.whenTurnSettled(30_000)
    await composer.fill('DIRECTORY_USER: 开始维护代码与文档。')
    await composer.press('Enter')
    const receiverSession = await initialTurn
    expectCompleted(toolReceiver.scaffold, receiverSession, ['DIRECTORY_CONTRIBUTION_RESULT_1'])
    expect(requests[requestOffset]!.filter(message => message.source.kind === 'scope-agent-context')).toEqual([])
    const identity = await toolReceiver.scaffold.ctx.scopeAccess.identity()
    expect(new Set([entry.ownerPeerId, grant.contributorPeerId, identity.peerId]).size).toBe(3)
    await access.getByLabel('接收设备身份', { exact: true }).fill(identity.peerId)
    await access.getByLabel('此会话的职责', { exact: true }).fill('维护重试实现与使用文档')
    await access.getByRole('button', { name: '生成只读邀请', exact: true }).click()
    const readField = access.getByRole('textbox', { name: '将此邀请交给接收人', exact: true })
    await expect.poll(() => readField.inputValue()).toContain(toolTask.id)
    await toolReceiver.page.getByRole('button', { name: '协作', exact: true }).click()
    const native = toolReceiver.page.locator('[data-native-scope-panel]')
    await native.getByLabel('粘贴只读邀请', { exact: true }).fill(await readField.inputValue())
    await native.getByRole('button', { name: '连接此会话', exact: true }).click()
    await expect.poll(async () => {
      const status = await toolReceiver.scaffold.ctx.scopeAgentContext.status({ agentId: receiverSession })
      return status.eligibility === 'not-live' ? undefined : status.state.mode
    }).toBe('passive')
    await toolReceiver.page.keyboard.press('Escape')
    const write = { session_id: session, cwd: toolSource.scaffold.workspaceCwd, tool_name: 'Write',
      tool_use_id: randomUUID(), tool_input: { file_path: codePath, content: code } }
    await contributionHook(toolSource.scaffold, generation, { ...write, hook_event_name: 'PreToolUse' })
    await writeFile(codePath, code)
    expect((await contributionHook(toolSource.scaffold, generation, { ...write, hook_event_name: 'PostToolUse' }))
      .receipt.status).toBe('published')
    const edit = { session_id: session, cwd: toolSource.scaffold.workspaceCwd, tool_name: 'Edit',
      tool_use_id: randomUUID(), tool_input: { file_path: documentPath, old_string: oldDocument,
        new_string: newDocument, replace_all: false } }
    await contributionHook(toolSource.scaffold, generation, { ...edit, hook_event_name: 'PreToolUse' })
    await writeFile(documentPath, newDocument)
    expect((await contributionHook(toolSource.scaffold, generation, { ...edit, hook_event_name: 'PostToolUse' }))
      .receipt.status).toBe('published')
    const publications = owner.scaffold.ctx.developmentTasks.get({ taskId: toolTask.id }).context
      .filter(item => item.peerToolObservation !== undefined)
    expect(publications).toHaveLength(2)
    expect(publications.map(item => item.peerToolObservation)).toMatchObject([
      { tool: 'Write', reportedStatus: 'success', observerPeerId: grant.contributorPeerId, grantId: grant.grantId,
        fields: { rootIndex: 0, path: 'code/retry.ts', content: code }, omissions: [] },
      { tool: 'Edit', reportedStatus: 'success', observerPeerId: grant.contributorPeerId, grantId: grant.grantId,
        fields: { rootIndex: 0, path: 'docs/coordination.md', oldString: oldDocument, newString: newDocument,
          replaceAll: false }, omissions: [] },
    ])
    const observedTurn = toolReceiver.scaffold.whenTurnSettled(30_000)
    await composer.fill('DIRECTORY_USER: 继续工作，使用已经到达的共享观察。')
    await composer.press('Enter')
    expect(await observedTurn).toBe(receiverSession)
    expect(requests).toHaveLength(requestOffset + 2)
    expectCompleted(toolReceiver.scaffold, receiverSession, ['DIRECTORY_CONTRIBUTION_RESULT_1', 'DIRECTORY_CONTRIBUTION_RESULT_2'])
    const observations = contextText(requests[requestOffset + 1]!)
    expect(observations).toContain('CODE_CHANGE_retryLimit')
    expect(observations).toContain(newDocument)
    const rendered = renderedPublications(observations)
    expect(rendered).toEqual(publications.map(publication => ({ id: publication.id, text: publication.text })))
    const reportText = rendered.map(publication => publication.text).join('\n')
    expect(reportText).toContain('"path":"code/retry.ts"')
    expect(reportText).toContain('"path":"docs/coordination.md"')
    expect(reportText).toContain(`"observerPeerId":"${grant.contributorPeerId}"`)
    expect(observations).toContain('not a current file snapshot')
    expect(observations).not.toContain('onlineOrderCode')
    expect(observations).not.toContain(root)
    for (const publication of publications) expect(observations).toContain(publication.id)

    await owned.getByRole('button', { name: '撤销贡献', exact: true }).click()
    await owned.getByText('贡献授权已撤销', { exact: true }).waitFor()
    const terminal = owner.scaffold.ctx.developmentTasks.get({ taskId: toolTask.id }).context
      .find(item => item.peerContribution?.grant.grantId === grant.grantId && item.peerContribution.ended === 'revoked')
    if (terminal === undefined) throw new Error('Owner revocation was not persisted')
    const withdrawnTurn = toolReceiver.scaffold.whenTurnSettled(30_000)
    await composer.fill('DIRECTORY_USER: 撤权后继续工作。')
    await composer.press('Enter')
    expect(await withdrawnTurn).toBe(receiverSession)
    expect(requests).toHaveLength(requestOffset + 3)
    expectCompleted(toolReceiver.scaffold, receiverSession, [
      'DIRECTORY_CONTRIBUTION_RESULT_1', 'DIRECTORY_CONTRIBUTION_RESULT_2', 'DIRECTORY_CONTRIBUTION_RESULT_3',
    ])
    const withdrawn = contextText(requests[requestOffset + 2]!)
    expect(withdrawn).toContain(terminal.id)
    expect(withdrawn).toContain('"ended":"revoked"')
    expect(withdrawn).toContain('"withdrawnOmissions":2')
    expect(withdrawn).not.toContain('CODE_CHANGE_retryLimit')
    expect(withdrawn).not.toContain(newDocument)
    expect(withdrawn).not.toContain('onlineOrderCode')
    expect(toolSource.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(toolReceiver.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    const events = toolReceiver.scaffold.ctx.agents.get(receiverSession)!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(0)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    expect(toolSource.page.isClosed()).toBe(true)
    for (const view of views) {
      expect(view.errors).toEqual([])
      expect(view.tripwire.warnings).toEqual([])
      expect(view.tripwire.pageErrors).toEqual([])
    }
  }, 180_000)

  it('keeps the online flow snapshots in the owner-local inventory', async () => {
    await assertFixtureInventory(SNAPSHOTS, [
      'source-waiting.expected.md', 'owner-pending.expected.md',
      'source-tool-waiting.expected.md', 'owner-tool-pending.expected.md',
    ])
  })
})
