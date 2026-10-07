/** Browser consent, real file tools, independent owner admission, and recipient request evidence. */
import { verifyNativeContributionEntry } from './native-entry-support.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOTS = join(import.meta.dirname, 'snapshots/native-contribution')
const PANEL = '[data-native-scope-panel]'
const SHARE = '[data-native-contribution]'
const DESKTOP = { width: 1440, height: 1000 }
const MOBILE = { width: 390, height: 844 }
const CODE = 'export const NATIVE_BROWSER_retryLimit = 3;\n'
const OLD_DOCUMENT = 'No retry policy is documented.'
const DOCUMENT = 'NATIVE_BROWSER_DOC: retry only after a retryable response.'
const CONSENT = '我允许分享上述目录中的所选文件操作。任务所有者批准后可自动启用，直到到期或我停止分享。'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(name: 'write' | 'read' | 'edit', input: object): StreamChunk[] {
  const id = ToolCallId(`native-browser-${name}`)
  const args = JSON.stringify(input)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textOf(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function prompt(host: WebScaffold, page: Page, text: string, marker: string): Promise<SessionId> {
  if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
  const settled = host.whenTurnSettled(30_000)
  const [sessionId] = await Promise.all([settled, (async () => {
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(text)
    await composer.press('Enter')
  })()])
  await page.getByText(marker, { exact: true }).waitFor()
  return sessionId
}

async function openSharing(page: Page): Promise<Locator> {
  if (!await page.locator(PANEL).isVisible()) await page.getByRole('button', { name: '协作', exact: true }).click()
  const share = page.locator(SHARE)
  if (await share.getAttribute('open') === null) await share.locator(':scope > summary').click()
  return share
}

function entryTokens(entry: ScopeContributionEntry): (readonly [string, string])[] {
  return [[entry.ownerAddress, '{{ownerAddress}}'], [entry.ownerPeerId, '{{ownerPeerId}}'],
    [entry.taskId, '{{taskId}}'], [entry.entryId, '{{entryId}}'], [String(entry.expiresAt), '{{entryExpiresAt}}']]
}

async function captureStage(page: Page, workspace: string, stage: string,
  replacements: readonly (readonly [string, string])[]): Promise<void> {
  const shots = process.env.DSH_NATIVE_CONTRIBUTION_SHOTS
  if (shots !== undefined) await mkdir(shots, { recursive: true })
  for (const viewport of [DESKTOP, MOBILE]) {
    await page.setViewportSize(viewport)
    await expect.poll(async () => {
      const bounds = await page.locator(PANEL).boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.locator(PANEL).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const region = page.locator(SHARE)
    const feedback = region.getByRole('alert').or(region.getByRole('status')).last()
    await feedback.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    if (shots !== undefined) await page.screenshot({ path: join(shots, `${stage}-${String(viewport.width)}.png`), fullPage: true })
  }
  await page.setViewportSize(DESKTOP)
  const aria = await captureStableAria(page, SHARE, workspace, { replacements: [...replacements] })
  await compareOrRefreshGolden(join(SNAPSHOTS, `${stage}.expected.md`), aria, MODE)
}

describe.skipIf(process.platform === 'win32')('web e2e: native file contribution consent', () => {
  let owner: WebScaffold | undefined
  let source: WebScaffold | undefined
  let receiver: WebScaffold | undefined
  let browser: Browser | undefined
  let unavailableServer: Server | undefined
  let unavailablePort: number
  let sourcePage: Page
  let receiverPage: Page
  let directory: string | undefined
  const receiverRequests: Message[][] = []
  const observedMutations: { tool: string; agentId: string | null }[] = []
  const trips: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Native contribution acceptance uses keyless controlled responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-contribution-web-'))
    // An owned port accepts TCP but cannot authenticate as the invitation's owner.
    const refusing = createServer(socket => socket.destroy())
    unavailableServer = refusing
    await new Promise<void>((resolve, reject) => {
      refusing.once('error', reject)
      refusing.listen({ host: '127.0.0.1', port: 0 }, () => { refusing.off('error', reject); resolve() })
    })
    const unavailableAddress = refusing.address()
    if (unavailableAddress === null || typeof unavailableAddress === 'string') throw new Error('No refusing listener')
    unavailablePort = unavailableAddress.port
    const sourceReplay: ReplayOverrideDoc = [
      textResponse('NATIVE_SOURCE_READY'),
      toolResponse('write', { file_path: 'project/src/client.ts', content: CODE }),
      toolResponse('read', { file_path: 'project/docs/guide.md' }),
      toolResponse('edit', { file_path: 'project/docs/guide.md', old_string: OLD_DOCUMENT, new_string: DOCUMENT, replace_all: false }),
      textResponse('NATIVE_SOURCE_WORK_DONE'),
    ].map(chunks => ({ kind: 'chunks', chunks }))
    const recipientReplay: ReplayOverrideDoc = ['NATIVE_RECIPIENT_READY', 'NATIVE_RECIPIENT_ADOPTED', 'NATIVE_RECIPIENT_WITHDRAWN']
      .map(value => ({ kind: 'chunks', chunks: textResponse(value) }))
    const sourceOverride = join(directory, 'source.override.json')
    const receiverOverride = join(directory, 'receiver.override.json')
    await writeFile(sourceOverride, JSON.stringify(sourceReplay))
    await writeFile(receiverOverride, JSON.stringify(recipientReplay))
    owner = await launchWebScaffold({ hermeticMcpClients: true })
    source = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native',
      replayFixture: join(directory, 'source-override-only.jsonl'), replayOverride: sourceOverride, paceMs: 5 })
    receiver = await launchWebScaffold({ hermeticMcpClients: true,
      replayFixture: join(directory, 'receiver-override-only.jsonl'), replayOverride: receiverOverride, paceMs: 5 })
    source.ctx.on('tool-fs/mutation-start', (mutation) => {
      observedMutations.push({ tool: mutation.tool, agentId: mutation.execution.agent?.id ?? null })
    })
    receiver.ctx.on('llm/stream', (options, next) => { receiverRequests.push(structuredClone(options.messages)); return next() })
    expect(new Set([owner.harnessHome, source.harnessHome, receiver.harnessHome]).size).toBe(3)
    browser = await chromium.launch()
    sourcePage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    receiverPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const [page, host, name] of [[sourcePage, source, 'native-contribution-source'],
      [receiverPage, receiver, 'native-contribution-recipient']] as const) {
      trips.push(watchConsole(page))
      await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspaceZh(page, host.workspaceCwd, name)
    }
    if (MODE === 'refresh') await mkdir(SNAPSHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [() => browser?.close(), () => receiver?.close(), () => source?.close(), () => owner?.close(),
      () => new Promise<void>((resolve, reject) => {
        if (!unavailableServer?.listening) { resolve(); return }
        unavailableServer.close((error) => { if (error === undefined) resolve(); else reject(error) })
      }),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Native contribution browser cleanup failed')
  }, 120_000)

  it('requires local consent once, contributes real file operations after approval, and withdraws through the UI', async () => {
    if (owner === undefined || source === undefined || receiver === undefined) throw new Error('Hosts were not started')
    const ownerHost = owner
    const sourceHost = source
    const receiverHost = receiver
    onTestFailed(() => saveFailureShot(sourcePage, 'web-e2e-native-contribution'))
    const ownerIdentity = await ownerHost.ctx.scopeAccess.identity()
    const sourceIdentity = await sourceHost.ctx.scopeAccess.identity()
    const receiverIdentity = await receiverHost.ctx.scopeAccess.identity()
    expect(new Set([ownerIdentity.peerId, sourceIdentity.peerId, receiverIdentity.peerId]).size).toBe(3)
    const ownerAddress = ownerIdentity.addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner has no direct address')
    const createdBy = 'native-browser-owner' as DevelopmentParticipantId
    await ownerHost.ctx.developmentRooms.announce({ id: createdBy, kind: 'human', displayName: 'Native browser owner' })
    const task = await ownerHost.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy,
      objective: '共享代码与文档工作的工具报告', scope: '明确授权的工具观察，不声称当前文件事实。' })
    const entry = await ownerHost.ctx.scopeAccess.createContributionEntry({ taskId: task.id, ownerAddress,
      sourceKind: 'tool-observations', expiresAt: Date.now() + 3_600_000 })
    const root = join(sourceHost.workspaceCwd, 'native-contribution-source', 'project')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs/guide.md'), OLD_DOCUMENT)
    const sourceId = await prompt(sourceHost, sourcePage, '准备修改代码与文档。', 'NATIVE_SOURCE_READY')
    const recipientId = await prompt(receiverHost, receiverPage, '准备接收协作内容。', 'NATIVE_RECIPIENT_READY')
    let share = await openSharing(sourcePage)
    await share.getByRole('status').getByText('尚未允许分享文件工作', { exact: true }).waitFor()
    expect(await share.getByRole('textbox', { name: '允许采集的目录', exact: true }).count()).toBe(0)
    expect(await share.getByRole('checkbox', { name: CONSENT, exact: true }).count()).toBe(0)
    expect((await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture).toBeNull()
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'unselected', [])
    const closed = await ownerHost.ctx.scopeAccess.createContributionEntry({ taskId: task.id, ownerAddress,
      sourceKind: 'tool-observations', expiresAt: Date.now() + 3_600_000 })
    await ownerHost.ctx.scopeAccess.rejectContributionApplication({ entryId: closed.entry.entryId, expectedProposal: null })
    const ownerStoragePath = join(ownerHost.workspaceCwd, '.dsh-storages/scope_access.json')
    const ownerBefore = await readFile(ownerStoragePath, 'utf8')
    const sourceBefore = structuredClone(sourceHost.ctx.agents.get(sourceId)!.session.snapshotEvents())
    const untouched = async (): Promise<void> => {
      expect(await readFile(ownerStoragePath, 'utf8')).toBe(ownerBefore)
      expect((await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture).toBeNull()
      expect((await sourceHost.ctx.scopeAccess.list()).subscriptions).toEqual([])
      expect((await ownerHost.ctx.scopeAccess.list()).grants).toEqual([])
      expect(ownerHost.ctx.developmentTasks.peerContributions({ taskId: task.id })).toEqual([])
      expect(ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
      expect(sourceHost.ctx.agents.get(sourceId)!.session.snapshotEvents()).toEqual(sourceBefore)
    }
    const unreachable = { ...entry.entry, ownerAddress: `/ip4/127.0.0.1/tcp/${String(unavailablePort)}/p2p/${ownerIdentity.peerId}` }
    await verifyNativeContributionEntry(sourcePage, JSON.stringify(unreachable))
    await share.getByText('无法连接任务所有者。请确认对方在线且地址可达，然后重试。', { exact: true }).waitFor()
    expect(await share.getByRole('textbox', { name: '允许采集的目录', exact: true }).count()).toBe(0)
    await untouched()
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'unavailable', entryTokens(unreachable))
    await verifyNativeContributionEntry(sourcePage, closed.text)
    await share.getByText('此入口已关闭。请向任务所有者获取新入口。', { exact: true }).waitFor()
    expect(await share.getByRole('textbox', { name: '允许采集的目录', exact: true }).count()).toBe(0)
    await untouched()
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'closed', entryTokens(closed.entry))
    await verifyNativeContributionEntry(sourcePage, entry.text)
    await share.getByText(task.id, { exact: true }).waitFor()
    await share.getByText('连接已确认，可以申请。确认本地权限后还需所有者批准；尚未开始同步。', { exact: true }).waitFor()
    await untouched()
    expect(await share.getByRole('checkbox', { name: '写入文件（write）', exact: true }).isChecked()).toBe(false)
    expect(await share.getByRole('checkbox', { name: '编辑文件（edit）', exact: true }).isChecked()).toBe(false)
    expect(await share.getByRole('checkbox', { name: CONSENT, exact: true }).isChecked()).toBe(false)
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'connection-ready', [...entryTokens(entry.entry),
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), entry.entry.expiresAt), '{{entryExpiresLocal}}']])
    await share.getByRole('textbox', { name: '允许采集的目录', exact: true }).fill(root)
    await share.getByRole('checkbox', { name: '写入文件（write）', exact: true }).check()
    await share.getByRole('checkbox', { name: '编辑文件（edit）', exact: true }).check()
    await share.getByLabel('授权有效期（小时）', { exact: true }).fill('1')
    await share.getByLabel('最多样本数', { exact: true }).fill('8')
    await share.getByLabel('每份样本字节上限', { exact: true }).fill('8192')
    const submit = share.getByRole('button', { name: '申请并允许批准后自动启用', exact: true })
    expect(await submit.isDisabled()).toBe(true)
    await share.getByRole('checkbox', { name: CONSENT, exact: true }).check()
    await submit.click()
    await share.getByRole('status').getByText('等待所有者批准；批准后自动启用', { exact: true }).waitFor()
    const pending = (await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture
    if (pending === null) throw new Error('Local consent was not retained')
    expect(pending.collecting).toBe(false)
    await expect.poll(async () => {
      const applications = await ownerHost.ctx.scopeAccess.contributionApplications({ taskId: task.id })
      return applications.entries.find(item => item.entry.entryId === entry.entry.entryId)?.result.status
    }).toBe('pending')
    expect(ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    const replacements: (readonly [string, string])[] = [
      [task.id, '{{taskId}}'], [entry.entry.ownerPeerId, '{{ownerPeerId}}'],
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), pending.limits.expiresAt), '{{permissionExpiresLocal}}'],
    ]
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'waiting', replacements)
    await ownerHost.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      expectedProposal: pending.proposal, limits: pending.limits, ownerAddress })
    await share.getByRole('status').getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
    const active = (await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture
    if (active?.invitation == null) throw new Error('Approved invitation was not adopted')
    expect(active.selection).toEqual(pending.selection)
    expect(active.collecting).toBe(true)
    const invitation = await ownerHost.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiverIdentity.peerId,
      ownerAddress, expiresAt: Date.now() + 3_600_000, responsibility: 'Review code and documentation changes.' })
    await receiverHost.ctx.scopeAgentContext.bind({ agentId: recipientId, expectedBindingId: null, invitation, automatic: null })
    expect(await prompt(sourceHost, sourcePage, '执行已授权的代码写入和文档编辑。', 'NATIVE_SOURCE_WORK_DONE')).toBe(sourceId)
    expect(observedMutations.map(mutation => mutation.tool)).toEqual(['write', 'edit'])
    expect(await readFile(join(root, 'src/client.ts'), 'utf8')).toBe(CODE)
    expect(await readFile(join(root, 'docs/guide.md'), 'utf8')).toBe(DOCUMENT)
    await expect.poll(() => ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(2)
    const publications = ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(publications.map(item => item.peerToolObservation?.fields.path)).toEqual(['src/client.ts', 'docs/guide.md'])
    expect(publications.map(item => item.peerToolObservation?.observerPeerId)).toEqual([sourceIdentity.peerId, sourceIdentity.peerId])
    expect(publications.map(item => item.peerToolObservation?.reportedStatus)).toEqual(['success', 'success'])
    expect(JSON.stringify(publications)).not.toContain(root)
    expect(JSON.stringify(publications)).not.toContain(sourceId)
    const sourceAgent = sourceHost.ctx.agents.get(sourceId)
    if (sourceAgent === undefined) throw new Error('Source Agent is no longer live')
    expect(sourceAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['write', 'read', 'edit'])
    expect(sourceAgent.session.snapshotEvents().filter(event => event.type === 'tool/result').flatMap(event => event.data.message.content)
      .filter(block => block.type === 'tool-result').map(block => block.isError))
      .toEqual([false, false, false])
    expect(await sourceHost.ctx.sessions.flush(sourceAgent.session)).toBe(true)
    expect(await sourceHost.ctx.sessionPersistence.stat(sourceId)).toBeDefined()
    share = await openSharing(sourcePage)
    await share.getByText('等待提交的观察：0', { exact: true }).waitFor()
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'active', replacements)
    expect(await prompt(receiverHost, receiverPage, '检查刚收到的文件工作观察。', 'NATIVE_RECIPIENT_ADOPTED')).toBe(recipientId)
    const adopted = receiverRequests[1]?.filter(message => message.source.kind === 'scope-agent-context')
    expect(adopted).toHaveLength(1)
    const adoptedText = textOf(adopted ?? [])
    for (const value of [CODE.trim(), DOCUMENT, 'src/client.ts', 'docs/guide.md', sourceIdentity.peerId]) expect(adoptedText).toContain(value)
    expect(adoptedText).toContain('not a current file snapshot')
    expect(adoptedText).not.toContain(root)
    const recipient = receiverHost.ctx.agents.get(recipientId)
    if (recipient === undefined) throw new Error('Recipient Agent is no longer live')
    const detached = Session.create(recipientId, structuredClone(recipient.session.snapshotEvents()), recipient.session.header)
    expect(detached.deriveMessages().filter(message => message.source.kind === 'scope-agent-context')).toEqual(adopted)
    await share.getByRole('button', { name: '停止分享并撤回', exact: true }).click()
    await share.getByRole('status').getByText('尚未允许分享文件工作', { exact: true }).waitFor()
    expect((await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture).toBeNull()
    expect(ownerHost.ctx.developmentTasks.peerContributions({ taskId: task.id })[0]?.state).toBe('ended')
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'stopped', replacements)
    expect(await prompt(receiverHost, receiverPage, '再次检查已撤回来源。', 'NATIVE_RECIPIENT_WITHDRAWN')).toBe(recipientId)
    const withdrawn = receiverRequests[2]?.filter(message => message.source.kind === 'scope-agent-context')
    expect(withdrawn).toHaveLength(1)
    expect(textOf(withdrawn ?? [])).not.toContain('NATIVE_BROWSER_')
    expect(textOf(withdrawn ?? [])).toContain('left')
    const replay = Session.create(recipientId, structuredClone(recipient.session.snapshotEvents()), recipient.session.header)
    expect(replay.deriveMessages().filter(message => message.source.kind === 'scope-agent-context')).toEqual(withdrawn)
    expect(JSON.stringify(recipient.session.snapshotEvents())).toContain('NATIVE_BROWSER_DOC')
    expect(receiverRequests).toHaveLength(3)
    expect(sourceHost.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    expect(receiverHost.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(SNAPSHOTS, ['unselected.expected.md', 'unavailable.expected.md', 'closed.expected.md', 'connection-ready.expected.md',
      'waiting.expected.md', 'active.expected.md', 'stopped.expected.md'])
  }, 180_000)
})
