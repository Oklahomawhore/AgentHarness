/** Real shipped Web profiles use production DeepSeek HTTP and Noise, with no paid model calls. */
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'

const repository = fileURLToPath(new URL('../../../../../../', import.meta.url))
const examples = join(repository, 'apps/cli/config/examples/scope-context')
const observer = new URL('../fixtures/scope-semantic-observer.mjs', import.meta.url).href
const descriptorSchema = z.object({ launchUrl: z.string() })
const identitySchema = z.object({ peerId: z.string(), addresses: z.array(z.string()).min(1) })
const resultSchema = z.object({ status: z.string(),
  projection: z.looseObject({ text: z.string(), backend: z.object({ id: z.string() }) }).optional() })
const auditSchema = z.object({ isolated: z.literal(true),
  events: z.array(z.object({ type: z.string(), seq: z.number(), data: z.unknown() })) })
const envelopeSchema = z.object({ model: z.string(), stream: z.literal(true),
  messages: z.array(z.object({ role: z.string(), content: z.string() })) })
const modelInputSchema = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string() })).min(1) })

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown }

async function startWeb(root: string, role: 'owner' | 'receiver', endpoint: string) {
  const home = join(root, role)
  const project = join(home, 'project')
  await mkdir(project, { recursive: true })
  const ready = join(home, 'ready.json')
  const patch = join(home, 'test.cordis.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', config: { apiKeyEnv: 'DSH_SEMANTIC_FIXTURE_KEY', baseURL: endpoint,
      thinking: 'disabled', reasoningEffort: 'off', maxTokens: 2048, defaultContextWindow: 1000000,
      models: [{ id: 'deepseek-flash', name: 'Controlled HTTP fixture', contextWindow: 1000000, maxTokens: 2048, inputModalities: ['text'] }],
      streamIdleTimeoutMs: 25000, retryPolicy: { mode: 'normal', maxRetries: 0 } } },
    // Enable the existing optional query index so isolation covers full-text search as well as exact reads.
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'first-search' } },
    { insert: [{ id: 'scope-semantic-observer', name: observer, config: { ready, project } }] },
  ]))
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1', DSH_SEMANTIC_FIXTURE_KEY: 'controlled-placeholder-not-a-secret' }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) env[key] = process.env[key]
  const launch = resolveExampleLaunch({ mode: 'lib', srcBin: join(repository, 'apps/cli/src/bin.ts'), env,
    configArgs: ['--profile', 'web', '--patch', join(examples, 'deadlines.cordis.yml'),
      ...role === 'owner' ? ['--patch', join(examples, 'semantic.cordis.yml')] : [],
      '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'] })
  const child = spawn(launch.command, launch.args, { cwd: home, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.resume() // The startup URL contains an authentication token and is never logged.
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) { await closed; return }
    let forced = false
    const force = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 15000)
    try {
      child.kill('SIGTERM')
      const exit = await closed
      expect(forced, stderr).toBe(false)
      expect(exit, stderr).toEqual({ code: 0, signal: null })
    } finally { clearTimeout(force) }
  }
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Web exited: ${stderr}`)
      try { return await readJson(ready) } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
    }, { timeout: 60000, interval: 50 }).not.toBeUndefined()
    const descriptor = descriptorSchema.parse(await readJson(join(home, 'mcp/connection.json')))
    const login = await fetch(descriptor.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    const cookie = login.headers.getSetCookie()[0]?.split(';', 1)[0]
    await login.body?.cancel()
    if (cookie === undefined) throw new Error('Web did not issue the fixture authentication cookie')
    const invoke = async (input: unknown): Promise<unknown> => {
      const response = await fetch(`${new URL(descriptor.launchUrl).origin}/__scope_semantic_fixture`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(input),
        signal: AbortSignal.timeout(45000),
      })
      const text = await response.text()
      expect(response.status, text).toBe(200)
      return JSON.parse(text) as unknown
    }
    return { home, project, invoke, stop, config: await readJson(ready) }
  } catch (error) { await stop(); throw error }
}

// This fixture includes Claude setup, whose descriptor lock is unavailable on Windows.
it.skipIf(process.platform === 'win32')('enables semantic in shipped Web, survives a slow remote read, and isolates cached audit history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-semantic-profile-'))
  const observed = Promise.withResolvers<unknown>()
  const release = Promise.withResolvers<undefined>()
  let calls = 0
  const failures: unknown[] = []
  const handlers: Promise<void>[] = []
  const server = createServer((request, response) => {
    handlers.push((async () => {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const envelope = envelopeSchema.parse(JSON.parse(raw) as unknown)
      calls++
      expect(request.url).toBe('/chat/completions')
      expect(request.headers.authorization).toBe('Bearer controlled-placeholder-not-a-secret')
      expect(envelope.model).toBe('deepseek-flash')
      const input = modelInputSchema.parse(JSON.parse(envelope.messages.at(-1)?.content ?? 'null') as unknown)
      observed.resolve(envelope)
      await release.promise
      const reply = JSON.stringify({ version: 1,
        decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
        updates: [{ text: 'Use three retries; validation errors remain excluded.',
          sources: input.sources.map(source => ({ sourceId: source.sourceId, quote: 'Never retry validation errors.' })) }] })
      for (const source of input.sources) expect(source.body).toContain('Never retry validation errors.')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const value of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
          prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } },
      ]) response.write(`data: ${JSON.stringify({ id: 'profile-fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', ...value })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => { failures.push(error); observed.reject(error); response.destroy() }))
  })
  let owner: Awaited<ReturnType<typeof startWeb>> | undefined
  let receiver: Awaited<ReturnType<typeof startWeb>> | undefined
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no assigned port')
    const endpoint = `http://127.0.0.1:${String(address.port)}`
    owner = await startWeb(root, 'owner', endpoint)
    receiver = await startWeb(root, 'receiver', endpoint)
    for (const host of [owner, receiver]) expect(host.config).toMatchObject({
      transportTimeoutMs: 35000, connectionTimeoutMs: 5000, accessTimeoutMs: 30000, waitTimeoutMs: 3000,
      hook: { profileName: 'claude-hook-summaries', timeoutMs: 45000, hookTimeoutSeconds: 60 },
    })
    expect(owner.config).toMatchObject({ backend: { id: 'semantic' }, defaultBackendDisabled: true,
      semantic: { auditSessionId: 'scope-context-audit', maxCalls: 100, maxConcurrentCalls: 2,
        maxInputBytes: 131072, maxOutputTokens: 2048, maxOutputBytes: 65536, timeoutMs: 20000 } })
    expect(receiver.config).toMatchObject({ backend: { id: 'reported-files', revision: '2' }, defaultBackendDisabled: false, semantic: null })
    const ownerIdentity = identitySchema.parse(await owner.invoke({ kind: 'identity' }))
    const receiverIdentity = identitySchema.parse(await receiver.invoke({ kind: 'identity' }))
    expect(ownerIdentity.peerId).not.toBe(receiverIdentity.peerId)
    const task = z.object({ id: z.string() }).parse(await owner.invoke({ kind: 'create' }))
    const invitation = await owner.invoke({ kind: 'invite', request: { taskId: task.id, recipientPeerId: receiverIdentity.peerId,
      ownerAddress: ownerIdentity.addresses[0], responsibility: 'Implement the frontend retry client', expiresAt: Date.now() + 120000 } })
    const subscription = z.object({ id: z.string() }).parse(await receiver.invoke({ kind: 'join', invitation }))
    let settled = false
    const pending = receiver.invoke({ kind: 'read', subscriptionId: subscription.id }).finally(() => { settled = true })
    void pending.catch(() => undefined)
    const actualRequest = envelopeSchema.parse(await Promise.race([observed.promise, pending.then(() => {
      throw new Error('scope read ended before a provider request was observed')
    })]))
    const auditRoot = join(owner.home, 'scope-context-audit')
    const auditFiles = (await readdir(auditRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
    expect(auditFiles).toHaveLength(1)
    const auditFile = auditFiles[0]
    if (auditFile === undefined) throw new Error('audit file was not persisted before HTTP dispatch')
    const beforeReply = await readFile(join(auditRoot, auditFile), 'utf8')
    expect(beforeReply).toContain('context/semantic-request')
    expect(beforeReply).not.toContain('context/semantic-result')
    expect(beforeReply).toContain('RETRY_PROFILE_CANARY')
    // Elapsed time is the subject: hold the real response beyond the previous five-second read limit.
    await delay(5500)
    expect(settled).toBe(false)
    release.resolve(undefined)
    const first = resultSchema.parse(await pending)
    expect(first).toMatchObject({ status: 'active', projection: { backend: { id: 'semantic' } } })
    expect(first.projection?.text).toContain('Use three retries; validation errors remain excluded.')
    expect(first.projection?.text).toContain('Never retry validation errors.')
    const second = resultSchema.parse(await receiver.invoke({ kind: 'read', subscriptionId: subscription.id }))
    expect(second).toEqual(first)
    expect(calls).toBe(1)
    const inspected = auditSchema.parse(await owner.invoke({ kind: 'inspect' }))
    expect(inspected.events.map(event => event.type)).toEqual(['context/semantic-request', 'context/semantic-result'])
    const request = z.object({ key: z.string(), messages: z.array(z.object({ content: z.array(z.object({ text: z.string() })) })) })
      .parse(inspected.events[0]?.data)
    expect(request.messages[0]?.content[0]?.text).toBe(actualRequest.messages.at(-1)?.content)
    expect(inspected.events[1]?.data).toMatchObject({ key: request.key, status: 'completed', requestSeq: inspected.events[0]?.seq,
      projection: { text: first.projection?.text } })
    const configured = await owner.invoke({ kind: 'setup' })
    expect(configured).toMatchObject({ outcome: 'configured', profileName: 'claude-hook-summaries' })
    expect(await readFile(join(owner.home, 'profiles/claude-hook-summaries/cordis.patch.yml'), 'utf8')).toContain('45000')
    const settings = await readFile(join(owner.project, '.claude/settings.local.json'), 'utf8')
    expect(settings).toContain('claude-hook-summaries')
    expect(settings).toContain('60')
    const grant = z.object({ grantId: z.string() }).parse(invitation)
    await owner.invoke({ kind: 'revoke', grantId: grant.grantId })
    expect(await receiver.invoke({ kind: 'read', subscriptionId: subscription.id })).toEqual({ status: 'revoked' })
    expect(calls).toBe(1)
  } finally {
    release.resolve(undefined)
    const stopped = await Promise.allSettled([receiver?.stop(), owner?.stop()])
    const closing = new Promise<void>((resolve, reject) => { server.close((error) => {
      if (error === undefined || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) resolve()
      else reject(error)
    }) })
    server.closeAllConnections()
    const closed = await Promise.allSettled([closing])
    const handled = await Promise.allSettled(handlers)
    await rm(root, { recursive: true, force: true })
    const errors = [...stopped, ...closed, ...handled].flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'profile fixture cleanup failed')
    expect(failures).toEqual([])
  }
}, 180000)
