/** A live native Session recovers both original permissions after its independent owner changes listener. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { peerContributionSampleSchema } from '@deepseek-ai/dsh-development-task/schema'
import { contributionEntrySchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentContributionCapture } from '@deepseek-ai/dsh-scope-agent-contribution/types'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-access'
import type {} from '@deepseek-ai/dsh-development-task'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  readPersistedEvents, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { openContributionView, type ContributionView } from './contribution-scope-support.ts'
import { connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const PASSIVE_SNAPSHOTS = join(import.meta.dirname, 'expected/native-passive-read-issues')
const OBJECTIVE = '保留原权限恢复同一所有者的连接'
const SHARING = '[data-native-contribution]'
const PANEL = '[data-native-scope-panel]'
const BEFORE = 'OWNER_BEFORE_ROUTE: retry remains bounded.'
const AFTER = 'OWNER_AFTER_ROUTE: the new owner listener is active.'
const STOPPED = 'OWNER_AFTER_SHARING_STOP: reading is separately authorized.'
const SOURCE_CODE = 'export const capturedBeforeRecovery = 13;\n'
const cleanup: (() => Promise<unknown>)[] = []
const failureEvidence: (() => Promise<void>)[] = []

function reportFailure(error: unknown): void {
  console.error(error)
  if (error instanceof AggregateError) for (const cause of error.errors) reportFailure(cause)
}

afterEach(async ({ task }) => {
  const failures: unknown[] = []
  const diagnostics = failureEvidence.splice(0)
  if (task.result?.state === 'fail') for (const diagnose of diagnostics) {
    try { await diagnose() } catch (error) { failures.push(error) }
  }
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { reportFailure(error); failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Scope route browser cleanup failed')
}, 120_000)

function reply(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function tool(id: string, name: 'read' | 'write' | 'edit', args: Record<string, string>): StreamChunk[] {
  const callId = ToolCallId(id)
  const json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function scopeMessages(messages: readonly Message[]): Message[] {
  return messages.filter(message => message.source.kind === 'scope-agent-context')
}
function text(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
async function sharing(view: ContributionView): Promise<Locator> {
  if (!await view.page.locator(PANEL).isVisible()) await view.page.getByRole('button', { name: '协作', exact: true }).click()
  const result = view.page.locator(SHARING)
  if (await result.getAttribute('open') === null) await result.locator(':scope > summary').click()
  return result
}
async function applications(view: ContributionView): Promise<Locator> {
  const access = view.page.locator('[data-emergence-center] details:has(> summary:text-is("独立设备协作"))')
  if (await access.getAttribute('open') === null) await access.locator(':scope > summary').click()
  const owner = view.page.locator('[data-scope-contribution-owner]')
  if (await owner.getAttribute('open') === null) await owner.locator(':scope > summary').click()
  return owner.locator('[data-contribution-applications]')
}

async function captureRoute(view: ContributionView, selector: string, stage: string): Promise<void> {
  const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
  if (shots !== undefined) await mkdir(shots, { recursive: true })
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await view.page.setViewportSize(viewport)
    const panel = view.page.locator(PANEL)
    await expect.poll(async () => {
      const bounds = await panel.boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
    }).toBe(true)
    expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const route = view.page.locator(selector)
    await route.getByRole('button', { name: '保存恢复地址', exact: true }).scrollIntoViewIfNeeded()
    expect(await route.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (shots !== undefined) await view.page.screenshot({ path: join(shots, `${stage}-${String(viewport.width)}.png`), fullPage: true })
  }
  await view.page.setViewportSize({ width: 1440, height: 1000 })
}

// Hold the stopped owner's actual old port until its replacement listener is ready.
async function occupy(address: string): Promise<() => Promise<void>> {
  const match = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)\/p2p\/[^/]+$/u.exec(address)
  if (match === null) throw new Error('Route recovery requires an allocated IPv4 loopback listener')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.destroy()
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) { resolve(); return }
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    return closing
  }
  cleanup.push(close)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: Number(match[1]) }, () => { server.off('error', reject); resolve() })
  })
  return close
}

async function scenario(responses: readonly StreamChunk[][]) {
  if (MODE === 'record') throw new Error('Route recovery uses controlled keyless replies, never a live model')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-scope-route-web-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const replayOverride = join(directory, 'source.override.json')
  const script: ReplayOverrideDoc = [reply('SOURCE_READY'), ...responses].map(chunks => ({ kind: 'chunks', chunks }))
  await writeFile(replayOverride, JSON.stringify(script))
  const sourceStorage = join(directory, 'source-storage')
  // Source starts first and remains live. Every owner boot/close is nested inside its environment lifetime.
  const source = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', storageRoot: sourceStorage,
    replayFixture: join(directory, 'override-only.jsonl'), replayOverride, paceMs: 5 })
  cleanup.push(() => source.close())
  const browser: Browser = await chromium.launch()
  cleanup.push(() => browser.close())
  const sourceView = await openContributionView(browser, source, false)
  const views = [sourceView]
  failureEvidence.push(async () => {
    for (const [index, view] of views.entries()) {
      if (view.page.isClosed()) continue
      await saveFailureShot(view.page, `web-e2e-scope-route-${String(index)}`)
      console.error('scope route diagnostic', { index, errors: view.errors, warnings: view.tripwire.warnings,
        pageErrors: view.tripwire.pageErrors, aria: await view.page.locator('body').ariaSnapshot() })
    }
  })
  await connectFreshWorkspaceZh(sourceView.page, source.workspaceCwd, 'route-source')
  const sourceRoot = join(source.workspaceCwd, 'route-source/project')
  await mkdir(sourceRoot, { recursive: true })
  let sessionId: SessionId | undefined
  const requests: { messages: Message[]; events: SessionEvent[] }[] = []
  source.ctx.on('llm/stream', (options, next) => {
    requests.push({ messages: structuredClone(options.messages), events: sessionId === undefined ? []
      : structuredClone([...source.ctx.agents.get(sessionId)!.session.snapshotEvents()]) })
    return next()
  })
  async function prompt(marker: string): Promise<SessionId> {
    if (await sourceView.page.locator(PANEL).isVisible()) await sourceView.page.keyboard.press('Escape')
    const settled = source.whenTurnSettled(30_000)
    const composer = sourceView.page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(`继续当前工作：${marker}`)
    await composer.press('Enter')
    const id = await settled
    if (sessionId !== undefined) expect(id).toBe(sessionId)
    sessionId = id
    await sourceView.page.getByText(marker, { exact: true }).waitFor()
    return id
  }
  const id = await prompt('SOURCE_READY')
  const liveAgent = source.ctx.agents.get(id)
  if (liveAgent === undefined) throw new Error('Source Agent is not live')
  const agent = liveAgent
  const ownerHome = join(directory, 'owner-home')
  const ownerStorage = join(directory, 'owner-storage')
  let owner: WebScaffold | undefined
  let ownerView: ContributionView | undefined
  let ownerRequests = 0
  async function bootOwner(): Promise<void> {
    owner = await launchWebScaffold({ harnessHome: ownerHome, storageRoot: ownerStorage, hermeticMcpClients: true })
    owner.ctx.on('llm/stream', (_options, next) => { ownerRequests++; return next() })
    ownerView = await openContributionView(browser, owner, true)
    views.push(ownerView)
    // Each boot uses a fresh browser origin/profile; announce its human before publishing.
    const panel = ownerView.page.locator('[data-emergence-center]')
    await panel.getByLabel('协作显示名', { exact: true }).fill('Route Owner')
    await panel.getByRole('button', { name: '保存身份', exact: true }).click()
    await panel.getByRole('status').getByText('协作身份已生效：Route Owner', { exact: true }).waitFor()
  }
  async function closeOwner(): Promise<void> {
    const closing = owner
    if (closing === undefined) return
    await ownerView?.page.context().close()
    owner = undefined
    await closing.close()
  }
  cleanup.push(closeOwner)
  await bootOwner()
  const currentOwner = (): WebScaffold => {
    if (owner === undefined) throw new Error('Owner is offline')
    return owner
  }
  const currentOwnerView = (): ContributionView => {
    if (ownerView === undefined) throw new Error('Owner page is absent')
    return ownerView
  }
  const center = currentOwnerView().page.locator('[data-emergence-center]')
  await center.getByRole('button', { name: '新建任务', exact: true }).click()
  await center.getByRole('button', { name: '新建独立任务', exact: true }).click()
  const create = center.locator('form').filter({ has: currentOwnerView().page.getByLabel('Task 名称', { exact: true }) })
  await create.getByLabel('Task 名称', { exact: true }).fill(OBJECTIVE)
  await create.getByLabel('初始共享上下文', { exact: true }).fill(BEFORE)
  await create.getByRole('button', { name: '创建任务', exact: true }).click()
  await create.waitFor({ state: 'detached' })
  const createdTask = currentOwner().ctx.developmentTasks.list({ limit: 200 }).find(item => item.objective === OBJECTIVE)
  if (createdTask === undefined) throw new Error('Owner UI did not create a Task')
  const task = createdTask
  const identity = await currentOwner().ctx.scopeAccess.identity()
  const sourceIdentity = await source.ctx.scopeAccess.identity()
  expect(sourceIdentity.peerId).not.toBe(identity.peerId)
  let address = identity.addresses[0]
  if (address === undefined) throw new Error('Owner has no listener')
  const form = await applications(currentOwnerView())
  await form.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
  await form.getByRole('button', { name: '邀请一个会话加入', exact: true }).click()
  const entryField = form.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
  await expect.poll(() => entryField.inputValue()).toContain('scope-join-entry')
  const entryText = await entryField.inputValue()
  const entry = contributionEntrySchema.parse(JSON.parse(entryText))
  const share = await sharing(sourceView)
  await share.getByRole('textbox', { name: '粘贴协作申请入口', exact: true }).fill(entryText)
  await share.getByRole('button', { name: '验证连接', exact: true }).click()
  await share.getByText(task.id, { exact: true }).waitFor()
  await share.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(sourceRoot)
  for (const name of ['写入文件（write）', '编辑文件（edit）']) await share.getByRole('checkbox', { name, exact: true }).check()
  await share.getByLabel('授权有效期（小时）', { exact: true }).fill('2')
  await share.getByLabel('最多样本数', { exact: true }).fill('8')
  await share.getByLabel('每份样本字节上限', { exact: true }).fill('8192')
  await share.getByRole('checkbox', { name: '我允许分享上述目录中的所选文件操作。任务所有者批准后可自动启用，直到到期或我停止分享。', exact: true }).check()
  await share.getByRole('checkbox', { name: '我允许此会话在工作时接收整个目标的共享上下文；本项本身不允许自动开始新工作。', exact: true }).check()
  await share.getByRole('button', { name: '申请加入并在批准后连接', exact: true }).click()
  await share.getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
  const status = () => source.ctx.scopeAgentContributions.status({ agentId: id })
  const capture = async (): Promise<ScopeAgentContributionCapture> => {
    const value = (await status()).capture
    if (value === null) throw new Error('Original source capture is absent')
    return value
  }
  const original = await capture()
  async function approve(): Promise<void> {
    const approval = await applications(currentOwnerView())
    await approval.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await approval.getByLabel('该会话的协作职责', { exact: true }).fill('继续当前实现并采用所有者的共享说明。')
    await approval.getByRole('button', { name: '批准读取与文件贡献', exact: true }).click()
    const surface = await sharing(sourceView)
    await surface.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    await surface.getByText('此次加入的读取已连接', { exact: true }).waitFor()
  }
  async function restartOwner(): Promise<ScopeContributionEntry> {
    const previous = address
    if (previous === undefined) throw new Error('Missing original owner route')
    await closeOwner()
    const release = await occupy(previous)
    try { await bootOwner() } finally { await release() }
    const restored = await currentOwner().ctx.scopeAccess.identity()
    expect(restored.peerId).toBe(identity.peerId)
    address = restored.addresses[0]
    expect(address).toBeDefined()
    expect(address).not.toBe(previous)
    expect(currentOwner().ctx.developmentTasks.get({ taskId: task.id }).id).toBe(task.id)
    const view = currentOwnerView()
    const panel = view.page.locator('[data-emergence-center]')
    await panel.getByRole('button', { name: '全部', exact: true }).click()
    await panel.locator('button').filter({ has: view.page.locator('strong').filter({ hasText: OBJECTIVE }) }).click()
    await panel.getByRole('heading', { name: OBJECTIVE, exact: true }).waitFor()
    const rows = await applications(view)
    await rows.getByRole('button', { name: '用当前地址恢复入口', exact: true }).click()
    const entryDetails = rows.locator('details:has(> summary:text-is("将此入口交给来源用户"))')
    if (await entryDetails.getAttribute('open') === null) await entryDetails.locator(':scope > summary').click()
    const field = rows.getByRole('textbox', { name: '将此入口交给来源用户', exact: true })
    await expect.poll(() => field.inputValue()).toContain(address!)
    const replacement = contributionEntrySchema.parse(JSON.parse(await field.inputValue()))
    expect(replacement).toEqual({ ...entry, ownerAddress: address })
    return replacement
  }
  async function recover(replacement: ScopeContributionEntry): Promise<void> {
    const sourceState = (await status()).capture?.state
    const ending = sourceState === 'ending'
    const surface = await sharing(sourceView)
    const route = surface.locator('[data-native-contribution-route]')
    if (await route.getAttribute('open') === null) await route.locator(':scope > summary').click()
    await route.getByRole('textbox', { name: '粘贴原入口的恢复内容', exact: true }).fill(JSON.stringify(replacement))
    await route.getByRole('button', { name: '核对恢复内容', exact: true }).click()
    await captureRoute(sourceView, '[data-native-contribution-route]', `${sourceState ?? 'continuation'}-route`)
    await route.getByRole('button', { name: '保存恢复地址', exact: true }).click()
    await expect.poll(async () => {
      const current = await status()
      return current.capture?.entry.ownerAddress === replacement.ownerAddress || (ending && current.capture === null)
    }, { timeout: 15_000 }).toBe(true)
  }
  async function publish(value: string): Promise<void> {
    const panel = currentOwnerView().page.locator('[data-emergence-center]')
    await panel.getByPlaceholder('发布可被后续派生或汇合任务继承的上下文；不要填写私聊或内部推理。', { exact: true }).fill(value)
    await panel.getByRole('button', { name: '发布上下文', exact: true }).click()
    await expect.poll(() => currentOwner().ctx.developmentTasks.get({ taskId: task.id }).context
      .some(item => item.text === value)).toBe(true)
  }
  async function samples() {
    const raw = JSON.parse(await readFile(join(sourceStorage, 'scope_agent_contributions.json'), 'utf8')) as {
      tables: { sessions: Record<string, { samples: readonly { sample: unknown; receipt?: unknown }[] }> }
    }
    const row = raw.tables.sessions[id]
    if (row === undefined) throw new Error('Source row was not durable')
    return row.samples.map(item => ({ sample: peerContributionSampleSchema.parse(item.sample), receipt: item.receipt }))
  }
  async function proof(marker: string, absent = false): Promise<void> {
    const latest = requests.at(-1)
    if (latest === undefined || latest.events.length === 0) throw new Error('No actual scoped model request was recorded')
    const visible = scopeMessages(latest.messages)
    expect(visible).toHaveLength(1)
    expect(text(visible).includes(marker)).toBe(!absent)
    expect(await source.ctx.sessions.flush(agent.session)).toBe(true)
    const disk = await readPersistedEvents(source, id)
    expect(disk.slice(0, latest.events.length)).toEqual(latest.events)
    const restored = Session.create(id, structuredClone(latest.events), agent.session.header)
    expect(scopeMessages(restored.deriveMessages())).toEqual(visible)
    expect(source.ctx.agents.get(id)).toBe(agent)
    expect(source.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(ownerRequests).toBe(0)
  }
  async function passiveReading(stage: 'offline' | 'restored'): Promise<void> {
    const before = requests.length
    const observed = await source.ctx.scopeAgentContext.status({ agentId: id })
    if (observed.eligibility !== 'eligible') throw new Error('Original passive reading is no longer eligible')
    expect(observed.state).toMatchObject({ automatic: null, mode: 'paused', pauseReason: 'unavailable', usedBudget: 0 })
    const form = await sharing(sourceView)
    await form.locator(':scope > summary').click()
    const page = sourceView.page
    const panel = page.locator(PANEL)
    const trigger = page.getByRole('button', { name: '协作', exact: true })
    await expect.poll(() => trigger.textContent()).toContain('工作时更新')
    await expect.poll(() => panel.locator(':scope > [role="status"]').textContent()).toBe('工作时更新')
    await panel.getByText('已记录共享上下文不可用；正常工作时仍会重新核验。', { exact: true }).waitFor()
    expect(await panel.getByText('自动协作已暂停', { exact: true }).count()).toBe(0)
    expect(await panel.getByText('当前无法取得共享上下文，自动启动已暂停。', { exact: true }).count()).toBe(0)
    const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
    if (shots !== undefined) await mkdir(shots, { recursive: true })
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const bounds = await panel.boundingBox()
        return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
      }).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await panel.getByRole('button').last().scrollIntoViewIfNeeded()
      await panel.getByRole('heading', { name: '当前会话协作', exact: true }).scrollIntoViewIfNeeded()
      if (shots !== undefined) {
        await page.screenshot({ path: join(shots, `passive-${stage}-${String(viewport.width)}.png`), fullPage: true })
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    if (MODE === 'refresh') await mkdir(PASSIVE_SNAPSHOTS, { recursive: true })
    const aria = await captureStableAria(page, PANEL, source.workspaceCwd,
      { replacements: [[task.id, '{{taskId}}'], [identity.peerId, '{{ownerPeerId}}']] })
    await compareOrRefreshGolden(join(PASSIVE_SNAPSHOTS, `${stage}.expected.md`), aria, MODE)
    expect(requests).toHaveLength(before)
  }
  function clean(): void {
    for (const view of views) {
      expect(view.errors).toEqual([])
      expect(view.tripwire.warnings).toEqual([])
      expect(view.tripwire.pageErrors).toEqual([])
    }
  }
  return { source, sourceView, sourceRoot, id, agent, requests, task, entry, original, capture, status, prompt, approve,
    restartOwner, closeOwner, recover, publish, samples, proof, passiveReading, clean, owner: currentOwner }
}

describe.skipIf(process.platform === 'win32')('web e2e: original joint scope route recovery', () => {
  it('preserves a live source, queued native work and reading across owner restarts, then completes pending withdrawal', async () => {
    const f = await scenario([
      tool('route-first-write', 'write', { file_path: 'project/code.ts', content: 'export const initial = 1;\n' }), reply('BASELINE_DONE'),
      tool('route-offline-write', 'write', { file_path: 'project/code.ts', content: SOURCE_CODE }), reply('OFFLINE_DONE'),
      tool('route-online-read', 'read', { file_path: 'project/code.ts' }),
      tool('route-online-edit', 'edit', { file_path: 'project/code.ts', old_string: 'CHANGED_AFTER_CAPTURE', new_string: 'EDITED_AFTER_RECOVERY' }), reply('EDIT_DONE'),
      reply('READ_RESTORED'), reply('SHARING_STOPPED_READ'), reply('READ_LEFT'),
    ])
    await f.approve()
    const original = await f.capture()
    const receiver = await f.source.ctx.scopeAgentContext.status({ agentId: f.id })
    if (receiver.eligibility !== 'eligible' || receiver.state.binding === null || receiver.state.binding.kind === 'local-task') {
      throw new Error('Joint reading did not bind the remote Task')
    }
    const binding = receiver.state.binding
    const subscription = (await f.source.ctx.scopeAccess.list()).subscriptions.find(item => item.id === binding.subscriptionId)
    if (subscription === undefined) throw new Error('Joint subscription is not durable')
    expect(receiver.state).toMatchObject({ automatic: null, usedBudget: 0 })
    await f.prompt('BASELINE_DONE')
    await f.proof(BEFORE)
    await expect.poll(() => f.owner().ctx.developmentTasks.get({ taskId: f.task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length, { timeout: 15_000 }).toBe(1)
    await expect.poll(async () => (await f.capture()).pendingSamples, { timeout: 15_000 }).toBe(0)
    await f.closeOwner()
    await f.prompt('OFFLINE_DONE')
    await f.proof(BEFORE, true)
    const offlineRequest = f.requests.at(-1)
    if (offlineRequest === undefined) throw new Error('Offline ordinary request is missing')
    const offlineInput = scopeMessages(offlineRequest.messages)[0]
    expect(offlineInput?.source.kind === 'scope-agent-context' && offlineInput.source.form).toBe('withdrawn')
    await f.passiveReading('offline')
    await expect.poll(async () => (await f.capture()).pendingSamples, { timeout: 15_000 }).toBe(1)
    const pending = (await f.samples()).find(item => item.receipt === undefined)
    if (pending === undefined) throw new Error('Offline source did not retain its original sample')
    expect(pending.sample.result).toMatchObject({ kind: 'tool-observation', fields: { content: SOURCE_CODE } })
    await writeFile(join(f.sourceRoot, 'code.ts'), 'CHANGED_AFTER_CAPTURE\n')
    const replacement = await f.restartOwner()
    await f.recover(replacement)
    await expect.poll(async () => (await f.capture()).pendingSamples, { timeout: 15_000 }).toBe(0)
    const recovered = await f.capture()
    expect(recovered).toMatchObject({ selection: original.selection, proposal: original.proposal,
      roots: original.roots, tools: original.tools, limits: original.limits,
      invitation: { grant: original.invitation?.grant }, receiving: { adoptionId: original.receiving?.adoptionId } })
    const admitted = (await f.samples()).find(item => item.sample.sourceId === pending.sample.sourceId)
    expect(admitted?.sample).toEqual(pending.sample)
    expect(admitted?.receipt).toBeDefined()
    const publications = f.owner().ctx.developmentTasks.get({ taskId: f.task.id }).context
      .filter(item => item.peerToolObservation !== undefined)
    expect(publications).toHaveLength(2)
    expect(admitted?.receipt).toMatchObject({ publicationId: publications[1]?.id,
      sourceId: pending.sample.sourceId, sequence: pending.sample.sequence })
    expect(publications[1]?.peerToolObservation).toMatchObject({ sourceId: pending.sample.sourceId, sequence: pending.sample.sequence,
      fields: { path: 'code.ts', content: SOURCE_CODE } })
    expect(JSON.stringify(publications)).not.toContain('CHANGED_AFTER_CAPTURE')
    await f.prompt('EDIT_DONE')
    expect(await readFile(join(f.sourceRoot, 'code.ts'), 'utf8')).toBe('EDITED_AFTER_RECOVERY\n')
    await expect.poll(() => f.owner().ctx.developmentTasks.get({ taskId: f.task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length, { timeout: 15_000 }).toBe(3)
    await f.publish(AFTER)
    await f.prompt('READ_RESTORED')
    await f.proof(AFTER)
    await f.passiveReading('restored')
    const after = await f.source.ctx.scopeAgentContext.status({ agentId: f.id })
    if (after.eligibility !== 'eligible' || after.state.binding === null || after.state.binding.kind === 'local-task') {
      throw new Error('Read binding was lost')
    }
    expect(after.state.binding.id).toBe(binding.id)
    expect(after.state.binding.subscriptionId).toBe(binding.subscriptionId)
    expect(after.state.binding.invitation).toEqual({ ...binding.invitation, ownerAddress: replacement.ownerAddress })
    expect((await f.source.ctx.scopeAccess.list()).subscriptions).toEqual([{ ...subscription,
      routeRevision: (subscription.routeRevision ?? 0) + 1,
      invitation: { ...subscription.invitation, ownerAddress: replacement.ownerAddress } }])
    expect(after.state).toMatchObject({ automatic: null, usedBudget: 0 })
    await f.closeOwner()
    await (await sharing(f.sourceView)).getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    await expect.poll(async () => (await f.capture()).state, { timeout: 15_000 }).toBe('ending')
    expect((await f.capture()).collecting).toBe(false)
    const terminalRoute = await f.restartOwner()
    await f.recover(terminalRoute)
    await expect.poll(async () => {
      const current = await f.status()
      return current.capture === null && current.receivingContinuation === undefined
    }, { timeout: 15_000 }).toBe(true)
    const ended = f.owner().ctx.developmentTasks.get({ taskId: f.task.id }).context
      .filter(item => item.peerContribution?.ended !== undefined)
    expect(ended).toHaveLength(1)
    expect(ended[0]?.peerContribution?.grant).toEqual(original.invitation?.grant)
    const retainedRead = await f.source.ctx.scopeAgentContext.status({ agentId: f.id })
    if (retainedRead.eligibility !== 'eligible') throw new Error('Retained reading is not eligible')
    expect(retainedRead.state.binding).toMatchObject({ id: binding.id, subscriptionId: binding.subscriptionId,
      invitation: { ...binding.invitation, ownerAddress: terminalRoute.ownerAddress } })
    const readRoute = await f.restartOwner()
    await sharing(f.sourceView)
    const readForm = f.sourceView.page.locator('[data-native-read-route]')
    if (await readForm.getAttribute('open') === null) await readForm.locator(':scope > summary').click()
    await readForm.getByRole('textbox', { name: '新的连接地址', exact: true }).fill(readRoute.ownerAddress)
    await captureRoute(f.sourceView, '[data-native-read-route]', 'independent-read-route')
    await readForm.getByRole('button', { name: '保存恢复地址', exact: true }).click()
    await expect.poll(async () => {
      const current = await f.source.ctx.scopeAgentContext.status({ agentId: f.id })
      if (current.eligibility === 'not-live' || current.state.binding?.kind === 'local-task') return undefined
      return current.state.binding?.invitation.ownerAddress
    }).toBe(readRoute.ownerAddress)
    await f.publish(STOPPED)
    await f.prompt('SHARING_STOPPED_READ')
    await f.proof(STOPPED)
    const finalRead = await f.source.ctx.scopeAgentContext.status({ agentId: f.id })
    if (finalRead.eligibility !== 'eligible') throw new Error('Retained reading is not eligible')
    expect(finalRead.state.binding).toMatchObject({ id: binding.id, subscriptionId: binding.subscriptionId,
      invitation: { ...binding.invitation, ownerAddress: readRoute.ownerAddress } })
    expect(finalRead.state).toMatchObject({ automatic: null, usedBudget: 0 })
    expect((await f.source.ctx.scopeAccess.list()).subscriptions).toEqual([{ ...subscription,
      routeRevision: (subscription.routeRevision ?? 0) + 3,
      invitation: { ...subscription.invitation, ownerAddress: readRoute.ownerAddress } }])
    const panel = await sharing(f.sourceView)
    const restoredReadForm = panel.page().locator('[data-native-read-route]')
    if (await restoredReadForm.getAttribute('open') === null) await restoredReadForm.locator(':scope > summary').click()
    await restoredReadForm.getByText(readRoute.ownerAddress, { exact: true }).waitFor()
    await captureRoute(f.sourceView, '[data-native-read-route]', 'independent-read-restored')
    await panel.page().locator(PANEL).getByRole('button', { name: '离开共享上下文', exact: true }).click()
    await f.prompt('READ_LEFT')
    await f.proof(STOPPED, true)
    expect(f.requests).toHaveLength(11)
    await assertFixtureInventory(PASSIVE_SNAPSHOTS, ['offline.expected.md', 'restored.expected.md'])
    f.clean()
  })

  it('recovers the original waiting application before one joint approval without replacing local consent', async () => {
    const f = await scenario([reply('PENDING_RECOVERED')])
    expect(f.original.state).toBe('prepared')
    expect(f.original.receiving?.state).toBe('waiting')
    const replacement = await f.restartOwner()
    await f.recover(replacement)
    const waiting = await f.capture()
    expect(waiting).toMatchObject({ selection: f.original.selection, proposal: f.original.proposal,
      roots: f.original.roots, tools: f.original.tools, limits: f.original.limits, state: 'prepared' })
    expect(waiting.receiving?.adoptionId).toBe(f.original.receiving?.adoptionId)
    expect(f.requests).toHaveLength(1)
    expect(f.owner().ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toEqual([])
    expect((await f.source.ctx.scopeAccess.list()).subscriptions).toEqual([])
    await f.approve()
    expect((await f.capture()).selection).toEqual(f.original.selection)
    expect(f.owner().ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toHaveLength(1)
    expect((await f.owner().ctx.scopeAccess.list()).grants).toHaveLength(1)
    await f.prompt('PENDING_RECOVERED')
    await f.proof(BEFORE)
    expect(f.requests).toHaveLength(2)
    f.clean()
  })
})
