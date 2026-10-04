/** Project-local Claude hook installation with exact ownership and atomic settings replacement. */

import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, isAbsolute, join } from 'node:path'
import { PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  ClaudeScopeSetupConfig, ClaudeScopeSetupRequest, ClaudeScopeSetupResult,
  ClaudeScopeProjectSetupResult, ClaudeScopeRemoveSetupResult,
} from './types.ts'

/** Deployment settings plus the current Host's existing descriptor location. */
export interface ClaudeScopeProjectSetupOptions extends ClaudeScopeSetupConfig {
  readonly descriptorPath: string
}

/** Stable local-setup failures; diagnostics never include existing settings contents. */
export class ClaudeScopeSetupError extends Error {
  constructor(readonly code: 'project-invalid' | 'configuration-conflict' | 'configuration-invalid' | 'configuration-too-large' | 'write-failed') {
    super(`claude-scope setup: ${code}`)
  }
}

const MARKER = '# agentharness-claude-scope:v1'
const EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PostToolBatch', 'SessionEnd'] as const
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
type JsonObject = Record<string, unknown>
interface Target {
  readonly projectPath: string
  readonly settingsPath: string
  readonly profileName: string
  readonly profilePath: string
  readonly command: string
  readonly manifest: string
  readonly patch: string
}
interface Settings {
  readonly text: string | undefined
  readonly document: JsonObject
  readonly hooks: ReadonlyMap<string, readonly JsonObject[]>
  readonly owned: number
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function fail(code: ClaudeScopeSetupError['code']): never { throw new ClaudeScopeSetupError(code) }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function serialized(value: unknown, limit: number): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > limit) fail('configuration-too-large')
  return text
}

async function directory(path: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  let info
  try { info = await lstat(path) } catch (error) { if (missing(error)) return false; throw error }
  signal.throwIfAborted()
  if (!info.isDirectory() || info.isSymbolicLink()) fail('configuration-conflict')
  return true
}

async function readText(path: string, limit: number, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  let info
  try { info = await lstat(path, { bigint: true }) } catch (error) { if (missing(error)) return undefined; throw error }
  signal.throwIfAborted()
  if (!info.isFile() || info.isSymbolicLink()) fail('configuration-conflict')
  if (info.size > BigInt(limit)) fail('configuration-too-large')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    signal.throwIfAborted()
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino) fail('configuration-conflict')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      signal.throwIfAborted()
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > limit) fail('configuration-too-large')
    const after = await file.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    signal.throwIfAborted()
    if (after.dev !== current.dev || after.ino !== current.ino || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || BigInt(length) !== after.size) fail('configuration-conflict')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) }
    catch { return fail('configuration-invalid') }
  } finally {
    await file.close()
  }
}

function parse(text: string): JsonObject {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return fail('configuration-invalid') }
  if (!object(value)) fail('configuration-invalid')
  return value
}

function group(target: Target, event: string, options: ClaudeScopeProjectSetupOptions): JsonObject {
  return {
    ...(TOOL_EVENTS.has(event) ? { matcher: '^(Write|Edit|Bash)$' } : {}),
    hooks: [{ type: 'command', command: target.command, timeout: options.hookTimeoutSeconds }],
  }
}

async function target(options: ClaudeScopeProjectSetupOptions, request: ClaudeScopeSetupRequest, signal: AbortSignal): Promise<Target> {
  signal.throwIfAborted()
  if (process.platform === 'win32' || !isAbsolute(request.projectPath)) fail('project-invalid')
  if (![options.home, options.launchCommand, options.launchCwd, options.descriptorPath].every(isAbsolute)
    || [...options.launchArgs, options.home, options.launchCommand, options.launchCwd].some(value => value.includes('\0'))) fail('configuration-invalid')
  let projectPath: string
  try {
    projectPath = await realpath(request.projectPath)
    if (!(await stat(projectPath)).isDirectory()) fail('project-invalid')
  } catch {
    signal.throwIfAborted()
    return fail('project-invalid')
  }
  signal.throwIfAborted()
  const profilePath = resolveProfileDir(options.profileName, options.home)
  const command = `cd ${quote(options.launchCwd)} && DSH_HOME=${quote(options.home)} ${[options.launchCommand, ...options.launchArgs, '--profile', options.profileName].map(quote).join(' ')} ${MARKER}`
  const manifest = serialized({ name: `dsh-profile-${options.profileName}`, private: true, dependencies: {},
    dsh: { profile: { bundles: [], patchReload: 'startup' } } }, options.maxSettingsBytes)
  const patch = serialized([{ insert: [{ id: 'claude-scope-command', name: '@deepseek-ai/dsh-claude-scope/command', config: {
    descriptorPath: options.descriptorPath, maxRequestBytes: options.maxRequestBytes,
    maxResponseBytes: options.maxResponseBytes, timeoutMs: options.timeoutMs,
  } }] }], options.maxSettingsBytes)
  return { projectPath, settingsPath: join(projectPath, '.claude/settings.local.json'), profileName: options.profileName, profilePath, command, manifest, patch }
}

async function settings(target: Target, options: ClaudeScopeProjectSetupOptions, signal: AbortSignal): Promise<Settings> {
  await directory(dirname(target.settingsPath), signal)
  const text = await readText(target.settingsPath, options.maxSettingsBytes, signal)
  const document = text === undefined ? {} : parse(text)
  if (document.hooks !== undefined && !object(document.hooks)) fail('configuration-invalid')
  const hooks = new Map<string, JsonObject[]>()
  let owned = 0
  for (const [event, entries] of Object.entries(document.hooks ?? {})) {
    if (!Array.isArray(entries)) fail('configuration-invalid')
    const groups: JsonObject[] = []
    let eventOwned = 0
    for (const entry of entries) {
      if (!object(entry) || !Array.isArray(entry.hooks) || !entry.hooks.every(object)
        || (entry.matcher !== undefined && typeof entry.matcher !== 'string')) fail('configuration-invalid')
      if (entry.hooks.some(hook => typeof hook.command === 'string' && hook.command.includes(MARKER))) {
        if (!EVENTS.some(candidate => candidate === event) || !isDeepStrictEqual(entry, group(target, event, options))) fail('configuration-conflict')
        eventOwned++
      }
      groups.push(entry)
    }
    if (eventOwned > 1) fail('configuration-conflict')
    owned += eventOwned
    hooks.set(event, groups)
  }
  if (owned !== 0 && owned !== EVENTS.length) fail('configuration-conflict')
  return { text, document, hooks, owned }
}

async function profile(target: Target, options: ClaudeScopeProjectSetupOptions, signal: AbortSignal): Promise<boolean> {
  await directory(options.home, signal)
  await directory(dirname(target.profilePath), signal)
  await directory(target.profilePath, signal)
  const manifest = await readText(join(target.profilePath, 'package.json'), options.maxSettingsBytes, signal)
  const patch = await readText(join(target.profilePath, PROFILE_PATCH_FILENAME), options.maxSettingsBytes, signal)
  if (manifest !== undefined && !isDeepStrictEqual(parse(manifest), parse(target.manifest))) fail('configuration-conflict')
  if (patch !== undefined) {
    let value: unknown
    try { value = JSON.parse(patch) as unknown } catch { return fail('configuration-conflict') }
    if (!isDeepStrictEqual(value, JSON.parse(target.patch) as unknown)) fail('configuration-conflict')
  }
  return manifest !== undefined && patch !== undefined
}

function paths(target: Target) {
  return { projectPath: target.projectPath, settingsPath: target.settingsPath, profileName: target.profileName }
}

/**
 * Inspect exact project hook entries and the shared startup-only profile without writing files.
 * A configured result describes files; Claude's trust, policy, and running sessions remain client-owned.
 * @param options - explicit launcher, home, profile, descriptor, and byte limits.
 * @param request - existing project directory whose local settings are inspected.
 * @param signal - owning Host operation cancellation.
 * @returns configuration state, with only a stable diagnostic code for conflicts.
 */
export async function inspectClaudeScopeProject(
  options: ClaudeScopeProjectSetupOptions, request: ClaudeScopeSetupRequest, signal: AbortSignal,
): Promise<ClaudeScopeProjectSetupResult> {
  const selected = await target(options, request, signal)
  try {
    const current = await settings(selected, options, signal)
    if (current.document.disableAllHooks === true) fail('configuration-conflict')
    const ready = await profile(selected, options, signal)
    return { ...paths(selected), state: current.owned === EVENTS.length && ready ? 'configured' : 'not-configured' }
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof ClaudeScopeSetupError)) throw error
    return { ...paths(selected), state: 'conflict', detail: error.code }
  }
}

async function mutate(
  options: ClaudeScopeProjectSetupOptions, request: ClaudeScopeSetupRequest, signal: AbortSignal, install: boolean,
): Promise<{ target: Target; changed: boolean }> {
  const selected = await target(options, request, signal)
  // Validate both inputs before creating installation files. The locked cycle repeats these reads.
  const inspected = await settings(selected, options, signal)
  if (install && inspected.document.disableAllHooks === true) fail('configuration-conflict')
  if (install) await profile(selected, options, signal)
  if (!install && !await directory(dirname(selected.settingsPath), signal)) return { target: selected, changed: false }
  try {
    if (install) {
      await mkdir(selected.profilePath, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
    }
    await mkdir(dirname(selected.settingsPath), { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    const changeSettings = async (): Promise<{ target: Target; changed: boolean }> => {
      await directory(dirname(selected.settingsPath), signal)
      const current = await settings(selected, options, signal)
      if (install && current.document.disableAllHooks === true) fail('configuration-conflict')
      const ready = install ? await profile(selected, options, signal) : true
      if (install ? current.owned === EVENTS.length && ready : current.owned === 0) return { target: selected, changed: false }
      const hooks = new Map(current.hooks)
      for (const event of EVENTS) {
        const previous = hooks.get(event) ?? []
        const entries = install
          ? current.owned === 0 ? [...previous, group(selected, event, options)] : [...previous]
          : previous.filter(entry => !isDeepStrictEqual(entry, group(selected, event, options)))
        if (entries.length === 0) hooks.delete(event)
        else hooks.set(event, entries)
      }
      const { hooks: _previousHooks, ...rest } = current.document
      const next = serialized({ ...rest, ...(hooks.size === 0 ? {} : { hooks: Object.fromEntries(hooks) }) }, options.maxSettingsBytes)
      if (install && !ready) {
        await directory(selected.profilePath, signal)
        for (const [file, text] of [['package.json', selected.manifest], [PROFILE_PATCH_FILENAME, selected.patch]] as const) {
          signal.throwIfAborted()
          if (await readText(join(selected.profilePath, file), options.maxSettingsBytes, signal) === undefined) {
            await writeFileAtomic(join(selected.profilePath, file), text, { mode: 0o600, dirMode: 0o700 })
          }
        }
      }
      signal.throwIfAborted()
      if (await readText(selected.settingsPath, options.maxSettingsBytes, signal) !== current.text) fail('configuration-conflict')
      signal.throwIfAborted()
      await writeFileAtomic(selected.settingsPath, next, { mode: 0o600, dirMode: 0o700 })
      return { target: selected, changed: true }
    }
    const lockedSettings = () => withFileLock(selected.settingsPath, changeSettings)
    return install
      ? await withFileLock(join(selected.profilePath, 'package.json'), lockedSettings)
      : await lockedSettings()
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ClaudeScopeSetupError) throw error
    if (error instanceof Error && ('code' in error || error.message.startsWith('atomic-write: timed out'))) fail('write-failed')
    throw error
  }
}

/**
 * Install seven owned hook groups after preparing their complete shared dsh profile.
 * Writes use cooperative file locks and atomic replacement; interrupted profile creation can resume.
 * Cancellation is checked before each write; an atomic replacement already started may commit.
 * The caller must await settlement before completing disposal; committed settings stay durable.
 * @param options - explicit launcher and same-home profile settings.
 * @param request - existing project directory; user-level settings are never accessed.
 * @param signal - owning Host operation cancellation.
 * @returns whether configuration was installed or already matched exactly.
 */
export async function setupClaudeScopeProject(
  options: ClaudeScopeProjectSetupOptions, request: ClaudeScopeSetupRequest, signal: AbortSignal,
): Promise<ClaudeScopeSetupResult> {
  const result = await mutate(options, request, signal, true)
  return { ...paths(result.target), outcome: result.changed ? 'configured' : 'already-configured' }
}

/**
 * Remove only exact owned project hooks, retaining unrelated settings and the shared profile.
 * This does not leave active scopes or stop hooks already loaded by a Claude session.
 * @param options - installation identity expected in the project hook commands.
 * @param request - existing project directory whose owned hooks are removed.
 * @param signal - owning Host operation cancellation.
 * @returns whether owned project entries were removed or were already absent.
 */
export async function removeClaudeScopeProject(
  options: ClaudeScopeProjectSetupOptions, request: ClaudeScopeSetupRequest, signal: AbortSignal,
): Promise<ClaudeScopeRemoveSetupResult> {
  const result = await mutate(options, request, signal, false)
  return { ...paths(result.target), outcome: result.changed ? 'removed' : 'already-removed' }
}
