/** Real native Sessions, persisted requests, and bounded file tools for the controlled evaluation profile. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createControlledNativeAdapter } from './controlled-native-adapter.mjs'

/** Mount one ordinary native Session without shell access or automatic scope activation.
 * @param ctx Profile-owned Cordis context.
 * @param config Private explicit recipient configuration.
 * @param modules Resolved public production modules.
 * @returns Finite management operations used by the authenticated fixture endpoint.
 */
export async function mountNativeSession(ctx, config, modules) {
  for (const key of ['Llm', 'Session', 'Projection', 'Prompt', 'Tools', 'Agents']) {
    await ctx.plugin(modules[key].default, key === 'Prompt' || key === 'Tools' ? {} : undefined)
  }
  await ctx.plugin(modules.Jsonl.default, { root: config.sessionRoot, compression: 'none' })
  await ctx.plugin(modules.Loop.default, { agents: [] })
  await ctx.plugin(modules.Native.default, { maxContextBytes: 10000, coalesceMs: 50, retryDelayMs: 1000 })
  const lifetime = new AbortController()
  const work = new Set()
  const requests = []
  let agent
  const recordingAdapter = createControlledNativeAdapter({ ...modules.Llm, Session: modules.Session.Session }, {
    program: config.program, agent: () => agent, requests,
  })
  ctx.effect(() => ctx.get('llm').registerAdapter(['controlled-evaluation'], recordingAdapter), 'evaluation adapter')
  const created = await ctx.get('agents').create({ sessionId: modules.Session.SessionId(config.sessionId),
    agentOptions: { provider: 'controlled-evaluation', model: 'registered-program' }, meta: { cwd: config.project } })
  agent = created.agent
  for (const [name, parameters] of [
    ['evaluation_read', { path: { type: 'string', required: true, enum: config.readableFiles } }],
    ['evaluation_write', { path: { type: 'string', required: true, enum: config.writableFiles }, text: { type: 'string', required: true } }],
    ['evaluation_test', {}],
  ]) {
    agent.ctx.effect(() => agent.ctx.tools.register(modules.Tools.defineTool({
      name, description: name === 'evaluation_test' ? 'Run the project tests.' : 'Read or write an authorized project file.',
      parameters, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        const signal = AbortSignal.any([lifetime.signal, exec.signal, AbortSignal.timeout(config.operationTimeoutMs)])
        const body = JSON.stringify({ role: config.role, sessionId: config.sessionId, operation: name, ...args })
        if (Buffer.byteLength(body) > config.maxToolBytes) throw new Error('tool request exceeds byte bound')
        const response = await fetch(config.coordinatorUrl, { method: 'POST', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.coordinatorToken}` }, body })
        const chunks = []
        let bytes = 0
        if (response.body === null) throw new Error('coordinator response missing')
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > config.maxToolBytes) { await response.body.cancel().catch(() => {}); throw new Error('tool response exceeds byte bound') }
          chunks.push(chunk)
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!response.ok) throw new Error(value.error ?? 'file operation failed')
        return value
      },
    })), `evaluation ${name}`)
  }
  let started = false
  const manage = async input => {
    if (input.kind === 'status') return { agentId: agent.id, started, requests: requests.length }
    if (input.kind === 'cancel') { agent.cancel({ kind: 'user' }); return { cancelled: true } }
    if (input.kind === 'start') {
      if (started) throw new Error('session already started')
      started = true
      agent.followup(modules.Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: config.goal }] }))
      return { started: true }
    }
    if (input.kind !== 'finish') throw new Error('unknown native management action')
    if (!started) throw new Error('session has not started')
    await agent.whenIdle()
    const flushed = await ctx.get('sessions').flush(agent.session)
    if (!flushed) throw new Error('Session has no persistence participant')
    const files = (await readdir(config.sessionRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
    if (files.length !== 1) throw new Error('expected one durable Session generation')
    const bytes = await readFile(join(config.sessionRoot, files[0]))
    const rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    const restore = modules.Catalog.sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
    for (const row of rows.slice(1)) restore.decodeRow(row)
    const stored = restore.finish()
    if (!isDeepStrictEqual(stored.events, agent.session.snapshotEvents())) throw new Error('durable Session events differ')
    for (const request of requests) {
      const detached = modules.Session.Session.create(agent.session.id, stored.events.slice(0, request.eventCount), stored.header)
      if (!isDeepStrictEqual(detached.deriveMessages(), request.messages)) throw new Error('durable request reconstruction differs')
    }
    const durable = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      eventCount: stored.events.length, requestReconstruction: true, file: files[0] }
    return { durable, agentId: agent.id, sessionId: config.sessionId, header: agent.session.header,
      events: agent.session.snapshotEvents(), requests, flushed, modelUsage: null }
  }
  const stop = async () => {
    lifetime.abort(new Error('native evaluation disposed'))
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()
    await Promise.allSettled([...work])
  }
  ctx.effect(() => stop, 'evaluation native quiescence')
  return { stop, invoke(input) {
    const operation = manage(input)
    work.add(operation)
    void operation.finally(() => work.delete(operation)).catch(() => {}) // The caller owns the original rejection.
    return operation
  } }
}
