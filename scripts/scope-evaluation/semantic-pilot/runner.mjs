/** Six-cell research Consumer; only its execute mode delegates to the production semantic Provider. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

/** Profile Consumer name. */
export const name = 'semantic-six-call-pilot'
/** Services shared by offline preparation and real-provider execution. */
export const inject = ['developmentRooms', 'developmentTasks', 'sessions', 'sessionPersistence']

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const errorMessage = error => error instanceof Error ? error.message : String(error)

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function checkSources(framed, input, cell) {
  const task = input.view.task
  check(isDeepStrictEqual(framed.task, {
    id: task.id, revision: task.revision, objective: task.objective, scope: task.scope, origin: task.origin,
  }) && isDeepStrictEqual(framed.recipient, input.recipient), 'Model Task or recipient differs from the frozen case')
  check(framed.sources.length === cell.afterSequence && framed.mandatory.length === 0
    && framed.inherited.length === 0 && task.context.length === cell.afterSequence,
  'Model source set differs from the frozen case')
  const remaining = new Map(task.context.map(publication => [publication.id, publication]))
  const sourceIds = new Set()
  for (const source of framed.sources) {
    const publication = remaining.get(source.source.publicationId)
    check(publication !== undefined && isDeepStrictEqual(source.source, {
      kind: 'publication', taskId: task.id, revision: task.revision, publicationId: publication.id,
    }) && source.body === publication.text && !sourceIds.has(source.sourceId),
    'Model source reference or canonical body differs from the admitted publication')
    remaining.delete(publication.id)
    sourceIds.add(source.sourceId)
    const tool = publication.peerToolObservation
    const grant = publication.peerContribution.grant
    for (const key of ['tool', 'reportedStatus', 'sequence', 'sourceId', 'sourceName', 'omissions']) {
      check(isDeepStrictEqual(source.attribution[key], tool[key]), `Model source attribution differs: ${key}`)
    }
    check(source.attribution.rootIndex === tool.fields.rootIndex && source.attribution.path === tool.fields.path
      && isDeepStrictEqual(source.attribution.authorization, {
        ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
        grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId,
        captureGeneration: grant.captureGeneration,
      }), 'Model source permission or relative path differs from the admitted report')
  }
  check(remaining.size === 0, 'Model omitted an admitted source before relevance selection')
}

function carriesOutput(chunk) {
  return ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)
    || (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
      && chunk.block.text.length > 0)
}

/**
 * Freeze trusted Host reports and, in execute mode, evaluate six production summaries without a substitute adapter.
 * @param ctx Profile context with the explicitly declared Task and audit services.
 * @param config Frozen mode, output directory, module URLs, fixture path, and audit Session ID from the driver.
 */
export async function apply(ctx, config) {
  check(config.mode === 'preflight' || config.mode === 'execute', 'Pilot mode must be preflight or execute')
  const taskSchema = await import(config.modules.TaskSchema)
  const { SessionId } = await import(config.modules.Session)
  const fixture = JSON.parse(await readFile(config.fixturePath, 'utf8'))
  const controller = new AbortController()
  const state = {
    version: 1, mode: config.mode, execution: fixture.execution, startedAt: new Date().toISOString(), status: 'starting',
    admission: 'trusted local Host fixture; no Noise, Claude Hook, actual tool execution or ordinary Agent',
    streamAttempts: 0, dispatchAttempts: 0, responseObservedCases: 0, liveModelAttempts: 0, liveModelResponseCases: 0,
    counterMeaning: 'Dispatch is delegation to the production LLM waterfall, not HTTP-send or billing confirmation. '
      + 'Response evidence requires nonempty text or reasoning yielded by the provider; a local error finish is insufficient.',
    completedProjections: 0, cumulativeKnownCostUsd: 0, unknownUsage: false, cases: [],
  }
  let operation = Promise.resolve()
  let current
  let fileFailure

  async function save(name, value) {
    const path = join(config.output, name)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      fileFailure = error
      controller.abort(error)
      throw error
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async function readAudit() {
    const handle = await ctx.sessionPersistence.open(SessionId(config.auditSessionId), 'read')
    try { return { header: handle.header, ...(await handle.read()) } }
    finally { await handle.close() }
  }

  if (config.mode === 'execute') ctx.on('llm/stream', async function* (options, next) {
    controller.signal.throwIfAborted()
    state.streamAttempts++
    check(state.streamAttempts <= 6, 'Pilot stream-attempt limit exceeded')
    check(current !== undefined, 'Model call has no active pilot case')
    check(options.purpose === 'context-summary' && options.provider === fixture.semantic.provider
      && options.model === fixture.semantic.model && options.maxTokens === fixture.semantic.maxOutputTokens
      && options.temperature === fixture.semantic.temperature && options.reasoningEffort === fixture.semantic.reasoningEffort,
    'Model call differs from the frozen route or controls')
    const framed = JSON.parse(options.messages[0].content[0].text)
    checkSources(framed, current.input, current.cell)
    const audit = await readAudit()
    const reservation = audit.events.findLast(event => event.type === 'context/semantic-request')
    check(reservation !== undefined && reservation.data.purpose === options.purpose
      && reservation.data.maxContextBytes === current.input.maxContextBytes
      && reservation.data.system === options.system && isDeepStrictEqual(reservation.data.messages, options.messages)
      && Object.entries(reservation.data.call).every(([key, value]) => isDeepStrictEqual(options[key], value))
      && !audit.events.some(event => event.type === 'context/semantic-result' && event.data.requestSeq === reservation.seq),
    'Actual stream lacks its exact unfinished durable reservation')
    await save(`${current.cell.id}-actual-request.json`, {
      requestSeq: reservation.seq, key: reservation.data.key, backend: reservation.data.backend,
      call: reservation.data.call, purpose: options.purpose, system: options.system, messages: options.messages,
    })
    controller.signal.throwIfAborted()
    state.dispatchAttempts++
    if (fixture.execution.kind === 'live') state.liveModelAttempts++
    for await (const chunk of next()) {
      if (!current.row.responseObserved && carriesOutput(chunk)) {
        current.row.responseObserved = true
        state.responseObservedCases++
        if (fixture.execution.kind === 'live') state.liveModelResponseCases++
      }
      yield chunk
    }
  }, { global: true, prepend: true })

  function checkReceipt(receipt, grant, task, kind) {
    for (const key of ['taskId', 'ownerPeerId', 'contributorPeerId', 'grantId', 'generation', 'captureId', 'captureGeneration']) {
      check(receipt[key] === grant[key], `Task receipt disagrees with the submitted ${key}`)
    }
    const event = ctx.developmentTasks.log().find(item => item.nodeId === receipt.event.nodeId && item.seq === receipt.event.seq)
    check(receipt.event.nodeId === task.ownerNodeId && receipt.event.kind === kind && event !== undefined
      && event.change.kind === kind && event.taskId === task.id && event.revision === receipt.revision,
    'Task receipt does not identify the owning Task event')
    return event
  }

  async function freezeInputs() {
    const owner = 'pilot-local-owner'
    await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Pilot owner' })
    const task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: fixture.objective,
      scope: fixture.scope, createdBy: owner })
    const grant = taskSchema.peerContributionGrantSchema.parse({ version: 1, taskId: task.id, grantId: 'pilot-tool-grant',
      generation: 'pilot-tool-generation', ownerPeerId: 'trusted-fixture-owner-peer', contributorPeerId: 'trusted-fixture-source-peer',
      captureId: 'pilot-capture', captureGeneration: 'pilot-capture-generation', source: fixture.source,
      expiresAt: Date.now() + fixture.limits.grantLifetimeMs, maxSamples: 4, maxSampleBytes: 8192 })
    const opened = await ctx.developmentTasks.openPeerContribution(grant)
    check(opened.state === 'active' && isDeepStrictEqual(opened.grant, grant), 'Pilot grant did not open exactly')
    const openEvent = checkReceipt(opened.openReceipt, grant, task, 'peer-contribution-opened')
    check(isDeepStrictEqual(openEvent.change.grant, grant), 'Open receipt names another grant')
    const receipts = []
    const views = new Map()
    for (const [index, result] of fixture.reports.entries()) {
      controller.signal.throwIfAborted()
      const request = taskSchema.peerContributionRequestSchema.parse({ grant, sourceId: digest(['pilot-report', index + 1, result]),
        sequence: index + 1, result })
      const admission = await ctx.developmentTasks.admitPeerContribution(request, grant.contributorPeerId)
      const event = checkReceipt(admission.receipt, grant, task, 'context-published')
      check(admission.outcome === 'published' && isDeepStrictEqual(event.change.publication, admission.publication)
        && admission.receipt.sourceId === request.sourceId && admission.receipt.sequence === request.sequence
        && admission.receipt.payloadDigest === taskSchema.peerContributionPayloadDigest(request)
        && admission.receipt.publicationId === taskSchema.peerContributionPublicationId(request)
        && admission.publication.id === admission.receipt.publicationId,
      'Sample receipt does not identify the exact admitted report')
      receipts.push({ request, admission })
      if (index >= 1) views.set(index + 1, await ctx.developmentTasks.currentContextView(task.id))
    }
    const inputs = fixture.cases.map(cell => ({ case: cell, input: { view: views.get(cell.afterSequence),
      recipient: { participantId: `pilot-recipient-${cell.recipient}`, sessionLabel: fixture.recipients[cell.recipient] },
      maxContextBytes: fixture.limits.maxContextBytes } }))
    check(inputs.length === 6 && inputs.every(item => item.input.view !== undefined), 'Invalid pilot cases')
    await save('captured-inputs.json', inputs)
    await save('task-admissions.json', { opened, grant, receipts, log: ctx.developmentTasks.log() })
    await save('dispatch-freeze.json', { frozenAt: new Date().toISOString(), inputsSha256: digest(inputs),
      fixtureSha256: digest(await readFile(config.fixturePath, 'utf8')), taskId: task.id, cases: inputs.map(item => ({
        id: item.case.id, inputSha256: digest(item.input), taskRevision: item.input.view.task.revision })) })
    return inputs
  }

  async function runCase(backend, item) {
    const row = { id: item.case.id, streamAttemptsBefore: state.streamAttempts, dispatchAttemptsBefore: state.dispatchAttempts,
      responseObserved: false, outcome: 'started', semanticFidelity: 'unreviewed', recipientRelevance: 'unreviewed',
      startedAt: new Date().toISOString() }
    current = { cell: item.case, input: item.input, row }
    state.cases.push(row)
    await save('progress.json', state)
    const beforeAudit = await readAudit()
    const priorRequests = new Set(beforeAudit.events.filter(event => event.type === 'context/semantic-request').map(event => event.seq))
    const priorResults = new Set(beforeAudit.events.filter(event => event.type === 'context/semantic-result').map(event => event.seq))
    try {
      const input = { ...item.input, signal: controller.signal }
      const projection = await backend.compute(input)
      row.productionValidation = 'accepted'
      await save(`${item.case.id}-projection.json`, projection)
      const start = projection.text.indexOf('<shared-work-updates>\n')
      const end = projection.text.lastIndexOf('\n</shared-work-updates>')
      check(start >= 0 && end > start, 'Production projection frame missing')
      const output = JSON.parse(projection.text.slice(start + '<shared-work-updates>\n'.length, end))
      await save(`${item.case.id}-review.json`, { case: item.case, status: 'unreviewed',
        rubricFile: join(dirname(config.fixturePath), 'rubric.json'), claims: output.updates.map(update => update.text),
        updatesWithExactQuotes: output.updates, coverage: output.coverage,
        warning: 'Judge update claims; historical 3 or failed 9 in a quote is not itself an error. No keyword-based semantic pass.' })
      const auditBeforeCache = await readAudit()
      const attemptsBeforeCache = state.streamAttempts
      const cached = await backend.compute(input)
      const auditAfterCache = await readAudit()
      check(isDeepStrictEqual(cached, projection) && state.streamAttempts === attemptsBeforeCache
        && isDeepStrictEqual(auditBeforeCache.events, auditAfterCache.events), 'Exact cache read changed output, events, or stream count')
      const requests = auditAfterCache.events.filter(event => event.type === 'context/semantic-request' && !priorRequests.has(event.seq))
      const results = auditAfterCache.events.filter(event => event.type === 'context/semantic-result' && !priorResults.has(event.seq))
      check(requests.length === 1 && results.length === 1 && results[0].data.status === 'completed'
        && results[0].data.requestSeq === requests[0].seq && results[0].data.key === requests[0].data.key
        && isDeepStrictEqual(results[0].data.projection, projection)
        && state.streamAttempts - row.streamAttemptsBefore === 1 && state.dispatchAttempts - row.dispatchAttemptsBefore === 1,
      'Completed case requires one matching durable request/result and one delegated stream attempt')
      row.cache = 'exact-projection-and-events; zero-new-stream-attempts'
      row.outcome = 'completed'
      state.completedProjections++
    } catch (error) {
      row.outcome = 'failed'
      row.productionValidation ??= 'rejected-or-not-delivered'
      row.error = errorMessage(error)
    }
    const audit = await readAudit()
    await save('audit-readback.json', audit)
    const requests = audit.events.filter(event => event.type === 'context/semantic-request' && !priorRequests.has(event.seq))
    check(requests.length <= 1, 'More than one reservation for one pilot case')
    const request = requests[0]
    const result = audit.events.findLast(event => event.type === 'context/semantic-result' && event.data.requestSeq === request?.seq)
    check(result === undefined || result.data.key === request.data.key, 'Audit result names a different request key')
    row.requestSeq = request?.seq ?? null
    row.resultSeq = result?.seq ?? null
    row.usage = result?.data.usage ?? null
    row.elapsedMs = result?.data.elapsedMs ?? null
    row.actualCall = request?.data.call ?? null
    row.estimatedCostUsd = fixture.execution.kind === 'transport-calibration' ? 0
      : row.usage === null ? null : (row.usage.inputTokens * fixture.pricing.inputMissPerMillion
      + (row.usage.cacheReadTokens ?? 0) * fixture.pricing.inputHitPerMillion
      + row.usage.outputTokens * fixture.pricing.outputPerMillion) / 1e6
    row.costMeaning = fixture.execution.kind === 'live' ? 'list-price estimate, not invoice' : 'synthetic calibration usage; no model cost'
    if (row.usage === null && state.dispatchAttempts > row.dispatchAttemptsBefore) state.unknownUsage = true
    if (row.estimatedCostUsd !== null && fixture.execution.kind === 'live') state.cumulativeKnownCostUsd += row.estimatedCostUsd
    row.streamAttemptsAfter = state.streamAttempts
    row.dispatchAttemptsAfter = state.dispatchAttempts
    row.finishedAt = new Date().toISOString()
    await save('progress.json', state)
    current = undefined
  }

  async function run() {
    const timeout = setTimeout(() => controller.abort(new Error('Pilot wall deadline exceeded')), fixture.limits.wallTimeoutMs)
    try {
      const inputs = await freezeInputs()
      state.status = 'inputs-frozen'
      await save('progress.json', state)
      if (config.mode === 'preflight') { state.status = 'offline-preflight-completed'; return }
      const backend = ctx.get('developmentTaskContextBackend')
      check(backend !== undefined && backend.identity.id === 'semantic', 'Execute requires the production semantic backend')
      const credentials = ctx.get('credentials')
      check(credentials !== undefined, 'Execution requires the existing credential service')
      const info = await credentials.describe(fixture.execution.apiKeyEnv)
      await save('credential-metadata.json', { configured: info.configured, source: info.source ?? null })
      check(info.configured, 'Pilot credential reference is not configured; no model call made')
      for (const item of inputs) {
        controller.signal.throwIfAborted()
        if (state.unknownUsage || state.cumulativeKnownCostUsd >= fixture.limits.maxKnownCostUsd) break
        await runCase(backend, item)
        if (fileFailure !== undefined) throw fileFailure
      }
      state.status = state.cases.length === 6 && state.cases.every(row => row.outcome === 'completed')
        ? 'six-projections-completed-semantic-review-pending' : 'stopped-or-failed'
    } catch (error) {
      state.status = 'failed'
      state.error = errorMessage(error)
    } finally {
      clearTimeout(timeout)
      state.finishedAt = new Date().toISOString()
      state.unattemptedCases = fixture.cases.filter(cell => !state.cases.some(row => row.id === cell.id)).map(cell => cell.id)
      await save('result.json', state)
    }
  }

  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  check(ready !== undefined && exit !== undefined, 'Pilot requires the named dsh profile launcher')
  ctx.effect(() => ready.onReady(() => {
    operation = run()
    void operation.then(() => exit(state.status === 'offline-preflight-completed'
      || state.status === 'six-projections-completed-semantic-review-pending' ? 0 : 1), () => exit(1))
  }))
  ctx.effect(() => async () => {
    controller.abort(new Error('Pilot disposed'))
    await operation
  })
}
