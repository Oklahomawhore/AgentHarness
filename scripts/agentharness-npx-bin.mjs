#!/usr/bin/env node
/** Install the pinned portable runtime shipped alongside this npm entry point. */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readClusterCredential } from './agentharness-cluster.mjs'

const root = import.meta.dirname
const args = process.argv.slice(2)
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  process.stdout.write('Usage: npx --yes @oklahomawhore/agentharness\nInstalls AgentHarness with DeepSeek Harness and starts http://127.0.0.1:3080.\nRequires Node.js 22.19+ (or 24+); macOS/Linux: curl, tar and a SHA-256 utility; Windows x64: PowerShell and tar.\nUse agentharness status, stop, logs or mcp-guide after installation.\n')
} else if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}\n`)
} else if (args.length !== 0) {
  process.stderr.write('agentharness: unsupported arguments; use --help.\n')
  process.exitCode = 1
} else {
  const windows = process.platform === 'win32'
  const installer = join(root, windows ? 'install.ps1' : 'install.sh')
  const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
  if (!supported.includes(`${process.platform}-${process.arch}`) || !existsSync(installer)) {
    process.stderr.write(`agentharness: this release has no installer for ${process.platform}-${process.arch}.\n`)
    process.exitCode = 1
  } else {
    // The installer retains an existing credential; fresh installs own a private cluster.
    let stored
    try {
      stored = await readClusterCredential({ ...process.env, AGENTHARNESS_MESH_SECRET: '' })
    } catch (error) {
      process.stderr.write(`agentharness: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
    const env = {
      ...process.env,
      AGENTHARNESS_MESH_SECRET: stored?.secret || process.env.AGENTHARNESS_MESH_SECRET || randomBytes(32).toString('hex'),
    }
    const result = spawnSync(windows ? 'powershell.exe' : 'sh', windows
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer]
      : [installer], { stdio: 'inherit', env })
    if (result.error) process.stderr.write(`agentharness: ${result.error.message}\n`)
    process.exitCode = result.status ?? 1
  }
}
