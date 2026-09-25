#!/usr/bin/env node
/** Verify a fresh installed portable runtime serves the Workspace onboarding UI in Chromium. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { chromium } from 'playwright'


function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => { reject(new Error('portable browser smoke received no TCP port')) })
        return
      }
      server.close(() => { resolvePort(address.port) })
    })
  })
}

function waitForReady(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`installed portable Web did not start in 90 seconds:\n${output}`))
    }, 90_000)
    const read = (chunk) => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolveReady(match[1])
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`installed portable Web exited before readiness (${String(code)}):\n${output}`))
    })
    child.once('error', reject)
  })
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  try {
    child.kill('SIGINT')
    await exited
  } finally {
    clearTimeout(timer)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function dismissFirstRunSteps(page) {
  const firstDialog = page.locator('[role="dialog"]').first()
  await firstDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  for (let step = 0; step < 2; step += 1) {
    const welcome = page.getByRole('dialog', { name: '内测声明' })
    if (await welcome.isVisible()) {
      await welcome.getByRole('button', { name: '继续', exact: true }).click()
      await welcome.waitFor({ state: 'detached', timeout: 15_000 })
      await firstDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
      continue
    }
    const credential = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    if (!await credential.isVisible()) return
    await credential.getByRole('button', { name: '稍后配置', exact: true }).click()
    await credential.waitFor({ state: 'detached', timeout: 15_000 })
    return
  }
}

async function main(args) {
  if (args.length !== 1) throw new Error('usage: portable-onboarding.smoke.mjs <portable-root>')
  const portableRoot = resolve(args[0])
  const fixture = await mkdtemp(join(tmpdir(), 'agentharness-installed-browser-smoke-'))
  const current = join(fixture, 'current')
  const harnessHome = join(fixture, 'dsh-home')
  await symlink(portableRoot, current, 'dir')
  const port = await freePort()
  const environment = { ...process.env, DSH_HOME: harnessHome }
  delete environment.DEEPSEEK_API_KEY
  delete environment.AGENTHARNESS_PROVIDER_API_KEY
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const start = () => spawn(join(current, 'runtime', runtimeName), [join(current, 'start.mjs'), '--port', String(port)], {
    cwd: current,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let child = start()
  let browser
  try {
    const baseUrl = await waitForReady(child)
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await dismissFirstRunSteps(page)

    const chooser = page.getByRole('button', { name: '选择工作区', exact: true })
    await chooser.waitFor({ timeout: 15_000 })
    assert(await chooser.isVisible(), 'Workspace chooser is not visible')
    assert((await page.locator('body').innerText()).includes('选择一个工作区开始'), 'fresh Workspace prompt is absent')
    assert(pageErrors.length === 0, `portable browser raised page errors: ${pageErrors.join('; ')}`)
    const credentialsPath = join(harnessHome, '.credentials.yaml')
    const credentials = await readFile(credentialsPath, 'utf8')
    await stop(child)
    child = start()
    const restartedUrl = await waitForReady(child)
    const restartedPage = await page.goto(restartedUrl, { waitUntil: 'domcontentloaded' })
    assert(restartedPage?.ok(), 'restarted portable Web endpoint is unavailable')
    assert(await readFile(credentialsPath, 'utf8') === credentials, 'restart changed persisted credentials')
    process.stdout.write(`Installed portable browser smoke passed: ${basename(portableRoot)}\n`)
  } finally {
    await browser?.close()
    await stop(child)
    await rm(fixture, { recursive: true, force: true })
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`portable-onboarding-smoke: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
