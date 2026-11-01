import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureCodexHooks, inspectCodexHooks } from '../src/codex-hooks.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-hooks-'))
  roots.push(root)
  return join(root, 'hooks.json')
}

describe.skipIf(process.platform === 'win32')('Codex hook configuration', () => {
  it('installs exact automatic receiving definitions without adding trust state', async () => {
    const path = await fixture()
    expect(await inspectCodexHooks(path)).toEqual({ state: 'not-configured', configPath: path })
    await configureCodexHooks(path)
    expect(await inspectCodexHooks(path)).toEqual({ state: 'configured', configPath: path })
    const text = await readFile(path, 'utf8')
    expect(JSON.parse(text)).toEqual({ hooks: Object.fromEntries(['UserPromptSubmit', 'PostToolUse'].map(event => [event, [{ hooks: [{
      type: 'mcp_tool', server: 'agentharness', tool: 'agentharness_codex_hook',
      input: { sessionId: '${session_id}', cwd: '${cwd}', event: '${hook_event_name}' },
    }] }]])) })
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    await configureCodexHooks(path)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('preserves unrelated hooks and fills only a missing receiving event', async () => {
    const path = await fixture()
    await configureCodexHooks(path)
    const document = JSON.parse(await readFile(path, 'utf8')) as { hooks: Record<string, unknown[]> }
    const unrelated = { matcher: 'Bash', hooks: [{ type: 'command', command: '/local/review' }] }
    delete document.hooks.PostToolUse
    document.hooks.UserPromptSubmit?.push(unrelated)
    document.hooks.Stop = [unrelated]
    await writeFile(path, JSON.stringify({ ...document, description: 'Keep this preference' }))
    await Promise.all([configureCodexHooks(path), configureCodexHooks(path)])
    const restored: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(restored).toMatchObject({ description: 'Keep this preference', hooks: { Stop: [unrelated] } })
    expect((restored as typeof document).hooks.UserPromptSubmit).toHaveLength(2)
    expect((restored as typeof document).hooks.PostToolUse).toHaveLength(1)
    expect((await inspectCodexHooks(path)).state).toBe('configured')
  })

  it.each([
    '{broken', '[]', '{"hooks":null}', '{"hooks":{"UserPromptSubmit":{}}}',
    '{"hooks":{"PostToolUse":[null]}}', '{"hooks":{"PostToolUse":[{"hooks":[null]}]}}',
    JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'agentharness', tool: 'agentharness_codex_hook' }] }] } }),
  ])('refuses malformed or conflicting hook definitions: %s', async (contents) => {
    const path = await fixture()
    await writeFile(path, contents)
    expect(['conflict', 'failed']).toContain((await inspectCodexHooks(path)).state)
    await expect(configureCodexHooks(path)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(contents)
  })

  it('refuses a symbolic-link hooks file without changing the target', async () => {
    const path = await fixture()
    const target = path + '.target'
    await writeFile(target, '{}\n')
    await symlink(target, path)
    expect((await inspectCodexHooks(path)).state).toBe('failed')
    await expect(configureCodexHooks(path)).rejects.toThrow('symbolic-link')
    expect(await readFile(target, 'utf8')).toBe('{}\n')
  })

  it('preserves a directory occupying the hook file path', async () => {
    const path = await fixture()
    await mkdir(path)
    const retained = join(path, 'user-data.txt')
    await writeFile(retained, 'Keep this file')
    expect((await inspectCodexHooks(path)).state).toBe('failed')
    await expect(configureCodexHooks(path)).rejects.toThrow()
    expect(await readFile(retained, 'utf8')).toBe('Keep this file')
  })
})
