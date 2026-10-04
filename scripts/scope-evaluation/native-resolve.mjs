/** Public artifact resolution through explicit, dependency-declaring workspace anchors. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve only public exports declared by the specified owner; never search unrelated packages.
 * @param repo Absolute repository checkout containing built workspace packages.
 * @returns Explicit module URLs for the private dsh profile.
 */
export function resolveNativeModules(repo) {
  const owners = {
    scope: join(repo, 'packages/collaboration/claude-scope/package.json'),
    capture: join(repo, 'packages/collaboration/scope-agent-contribution/package.json'),
    sdk: join(repo, 'packages/bundle/sdk-minimal/package.json'),
    jsonl: join(repo, 'packages/session/session-persistence-jsonl/package.json'),
  }
  const names = {
    Launcher: ['scope', '@deepseek-ai/dsh-loader-smoke'],
    Catalog: ['jsonl', '@deepseek-ai/dsh-session-format-catalog'],
    Gateway: ['scope', '@deepseek-ai/dsh-api-gateway'], Connection: ['scope', '@deepseek-ai/dsh-client-connection'],
    Credentials: ['scope', '@deepseek-ai/dsh-credentials-local'], Rooms: ['scope', '@deepseek-ai/dsh-development-room'],
    RoomStorage: ['scope', '@deepseek-ai/dsh-development-room-storage-domain'], Tasks: ['scope', '@deepseek-ai/dsh-development-task'],
    TaskStorage: ['scope', '@deepseek-ai/dsh-development-task-storage-domain'],
    Facts: ['scope', '@deepseek-ai/dsh-development-task-context/facts'], Text: ['scope', '@deepseek-ai/dsh-development-task-context/text'],
    Transport: ['scope', '@deepseek-ai/dsh-scope-transport/libp2p'], Access: ['scope', '@deepseek-ai/dsh-scope-access'],
    Web: ['scope', '@deepseek-ai/dsh-host-webserver'], Storage: ['scope', '@deepseek-ai/dsh-storage'],
    Domain: ['scope', '@deepseek-ai/dsh-storage-domain'], Sqlite: ['scope', '@deepseek-ai/dsh-storage-sqlite'],
    Typert: ['scope', '@deepseek-ai/dsh-typert-registry'], Claude: ['scope', '@deepseek-ai/dsh-claude-scope'],
    Loop: ['sdk', '@deepseek-ai/dsh-agent-loop'], Agents: ['sdk', '@deepseek-ai/dsh-agent'],
    Llm: ['sdk', '@deepseek-ai/dsh-llm'], Session: ['sdk', '@deepseek-ai/dsh-session'],
    Projection: ['sdk', '@deepseek-ai/dsh-session-projection'], Prompt: ['sdk', '@deepseek-ai/dsh-system-prompt'],
    Tools: ['sdk', '@deepseek-ai/dsh-tools'], Jsonl: ['sdk', '@deepseek-ai/dsh-session-persistence-jsonl'],
    Native: ['scope', '@deepseek-ai/dsh-scope-agent-context'],
    DeepSeek: ['sdk', '@deepseek-ai/dsh-llm-deepseek'],
    Semantic: ['scope', '@deepseek-ai/dsh-development-task-context/semantic'],
    FsLocal: ['capture', '@deepseek-ai/dsh-fs-local'], FsPolicy: ['capture', '@deepseek-ai/dsh-fs-observation-policy'],
    ToolFs: ['capture', '@deepseek-ai/dsh-tool-fs'], Contribution: ['capture', '@deepseek-ai/dsh-scope-agent-contribution'],
  }
  return Object.fromEntries(Object.entries(names).map(([key, [owner, specifier]]) => {
    const anchor = owners[owner]
    const manifest = JSON.parse(readFileSync(anchor, 'utf8'))
    if (manifest === null || typeof manifest !== 'object') throw new Error('invalid dependency anchor')
    const packageName = specifier.split('/').slice(0, 2).join('/')
    const declared = ('name' in manifest && manifest.name === packageName)
      || ['dependencies', 'devDependencies', 'peerDependencies'].some((field) => {
        const record = manifest[field]
        return record !== null && typeof record === 'object' && Object.hasOwn(record, packageName)
      })
    if (!declared) throw new Error(`${owner} does not declare ${packageName}`)
    return [key, pathToFileURL(createRequire(anchor).resolve(specifier)).href]
  }))
}

const repo = process.argv[2]
if (repo === undefined) throw new Error('repository path is required')
process.stdout.write(JSON.stringify(resolveNativeModules(repo)) + '\n')
