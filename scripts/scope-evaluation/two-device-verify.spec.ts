/** Static captured Web exports remain reconstructable after relocation; mutations cannot borrow observer success flags. */
import { gunzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as SessionModule from '@deepseek-ai/dsh-session'
import * as Catalog from '@deepseek-ai/dsh-session-format-catalog'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import { contextSourceSchema } from '../../packages/collaboration/scope-agent-context/src/state.ts'
import { localContextProjectionDigest, localTaskContextSourceSchema }
  from '../../packages/collaboration/development-task-context/src/local-schema.ts'
import { projectionDigest } from '../../packages/collaboration/scope-access/src/schema.ts'
import type { ScopeAccessCaptureProjection } from '../../packages/collaboration/scope-access/src/types.ts'
import { nativeDigest } from '../../packages/collaboration/scope-agent-contribution/src/identity.ts'
import { verifyTwoDeviceEvidence, runTwoDeviceVerification } from './two-device-verify.ts'
import { ExportReader, exportLimits, exportRelativePath } from './two-device-verify-files.ts'
import { canonicalEvidence, evidenceDigest, persistedEvidenceHeader, restoreEvidenceSession } from './two-device-verify-replay.mjs'

// Original two-process/one-machine keyless Web captures. The compressed JSON retains every selected file's exact text
// and SHA-256; no home, overlay, replay program, credentials or external model results are included. Recorded paths are inert.
// Captured Session generations are frozen: future recordings add a new fixture generation instead of overwriting these bytes.
const fixtureSchema = z.strictObject({ version: z.literal(1), provenance: z.strictObject({
  kind: z.literal('two-controlled-web-processes-one-machine'), physicalDevicesVerified: z.literal(false),
  externalModelCalls: z.literal(0), source: z.string(), originalPathsNeedNotExist: z.literal(true),
}), hashes: z.record(z.string(), z.string()), files: z.record(z.string(), z.string()) })
const allowedFixtureFile = new RegExp('^[AB]/(?:device\\.json|process-exit\\.json|evidence/(?:requests\\.jsonl|verification\\.json)'
  + '|sessions/[^/]+/[^/]+/session\\.v3\\.jsonl|workspace/project/[^/]+\\.ts)$', 'u')
const roots: string[] = []
afterEach(async () => {
  const results = await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const failures: unknown[] = []
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'offline export fixture cleanup failed')
})
async function fixture(generation: 1 | 2 | 3 = 1) {
  const files = { 1: './two-device-verify.fixture.json.gz', 2: './two-device-verify.v2.fixture.json.gz',
    3: './two-device-verify.v3.fixture.json.gz' }
  const file = files[generation]
  const bytes = await readFile(new URL(file, import.meta.url))
  expect(bytes.length).toBeLessThan(524288)
  const captured = fixtureSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: 2097152 }).toString('utf8')) as unknown)
  const root = await mkdtemp(join(tmpdir(), 'two-device-verify-'))
  roots.push(root)
  for (const [name, text] of Object.entries(captured.files)) {
    exportRelativePath(name)
    expect(name).toMatch(allowedFixtureFile)
    expect(evidenceDigest(text)).toBe(captured.hashes[name])
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), text, { flag: 'wx' })
  }
  return { root, aDirectory: join(root, 'A'), bDirectory: join(root, 'B'), captured }
}
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value) + '\n') }
const objectSchema = z.record(z.string(), z.unknown())
const rowSchema = z.looseObject({ type: z.string(), seq: z.number(), data: z.record(z.string(), z.unknown()) })
const requestSchema = z.looseObject({ eventCount: z.number(), messages: z.array(z.unknown()) })
/** Recompute transport hashes after a targeted semantic mutation so the regression reaches the actual paired checks. */
async function reseal(directory: string, mutate: (rows: z.infer<typeof rowSchema>[]) => void) {
  const verification = z.looseObject({ sessions: z.array(z.looseObject({ path: z.string() })) })
    .parse(await json(join(directory, 'evidence/verification.json')))
  const summary = verification.sessions[0]
  if (summary === undefined) throw new Error('captured Session missing')
  const sessionPath = join(directory, 'sessions', exportRelativePath(summary.path))
  const original = (await readFile(sessionPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
  const rows = original.slice(1).map(row => rowSchema.parse(row))
  mutate(rows)
  const raw = [original[0], ...rows].map(row => JSON.stringify(row)).join('\n') + '\n'
  const restored = restoreEvidenceSession(SessionModule, Catalog, [original[0], ...rows])
  await writeFile(sessionPath, raw)
  const requests = (await readFile(join(directory, 'evidence/requests.jsonl'), 'utf8')).trimEnd().split('\n')
    .map(line => requestSchema.parse(JSON.parse(line) as unknown))
  for (const request of requests) {
    const prefix = restored.events.slice(0, request.eventCount)
    const session = SessionModule.Session.create(restored.session.id, prefix, restored.header)
    request.messages = [...session.deriveMessages()]
    request.prefixSha256 = evidenceDigest(canonicalEvidence({ header: persistedEvidenceHeader(restored.header), events: prefix }))
    const messages = z.array(z.looseObject({ source: z.looseObject({ kind: z.string() }),
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })) })).parse(request.messages)
    const managed = messages.filter(message => ['scope-agent-context', 'development-task-context'].includes(message.source.kind))
    request.contextBytes = managed.reduce((sum, message) => sum + message.content.reduce((total, block) =>
      total + (block.type === 'text' ? Buffer.byteLength(block.text ?? '') : 0), 0), 0)
  }
  const requestText = requests.map(request => JSON.stringify(request)).join('\n') + '\n'
  await writeFile(join(directory, 'evidence/requests.jsonl'), requestText)
  summary.bytes = Buffer.byteLength(raw)
  summary.sha256 = evidenceDigest(raw)
  summary.eventCount = rows.length
  summary.lastTurnEnd = rows.findLast(row => row.type === 'turn/end')
  verification.evidenceBytes = Buffer.byteLength(requestText)
  await writeJson(join(directory, 'evidence/verification.json'), verification)
}
function event(rows: z.infer<typeof rowSchema>[], type: string, seq?: number) {
  const value = rows.find(row => row.type === type && (seq === undefined || row.seq === seq))
  if (value === undefined) throw new Error('captured mutation target absent')
  return value
}

it('reconstructs both relocated exports and limits its claims to the captured material', async () => {
  const f = await fixture()
  const result = await verifyTwoDeviceEvidence(f)
  expect(result).toMatchObject({ version: 1, status: 'passed', controlledRequests: 13, physicalDevicesVerified: false,
    localBaseline: 'join-plan', preJoinUiAssignmentVerified: false, crossDeviceAfterLeaveOrderVerified: false })
  expect(result.leave).toMatchObject({ ownerAfterAdmissionVerified: true, ownerAfterAdmissionEvidence: 'captured-projection' })
  expect(result.directions.AtoB).toMatchObject({ callSeq: 23, resultSeq: 24, receiveRequest: 2 })
  expect(result.directions.BtoA).toMatchObject({ callSeq: 39, resultSeq: 40, receiveRequest: 3 })
  expect(result.endpoints.A.files['device.json']?.sha256).toBe(f.captured.hashes['A/device.json'])
  expect(result.endpoints.B.files['device.json']?.sha256).toBe(f.captured.hashes['B/device.json'])
  expect(await runTwoDeviceVerification(['--a', f.aDirectory, '--b', f.bDirectory])).toEqual(result)
})
it('ignores recorded root paths as read instructions and permits equal original root names', async () => {
  const f = await fixture()
  for (const directory of [f.aDirectory, f.bDirectory]) {
    const manifest = objectSchema.parse(await json(join(directory, 'device.json')))
    for (const key of ['root', 'home', 'sessionRoot', 'evidencePath', 'overlayPath']) manifest[key] = '/nonexistent/same-original-root'
    manifest.sourceHashes = { '/do-not-read/private-key': 'a'.repeat(64) }
    await writeJson(join(directory, 'device.json'), manifest)
  }
  expect((await verifyTwoDeviceEvidence(f)).status).toBe('passed')
})
it('refuses a forged passed report when the actual request program is incomplete', async () => {
  const f = await fixture()
  const path = join(f.aDirectory, 'evidence/requests.jsonl')
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
  await writeFile(path, lines.slice(0, -1).join('\n') + '\n')
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('controlled request program was not fully consumed')
})
it.each(['messages', 'tools', 'sourceSeqs', 'prefixSha256'] as const)('refuses altered actual-request %s', async (field) => {
  const f = await fixture()
  const path = join(f.aDirectory, 'evidence/requests.jsonl')
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => objectSchema.parse(JSON.parse(line) as unknown))
  const value = rows[3]
  if (value === undefined) throw new Error('request absent')
  value[field] = field === 'prefixSha256' ? 'a'.repeat(64) : []
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const detail = { messages: 'actual messages differ', tools: 'actual request header differs',
    sourceSeqs: 'managed source sequence mismatch', prefixSha256: 'persisted request prefix hash mismatch' }
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow(detail[field])
})
it('refuses an error tool result even after all transport hashes are recomputed', async () => {
  const f = await fixture()
  await reseal(f.aDirectory, (rows) => {
    const result = event(rows, 'tool/result', 24)
    const message = z.looseObject({ content: z.array(z.looseObject({ isError: z.boolean().optional() })) }).parse(result.data.message)
    if (message.content[0] === undefined) throw new Error('result block missing')
    message.content[0].isError = true
    result.data.message = message
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('write did not complete successfully')
})
it('rejects a substituted peer execution sourceId with matching request and Session hashes', async () => {
  const f = await fixture()
  await reseal(f.aDirectory, (rows) => {
    const row = event(rows, 'user/message', 35)
    const content = z.array(z.looseObject({ text: z.string() })).parse(row.data.content)
    const block = content[0]
    if (block === undefined) throw new Error('context missing')
    block.text = block.text.replace('9b402b0ce351de831040fc0b62c5c13c0fe460afbd6db629345ae51b42dbce82', 'a'.repeat(64))
    row.data.content = content
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('peer sourceId differs from actual execution coordinates')
})
it('rejects private content in a reconstructed peer request', async () => {
  const f = await fixture()
  const manifest = z.object({ files: z.object({ private: z.object({ text: z.string() }) }) })
    .parse(await json(join(f.bDirectory, 'device.json')))
  await reseal(f.aDirectory, (rows) => {
    const row = event(rows, 'system/message')
    const message = z.looseObject({ content: z.array(z.looseObject({ text: z.string() })) }).parse(row.data.message)
    if (message.content[0] === undefined) throw new Error('system content missing')
    message.content[0].text += '\n' + manifest.files.private.text
    row.data.message = message
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('private content leaked to peer')
})
it('refuses a leave record that changes the retained local Task', async () => {
  const f = await fixture()
  await reseal(f.bDirectory, (rows) => {
    const row = event(rows, 'scope-agent-context/join-read', 46)
    const plan = z.looseObject({ target: z.looseObject({ taskId: z.string() }) }).parse(row.data.plan)
    plan.target.taskId = 'another-task'
    row.data.plan = plan
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('leave changed the original plan')
})
it('refuses changed business bytes and a contradictory observer status', async () => {
  const f = await fixture()
  await writeFile(join(f.aDirectory, 'workspace/project/owner.ts'), 'changed\n')
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('business file differs from completed write')
  await writeFile(join(f.aDirectory, 'workspace/project/owner.ts'), f.captured.files['A/workspace/project/owner.ts'] ?? '')
  const path = join(f.aDirectory, 'evidence/verification.json')
  const verification = objectSchema.parse(await json(path))
  verification.status = 'failed'
  await writeJson(path, verification)
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('observer summary disagrees with rebuilt evidence')
})
it('refuses torn JSONL, finite read limits, and invalid CLI arguments', async () => {
  const f = await fixture()
  await expect(verifyTwoDeviceEvidence({ ...f, limits: { ...exportLimits, maxFileBytes: 10 } })).rejects.toThrow('byte limit exceeded')
  await expect(verifyTwoDeviceEvidence({ ...f, limits: { ...exportLimits, maxEntries: 1 } })).rejects.toThrow('entry limit exceeded')
  await expect(verifyTwoDeviceEvidence({ ...f, limits: { ...exportLimits, maxDepth: 0 } })).rejects.toThrow('depth exceeded')
  await expect(runTwoDeviceVerification(['--a', f.aDirectory])).rejects.toThrow('usage:')
  const path = join(f.aDirectory, 'evidence/requests.jsonl')
  await writeFile(path, (await readFile(path, 'utf8')).trimEnd())
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('incomplete or empty JSONL')
})
it('refuses path traversal and shared export roots', async () => {
  const f = await fixture()
  for (const path of ['../secret', 'workspace/../secret', '/absolute', 'C:\\secret', 'workspace//file', './file']) {
    expect(() => exportRelativePath(path)).toThrow('unsafe export-relative path')
  }
  await expect(verifyTwoDeviceEvidence({ aDirectory: f.aDirectory, bDirectory: f.aDirectory })).rejects.toThrow('independent directories')
  const reader = new ExportReader(f.aDirectory, exportLimits)
  await expect(reader.text('../device.json', 1048576)).rejects.toThrow('unsafe export-relative path')
})
// Creating file symlinks requires elevated permission on some Windows hosts.
it.skipIf(process.platform === 'win32')('refuses symlinked allowed files', async () => {
  const f = await fixture()
  const path = join(f.aDirectory, 'evidence/requests.jsonl')
  await rm(path)
  await symlink(join(f.bDirectory, 'evidence/requests.jsonl'), path)
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('symlink')
})

it('compares Windows-style recorded Session paths without using them as read paths', async () => {
  const f = await fixture()
  for (const directory of [f.aDirectory, f.bDirectory]) {
    const path = join(directory, 'evidence/verification.json')
    const value = z.looseObject({ sessions: z.array(z.looseObject({ path: z.string() })) }).parse(await json(path))
    for (const session of value.sessions) session.path = session.path.replaceAll('/', '\\')
    await writeJson(path, value)
  }
  expect((await verifyTwoDeviceEvidence(f)).status).toBe('passed')
})

it('rejects an invalid original header even when its missing depth would otherwise normalize to zero', async () => {
  const f = await fixture()
  const path = join(f.aDirectory, 'evidence/requests.jsonl')
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n')
    .map(line => z.looseObject({ header: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line) as unknown))
  if (rows[0] === undefined) throw new Error('request missing')
  rows[0].header.delegationDepth = null
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('delegationDepth')
})
it('rejects a same-body contribution carrying another capture generation', async () => {
  const f = await fixture()
  await reseal(f.aDirectory, (rows) => {
    const row = event(rows, 'user/message', 35)
    const content = z.array(z.looseObject({ text: z.string() })).parse(row.data.content)
    const block = content[0]
    if (block === undefined) throw new Error('context missing')
    block.text = block.text.replaceAll('36c401a2-6568-4bf2-b676-070ff5dd2549', '00000000-0000-4000-8000-000000000000')
    row.data.content = content
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('contribution grant differs from original read capture')
})
it('refuses a non-clean recorded process termination', async () => {
  const f = await fixture()
  const path = join(f.aDirectory, 'process-exit.json')
  const value = objectSchema.parse(await json(path))
  value.forced = true
  await writeJson(path, value)
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('forced')
})

it('rejects an after-leave omission with the right publication ID but another Task revision', async () => {
  const f = await fixture()
  await reseal(f.aDirectory, (rows) => {
    const row = event(rows, 'user/message', 53)
    const source = z.looseObject({ omittedSources: z.array(z.looseObject({ source: z.looseObject({
      publicationId: z.string().optional(), taskId: z.string(), revision: z.number(),
    }) })) }).parse(row.data.source)
    const after = source.omittedSources.find(item => item.source.publicationId
      === 'context-local-observation-56af797d2a1b7cc7b7b29cebf7cc520b26fa362767f54c5a25c95d063429aa43')
    if (after === undefined) throw new Error('captured after-leave source missing')
    after.source.taskId = 'another-task'
    after.source.revision += 1
    row.data.source = source
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('owner after-leave write lacks exact admitted source')
})
const reportedSchema = z.looseObject({ task: z.looseObject({ id: z.string(), revision: z.number() }),
  publications: z.array(z.looseObject({ id: z.string(), text: z.string(),
    source: z.looseObject({ taskId: z.string(), revision: z.number(), publicationId: z.string() }),
    localContribution: z.looseObject({ grant: z.looseObject({ taskId: z.string(), expiresAt: z.number() }) }).optional(),
    peerContribution: z.looseObject({
      grant: z.looseObject({ taskId: z.string(), grantId: z.string(), generation: z.string() }),
    }).optional(),
  })) })
function rewriteReported(text: string, mutate: (body: z.infer<typeof reportedSchema>) => void): string {
  const marker = '<development-task-context>\n'
  const start = text.indexOf(marker) + marker.length
  const end = text.lastIndexOf('\n</development-task-context>')
  if (start < marker.length || end < start) throw new Error('reported body missing')
  const body = reportedSchema.parse(JSON.parse(text.slice(start, end)) as unknown)
  mutate(body)
  return text.slice(0, start) + JSON.stringify(body).replaceAll('<', '\\u003c') + text.slice(end)
}
function rewriteScopeProjection(rows: z.infer<typeof rowSchema>[], seq: number,
  transform: (projection: ScopeAccessCaptureProjection) => ScopeAccessCaptureProjection): void {
  const row = event(rows, 'user/message', seq)
  const source = contextSourceSchema.parse(row.data.source)
  if (source.form !== 'snapshot' || source.version !== 2) throw new Error('capture projection missing')
  const prior = source.projection
  const projection = transform(prior)
  row.data.source = { ...source, projection: { ...projection, projectionId: projectionDigest(projection) } }
  const content = z.array(z.looseObject({ text: z.string() })).parse(row.data.content)
  if (content[0] === undefined || !content[0].text.endsWith(prior.text)) throw new Error('scope content missing')
  content[0].text = content[0].text.slice(0, -prior.text.length) + projection.text
  row.data.content = content
}
function rewriteCapturedScope(rows: z.infer<typeof rowSchema>[], transform: (text: string) => string, taskId?: DevelopmentTaskId): void {
  rewriteScopeProjection(rows, 29, prior => ({ ...prior, text: transform(prior.text), ...(taskId === undefined ? {} : {
    taskId, peerCapture: { ...prior.peerCapture, taskId }, selectedSources: prior.selectedSources.map(ref => ({ ...ref, taskId })),
    omittedSources: prior.omittedSources.map(item => ({ ...item, source: { ...item.source, taskId } })),
  }) }))
}
it('rejects two internally consistent Task identities that do not close across endpoints', async () => {
  const f = await fixture()
  const taskId = brandString<DevelopmentTaskId>('task-another-shared-scope')
  await reseal(f.bDirectory, (rows) => {
    for (const row of rows.filter(item => item.type === 'scope-agent-context/join-read')) {
      const plan = z.looseObject({ subscription: z.looseObject({ invitation: z.looseObject({ taskId: z.string() }) }) })
        .parse(row.data.plan)
      plan.subscription.invitation.taskId = taskId
      row.data.plan = plan
    }
    rewriteCapturedScope(rows, text => rewriteReported(text, (body) => {
      body.task.id = taskId
      for (const publication of body.publications) publication.source.taskId = taskId
    }), taskId)
  })
  await reseal(f.aDirectory, (rows) => {
    const row = event(rows, 'user/message', 35)
    const content = z.array(z.looseObject({ text: z.string() })).parse(row.data.content)
    if (content[0] === undefined) throw new Error('peer body missing')
    let changedId: string | undefined
    content[0].text = rewriteReported(content[0].text, (body) => {
      for (const publication of body.publications) {
        const grant = publication.peerContribution?.grant
        if (grant === undefined) continue
        grant.taskId = taskId
        const observation = z.object({ sourceId: z.string() })
          .parse(JSON.parse(publication.text.slice(publication.text.indexOf('\n') + 1)) as unknown)
        changedId = 'context-peer-observation-' + nativeDigest([taskId, grant.grantId, grant.generation, observation.sourceId])
        publication.id = changedId
        publication.source.publicationId = changedId
      }
    })
    if (changedId === undefined) throw new Error('peer publication missing')
    const source = z.looseObject({ selectedSources: z.array(z.looseObject({ kind: z.string(), publicationId: z.string().optional() })) })
      .parse(row.data.source)
    for (const ref of source.selectedSources) if (ref.kind === 'publication') ref.publicationId = changedId
    row.data.content = content
    row.data.source = source
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('received scope is not the source local Task')
})
it('rejects an owner publication recorded after its grant expired', async () => {
  const f = await fixture()
  await reseal(f.bDirectory, (rows) => {
    rewriteCapturedScope(rows, text => rewriteReported(text, (body) => {
      const grant = body.publications[0]?.localContribution?.grant
      if (grant === undefined) throw new Error('local grant missing')
      grant.expiresAt = 1
    }))
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('local publication was admitted after grant expiry')
})
it('uses strict durable relationship validation for model calls and executed arguments', async () => {
  const f = await fixture()
  const summary = z.object({ sessions: z.array(z.object({ path: z.string() })) })
    .parse(await json(join(f.aDirectory, 'evidence/verification.json'))).sessions[0]
  if (summary === undefined) throw new Error('captured Session missing')
  const path = join(f.aDirectory, 'sessions', exportRelativePath(summary.path))
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n')
  const index = rows.findIndex((line) => {
    const row = z.looseObject({ type: z.string(), seq: z.number().optional() }).parse(JSON.parse(line) as unknown)
    return row.type === 'assistant/message' && row.seq === 22
  })
  if (index < 0 || rows[index] === undefined) throw new Error('model tool call missing')
  rows[index] = rows[index].replaceAll('A_SHARED_', 'A_MODEL_')
  await writeFile(path, rows.join('\n') + '\n')
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('tool/call A-shared does not match one advertised tool call')
})

it('reconstructs the later captured Task revision after the peer contribution arrives', async () => {
  const f = await fixture(2)
  const requests = (await readFile(join(f.bDirectory, 'evidence/requests.jsonl'), 'utf8')).trimEnd().split('\n')
    .map(line => z.object({ messages: z.array(z.looseObject({ source: z.unknown() })) }).parse(JSON.parse(line) as unknown))
  const projections = requests.slice(2, 5).map((request) => {
    const scope = request.messages.map(message => contextSourceSchema.safeParse(message.source))
      .find(value => value.success && value.data.form === 'snapshot')
    if (!scope?.success || scope.data.form !== 'snapshot' || scope.data.version !== 2) throw new Error('captured scope missing')
    return scope.data.projection
  })
  expect(projections.map(value => value.taskRevision)).toEqual([4, 4, 5])
  expect(projections.map(value => value.omittedSources.map(item => item.reason))).toEqual([[], [], ['self-published']])
  expect(new Set(projections.map(value => value.projectionId)).size).toBe(2)
  expect((await verifyTwoDeviceEvidence(f)).status).toBe('passed')
})
it('checks each current allowance without requiring it to equal the first projection', async () => {
  const f = await fixture(2)
  await reseal(f.bDirectory, (rows) => {
    rewriteScopeProjection(rows, 42, prior => ({ ...prior, maxContextBytes: prior.maxContextBytes - 1 }))
  })
  expect((await verifyTwoDeviceEvidence(f)).status).toBe('passed')
})
it('refuses a later projection that changes the original read grant', async () => {
  const f = await fixture(2)
  await reseal(f.bDirectory, (rows) => {
    rewriteScopeProjection(rows, 42, prior => ({ ...prior, expiresAt: prior.expiresAt - 1 }))
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('projection differs from its original capture binding')
})
it('refuses a later projection that changes the original contribution capture', async () => {
  const f = await fixture(2)
  await reseal(f.bDirectory, (rows) => {
    rewriteScopeProjection(rows, 42, prior => ({ ...prior, peerCapture: { ...prior.peerCapture,
      generation: brandString<ScopeAccessCaptureProjection['peerCapture']['generation']>('another-generation') } }))
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('scope original capture changed during controlled sharing')
})
it('checks the complete owner publication again in each later scope snapshot', async () => {
  const f = await fixture(2)
  await reseal(f.bDirectory, (rows) => {
    rewriteScopeProjection(rows, 42, prior => ({ ...prior, text: rewriteReported(prior.text, (body) => {
      const grant = body.publications[0]?.localContribution?.grant
      if (grant === undefined) throw new Error('local grant missing')
      grant.expiresAt -= 1
    }) }))
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('shared owner publication changed during controlled sharing')
})
it('refuses a decreasing Task revision even with valid current projection and request hashes', async () => {
  const f = await fixture(2)
  await reseal(f.bDirectory, (rows) => {
    rewriteScopeProjection(rows, 42, prior => ({ ...prior, taskRevision: 3,
      selectedSources: prior.selectedSources.map(source => ({ ...source, revision: 3 })),
      omittedSources: prior.omittedSources.map(item => ({ ...item, source: { ...item.source, revision: 3 } })),
      text: rewriteReported(prior.text, (body) => {
        body.task.revision = 3
        for (const publication of body.publications) publication.source.revision = 3
      }),
    }))
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('scope Task revision moved backwards')
})

it('does not claim admission when the completed write is newer than the last captured Task projection', async () => {
  const f = await fixture(3)
  const result = await verifyTwoDeviceEvidence(f)
  expect(result).toMatchObject({ status: 'passed', controlledRequests: 13, crossDeviceAfterLeaveOrderVerified: false })
  expect(result.leave).toMatchObject({ ownerAfterAdmissionVerified: false, ownerAfterAdmissionEvidence: 'not-in-captured-request' })
  expect(result.leave.derivedOwnerAfterPublicationId).toMatch(/^context-local-observation-[a-f0-9]{64}$/u)
})
it.each(['selected', 'body'] as const)('rejects a misplaced after-leave publication in %s instead of calling it absent', async (where) => {
  const f = await fixture()
  await reseal(f.aDirectory, (rows) => {
    const row = event(rows, 'user/message', 53)
    const source = z.looseObject({ selectedSources: z.array(z.unknown()), omittedSources: z.array(z.looseObject({
      source: z.looseObject({ kind: z.string(), taskId: z.string(), revision: z.number(), publicationId: z.string().optional() }),
      reason: z.string(),
    })) }).parse(row.data.source)
    const id = 'context-local-observation-56af797d2a1b7cc7b7b29cebf7cc520b26fa362767f54c5a25c95d063429aa43'
    const after = source.omittedSources.find(item => item.source.publicationId === id)
    if (after === undefined) throw new Error('captured after-leave source missing')
    source.omittedSources = source.omittedSources.filter(item => item !== after)
    if (where === 'selected') source.selectedSources.push(after.source)
    else {
      const content = z.array(z.looseObject({ text: z.string() })).parse(row.data.content)
      if (content[0] === undefined) throw new Error('owner body missing')
      content[0].text = rewriteReported(content[0].text, (body) => {
        const publication = body.publications[0]
        if (publication === undefined) throw new Error('owner publication missing')
        publication.id = id
        publication.source.publicationId = id
      })
      row.data.content = content
    }
    row.data.source = source
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('owner after-leave write lacks exact admitted source')
})

const grantLegend = 'grantReferences.entries uses zero-based indices. Restore publications[publicationIndex]'
  + '[grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. All other fields are literal.'
const observationLegend = 'Expand grantReferences first if present. Indices are zero-based. For each entry let '
  + 'p=publications[publicationIndex], g=p.peerContribution.grant. Restore p.text as preambles[preambleIndex]+"\\n"'
  + '+JSON.stringify({...result,sourceName:g.source.name,grantId:g.grantId,sequence,observerPeerId:g.contributorPeerId,'
  + 'sourceId,capture:{id:g.captureId,generation:g.captureGeneration}}), in that field order. All other fields are literal.'
function indexedGrants(text: string, revision: '4' | '5'): string {
  const marker = '<development-task-context>\n'
  const start = text.indexOf(marker) + marker.length
  const end = text.lastIndexOf('\n</development-task-context>')
  if (start < marker.length || end < start) throw new Error('reported frame missing')
  const body = z.looseObject({ publications: z.array(objectSchema) }).parse(JSON.parse(text.slice(start, end)) as unknown)
  const grants: { kind: string; value: unknown }[] = []
  const entries: { publicationIndex: number; grantIndex: number }[] = []
  const preambles: string[] = []
  const observations: Record<string, unknown>[] = []
  for (const [publicationIndex, publication] of body.publications.entries()) {
    if (revision === '5' && publication.peerContribution !== undefined && typeof publication.text === 'string'
      && publication.text.startsWith('Authenticated peer tool observation.')) {
      const split = publication.text.indexOf('\n')
      const warning = publication.text.slice(0, split)
      const value = objectSchema.parse(JSON.parse(publication.text.slice(split + 1)) as unknown)
      if (value.kind === 'tool-observation') {
        const { sourceName: _name, grantId: _grant, observerPeerId: _peer, capture: _capture, sequence, sourceId, ...result } = value
        let preambleIndex = preambles.indexOf(warning)
        if (preambleIndex === -1) { preambleIndex = preambles.length; preambles.push(warning) }
        observations.push({ publicationIndex, preambleIndex, result, sequence, sourceId })
        delete publication.text
      }
    }
    for (const kind of ['peerContribution', 'localContribution', 'authority']) {
      const result = objectSchema.safeParse(publication[kind])
      if (!result.success || !Object.hasOwn(result.data, 'grant')) continue
      const { grant, ...parent } = result.data
      const grantIndex = grants.length
      grants.push({ kind, value: grant })
      entries.push({ publicationIndex, grantIndex })
      publication[kind] = parent
    }
  }
  if (entries.length > 0) body.grantReferences = { version: 1, legend: grantLegend, grants, entries }
  if (observations.length > 0) body.observationReferences = { version: 1, legend: observationLegend, preambles, entries: observations }
  return text.slice(0, start) + JSON.stringify(body).replaceAll('<', '\\u003c') + text.slice(end)
}
function upgradeReportedEvidence(rows: z.infer<typeof rowSchema>[], revision: '4' | '5'): void {
  for (const row of rows) {
    if (row.type !== 'user/message') continue
    const source = objectSchema.parse(row.data.source)
    if (source.kind === 'scope-agent-context' && source.form === 'snapshot') {
      rewriteScopeProjection(rows, row.seq, prior => ({ ...prior, backend: { id: 'reported-files', revision },
        text: indexedGrants(prior.text, revision) }))
    } else if (source.kind === 'development-task-context' && source.form === 'snapshot') {
      const parsed = localTaskContextSourceSchema.parse(source)
      if (parsed.form !== 'snapshot' || parsed.version === 1) throw new Error('attributed local context missing')
      const content = z.array(z.looseObject({ text: z.string() })).parse(row.data.content)
      if (content[0] === undefined) throw new Error('local context text missing')
      content[0].text = indexedGrants(content[0].text, revision)
      if (parsed.version === 2) row.data.source = { ...parsed, backend: { id: 'reported-files', revision } }
      else {
        const projection = { ...parsed.projection, backend: { id: 'reported-files', revision }, text: content[0].text }
        row.data.source = { ...parsed, projection: { ...projection, projectionId: localContextProjectionDigest(projection) } }
      }
      row.data.content = content
    }
  }
}
it.each(['4', '5'] as const)('independently expands revision %s while preserving the revision 3 recorded fixture', async (revision) => {
  const f = await fixture()
  for (const directory of [f.aDirectory, f.bDirectory]) await reseal(directory, (rows) => { upgradeReportedEvidence(rows, revision) })
  const result = await verifyTwoDeviceEvidence(f)
  expect(result).toMatchObject({ status: 'passed', controlledRequests: 13, physicalDevicesVerified: false })
  expect(result.leave.ownerAfterAdmissionVerified).toBe(true)
  if (revision === '5') expect(await readFile(join(f.aDirectory, 'evidence/requests.jsonl'), 'utf8'))
    .toContain('observationReferences')
})
it('refuses a backend revision change within the original sharing interval', async () => {
  const f = await fixture(2)
  await reseal(f.bDirectory, (rows) => {
    const current = rows.filter(row => row.type === 'user/message').findLast((row) => {
      const source = objectSchema.parse(row.data.source)
      return source.kind === 'scope-agent-context' && source.form === 'snapshot'
    })
    if (current === undefined) throw new Error('last scope projection missing')
    rewriteScopeProjection(rows, current.seq, prior => ({ ...prior, backend: { id: 'reported-files', revision: '4' } }))
  })
  await expect(verifyTwoDeviceEvidence(f)).rejects.toThrow('scope context backend changed during controlled sharing')
})
