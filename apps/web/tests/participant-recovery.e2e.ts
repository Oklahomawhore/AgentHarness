/** Real Web composition recovers one failed presence request without reloading the page. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-task'
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
  const errors: string[] = []
  const releaseDirectory = Promise.withResolvers<undefined>()
  let announcements = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ hermeticMcpClients: true, extraOverlayPath: overlay })
    await scaffold.ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Fixture owner' })
    const root = await scaffold.ctx.developmentTasks.create({ createdBy: owner, objective: '目录恢复根任务',
      scope: 'Host-owned query bounds', origin: { kind: 'root' } })
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
    expect(scaffold.ctx.developmentRooms.list().participants).toContainEqual(expect.objectContaining({
      id: receiver, displayName: '恢复验收用户', presence: 'online',
    }))
    await compareOrRefreshGolden(expected, await status.ariaSnapshot(), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
