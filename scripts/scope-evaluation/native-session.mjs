/** Real native Sessions, persisted requests, and bounded file tools for the controlled evaluation profile. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createControlledNativeAdapter, recordNativeRequest } from './controlled-native-adapter.mjs'

/** Mount one native Session with bounded file tools and optional explicitly authorized automatic scope work.
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
  if (config.mode !== 'data-source') await ctx.plugin(modules.Native.default, {
    maxContextBytes: config.contextBytes ?? 10000,
    maxLocalContextBytes: Math.floor((config.contextBytes ?? 10000) / 2), coalesceMs: 50, retryDelayMs: 1000 })
  if (config.mode === 'data-source') {
    await ctx.plugin(modules.FsLocal.LocalFileSystem, { cwd: config.project })
    await ctx.plugin(modules.FsPolicy)
    await ctx.plugin(modules.ToolFs, {})
    await ctx.plugin(modules.Contribution.default, { maxSessions: 4, maxLeases: 16,
      maxObservationBytes: 16384, contributionPollIntervalMs: 50 })
  }
  const lifetime = new AbortController()
  const phaseGate = async (operation, signal) => {
    const response = await fetch(config.coordinatorUrl, { method: 'POST',
      signal: AbortSignal.any([lifetime.signal, ...(signal === undefined ? [] : [signal])]),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.coordinatorToken}` },
      body: JSON.stringify({ role: config.role, sessionId: config.sessionId, operation }) })
    await response.body?.cancel()
    if (!response.ok) throw new Error('continuity phase admission failed')
  }
  const work = new Set()
  const requests = []
  let agent
  let meter
  if (config.mode === 'data-recipient') {
    meter = await mountDataModel(ctx, config, modules, async options => {
      if (!await ctx.get('sessions').flush(agent.session)) throw new Error('ordinary request has no durable Session')
      return recordNativeRequest(modules.Session.Session, agent, options, requests)
    }, () => agent.cancel({ kind: 'hook', reason: 'data-model-limit' }))
  } else {
    const recordingAdapter = createControlledNativeAdapter({ ...modules.Llm, Session: modules.Session.Session }, {
      program: config.program, agent: () => agent, requests,
      beforeRequest: config.continuity && config.mode === 'data-source' ? async (index, signal) => {
        if (index === 3) await phaseGate('source-stage', signal)
      } : undefined,
    })
    ctx.effect(() => ctx.get('llm').registerAdapter(['controlled-evaluation'], recordingAdapter), 'evaluation adapter')
  }
  const created = await ctx.get('agents').create({ sessionId: modules.Session.SessionId(config.sessionId),
    agentOptions: config.mode === 'data-recipient'
      ? { provider: config.route.provider, model: config.route.model, maxTokens: config.route.maxOutputTokens,
        reasoningEffort: 'off', temperature: 0 }
      : { provider: 'controlled-evaluation', model: 'registered-program' }, meta: { cwd: config.project } })
  agent = created.agent
  for (const [name, parameters] of config.mode === 'data-source' ? [] : [
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
  if (config.continuity && config.mode === 'data-recipient') {
    ctx.on('agent/pre-step', async ({ signal }, next) => {
      await phaseGate('phase-admission', signal)
      return next()
    }, { global: true, prepend: true })
  }
  let started = false
  const manage = async input => {
    if (input.kind === 'status') return { agentId: agent.id, started, requests: requests.length,
      ...config.continuity ? { sessionId: config.sessionId, agentStatus: agent.status,
        lastTurnEnd: agent.session.snapshotEvents().findLast(event => event.type === 'turn/end') ?? null,
        scopeState: config.mode === 'data-recipient' ? ctx.get('sessionProjections').stateOf(agent.session, 'scopeAgentContext') ?? null : null,
        completed: config.mode === 'data-recipient' ? ctx.get('sessionProjections').stateOf(agent.session, 'scopeAgentEvidence')?.completed ?? null : null } : {} }
    if (input.kind === 'cancel') { agent.cancel({ kind: 'user' }); return { cancelled: true } }
    if (input.kind === 'start') {
      if (started) throw new Error('session already started')
      started = true
      agent.followup(modules.Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: config.goal }] }))
      return { started: true }
    }
    if (input.kind !== 'finish') throw new Error('unknown native management action')
    if (!started && !config.continuity) throw new Error('session has not started')
    if (!config.continuity || config.mode !== 'data-source') await agent.whenIdle()
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
      events: agent.session.snapshotEvents(), requests, flushed, modelUsage: meter?.state ?? null,
      ...config.mode === undefined ? {} : { turnReason: agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason ?? null } }
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

/** Mount the production HTTP adapter with finite dispatch accounting and recorded actual inputs.
 * @param ctx Owning model context; its Connection credentials remain private to this Host.
 * @param config Explicit route and authenticated parent accounting endpoint.
 * @param modules Built public modules.
 * @param beforeSend Durable request verifier invoked before any delegation.
 * @param cancel Cancel the owning ordinary turn on its per-call deadline; summaries own their deadline.
 * @returns Observed stream accounting, including unknown usage rather than an inferred zero.
 */
export async function mountDataModel(ctx, config, modules, beforeSend, cancel) {
  const route = config.route
  const modelCtx = route.credentialsPath === null ? ctx : ctx.isolate('credentials')
  if (route.credentialsPath !== null) await modelCtx.plugin(modules.Credentials.default, {
    path: route.credentialsPath, dshHome: config.project, watch: false })
  await modelCtx.plugin(modules.DeepSeek, { apiKeyEnv: route.apiKeyEnv, baseURL: route.endpoint,
    thinking: 'disabled', reasoningEffort: 'off', maxTokens: route.maxOutputTokens,
    defaultContextWindow: 1000000, models: [{ id: route.model, contextWindow: 1000000,
      maxTokens: route.maxOutputTokens, inputModalities: ['text'] }],
    streamIdleTimeoutMs: route.timeoutMs, retryPolicy: { mode: 'normal', maxRetries: 0 } })
  const state = { dispatchAttempts: 0, unknownUsage: false, calls: [] }
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('data model disposed')), 'data model lifetime')
  const account = async (action, value, signal) => {
    const response = await fetch(config.coordinatorUrl, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.coordinatorToken}` },
      body: JSON.stringify({ role: config.role, sessionId: config.sessionId, operation: action, ...value }) })
    const text = await response.text()
    if (text.length > 8192 || !response.ok) throw new Error('parent model accounting rejected the operation')
    return JSON.parse(text)
  }
  ctx.on('llm/stream', async function* (options, next) {
    lifetime.signal.throwIfAborted()
    if (state.unknownUsage || state.dispatchAttempts >= route.maxCalls) throw new Error('model dispatch budget unavailable')
    if (options.provider !== route.provider || options.model !== route.model || options.maxTokens !== route.maxOutputTokens) {
      throw new Error('model request differs from frozen route')
    }
    const request = { provider: options.provider, model: options.model, maxTokens: options.maxTokens,
      purpose: options.purpose ?? 'ordinary', system: options.system ?? null, messages: options.messages, tools: options.tools ?? [] }
    if (Buffer.byteLength(JSON.stringify(request)) > route.maxInputBytes) throw new Error('model input exceeds byte limit')
    const evidence = await beforeSend(options)
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal === undefined ? [] : [options.signal]),
      AbortSignal.timeout(route.timeoutMs)])
    const permission = await account('model-reserve', { request, evidence }, signal)
    const call = { reservation: permission.reservation, usage: null, finish: null, outputBytes: 0, responseObserved: false }
    state.calls.push(call)
    state.dispatchAttempts++
    const timer = cancel === undefined ? undefined : setTimeout(cancel, route.timeoutMs)
    try {
      for await (const chunk of next()) {
        signal.throwIfAborted()
        call.outputBytes += Buffer.byteLength(JSON.stringify(chunk))
        if (call.outputBytes > route.maxOutputBytes) { cancel?.(); throw new Error('model output exceeds byte limit') }
        if (chunk.type === 'usage') call.usage = chunk.usage
        if (chunk.type === 'finish') call.finish = chunk.reason
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0
          || chunk.type === 'tool-call-delta' && chunk.argumentsDelta.length > 0
          || chunk.type === 'block-end') call.responseObserved = true
        yield chunk
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (call.usage === null) state.unknownUsage = true
      // A cancelled stream still settles its reservation; no new model dispatch occurs during this bounded write.
      await account('model-settle', call, AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.operationTimeoutMs)]))
    }
  }, { global: true, prepend: true })
  return { state }
}

/** Mount a production semantic provider with its own durable audit Session and model budget.
 * @param ctx Private owner Host context.
 * @param config Explicit summary route, audit path, and parent accounting endpoint.
 * @param modules Built public modules.
 * @returns Read-only audit observation after outstanding receiver requests have settled.
 */
export async function mountDataSemantic(ctx, config, modules) {
  for (const key of ['Llm', 'Session', 'Projection']) await ctx.plugin(modules[key].default)
  await ctx.plugin(modules.Jsonl.default, { root: config.sessionRoot, compression: 'none' })
  const readAudit = async () => {
    const handle = await ctx.get('sessionPersistence').open(modules.Session.SessionId(config.sessionId), 'read')
    try { return { header: handle.header, ...await handle.read() } } finally { await handle.close() }
  }
  const meter = await mountDataModel(ctx, config, modules, async options => {
    const audit = await readAudit()
    const reservation = audit.events.findLast(event => event.type === 'context/semantic-request')
    if (reservation === undefined || reservation.data.system !== options.system
      || !isDeepStrictEqual(reservation.data.messages, options.messages)
      || !Object.entries(reservation.data.call).every(([key, value]) => isDeepStrictEqual(options[key], value))
      || audit.events.some(event => event.type === 'context/semantic-result' && event.data.requestSeq === reservation.seq)) {
      throw new Error('semantic stream lacks its exact durable reservation')
    }
    return { requestSeq: reservation.seq, key: reservation.data.key, backend: reservation.data.backend }
  })
  const route = config.route
  await ctx.plugin(modules.Semantic.default, { auditSessionId: config.sessionId, provider: route.provider, model: route.model,
    temperature: 0, reasoningEffort: 'off', maxInputBytes: route.maxInputBytes, maxOutputTokens: route.maxOutputTokens,
    maxOutputBytes: route.maxOutputBytes, timeoutMs: route.timeoutMs, maxConcurrentCalls: 1, maxCalls: route.maxCalls })
  return { stop: async () => {}, async invoke(input) {
    if (input.kind !== 'status' && input.kind !== 'finish') throw new Error('owner exposes only audit observation')
    return { ...await readAudit(), modelUsage: meter.state }
  } }
}
