/** Recorded model-written Host JavaScript reaches Task validation through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/cordis-task-validation/session.v3.jsonl', import.meta.url))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Cordis Task fixture cleanup failed')
})

// The shipped native Web composition is unavailable on Windows.
it.skipIf(process.platform === 'win32')('rejects invalid model-written Task input without changing committed Task state', async () => {
  if (webSnapshotMode() === 'record') throw new Error('Task validation acceptance uses only controlled keyless replies')
  const fixture = await selectedSessionFixture(FIXTURE)
  const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
  expect(prompts).toHaveLength(3)
  const host = await launchWebScaffold({ hermeticMcpClients: true, cordisTools: true, toolsMode: 'native', paceMs: 0,
    replayFixture: fixture, compareReplaySession: true })
  cleanup.push(() => host.close())
  let persisted = 0
  let changed = 0
  host.ctx.on('development-task/persist', () => { persisted++ })
  host.ctx.on('development-task/changed', () => { changed++ })
  const handle = await host.ctx.agents.create({ sessionId: SessionId('cordis-task-validation'),
    meta: { cwd: host.workspaceCwd }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: ctx => host.ctx.agentPresets.mount(ctx).then(() => undefined) })
  cleanup.push(() => handle.dispose())
  const baselineSettled = host.whenTurnSettled()
  handle.agent.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: prompts[0]! }] }))
  expect(await baselineSettled).toBe(handle.agent.id)
  const baselineResult = handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .at(-1)?.data.message.content[0]
  expect(baselineResult).toMatchObject({ isError: false })
  const beforeTasks = structuredClone(host.ctx.developmentTasks.list({ limit: 16 }))
  const beforeLog = structuredClone(host.ctx.developmentTasks.log())
  expect(beforeTasks).toMatchObject([{ revision: 1, origin: { kind: 'root' }, objective: 'Preserve the committed Task' }])
  expect(beforeLog).toHaveLength(1)
  expect({ persisted, changed }).toEqual({ persisted: 1, changed: 1 })

  const rejections = ['unsupported Task discriminant: {"kind":"branch"}',
    'artifact sample sequence must reserve its terminal successor']
  for (const [index, prompt] of prompts.slice(1).entries()) {
    const rejectedSettled = host.whenTurnSettled()
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }))
    expect(await rejectedSettled).toBe(handle.agent.id)
    const rejection = handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .at(-1)?.data.message.content[0]
    expect(rejection?.isError).toBe(true)
    expect(rejection?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      .toContain(rejections[index])
    expect(host.ctx.developmentTasks.list({ limit: 16 })).toEqual(beforeTasks)
    expect(host.ctx.developmentTasks.log()).toEqual(beforeLog)
    expect({ persisted, changed }).toEqual({ persisted: 1, changed: 1 })
  }
  const events = handle.agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([
    { kind: 'completed' }, { kind: 'completed' }, { kind: 'completed' },
  ])
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name))
    .toEqual(['cordis_define', 'cordis_run', 'cordis_define', 'cordis_run', 'cordis_define', 'cordis_run'])
  expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.content[0].isError))
    .toEqual([false, false, false, true, false, true])
})
