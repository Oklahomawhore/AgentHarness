/** Real source tools, durable Session evidence, owner admission, and recipient model requests. */
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ScopeAgentContributionCapture } from '../src/types.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, requestText, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
})

function gate() {
  const result = Promise.withResolvers<undefined>()
  releases.push(() => { result.resolve(undefined) })
  return result
}

async function fixture(mode: 'native' | 'ptc' = 'native') {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source', mode)
  hosts.push(source)
  const receiver = await createHost(network, 'receiver')
  hosts.push(receiver)
  const task = await rootTask(owner)
  const agent = await source.createAgent('native-source')
  const recipient = await receiver.createAgent('native-recipient')
  const allowed = join(source.workspace, 'project')
  await mkdir(join(allowed, 'src'), { recursive: true })
  await mkdir(join(allowed, 'manual'))
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('owner address missing')
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: Date.now() + 50000 })
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 16, maxSampleBytes: 8192 }
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    entry: entry.entry, roots: [allowed], tools: ['write', 'edit'], limits })
  if (requested.capture === null) throw new Error('source consent was not retained')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
    .toBe('pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: requested.capture.proposal, limits, ownerAddress })
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting).toBe(true)
  const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiver.peerId,
    ownerAddress, expiresAt: Date.now() + 50000, responsibility: 'Implement the client and update its documentation.' })
  await receiver.ctx.scopeAgentContext.bind({ agentId: recipient.id, expectedBindingId: null, invitation, automatic: null })
  return { owner, source, receiver, task, agent, recipient, allowed, selection: requested.capture.selection }
}

function calls(mode: 'native' | 'ptc', values: readonly { name: string; args: object }[]): StreamChunk[][] {
  if (mode === 'native') return values.map((value, index) => toolCallResponse(`native-${index}`, value.name, value.args))
  const code = values.map(value => `await tools.${value.name}(${JSON.stringify(value.args)});`).join('\n')
  return [toolCallResponse('ptc-outer', 'run_code', { code, description: 'Perform the authorized file changes.' })]
}

async function capture(source: TestHost, agent: Agent): Promise<ScopeAgentContributionCapture> {
  const value = (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture
  if (value === null) throw new Error('expected a retained capture')
  return value
}

function currentScope(agent: Agent) {
  return agent.session.deriveMessages().filter(message => message.source.kind === 'scope-agent-context')
}

function assertRequestReplay(host: TestHost, agent: Agent): string {
  const actual = host.adapter.requests.at(-1)
  if (actual === undefined) throw new Error('recipient made no request')
  const events = structuredClone(agent.session.snapshotEvents())
  const replay = Session.create(agent.id, events, agent.session.header)
  const visible = actual.messages.filter(message => message.source.kind === 'scope-agent-context')
  expect(visible).toHaveLength(1)
  expect(replay.deriveMessages().filter(message => message.source.kind === 'scope-agent-context')).toEqual(visible)
  expect(currentScope(agent)).toEqual(visible)
  return requestText(actual)
}

describe('native contribution through Loader, actual tools, and independent owner authority', () => {
  it('persists a real source Session through its configured JSONL provider', async () => {
    const source = await createHost(new TestNetwork(), 'source')
    hosts.push(source)
    expect(source.ctx.get('sessionPersistence')).toBeDefined()
    const agent = await source.createAgent('durability-source')
    await run(source, agent)
    expect(await source.ctx.sessions.flush(agent.session)).toBe(true)
    expect(await source.ctx.sessionPersistence.stat(agent.id)).toBeDefined()
    expect(await source.readEvents(agent)).toEqual(agent.session.snapshotEvents())
  })

  it.each(['native', 'ptc'] as const)('automatically contributes two unregistered files in %s mode and withdraws them from the recipient', async (mode) => {
    const { owner, source, receiver, task, agent, recipient } = await fixture(mode)
    let durableSamples = 0
    source.transport.beforeRequest = async (protocol, payload) => {
      if (protocol !== '/agentharness/scope-contribute/1' || typeof payload !== 'object' || payload === null
        || !('op' in payload) || payload.op !== 'sample') return
      const events = await source.readEvents(agent)
      const completed = events.filter(event => mode === 'native' ? event.type === 'tool/result' : event.type === 'tool/ptc-dispatch')
      expect(completed.length).toBeGreaterThan(durableSamples)
      durableSamples++
    }
    await run(source, agent, calls(mode, [
      { name: 'write', args: { file_path: 'project/src/client.ts', content: 'export const mode = "NATIVE_ALPHA";\n' } },
      { name: 'write', args: { file_path: 'project/manual/guide.md', content: 'NATIVE_BETA: keep the client documentation aligned.\n' } },
      { name: 'edit', args: { file_path: 'project/src/client.ts', old_string: 'NATIVE_ALPHA', new_string: 'NATIVE_CORRECTED' } },
    ]))
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(3)
    expect(durableSamples).toBe(3)
    expect(await readFile(join(source.workspace, 'project/src/client.ts'), 'utf8')).toBe('export const mode = "NATIVE_CORRECTED";\n')
    expect(await readFile(join(source.workspace, 'project/manual/guide.md'), 'utf8')).toContain('NATIVE_BETA')
    const log = await source.readEvents(agent)
    const tools = log.filter(event => event.type === 'tool/call')
    expect(tools.map(event => event.data.name)).toEqual(mode === 'native' ? ['write', 'write', 'edit'] : ['run_code'])
    expect(log.filter(event => event.type === 'tool/result')).toHaveLength(mode === 'native' ? 3 : 1)
    if (mode === 'ptc') {
      const nested = log.filter(event => event.type === 'tool/ptc-dispatch')
      expect(nested.map(event => [event.data.name, event.data.isError])).toEqual([['write', false], ['write', false], ['edit', false]])
      expect(nested.every(event => event.data.rootCallId === tools[0]?.data.callId)).toBe(true)
    }
    const publications = owner.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(publications.map(item => item.peerToolObservation?.sequence)).toEqual([1, 2, 3])
    expect(publications.map(item => item.peerToolObservation?.fields.path)).toEqual(['src/client.ts', 'manual/guide.md', 'src/client.ts'])
    expect(publications.every(item => item.peerToolObservation?.observerPeerId === source.peerId)).toBe(true)
    expect(JSON.stringify(publications)).not.toContain(source.workspace)
    expect(JSON.stringify(publications)).not.toContain(agent.id)
    await run(receiver, recipient)
    const first = assertRequestReplay(receiver, recipient)
    for (const value of ['NATIVE_ALPHA', 'NATIVE_BETA', 'NATIVE_CORRECTED']) expect(first).toContain(value)
    expect(first).toContain('not a current file snapshot')
    expect(recipient.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
    expect(source.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    expect(receiver.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    const active = await capture(source, agent)
    if (active.invitation === null) throw new Error('active invitation missing')
    await owner.ctx.scopeAccess.revokeContribution({ grant: active.invitation.grant })
    await run(receiver, recipient)
    const withdrawn = assertRequestReplay(receiver, recipient)
    for (const value of ['NATIVE_ALPHA', 'NATIVE_BETA', 'NATIVE_CORRECTED']) expect(withdrawn).not.toContain(value)
    expect(withdrawn).toContain('revoked')
    const history = recipient.session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(JSON.stringify(history)).toContain('NATIVE_BETA')
    expect([...owner.exitCodes, ...source.exitCodes, ...receiver.exitCodes]).toEqual([])
  })

  it('does not collect an unselected Session, read, Bash, outside targets, or a symlink escape', async () => {
    const { owner, source, task, agent, allowed } = await fixture()
    const other = await source.createAgent('unselected-source')
    await run(source, other, calls('native', [{ name: 'write', args: { file_path: 'project/unselected.txt', content: 'UNSELECTED' } }]))
    await writeFile(join(allowed, 'read-only.txt'), 'READ_ONLY')
    await symlink(source.workspace, join(allowed, 'escape'))
    await run(source, agent, calls('native', [
      { name: 'read', args: { file_path: 'project/read-only.txt' } },
      { name: 'bash', args: { command: "printf 'BASH_ONLY' > project/bash-only.txt", description: 'Write a non-contributed Bash file.' } },
      { name: 'write', args: { file_path: 'outside.txt', content: 'OUTSIDE' } },
      { name: 'write', args: { file_path: 'project/escape/escaped.txt', content: 'SYMLINK_OUTSIDE' } },
    ]))
    expect(await readFile(join(allowed, 'unselected.txt'), 'utf8')).toBe('UNSELECTED')
    expect(await readFile(join(allowed, 'bash-only.txt'), 'utf8')).toBe('BASH_ONLY')
    expect(await readFile(join(source.workspace, 'outside.txt'), 'utf8')).toBe('OUTSIDE')
    expect(await readFile(join(source.workspace, 'escaped.txt'), 'utf8')).toBe('SYMLINK_OUTSIDE')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    expect((await capture(source, agent)).pendingSamples).toBe(0)
    const settled = await source.readEvents(agent)
    expect(settled.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['read', 'bash', 'write', 'write'])
  })

  it('shares a real failed Edit as failure without fabricated replacement fields', async () => {
    const { owner, source, receiver, task, agent, recipient, allowed } = await fixture()
    await writeFile(join(allowed, 'failure.txt'), 'unchanged')
    await run(source, agent, calls('native', [
      { name: 'read', args: { file_path: 'project/failure.txt' } },
      { name: 'edit', args: { file_path: 'project/failure.txt', old_string: 'missing', new_string: 'NEVER_WRITTEN' } },
    ]))
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(1)
    const observation = owner.ctx.developmentTasks.get({ taskId: task.id }).context[0]?.peerToolObservation
    expect(observation).toMatchObject({ tool: 'Edit', reportedStatus: 'failure', fields: { path: 'failure.txt' } })
    expect(observation?.fields).not.toHaveProperty('newString')
    expect(observation?.fields).not.toHaveProperty('oldString')
    expect(observation?.omissions).toEqual(expect.arrayContaining(['oldString', 'newString']))
    expect(await readFile(join(allowed, 'failure.txt'), 'utf8')).toBe('unchanged')
    await run(receiver, recipient)
    const actual = assertRequestReplay(receiver, recipient)
    expect(actual).toContain('failure')
    expect(actual).not.toContain('NEVER_WRITTEN')
  })

  it('does not treat an agent-local tool named write as filesystem evidence', async () => {
    const { owner, source, task, agent } = await fixture()
    agent.ctx.effect(() => agent.ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'A fixture with no filesystem provider operation.',
      parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      execute() { return Promise.resolve([{ type: 'text', text: 'Pretended to write.' }]) },
    })))
    await run(source, agent, calls('native', [{ name: 'write', args: { file_path: 'project/not-written.txt', content: 'FAKE_TOOL' } }]))
    await expect(readFile(join(source.workspace, 'project/not-written.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    expect((await capture(source, agent)).pendingSamples).toBe(0)
    const log = await source.readEvents(agent)
    expect(log.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write'])
    expect(log.filter(event => event.type === 'tool/result')).toHaveLength(1)
  })

  it('cancels an admitted tool before provider dispatch without publishing it after source Stop', async () => {
    const { owner, source, task, agent, selection } = await fixture()
    const entered = gate()
    const release = gate()
    source.ctx.on('tools/execute', async (execution, next) => {
      if (execution.name !== 'write') return await next()
      entered.resolve(undefined)
      await release.promise
      return await next()
    }, { prepend: true })
    source.script.push(...calls('native', [{ name: 'write', args: { file_path: 'project/cancelled.txt', content: 'CANCELLED_SOURCE' } }]),
      textResponse('Unused after cancellation.'))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Attempt the authorized write.' }] }))
    await entered.promise
    agent.cancel({ kind: 'user' })
    await source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: selection })
    release.resolve(undefined)
    await agent.whenIdle()
    await expect(readFile(join(source.workspace, 'project/cancelled.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.peerToolObservation !== undefined)).toEqual([])
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting ?? false).toBe(false)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
  })
})
