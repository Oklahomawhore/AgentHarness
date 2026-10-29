/** Private official-CLI protocol stand-in shared by process and browser acceptance. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Files owned by one isolated Codex setup fixture. */
export interface CodexCliFixture {
  readonly settingsPath: string
  readonly registrationLogPath: string
}

/**
 * Write an isolated Codex MCP list/add command with a retained unrelated server.
 * @param home - Private fixture directory owning settings and registration evidence.
 * @param bin - Private executable directory added only to the fixture Host's PATH.
 * @returns Settings and registration-log paths; the caller owns their directory cleanup.
 */
export async function createCodexCliFixture(home: string, bin: string): Promise<CodexCliFixture> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const settingsPath = join(home, 'codex-settings.json')
  const registrationLogPath = join(home, 'codex-registration.log')
  const programPath = join(home, 'codex-cli.mjs')
  await writeFile(settingsPath, JSON.stringify({ keep: 'unrelated preference', servers: [
    { name: 'sibling', enabled: true, transport: { type: 'stdio', command: 'existing-server', args: [] } },
  ] }), { mode: 0o600 })
  await writeFile(programPath, `import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
const args = process.argv.slice(2)
assert.equal(args[0], 'mcp')
const path = ${JSON.stringify(settingsPath)}
const settings = JSON.parse(await readFile(path, 'utf8'))
if (args[1] === 'list') process.stdout.write(JSON.stringify(settings.servers))
else {
  assert.equal(args[1], 'add')
  assert.equal(args[2], 'agentharness')
  const split = args.indexOf('--')
  assert.ok(split > 2)
  const env = {}
  for (let index = 3; index < split; index += 2) {
    assert.equal(args[index], '--env')
    const pair = args[index + 1]
    const equals = pair.indexOf('=')
    env[pair.slice(0, equals)] = pair.slice(equals + 1)
  }
  settings.servers.push({ name: args[2], enabled: true,
    transport: { type: 'stdio', command: args[split + 1], args: args.slice(split + 2), env } })
  await appendFile(${JSON.stringify(registrationLogPath)}, JSON.stringify(args))
  await writeFile(path, JSON.stringify(settings))
}
`, { mode: 0o600 })
  const quoted = [process.execPath, programPath].map(value => "'" + value.replaceAll("'", "'\\''") + "'")
  await writeFile(join(bin, 'codex'), `#!/bin/sh\nexec ${quoted.join(' ')} "$@"\n`, { mode: 0o700 })
  return { settingsPath, registrationLogPath }
}
