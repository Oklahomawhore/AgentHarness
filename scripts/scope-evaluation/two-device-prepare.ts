/** Prepare one independently owned Web calibration device; does not start an application or call a model. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { resolveNativeModules } from './native-dependencies.ts'

/** Locally generated file content; the peer's content is absent from this device's program. */
export interface DeviceFile { readonly path: string; readonly text: string }
/** Human continuation text contains no business fact. */
export interface DeviceStage { readonly prompt: string; readonly reply: string }
/** Private, single-device preparation manifest for a built checkout. */
export interface DevicePreparation {
  readonly version: 1
  readonly role: 'A' | 'B'
  readonly root: string
  readonly home: string
  readonly workspace: string
  readonly overlayPath: string
  readonly evidencePath: string
  readonly sessionRoot: string
  readonly expectedRequests: number
  readonly environment: Readonly<Record<'DSH_HOME' | 'DSH_AGENTS_HOME' | 'DSH_BUNDLED_SKILL_DIR', string>>
  readonly files: { readonly shared: DeviceFile; readonly afterLeave: DeviceFile; readonly private?: DeviceFile }
  readonly stages: Readonly<Record<'ready' | 'publish' | 'receive' | 'afterLeave', DeviceStage>>
  readonly modelTrialsExecuted: 0
  readonly sourceHashes: Readonly<Record<string, string>>
}

function reply(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function write(id: string, file: DeviceFile): StreamChunk[] {
  const callId = ToolCallId(id)
  const args = JSON.stringify({ file_path: file.path, content: file.text })
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'write', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'write', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function file(path: string, marker: string, nonce: string): DeviceFile {
  return { path, text: `export const fact = ${JSON.stringify(`${marker}_${nonce}`)};\n` }
}

/** Create a private root and one role's keyless Web overlay, refusing an existing destination.
 * @param options Built checkout, absolute new root, and independently prepared device role.
 * @returns Manifest for normal dsh --profile web launch and read-only evidence inspection.
 */
export async function prepareDevice(options: { repo: string; root: string; role: 'A' | 'B' }): Promise<DevicePreparation> {
  const { repo, root, role } = options
  if (!isAbsolute(repo) || !isAbsolute(root)) throw new Error('repo and root must be absolute paths')
  const modules = resolveNativeModules(repo)
  const observer = join(repo, 'scripts/scope-evaluation/two-device-observer.mjs')
  const replay = join(repo, 'packages/test-support/llm-replay/lib/index.js')
  const sources = [observer, replay, join(repo, 'scripts/scope-evaluation/two-device-prepare.ts')]
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')] as const)))
  await mkdir(root, { mode: 0o700 })
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const sessionRoot = join(root, 'sessions')
  await Promise.all([mkdir(home), mkdir(join(workspace, 'project'), { recursive: true }), mkdir(sessionRoot)])
  const nonce = randomUUID()
  const files = role === 'A'
    ? { shared: file('project/owner.ts', 'A_SHARED', nonce), afterLeave: file('project/owner-after.ts', 'A_AFTER_LEAVE', nonce) }
    : { private: file('project/before.ts', 'B_PRIVATE', nonce), shared: file('project/shared.ts', 'B_SHARED', nonce),
      afterLeave: file('project/after.ts', 'B_AFTER', nonce) }
  const stage = (name: string, marker: string): DeviceStage => ({ prompt: `${role}: ${name}.`, reply: marker })
  const stages = { ready: stage('Complete your initial local work', `${role}_READY`),
    publish: stage('Complete your local shared work', `${role}_PUBLISHED`),
    receive: stage('Continue with currently available context', `${role}_RECEIVED`),
    afterLeave: stage('Complete your local work after shared reading ends', role === 'A' ? 'A_AFTER_PUBLISHED' : 'B_LEFT') }
  const program: StreamChunk[][] = [
    ...files.private === undefined ? [] : [write(`${role}-private`, files.private)], reply(stages.ready.reply),
    ...role === 'A' ? [write('A-shared', files.shared), reply(stages.publish.reply), reply(stages.receive.reply)]
      : [reply(stages.receive.reply), write('B-shared', files.shared), reply(stages.publish.reply)],
    write(`${role}-after`, files.afterLeave), reply(stages.afterLeave.reply),
  ]
  const script: ReplayOverrideDoc = program.map(chunks => ({ kind: 'chunks', chunks }))
  const overrides = join(root, 'responses.json')
  const evidencePath = join(root, 'evidence')
  const overlayPath = join(root, 'device.cordis.yml')
  const overlay = [
    { id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', disabled: true },
    { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-instructions', disabled: true }, { id: 'mcp-client-setup', disabled: true },
    { id: 'open-in-app', disabled: true }, { id: 'ui-open-in-app', disabled: true },
    { id: 'agent-default-model', config: { provider: 'scope-calibration', model: 'controlled' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'agent-presets', config: { default: 'standard', includeUserRoot: false } },
    { id: 'session-persistence-jsonl', config: { root: sessionRoot, compression: 'none' } },
    { id: 'storage-json', config: { root: join(root, 'storage') } },
    { id: 'settings', config: { dshHome: home } }, { id: 'credentials', config: { dshHome: home } },
    { id: 'skill-filesystem', config: { dshHome: home, agentsHome: join(root, 'agents'),
      bundledSkillDir: join(root, 'skills'), watch: false } },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
      { id: 'two-device-replay', name: pathToFileURL(replay).href, config: {
        file: join(root, 'unrecorded-session.jsonl'), overrideFile: overrides, childFiles: [],
        providers: [{ id: 'scope-calibration', name: 'Controlled calibration',
          models: [{ id: 'controlled', contextWindow: 128000, defaultMaxTokens: 4096 }],
          retryPolicy: { mode: 'normal', maxRetries: 0 } }],
      } },
      { id: 'two-device-observer', name: pathToFileURL(observer).href, config: {
        directory: evidencePath, sessionRoot,
        modules: { Session: modules.Session, Catalog: modules.Catalog, Llm: modules.Llm },
        maxSessions: 1, expectedRequests: program.length, maxRequestBytes: 4 * 1024 * 1024,
        maxSessionBytes: 32 * 1024 * 1024, maxEvidenceBytes: 64 * 1024 * 1024, drainBudgetMs: 15000,
      } },
    ] },
  ]
  const manifest: DevicePreparation = { version: 1, role, root, home, workspace, overlayPath, evidencePath,
    sessionRoot, expectedRequests: program.length, environment: { DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'),
      DSH_BUNDLED_SKILL_DIR: join(root, 'skills') }, files, stages, modelTrialsExecuted: 0, sourceHashes }
  for (const [path, value] of [[overrides, script], [overlayPath, overlay], [join(root, 'device.json'), manifest]] as const) {
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  return manifest
}

/** Parse the preparation command; the generated overlay is launched separately with dsh.
 * @param args Ordered --output and --role arguments.
 * @returns Prepared device manifest.
 */
export async function runPreparation(args: readonly string[]): Promise<DevicePreparation> {
  const [outputFlag, output, roleFlag, role] = args
  if (args.length !== 4 || outputFlag !== '--output' || output === undefined || roleFlag !== '--role'
    || (role !== 'A' && role !== 'B')) throw new Error('usage: two-device-prepare.ts --output <new-directory> --role <A|B>')
  return prepareDevice({ repo: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), root: resolve(output), role })
}
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const prepared = await runPreparation(process.argv.slice(2))
  process.stdout.write(JSON.stringify({ manifest: join(prepared.root, 'device.json'), modelTrialsExecuted: 0 }) + '\n')
}
