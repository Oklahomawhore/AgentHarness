/** Existing-file Edit results require explicit complete-content permission before reaching another native Session. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { chromium } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { createUserMessage, ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const cleanup: (() => Promise<void>)[] = []
const consumption = new WeakMap<WebScaffold, { actual: number; expected: number }>()
const untouched = 'UNSHARED_EXISTING_FILE_PREFIX'
const siblingCanary = 'UNTOUCHED_SIBLING_CANARY'
const prefix = '// ' + untouched + '\nexport const state = "EDIT_VALUE_000";\n'
const initial = prefix + 'x'.repeat(1023 - Buffer.byteLength(prefix, 'utf8')) + '\n'
const latest = initial.replace('EDIT_VALUE_000', 'EDIT_VALUE_040')
const value = (index: number): string => `EDIT_VALUE_${String(index).padStart(3, '0')}`

function reply(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function fileCall(index: number): StreamChunk[] {
  const id = ToolCallId(`existing-edit-${String(index)}`)
  const name = index === 0 ? 'read' : 'edit'
  const args = JSON.stringify(index === 0 ? { file_path: 'project/state.ts' }
    : { file_path: 'project/state.ts', old_string: value(index - 1), new_string: value(index), replace_all: false })
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function context(messages: readonly Message[]): Message[] {
  return messages.filter(message => ['scope-agent-context', 'development-task-context'].includes(message.source.kind))
}
function textOf(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
function jsonStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => jsonStrings(item))
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(item => jsonStrings(item))
  if (typeof value !== 'string') return []
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch {
    // Original report text may itself contain JSON; ordinary strings have no nested fields.
    return [value]
  }
  return [value, ...jsonStrings(parsed)]
}
async function run(host: WebScaffold, handle: AgentHandle, instruction: string): Promise<void> {
  const settled = host.whenTurnSettled()
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: instruction }] }))
  expect(await settled).toBe(handle.agent.id)
  const events = handle.agent.session.snapshotEvents()
  const ended = events.findLast(event => event.type === 'turn/end')
  const diagnostic = inspect({ ended, consumption: consumption.get(host),
    tools: events.filter(event => event.type === 'tool/call' || event.type === 'tool/result').slice(-4) }, { depth: 8 })
  expect(ended?.data.reason.kind, diagnostic).toBe('completed')
}
async function originalTask(host: WebScaffold, handle: AgentHandle) {
  const status = await host.ctx.scopeAgentContributions.localStatus({ agentId: handle.agent.id })
  if (status.participantId === null) throw new Error('Existing native Session lacks a participant')
  const task = await host.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: status.participantId,
    objective: 'Maintain this independently owned implementation.', scope: 'Use only explicitly permitted file observations.' })
  await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId: status.participantId })
  const reading = await host.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (reading.eligibility !== 'eligible' || reading.localTask === null) throw new Error('Original local Task assignment absent')
  await host.ctx.scopeAgentContext.bindLocal({ agentId: handle.agent.id,
    expectedBindingId: null, ...reading.localTask, automatic: null })
  return { task, target: reading.localTask }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Existing-file Edit fixture cleanup failed: ${inspect(failures, { depth: 8 })}`)
  }
})

// The shipped native Web composition is unavailable on Windows.
it.skipIf(process.platform === 'win32').each([false, true])(
  'shares existing-file completion only with explicit full-content permission (%s)', async (completeFile) => {
    if (webSnapshotMode() === 'record') throw new Error('Existing-file Edit acceptance uses only controlled keyless replies')
    expect(Buffer.byteLength(initial, 'utf8')).toBe(1024)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-existing-edit-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const ownerOverride = join(directory, 'owner.override.json')
    const receiverOverride = join(directory, 'receiver.override.json')
    const ownerReplies: ReplayOverrideDoc = [fileCall(0), reply('Owner ready.'), fileCall(1), reply('Initial work complete.'),
      ...Array.from({ length: 39 }, (_, index) => fileCall(index + 2)), reply('Edits complete.'),
    ].map(chunks => ({ kind: 'chunks', chunks }))
    const receiverReplies: ReplayOverrideDoc = [reply('Receiver ready.'), reply('Initial shared work observed.'),
      reply('Current shared work observed.')].map(chunks => ({ kind: 'chunks', chunks }))
    await writeFile(ownerOverride, JSON.stringify(ownerReplies))
    await writeFile(receiverOverride, JSON.stringify(receiverReplies))
    const owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
      replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
    cleanup.push(() => owner.close())
    const receiver = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
      replayFixture: join(directory, 'receiver-override-only.jsonl'), replayOverride: receiverOverride })
    cleanup.push(() => receiver.close())
    const create = async (host: WebScaffold, role: string): Promise<AgentHandle> => {
      const handle = await host.ctx.agents.create({ sessionId: SessionId(`existing-edit-${role}`), meta: { cwd: host.workspaceCwd },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        setup: agentCtx => host.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
      cleanup.push(() => handle.dispose())
      return handle
    }
    const a = await create(owner, 'owner')
    const b = await create(receiver, 'receiver')
    const ownerConsumption = { actual: 0, expected: ownerReplies.length }
    const receiverConsumption = { actual: 0, expected: receiverReplies.length }
    consumption.set(owner, ownerConsumption); consumption.set(receiver, receiverConsumption)
    owner.ctx.on('llm/stream', (_, next) => { ownerConsumption.actual++; return next() })
    const requests: Message[][] = []
    receiver.ctx.on('llm/stream', (options, next) => {
      receiverConsumption.actual++; requests.push(structuredClone(options.messages))
      expect(context(Session.create(b.agent.id, structuredClone(b.agent.session.snapshotEvents()), b.agent.session.header)
        .deriveMessages())).toEqual(context(options.messages))
      return next()
    })
    await mkdir(join(owner.workspaceCwd, 'project'))
    await writeFile(join(owner.workspaceCwd, 'project/state.ts'), initial)
    await writeFile(join(owner.workspaceCwd, 'project/untouched.ts'), siblingCanary)
    await run(owner, a, 'Continue your ordinary local work.')
    await run(receiver, b, 'Continue your ordinary local work.')
    const aOriginal = await originalTask(owner, a)
    const bOriginal = await originalTask(receiver, b)
    const limits = { expiresAt: Date.now() + 3600000, maxSamples: 64, maxSampleBytes: 8192 }
    await owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.agent.id, expectedCapture: null,
      taskId: aOriginal.task.id, bindingId: aOriginal.target.taskBindingId, expectedBindingEpoch: aOriginal.target.expectedBindingEpoch,
      roots: [join(owner.workspaceCwd, 'project')], tools: ['edit'], limits,
      ...(completeFile ? { fileContent: 'completed-native-file' as const } : {}) })
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.agent.id })).capture?.collecting)
      .toBe(true)
    const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner has no active transport address')
    const invitation = await owner.ctx.scopeAccess.invite({ taskId: aOriginal.task.id, ownerAddress,
      recipientPeerId: (await receiver.ctx.scopeAccess.identity()).peerId, expiresAt: limits.expiresAt,
      responsibility: 'Use the latest permitted implementation without taking over the owner responsibility.' })
    const receiving = await receiver.ctx.scopeAgentContext.status({ agentId: b.agent.id })
    if (receiving.eligibility !== 'eligible') throw new Error('Existing receiving Session is ineligible')
    await receiver.ctx.scopeAgentContext.bind({ agentId: b.agent.id, invitation,
      expectedBindingId: receiving.state.binding?.id ?? null, localTask: bOriginal.target, automatic: null })
    const reports = () => owner.ctx.developmentTasks.get({ taskId: aOriginal.task.id }).context
      .filter(publication => publication.localToolObservation !== undefined)
    let completed = 0
    owner.ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (agent === a.agent && step > 1) {
        completed++
        await expect.poll(async () => {
          const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.agent.id })
          return { count: reports().length, recorded: local.initialization.recordedSamples,
            unconfirmed: local.initialization.unconfirmedSamples, pending: local.capture?.pendingSamples }
        }).toEqual({ count: completed, recorded: completed, unconfirmed: 0, pending: 0 })
      }
      return next()
    }, { prepend: true })
    await run(owner, a, 'Complete the permitted initial file work.')
    expect(await readFile(join(owner.workspaceCwd, 'project/state.ts'), 'utf8')).toBe(initial.replace(value(0), value(1)))
    await run(receiver, b, 'Continue using the available shared context.')
    const initialRequest = requests.at(-1)
    if (initialRequest === undefined) throw new Error('Initial receiver request is absent')
    const firstShared = initialRequest.find(message => message.source.kind === 'scope-agent-context')
    if (firstShared?.source.kind !== 'scope-agent-context' || firstShared.source.form !== 'snapshot') {
      throw new Error('First Edit has no current receiver snapshot')
    }
    const initialPayload = JSON.parse(firstShared.source.projection.text.split('<development-task-context>\n')[1]
      ?.split('\n</development-task-context>')[0] ?? 'null') as unknown
    if (!completeFile) {
      expect(textOf([firstShared])).toContain(value(1))
      expect(textOf([firstShared])).not.toContain(untouched)
    }
    await run(owner, a, 'Complete the permitted incremental edits.')
    expect(completed).toBe(40)
    expect(await readFile(join(owner.workspaceCwd, 'project/state.ts'), 'utf8')).toBe(latest)
    await run(receiver, b, 'Continue using the available shared context.')
    const currentRequest = requests.at(-1)
    if (currentRequest === undefined) throw new Error('Final receiver request is absent')
    expect(requests).toHaveLength(3)
    expect(a.agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['read', ...Array.from({ length: 40 }, () => 'edit')])
    expect(ownerConsumption.actual).toBe(ownerConsumption.expected)
    expect(receiverConsumption.actual).toBe(receiverConsumption.expected)
    expect(b.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
    const managed = context(currentRequest)
    const remote = managed.find(message => message.source.kind === 'scope-agent-context')
    if (remote?.source.kind !== 'scope-agent-context' || remote.source.form !== 'snapshot') {
      throw new Error(`Receiver lacks a current shared snapshot: ${JSON.stringify(managed)}`)
    }
    const localBytes = Buffer.byteLength(textOf(managed.filter(message => message.source.kind === 'development-task-context')), 'utf8')
    const sharedBytes = Buffer.byteLength(textOf([remote]), 'utf8')
    expect(localBytes).toBeLessThanOrEqual(4000)
    expect(localBytes + sharedBytes).toBeLessThanOrEqual(8000)
    const projection = remote.source.projection
    const payload = JSON.parse(projection.text.split('<development-task-context>\n')[1]?.split('\n</development-task-context>')[0]
      ?? 'null') as unknown
    const diagnostic = JSON.stringify({ completedTools: completed, localBytes, sharedBytes,
      selectedSources: projection.selectedSources, omittedSources: projection.omittedSources, projectionText: projection.text })
    for (const request of requests) {
      const shared = textOf(request.filter(message => message.source.kind === 'scope-agent-context'))
      expect(shared).not.toContain(siblingCanary)
      if (!completeFile) expect(shared).not.toContain(untouched)
    }
    if (completeFile) {
      expect(jsonStrings(initialPayload), diagnostic).toContain(initial.replace(value(0), value(1)))
      expect(jsonStrings(payload), diagnostic).toContain(latest)
      for (let index = 0; index < 40; index++) expect(textOf([remote])).not.toContain(value(index))
    } else expect(jsonStrings(payload)).not.toContain(latest)
  })

it.skipIf(process.platform === 'win32')('authorizes complete contents through the native UI before an existing-file Edit', async (test) => {
  if (webSnapshotMode() === 'record') throw new Error('Native completion UI acceptance uses controlled keyless replies')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-existing-edit-ui-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ownerOverride = join(directory, 'owner.override.json')
  const receiverOverride = join(directory, 'receiver.override.json')
  const ownerReplies: ReplayOverrideDoc = [fileCall(0), reply('EXISTING_FILE_READY'), fileCall(1), reply('EXISTING_FILE_EDITED')]
    .map(chunks => ({ kind: 'chunks', chunks }))
  const receiverReplies: ReplayOverrideDoc = [reply('RECEIVER_READY'), reply('RECEIVER_OBSERVED'), reply('RECEIVER_WITHDRAWN')]
    .map(chunks => ({ kind: 'chunks', chunks }))
  await writeFile(ownerOverride, JSON.stringify(ownerReplies)); await writeFile(receiverOverride, JSON.stringify(receiverReplies))
  const owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
    replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
  cleanup.push(() => owner.close())
  const receiver = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
    replayFixture: join(directory, 'receiver-override-only.jsonl'), replayOverride: receiverOverride })
  cleanup.push(() => receiver.close())
  const b = await receiver.ctx.agents.create({ sessionId: SessionId('existing-edit-ui-recipient'), meta: { cwd: receiver.workspaceCwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: agentCtx => receiver.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
  cleanup.push(() => b.dispose())
  const requests: Message[][] = []
  const ownerConsumption = { actual: 0, expected: ownerReplies.length }
  const receiverConsumption = { actual: 0, expected: receiverReplies.length }
  consumption.set(owner, ownerConsumption); consumption.set(receiver, receiverConsumption)
  owner.ctx.on('llm/stream', (_, next) => { ownerConsumption.actual++; return next() })
  receiver.ctx.on('llm/stream', (options, next) => {
    receiverConsumption.actual++; requests.push(structuredClone(options.messages)); return next()
  })
  const browser = await chromium.launch()
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-existing-edit-ui'))
  await page.goto(owner.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspaceZh(page, owner.workspaceCwd, 'existing-edit-ui')
  const project = join(owner.workspaceCwd, 'existing-edit-ui/project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'state.ts'), initial)
  await writeFile(join(project, 'untouched.ts'), siblingCanary)
  const prompt = async (marker: string): Promise<SessionId> => {
    if (await page.locator('[data-native-scope-panel]').isVisible()) await page.keyboard.press('Escape')
    const settled = owner.whenTurnSettled()
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill('继续本轮工作。'); await composer.press('Enter')
    const id = await settled
    await page.getByText(marker, { exact: true }).waitFor()
    return id
  }
  const aId = await prompt('EXISTING_FILE_READY')
  const a = owner.ctx.agents.get(aId)
  if (a === undefined) throw new Error('The UI-created native Session is absent')
  await run(receiver, b, 'Continue your ordinary local work.')
  const before = await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })
  if (before.participantId === null) throw new Error('Current source participant is absent')
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: before.participantId,
    objective: '维护已有文件的获准完成内容', scope: '只接收明确授权的文件观察。' })
  await page.getByRole('button', { name: '协作', exact: true }).click()
  const panel = page.locator('[data-native-scope-panel]')
  await panel.getByRole('radio', { name: '本机创建的目标', exact: true }).check()
  const local = page.locator('[data-native-local-contribution]')
  await local.getByRole('combobox', { name: '本机目标', exact: true }).selectOption({ label: task.objective })
  await local.getByRole('button', { name: '连接当前会话', exact: true }).click()
  await local.getByText(`已连接：${task.objective}`, { exact: true }).waitFor()
  const suggestions = local.getByRole('button', { name: '使用当前工作区建议', exact: true })
  await expect.poll(() => suggestions.isEnabled()).toBe(true)
  await suggestions.click()
  await expect.poll(() => local.getByRole('textbox', { name: '允许采集的目录', exact: true }).inputValue()).toBe(a.session.header.cwd)
  expect(await local.getByLabel('授权有效期（小时）', { exact: true }).inputValue()).toBe('8')
  expect(await local.getByLabel('最多样本数', { exact: true }).inputValue()).toBe('100')
  expect(await local.getByLabel('每份样本字节上限', { exact: true }).inputValue()).toBe('8192')
  expect(await local.getByRole('checkbox', { name: '写入文件（write）', exact: true }).isChecked()).toBe(true)
  expect(await local.getByRole('checkbox', { name: '编辑文件（edit）', exact: true }).isChecked()).toBe(true)
  expect(await local.getByRole('checkbox', {
    name: '我允许将上述目录中所选文件操作的内容分享到这个目标，直到到期或我停止分享。', exact: true,
  }).isChecked()).toBe(false)
  expect(await local.getByRole('checkbox', { name: '允许此会话为当前目标开始有限自动工作', exact: true }).isChecked()).toBe(false)
  expect((await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture).toBeNull()
  expect(ownerConsumption.actual).toBe(2)
  await local.getByRole('checkbox', { name: '写入文件（write）', exact: true }).uncheck()
  const complete = local.getByRole('checkbox', { name: '分享修改后的完整文件内容', exact: true })
  expect(await complete.isChecked()).toBe(false)
  expect((await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture).toBeNull()
  await complete.check()
  const enable = local.getByRole('button', { name: '允许并开始分享', exact: true })
  expect(await enable.isDisabled()).toBe(true)
  await local.getByRole('checkbox', {
    name: '我允许将上述目录中所选文件操作的内容分享到这个目标，直到到期或我停止分享。', exact: true,
  }).check()
  await expect.poll(() => enable.isEnabled()).toBe(true)
  const snapshots = join(import.meta.dirname, 'expected/native-completed-file')
  if (webSnapshotMode() === 'refresh') await mkdir(snapshots, { recursive: true })
  const capture = async (stage: string, replacements: readonly (readonly [string, string])[] = []): Promise<void> => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const last = local.getByRole('button').last()
      await last.scrollIntoViewIfNeeded()
      await expect.poll(async () => {
        const bounds = await last.boundingBox()
        return bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= (width === 390 ? 844 : 1000)
      }).toBe(true)
      const shots = process.env.DSH_CONTRIBUTION_SCOPE_SHOTS
      if (shots !== undefined) {
        await mkdir(shots, { recursive: true })
        await complete.or(local.getByText('本次操作完成后的完整文件内容（包含未修改部分）', { exact: true })).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(shots, `completed-file-${stage}-${String(width)}.png`), fullPage: true })
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const aria = await captureStableAria(page, '[data-native-local-contribution]', owner.workspaceCwd,
      { replacements: [[task.id, '{{taskId}}'], ...replacements] })
    await compareOrRefreshGolden(join(snapshots, `${stage}.expected.md`), aria, webSnapshotMode())
  }
  await capture('permission')
  await enable.click()
  await local.getByText('正在采集已授权的文件工作', { exact: true }).waitFor()
  await expect.poll(() => local.getByRole('button', { name: '停止分享并撤回', exact: true }).isEnabled()).toBe(true)
  const active = (await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture
  if (active === null) throw new Error('The UI did not establish a native capture')
  expect(active.grant.source).toMatchObject({ version: 3, fileContent: 'completed-native-file', tools: ['Edit'] })
  expect(active.tools).toEqual(['edit'])
  expect(active.roots).toEqual([a.session.header.cwd])
  expect(active.grant).toMatchObject({ maxSamples: 100, maxSampleBytes: 8192 })
  await capture('active', [[await page.evaluate(value => new Date(value).toLocaleString(), active.grant.expiresAt), '{{expiresLocal}}']])
  const address = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (address === undefined) throw new Error('The owner has no transport address')
  const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress: address,
    recipientPeerId: (await receiver.ctx.scopeAccess.identity()).peerId, expiresAt: active.grant.expiresAt,
    responsibility: '使用获准的文件完成文本。' })
  await receiver.ctx.scopeAgentContext.bind({ agentId: b.agent.id, invitation, expectedBindingId: null, automatic: null })
  expect(await prompt('EXISTING_FILE_EDITED')).toBe(aId)
  await expect.poll(async () => {
    const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })
    return { recorded: status.initialization.recordedSamples, pending: status.capture?.pendingSamples }
  }).toEqual({ recorded: 1, pending: 0 })
  const changed = initial.replace(value(0), value(1))
  expect(await readFile(join(project, 'state.ts'), 'utf8')).toBe(changed)
  await run(receiver, b, 'Continue using the available shared context.')
  const received = requests.at(-1)?.find(message => message.source.kind === 'scope-agent-context')
  if (received?.source.kind !== 'scope-agent-context' || received.source.form !== 'snapshot') {
    throw new Error('The next natural receiver request lacks a current shared snapshot')
  }
  const payload = JSON.parse(received.source.projection.text.split('<development-task-context>\n')[1]
    ?.split('\n</development-task-context>')[0] ?? 'null') as unknown
  expect(jsonStrings(payload)).toContain(changed)
  expect(textOf([received])).not.toContain(siblingCanary)
  expect(Buffer.byteLength(textOf([received]), 'utf8')).toBeLessThanOrEqual(8000)
  expect(a.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['read', 'edit'])
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await local.getByRole('button', { name: '停止分享并撤回', exact: true }).click()
  // Stopping may wait for the configured reconciliation cadence before both durable writes settle.
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })).capture,
    { timeout: test.task.timeout }).toBeNull()
  const retained = await owner.ctx.scopeAgentContributions.localStatus({ agentId: aId })
  expect(retained.assignment?.taskId).toBe(task.id)
  expect(await complete.isChecked()).toBe(false)
  await run(receiver, b, 'Continue after the sharing permission ends.')
  expect(textOf(requests.at(-1)?.filter(message => message.source.kind === 'scope-agent-context') ?? [])).not.toContain(untouched)
  expect(await readFile(join(project, 'state.ts'), 'utf8')).toBe(changed)
  expect(ownerConsumption.actual).toBe(4); expect(receiverConsumption.actual).toBe(3)
  expect(b.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
})
