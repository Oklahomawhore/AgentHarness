#!/usr/bin/env node
/** Build a source-free, relocatable AgentHarness directory and tar archive. */

import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const HOST_TARGET = `${process.platform}-${process.arch}`
const DEFAULT_OUTPUT = join(root, 'dist', 'agentharness-portable', HOST_TARGET)
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const REQUIRED_ASSETS = [
  { label: 'CLI', paths: ['lib/bin.js'] },
  { label: 'bundled Node license', paths: ['runtime/NODE_LICENSE'] },
  { label: 'installed command', paths: ['agentharness.mjs'] },
  { label: 'cluster credential helper', paths: ['agentharness-cluster.mjs'] },
  { label: 'stable collaboration node identity', paths: ['agentharness-node-identity.mjs'] },
  {
    label: 'Web frontend',
    paths: [
      'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
      'node_modules/.pnpm/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    ],
  },
  { label: 'Web bundle', paths: ['node_modules/@deepseek-ai/dsh-web-app/package.json'] },
  { label: 'AgentHarness MCP bridge', paths: ['node_modules/@deepseek-ai/dsh-agentharness-bridge/lib/bin.js'] },
]
/** @type {Readonly<Record<string, readonly string[]>>} */
const TARGET_NATIVE_PACKAGES = {
  'win32-x64': [
    '@img/sharp-win32-x64',
    '@koromix/koffi-win32-x64',
    '@vscode/ripgrep-win32-x64',
    'node-addon-require-builtin-win32-x64-msvc',
  ],
}
const RUNTIME_SOURCE_ALLOWLIST = new Set([
  // Native package sources are runtime inputs for platform fallback builds,
  // not Harness workspace application source.
  'node_modules/@deepseek-ai/node-addon-landlock-run/src',
])

function isAllowedRuntimeSource(path) {
  return RUNTIME_SOURCE_ALLOWLIST.has(path)
    || path.endsWith('/@deepseek-ai/node-addon-landlock-run/src')
}

/** Parse portable-pack flags without accepting ambiguous positional input. */
export function parsePortableArguments(args) {
  let out = DEFAULT_OUTPUT
  let target = HOST_TARGET
  let runtimeExecutable
  let runtimeLicense
  let skipBuild = false
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    else if (argument === '--skip-build') skipBuild = true
    else if (argument === '--dry-run') dryRun = true
    else if (argument === '--target') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--target needs a platform-architecture value')
      target = value
      index += 1
    } else if (argument?.startsWith('--target=')) {
      target = argument.slice('--target='.length)
    } else if (argument === '--runtime-executable') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--runtime-executable needs a file')
      runtimeExecutable = resolve(value)
      index += 1
    } else if (argument === '--runtime-license') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--runtime-license needs a file')
      runtimeLicense = resolve(value)
      index += 1
    } else if (argument === '--out') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--out needs a directory')
      out = resolve(value)
      index += 1
    } else if (argument?.startsWith('--out=')) {
      const value = argument.slice('--out='.length)
      if (value === '') throw new Error('--out needs a directory')
      out = resolve(value)
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`)
    }
  }
  if (!SUPPORTED_TARGETS.has(target)) throw new Error(`unsupported portable target ${JSON.stringify(target)}`)
  if (target !== HOST_TARGET && (runtimeExecutable === undefined || runtimeLicense === undefined)) {
    throw new Error('cross-platform packaging requires --runtime-executable and --runtime-license')
  }
  return { out, target, runtimeExecutable, runtimeLicense, skipBuild, dryRun }
}

/** Refuse an output path that could clear the repository or one of its ancestors. */
export function validatePortableOutput(output) {
  const normalized = resolve(output)
  if (normalized === root || root.startsWith(`${normalized}${sep}`)) {
    throw new Error(`portable output cannot contain the repository root: ${normalized}`)
  }
  return normalized
}

/** Resolve the pnpm JavaScript entry point on Windows, where pnpm.CMD cannot be spawned directly. */
export function portableCommand(command, args, platform = process.platform, pnpmHome = process.env.PNPM_HOME) {
  if (command !== 'pnpm' || platform !== 'win32') return { command, args }
  if (!pnpmHome) throw new Error('PNPM_HOME is required to run pnpm while packing on Windows')
  return { command: process.execPath, args: [resolve(pnpmHome, '..', 'pnpm', 'bin', 'pnpm.cjs'), ...args] }
}

function runChecked(command, args, dryRun) {
  if (dryRun) {
    process.stdout.write(`${[command, ...args].map(value => JSON.stringify(value)).join(' ')}\n`)
    return
  }
  const invocation = portableCommand(command, args)
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error === undefined ? `exit code ${String(result.status)}` : result.error.message
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`, { cause: result.error })
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function workspaceRuntimeClosure() {
  const manifests = new Map()
  for (const relativePath of globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })) {
    const path = join(root, relativePath)
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (typeof manifest.name === 'string') manifests.set(manifest.name, { directory: dirname(path), manifest })
  }
  const cli = JSON.parse(await readFile(join(root, 'apps', 'cli', 'package.json'), 'utf8'))
  const queue = Object.keys(cli.dependencies ?? {}).filter(name => manifests.has(name))
  const closure = new Set(queue)
  for (let index = 0; index < queue.length; index += 1) {
    const current = manifests.get(queue[index])?.manifest
    if (current === undefined) continue
    const candidates = {
      ...current.dependencies,
      ...current.optionalDependencies,
      ...Object.fromEntries(Object.entries(current.peerDependencies ?? {})
        .filter(([name]) => current.peerDependenciesMeta?.[name]?.optional !== true)),
    }
    for (const name of Object.keys(candidates)) {
      if (!manifests.has(name) || closure.has(name)) continue
      closure.add(name)
      queue.push(name)
    }
  }
  return { manifests, names: [...closure].sort() }
}

/**
 * Flatten deployed workspace packages and overlay their complete built `lib`.
 *
 * pnpm deploy follows each package's publish `files` list. That is useful for
 * npm publication, but a tsdown chunk can be runtime-required without being a
 * named public entry. The flat link is also the installation-owned resolution
 * layer used by profile Loader entries. Replacing only `lib` makes the portable
 * runtime closed over the build plane while retaining pnpm's isolated
 * dependency links and package-owned runtime assets.
 */
export async function materializePortableWorkspaceClosure(output, target = HOST_TARGET) {
  const closure = await workspaceRuntimeClosure()
  for (const name of closure.names) {
    const destination = join(output, 'node_modules', ...name.split('/'))
    const canonical = join(output, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'))
    if (!await pathExists(destination) && await pathExists(canonical)) {
      await mkdir(dirname(destination), { recursive: true })
      if (target.startsWith('win32-')) await cp(canonical, destination, { recursive: true, dereference: true })
      else await symlink(relative(dirname(destination), canonical), destination, 'dir')
    }
    const source = closure.manifests.get(name)?.directory
    if (source === undefined) throw new Error(`portable workspace package cannot be resolved: ${name}`)
    if (!await pathExists(destination)) {
      // pnpm omits a peer-only workspace package from the production graph.
      // These contract packages have no third-party runtime dependencies; the
      // flattened workspace closure satisfies their workspace peers.
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter(path) {
          const first = relative(source, path).split(sep)[0]
          return first === '' || !['.git', 'node_modules', 'src', 'tests'].includes(first)
        },
      })
    }
    // `destination` is normally a pnpm symlink. Replace only its real `lib`
    // directory so generated node_modules dependency links stay intact. pnpm
    // may hard-link published files to the workspace, so unlink before copy.
    const deployedPackage = await realpath(destination)
    const builtLibrary = join(source, 'lib')
    if (!await pathExists(builtLibrary)) continue
    await rm(join(deployedPackage, 'lib'), { recursive: true, force: true })
    await cp(builtLibrary, join(deployedPackage, 'lib'), { recursive: true, dereference: true })
  }
}

/**
 * Reject missing runtime assets, source-control metadata, and workspace source trees.
 * @param {string} output - Extracted portable root.
 * @param {readonly string[]} [expectedWorkspacePackages] - Injectable closure for focused tests; production derives the complete closure.
 */
export async function verifyPortablePayload(output, expectedWorkspacePackages, target = HOST_TARGET) {
  const missing = []
  const runtimeName = target.startsWith('win32-') ? 'node.exe' : 'node'
  for (const asset of [{ label: 'bundled Node runtime', paths: [`runtime/${runtimeName}`] }, ...REQUIRED_ASSETS]) {
    if (!(await Promise.all(asset.paths.map(path => pathExists(join(output, path))))).some(Boolean)) {
      missing.push(asset.label)
    }
  }
  if (missing.length > 0) throw new Error(`portable payload is missing: ${missing.join(', ')}`)

  const missingNativePackages = (TARGET_NATIVE_PACKAGES[target] ?? []).filter(name =>
    !globSync(join(output, 'node_modules', ...name.split('/'))).length
    && !globSync(join(output, 'node_modules', '.pnpm', `${name.replace('/', '+')}@*`)).length)
  if (missingNativePackages.length > 0) {
    throw new Error(`portable payload is missing ${target} native packages: ${missingNativePackages.join(', ')}`)
  }

  const workspacePackages = expectedWorkspacePackages ?? (await workspaceRuntimeClosure()).names
  const missingWorkspacePackages = workspacePackages.filter(name =>
    !globSync(join(output, 'node_modules', ...name.split('/'))).length)
  if (missingWorkspacePackages.length > 0) {
    throw new Error(`portable payload is missing workspace runtime packages: ${missingWorkspacePackages.join(', ')}`)
  }

  const pending = [output]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const local = relative(output, path).split(sep).join('/')
      if (entry.name === '.git' || local.includes('/.git/')) {
        throw new Error(`portable payload contains Git metadata: ${local}`)
      }
      if (entry.isDirectory()) {
        if (/(?:^|\/)node_modules\/@deepseek-ai\/[^/]+\/src(?:\/|$)/u.test(`${local}/`)
          && !isAllowedRuntimeSource(local)) {
          throw new Error(`portable payload contains workspace source: ${local}`)
        }
        pending.push(path)
      }
    }
  }
}

/** Remove build-time workspace sources while retaining native fallback inputs. */
export async function prunePortableSources(output) {
  const sources = globSync([
    'node_modules/@deepseek-ai/*/src',
    'node_modules/.pnpm/*/node_modules/@deepseek-ai/*/src',
  ], { cwd: output })
  for (const local of sources) {
    if (isAllowedRuntimeSource(local)) continue
    await rm(join(output, local), { recursive: true, force: true })
  }
}

async function rejectPortableLinks(output) {
  const pending = [output]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Windows portable payload contains a symbolic link: ${relative(output, path)}`)
      if (entry.isDirectory()) pending.push(path)
    }
  }
}

async function writeLaunchers(output, options) {
  await cp(join(root, 'scripts', 'agentharness-portable-start.mjs'), join(output, 'start.mjs'))
  await cp(join(root, 'scripts', 'agentharness-cluster.mjs'), join(output, 'agentharness-cluster.mjs'))
  await cp(join(root, 'scripts', 'agentharness-node-identity.mjs'), join(output, 'agentharness-node-identity.mjs'))
  await cp(join(root, 'scripts', 'agentharness-portable-mcp.mjs'), join(output, 'mcp.mjs'))
  await cp(join(root, 'scripts', 'agentharness-portable-command.mjs'), join(output, 'agentharness.mjs'))
  const [platform, arch] = options.target.split('-')
  const runtimeName = platform === 'win32' ? 'node.exe' : 'node'
  const licenseCandidates = [
    options.runtimeLicense,
    join(dirname(process.execPath), 'LICENSE'),
    resolve(dirname(process.execPath), '..', 'LICENSE'),
  ].filter(path => path !== undefined)
  const nodeLicense = (await Promise.all(licenseCandidates.map(async path => await pathExists(path) ? path : undefined)))
    .find(path => path !== undefined)
  if (nodeLicense === undefined) throw new Error(`cannot locate the Node.js LICENSE beside ${process.execPath}`)
  await mkdir(join(output, 'runtime'), { recursive: true })
  await cp(options.runtimeExecutable ?? process.execPath, join(output, 'runtime', runtimeName))
  await cp(nodeLicense, join(output, 'runtime', 'NODE_LICENSE'))
  await chmod(join(output, 'runtime', runtimeName), 0o755)
  await writeFile(join(output, 'start.sh'), '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/runtime/node" "$root/start.mjs" "$@"\n', { mode: 0o755 })
  await writeFile(join(output, 'start.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0start.mjs" %*\r\n')
  const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
  await writeFile(join(output, 'agentharness-portable.json'), `${JSON.stringify({
    formatVersion: 1,
    product: 'AgentHarness',
    version: process.env.AGENTHARNESS_RELEASE_VERSION ?? manifest.version,
    platform,
    arch,
    entry: 'start.mjs',
    mcpEntry: 'mcp.mjs',
    runtime: { node: `runtime/${runtimeName}` },
  }, null, 2)}\n`)
}

/** Build and archive one portable runtime, with native execution smoke on the host target. */
export async function buildPortable(options) {
  if (process.env.AGENTHARNESS_RELEASE_VERSION !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(process.env.AGENTHARNESS_RELEASE_VERSION)) {
    throw new Error('AGENTHARNESS_RELEASE_VERSION must be a semantic version')
  }
  const output = validatePortableOutput(options.out)
  const archive = resolve(dirname(output), `agentharness-${options.target}.tgz`)
  if (!options.skipBuild) runChecked('pnpm', ['run', 'build'], options.dryRun)
  if (options.dryRun) {
    process.stdout.write(`prepare ${JSON.stringify(output)}\n`)
  } else {
    await rm(output, { recursive: true, force: true })
    await mkdir(dirname(output), { recursive: true })
  }
  runChecked('pnpm', [
    '--filter', '@deepseek-ai/dsh',
    'deploy', '--prod',
    '--config.inject-workspace-packages=true',
    // The workspace postinstall identity becomes an absolute file URL inside
    // pnpm deploy and no longer matches the reviewed workspace allowBuilds
    // key. Keep third-party allowBuilds enforcement, then execute that one
    // reviewed chmod-only script explicitly after materialization below.
    '--config.strict-dep-builds=false',
    ...options.target.startsWith('win32-') ? ['--config.node-linker=hoisted'] : [],
    output,
  ], options.dryRun)
  if (options.dryRun) {
    process.stdout.write(`write portable launchers in ${JSON.stringify(output)}\n`)
    process.stdout.write(`archive ${JSON.stringify(archive)}\n`)
    return { output, archive }
  }
  await materializePortableWorkspaceClosure(output, options.target)
  const spawnHelperCandidates = [
    join(output, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'scripts', 'ensure-spawn-helper.mjs'),
    join(output, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'scripts', 'ensure-spawn-helper.mjs'),
  ]
  const spawnHelper = (await Promise.all(spawnHelperCandidates.map(async path => await pathExists(path) ? path : undefined)))
    .find(path => path !== undefined)
  if (spawnHelper === undefined) throw new Error('portable payload is missing the subprocess spawn-helper installer')
  runChecked(process.execPath, [spawnHelper], false)
  if (options.target.startsWith('win32-')) {
    for (const binDirectory of globSync(['node_modules/.bin', 'node_modules/**/.bin'], { cwd: output })) {
      await rm(join(output, binDirectory), { recursive: true, force: true })
    }
  }
  await prunePortableSources(output)
  await writeLaunchers(output, options)
  await verifyPortablePayload(output, undefined, options.target)
  if (options.target.startsWith('win32-')) await rejectPortableLinks(output)
  if (options.target === HOST_TARGET) {
    runChecked(process.execPath, [
      join(root, 'apps', 'web', 'tests', 'portable-onboarding.smoke.mjs'),
      output,
    ], false)
  }
  await rm(archive, { force: true })
  runChecked('tar', ['-czf', archive, '-C', output, '.'], false)
  process.stdout.write(`AgentHarness portable directory: ${output}\n`)
  process.stdout.write(`AgentHarness portable archive: ${archive}\n`)
  return { output, archive }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  buildPortable(parsePortableArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`agentharness-pack-portable: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
