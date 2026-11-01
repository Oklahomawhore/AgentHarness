/** User-level Codex hook definitions; Codex retains ownership of review and activation. */

import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { McpClientSnapshot } from './types.ts'

const events = ['UserPromptSubmit', 'PostToolUse'] as const
const group = { hooks: [{ type: 'mcp_tool', server: 'agentharness', tool: 'agentharness_codex_hook',
  input: { sessionId: '${session_id}', cwd: '${cwd}', event: '${hook_event_name}' } }] }

type HookState = NonNullable<McpClientSnapshot['automaticContext']>['state']

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function read(path: string): Promise<Record<string, unknown>> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('refusing a symbolic-link hook configuration')
    let value: unknown
    try { value = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('Codex hook configuration is not strict JSON')
      throw error
    }
    if (!object(value)) throw new Error('Codex hook configuration root is not a JSON object')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {}
  }
}

function state(document: Record<string, unknown>): Exclude<HookState, 'failed'> {
  if (document.hooks !== undefined && !object(document.hooks)) return 'conflict'
  const hooks = document.hooks
  let complete = true
  for (const event of events) {
    const groups = hooks?.[event]
    if (groups !== undefined && !Array.isArray(groups)) return 'conflict'
    if (groups?.some(item => !object(item) || !Array.isArray(item.hooks) || item.hooks.some(handler => !object(handler))) === true) {
      return 'conflict'
    }
    const owned = groups?.filter(item => object(item) && Array.isArray(item.hooks)
      && item.hooks.some(handler => object(handler) && handler.server === 'agentharness' && handler.tool === 'agentharness_codex_hook')) ?? []
    if (owned.length > 1 || (owned.length === 1 && !isDeepStrictEqual(owned[0], group))) return 'conflict'
    if (owned.length === 0) complete = false
  }
  return complete ? 'configured' : 'not-configured'
}

/**
 * Inspect exact user-level definitions without trusting or invoking a hook.
 * @param path - absolute hooks.json selected by the Codex home.
 * @returns definition state only; other layers and client activation remain independent.
 */
export async function inspectCodexHooks(path: string): Promise<NonNullable<McpClientSnapshot['automaticContext']>> {
  try { return { state: state(await read(path)), configPath: path } }
  catch { return { state: 'failed', configPath: path } }
}

/**
 * Add missing definitions while preserving unrelated hooks and refusing conflicting owned groups.
 * @param path - absolute user-level hooks.json.
 * @returns after an owner-only atomic write or an already matching definition.
 */
export async function configureCodexHooks(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const document = await read(path)
    const current = state(document)
    if (current === 'conflict') throw new Error('a different AgentHarness Codex hook definition already exists')
    if (current === 'configured') return
    const hooks = { ...document.hooks as Record<string, unknown> | undefined }
    for (const event of events) {
      const groups = hooks[event] as unknown[] | undefined
      if (groups?.some(item => isDeepStrictEqual(item, group)) !== true) hooks[event] = [...groups ?? [], group]
    }
    await writeFileAtomic(path, `${JSON.stringify({ ...document, hooks }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  })
}
