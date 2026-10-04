/** Owns one bounded Docker execution and its host IPC proxy; the oracle remains outside its mounts. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { z } from 'zod'

/** Explicit deployment limits and the single role directory visible to a program. */
export interface DockerProgramRequest {
  readonly imageDigest: string
  readonly dockerPath: string
  readonly dockerHost: string
  readonly nodePath: string
  readonly mode: 'client' | 'tests'
  readonly target: string
  readonly runner: string
  readonly root: string
  readonly timeoutMs: number
  readonly memoryBytes: number
  readonly cpus: number
  readonly pidsLimit: number
  readonly tmpBytes: number
  readonly maxWireBytes: number
  readonly maxDiagnosticBytes: number
  readonly cleanupTimeoutMs: number
}

/** Inspected restrictions and terminal state of an exactly identified, removed container. */
export interface DockerReceipt {
  readonly containerId: string
  readonly containerName: string
  readonly imageDigest: string
  readonly imageId: string
  readonly removed: true
  readonly exitCode: number | null
  readonly oomKilled: boolean
  readonly limits: {
    readonly network: 'none'
    readonly readOnlyRoot: true
    readonly memoryBytes: number
    readonly memorySwapBytes: number
    readonly nanoCpus: number
    readonly pidsLimit: number
    readonly tmpBytes: number
    readonly user: string
    readonly capabilities: readonly string[]
    readonly securityOptions: readonly string[]
    readonly mounts: readonly { readonly source: string; readonly destination: string; readonly writable: boolean }[]
  }
}

/** Parent-owned cleanup survives unexpected proxy termination. */
export interface DockerProgramHandle {
  readonly child: ChildProcess
  /** Begin IPC after the caller installs its message listeners; repeated calls do nothing. */
  start(): void
  /** Remove the owned container and await proxy exit; repeated calls share the same result. */
  terminate(): Promise<void>
  /** Return inspected execution evidence only after removal; cleanup failure rejects. */
  dispose(): Promise<DockerReceipt>
}

const imageSchema = z.array(z.object({ Id: z.string(), RepoDigests: z.array(z.string()) })).length(1)
const containerSchema = z.array(z.object({
  Id: z.string(), Image: z.string(), Name: z.string(),
  Config: z.object({ Image: z.string(), User: z.string(), Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Status: z.string(), Running: z.boolean(), ExitCode: z.number().int(), OOMKilled: z.boolean() }),
  HostConfig: z.object({ NetworkMode: z.string(), ReadonlyRootfs: z.boolean(), Privileged: z.boolean(),
    Memory: z.number(), MemorySwap: z.number(), NanoCpus: z.number(), PidsLimit: z.number(),
    CapDrop: z.array(z.string()), SecurityOpt: z.array(z.string()), Tmpfs: z.record(z.string(), z.string()) }),
  Mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean() })),
})).length(1)

/** Create a stopped container, then return an IPC proxy awaiting explicit start.
 * @param request Explicit runtime, artifact paths, and resource limits; no ambient Docker configuration is read.
 * @returns A handle retaining cleanup authority independently of the proxy process.
 */
export async function startDockerProgram(request: DockerProgramRequest): Promise<DockerProgramHandle> {
  if (process.platform === 'win32') throw new Error('Docker evaluation currently requires a POSIX host')
  if (!/^node@sha256:[a-f0-9]{64}$/.test(request.imageDigest)) throw new Error('Docker image must be a pinned official Node digest')
  if (!request.dockerHost.startsWith('unix:///')) throw new Error('Docker evaluation requires an explicit local Unix endpoint')
  for (const value of [request.timeoutMs, request.memoryBytes, request.pidsLimit, request.tmpBytes,
    request.maxWireBytes, request.maxDiagnosticBytes, request.cleanupTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Docker limits must be positive safe integers')
  }
  if (request.timeoutMs > 2 ** 31 - 1 || request.cleanupTimeoutMs > 2 ** 31 - 1) {
    throw new Error('Docker deadlines exceed the Node timer range')
  }
  if (!Number.isFinite(request.cpus) || request.cpus <= 0 || !Number.isSafeInteger(request.cpus * 1e9)) {
    throw new Error('Docker CPU limit must be positive and exactly representable in nanocpus')
  }
  for (const path of [request.root, request.runner, request.target, request.dockerPath, request.nodePath]) {
    if (!isAbsolute(path) || path.includes(',') || path.includes('\n')) throw new Error('Docker paths must be absolute without mount separators')
  }
  const root = await realpath(request.root)
  const target = await realpath(request.target)
  const targetRelative = relative(root, target)
  if (targetRelative === '' || targetRelative.startsWith(`..${sep}`) || targetRelative === '..' || isAbsolute(targetRelative)) {
    throw new Error('Docker target must be inside its role directory')
  }
  if (!(await lstat(root)).isDirectory() || !(await lstat(target)).isFile()) throw new Error('Docker artifacts must be files in a role directory')
  const stage = await mkdtemp(join(tmpdir(), 'scope-docker-runtime-'))
  const containerName = `agentharness-evaluation-${randomUUID()}`
  const ownership = randomUUID()
  const label = 'org.agentharness.scope-evaluation'
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: stage, LANG: 'C', TZ: 'UTC' }
  const base = ['--config', stage, '--host', request.dockerHost]
  const cli = async (args: string[]) => {
    const result = await execa(request.dockerPath, [...base, ...args], { env, extendEnv: false, reject: false,
      timeout: request.cleanupTimeoutMs, maxBuffer: request.maxDiagnosticBytes })
    if (result.exitCode !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  let created = false
  let containerId: string | undefined
  try {
    await writeFile(join(stage, 'config.json'), '{"auths":{}}\n', { mode: 0o600, flag: 'wx' })
    await copyFile(request.runner, join(stage, 'runner.mjs'))
    await copyFile(fileURLToPath(new URL('./docker-inner.mjs', import.meta.url)), join(stage, 'docker-inner.mjs'))
    await chmod(stage, 0o755)
    await chmod(join(stage, 'runner.mjs'), 0o644)
    await chmod(join(stage, 'docker-inner.mjs'), 0o644)
    const [image] = imageSchema.parse(JSON.parse(await cli(['image', 'inspect', request.imageDigest])))
    if (image === undefined || !image.RepoDigests.includes(request.imageDigest)) throw new Error('Inspected image does not prove the requested digest')
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    if (uid === undefined || gid === undefined || uid === 0) throw new Error('Docker evaluation requires a non-root POSIX owner')
    const user = `${uid}:${gid}`
    const tmpfs = `rw,nosuid,nodev,noexec,size=${request.tmpBytes}`
    const mounts = [
      { source: root, destination: '/work', writable: false },
      { source: join(stage, 'runner.mjs'), destination: '/runtime/runner.mjs', writable: false },
      { source: join(stage, 'docker-inner.mjs'), destination: '/runtime/docker-inner.mjs', writable: false },
    ]
    if (request.mode === 'tests') {
      const verdict = join(root, 'qa/verdict.json')
      const parent = await realpath(join(root, 'qa'))
      if (parent !== join(root, 'qa')) throw new Error('Docker verdict directory must not be a symbolic link')
      const file = await open(verdict, 'wx', 0o600)
      await file.close()
      mounts.push({ source: verdict, destination: '/work/qa/verdict.json', writable: true })
    }
    // A successful create precedes proxy ownership, so proxy death cannot race a later daemon create.
    created = true
    containerId = (await cli(['create', '--name', containerName, '--label', `${label}=${ownership}`,
      '--pull=never', '--network=none', '--read-only', '--user', user, '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--memory', String(request.memoryBytes), '--memory-swap', String(request.memoryBytes),
      '--cpus', String(request.cpus), '--pids-limit', String(request.pidsLimit), '--ulimit', 'nofile=64:64',
      '--tmpfs', `/tmp:${tmpfs}`, ...mounts.flatMap(mount => ['--mount',
        `type=bind,src=${mount.source},dst=${mount.destination}${mount.writable ? '' : ',readonly'}`]),
      '--env', 'HOME=/tmp', '--env', 'LANG=C', '--env', 'TZ=UTC', '--workdir', '/work', '--entrypoint', '/usr/local/bin/node',
      '--interactive', request.imageDigest, '/runtime/docker-inner.mjs', request.mode, `/work/${targetRelative.split(sep).join('/')}`,
      String(request.timeoutMs), String(request.maxWireBytes), String(request.maxDiagnosticBytes)])).trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Docker create returned an invalid container id')
    const id = containerId
    const inspect = async () => {
      const [record] = containerSchema.parse(JSON.parse(await cli(['inspect', id])))
      if (record === undefined || record.Id !== id || record.Name !== `/${containerName}`
        || record.Config.Labels[label] !== ownership || record.Image !== image.Id || record.Config.Image !== request.imageDigest) {
        throw new Error('Docker container identity changed')
      }
      return record
    }
    const initial = await inspect()
    const config = initial.HostConfig
    if (config.NetworkMode !== 'none' || !config.ReadonlyRootfs || config.Privileged || initial.Config.User !== user
      || config.Memory !== request.memoryBytes || config.MemorySwap !== request.memoryBytes || config.NanoCpus !== request.cpus * 1e9
      || config.PidsLimit !== request.pidsLimit || !config.CapDrop.some(value => value.toUpperCase() === 'ALL')
      || !config.SecurityOpt.includes('no-new-privileges') || config.Tmpfs['/tmp'] !== tmpfs
      || initial.Mounts.length !== mounts.length || mounts.some(expected => !initial.Mounts.some(actual => actual.Type === 'bind'
        && actual.Source === expected.source && actual.Destination === expected.destination && actual.RW === expected.writable))) {
      throw new Error('Docker did not install the requested execution restrictions')
    }
    const child = spawn(request.nodePath, [fileURLToPath(new URL('./docker-proxy.mjs', import.meta.url)),
      JSON.stringify({ dockerPath: request.dockerPath, base, id, maxWireBytes: request.maxWireBytes,
        maxDiagnosticBytes: request.maxDiagnosticBytes })], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const closed = new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
    let started = false
    let cleanup: Promise<DockerReceipt> | undefined
    const dispose = (): Promise<DockerReceipt> => cleanup ??= (async () => {
      try {
        const before = await inspect()
        if (before.State.Running) {
          try { await cli(['kill', '--signal', 'KILL', id]) }
          catch (error) {
            // A natural exit may win the kill; daemon failures or a still-running container remain failures.
            if ((await inspect()).State.Running) throw error
          }
        }
        const final = await inspect()
        await cli(['rm', '--force', id])
        const remaining = await cli(['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'])
        if (remaining.trim() !== '') throw new Error('Owned Docker container still exists after removal')
        child.kill('SIGKILL')
        await closed
        return { containerId: id, containerName, imageDigest: request.imageDigest, imageId: image.Id, removed: true,
          exitCode: final.State.Status === 'created' ? null : final.State.ExitCode, oomKilled: final.State.OOMKilled,
          limits: { network: 'none', readOnlyRoot: true, memoryBytes: config.Memory, memorySwapBytes: config.MemorySwap,
            nanoCpus: config.NanoCpus, pidsLimit: config.PidsLimit, tmpBytes: request.tmpBytes, user,
            capabilities: config.CapDrop, securityOptions: config.SecurityOpt, mounts } }
      } finally {
        child.kill('SIGKILL')
        await closed
        await rm(stage, { recursive: true, force: true })
      }
    })()
    // Retain the rejection for explicit dispose; close can arrive before the caller starts teardown.
    child.once('close', () => { void dispose().catch(() => undefined) })
    child.once('error', () => { void dispose().catch(() => undefined) })
    return { child, start() {
      if (started || cleanup !== undefined) return
      started = true
      child.send({ kind: 'bridge-start' }, (error) => { if (error) void dispose().catch(() => undefined) })
    }, terminate: async () => { await dispose() }, dispose }
  } catch (error) {
    try {
      if (created) {
        const ids = (await cli(['ps', '-a', '--no-trunc', '--filter', `name=^/${containerName}$`,
          '--filter', `label=${label}=${ownership}`, '--format', '{{.ID}}'])).trim()
        if (ids !== '') {
          if (!/^[a-f0-9]{64}$/.test(ids)) throw new Error('Unexpected container ownership query result')
          await cli(['rm', '--force', ids])
          if ((await cli(['ps', '-a', '--no-trunc', '--filter', `id=${ids}`, '--format', '{{.ID}}'])).trim() !== '') {
            throw new Error('Failed setup left its container behind')
          }
        }
      }
    } finally { await rm(stage, { recursive: true, force: true }) }
    throw error
  }
}
