// Web e2e scenario: the shipped workbench starts a real managed subprocess,
// gates its iframe on HTTP readiness, and restores browser-local choices.
// Zero model calls: a stray stream fails loud through the scaffold's route-only
// adapter.
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/dev-workbench', import.meta.url))
const WAITING_EXPECTED = join(SNAPSHOT_DIR, 'waiting.expected.md')
const FIXTURE = fileURLToPath(new URL('./support/dev-workbench-fixture.mjs', import.meta.url))
const MODE = webSnapshotMode()

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return port
}

describe('web e2e: development workbench', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let overlayRoot: string
  let fixtureOrigin: string
  let fixturePort: number
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    fixturePort = await reservePort()
    overlayRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-workbench-'))
    const overlayPath = join(overlayRoot, 'cordis.patch.yml')
    fixtureOrigin = `http://127.0.0.1:${String(fixturePort)}`
    await writeFile(overlayPath, `
- id: dev-workbench
  config:
    entries:
      example-agent:
        label: Example Agent
        cwd: ${JSON.stringify(dirname(FIXTURE))}
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(FIXTURE)}, ${JSON.stringify(String(fixturePort))}]
        views:
          - id: agent
            label: Agent
            url: ${fixtureOrigin}/chat
          - id: local-debug
            label: Local-debug
            url: ${fixtureOrigin}/local-debug
        readiness:
          url: ${fixtureOrigin}/ready
          acceptedStatusCodes: [200]
          intervalMs: 100
          requestTimeoutMs: 500
          warnAfterMs: 5000
    maxOutputBytes: 8192
    graceMs: 1000
`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlayPath })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (overlayRoot !== undefined) await rm(overlayRoot, { recursive: true, force: true })
  })

  it('gates the view on readiness and restores view and size after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-dev-workbench'))
    await page.getByRole('button', { name: '打开开发工作台' }).click()
    const panel = page.locator('[data-dev-workbench]')
    await panel.getByRole('button', { name: 'Local-debug', exact: true }).click()
    await panel.getByRole('button', { name: '启动', exact: true }).click()
    await panel.getByText('等待页面就绪', { exact: true }).waitFor({ timeout: 5_000 })
    await panel.getByText('HTTP 503', { exact: true }).waitFor({ timeout: 5_000 })

    const waiting = (await captureStableAria(page, '[data-dev-workbench]', scaffold.workspaceCwd))
      .split(process.execPath).join('{{node}}')
      .split(FIXTURE).join('{{fixture}}')
      .split(fixtureOrigin).join('{{fixtureOrigin}}')
      .split(String(fixturePort)).join('{{fixturePort}}')
    await compareOrRefreshGolden(WAITING_EXPECTED, waiting, MODE)

    const frame = panel.locator('iframe[title="Local-debug"]')
    await frame.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => page.frames().some(candidate => candidate.url().endsWith('/local-debug')),
      { timeout: 5_000 },
    ).toBe(true)

    const before = await panel.boundingBox()
    const handle = panel.getByRole('separator', { name: '拖动左下角调整工作台大小' })
    const handleBox = await handle.boundingBox()
    if (before === null || handleBox === null) throw new Error('workbench geometry is unavailable')
    await page.mouse.move(handleBox.x + 4, handleBox.y + handleBox.height - 4)
    await page.mouse.down()
    await page.mouse.move(handleBox.x - 76, handleBox.y + handleBox.height + 36)
    await page.mouse.up()
    const resized = await panel.boundingBox()
    if (resized === null) throw new Error('resized workbench geometry is unavailable')
    expect(resized.width).toBeGreaterThan(before.width)
    expect(resized.height).toBeGreaterThan(before.height)

    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: '打开开发工作台' }).click()
    const restored = page.locator('[data-dev-workbench]')
    await restored.locator('iframe[title="Local-debug"]').waitFor({ timeout: 10_000 })
    const restoredBox = await restored.boundingBox()
    expect(restoredBox?.width).toBeCloseTo(resized.width, 0)
    expect(restoredBox?.height).toBeCloseTo(resized.height, 0)
    await restored.getByRole('button', { name: '停止', exact: true }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['waiting.expected.md'])
  })
})
