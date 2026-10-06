/** Read-only, bounded actual-request evidence for independent named Web profiles. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, opendir, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'

export const name = 'two-device-observer'
export const inject = ['llm', 'sessions', 'sessionPersistence', 'agents']

const digest = value => createHash('sha256').update(value).digest('hex')
const encoded = value => JSON.stringify(value)
const bytes = value => Buffer.byteLength(value, 'utf8')
const canonical = value => JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
// JSONL explicitly materializes the current header's optional zero delegation depth.
const persistedHeader = header => ({ ...header, delegationDepth: header.delegationDepth ?? 0 })

function validateConfig(config) {
  for (const key of ['directory', 'sessionRoot']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`observer ${key} must be absolute`)
  }
  for (const [parent, child] of [[config.directory, config.sessionRoot], [config.sessionRoot, config.directory]]) {
    const path = relative(parent, child)
    if (path === '' || !path.startsWith('..') && !isAbsolute(path)) throw new Error('observer evidence and Session directories must be disjoint')
  }
  for (const key of ['maxSessions', 'expectedRequests', 'maxRequestBytes', 'maxSessionBytes', 'maxEvidenceBytes', 'drainBudgetMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`observer ${key} must be a positive safe integer`)
  }
  if (config.drainBudgetMs > 2147483647) throw new Error('observer drainBudgetMs exceeds timer range')
}

async function boundedRead(path, maximum) {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('observer Session artifact exceeds byte limit or is not a file')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maximum + 1))
    let size = 0
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null)
      if (result.bytesRead === 0) return buffer.subarray(0, size)
      size += result.bytesRead
    }
    throw new Error('observer Session artifact grew during read')
  } finally { await file.close() }
}

async function sessionFiles(root, maximum) {
  const files = []
  let entries = 0
  const walk = async (directory, depth) => {
    const handle = await opendir(directory)
    for await (const entry of handle) {
      if (++entries > maximum) throw new Error('observer Session directory exceeds entry limit')
      if (entry.isSymbolicLink()) throw new Error('observer Session directory contains a symbolic link')
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth >= 2) throw new Error('observer Session directory exceeds expected JSONL depth')
        await walk(path, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
      else if (entry.name.endsWith('.zstd')) throw new Error('observer requires uncompressed JSONL')
    }
  }
  await walk(root, 0)
  return files
}

function requestConfig(options) {
  return Object.fromEntries(['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']
    .filter(key => options[key] !== undefined).map(key => [key, options[key]]))
}

function reconstruct(SessionModule, sessionId, header, events, record) {
  const detached = SessionModule.Session.create(sessionId, events, header)
  const requestHeader = SessionModule.foldRequestHeader(events)
  if (!isDeepStrictEqual(detached.deriveMessages(), record.messages)) throw new Error('observer actual messages differ from Session derivation')
  if (requestHeader === undefined || !isDeepStrictEqual(requestHeader.config, record.config)
    || !isDeepStrictEqual(requestHeader.tools ?? [], record.tools)) throw new Error('observer actual request header differs from Session')
}

/** Install the observer using explicit public runtime modules, without changing Session or model input.
 * @param ctx Profile-owned context with the ordinary loop and JSONL persistence services.
 * @param config Explicit evidence paths, expected request count and finite resource limits.
 * @param modules Public Session, Catalog and Llm modules resolved by the profile preparer.
 * @returns Observer-owned close operation; disposal also calls and awaits it.
 */
export async function installObserver(ctx, config, modules) {
  validateConfig(config)
  const sessionStore = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const agents = ctx.get('agents')
  await mkdir(config.directory, { mode: 0o700 })
  const requestFile = await open(join(config.directory, 'requests.jsonl'), 'wx', 0o600)
  const records = []
  const sessions = new Map()
  const failures = []
  let evidenceBytes = 0
  let activeStreams = 0
  let closing = false
  let closed
  let tail = Promise.resolve()
  let revision = 0
  let verifiedRequests = 0
  let drainStartedAt
  let drainBudgetExceeded = false
  let summaries = []
  const disposers = []
  const fail = error => {
    if (failures.length === 0) failures.push(error instanceof Error ? error.message.slice(0, 4096) : 'observer failed with non-Error rejection')
  }
  const checkDrainBudget = () => {
    if (drainStartedAt !== undefined && performance.now() - drainStartedAt >= config.drainBudgetMs) {
      drainBudgetExceeded = true
      fail(new Error('observer drain exceeded its configured elapsed-time budget'))
    }
  }
  const report = async final => {
    if (final) checkDrainBudget()
    const value = { version: 1, revision: ++revision, final,
      status: failures.length > 0 ? 'failed' : verifiedRequests === records.length && records.length > 0
        && activeStreams === 0 && summaries.every(item => item.idle) ? 'passed' : 'running',
      expectedRequests: config.expectedRequests, observedRequests: records.length, verifiedRequests, activeStreams,
      evidenceBytes, drainBudgetExceeded, sessions: summaries, failures: [...failures] }
    const temporary = join(config.directory, `verification.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(encoded(value) + '\n'); await file.sync() } finally { await file.close() }
    try { await rename(temporary, join(config.directory, 'verification.json')) } catch (error) {
      await unlink(temporary)
      throw error
    }
  }
  const enqueue = operation => {
    const result = tail.then(operation)
    tail = result.catch(error => { fail(error) })
    return result
  }
  const verify = async final => {
    const batch = records.slice()
    const capturedSessions = new Map(sessions)
    if (final && records.length !== config.expectedRequests) fail(new Error('observer controlled request program was not fully consumed'))
    if (records.length === 0) { await report(final); return }
    if (!final) {
      for (const session of capturedSessions.values()) {
        if (sessionStore.get(session.id) === session && !await sessionStore.flush(session)) {
          throw new Error('observer Session has no durability participant')
        }
      }
    }
    // Host teardown can detach the Session router before this consumer. The owned backend barrier and raw log remain authoritative.
    await persistence.flush()
    // A fresh private JSONL root contains at most one project/session directory pair and a few owned files per Session.
    const files = await sessionFiles(config.sessionRoot, config.maxSessions * 8 + config.expectedRequests)
    if (files.length > config.maxSessions) throw new Error('observer found more Session artifacts than configured')
    const found = new Map()
    for (const path of files) {
      const content = await boundedRead(path, config.maxSessionBytes)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
      if (!text.endsWith('\n')) throw new Error('observer Session artifact has an incomplete final row')
      const rows = text.trimEnd().split('\n')
      const restore = modules.Catalog.sessionFormatCatalog.createRestore(JSON.parse(rows[0]), { recovery: 'strict', validation: 'current' })
      for (const row of rows.slice(1)) restore.decodeRow(JSON.parse(row))
      const stored = restore.finish()
      const id = stored.header.id
      if (!capturedSessions.has(id) || found.has(id)) throw new Error('observer found an unexpected or duplicate Session artifact')
      const ownRecords = batch.filter(record => record.sessionId === id)
      for (const record of ownRecords) {
        const prefix = stored.events.slice(0, record.eventCount)
        if (prefix.length !== record.eventCount
          || digest(canonical({ header: persistedHeader(stored.header), events: prefix })) !== record.prefixSha256) {
          throw new Error('observer persisted request prefix differs from captured events')
        }
        reconstruct(modules.Session, id, stored.header, prefix, record)
      }
      const agent = agents.get(id)
      const lastStart = stored.events.findLast(event => event.type === 'turn/start')
      const lastEnd = stored.events.findLast(event => event.type === 'turn/end')
      const idle = (agent === undefined || agent.status === 'idle') && lastEnd !== undefined
        && lastStart !== undefined && lastEnd.seq > lastStart.seq
      found.set(id, { sessionId: id, observedRequests: ownRecords.length,
        latestTurnId: lastStart?.data.turn ?? null, idle, eventCount: stored.events.length,
        lastTurnEnd: lastEnd ?? null, path: relative(config.sessionRoot, path),
        bytes: content.length, sha256: digest(content), requestReconstruction: true })
    }
    if (found.size !== capturedSessions.size) throw new Error('observer is missing a persisted Session artifact')
    summaries = [...found.values()]
    verifiedRequests = batch.length
    if (final && (activeStreams !== 0 || summaries.some(item => !item.idle))) fail(new Error('observer closed before the observed turn settled'))
    await report(final)
  }
  const observe = options => {
    if (!Object.isFrozen(options) || !Object.isFrozen(options.messages)) throw new Error('observer loop request is not frozen')
    const session = sessionStore.get(options.sessionId)
    if (session === undefined) throw new Error('observer loop request has no live Session')
    if (records.length >= config.expectedRequests) throw new Error('observer received an extra controlled model request')
    if (!sessions.has(session.id) && sessions.size >= config.maxSessions) throw new Error('observer Session limit exceeded')
    const events = session.snapshotEvents()
    const prefix = canonical({ header: persistedHeader(session.header), events })
    if (bytes(prefix) > config.maxSessionBytes) throw new Error('observer Session prefix exceeds byte limit')
    const step = events.findLast(event => event.type === 'step/start')
    if (step === undefined || options.system !== undefined || options.purpose !== undefined) {
      throw new Error('observer only accepts ordinary loop requests with a recorded step')
    }
    const managed = options.messages.filter(message => ['scope-agent-context', 'development-task-context'].includes(message.source?.kind))
    const sourceSeqs = managed.map(message => {
      const event = events.findLast(item => item.type === 'user/message' && isDeepStrictEqual(item.data, message))
      if (event === undefined) throw new Error('observer managed context is missing its exact Session event')
      return { kind: message.source.kind, seq: event.seq }
    })
    const contextBytes = managed.reduce((total, message) => total + message.content.reduce((sum, block) =>
      sum + (block.type === 'text' ? bytes(block.text) : 0), 0), 0)
    const record = { version: 1, index: records.length, sessionId: session.id, turn: step.data.turn, step: step.data.step,
      eventCount: events.length, prefixSha256: digest(prefix), header: session.header, config: requestConfig(options),
      messages: options.messages, tools: options.tools ?? [], sourceSeqs, contextBytes }
    reconstruct(modules.Session, session.id, session.header, events, record)
    const line = encoded(record) + '\n'
    if (bytes(line) > config.maxRequestBytes) throw new Error('observer request exceeds evidence byte limit')
    if (evidenceBytes + bytes(line) > config.maxEvidenceBytes) throw new Error('observer total evidence byte limit exceeded')
    records.push(JSON.parse(line))
    sessions.set(session.id, session)
    evidenceBytes += bytes(line)
    return line
  }
  const close = () => {
    if (closed !== undefined) return closed
    closing = true
    for (const dispose of disposers) dispose()
    closed = (async () => {
      drainStartedAt = performance.now()
      // Filesystem durability has no cancellation API; the process owner enforces the hard shutdown deadline.
      const budgetTimer = setTimeout(checkDrainBudget, config.drainBudgetMs)
      try {
        await tail
        try { await verify(true) } catch (error) { fail(error); await report(true) }
      } finally { clearTimeout(budgetTimer); await requestFile.close() }
      await report(true)
      if (failures.length > 0) throw new Error(`two-device observer failed: ${failures[0]}`)
    })()
    return closed
  }
  ctx.effect(() => close, 'two-device observer evidence drain')
  try {
    disposers.push(ctx.on('llm/stream', async function* (options, next) {
      if (!modules.Llm.isAgentLoopRequest(options)) { yield* next(); return }
      if (closing) throw new Error('observer is closing')
      let line
      try { line = observe(options) } catch (error) { fail(error); await enqueue(() => report(false)); throw error }
      activeStreams++
      try {
        await enqueue(async () => { await requestFile.writeFile(line); await requestFile.sync(); await report(false) })
        yield* next()
      } finally { activeStreams-- }
    }, { global: true, prepend: true }))
    disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (closing || status !== 'idle' || !sessions.has(agent.id)) return
      void enqueue(async () => {
        try { await verify(false) } catch (error) { fail(error); await report(false) }
      }).catch(error => { ctx.logger.error(error) })
    }, { global: true }))
    await report(false)
    return { close }
  } catch (error) {
    fail(error)
    await close().catch(closeError => { ctx.logger.error(closeError) })
    throw error
  }
}

/** Load the explicit public modules and install this profile-local evidence plugin.
 * @param ctx Named Web profile context.
 * @param config Explicit module URLs and observer resource limits.
 */
export async function apply(ctx, config) {
  const modules = Object.fromEntries(await Promise.all(['Session', 'Catalog', 'Llm']
    .map(async key => [key, await import(config.modules[key])])))
  await installObserver(ctx, config, modules)
}
