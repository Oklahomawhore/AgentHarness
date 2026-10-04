/** Three private Web Hosts exercise contribution onboarding and automatic native context. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { ClaudeScopeHookRequest, ClaudeScopeHookResult } from '@deepseek-ai/dsh-claude-scope'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScopeContributionInvitation, ScopeContributionTransfer, ScopeInvitation } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentBindingStatus } from '@deepseek-ai/dsh-scope-agent-context/types'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOTS = join(import.meta.dirname, 'snapshots/contribution-scope')
const DESKTOP = { width: 1440, height: 1000 }
const NARROW = { width: 390, height: 844 }
const SOURCE = '[data-claude-contribution]'
const OWNER = '[data-scope-contribution-owner]'
const ACCESS = '[data-emergence-center] details:has(> summary:text-is("独立设备协作"))'
const NATIVE = '[data-native-scope-panel]'
const OBJECTIVE = '独立来源的订单接口协作'
const SESSION = 'browser-contribution-backend'
const OTHER_SESSION = 'browser-contribution-unselected'

interface View {
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly tripwire: ReturnType<typeof watchConsole>
  readonly errors: string[]
  readonly injectedFailures: Set<string>
}

function replay(): ReplayOverrideDoc {
  return [1, 2, 3, 4, 5].map(index => ({ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: `CONTRIBUTION_RESULT_${String(index)}` },
    { type: 'block-end', index: 0, block: { type: 'text', text: `CONTRIBUTION_RESULT_${String(index)}` } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }))
}

function declaration(field: string): string {
  return JSON.stringify({ openapi: '3.1.1', info: { title: 'Orders', version: '1' }, paths: {
    '/orders': { post: { operationId: 'createOrder', requestBody: { required: true,
      content: { 'application/json': { schema: { type: 'object', required: [field] } } } },
    responses: { '201': { description: 'Created' } } } },
  } })
}

function textOf(messages: readonly Message[]): string {
  return messages.filter(message => message.source.kind === 'scope-agent-context')
    .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function openView(browser: Browser, scaffold: WebScaffold, collaboration: boolean): Promise<View> {
  const context = await browser.newContext({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
  const page = await context.newPage()
  const tripwire = watchConsole(page)
  const errors: string[] = []
  const injectedFailures = new Set<string>()
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (message.text().includes('net::ERR_FAILED') && injectedFailures.has(new URL(message.location().url, scaffold.baseUrl).pathname)) return
    errors.push(message.text())
  })
  const url = new URL(scaffold.authenticatedUrl)
  if (collaboration) url.hash = 'agentharness=collaboration'
  await page.goto(url.href, { waitUntil: 'load' })
  await page.locator(collaboration ? '[data-emergence-center]' : '[class*="frame"]').first().waitFor({ timeout: 30_000 })
  return { scaffold, page, tripwire, errors, injectedFailures }
}

async function hook(scaffold: WebScaffold, generation: string, input: ClaudeScopeHookRequest['input']): Promise<ClaudeScopeHookResult> {
  const response = await scaffold.hostFetch('/api/claudeScope/hook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'claudeScope/hook', payload: { args: { request: { generation, input } } } }),
  })
  expect(response.ok).toBe(true)
  const body = await response.json() as { result: { ok: true; value: ClaudeScopeHookResult } | { ok: false; error: unknown } }
  if (!body.result.ok) throw new Error(`Hook failed: ${JSON.stringify(body.result.error)}`)
  return body.result.value
}

async function reload(view: View): Promise<void> {
  const previous = view.tripwire.warnings.length
  await view.page.reload({ waitUntil: 'load' })
  await view.page.locator('[data-emergence-center]').waitFor()
  acknowledgeReloadConnectionLoss(view.tripwire, previous)
}

async function dropCommittedReply(view: View, method: string): Promise<{ readonly settled: Promise<void> }> {
  const path = `/api/${method}`
  const pattern = `**${path}`
  view.injectedFailures.add(path)
  const committed = Promise.withResolvers<undefined>()
  await view.page.route(pattern, async (route) => {
    try {
      const response = await route.fetch()
      const body = await response.json() as { result: { ok: boolean } }
      expect(body.result.ok).toBe(true)
      await route.abort('failed')
      committed.resolve(undefined)
    } catch (error) { committed.reject(error) }
  }, { times: 1 })
  return { settled: committed.promise }
}

async function acknowledgeLostReply(view: View, role: 'owner' | 'source'): Promise<void> {
  const prefix = `[ui-emergence-center] ${role} contribution management failed:`
  await expect.poll(() => view.errors.filter(message => message.startsWith(prefix)).length).toBe(1)
  const index = view.errors.findIndex(message => message.startsWith(prefix))
  expect(view.errors[index]).toContain('Failed to fetch')
  view.errors.splice(index, 1)
  await view.page.getByRole('alert').getByText('操作结果尚未确认。请重新读取当前状态后再继续。', { exact: true }).waitFor()
  const refresh = view.page.getByRole('button', { name: role === 'owner' ? '刷新贡献授权' : '重新读取贡献', exact: true })
  await expect.poll(() => refresh.isEnabled()).toBe(true)
}

async function capture(view: View, selector: string, stage: string, replacements: readonly (readonly [string, string])[]): Promise<void> {
  await compareOrRefreshGolden(join(SNAPSHOTS, `${stage}.expected.md`),
    await captureStableAria(view.page, selector, view.scaffold.workspaceCwd, { replacements }), MODE)
  const directory = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
  if (directory !== undefined) await mkdir(directory, { recursive: true })
  for (const viewport of [DESKTOP, NARROW]) {
    await view.page.setViewportSize(viewport)
    const panel = view.page.locator(selector)
    await panel.scrollIntoViewIfNeeded()
    const bounds = await panel.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (directory !== undefined) await view.page.screenshot({ path: join(directory, `${stage}-${String(viewport.width)}.png`), fullPage: true })
  }
  await view.page.setViewportSize(DESKTOP)
}

describe.skipIf(process.platform === 'win32')('web e2e: independent source contribution onboarding', () => {
  let ownerHost: WebScaffold | undefined
  let sourceHost: WebScaffold | undefined
  let receiverHost: WebScaffold | undefined
  let browser: Browser | undefined
  let owner: View
  let source: View
  let receiver: View
  let directory: string
  let generation: string
  let filePath: string
  let taskId: DevelopmentTaskId
  let sessionId: SessionId
  const requests: Message[][] = []

  async function state(): Promise<ScopeAgentBindingStatus> {
    const result = await receiver.scaffold.ctx.scopeAgentContext.status({ agentId: sessionId })
    if (result.eligibility === 'not-live') throw new Error('Native recipient is not live')
    return result.state
  }

  async function write(content: string): Promise<void> {
    const input = { session_id: SESSION, cwd: source.scaffold.workspaceCwd, tool_name: 'Write',
      tool_use_id: randomUUID(), tool_input: { file_path: filePath, content } }
    await hook(source.scaffold, generation, { ...input, hook_event_name: 'PreToolUse' })
    await writeFile(filePath, content)
    await hook(source.scaffold, generation, { ...input, hook_event_name: 'PostToolUse' })
  }

  async function automaticUpdate(action: () => Promise<void>, count: number): Promise<void> {
    const settled = receiver.scaffold.whenTurnSettled(30_000)
    await action()
    expect(await settled).toBe(sessionId)
    expect(requests).toHaveLength(count)
  }

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Contribution onboarding acceptance uses keyless controlled model responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-contribution-ui-'))
    const replayOverride = join(directory, 'replay.override.json')
    const overlay = join(directory, 'facts.patch.yml')
    await writeFile(replayOverride, JSON.stringify(replay()))
    await writeFile(overlay, JSON.stringify([
      { id: 'development-task-context-text', disabled: true },
      { insert: [{ id: 'contribution-facts', name: '@deepseek-ai/dsh-development-task-context/facts', config: {
        routes: [{ responsibility: 'frontend', fields: ['requiredRequestFields'] }], unmatchedFields: ['requiredRequestFields'],
      } }] },
    ]))
    // The shipped composition owns private identities, data and authorization on each Host.
    ownerHost = await launchWebScaffold({ hermeticMcpClients: true, extraOverlayPath: overlay })
    sourceHost = await launchWebScaffold({ hermeticMcpClients: true })
    receiverHost = await launchWebScaffold({ hermeticMcpClients: true, replayFixture: join(directory, 'override-only.jsonl'), replayOverride, paceMs: 5 })
    receiverHost.ctx.on('llm/stream', (options, next) => { requests.push(structuredClone(options.messages)); return next() })
    expect(new Set([ownerHost.harnessHome, sourceHost.harnessHome, receiverHost.harnessHome]).size).toBe(3)
    browser = await chromium.launch()
    owner = await openView(browser, ownerHost, true)
    source = await openView(browser, sourceHost, true)
    receiver = await openView(browser, receiverHost, false)
    filePath = join(sourceHost.workspaceCwd, 'openapi.json')
    await writeFile(filePath, declaration('not-yet-shared'))
    const descriptor = JSON.parse(await readFile(join(sourceHost.harnessHome, 'claude-scope/connection.json'), 'utf8')) as { generation: string }
    generation = descriptor.generation
    if (MODE === 'refresh') await mkdir(SNAPSHOTS, { recursive: true })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => receiverHost?.close(), () => sourceHost?.close(), () => ownerHost?.close(),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Contribution onboarding cleanup failed')
  })

  it('recovers preparation and lost approval/stop replies while ordinary file work reaches the recipient', async () => {
    onTestFailed(async () => {
      for (const view of [owner, source, receiver]) {
        const role = view === owner ? 'owner' : view === source ? 'source' : 'receiver'
        await saveFailureShot(view.page, `web-e2e-contribution-${role}`)
        console.error('contribution acceptance diagnostics', { role, errors: view.errors,
          warnings: view.tripwire.warnings, pageErrors: view.tripwire.pageErrors,
          aria: await view.page.locator('body').ariaSnapshot() })
      }
    })
    const sourcePanel = source.page.locator('[data-emergence-center]')
    expect(source.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    await sourcePanel.getByLabel('项目路径', { exact: true }).fill(source.scaffold.workspaceCwd)
    await sourcePanel.getByRole('button', { name: '配置 hooks', exact: true }).click()
    await sourcePanel.getByText('项目 hooks 已配置', { exact: true }).waitFor()
    for (const externalId of [SESSION, OTHER_SESSION]) {
      expect((await hook(source.scaffold, generation, { hook_event_name: 'SessionStart', session_id: externalId, cwd: source.scaffold.workspaceCwd })).receipt.status).toBe('observed')
    }
    await sourcePanel.getByRole('button', { name: '刷新会话', exact: true }).click()
    await sourcePanel.getByRole('radio', { name: new RegExp(SESSION) }).check()
    let contribution = source.page.locator(SOURCE)
    await contribution.getByRole('combobox', { name: '贡献来源', exact: true }).selectOption('openapi')
    await contribution.getByLabel('API 文件', { exact: true }).fill(filePath)
    await contribution.getByLabel('来源名称', { exact: true }).fill('Orders')
    await contribution.getByRole('combobox', { name: 'HTTP 方法', exact: true }).selectOption('post')
    await contribution.getByLabel('API 路径', { exact: true }).fill('/orders')
    await contribution.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(source.scaffold.workspaceCwd)
    await contribution.locator('[data-contribution-manual-source] > summary').click()
    await contribution.getByRole('button', { name: '准备贡献申请', exact: true }).click()
    const proposalText = await contribution.getByRole('textbox', { name: '将申请交给任务所有者', exact: true }).inputValue()
    expect(proposalText).not.toContain(source.scaffold.workspaceCwd)
    expect(proposalText).not.toContain(SESSION)
    const summaries = await source.scaffold.ctx.claudeScope.sessions()
    expect(summaries.find(item => item.sessionId === OTHER_SESSION)?.contributionState).toBeUndefined()
    const sourceSession = summaries.find(item => item.sessionId === SESSION)!
    await expect.poll(() => contribution.getByRole('button', { name: '重新读取贡献', exact: true }).isEnabled()).toBe(true)
    await reload(source)
    await source.page.getByRole('radio', { name: new RegExp(SESSION) }).check()
    contribution = source.page.locator(SOURCE)
    await expect.poll(() => contribution.getByRole('textbox', { name: '将申请交给任务所有者', exact: true }).inputValue()).toBe(proposalText)
    const proposal = JSON.parse(proposalText) as ScopeContributionTransfer
    if (proposal.kind !== 'openapi-contribution-request') throw new Error('Source did not prepare a contribution request')
    await capture(source, SOURCE, 'source-prepared', [[proposal.proposal.contributorPeerId, '{{contributorPeerId}}']])

    const ownerPanel = owner.page.locator('[data-emergence-center]')
    await ownerPanel.getByLabel('协作显示名').fill('Contribution Owner')
    await ownerPanel.getByRole('button', { name: '保存身份', exact: true }).click()
    await ownerPanel.getByRole('status').getByText('协作身份已生效：Contribution Owner', { exact: true }).waitFor()
    await ownerPanel.getByRole('button', { name: '新建任务', exact: true }).click()
    await ownerPanel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = ownerPanel.locator('form').filter({ has: owner.page.getByLabel('Task 名称') })
    await form.getByLabel('Task 名称').fill(OBJECTIVE)
    await form.getByLabel('初始共享上下文').fill('后端维护 Orders，前端使用已授权的当前声明。')
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    await ownerPanel.getByRole('heading', { name: OBJECTIVE, exact: true }).waitFor()
    taskId = owner.scaffold.ctx.developmentTasks.list({ limit: 200 }).find(task => task.objective === OBJECTIVE)!.id
    const access = owner.page.locator(ACCESS)
    await access.locator(':scope > summary').click()
    let approval = owner.page.locator(OWNER)
    await approval.locator(':scope > summary').click()
    await approval.locator('[data-contribution-manual-owner] > summary').click()
    await approval.getByRole('textbox', { name: '粘贴贡献申请', exact: true }).fill(proposalText)
    await approval.getByRole('button', { name: '核对申请', exact: true }).click()
    const approve = approval.getByRole('button', { name: '批准贡献', exact: true })
    await approval.getByLabel('授权有效期（小时）', { exact: true }).fill('1')
    await approval.getByLabel('最多样本数', { exact: true }).fill('8')
    await approval.getByLabel('每份样本字节上限', { exact: true }).fill('4096')
    await expect.poll(() => approve.isEnabled()).toBe(true)
    const approvalLost = await dropCommittedReply(owner, 'scopeAccess/approveContribution')
    await approve.click()
    await approvalLost.settled
    await acknowledgeLostReply(owner, 'owner')
    await expect.poll(() => owner.scaffold.ctx.developmentTasks.peerContributions({ taskId }).length).toBe(1)
    const originalGrant = owner.scaffold.ctx.developmentTasks.peerContributions({ taskId })[0]!.grant
    await reload(owner)
    await owner.page.locator(ACCESS).locator(':scope > summary').click()
    approval = owner.page.locator(OWNER)
    await approval.locator(':scope > summary').click()
    await approval.getByRole('button', { name: '恢复邀请', exact: true }).click()
    const invitationText = await approval.getByRole('textbox', { name: '将邀请交给来源用户', exact: true }).inputValue()
    const invitation = JSON.parse(invitationText) as ScopeContributionInvitation
    expect(invitation.grant).toEqual(originalGrant)
    expect(owner.scaffold.ctx.developmentTasks.peerContributions({ taskId })).toHaveLength(1)
    const expiryLabel = await owner.page.evaluate(timestamp => new Date(timestamp).toLocaleString(), originalGrant.expiresAt)
    const replacements = [[expiryLabel, '{{expiresLocal}}'], [originalGrant.grantId, '{{grantId}}'],
      [originalGrant.generation, '{{generation}}'], [originalGrant.captureId, '{{captureId}}'],
      [originalGrant.captureGeneration, '{{captureGeneration}}'], [taskId, '{{taskId}}'],
      [invitation.ownerAddress, '{{ownerAddress}}'], [invitation.grant.ownerPeerId, '{{ownerPeerId}}'],
      [invitation.grant.contributorPeerId, '{{contributorPeerId}}'], [String(invitation.grant.expiresAt), '{{expiresAt}}']] as const
    await capture(owner, OWNER, 'owner-approved', replacements)
    await contribution.getByRole('textbox', { name: '粘贴贡献邀请', exact: true }).fill(invitationText)
    await contribution.getByRole('button', { name: '核对邀请', exact: true }).click()
    await contribution.getByRole('button', { name: '启用贡献', exact: true }).click()
    await expect.poll(async () => (await source.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionKey === sourceSession.sessionKey)?.contributionState, { timeout: 10_000 }).toBe('active')
    expect(owner.scaffold.ctx.developmentTasks.get({ taskId }).context.filter(item => item.peerObservation !== undefined)).toHaveLength(0)
    await contribution.getByText('贡献已启用', { exact: true }).waitFor()
    await capture(source, SOURCE, 'source-active', replacements)

    // The receiver joins using its existing UI. It owns no local Task replica.
    await connectFreshWorkspaceZh(receiver.page, receiver.scaffold.workspaceCwd, 'contribution-native-receiver')
    const firstTurn = receiver.scaffold.whenTurnSettled(30_000)
    const composer = receiver.page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill('CONTRIBUTION_USER: 开始前端工作。')
    await composer.press('Enter')
    sessionId = await firstTurn
    expect(requests).toHaveLength(1)
    await receiver.page.getByRole('button', { name: '协作', exact: true }).click()
    const native = receiver.page.locator(NATIVE)
    const identityPage = await receiver.page.context().newPage()
    await identityPage.goto(`${receiver.scaffold.baseUrl}/#agentharness=collaboration`, { waitUntil: 'load' })
    await identityPage.locator(ACCESS).locator(':scope > summary').click()
    const recipientPeerId = await identityPage.locator(ACCESS).getByRole('textbox', { name: '本机设备身份', exact: true }).inputValue()
    await identityPage.close()
    await access.getByLabel('接收设备身份', { exact: true }).fill(recipientPeerId)
    await access.getByLabel('此会话的职责', { exact: true }).fill('frontend')
    await access.getByRole('button', { name: '生成只读邀请', exact: true }).click()
    const readText = await access.getByRole('textbox', { name: '将此邀请交给接收人', exact: true }).inputValue()
    const readInvitation = JSON.parse(readText) as ScopeInvitation
    expect(readInvitation.taskId).toBe(taskId)
    await native.getByLabel('粘贴只读邀请', { exact: true }).fill(readText)
    await native.getByRole('button', { name: '连接此会话', exact: true }).click()
    await expect.poll(async () => (await state()).mode).toBe('passive')
    await write(declaration('sku'))
    await native.getByRole('radio', { name: '允许自动协作', exact: true }).check()
    await native.getByLabel('本地协作目标', { exact: true }).fill('依据当前订单声明更新前端。')
    await native.getByLabel('允许新增的自动启动次数', { exact: true }).fill('4')
    await native.getByLabel('每轮最多步数', { exact: true }).fill('1')
    await native.getByLabel('最短间隔（秒）', { exact: true }).fill('0')
    await automaticUpdate(() => native.getByRole('button', { name: '确认启用自动协作', exact: true }).click(), 2)
    expect(textOf(requests.at(-1)!)).toContain('"requiredRequestFields":["sku"]')
    await write(declaration('sku'))
    const unchangedRevision = owner.scaffold.ctx.developmentTasks.get({ taskId }).revision
    await expect.poll(() => receiver.scaffold.ctx.agents.get(sessionId)!.session.snapshotEvents().some(event =>
      event.type === 'scope-agent-context/evaluation' && event.data.projection.taskRevision === unchangedRevision
      && event.data.decision === 'suppress-unchanged')).toBe(true)
    expect(requests).toHaveLength(2)
    expect((await state()).usedBudget).toBe(1)
    await automaticUpdate(() => write(declaration('customerCode')), 3)
    expect(textOf(requests.at(-1)!)).toContain('"requiredRequestFields":["customerCode"]')
    expect(textOf(requests.at(-1)!)).not.toContain('"sku"')
    await automaticUpdate(() => write('{invalid JSON'), 4)
    expect(textOf(requests.at(-1)!)).toContain('"evidence":"unavailable"')
    expect(textOf(requests.at(-1)!)).not.toContain('customerCode')
    const stopLost = await dropCommittedReply(source, 'claudeScope/contributionLeave')
    await automaticUpdate(async () => {
      await contribution.getByRole('button', { name: '停止贡献', exact: true }).click()
      await stopLost.settled
      await acknowledgeLostReply(source, 'source')
    }, 5)
    await reload(source)
    await source.page.getByRole('radio', { name: new RegExp(SESSION) }).check()
    await source.page.locator(SOURCE).getByText('尚未启用贡献', { exact: true }).waitFor()
    const stopped = (await source.scaffold.ctx.claudeScope.sessions()).find(item => item.sessionKey === sourceSession.sessionKey)
    expect(stopped?.contributionState).toBeUndefined()
    expect(owner.scaffold.ctx.developmentTasks.peerContributions({ taskId })).toMatchObject([{ grant: originalGrant, state: 'ended', reason: 'left' }])
    expect(textOf(requests.at(-1)!)).toContain('"state":"revoked"')
    expect(textOf(requests.at(-1)!)).toContain('"reason":"grant-ended"')
    expect(textOf(requests.at(-1)!)).toContain('"ended":"left"')
    expect(textOf(requests.at(-1)!)).not.toContain('customerCode')
    expect((await state())).toMatchObject({ mode: 'paused', pauseReason: 'budget', usedBudget: 4 })
    expect(source.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(receiver.scaffold.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    const events = receiver.scaffold.ctx.agents.get(sessionId)!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(4)
    for (const view of [owner, source, receiver]) {
      expect(view.errors).toEqual([])
      expect(view.tripwire.warnings).toEqual([])
      expect(view.tripwire.pageErrors).toEqual([])
    }
  }, 180_000)

  it('keeps every owner-local browser expected output in its inventory', async () => {
    await assertFixtureInventory(SNAPSHOTS, ['source-prepared.expected.md', 'owner-approved.expected.md', 'source-active.expected.md'])
  })
})
