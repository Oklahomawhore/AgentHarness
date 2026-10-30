/** Real Web composition recovers presence, selected lineage, and exhausted source capacity. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { DevelopmentParticipantId, DevelopmentTaskId } from '@deepseek-ai/dsh-development-task'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const overlay = fileURLToPath(new URL('./participant-recovery.overlay.yml', import.meta.url))
const expected = fileURLToPath(new URL('./expected/participant-recovery/online.expected.md', import.meta.url))
const owner = 'human-fixture-owner' as DevelopmentParticipantId
const receiver = 'human-recovery' as DevelopmentParticipantId

describe('web e2e: participant refresh recovery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let taskId: DevelopmentTaskId
  const handles: AgentHandle[] = []
  const errors: string[] = []
  const releaseDirectory = Promise.withResolvers<undefined>()
  let announcements = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ hermeticMcpClients: true, extraOverlayPath: overlay })
    await scaffold.ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Fixture owner' })
    const root = await scaffold.ctx.developmentTasks.create({ createdBy: owner, objective: '目录恢复根任务',
      scope: 'Host-owned query bounds', origin: { kind: 'root' } })
    taskId = root.id
    const first = await scaffold.ctx.developmentTasks.create({ createdBy: owner, objective: '目录恢复分支',
      scope: 'Host-owned query bounds', origin: { kind: 'fork', parent: { taskId: root.id, revision: root.revision } } })
    await scaffold.ctx.developmentTasks.create({ createdBy: owner, objective: '目录恢复末级', scope: 'Host-owned query bounds',
      origin: { kind: 'fork', parent: { taskId: first.id, revision: first.revision } } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.addInitScript(({ id }) => {
      localStorage.setItem('dsh.emergence-center.profile.v1', JSON.stringify({ id, displayName: '恢复验收用户' }))
    }, { id: receiver })
    await page.route('**/api/developmentRooms/list', async (route) => {
      await releaseDirectory.promise
      await route.continue()
    })
    await page.route('**/api/developmentRooms/announce', async (route) => {
      announcements++
      if (announcements === 1) await route.abort('failed')
      else await route.continue()
    })
    const url = new URL(scaffold.authenticatedUrl)
    url.hash = 'agentharness=collaboration'
    await page.goto(url.href, { waitUntil: 'load' })
    await page.waitForSelector('[data-emergence-center]', { timeout: 30_000 })
    releaseDirectory.resolve(undefined)
  }, 120_000)

  afterAll(async () => {
    releaseDirectory.resolve(undefined)
    await page?.unrouteAll({ behavior: 'wait' })
    for (const handle of handles.reverse()) await handle.dispose()
    await browser?.close()
    await scaffold?.close()
  })

  it('retries the announcement on Refresh and reads lineage within the configured Host capacity', async () => {
    onTestFailed(async () => {
      console.log('Participant recovery requests', { announcements, errors })
      await saveFailureShot(page, 'web-e2e-participant-recovery')
    })
    const panel = page.locator('[data-emergence-center]')
    await expect.poll(() => errors.some(error => error.includes('participant synchronization failed')), { timeout: 10_000 }).toBe(true)
    expect(announcements).toBe(1)
    expect(scaffold.ctx.developmentRooms.list().participants.some(participant => participant.id === receiver)).toBe(false)
    await panel.getByText('边界外还有 1 个任务，可选中节点继续展开', { exact: true }).waitFor({ timeout: 10_000 })
    expect(scaffold.ctx.developmentTasks.list({})).toHaveLength(2)

    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    const status = panel.getByRole('status').filter({ hasText: '协作身份已生效：恢复验收用户' })
    await status.waitFor({ timeout: 10_000 })
    expect(announcements).toBe(2)
    await panel.getByText('边界外还有 1 个任务，可选中节点继续展开', { exact: true }).waitFor({ timeout: 10_000 })
    expect(scaffold.ctx.developmentRooms.list().participants).toContainEqual(expect.objectContaining({
      id: receiver, displayName: '恢复验收用户', presence: 'online',
    }))
    await compareOrRefreshGolden(expected, await status.ariaSnapshot(), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('reclaims stopped SQLite-backed source Sessions without resetting their observed revisions', async () => {
    const grant = async (name: string) => {
      const handle = await scaffold.ctx.agents.create({ sessionId: SessionId(name),
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
      handles.push(handle)
      const agentId = handle.agent.id
      const participantId = developmentAgentParticipantId(agentId)
      await expect.poll(() => scaffold.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
      await scaffold.ctx.developmentTasks.checkout({ taskId, participantId })
      const status = await scaffold.ctx.scopeAgentContributions.localStatus({ agentId })
      if (status.assignment === null) throw new Error('Source Task assignment missing')
      return { agentId, ...status.assignment, expectedCapture: null, sourceKind: 'completed-turn-outcomes' as const,
        limits: { expiresAt: Date.now() + 60_000, maxSamples: 1, maxSampleBytes: 8192 } }
    }
    const first = await grant('capacity-first')
    const second = await grant('capacity-second')
    const started = await scaffold.ctx.scopeAgentContributions.requestLocal(first)
    if (started.capture === null) throw new Error('First source capture missing')
    await expect.poll(async () => (await scaffold.ctx.scopeAgentContributions.localStatus(first)).capture?.collecting).toBe(true)
    await scaffold.ctx.scopeAgentContributions.stopLocal({ agentId: first.agentId, expectedCapture: started.capture.selection })
    await expect.poll(async () => (await scaffold.ctx.scopeAgentContributions.localStatus(first)).capture).toBeNull()
    const stopped = await scaffold.ctx.scopeAgentContributions.localStatus(first)
    const next = await scaffold.ctx.scopeAgentContributions.requestLocal(second)
    if (next.capture === null) throw new Error('Replacement source capture missing')
    await expect.poll(async () => (await scaffold.ctx.scopeAgentContributions.localStatus(second)).capture?.collecting).toBe(true)
    expect((await scaffold.ctx.scopeAgentContributions.localStatus(first)).revision).toBeGreaterThanOrEqual(stopped.revision)
    await expect(scaffold.ctx.scopeAgentContributions.requestLocal(first)).rejects.toThrow('source inventory is full')
    await scaffold.ctx.scopeAgentContributions.stopLocal({ agentId: second.agentId, expectedCapture: next.capture.selection })
    await expect.poll(async () => (await scaffold.ctx.scopeAgentContributions.localStatus(second)).capture).toBeNull()
    const renewed = await scaffold.ctx.scopeAgentContributions.requestLocal(first)
    expect(renewed.capture).not.toBeNull()
    expect(renewed.revision).toBeGreaterThan(stopped.revision)
    expect(handles.every(handle => handle.agent.session.snapshotEvents().every(event => event.type !== 'step/start'))).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  })
})
