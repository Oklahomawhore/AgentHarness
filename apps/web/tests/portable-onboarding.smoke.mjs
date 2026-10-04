/** Verify a fresh installed portable runtime serves the Workspace onboarding UI in Chromium. */

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { chromium } from 'playwright'


function waitForReady(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`installed portable Web did not start in 90 seconds:\n${output.replace(/([?&]token=)[^\s&#]+/gu, '$1[redacted]')}`))
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
      reject(new Error(`installed portable Web exited before readiness (${String(code)}):\n${output.replace(/([?&]token=)[^\s&#]+/gu, '$1[redacted]')}`))
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

async function configureMcpClient(portableRoot, clientHome, harnessHome, environment) {
  const resolver = createRequire(join(portableRoot, 'package.json'))
  const { setupMcpClient } = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-host-mcp-client-setup')).href)
  const applications = join(clientHome, 'Applications')
  const fixtureBin = join(clientHome, 'bin')
  await mkdir(join(applications, 'Cursor.app'), { recursive: true })
  await mkdir(fixtureBin)
  const result = await setupMcpClient({
    home: clientHome, path: fixtureBin, applicationRoots: [applications], environment,
    nodePath: join(portableRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), dshPath: join(portableRoot, 'lib', 'bin.js'), nodeArgs: [],
    descriptorPath: join(harnessHome, 'mcp', 'connection.json'), harnessHome, username: 'portable-fixture',
  }, { clientId: 'cursor' })
  if (process.platform === 'win32') {
    assert(result.outcome === 'unsupported' && result.client.canSetup === false, 'Windows must report MCP authentication as unsupported')
    return undefined
  }
  assert(result.outcome === 'configured', 'temporary Cursor configuration did not succeed')
  return join(clientHome, '.cursor', 'mcp.json')
}

async function proveMcp(portableRoot, configuration, environment, expectExisting) {
  const result = await promisify(execFile)(process.execPath, [
    resolve(import.meta.dirname, '../../../scripts/agentharness-portable-live-e2e.mjs'),
    '--root', portableRoot, '--config', configuration, ...expectExisting ? ['--expect-existing'] : [],
  ], { env: environment, timeout: 60_000, maxBuffer: 1024 * 1024 })
  const proof = JSON.parse(result.stdout)
  assert(proof.contextInherited === true && proof.independentBindings.length === 2, 'portable MCP proof was incomplete')
  if (expectExisting) assert(proof.restoredTasksBeforeCreate > 0, 'MCP task state did not survive Host restart')
}

async function main(args) {
  if (args.length !== 1) throw new Error('usage: portable-onboarding.smoke.mjs <portable-root>')
  const portableRoot = resolve(args[0])
  const fixture = await mkdtemp(join(tmpdir(), 'agentharness-installed-browser-smoke-'))
  const current = join(fixture, 'current')
  const harnessHome = join(fixture, 'dsh-home')
  await symlink(portableRoot, current, 'dir')
  const clientHome = join(fixture, 'client-home')
  await mkdir(clientHome)
  const environment = {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    HOME: clientHome, USERPROFILE: clientHome, USER: 'portable-fixture', DSH_HOME: harnessHome,
  }
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const start = () => spawn(join(current, 'runtime', runtimeName), [join(current, 'start.mjs'), '--port', '0'], {
    cwd: current,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let child = start()
  let browser
  try {
    const baseUrl = await waitForReady(child)
    const mcpConfiguration = await configureMcpClient(portableRoot, clientHome, harnessHome, environment)
    if (mcpConfiguration !== undefined) await proveMcp(portableRoot, mcpConfiguration, environment, false)
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
    if (mcpConfiguration !== undefined) await proveMcp(portableRoot, mcpConfiguration, environment, true)
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
