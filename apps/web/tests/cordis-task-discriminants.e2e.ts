/** Model-written Host JavaScript reaches Task discriminant guards through the shipped Web composition. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'

const BASELINE_CODE = `
return {
  inject: ['developmentRooms', 'developmentTasks'],
  async apply(ctx) {
    await ctx.developmentRooms.announce({
      id: 'cordis-task-owner', kind: 'human', displayName: 'Task fixture owner',
    })
    await ctx.developmentTasks.create({
      origin: { kind: 'root' }, createdBy: 'cordis-task-owner',
      objective: 'Preserve the committed Task', scope: 'Dynamic Host discriminants',
    })
  },
}
`
const UNSUPPORTED_ORIGIN_CODE = `
return {
  inject: ['developmentTasks'],
  async apply(ctx) {
    const baseline = ctx.developmentTasks.list({ limit: 1 })[0]
    await ctx.developmentTasks.create({
      origin: { kind: 'branch' }, createdBy: baseline.createdBy,
      objective: 'Reject the unsupported origin', scope: baseline.scope,
    })
  },
}
`

function toolReply(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Cordis Task fixture cleanup failed')
})

// The shipped native Web composition is unavailable on Windows.
it.skipIf(process.platform === 'win32')('rejects an unsupported Task origin from model-written Host JavaScript without changing committed state', async () => {
  if (webSnapshotMode() === 'record') throw new Error('Task discriminant acceptance uses only controlled keyless replies')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cordis-task-discriminants-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const overrideFile = join(directory, 'replay.override.json')
  const script: ReplayOverrideDoc = []
  for (const [index, [prefix, code]] of ([['base', BASELINE_CODE], ['bad', UNSUPPORTED_ORIGIN_CODE]] as const).entries()) {
    script.push({ kind: 'chunks', chunks: toolReply(`${prefix}-define`, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: prefix }, name: `${prefix} Task probe`,
      purpose: 'Exercise Task creation from Host JavaScript', code: { host: code },
    }) })
    script.push({ kind: 'chunks', chunks: toolReply(`${prefix}-run`, 'cordis_run', {
      pluginId: `${prefix}-${String(index + 1)}`, packageId: `pkg-${String(index + 1)}`, mode: 'run',
    }) })
    script.push({ kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: `${prefix} complete` },
      { type: 'block-end', index: 0, block: { type: 'text', text: `${prefix} complete` } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] })
  }
  await writeFile(overrideFile, JSON.stringify(script))
  const host = await launchWebScaffold({ hermeticMcpClients: true, cordisTools: true, toolsMode: 'native', paceMs: 0,
    replayFixture: join(directory, 'override-only.jsonl'), replayOverride: overrideFile })
  cleanup.push(() => host.close())
  let persisted = 0
  let changed = 0
  host.ctx.on('development-task/persist', () => { persisted++ })
  host.ctx.on('development-task/changed', () => { changed++ })
  const handle = await host.ctx.agents.create({ sessionId: SessionId('cordis-task-discriminants'),
    meta: { cwd: host.workspaceCwd }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: ctx => host.ctx.agentPresets.mount(ctx).then(() => undefined) })
  cleanup.push(() => handle.dispose())
  const baselineSettled = host.whenTurnSettled()
  handle.agent.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Create the baseline Task through a Host-only Cordis Package.' }] }))
  expect(await baselineSettled).toBe(handle.agent.id)
  const beforeTasks = structuredClone(host.ctx.developmentTasks.list({ limit: 16 }))
  const beforeLog = structuredClone(host.ctx.developmentTasks.log())
  expect(beforeTasks).toMatchObject([{ revision: 1, origin: { kind: 'root' }, objective: 'Preserve the committed Task' }])
  expect(beforeLog).toHaveLength(1)
  expect({ persisted, changed }).toEqual({ persisted: 1, changed: 1 })

  const rejectedSettled = host.whenTurnSettled()
  handle.agent.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Try the unsupported Task origin through another Host-only Cordis Package.' }] }))
  expect(await rejectedSettled).toBe(handle.agent.id)
  const events = handle.agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([
    { kind: 'completed' }, { kind: 'completed' },
  ])
  const calls = events.filter(event => event.type === 'tool/call')
  expect(calls.map(event => event.data.name)).toEqual(['cordis_define', 'cordis_run', 'cordis_define', 'cordis_run'])
  const results = events.filter(event => event.type === 'tool/result')
  expect(results.map(event => event.data.message.content[0].isError)).toEqual([false, false, false, true])
  const rejection = results.at(-1)?.data.message.content[0]
  expect(rejection?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    .toContain('unsupported Task discriminant: {"kind":"branch"}')
  expect(host.ctx.developmentTasks.list({ limit: 16 })).toEqual(beforeTasks)
  expect(host.ctx.developmentTasks.log()).toEqual(beforeLog)
  expect({ persisted, changed }).toEqual({ persisted: 1, changed: 1 })
})
