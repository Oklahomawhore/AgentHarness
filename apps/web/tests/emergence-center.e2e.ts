// Keyless browser acceptance for the shipped context-only Emergence Center.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import type { Browser, ConsoleMessage, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { DevelopmentNodeId, DevelopmentParticipantId, DevelopmentTaskBindingId } from '@deepseek-ai/dsh-development-task'
import type {} from '@deepseek-ai/dsh-claude-scope'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/emergence-center', import.meta.url))
const CREATED_EXPECTED = join(SNAPSHOT_DIR, 'created.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Emergence Center shared-context journey', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ hermeticMcpClients: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    const collaborationUrl = new URL(scaffold.authenticatedUrl)
    collaborationUrl.hash = 'agentharness=collaboration'
    await page.goto(collaborationUrl.href, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('creates, publishes, forks, and merges context without lifecycle controls', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-emergence-center-context'))
    const panel = page.locator('[data-emergence-center]')
    await panel.waitFor({ timeout: 10_000 })
    await panel.getByText('这里还没有本地 Task。可从顶部新建 Task 来管理共享上下文；向其他人的 Task 贡献工作变化无需新建。').first().waitFor({ timeout: 10_000 })

    const graph = panel.getByRole('main', { name: '任务有向无环谱系图' })
    await graph.getByRole('button', { name: '放大图谱' }).waitFor()
    await graph.getByRole('button', { name: '缩小图谱' }).waitFor()
    expect(await graph.locator('.react-flow__attribution').count()).toBe(0)
    expect(await graph.locator('.react-flow__minimap').count()).toBe(0)

    await panel.getByLabel('协作显示名').fill('浏览器验收用户')
    await panel.getByRole('button', { name: '保存身份' }).click()
    await panel.getByRole('status').getByText('协作身份已生效：浏览器验收用户').waitFor({ timeout: 10_000 })

    const createTask = panel.getByRole('button', { name: '新建任务', exact: true })
    expect(await createTask.count()).toBe(1)
    await createTask.click()
    await panel.getByText('创建一份独立共享上下文').waitFor()
    await panel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = panel.locator('form').filter({ has: page.getByLabel('Task 名称') })
    const submit = form.getByRole('button', { name: '创建任务' })
    expect(await submit.isDisabled()).toBe(true)
    await form.getByText('填写显示名、Task 名称和初始共享上下文即可创建；没有阶段或验收门禁。').waitFor()
    await form.getByLabel('Task 名称').fill('网页共享上下文验收')
    await form.getByLabel('初始共享上下文').fill('验证身份、远程调用、持久化和任务图。')
    await expect.poll(() => submit.isEnabled(), { timeout: 5_000 }).toBe(true)
    await submit.click()

    await form.waitFor({ state: 'detached', timeout: 15_000 })
    await panel.getByRole('heading', { name: '网页共享上下文验收' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => graph.locator('.react-flow__node').count(), { timeout: 10_000 }).toBe(1)
    const rootTask = scaffold.ctx.developmentTasks.list({ limit: 200 })[0]
    if (rootTask === undefined) throw new Error('expected the Root Task to be persisted')
    expect(rootTask).toMatchObject({
      objective: '网页共享上下文验收',
      scope: '验证身份、远程调用、持久化和任务图。',
      origin: { kind: 'root' },
      revision: 1,
    })
    expect(typeof rootTask.createdBy).toBe('string')
    expect(rootTask).not.toHaveProperty('stage')
    expect(rootTask).not.toHaveProperty('evidence')
    expect(rootTask).not.toHaveProperty('approval')

    const agentHub = panel.getByRole('region', { name: '让 Agent Session 加入当前 Task' })
    await agentHub.waitFor()
    expect(await panel.getByRole('tab').count()).toBe(0)
    expect(await agentHub.textContent()).toContain('Claude 会话可在下方单独加入')
    expect(await agentHub.textContent()).toContain('agentharness_task_connect')
    const clients = (await scaffold.ctx.mcpClientSetup.list()).clients
    expect(clients.filter(client => client.detected).map(client => [client.id, client.state]))
      .toEqual([['cursor', 'not-configured'], ['doubao', 'manual']])
    expect(await panel.textContent()).not.toContain('提交计划')
    expect(await panel.textContent()).not.toContain('审计')

    const publication = '后续 Task 必须继承这个显式结论。'
    await panel.getByPlaceholder('发布可被后续派生或汇合任务继承的上下文；不要填写私聊或内部推理。').fill(publication)
    await panel.getByRole('button', { name: '发布上下文' }).click()
    await panel.getByText(publication, { exact: true }).waitFor({ timeout: 10_000 })
    if (process.env.AGENTHARNESS_CAPTURE_README_SCREENSHOT === '1') {
      await page.screenshot({ path: join(process.cwd(), 'assets/agentharness-collaboration.png'), fullPage: true })
    }
    await expect.poll(() => scaffold.ctx.developmentTasks.get({ taskId: rootTask.id }).revision).toBe(2)
    const rootHead = scaffold.ctx.developmentTasks.get({ taskId: rootTask.id })

    const selectTask = async (objective: string): Promise<void> => {
      await panel.locator('button', { hasText: objective }).first().click()
      await panel.getByRole('heading', { name: objective }).waitFor({ timeout: 10_000 })
    }
    const createChild = async (objective: string): Promise<void> => {
      const currentForm = panel.locator('form').filter({ has: page.getByLabel('Task 名称') })
      await currentForm.getByLabel('Task 名称').fill(objective)
      await currentForm.getByLabel('初始共享上下文').fill(`${objective}的增量上下文。`)
      await currentForm.getByRole('button', { name: '创建任务' }).click()
      await currentForm.waitFor({ state: 'detached', timeout: 15_000 })
      await panel.getByRole('heading', { name: objective }).waitFor({ timeout: 10_000 })
    }

    await createTask.click()
    await panel.getByRole('button', { name: '从当前任务派生', exact: true }).click()
    await panel.getByText('继承“网页共享上下文验收”的当前版本').waitFor()
    await createChild('网页派生任务一')
    const forkOne = scaffold.ctx.developmentTasks.list({ limit: 200 }).find(task => task.objective === '网页派生任务一')!

    await selectTask('网页共享上下文验收')
    await createTask.click()
    await panel.getByRole('button', { name: '从当前任务派生', exact: true }).click()
    await createChild('网页派生任务二')
    const forkTwo = scaffold.ctx.developmentTasks.list({ limit: 200 }).find(task => task.objective === '网页派生任务二')!

    await createTask.click()
    await panel.getByRole('button', { name: '汇合多个任务', exact: true }).click()
    await panel.getByLabel('网页派生任务一 · 修订 r1').check()
    await createChild('网页汇合任务')
    const merged = scaffold.ctx.developmentTasks.list({ limit: 200 }).find(task => task.objective === '网页汇合任务')!

    expect(forkOne.origin).toEqual({ kind: 'fork', parent: { taskId: rootTask.id, revision: rootHead.revision } })
    expect(forkTwo.origin).toEqual({ kind: 'fork', parent: { taskId: rootTask.id, revision: rootHead.revision } })
    expect(scaffold.ctx.developmentTasks.contextView(forkOne.id).inherited?.sources[0]?.context)
      .toEqual([expect.objectContaining({ text: publication })])
    expect(merged.origin.kind).toBe('merge')
    if (merged.origin.kind !== 'merge') throw new Error('expected merged Task origin')
    expect(new Set(merged.origin.parents.map(parent => parent.taskId))).toEqual(new Set([forkOne.id, forkTwo.id]))

    await expect.poll(() => graph.locator('.react-flow__node').count(), { timeout: 10_000 }).toBe(4)
    await expect.poll(() => graph.locator('.react-flow__edge').count(), { timeout: 10_000 }).toBe(4)
    const nodeWidths = await graph.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))
    expect(nodeWidths).toHaveLength(4)
    expect(nodeWidths.every(width => width >= 160)).toBe(true)
    expect(await graph.locator('.react-flow__minimap').count()).toBe(1)

    const snapshot = await captureStableAria(page, '[data-emergence-center]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CREATED_EXPECTED, snapshot, MODE)
    expect(consoleErrors.filter(message => /ui-emergence-center|without inject/iu.test(message))).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(process.platform === 'win32')('configures a project and joins only the selected Claude session through the live UI', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-claude-scope-setup'))
    const panel = page.locator('[data-emergence-center]')
    const claude = panel.getByRole('region', { name: 'Claude Code', exact: true })
    const projectPath = join(scaffold.workspaceCwd, 'claude-project')
    await mkdir(projectPath)
    await claude.getByLabel('项目路径', { exact: true }).fill(projectPath)
    await claude.getByRole('button', { name: '检查配置', exact: true }).click()
    await claude.getByText('项目 hooks 未配置', { exact: true }).waitFor()
    await claude.getByRole('button', { name: '配置 hooks', exact: true }).click()
    await claude.getByText('项目 hooks 已配置', { exact: true }).waitFor()
    const settingsPath = join(projectPath, '.claude', 'settings.local.json')
    expect(await readFile(settingsPath, 'utf8')).toContain('UserPromptSubmit')
    expect(await scaffold.ctx.claudeScope.sessions()).toEqual([])

    const descriptor = JSON.parse(await readFile(join(scaffold.harnessHome, 'claude-scope', 'connection.json'), 'utf8')) as { generation: string }
    for (const sessionId of ['browser-claude-a', 'browser-claude-b']) {
      const response = await scaffold.hostFetch('/api/claudeScope/hook', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `observe-${sessionId}`, method: 'claudeScope/hook', payload: { args: { request: {
          generation: descriptor.generation, input: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: projectPath },
        } } } }),
      })
      expect(response.ok).toBe(true)
      expect(await response.json()).toMatchObject({ result: { ok: true, value: { receipt: { status: 'observed' } } } })
    }
    await claude.getByRole('button', { name: '刷新会话' }).click()
    const sessionA = claude.getByRole('radio', { name: /browser-claude-a/u })
    const sessionB = claude.getByRole('radio', { name: /browser-claude-b/u })
    await sessionB.waitFor()
    expect(await sessionA.isChecked()).toBe(false)
    expect(await sessionB.isChecked()).toBe(false)

    const capture = async (stage: string): Promise<void> => {
      const directory = process.env.DSH_CLAUDE_SCOPE_SHOTS
      if (directory === undefined) return
      await mkdir(directory, { recursive: true })
      for (const viewport of [{ width: 1680, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        const focus = stage === 'selected'
          ? claude.getByLabel('此会话的职责')
          : claude.getByRole('group', { name: '选择一个会话' })
        await focus.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(directory, `${stage}-${viewport.width}.png`), fullPage: true })
        const bounds = await claude.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      }
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
    await capture('observed')
    await sessionB.check()
    await claude.getByLabel('此会话的职责').fill('实现后端接口')
    expect(await claude.getByLabel('允许观察的目录（每行一个绝对路径）').inputValue()).toBe(projectPath)
    await capture('selected')
    await claude.getByRole('button', { name: '加入当前 Task', exact: true }).click()
    await claude.getByRole('button', { name: '更新此会话授权' }).waitFor()
    const sessions = await scaffold.ctx.claudeScope.sessions()
    const task = scaffold.ctx.developmentTasks.list({ limit: 200 }).find(item => item.objective === '网页汇合任务')!
    expect(sessions.find(session => session.sessionId === 'browser-claude-a')?.taskId).toBeUndefined()
    expect(sessions.find(session => session.sessionId === 'browser-claude-b')?.taskId).toBe(task.id)
    expect(await sessionA.isChecked()).toBe(false)

    await claude.getByRole('button', { name: '移除项目 hooks' }).click()
    await claude.getByText('项目 hooks 未配置', { exact: true }).waitFor()
    expect((await scaffold.ctx.claudeScope.sessions()).find(session => session.sessionId === 'browser-claude-b')?.taskId).toBe(task.id)
    const leaving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/claudeScope/leave')
    await claude.getByRole('button', { name: '退出 Task', exact: true }).click()
    const leaveReply = await (await leaving).json() as { result: { ok: boolean; error?: { code: string; message: string } } }
    expect(leaveReply.result.ok, JSON.stringify(leaveReply.result.error)).toBe(true)
    expect((await scaffold.ctx.claudeScope.sessions()).every(session => session.taskId === undefined)).toBe(true)
    await claude.getByRole('button', { name: '加入当前 Task', exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('approves and ends one replicated remote binding through generated browser Remotes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-remote-observation-approval'))
    const task = scaffold.ctx.developmentTasks.list({ limit: 200 }).find(item => item.objective === '网页汇合任务')!
    const sourceNodeId = 'browser-source-node' as DevelopmentNodeId
    const participantId = 'browser-source-agent' as DevelopmentParticipantId
    const bindingId = 'browser-source-binding' as DevelopmentTaskBindingId
    const at = Date.now()
    await scaffold.ctx.developmentTasks.acceptAssignmentReplica({
      nodeId: sourceNodeId, seq: 1, at, bindingId, participantId,
      change: { kind: 'task-bound', taskId: task.id, sessionLabel: '远程 API 会话' },
    }, sourceNodeId)
    await scaffold.ctx.developmentRooms.acceptPresenceReplica({
      id: participantId, nodeId: sourceNodeId, kind: 'agent', displayName: '远程 Claude', presence: 'online', lastSeenAt: at,
    }, sourceNodeId)
    const authorization = page.getByRole('region', { name: '远程工作观察授权', exact: true })
    await authorization.getByText('远程 API 会话', { exact: true }).waitFor()
    await authorization.getByText('已连接此 Task，尚未批准工作观察。', { exact: true }).waitFor()
    expect(await scaffold.ctx.developmentTasks.observedIntervals({ taskId: task.id })).toEqual([])
    await authorization.getByRole('button', { name: '允许此绑定共享工作观察', exact: true }).click()
    await authorization.getByText('已允许工作观察', { exact: true }).waitFor()
    const [approved] = await scaffold.ctx.developmentTasks.observedIntervals({ taskId: task.id })
    expect(approved).toMatchObject({ state: 'active', sourceNodeId, participantId, bindingId,
      expectedBindingEpoch: { nodeId: sourceNodeId, seq: 1 } })
    await authorization.getByRole('button', { name: '停止接收此绑定的观察', exact: true }).click()
    await authorization.getByText('已终止此绑定的共享；重新加入需创建新的绑定。', { exact: true }).waitFor()
    const [ended] = await scaffold.ctx.developmentTasks.observedIntervals({ taskId: task.id })
    expect(ended).toMatchObject({ state: 'ended', id: approved!.id })
    expect(await authorization.getByRole('button', { name: '允许此绑定共享工作观察', exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 30_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['created.expected.md'])
  })
})
