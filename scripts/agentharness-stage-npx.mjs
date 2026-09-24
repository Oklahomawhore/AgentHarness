#!/usr/bin/env node
/** Generate a public npm bootstrap package from checksummed portable artifacts. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseStageArguments, stagePortableRelease, validateReleaseBaseUrl } from './agentharness-stage-portable-release.mjs'

const root = resolve(import.meta.dirname, '..')
try {
  const options = parseStageArguments(process.argv.slice(2))
  if (options.clusterSecretFile !== undefined) throw new Error('public npm packages cannot embed cluster credentials')
  if (!validateReleaseBaseUrl(options.baseUrl).startsWith('https://')) throw new Error('public npm packages require an HTTPS artifact origin')
  const release = await stagePortableRelease(options)
  const output = resolve(release.output, 'npm')
  await mkdir(output)
  const files = ['bin.mjs', 'agentharness-cluster.mjs']
  await cp(resolve(root, 'scripts/agentharness-cluster.mjs'), resolve(output, 'agentharness-cluster.mjs'))
  await cp(resolve(root, 'scripts/agentharness-npx-bin.mjs'), resolve(output, 'bin.mjs'))
  for (const source of Object.values(release.installers)) {
    const name = source.endsWith('.ps1') ? 'install.ps1' : 'install.sh'
    await cp(source, resolve(output, name))
    files.push(name)
  }
  await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
  const engines = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).engines
  await writeFile(resolve(output, 'package.json'), `${JSON.stringify({
    name: '@oklahomawhore/agentharness', version: release.version, type: 'module', license: 'MIT',
    author: 'Wangshu Zhu',
    repository: { type: 'git', url: 'git+https://github.com/Oklahomawhore/AgentHarness.git' },
    description: 'Install and start AgentHarness with its bundled DeepSeek Harness runtime',
    bin: { 'agentharness': 'bin.mjs' }, files, engines,
    publishConfig: { access: 'public' },
  }, null, 2)}\n`)
  await writeFile(resolve(output, 'README.md'), '# AgentHarness\n\nRun `npx --yes @oklahomawhore/agentharness` to install the pinned AgentHarness release, including DeepSeek Harness and Node.js, and start the local browser UI. The npm bootstrap itself requires Node.js. macOS/Linux require curl, tar and sha256sum or shasum; Windows x64 requires PowerShell and tar. Each fresh installation creates a private collaboration cluster. Use your own model API key in the browser; no shared provider or cluster credentials are distributed. To join a team, use the installed `agentharness cluster join --secret-stdin` command.\n\nThe installer verifies the SHA-256 of the portable runtime. Re-running downloads the pinned release and retains existing user credentials. The installer also configures supported local MCP clients without overwriting conflicting entries. Use `agentharness status`, `agentharness stop`, `agentharness logs` and `agentharness mcp-guide` after installation.\n')
  process.stdout.write(`Public npm package: ${output}\nRun npm pack in that directory, inspect the tarball, then publish when the HTTPS artifacts are available.\n`)
} catch (error) {
  process.stderr.write(`agentharness-stage-npx: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
