/** Parse external hooks and retain only explicitly authorized original tool fields. */

import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { toolObservationResultSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskToolObservationResult, DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { z } from 'zod'
import type {
  ClaudeScopeHookEvent,
  ClaudeScopeHookInput,
  ClaudeScopeHookTool,
  ClaudeScopeObservation,
  ClaudeScopeOmission,
  ClaudeScopePolicy,
  ClaudeScopePreparedInput,
} from './types.ts'

const hookSchema = z.object({
  session_id: z.string().min(1), hook_event_name: z.string().min(1), cwd: z.string().optional(), agent_id: z.string().optional(),
  tool_use_id: z.string().optional(), tool_name: z.string().optional(), tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(), error: z.string().optional(),
})
const writeSchema = z.strictObject({ file_path: z.string().min(1), content: z.string() })
const editSchema = z.strictObject({
  file_path: z.string().min(1), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional(),
})
const bashSchema = z.strictObject({
  command: z.string().min(1), timeout: z.number().positive().optional(), description: z.string().optional(),
  run_in_background: z.boolean().optional(), dangerouslyDisableSandbox: z.boolean().optional(),
})
const knownEvents = new Set<ClaudeScopeHookEvent>([
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PostToolBatch', 'SessionEnd',
])

/**
 * Parse identity and supported event fields without retaining conversation payloads.
 * @param value - decoded external Hook JSON; its full byte bound belongs to the ingress.
 * @returns a main-session event or ignored event; throws for malformed identity or tool fields.
 */
export function parseClaudeScopeHook(value: unknown): ClaudeScopeHookInput {
  const parsed = hookSchema.parse(value)
  const event = knownEvents.has(parsed.hook_event_name as ClaudeScopeHookEvent)
    ? parsed.hook_event_name as ClaudeScopeHookEvent : 'ignored'
  const toolEvent = event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure'
  let tool: ClaudeScopeHookTool | undefined
  if (toolEvent) {
    if (!parsed.tool_use_id || !parsed.tool_name || parsed.tool_input === undefined) {
      throw new Error('claude-scope: tool hook requires tool_use_id, tool_name, and tool_input')
    }
    tool = {
      id: parsed.tool_use_id, name: parsed.tool_name, input: parsed.tool_input,
      ...(parsed.tool_response === undefined ? {} : { response: parsed.tool_response }),
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
    }
  }
  return {
    sessionId: parsed.session_id, event,
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    ...(parsed.agent_id === undefined ? {} : { agentId: parsed.agent_id }),
    ...(tool === undefined ? {} : { tool }),
  }
}

function omitted(reason: string): ClaudeScopeOmission { return { kind: 'omitted', reason } }

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/** Resolve existing ancestors so a new Write target still respects symlinked directories. */
async function resolvedTarget(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const parent = dirname(path)
  if (parent === path) throw new Error('claude-scope: file target has no existing ancestor')
  return resolve(await resolvedTarget(parent), basename(path))
}

async function scopedPath(path: string | undefined, policy: ClaudeScopePolicy): Promise<{ rootIndex: number; path: string } | undefined> {
  if (path === undefined || !isAbsolute(path)) return undefined
  let canonical: string
  try { canonical = await resolvedTarget(path) }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) throw error
    return undefined
  }
  const match = [...policy.roots.entries()].find(([, root]) => within(root, canonical))
  if (match === undefined) return undefined
  return { rootIndex: match[0], path: relative(match[1], canonical) || '.' }
}

function prepared(toolName: ClaudeScopePreparedInput['toolName'], input: object, fields: ClaudeScopePreparedInput['fields']): ClaudeScopePreparedInput {
  const inputDigest = createHash('sha256').update(JSON.stringify({ input, rootIndex: fields.rootIndex, path: fields.path })).digest('hex')
  return { kind: 'eligible', toolName, inputDigest, fields }
}

/**
 * Compare original supported tool arguments independently of a file's later path resolution.
 * @param tool - raw supported tool input, excluding response and completion status.
 * @returns a normalized argument digest, or undefined for unsupported input.
 */
export function claudeScopeToolArgumentDigest(tool: ClaudeScopeHookTool): string | undefined {
  const schema = tool.name === 'Write' ? writeSchema : tool.name === 'Edit' ? editSchema : undefined
  if (schema === undefined) return undefined
  const parsed = schema.safeParse(tool.input)
  return parsed.success ? createHash('sha256').update(JSON.stringify([tool.name, parsed.data])).digest('hex') : undefined
}

/**
 * Authorize supported tool inputs against the current explicit collection grant.
 * @param tool - original Hook tool fields; unknown input keys reject collection.
 * @param cwd - external working directory, required for constrained Bash observations.
 * @param policy - canonical allowed roots and exact allowed Bash commands.
 * @returns authorized fields and digest, or a reason without changing tool permission.
 */
export async function authorizeClaudeScopeTool(
  tool: ClaudeScopeHookTool,
  cwd: string | undefined,
  policy: ClaudeScopePolicy,
): Promise<ClaudeScopePreparedInput | ClaudeScopeOmission> {
  switch (tool.name) {
    case 'Write': {
      const parsed = writeSchema.safeParse(tool.input)
      if (!parsed.success) return omitted('unsupported-tool-input')
      const path = await scopedPath(parsed.data.file_path, policy)
      if (path === undefined) return omitted('path-outside-grant')
      return prepared('Write', parsed.data, { ...path, content: parsed.data.content })
    }
    case 'Edit': {
      const parsed = editSchema.safeParse(tool.input)
      if (!parsed.success) return omitted('unsupported-tool-input')
      const path = await scopedPath(parsed.data.file_path, policy)
      if (path === undefined) return omitted('path-outside-grant')
      return prepared('Edit', parsed.data, {
        ...path, oldString: parsed.data.old_string, newString: parsed.data.new_string, replaceAll: parsed.data.replace_all ?? false,
      })
    }
    case 'Bash': {
      const parsed = bashSchema.safeParse(tool.input)
      if (!parsed.success) return omitted('unsupported-tool-input')
      if (parsed.data.run_in_background === true) return omitted('background-tool')
      if (!policy.bashCommands.includes(parsed.data.command)) return omitted('command-outside-grant')
      const path = await scopedPath(cwd, policy)
      if (path === undefined) return omitted('cwd-outside-grant')
      return prepared('Bash', parsed.data, { ...path, command: parsed.data.command })
    }
    default: return omitted('unsupported-tool')
  }
}

/**
 * Render an original tool observation with complete-field omission and exact byte accounting.
 * @param input - successful or failed completion hook; no conversation fields are copied.
 * @param authorized - newly authorized input matching the durable starting lease.
 * @param sourceId - stable identity supplied by the binding-aware Host.
 * @param maxBytes - maximum UTF-8 bytes of the complete publication JSON.
 * @returns bounded source text or a reason when mandatory attribution cannot fit.
 */
export function renderClaudeScopeObservation(
  input: ClaudeScopeHookInput,
  authorized: ClaudeScopePreparedInput,
  sourceId: DevelopmentTaskObservedSourceId,
  maxBytes: number,
): ClaudeScopeObservation | ClaudeScopeOmission {
  if (input.event !== 'PostToolUse' && input.event !== 'PostToolUseFailure') return omitted('not-tool-completion')
  const failure = input.event === 'PostToolUseFailure'
  const { content, oldString, newString, ...identity } = authorized.fields
  const fields = new Map(Object.entries(identity))
  const omissions: string[] = []
  const candidates: [string, string | number | boolean][] = []
  if (failure) {
    if (input.tool?.error === undefined) omissions.push('unsupported-error-output')
    else candidates.push(['error', input.tool.error])
  } else {
    for (const [key, value] of [['content', content], ['oldString', oldString], ['newString', newString]] as const) {
      if (value !== undefined) candidates.push([key, value])
    }
    if (authorized.toolName === 'Bash') {
      const response = z.object({ stdout: z.string(), stderr: z.string(), interrupted: z.boolean() }).safeParse(input.tool?.response)
      if (response.success) candidates.push(['stdout', response.data.stdout], ['stderr', response.data.stderr], ['interrupted', response.data.interrupted])
      else omissions.push('unsupported-tool-response')
    }
  }
  const render = (): string => JSON.stringify({
    kind: 'claude-tool-observation', version: 1, sourceId, tool: authorized.toolName,
    reportedStatus: failure ? 'failure' : 'success', fields: Object.fromEntries(fields), omissions,
  })
  for (const [key] of candidates) omissions.push(`budget:${key}`)
  if (Buffer.byteLength(render(), 'utf8') > maxBytes) return omitted('observation-attribution-exceeds-budget')
  for (const [key, value] of candidates) {
    const omission = `budget:${key}`
    const index = omissions.indexOf(omission)
    fields.set(key, value)
    omissions.splice(index, 1)
    if (Buffer.byteLength(render(), 'utf8') > maxBytes) {
      fields.delete(key)
      omissions.splice(index, 0, omission)
    }
  }
  return { kind: 'observation', sourceId, text: render() }
}

/**
 * Produce a typed original completion with explicit whole-field omissions.
 * @param input - successful or failed Write/Edit completion; no conversation payload is copied.
 * @param authorized - fields reauthorized against the original local lease.
 * @param fits - checks the complete owner-bound sample, including its grant and attribution.
 * @returns a typed report or a reason when mandatory fields cannot be represented.
 */
export function renderClaudeScopeToolContribution(
  input: ClaudeScopeHookInput, authorized: ClaudeScopePreparedInput,
  fits: (result: DevelopmentTaskToolObservationResult) => boolean,
): DevelopmentTaskToolObservationResult | ClaudeScopeOmission {
  if (input.event !== 'PostToolUse' && input.event !== 'PostToolUseFailure') return omitted('not-tool-completion')
  if (authorized.toolName !== 'Write' && authorized.toolName !== 'Edit') return omitted('unsupported-contribution-tool')
  const { rootIndex, path, replaceAll } = authorized.fields
  if (typeof rootIndex !== 'number' || typeof path !== 'string'
    || (authorized.toolName === 'Edit' && typeof replaceAll !== 'boolean')) return omitted('unsupported-tool-input')
  const failure = input.event === 'PostToolUseFailure'
  type Field = DevelopmentTaskToolObservationResult['omissions'][number]
  const body: Field[] = authorized.toolName === 'Write' ? ['content'] : ['oldString', 'newString']
  const omissions = [...body]
  const values: Record<Field, string | undefined> = { content: undefined, oldString: undefined, newString: undefined, error: undefined }
  const candidates: [Field, string][] = []
  if (failure) {
    if (input.tool?.error !== undefined) { candidates.push(['error', input.tool.error]); omissions.push('error') }
  } else {
    for (const field of body) {
      const value = authorized.fields[field]
      if (typeof value !== 'string') return omitted('unsupported-tool-input')
      candidates.push([field, value])
    }
  }
  const report = (): DevelopmentTaskToolObservationResult => {
    const common = { kind: 'tool-observation' as const, version: 1 as const,
      reportedStatus: failure ? 'failure' as const : 'success' as const, omissions: [...omissions] }
    const identity = { rootIndex, path: path.split(sep).join('/'), ...(values.error === undefined ? {} : { error: values.error }) }
    return authorized.toolName === 'Write'
      ? { ...common, tool: 'Write', fields: { ...identity, ...(values.content === undefined ? {} : { content: values.content }) } }
      : { ...common, tool: 'Edit', fields: { ...identity, replaceAll: replaceAll === true,
        ...(values.oldString === undefined ? {} : { oldString: values.oldString }),
        ...(values.newString === undefined ? {} : { newString: values.newString }) } }
  }
  if (!toolObservationResultSchema.safeParse(report()).success) return omitted('unsupported-contribution-path')
  if (!fits(report())) return omitted('observation-attribution-exceeds-budget')
  for (const [field, value] of candidates) {
    const index = omissions.indexOf(field)
    values[field] = value
    omissions.splice(index, 1)
    if (!fits(report())) { values[field] = undefined; omissions.splice(index, 0, field) }
  }
  return report()
}
