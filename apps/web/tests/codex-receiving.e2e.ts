/** Browser consent and fresh Codex hook output across two independent real scope transports. */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { CodexScopeClientId, CodexScopeHookRequest } from '@deepseek-ai/dsh-codex-scope'
import type {} from '@deepseek-ai/dsh-codex-scope'
import type {} from '@deepseek-ai/dsh-scope-access'
import type {} from '@deepseek-ai/dsh-development-task'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room/types'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { openContributionView } from './contribution-scope-support.ts'
import { saveFailureShot } from './support.ts'

const ROOT_ID = 'codex-browser-root-conversation'
const BEFORE = 'CODEX_BROWSER_BEFORE: the endpoint returns a string identifier.'
const AFTER = 'CODEX_BROWSER_AFTER: the endpoint now returns a structured identifier.'
const REVIEW = 'Hook 定义已配置。在 Codex /hooks 中审阅并启用，然后重新加载；发送一次消息后刷新会话。'
const ACCESS = '[data-emergence-center] details:has(> summary:text-is("独立设备协作"))'

// Only the client CLI boundary is fixture-owned; the setup service inspects and writes its real private files.
async function installFixtureCodex(host: WebScaffold): Promise<void> {
  const fixture = join(host.workspaceCwd, '.mcp-client-fixture')
  const executable = join(fixture, 'bin/codex')
  const state = join(fixture, 'codex-mcp.json')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : '[]');
} else if (args[0] === 'mcp' && args[1] === 'add') {
  const separator = args.indexOf('--');
  const env = {};
  for (let i = 3; i < separator; i += 2) {
    if (args[i] !== '--env') throw new Error('Unexpected CLI fixture argument');
    const entry = args[i + 1];
    const equals = entry.indexOf('=');
    env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  fs.writeFileSync(state, JSON.stringify([{ name: args[2], enabled: true,
    transport: { command: args[separator + 1], args: args.slice(separator + 2), env } }]));
} else { throw new Error('The CLI fixture permits only MCP list and add'); }
`)
  await chmod(executable, 0o700)
}

async function captureControls(page: Page): Promise<void> {
  const shots = process.env.DSH_CODEX_RECEIVING_SHOTS
  if (shots !== undefined) await mkdir(shots, { recursive: true })
  const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  const originalViewport = page.viewportSize()!
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      for (const dark of [false, true]) {
        await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
        const access = page.locator(ACCESS)
        await access.getByRole('button', { name: '停止接收', exact: true }).scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(await access.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        const controls = access.locator('select, button')
        for (const control of await controls.all()) {
          const bounds = await control.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
        }
        if (shots !== undefined) await page.screenshot({
          path: join(shots, `codex-receiving-${dark ? 'dark' : 'light'}-${String(viewport.width)}.png`), fullPage: true,
        })
      }
    }
  } finally {
    await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), originalDark)
    await page.setViewportSize(originalViewport)
  }
}

describe.skipIf(process.platform === 'win32')('web e2e: independent Codex receiving', () => {
  it('configures definitions without a local Task, receives current owner facts, and stops through the browser', async () => {
    if (webSnapshotMode() === 'record') throw new Error('Codex receiving acceptance is keyless and never calls a model')
    const close: (() => Promise<unknown>)[] = []
    const failures: unknown[] = []
    let page: Page | undefined
    try {
      const receiver = await launchWebScaffold({ hermeticMcpClients: true })
      close.push(() => receiver.close())
      await installFixtureCodex(receiver)
      const owner = await launchWebScaffold({ hermeticMcpClients: true })
      close.push(() => owner.close())
      let modelRequests = 0
      for (const host of [receiver, owner]) host.ctx.on('llm/stream', (_request, next) => { modelRequests++; return next() })
      const browser = await chromium.launch()
      close.push(() => browser.close())
      const view = await openContributionView(browser, receiver, true)
      page = view.page
      const access = page.locator(ACCESS)
      await access.locator(':scope > summary').click()
      await access.getByText('尚未配置 Codex 自动接收。配置后仍需在 Codex /hooks 中审阅并启用。', { exact: true }).waitFor()
      expect(receiver.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
      await access.getByRole('button', { name: '配置 Codex 自动接收', exact: true }).click()
      await access.getByText(REVIEW, { exact: true }).waitFor()
      const setup = (await receiver.ctx.mcpClientSetup.list()).clients.find(client => client.id === 'codex')
      if (setup?.automaticContext?.state !== 'configured') throw new Error('Browser setup did not configure Codex hook definitions')
      const hooks = JSON.parse(await readFile(setup.automaticContext.configPath, 'utf8')) as { hooks: Record<string, unknown> }
      expect(Object.keys(hooks.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse'])
      const request: CodexScopeHookRequest = { clientId: setup.participantId as CodexScopeClientId,
        sessionId: ROOT_ID, cwd: receiver.workspaceCwd, event: 'UserPromptSubmit' }
      const signal = new AbortController().signal
      expect(await receiver.ctx.codexScope.hook(request, signal)).toEqual({ output: {} })
      const observed = (await receiver.ctx.codexScope.sessions()).find(session => session.sessionId === ROOT_ID)
      if (observed === undefined) throw new Error('Codex root observation was not retained')
      await access.getByRole('option', { name: `Codex · ${ROOT_ID}`, exact: true }).waitFor({ state: 'attached' })

      const receiverIdentity = await receiver.ctx.scopeAccess.identity()
      const ownerIdentity = await owner.ctx.scopeAccess.identity()
      expect(receiverIdentity.peerId).not.toBe(ownerIdentity.peerId)
      const ownerAddress = ownerIdentity.addresses[0]
      if (ownerAddress === undefined) throw new Error('Owner has no live scope transport address')
      const participantId = 'codex-browser-owner' as DevelopmentParticipantId
      await owner.ctx.developmentRooms.announce({ id: participantId, kind: 'human', displayName: 'Codex browser owner' })
      const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: participantId,
        objective: 'Codex 跨设备接收验收', scope: BEFORE })
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiverIdentity.peerId,
        ownerAddress, responsibility: 'Keep the local client aligned with the API owner.', expiresAt: Date.now() + 3_600_000 })
      await access.getByLabel('粘贴收到的邀请', { exact: true }).fill(JSON.stringify(invitation))
      expect(await access.getByRole('combobox').count()).toBe(1)
      await access.getByRole('combobox').selectOption(`codex:${observed.sessionKey}`)
      await access.getByRole('button', { name: '连接所选会话', exact: true }).click()
      await access.getByRole('button', { name: '停止接收', exact: true }).waitFor()
      const first = await receiver.ctx.codexScope.hook(request, signal)
      const firstText = first.output.hookSpecificOutput?.additionalContext
      expect(firstText).toContain(BEFORE)
      expect(firstText).toContain('"revision":1')
      expect(first.output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit')

      await owner.ctx.developmentTasks.publishContext({ taskId: task.id, participantId, text: AFTER })
      const second = await receiver.ctx.codexScope.hook({ ...request, event: 'PostToolUse' }, signal)
      const secondText = second.output.hookSpecificOutput?.additionalContext
      expect(secondText).toContain(AFTER)
      expect(secondText).toContain('"revision":2')
      expect(secondText).not.toBe(firstText)
      expect(second.output.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
      await captureControls(page)

      await access.getByRole('button', { name: '停止接收', exact: true }).click()
      await access.getByRole('button', { name: '停止接收', exact: true }).waitFor({ state: 'detached' })
      await expect.poll(async () => (await receiver.ctx.codexScope.sessions())[0]?.receiveState).toBe('left')
      const stopped = await receiver.ctx.codexScope.hook({ ...request, event: 'PostToolUse' }, signal)
      const notice = stopped.output.hookSpecificOutput?.additionalContext
      expect(notice).toContain('"status":"left"')
      expect(notice).toContain('This notice does not erase information already present in this conversation.')
      expect(notice).not.toContain(BEFORE)
      expect(notice).not.toContain(AFTER)
      expect(receiver.ctx.developmentTasks.list({ limit: 200 })).toEqual([])
      expect(modelRequests).toBe(0)
      expect(view.errors).toEqual([])
      expect(view.tripwire.pageErrors).toEqual([])
    } catch (error) {
      failures.push(error)
      if (page !== undefined && !page.isClosed()) {
        try {
          const shots = process.env.DSH_CODEX_RECEIVING_SHOTS
          if (shots === undefined) await saveFailureShot(page, 'web-e2e-codex-receiving')
          else { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, 'failure.png'), fullPage: true }) }
        } catch (diagnostic) { failures.push(diagnostic) }
      }
    } finally {
      for (const dispose of close.reverse()) {
        try { await dispose() } catch (error) { failures.push(error) }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Codex receiving browser acceptance failed')
  })
})
