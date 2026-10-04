import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { authorizeClaudeScopeTool, parseClaudeScopeHook, renderClaudeScopeObservation, renderClaudeScopeToolContribution } from '../src/capture.ts'
import type { ClaudeScopeHookInput, ClaudeScopePolicy, ClaudeScopePreparedInput } from '../src/types.ts'

const directories: string[] = []
const sourceId = 'a'.repeat(64) as DevelopmentTaskObservedSourceId
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; outside: string; policy: ClaudeScopePolicy }> {
  // macOS resolves its temporary-directory prefix through /private.
  const { realpath } = await import('node:fs/promises')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-capture-')))
  directories.push(directory)
  const root = join(directory, 'project')
  const outside = join(directory, 'project-other')
  await mkdir(root)
  await mkdir(outside)
  return { root, outside, policy: { roots: [root], bashCommands: ['pnpm test'], revision: 'grant-1' } }
}

async function writeInput(root: string, policy: ClaudeScopePolicy, content: string): Promise<ClaudeScopePreparedInput> {
  const result = await authorizeClaudeScopeTool({ id: 'tool-1', name: 'Write', input: { file_path: join(root, 'new', 'api.txt'), content } }, root, policy)
  if (result.kind !== 'eligible') throw new Error(result.reason)
  return result
}

function completion(event: 'PostToolUse' | 'PostToolUseFailure', response?: unknown, error?: string): ClaudeScopeHookInput {
  return { event, sessionId: 'external', tool: { id: 'tool-1', name: 'Write', input: {}, response, ...(error === undefined ? {} : { error }) } }
}

describe('authorized original Claude tool observations', () => {
  it('drops conversation and batch payloads while preserving external session identity', () => {
    const hook = parseClaudeScopeHook({
      session_id: 'one', hook_event_name: 'PostToolBatch', cwd: '/project',
      prompt: 'private question', transcript_path: '/private/transcript.jsonl', tool_responses: [{ secret: 'private output' }],
    })
    expect(hook).toEqual({ sessionId: 'one', event: 'PostToolBatch', cwd: '/project' })
    expect(parseClaudeScopeHook({ session_id: 'two', hook_event_name: 'FutureHook', agent_id: 'subagent' }))
      .toEqual({ sessionId: 'two', event: 'ignored', agentId: 'subagent' })
    expect(() => parseClaudeScopeHook({ hook_event_name: 'SessionStart' })).toThrow()
    expect(() => parseClaudeScopeHook({ session_id: 'one', hook_event_name: 'PreToolUse', tool_name: 'Write' })).toThrow('requires')
  })

  it('allows new descendants and rejects prefix siblings, relative paths, and unsupported input fields', async () => {
    const { root, outside, policy } = await fixture()
    const accepted = await writeInput(root, policy, 'original source')
    expect(accepted.fields).toEqual({ rootIndex: 0, path: join('new', 'api.txt'), content: 'original source' })
    for (const filePath of [join(outside, 'api.txt'), '../api.txt']) {
      expect(await authorizeClaudeScopeTool({ id: 't', name: 'Write', input: { file_path: filePath, content: 'secret' } }, root, policy))
        .toEqual({ kind: 'omitted', reason: 'path-outside-grant' })
    }
    expect(await authorizeClaudeScopeTool({ id: 't', name: 'Write', input: { file_path: join(root, 'a'), content: 'x', extra: 'unreviewed' } }, root, policy))
      .toEqual({ kind: 'omitted', reason: 'unsupported-tool-input' })
  })

  it.skipIf(process.platform === 'win32')('reauthorizes symlink targets and changes the digest after an in-scope retarget', async () => {
    const { root, outside, policy } = await fixture()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    const link = join(root, 'link')
    await symlink(first, link)
    const tool = { id: 't', name: 'Write', input: { file_path: join(link, 'new.txt'), content: 'original' } }
    const before = await authorizeClaudeScopeTool(tool, root, policy)
    await rm(link)
    await symlink(second, link)
    const changed = await authorizeClaudeScopeTool(tool, root, policy)
    expect(before.kind).toBe('eligible')
    expect(changed.kind).toBe('eligible')
    if (before.kind !== 'eligible' || changed.kind !== 'eligible') throw new Error('fixture grant failed')
    expect(changed.inputDigest).not.toBe(before.inputDigest)
    await rm(link)
    await symlink(outside, link)
    expect(await authorizeClaudeScopeTool(tool, root, policy)).toEqual({ kind: 'omitted', reason: 'path-outside-grant' })
  })

  it('includes changed tool arguments in the starting digest', async () => {
    const { root, policy } = await fixture()
    const before = await writeInput(root, policy, 'one')
    const after = await writeInput(root, policy, 'two')
    expect(after.inputDigest).not.toBe(before.inputDigest)
    const base = { file_path: join(root, 'a'), old_string: 'a', new_string: 'b' }
    const once = await authorizeClaudeScopeTool({ id: 't', name: 'Edit', input: base }, root, policy)
    const all = await authorizeClaudeScopeTool({ id: 't', name: 'Edit', input: { ...base, replace_all: true } }, root, policy)
    if (once.kind !== 'eligible' || all.kind !== 'eligible') throw new Error('fixture grant failed')
    expect(all.inputDigest).not.toBe(once.inputDigest)
  })

  it('constrains Bash by exact command, resolved cwd, foreground execution, and supported fields', async () => {
    const { root, outside, policy } = await fixture()
    const tool = { id: 't', name: 'Bash', input: { command: 'pnpm test' } }
    const accepted = await authorizeClaudeScopeTool(tool, root, policy)
    expect(accepted.kind).toBe('eligible')
    expect(await authorizeClaudeScopeTool(tool, outside, policy)).toEqual({ kind: 'omitted', reason: 'cwd-outside-grant' })
    expect(await authorizeClaudeScopeTool({ ...tool, input: { command: 'pnpm test; cat .env' } }, root, policy))
      .toEqual({ kind: 'omitted', reason: 'command-outside-grant' })
    expect(await authorizeClaudeScopeTool({ ...tool, input: { command: 'pnpm test', run_in_background: true } }, root, policy))
      .toEqual({ kind: 'omitted', reason: 'background-tool' })
    expect(await authorizeClaudeScopeTool({ id: 't', name: 'Read', input: { file_path: join(root, 'secret') } }, root, policy))
      .toEqual({ kind: 'omitted', reason: 'unsupported-tool' })
  })

  it('attributes reported success without copying tool response extras or absolute paths', async () => {
    const { root, policy } = await fixture()
    const input = await writeInput(root, policy, 'syncNonce=123')
    const result = renderClaudeScopeObservation(completion('PostToolUse', { filePath: '/private/secret', extra: 'private output' }), input, sourceId, 2048)
    if (result.kind !== 'observation') throw new Error(result.reason)
    expect(JSON.parse(result.text)).toEqual({
      kind: 'claude-tool-observation', version: 1, sourceId, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: join('new', 'api.txt'), content: 'syncNonce=123' }, omissions: [],
    })
    expect(result.text).not.toContain(root)
    expect(result.text).not.toContain('private output')
  })

  it('reports failure without presenting requested content as applied', async () => {
    const { root, policy } = await fixture()
    const input = await writeInput(root, policy, 'unapplied content')
    const result = renderClaudeScopeObservation(completion('PostToolUseFailure', undefined, 'permission denied'), input, sourceId, 2048)
    if (result.kind !== 'observation') throw new Error(result.reason)
    expect(JSON.parse(result.text)).toEqual({
      kind: 'claude-tool-observation', version: 1, sourceId, tool: 'Write', reportedStatus: 'failure',
      fields: { rootIndex: 0, path: join('new', 'api.txt'), error: 'permission denied' }, omissions: [],
    })
    expect(result.text).not.toContain('unapplied content')
  })

  it('counts complete UTF-8 output and omits whole fields instead of truncating source text', async () => {
    const { root, policy } = await fixture()
    const input = await writeInput(root, policy, '中文🙂'.repeat(40))
    const full = renderClaudeScopeObservation(completion('PostToolUse'), input, sourceId, 4096)
    if (full.kind !== 'observation') throw new Error(full.reason)
    const bytes = Buffer.byteLength(full.text)
    expect(renderClaudeScopeObservation(completion('PostToolUse'), input, sourceId, bytes)).toEqual(full)
    const bounded = renderClaudeScopeObservation(completion('PostToolUse'), input, sourceId, bytes - 1)
    if (bounded.kind !== 'observation') throw new Error(bounded.reason)
    expect(Buffer.byteLength(bounded.text)).toBeLessThan(bytes)
    expect(JSON.parse(bounded.text)).toMatchObject({ fields: { path: join('new', 'api.txt') }, omissions: ['budget:content'] })
    expect(bounded.text).not.toContain('中文')
    expect(renderClaudeScopeObservation(completion('PostToolUse'), input, sourceId, 1))
      .toEqual({ kind: 'omitted', reason: 'observation-attribution-exceeds-budget' })
  })

  it('does not claim unsupported Bash output was collected', async () => {
    const { root, policy } = await fixture()
    const input = await authorizeClaudeScopeTool({ id: 't', name: 'Bash', input: { command: 'pnpm test' } }, root, policy)
    if (input.kind !== 'eligible') throw new Error(input.reason)
    const bad = renderClaudeScopeObservation(completion('PostToolUse', 'unstructured secret'), input, sourceId, 2048)
    if (bad.kind !== 'observation') throw new Error(bad.reason)
    expect(JSON.parse(bad.text)).toMatchObject({ omissions: ['unsupported-tool-response'] })
    expect(bad.text).not.toContain('unstructured secret')
    const valid = renderClaudeScopeObservation(completion('PostToolUse', { stdout: '2 passed', stderr: '', interrupted: false, ignored: 'secret' }), input, sourceId, 2048)
    if (valid.kind !== 'observation') throw new Error(valid.reason)
    expect(JSON.parse(valid.text)).toMatchObject({ fields: { stdout: '2 passed', stderr: '', interrupted: false }, omissions: [] })
    expect(valid.text).not.toContain('secret')
  })
})


describe('independent typed tool reports', () => {
  it('preserves complete Unicode fields and reports omissions against the caller complete-byte budget', async () => {
    const { root, policy } = await fixture()
    const authorized = await writeInput(root, policy, '变化🦊'.repeat(10))
    const input = completion('PostToolUse')
    const full = renderClaudeScopeToolContribution(input, authorized, () => true)
    if (full.kind === 'omitted') throw new Error(full.reason)
    const bytes = (report: typeof full) => Buffer.byteLength(JSON.stringify({ wrapper: 'owner-attribution', report }))
    const exact = renderClaudeScopeToolContribution(input, authorized, report => bytes(report) <= bytes(full))
    expect(exact).toEqual(full)
    const shorter = renderClaudeScopeToolContribution(input, authorized, report => bytes(report) < bytes(full))
    expect(shorter).toMatchObject({ tool: 'Write', reportedStatus: 'success', omissions: ['content'] })
    expect(JSON.stringify(shorter)).not.toContain('变化')
    expect(renderClaudeScopeToolContribution(input, authorized, () => false)).toMatchObject({ kind: 'omitted' })
  })

  it('keeps failure attribution without publishing attempted content as successful evidence', async () => {
    const { root, policy } = await fixture()
    const authorized = await writeInput(root, policy, 'UNCOMMITTED_INPUT')
    const result = renderClaudeScopeToolContribution(completion('PostToolUseFailure', undefined, 'write denied'), authorized, () => true)
    expect(result).toMatchObject({ tool: 'Write', reportedStatus: 'failure', omissions: ['content'], fields: { error: 'write denied' } })
    expect(JSON.stringify(result)).not.toContain('UNCOMMITTED_INPUT')
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it('keeps exact Edit replacement semantics and rejects unrepresentable relative paths', async () => {
    const { root, policy } = await fixture()
    const tool = { id: 'edit-1', name: 'Edit', input: { file_path: join(root, 'design.md'), old_string: 'before', new_string: 'after', replace_all: true } }
    const authorized = await authorizeClaudeScopeTool(tool, root, policy)
    if (authorized.kind !== 'eligible') throw new Error(authorized.reason)
    const input: ClaudeScopeHookInput = { event: 'PostToolUse', sessionId: 'local', tool }
    expect(renderClaudeScopeToolContribution(input, authorized, () => true)).toMatchObject({ tool: 'Edit', omissions: [],
      fields: { path: 'design.md', oldString: 'before', newString: 'after', replaceAll: true } })
    expect(renderClaudeScopeToolContribution(input, { ...authorized, fields: { ...authorized.fields, path: '../private' } }, () => true))
      .toMatchObject({ kind: 'omitted', reason: 'unsupported-contribution-path' })
  })
})
