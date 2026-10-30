/** Browser consent for complete native replies, independent owner admission, and actual recipient request evidence. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { z } from 'zod'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { verifyNativeContributionEntry } from './native-entry-support.ts'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOTS = join(import.meta.dirname, 'snapshots/native-turn-outcomes')
const PANEL = '[data-native-scope-panel]'
const SHARE = '[data-native-contribution]'
const COPY = {
  'native.outcomes.scope': '只采集未来完整的最终答复；不直接复制用户输入、推理或工具记录。答复可能引用输入中的内容。自动响应、授权前已开始或中途追加输入的回合不采集；超出单条额度时整条不分享。',
  'native.outcomes.remoteConsent': '我允许按上述范围分享本会话的最终答复。任务所有者批准后可自动启用，直到到期或我停止分享。',
  'native.outcomes.active': '正在采集已授权的最终答复',
  'contribution.application.waiting': '等待所有者批准；批准后自动启用',
  'contribution.roots': '允许采集的目录',
  'contribution.hours': '授权有效期（小时）',
  'contribution.maxSamples': '最多样本数',
  'contribution.maxBytes': '每份样本字节上限',
  'native.share.probe.ready': '连接已确认，可以申请。确认本地权限后还需所有者批准；尚未开始同步。',
  'native.share.none': '尚未允许分享本会话的工作',
  'native.share.write': '写入文件（write）',
  'native.share.edit': '编辑文件（edit）',
  'native.share.request': '申请并允许批准后自动启用',
  'native.share.pending': '等待提交的观察：{count}',
  'native.share.stop': '停止分享并撤回',
} as const
const DESKTOP = { width: 1440, height: 1000 }
const MOBILE = { width: 390, height: 844 }
const PRIVATE_REPLY = 'PRIVATE_BEFORE_PERMISSION：这段既有最终答复仅保留在原会话。'
const PRIVATE_INPUT = 'PRIVATE_USER_INPUT：请依据我的私有背景形成当前结论。'
const FIRST_REPLY = 'TURN_OUTCOME_FIRST：产品决定是先支持团队内测；保留用户授权和责任边界，不代表所有者已经批准。'
const SECOND_REPLY = 'TURN_OUTCOME_SECOND：另一个独立结论是先收集使用反馈；它没有自动撤销上一条内测建议。'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function textOf(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
function requestPublications(messages: readonly Message[]) {
  const text = textOf(messages)
  const frame = /<development-task-context>\n([\s\S]*)\n<\/development-task-context>/u.exec(text)?.[1]
  if (frame === undefined) throw new Error('The actual model request has no Task publication frame')
  return z.object({ publications: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(JSON.parse(frame)).publications
}
async function prompt(host: WebScaffold, page: Page, input: string, answer: string): Promise<SessionId> {
  if (await page.locator(PANEL).isVisible()) await page.keyboard.press('Escape')
  const settled = host.whenTurnSettled(30_000)
  const [sessionId] = await Promise.all([settled, (async () => {
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(input)
    await composer.press('Enter')
  })()])
  await page.getByText(answer, { exact: true }).waitFor()
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
  const shots = process.env.DSH_NATIVE_TURN_OUTCOME_SHOTS
  if (shots !== undefined) await mkdir(shots, { recursive: true })
  for (const viewport of [DESKTOP, MOBILE]) {
    await page.setViewportSize(viewport)
    await expect.poll(async () => {
      const bounds = await page.locator(PANEL).boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.locator(PANEL).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.locator(SHARE).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const feedback = page.locator(SHARE).getByRole('alert').or(page.locator(SHARE).getByRole('status')).last()
    await feedback.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    if (shots !== undefined) await page.screenshot({ path: join(shots, `${stage}-${String(viewport.width)}.png`), fullPage: true })
  }
  await page.setViewportSize(DESKTOP)
  const aria = await captureStableAria(page, SHARE, workspace, { replacements: [...replacements] })
  await compareOrRefreshGolden(join(SNAPSHOTS, `${stage}.expected.md`), aria, MODE)
}

describe.skipIf(process.platform === 'win32')('web e2e: native completed-turn sharing consent', () => {
  let owner: WebScaffold | undefined
  let source: WebScaffold | undefined
  let receiver: WebScaffold | undefined
  let browser: Browser | undefined
  let sourcePage: Page
  let receiverPage: Page
  let directory: string | undefined
  const sourceRequests: Message[][] = []
  const receiverRequests: Message[][] = []
  const ownerRequests: Message[][] = []
  const trips: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Native completed-turn acceptance uses keyless controlled responses')
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-turn-outcomes-web-'))
    const sourceReplay: ReplayOverrideDoc = [PRIVATE_REPLY, FIRST_REPLY, SECOND_REPLY]
      .map(text => ({ kind: 'chunks', chunks: textResponse(text) }))
    const receiverReplay: ReplayOverrideDoc = ['TURN_RECEIVER_READY', 'TURN_RECEIVER_ADOPTED', 'TURN_RECEIVER_WITHDRAWN']
      .map(text => ({ kind: 'chunks', chunks: textResponse(text) }))
    const sourceOverride = join(directory, 'source.override.json')
    const receiverOverride = join(directory, 'receiver.override.json')
    await writeFile(sourceOverride, JSON.stringify(sourceReplay))
    await writeFile(receiverOverride, JSON.stringify(receiverReplay))
    owner = await launchWebScaffold({ hermeticMcpClients: true })
    source = await launchWebScaffold({ hermeticMcpClients: true,
      replayFixture: join(directory, 'source-override-only.jsonl'), replayOverride: sourceOverride, paceMs: 5 })
    receiver = await launchWebScaffold({ hermeticMcpClients: true,
      replayFixture: join(directory, 'receiver-override-only.jsonl'), replayOverride: receiverOverride, paceMs: 5 })
    owner.ctx.on('llm/stream', (options, next) => { ownerRequests.push(structuredClone(options.messages)); return next() })
    source.ctx.on('llm/stream', (options, next) => { sourceRequests.push(structuredClone(options.messages)); return next() })
    receiver.ctx.on('llm/stream', (options, next) => { receiverRequests.push(structuredClone(options.messages)); return next() })
    expect(new Set([owner.harnessHome, source.harnessHome, receiver.harnessHome]).size).toBe(3)
    browser = await chromium.launch()
    sourcePage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    receiverPage = await browser.newPage({ viewport: DESKTOP, locale: ZH_BROWSER_LOCALE })
    for (const [page, host, name] of [[sourcePage, source, 'native-turn-source'],
      [receiverPage, receiver, 'native-turn-recipient']] as const) {
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
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Native completed-turn browser cleanup failed')
  }, 120_000)

  it('shares only future complete replies after UI consent and removes them from the next request after UI stop', async () => {
    if (owner === undefined || source === undefined || receiver === undefined) throw new Error('Hosts were not started')
    const ownerHost = owner
    const sourceHost = source
    const receiverHost = receiver
    onTestFailed(() => saveFailureShot(sourcePage, 'web-e2e-native-turn-outcomes'))
    const ownerIdentity = await ownerHost.ctx.scopeAccess.identity()
    const sourceIdentity = await sourceHost.ctx.scopeAccess.identity()
    const receiverIdentity = await receiverHost.ctx.scopeAccess.identity()
    expect(new Set([ownerIdentity.peerId, sourceIdentity.peerId, receiverIdentity.peerId]).size).toBe(3)
    const ownerAddress = ownerIdentity.addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner has no direct address')
    const createdBy = 'native-turn-browser-owner' as DevelopmentParticipantId
    await ownerHost.ctx.developmentRooms.announce({ id: createdBy, kind: 'human', displayName: 'Completed-turn owner' })
    const task = await ownerHost.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy,
      objective: '共享分别负责产品和研究工作的 Agent 报告', scope: '独立获准的最终答复；不代表已批准事实。' })
    const entry = await ownerHost.ctx.scopeAccess.createContributionEntry({ taskId: task.id, ownerAddress,
      sourceKind: 'completed-turn-outcomes', expiresAt: Date.now() + 3_600_000 })
    const sourceId = await prompt(sourceHost, sourcePage, '建立原有私有工作背景。', PRIVATE_REPLY)
    const receiverId = await prompt(receiverHost, receiverPage, '准备继续我的职责工作。', 'TURN_RECEIVER_READY')
    const sourceAgent = sourceHost.ctx.agents.get(sourceId)
    const receiverAgent = receiverHost.ctx.agents.get(receiverId)
    if (sourceAgent === undefined || receiverAgent === undefined) throw new Error('Existing Agents are missing')
    const privateEvents = structuredClone(sourceAgent.session.snapshotEvents())
    const receiverEvents = structuredClone(receiverAgent.session.snapshotEvents())
    let share = await openSharing(sourcePage)
    expect((await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture).toBeNull()
    await verifyNativeContributionEntry(sourcePage, entry.text)
    await share.getByText(COPY['native.share.probe.ready'], { exact: true }).waitFor()
    const permission = share.locator('[data-native-turn-outcome-permission]')
    await permission.getByText(COPY['native.outcomes.scope'], { exact: true }).waitFor()
    expect(await share.getByRole('textbox', { name: COPY['contribution.roots'], exact: true }).count()).toBe(0)
    expect(await share.getByRole('checkbox', { name: COPY['native.share.write'], exact: true }).count()).toBe(0)
    expect(await share.getByRole('checkbox', { name: COPY['native.share.edit'], exact: true }).count()).toBe(0)
    await permission.getByLabel(COPY['contribution.hours'], { exact: true }).fill('1')
    await permission.getByLabel(COPY['contribution.maxSamples'], { exact: true }).fill('4')
    await permission.getByLabel(COPY['contribution.maxBytes'], { exact: true }).fill('8192')
    const consent = permission.getByRole('checkbox', { name: COPY['native.outcomes.remoteConsent'], exact: true })
    const submit = share.getByRole('button', { name: COPY['native.share.request'], exact: true })
    expect(await consent.isChecked()).toBe(false)
    expect(await submit.isDisabled()).toBe(true)
    expect(ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    expect(sourceAgent.session.snapshotEvents()).toEqual(privateEvents)
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'permission', [...entryTokens(entry.entry),
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), entry.entry.expiresAt), '{{entryExpiresLocal}}']])
    await consent.check()
    await submit.click()
    await share.getByRole('status').getByText(COPY['contribution.application.waiting'], { exact: true }).waitFor()
    const pending = (await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture
    if (pending === null || pending.sourceKind !== 'completed-turn-outcomes') throw new Error('Independent turn permission is missing')
    expect(pending.collecting).toBe(false)
    expect(pending.proposal.source).toEqual({ kind: 'completed-turn-outcomes', version: 5, name: 'session-outcomes' })
    for (const field of ['roots', 'tools', 'commands', 'initialization', 'fileContent']) expect(pending).not.toHaveProperty(field)
    await expect.poll(async () => (await ownerHost.ctx.scopeAccess.contributionApplications({ taskId: task.id }))
      .entries.find(item => item.entry.entryId === entry.entry.entryId)?.result.status).toBe('pending')
    const replacements: (readonly [string, string])[] = [[task.id, '{{taskId}}'], [ownerIdentity.peerId, '{{ownerPeerId}}'],
      [await sourcePage.evaluate(value => new Date(value).toLocaleString(), pending.limits.expiresAt), '{{permissionExpiresLocal}}']]
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'waiting', replacements)
    await ownerHost.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      expectedProposal: pending.proposal, limits: pending.limits, ownerAddress })
    await share.getByRole('status').getByText(COPY['native.outcomes.active'], { exact: true }).waitFor()
    const active = (await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture
    if (active?.invitation == null) throw new Error('Owner approval was not adopted')
    expect(active.selection).toEqual(pending.selection)
    expect(active.collecting).toBe(true)
    expect(ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    const invitation = await ownerHost.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiverIdentity.peerId,
      ownerAddress, expiresAt: Date.now() + 3_600_000, responsibility: 'Use independently reported product and research conclusions.' })
    await receiverHost.ctx.scopeAgentContext.bind({ agentId: receiverId, expectedBindingId: null, invitation, automatic: null })
    expect(await prompt(sourceHost, sourcePage, PRIVATE_INPUT, FIRST_REPLY)).toBe(sourceId)
    expect(await prompt(sourceHost, sourcePage, '继续独立的研究职责并保留先前结论。', SECOND_REPLY)).toBe(sourceId)
    await expect.poll(() => ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerTurnOutcome !== undefined).length).toBe(2)
    const publications = ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(publications).toHaveLength(2)
    expect(publications.map(item => item.peerTurnOutcome?.text)).toEqual([FIRST_REPLY, SECOND_REPLY])
    for (const [index, publication] of publications.entries()) {
      const observation = publication.peerTurnOutcome
      if (observation === undefined) throw new Error('Expected a complete turn report')
      expect(observation.sha256).toBe(createHash('sha256').update(observation.text, 'utf8').digest('hex'))
      expect(observation).toMatchObject({ kind: 'completed-turn-outcome', version: 5, sequence: index + 1,
        observerPeerId: sourceIdentity.peerId,
        capture: { id: pending.selection.captureId, generation: pending.selection.captureGeneration } })
      expect(publication.peerContribution?.grant).toEqual(active.invitation.grant)
      expect(publication.text).toContain('not owner-approved facts')
      expect(publication.peerToolObservation).toBeUndefined()
    }
    expect(JSON.stringify(publications)).not.toContain(PRIVATE_REPLY)
    expect(JSON.stringify(publications)).not.toContain(PRIVATE_INPUT)
    expect(JSON.stringify(publications)).not.toContain(sourceId)
    expect(sourceHost.ctx.agents.get(sourceId)).toBe(sourceAgent)
    expect(sourceAgent.session.snapshotEvents().slice(0, privateEvents.length)).toEqual(privateEvents)
    expect(await sourceHost.ctx.sessions.flush(sourceAgent.session)).toBe(true)
    expect(await sourceHost.ctx.sessionPersistence.stat(sourceId)).toBeDefined()
    share = await openSharing(sourcePage)
    await share.getByText(COPY['native.share.pending'].replace('{count}', '0'), { exact: true }).waitFor()
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'active', replacements)
    expect(await prompt(receiverHost, receiverPage, '继续我的职责工作，使用当前共享报告。', 'TURN_RECEIVER_ADOPTED')).toBe(receiverId)
    const adopted = receiverRequests[1]?.filter(message => message.source.kind === 'scope-agent-context') ?? []
    expect(adopted).toHaveLength(1)
    expect(requestPublications(adopted)).toEqual(publications.map(item => ({ id: item.id, text: item.text })))
    expect(textOf(adopted)).not.toContain(PRIVATE_REPLY)
    expect(textOf(adopted)).not.toContain(PRIVATE_INPUT)
    const adoptedEvents = structuredClone(receiverAgent.session.snapshotEvents())
    const detached = Session.create(receiverId, adoptedEvents, receiverAgent.session.header)
    expect(detached.deriveMessages().filter(message => message.source.kind === 'scope-agent-context')).toEqual(adopted)
    await share.getByRole('button', { name: COPY['native.share.stop'], exact: true }).click()
    await share.getByRole('status').getByText(COPY['native.share.none'], { exact: true }).waitFor()
    expect((await sourceHost.ctx.scopeAgentContributions.status({ agentId: sourceId })).capture).toBeNull()
    expect(ownerHost.ctx.developmentTasks.peerContributions({ taskId: task.id })[0]?.state).toBe('ended')
    await captureStage(sourcePage, sourceHost.workspaceCwd, 'stopped', replacements)
    expect(await prompt(receiverHost, receiverPage, '继续检查当前已授权的共享内容。', 'TURN_RECEIVER_WITHDRAWN')).toBe(receiverId)
    const withdrawn = receiverRequests[2]?.filter(message => message.source.kind === 'scope-agent-context') ?? []
    expect(withdrawn).toHaveLength(1)
    expect(textOf(withdrawn)).not.toContain('TURN_OUTCOME_FIRST')
    expect(textOf(withdrawn)).not.toContain('TURN_OUTCOME_SECOND')
    const terminal = ownerHost.ctx.developmentTasks.get({ taskId: task.id }).context.at(-1)
    if (terminal === undefined) throw new Error('Missing durable withdrawal')
    expect(terminal.peerContribution?.ended).toBe('left')
    expect(requestPublications(withdrawn)).toEqual([{ id: terminal.id, text: terminal.text }])
    expect(receiverHost.ctx.agents.get(receiverId)).toBe(receiverAgent)
    expect(receiverAgent.session.snapshotEvents().slice(0, receiverEvents.length)).toEqual(receiverEvents)
    expect(receiverAgent.session.snapshotEvents().slice(0, adoptedEvents.length)).toEqual(adoptedEvents)
    const replay = Session.create(receiverId, structuredClone(receiverAgent.session.snapshotEvents()), receiverAgent.session.header)
    expect(replay.deriveMessages().filter(message => message.source.kind === 'scope-agent-context')).toEqual(withdrawn)
    expect(JSON.stringify(receiverAgent.session.snapshotEvents())).toContain(FIRST_REPLY)
    expect(JSON.stringify(receiverAgent.session.snapshotEvents())).toContain(SECOND_REPLY)
    for (const agent of [sourceAgent, receiverAgent]) expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
    expect(sourceRequests).toHaveLength(3)
    expect(receiverRequests).toHaveLength(3)
    expect(ownerRequests).toEqual([])
    expect(sourceHost.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    expect(receiverHost.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    for (const trip of trips) { expect(trip.pageErrors).toEqual([]); expect(trip.warnings).toEqual([]) }
    await assertFixtureInventory(SNAPSHOTS, ['permission.expected.md', 'waiting.expected.md', 'active.expected.md', 'stopped.expected.md'])
  }, 180_000)
})
