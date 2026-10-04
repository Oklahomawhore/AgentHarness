/** Real Web settings persistence and same-machine non-loopback Noise admission; no model requests. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { contributionEntrySchema, contributionProposalSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type {} from '@deepseek-ai/dsh-scope-access'
import type {} from '@deepseek-ai/dsh-development-task'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { openContributionView, type ContributionView } from './contribution-scope-support.ts'
import { saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const LOCAL_IPV4 = Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
  .filter(entry => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
  .map(entry => entry.address)
const OBJECTIVE = '通过局域网地址审批独立来源'

async function networkCard(view: ContributionView): Promise<Locator> {
  await view.page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = view.page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await expect.poll(() => dialog.getByRole('tab', { name: '插件配置', exact: true }).getAttribute('aria-selected'))
    .toBe('true')
  await dialog.getByRole('button', { name: '展开设置: 协作网络', exact: true }).click()
  const card = dialog.locator('[data-scope-network-settings]')
  await card.waitFor()
  return card
}

function assertClean(view: ContributionView): void {
  expect(view.errors).toEqual([])
  expect(view.tripwire.pageErrors).toEqual([])
  expect(view.tripwire.warnings).toEqual([])
}

// This calibration requires a real local non-loopback interface. It does not prove a second physical device can reach it.
describe.skipIf(process.platform === 'win32' || LOCAL_IPV4.length === 0)('web e2e: persistent scope network settings', () => {
  let directory: string | undefined
  let browser: Browser | undefined
  const hosts: WebScaffold[] = []
  const views: ContributionView[] = []
  let modelRequests = 0

  async function boot(harnessHome: string): Promise<WebScaffold> {
    const host = await launchWebScaffold({ harnessHome, hermeticMcpClients: true })
    hosts.push(host)
    host.ctx.on('llm/stream', (_options, next) => { modelRequests += 1; return next() })
    return host
  }

  async function closeHost(host: WebScaffold): Promise<void> {
    const index = hosts.indexOf(host)
    if (index >= 0) hosts.splice(index, 1)
    await host.close()
  }

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('Scope network acceptance does not call a model')
    directory = await mkdtemp(join(tmpdir(), 'dsh-scope-network-browser-'))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    const cleanup = [() => browser?.close(), ...[...hosts].reverse().map(host => () => closeHost(host)),
      () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true })]
    for (const close of cleanup) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Scope network acceptance cleanup failed')
  })

  it('saves through the UI, applies on same-home restart and approves through an advertised non-loopback address', async () => {
    if (directory === undefined || browser === undefined) throw new Error('Scope network fixture was not initialized')
    onTestFailed(async () => {
      for (const [index, view] of views.entries()) {
        if (view.page.isClosed()) continue
        await saveFailureShot(view.page, `web-e2e-scope-network-${String(index)}`)
        console.error('scope network diagnostics', { index, errors: view.errors,
          warnings: view.tripwire.warnings, pageErrors: view.tripwire.pageErrors,
          aria: await view.page.locator('body').ariaSnapshot() })
      }
    })
    const ownerHome = join(directory, 'owner-home')
    await mkdir(ownerHome, { mode: 0o700 })
    const before = await boot(ownerHome)
    const initial = await before.ctx.scopeAccess.identity()
    expect(initial.addresses).toHaveLength(1)
    const portMatch = initial.addresses[0]?.match(/^\/ip4\/127\.0\.0\.1\/tcp\/([1-9]\d*)\/p2p\//)
    if (portMatch?.[1] === undefined) throw new Error('Shipped scope transport did not start on an allocated loopback port')
    // Reuse the actual listener's owned port across restart; do not probe, release, then claim an unrelated free port.
    const port = Number(portMatch[1])
    const listener = `/ip4/0.0.0.0/tcp/${String(port)}`
    const settingsPath = join(ownerHome, 'settings.yaml')
    const firstView = await openContributionView(browser, before, false)
    views.push(firstView)
    const card = await networkCard(firstView)
    await card.getByRole('combobox', { name: '协作连接范围', exact: true }).selectOption('lan')
    await card.getByRole('spinbutton', { name: 'TCP 端口', exact: true }).fill(String(port))
    await firstView.page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '保存', exact: true }).click()
    await firstView.page.getByText('设置已保存；当前监听不会立即改变。请手动重启 Host 后刷新协作地址。', { exact: true }).waitFor()
    await expect.poll(async () => (await readFile(settingsPath, 'utf8')).includes(listener)).toBe(true)
    const desired = before.ctx.settings.describe().find(item => item.ns === 'scope-network')
    expect(desired).toMatchObject({ applies: 'restart', value: { listenAddresses: [listener] } })
    expect(await before.ctx.scopeAccess.identity()).toEqual(initial)
    const saved = await readFile(settingsPath, 'utf8')
    expect(saved).toContain('scope-network:')
    assertClean(firstView)
    await firstView.page.context().close()
    await closeHost(before)
    expect(await readFile(settingsPath, 'utf8')).toBe(saved)

    const owner = await boot(ownerHome)
    const active = await owner.ctx.scopeAccess.identity()
    expect(active.peerId).toBe(initial.peerId)
    const candidates = LOCAL_IPV4.map(address => `/ip4/${address}/tcp/${String(port)}/p2p/${active.peerId}`)
    const selectedAddress = active.addresses.find(address => candidates.includes(address))
    if (selectedAddress === undefined) throw new Error('Restart did not advertise a local non-loopback address at the saved port')
    expect(active.addresses.every(address => address.includes(`/tcp/${String(port)}/p2p/`))).toBe(true)
    expect(await readFile(settingsPath, 'utf8')).toBe(saved)
    const ownerView = await openContributionView(browser, owner, false)
    views.push(ownerView)
    const restoredCard = await networkCard(ownerView)
    expect(await restoredCard.getByRole('combobox', { name: '协作连接范围', exact: true }).inputValue()).toBe('lan')
    expect(await restoredCard.getByRole('spinbutton', { name: 'TCP 端口', exact: true }).inputValue()).toBe(String(port))
    await ownerView.page.keyboard.press('Escape')
    await ownerView.page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
    await ownerView.page.getByRole('button', { name: '打开涌现协作中心', exact: true }).click()
    const panel = ownerView.page.locator('[data-emergence-center]')
    await panel.waitFor()
    await panel.getByLabel('协作显示名', { exact: true }).fill('Network Owner')
    await panel.getByRole('button', { name: '保存身份', exact: true }).click()
    await panel.getByRole('status').getByText('协作身份已生效：Network Owner', { exact: true }).waitFor()
    await panel.getByRole('button', { name: '新建任务', exact: true }).click()
    await panel.getByRole('button', { name: '新建独立任务', exact: true }).click()
    const form = panel.locator('form').filter({ has: ownerView.page.getByLabel('Task 名称', { exact: true }) })
    await form.getByLabel('Task 名称', { exact: true }).fill(OBJECTIVE)
    await form.getByLabel('初始共享上下文', { exact: true }).fill('来源只通过选定的独立设备网络地址申请授权。')
    await form.getByRole('button', { name: '创建任务', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    await panel.getByRole('heading', { name: OBJECTIVE, exact: true }).waitFor()
    const access = ownerView.page.locator('[data-emergence-center] details:has(> summary:text-is("独立设备协作"))')
    await access.locator(':scope > summary').click()
    const contribution = ownerView.page.locator('[data-scope-contribution-owner]')
    await contribution.locator(':scope > summary').click()
    const addressInput = contribution.getByRole('combobox', { name: '邀请使用的本机地址', exact: true })
    await expect.poll(() => addressInput.isEnabled()).toBe(true)
    await addressInput.selectOption(selectedAddress)
    expect(await addressInput.inputValue()).toBe(selectedAddress)
    const applications = contribution.locator('[data-contribution-applications]')
    await applications.getByRole('combobox', { name: '入口用途', exact: true }).selectOption('contribution')
    await applications.getByLabel('申请入口有效期（小时）', { exact: true }).fill('1')
    await applications.getByRole('button', { name: '生成一次申请入口', exact: true }).click()
    const entryText = await applications.getByRole('textbox', { name: '将此入口交给来源用户', exact: true }).inputValue()
    const entry = contributionEntrySchema.parse(JSON.parse(entryText))
    expect(entry).toMatchObject({ kind: 'contribution-entry', sourceKind: 'tool-observations', ownerAddress: selectedAddress,
      ownerPeerId: initial.peerId })
    const task = owner.ctx.developmentTasks.list({ limit: 200 }).find(item => item.objective === OBJECTIVE)
    expect(entry.taskId).toBe(task?.id)

    // The second independent Host uses the production application protocol, not a loopback-rewritten fixture route.
    const sourceHome = join(directory, 'source-home')
    await mkdir(sourceHome, { mode: 0o700 })
    const source = await boot(sourceHome)
    const sourceIdentity = await source.ctx.scopeAccess.identity()
    expect(sourceIdentity.peerId).not.toBe(active.peerId)
    const proposal = contributionProposalSchema.parse({ contributorPeerId: sourceIdentity.peerId,
      captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'network-source', tools: ['Write'] } })
    const request = { entry, proposal, limits: { expiresAt: entry.expiresAt, maxSamples: 2, maxSampleBytes: 4096 } }
    expect(await source.ctx.scopeAccess.applyContribution(request, AbortSignal.timeout(15_000))).toEqual({ status: 'pending' })
    await applications.getByRole('status').getByText('收到申请，等待你的批准', { exact: true }).waitFor()
    await applications.getByRole('button', { name: '批准并让来源自动启用', exact: true }).click()
    await applications.getByRole('status').getByText('已批准，来源将自动取回授权', { exact: true }).waitFor()
    const approved = await source.ctx.scopeAccess.contributionApplicationStatus({ entry, proposal }, AbortSignal.timeout(15_000))
    expect(approved.status).toBe('approved')
    if (approved.status !== 'approved') throw new Error(`Network approval was not available: ${approved.status}`)
    expect(approved.invitation.ownerAddress).toBe(selectedAddress)
    expect(approved.invitation.grant).toMatchObject({ ownerPeerId: active.peerId, contributorPeerId: sourceIdentity.peerId,
      captureId: proposal.captureId, captureGeneration: proposal.captureGeneration, taskId: entry.taskId })
    expect(owner.ctx.developmentTasks.peerContributions({ taskId: entry.taskId }).map(item => item.grant))
      .toEqual([approved.invitation.grant])
    expect(source.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
    expect(modelRequests).toBe(0)
    assertClean(ownerView)
    console.info('scope network acceptance', { calibration: 'same-machine-non-loopback', peerIdPreserved: true,
      listenerChangedOnlyAfterRestart: true, selectedAddress, fixedPort: port, independentHosts: 2,
      applicationStatus: approved.status, modelRequests })
  })
})
