#!/usr/bin/env node
/** Exercise a running portable AgentHarness through its shipped stdio MCP bridge. */

import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}

const portableRoot = resolve(option('--root', '.'))
const url = option('--url', 'http://127.0.0.1:3080')
const expectExisting = process.argv.includes('--expect-existing')
const sdkRoot = await realpath(join(
  portableRoot, 'node_modules', '.pnpm', 'node_modules', '@modelcontextprotocol', 'sdk',
))
const { Client } = await import(pathToFileURL(join(sdkRoot, 'dist', 'esm', 'client', 'index.js')).href)
const { StdioClientTransport } = await import(pathToFileURL(join(sdkRoot, 'dist', 'esm', 'client', 'stdio.js')).href)

async function connect(participantId, displayName) {
  const client = new Client({ name: `agentharness-portable-e2e-${participantId}`, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(portableRoot, 'mcp.mjs'), '--url', url,
      '--participant-id', participantId, '--display-name', displayName,
    ],
    stderr: 'pipe',
  })
  await client.connect(transport)
  return client
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args })
  if (response.isError) {
    const detail = response.content?.map(item => item.type === 'text' ? item.text : '').join('\n')
    throw new Error(`${name} failed: ${detail}`)
  }
  return response.structuredContent?.items
    ?? response.structuredContent
}

const codex = await connect('codex-agent', 'Codex Agent')
try {
  const tools = await codex.listTools()
  assert.equal(tools.tools.length, 9)
  assert.equal(tools.tools.some(tool => /evidence|transition|approve/u.test(tool.name)), false)
  const initialTasks = await call(codex, 'agentharness_task_list', {})
  if (expectExisting) assert(initialTasks.length > 0)

  const created = await call(codex, 'agentharness_task_create', {
    objective: 'Portable shared context',
    scope: 'Prove lineage, explicit publication, and session isolation',
  })
  const root = created.task
  const rootSession = await call(codex, 'agentharness_task_connect', {
    taskId: root.id,
    sessionLabel: 'Codex / root session',
  })
  assert.equal(rootSession.connectedTask.id, root.id)
  await call(codex, 'agentharness_task_context_publish', {
    bindingId: rootSession.bindingId,
    taskId: root.id,
    text: 'Portable context is explicit and inheritable',
  })
  const rootHead = await call(codex, 'agentharness_task_get', { taskId: root.id })

  const firstForked = await call(codex, 'agentharness_task_fork', {
    parent: { taskId: root.id, revision: rootHead.revision },
    objective: 'First portable Fork',
    scope: 'Pinned root context',
  })
  const firstFork = firstForked.task
  const secondForked = await call(codex, 'agentharness_task_fork', {
    parent: { taskId: root.id, revision: rootHead.revision },
    objective: 'Second portable Fork',
    scope: 'Same content-addressed parent revision',
  })
  const secondFork = secondForked.task
  const mergedResult = await call(codex, 'agentharness_task_merge', {
    parents: [
      { taskId: firstFork.id, revision: firstFork.revision },
      { taskId: secondFork.id, revision: secondFork.revision },
    ],
    objective: 'Merged portable context',
    scope: 'Two immutable parent revisions',
  })
  const merged = mergedResult.task
  assert.equal(merged.origin.parents.length, 2)

  const forkSession = await call(codex, 'agentharness_task_connect', {
    taskId: firstFork.id,
    sessionLabel: 'Codex / fork session',
  })
  assert.notEqual(rootSession.bindingId, forkSession.bindingId)
  const rootStatus = await call(codex, 'agentharness_task_status', { bindingId: rootSession.bindingId })
  const forkStatus = await call(codex, 'agentharness_task_status', { bindingId: forkSession.bindingId })
  assert.equal(rootStatus.connectedTask.id, root.id)
  assert.equal(forkStatus.connectedTask.id, firstFork.id)

  const resource = await codex.readResource({ uri: `agentharness://tasks/${firstFork.id}/context` })
  assert.equal(resource.contents.length, 1)
  assert.match(resource.contents[0].text, /Portable context is explicit and inheritable/u)

  process.stdout.write(`${JSON.stringify({
    tools: tools.tools.length,
    restoredTasksBeforeCreate: initialTasks.length,
    rootId: root.id,
    firstForkId: firstFork.id,
    secondForkId: secondFork.id,
    mergeId: merged.id,
    independentBindings: [rootSession.bindingId, forkSession.bindingId],
    contextInherited: true,
  }, null, 2)}\n`)
} finally {
  await codex.close()
}
