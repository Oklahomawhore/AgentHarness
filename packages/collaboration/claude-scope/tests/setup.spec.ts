import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  inspectClaudeScopeProject, removeClaudeScopeProject, setupClaudeScopeProject,
  type ClaudeScopeProjectSetupOptions,
} from '../src/setup.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})
const atomic = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
const directories: string[] = []
const signal = new AbortController().signal
const events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PostToolBatch', 'SessionEnd']
interface Settings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>
  [key: string]: unknown
}

afterEach(async () => {
  vi.mocked(writeFileAtomic).mockReset().mockImplementation(atomic.writeFileAtomic)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-project-setup-')))
  directories.push(directory)
  const projectPath = join(directory, 'project')
  const home = join(directory, 'harness-home')
  await mkdir(projectPath)
  const options: ClaudeScopeProjectSetupOptions = {
    home, profileName: 'scope-hooks', launchCommand: process.execPath,
    launchArgs: [join(directory, 'installed-dsh', 'bin.js')], launchCwd: directory,
    descriptorPath: join(home, 'claude-scope', 'descriptor.json'),
    maxRequestBytes: 32768, maxResponseBytes: 32768, timeoutMs: 10000, hookTimeoutSeconds: 20, maxSettingsBytes: 32768,
  }
  const settingsPath = join(projectPath, '.claude', 'settings.local.json')
  const profilePath = join(home, 'profiles', options.profileName)
  return { directory, projectPath, options, request: { projectPath }, settingsPath, profilePath }
}

async function existingSettings(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

async function readSettings(path: string): Promise<Settings> { return JSON.parse(await readFile(path, 'utf8')) as Settings }

function foreign() {
  return { permissions: { allow: ['Bash(test-safe)'], deny: ['Read(.env)'] }, env: { FAKE_SETTING: 'retained' },
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'existing-hook' }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'Keep this other handler.' }] }] } }
}

describe.skipIf(process.platform === 'win32')('project-local Claude hook setup', () => {
  it('inspects an absent setup without creating project or home configuration', async () => {
    const f = await fixture()
    expect(await inspectClaudeScopeProject(f.options, f.request, signal)).toEqual({
      projectPath: f.projectPath, settingsPath: f.settingsPath, profileName: 'scope-hooks', state: 'not-configured',
    })
    expect(await readdir(f.projectPath)).toEqual([])
    await expect(stat(f.options.home)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await removeClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('already-removed')
    expect(await readdir(f.projectPath)).toEqual([])
  })

  it('merges seven owned hooks, preserves existing settings, and is byte-idempotent', async () => {
    const f = await fixture()
    const original = foreign()
    await existingSettings(f.settingsPath, original)
    expect((await setupClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('configured')
    const settings = await readSettings(f.settingsPath)
    expect(settings.permissions).toEqual(original.permissions)
    expect(settings.env).toEqual(original.env)
    expect(settings.hooks.Stop).toEqual(original.hooks.Stop)
    expect(settings.hooks.SessionStart?.[0]).toEqual(original.hooks.SessionStart[0])
    for (const event of events) {
      const owned = settings.hooks[event]?.at(-1)
      expect(owned?.hooks).toHaveLength(1)
      expect(owned?.hooks[0]).toMatchObject({ type: 'command', timeout: 20 })
      expect(owned?.hooks[0]?.command).toContain(`DSH_HOME='${f.options.home}'`)
      expect(owned?.hooks[0]?.command).toContain("'--profile' 'scope-hooks'")
    }
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('^(Write|Edit|Bash)$')
    expect(settings.hooks.UserPromptSubmit?.[0]?.matcher).toBeUndefined()
    const bytes = await readFile(f.settingsPath)
    const before = await stat(f.settingsPath)
    expect((await setupClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('already-configured')
    expect(await readFile(f.settingsPath)).toEqual(bytes)
    expect((await stat(f.settingsPath)).mtimeMs).toBe(before.mtimeMs)
    expect((await inspectClaudeScopeProject(f.options, f.request, signal)).state).toBe('configured')
    const manifest = JSON.parse(await readFile(join(f.profilePath, 'package.json'), 'utf8')) as unknown
    expect(manifest).toEqual({ name: 'dsh-profile-scope-hooks', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } })
    const patch = JSON.parse(await readFile(join(f.profilePath, 'cordis.patch.yml'), 'utf8')) as unknown
    expect(patch).toEqual([{ insert: [{ id: 'claude-scope-command', name: '@deepseek-ai/dsh-claude-scope/command', config: {
      descriptorPath: f.options.descriptorPath, maxRequestBytes: 32768, maxResponseBytes: 32768, timeoutMs: 10000,
    } }] }])
    expect((await stat(f.settingsPath)).mode & 0o777).toBe(0o600)
    expect((await stat(f.profilePath)).mode & 0o777).toBe(0o700)
  })

  it('removes only its exact groups and retains the shared profile and unrelated settings', async () => {
    const f = await fixture()
    const original = foreign()
    await existingSettings(f.settingsPath, original)
    await setupClaudeScopeProject(f.options, f.request, signal)
    const manifest = await readFile(join(f.profilePath, 'package.json'))
    expect((await removeClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('removed')
    expect(await readSettings(f.settingsPath)).toEqual(original)
    expect(await readFile(join(f.profilePath, 'package.json'))).toEqual(manifest)
    const bytes = await readFile(f.settingsPath)
    expect((await removeClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('already-removed')
    expect(await readFile(f.settingsPath)).toEqual(bytes)
  })

  it('quotes every launch argument and home without shell expansion', async () => {
    const f = await fixture()
    const literal = "with space ' and $HOME `uname` $(uname)"
    const options = { ...f.options, launchCommand: '/usr/bin/printf', launchArgs: ['%s\\n', literal] }
    await setupClaudeScopeProject(options, f.request, signal)
    const command = (await readSettings(f.settingsPath)).hooks.SessionStart?.[0]?.hooks[0]?.command
    expect(command).toBeDefined()
    const result = await promisify(execFile)('/bin/sh', ['-c', command!], { cwd: f.projectPath, env: { PATH: '/usr/bin:/bin' } })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${literal}\n--profile\nscope-hooks\n`)
  })

  it.each(['{ // comment\n}', '{"hooks": {},}', '[]', '{"hooks": []}', '{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[{"hooks":"wrong"}]}}'])('rejects malformed settings without rewriting: %s', async (raw) => {
    const f = await fixture()
    await existingSettings(f.settingsPath, raw)
    expect(await inspectClaudeScopeProject(f.options, f.request, signal)).toMatchObject({ state: 'conflict', detail: 'configuration-invalid' })
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-invalid' })
    expect(await readFile(f.settingsPath, 'utf8')).toBe(raw)
    await expect(stat(f.options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports explicit hook disablement without changing it or preparing a profile', async () => {
    const f = await fixture()
    const original = JSON.stringify({ ...foreign(), disableAllHooks: true })
    await existingSettings(f.settingsPath, original)
    expect(await inspectClaudeScopeProject(f.options, f.request, signal)).toMatchObject({ state: 'conflict', detail: 'configuration-conflict' })
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    expect(await readFile(f.settingsPath, 'utf8')).toBe(original)
    await expect(stat(f.options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can remove its installed hooks while preserving explicit hook disablement', async () => {
    const f = await fixture()
    await setupClaudeScopeProject(f.options, f.request, signal)
    const settings = await readSettings(f.settingsPath)
    settings.disableAllHooks = true
    await writeFile(f.settingsPath, JSON.stringify(settings))
    expect((await inspectClaudeScopeProject(f.options, f.request, signal)).state).toBe('conflict')
    expect((await removeClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('removed')
    expect(await readSettings(f.settingsPath)).toEqual({ disableAllHooks: true })
  })

  it('rejects invalid UTF-8 and oversized input without disclosing contents', async () => {
    const f = await fixture()
    await existingSettings(f.settingsPath, {})
    await writeFile(f.settingsPath, Buffer.from([0xff, 0xfe]))
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-invalid' })
    await writeFile(f.settingsPath, 'PRIVATE_VALUE'.repeat(4096))
    const result = await inspectClaudeScopeProject(f.options, f.request, signal)
    expect(result).toMatchObject({ state: 'conflict', detail: 'configuration-too-large' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE')
  })

  it.each(['changed', 'duplicate', 'partial'])('refuses %s owned hooks in install and removal', async (mutation) => {
    const f = await fixture()
    await setupClaudeScopeProject(f.options, f.request, signal)
    const settings = await readSettings(f.settingsPath)
    if (mutation === 'changed') settings.hooks.SessionStart![0]!.hooks[0]!.timeout = 99
    if (mutation === 'duplicate') settings.hooks.SessionStart!.push(settings.hooks.SessionStart![0]!)
    if (mutation === 'partial') delete settings.hooks.SessionEnd
    await writeFile(f.settingsPath, JSON.stringify(settings))
    const before = await readFile(f.settingsPath)
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    await expect(removeClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    expect(await readFile(f.settingsPath)).toEqual(before)
  })

  it('refuses a changed shared profile without modifying any project settings', async () => {
    const f = await fixture()
    await setupClaudeScopeProject(f.options, f.request, signal)
    const before = await readFile(f.settingsPath)
    await writeFile(join(f.profilePath, 'cordis.patch.yml'), '[]\n')
    expect((await inspectClaudeScopeProject(f.options, f.request, signal)).state).toBe('conflict')
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    expect(await readFile(f.settingsPath)).toEqual(before)
    expect((await removeClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('removed')
    expect(await readFile(join(f.profilePath, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  })

  it('rejects settings and .claude directory symlinks without changing their referents', async () => {
    const f = await fixture()
    const outside = join(f.directory, 'outside.json')
    await writeFile(outside, '{}')
    await mkdir(join(f.projectPath, '.claude'))
    await symlink(outside, f.settingsPath)
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    expect(await readFile(outside, 'utf8')).toBe('{}')
    expect((await lstat(f.settingsPath)).isSymbolicLink()).toBe(true)
    await rm(join(f.projectPath, '.claude'), { recursive: true })
    await symlink(f.directory, join(f.projectPath, '.claude'))
    expect((await inspectClaudeScopeProject(f.options, f.request, signal)).state).toBe('conflict')
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
  })

  it('rejects a symlinked profiles directory and preserves its target', async () => {
    const f = await fixture()
    const outside = join(f.directory, 'external-profiles')
    await mkdir(outside)
    await mkdir(f.options.home)
    await symlink(outside, join(f.options.home, 'profiles'))
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    expect(await readdir(outside)).toEqual([])
  })

  it('enforces the complete output byte limit before creating profile artifacts', async () => {
    const f = await fixture()
    await setupClaudeScopeProject(f.options, f.request, signal)
    const bytes = await readFile(f.settingsPath)
    await removeClaudeScopeProject(f.options, f.request, signal)
    await expect(setupClaudeScopeProject({ ...f.options, maxSettingsBytes: bytes.length - 1 }, f.request, signal))
      .rejects.toMatchObject({ code: 'configuration-too-large' })
    expect((await setupClaudeScopeProject({ ...f.options, maxSettingsBytes: bytes.length }, f.request, signal)).outcome).toBe('configured')
    expect(await readFile(f.settingsPath)).toEqual(bytes)
  })

  it('recovers an interrupted profile preparation without publishing incomplete hooks', async () => {
    const f = await fixture()
    vi.mocked(writeFileAtomic).mockImplementation(async (path, content, options) => {
      if (path.endsWith('cordis.patch.yml')) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' })
      await atomic.writeFileAtomic(path, content, options)
    })
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'write-failed' })
    await expect(stat(f.settingsPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(f.profilePath, 'package.json'))).isFile()).toBe(true)
    vi.mocked(writeFileAtomic).mockImplementation(atomic.writeFileAtomic)
    expect((await setupClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('configured')
    expect((await inspectClaudeScopeProject(f.options, f.request, signal)).state).toBe('configured')
    expect((await readdir(f.profilePath)).filter(name => name.endsWith('.lock') || name.endsWith('.tmp'))).toEqual([])
  })

  it('preserves a concurrent external settings edit instead of overwriting it', async () => {
    const f = await fixture()
    await existingSettings(f.settingsPath, foreign())
    const external = JSON.stringify({ permissions: { deny: ['Read(secret-fixture)'] }, description: 'external edit' })
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (path, content, options) => {
      await atomic.writeFileAtomic(path, content, options)
      await writeFile(f.settingsPath, external)
    })
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'configuration-conflict' })
    expect(await readFile(f.settingsPath, 'utf8')).toBe(external)
  })

  it('retains existing settings after commit failure and can retry with the prepared profile', async () => {
    const f = await fixture()
    const original = JSON.stringify(foreign())
    await existingSettings(f.settingsPath, original)
    vi.mocked(writeFileAtomic).mockImplementation(async (path, content, options) => {
      if (path === f.settingsPath) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' })
      await atomic.writeFileAtomic(path, content, options)
    })
    await expect(setupClaudeScopeProject(f.options, f.request, signal)).rejects.toMatchObject({ code: 'write-failed' })
    expect(await readFile(f.settingsPath, 'utf8')).toBe(original)
    vi.mocked(writeFileAtomic).mockImplementation(atomic.writeFileAtomic)
    expect((await setupClaudeScopeProject(f.options, f.request, signal)).outcome).toBe('configured')
  })

  it('serializes concurrent installation and preserves a shared profile across projects', async () => {
    const f = await fixture()
    const second = join(f.directory, 'second')
    await mkdir(second)
    const results = await Promise.all([
      setupClaudeScopeProject(f.options, f.request, signal),
      setupClaudeScopeProject(f.options, f.request, signal),
      setupClaudeScopeProject(f.options, { projectPath: second }, signal),
    ])
    expect(results.map(result => result.outcome).sort()).toEqual(['already-configured', 'configured', 'configured'])
    expect((await readSettings(f.settingsPath)).hooks.SessionStart).toHaveLength(1)
    await removeClaudeScopeProject(f.options, f.request, signal)
    expect((await inspectClaudeScopeProject(f.options, { projectPath: second }, signal)).state).toBe('configured')
  })

  it('settles cancellation during profile preparation before project settings are committed', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const reason = new Error('setup owner disposed')
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (path, content, options) => {
      entered.resolve(undefined)
      await release.promise
      await atomic.writeFileAtomic(path, content, options)
    })
    const pending = setupClaudeScopeProject(f.options, f.request, controller.signal)
    try {
      await entered.promise
      controller.abort(reason)
      release.resolve(undefined)
      await expect(pending).rejects.toBe(reason)
      await expect(stat(f.settingsPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(f.profilePath)).filter(name => name.endsWith('.lock'))).toEqual([])
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending])
    }
  })

  it('rejects invalid projects and pre-cancellation without writes', async () => {
    const f = await fixture()
    await expect(setupClaudeScopeProject(f.options, { projectPath: 'relative' }, signal)).rejects.toMatchObject({ code: 'project-invalid' })
    await expect(setupClaudeScopeProject(f.options, { projectPath: join(f.directory, 'absent') }, signal)).rejects.toMatchObject({ code: 'project-invalid' })
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(setupClaudeScopeProject(f.options, f.request, controller.signal)).rejects.toBe(reason)
    expect(await readdir(f.projectPath)).toEqual([])
  })
})
