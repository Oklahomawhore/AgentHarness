/** Offline consistency verification for the existing two-endpoint controlled Web calibration. */
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { localTaskContextSourceSchema } from '../../packages/collaboration/development-task-context/src/local-schema.ts'
import { localContributionGrantSchema, localContributionRequestSchema, peerContributionGrantSchema,
  peerContributionRequestSchema } from '../../packages/collaboration/development-task/src/schema.ts'
import { localContributionPublicationId } from '../../packages/collaboration/development-task/src/local.ts'
import { peerContributionPublicationId } from '../../packages/collaboration/development-task/src/peer.ts'
import { contextSourceSchema } from '../../packages/collaboration/scope-agent-context/src/state.ts'
import { joinReadEventSchema, joinReadHistory } from '../../packages/collaboration/scope-agent-context/src/join-read.ts'
import { snapshotMessage, withdrawalMessage } from '../../packages/collaboration/scope-agent-context/src/messages.ts'
import { nativeDigest } from '../../packages/collaboration/scope-agent-contribution/src/identity.ts'
import { ExportReader, exportLimits, exportLimitsSchema, exportRoots, type ExportLimits } from './two-device-verify-files.ts'
import { evidenceCheck as check, evidenceEqual as equal, verifyEndpoint,
  type DeviceRequest, type DeviceWrite, type VerifiedEndpoint } from './two-device-verify-endpoint.ts'

const refSchema = z.strictObject({ kind: z.literal('publication'), taskId: z.string(), revision: z.number().int().positive(), publicationId: z.string() })
const publicationSchema = z.looseObject({ source: refSchema, id: z.string(), text: z.string(), publishedAt: z.number(),
  publishedBy: z.string().optional(),
  localContribution: z.strictObject({
    version: z.literal(1), grant: localContributionGrantSchema, ended: z.string().optional(),
  }).optional(),
  peerContribution: z.strictObject({ version: z.literal(1), grant: peerContributionGrantSchema, ended: z.string().optional() }).optional(),
})
const payloadSchema = z.looseObject({ task: z.looseObject({ id: z.string(), revision: z.number().int().positive(),
  objective: z.string() }), publications: z.array(publicationSchema) })
const observationFields = { kind: z.literal('tool-observation'), version: z.literal(1), reportedStatus: z.literal('success'),
  omissions: z.tuple([]), tool: z.literal('Write'), fields: z.strictObject({ rootIndex: z.literal(0), path: z.string(), content: z.string() }),
  sourceId: z.string().regex(/^[a-f0-9]{64}$/u), sequence: z.number().int().positive() }
const localObservation = z.strictObject(observationFields)
const peerObservation = z.strictObject({ ...observationFields, sourceName: z.string(), grantId: z.string(),
  observerPeerId: z.string(), capture: z.strictObject({ id: z.string(), generation: z.string() }) })
function request(endpoint: VerifiedEndpoint, index: number): DeviceRequest {
  const value = endpoint.requests[index]
  check(value !== undefined, 'required request is absent')
  return value
}
function message(value: DeviceRequest, kind: string) {
  const messages = value.messages.filter(item => item.source.kind === kind)
  check(messages.length === 1 && messages[0] !== undefined, `expected one ${kind} message`)
  return messages[0]
}
function text(value: ReturnType<typeof message>): string {
  check(value.content.length === 1 && value.content[0]?.type === 'text' && value.content[0].text !== undefined,
    'managed message must contain one exact text block')
  return value.content[0].text
}
function payload(value: ReturnType<typeof message>) {
  const body = text(value)
  const start = '<development-task-context>\n'
  const end = '\n</development-task-context>'
  const first = body.indexOf(start)
  check(first >= 0 && body.indexOf(start, first + start.length) === -1 && body.endsWith(end), 'missing exact reported Task body')
  return payloadSchema.parse(JSON.parse(body.slice(first + start.length, -end.length)) as unknown)
}
function local(value: DeviceRequest) {
  const entry = message(value, 'development-task-context')
  const source = localTaskContextSourceSchema.parse(entry.source)
  check(source.form === 'snapshot' && source.version !== 1, 'missing attributable local Task snapshot')
  const data = payload(entry)
  const fields = source.version === 3 ? source.projection : { taskId: source.taskId, taskRevision: source.revision,
    taskBindingId: source.bindingId, bindingEpoch: source.bindingEpoch, maxContextBytes: source.maxContextBytes,
    selectedSources: source.selectedSources, omittedSources: source.omittedSources, backend: source.backend }
  equal([data.task.id, data.task.revision], [fields.taskId, fields.taskRevision], 'local Task body attribution differs')
  check(Buffer.byteLength(text(entry)) <= fields.maxContextBytes, 'local Task message exceeds allowance')
  if (source.version === 3) equal(text(entry), source.projection.text, 'local projection text differs from actual message')
  equal(fields.backend, { id: 'reported-files', revision: '3' }, 'unsupported calibration context backend')
  return { entry, source, data, fields }
}
function shared(value: DeviceRequest) {
  const entry = message(value, 'scope-agent-context')
  const source = contextSourceSchema.parse(entry.source)
  check(source.form === 'snapshot' && source.version === 2, 'missing capture-bound scope snapshot')
  const data = payload(entry)
  equal([data.task.id, data.task.revision], [source.projection.taskId, source.projection.taskRevision], 'scope Task body attribution differs')
  return { entry, source, data }
}
function selectedPublication(data: ReturnType<typeof payload>, refs: readonly unknown[], file: { path: string; text: string }) {
  // Decode every report instead of relying on string-escaping details to locate the one expected publication.
  const matches = data.publications.filter((item) => {
    const newline = item.text.indexOf('\n')
    if (newline < 0) return false
    const parsed: unknown = JSON.parse(item.text.slice(newline + 1))
    const observation = z.looseObject({ fields: z.looseObject({ content: z.string().optional() }) }).safeParse(parsed)
    return observation.success && observation.data.fields.content === file.text
  })
  check(matches.length === 1 && matches[0] !== undefined, 'expected shared Write absent from actual request body')
  const publication = matches[0]
  equal(publication.id, publication.source.publicationId, 'publication identity differs from source')
  equal([publication.source.taskId, publication.source.revision], [data.task.id, data.task.revision], 'publication Task attribution differs')
  check(refs.some(ref => isDeepStrictEqual(ref, publication.source)), 'publication lacks exact selected source')
  return publication
}
function completedWrite(endpoint: VerifiedEndpoint, file: { path: string; text: string }): DeviceWrite {
  const write = endpoint.writes.find(item => item.path === file.path && item.text === file.text)
  check(write !== undefined, 'shared publication lacks a completed source write')
  return write
}
function sourceId(endpoint: VerifiedEndpoint, write: DeviceWrite, capture: { captureId: string; captureGeneration: string },
  sequence: number, kind: 'native-tool' | 'native-local-tool'): string {
  return nativeDigest([nativeDigest([kind, endpoint.session.id, capture.captureId, capture.captureGeneration,
    write.callSeq, write.resultSeq]), sequence])
}
function observation(publication: z.infer<typeof publicationSchema>, kind: 'local' | 'peer') {
  const newline = publication.text.indexOf('\n')
  const prefix = kind === 'local' ? 'Local Agent tool observation. This is a reported event, not a current file snapshot.'
    : 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
      + 'The Task owner has not independently verified the tool execution or file contents.'
  equal(publication.text.slice(0, newline), prefix, 'reported observation warning mismatch')
  const value: unknown = JSON.parse(publication.text.slice(newline + 1))
  return kind === 'local' ? localObservation.parse(value) : peerObservation.parse(value)
}
function result(value: z.infer<typeof localObservation>) {
  return { kind: value.kind, version: value.version, reportedStatus: value.reportedStatus, omissions: value.omissions,
    tool: value.tool, fields: value.fields }
}
function noPeerText(endpoint: VerifiedEndpoint, indexes: readonly number[], contents: readonly string[]): void {
  for (const index of indexes) for (const content of contents) {
    // JSON-encoded report text is decoded separately below; a nonce also catches nested JSON representations.
    const nonce = /[a-f0-9-]{36}/u.exec(content)?.[0]
    check(nonce !== undefined && !JSON.stringify(request(endpoint, index).messages).includes(nonce), 'private or unauthorized peer content leaked')
  }
}
function verifyPair(a: VerifiedEndpoint, b: VerifiedEndpoint) {
  check(a.session.id !== b.session.id, 'endpoints reused one Session')
  const aLocal = local(request(a, 1))
  const bLocal = local(request(b, 2))
  check(aLocal.fields.taskId !== bLocal.fields.taskId, 'endpoints merged their local Tasks')
  for (const endpoint of [a, b]) for (const current of endpoint.requests.filter(item => item.turn > 1)) {
    const currentLocal = local(current)
    const initial = endpoint === a ? aLocal : bLocal
    if (currentLocal.source.version === 3) equal(currentLocal.source.projection.participantId,
      developmentAgentParticipantId(endpoint.session.id), 'original local Task participant changed')
    equal([currentLocal.fields.taskId, currentLocal.fields.taskBindingId, currentLocal.fields.bindingEpoch],
      [initial.fields.taskId, initial.fields.taskBindingId, initial.fields.bindingEpoch], 'original local Task assignment changed')
  }
  const joins = b.events.filter(event => event.type === 'scope-agent-context/join-read')
    .map(event => ({ seq: event.seq, value: joinReadEventSchema.parse(event.data) }))
  equal(joins.map(event => event.value.phase), ['planned', 'adopted', 'ended'], 'joint join transition sequence differs')
  const [planned, adopted, ended] = joins
  check(planned !== undefined && adopted !== undefined && ended !== undefined, 'missing joint join transitions')
  const plan = planned.value.plan
  check(planned.value.version === 4 && plan !== null && 'kind' in plan && plan.kind === 'local-task-scope', 'missing retained local join plan')
  equal([adopted.value.adoptionId, ended.value.adoptionId], [planned.value.adoptionId, planned.value.adoptionId], 'joint adoption identity changed')
  equal(adopted.value.plan, plan, 'adoption changed the original plan')
  equal(ended.value.plan, plan, 'leave changed the original plan')
  check(ended.value.phase === 'ended' && ended.value.leaveAdopted, 'joint leave did not end adopted reading')
  equal([plan.automatic, plan.retainedLocal.automatic], [null, null], 'joint join granted automatic work')
  equal(plan.target, { taskId: bLocal.fields.taskId, taskBindingId: bLocal.fields.taskBindingId,
    bindingEpoch: bLocal.fields.bindingEpoch, participantId: developmentAgentParticipantId(b.session.id) }, 'join plan differs from recorded local responsibility')
  const history = joinReadHistory(b.session)
  equal(history.bindingId, plan.retainedLocal.bindingId, 'leave did not retain the original local binding')
  const aToB = shared(request(b, 2))
  const projection = aToB.source.projection
  equal(projection.taskId, aLocal.fields.taskId, 'received scope is not the source local Task')
  equal([aToB.source.bindingId, aToB.source.subscriptionId], [plan.bindingId, plan.subscription.id], 'scope message belongs to another join')
  equal([projection.taskId, projection.ownerPeerId, projection.recipientPeerId,
    projection.grantId, projection.grantGeneration, projection.expiresAt],
  [plan.subscription.invitation.taskId, plan.subscription.invitation.ownerPeerId, plan.subscription.invitation.recipientPeerId,
    plan.subscription.invitation.grantId, plan.subscription.invitation.generation, plan.subscription.invitation.expiresAt], 'scope read grant differs from join')
  equal([projection.peerCapture.captureId, projection.peerCapture.captureGeneration],
    [plan.subscription.originalCapture.captureId, plan.subscription.originalCapture.captureGeneration], 'scope original capture differs from join')
  const binding = { kind: 'local-task-scope' as const, id: plan.bindingId, target: plan.target, retainedLocal: plan.retainedLocal,
    subscriptionId: plan.subscription.id, invitation: plan.subscription.invitation, originalCapture: plan.subscription.originalCapture }
  const localPublication = selectedPublication(aToB.data, projection.selectedSources, a.manifest.files.shared)
  check(localPublication.localContribution !== undefined && localPublication.peerContribution === undefined, 'owner Write lacks local grant')
  check(localPublication.localContribution.ended === undefined, 'local publication is withdrawn')
  const localGrant = localPublication.localContribution.grant
  check(localPublication.publishedAt < localGrant.expiresAt, 'local publication was admitted after grant expiry')
  equal(localGrant.taskId, localPublication.source.taskId, 'local publication grant differs from its source Task')
  equal([localGrant.source, localGrant.maxSamples, localGrant.maxSampleBytes],
    [{ kind: 'tool-observations', name: 'session-work', tools: ['Write'] }, 8, 8192], 'local grant changed its permitted source or limits')
  const localReport = observation(localPublication, 'local')
  const aWrite = completedWrite(a, a.manifest.files.shared)
  equal([localGrant.taskId, localGrant.bindingId, localGrant.expectedBindingEpoch, localGrant.participantId, localPublication.publishedBy],
    [aLocal.fields.taskId, aLocal.fields.taskBindingId, aLocal.fields.bindingEpoch,
      developmentAgentParticipantId(a.session.id), developmentAgentParticipantId(a.session.id)], 'local contribution grant differs from source Session assignment')
  equal([localReport.fields.path, localReport.fields.content, localReport.sequence],
    [aWrite.path.slice('project/'.length), aWrite.text, 1], 'local report differs from source write')
  equal(localReport.sourceId, sourceId(a, aWrite, localGrant, 1, 'native-local-tool'), 'local sourceId differs from actual execution coordinates')
  const localSample = localContributionRequestSchema.parse({ grant: localGrant, sourceId: localReport.sourceId,
    sequence: localReport.sequence, result: result(localReport) })
  equal(localPublication.id, localContributionPublicationId(localSample), 'local publicationId differs from exact sample')
  let taskRevision = projection.taskRevision
  for (const current of b.requests.filter(item => item.turn === 2 || item.turn === 3)) {
    check(current.eventCount > adopted.seq && current.eventCount <= ended.seq, 'scope request is outside its adopted interval')
    const scope = shared(current)
    const currentProjection = scope.source.projection
    equal([scope.source.bindingId, scope.source.subscriptionId], [plan.bindingId, plan.subscription.id], 'scope message belongs to another join')
    equal(currentProjection.peerCapture, projection.peerCapture, 'scope original capture changed during controlled sharing')
    equal(currentProjection.backend, { id: 'reported-files', revision: '3' }, 'unsupported calibration context backend')
    equal(currentProjection.activation, { kind: 'exact' }, 'controlled scope activation differs')
    equal(scope.entry.content, snapshotMessage(binding, currentProjection, 8000).content, 'actual scope text differs from current projection')
    check(current.contextBytes <= 8000, 'combined managed context exceeds 8000 bytes')
    check(currentProjection.taskRevision >= taskRevision, 'scope Task revision moved backwards')
    taskRevision = currentProjection.taskRevision
    equal(scope.data.task, { ...aToB.data.task, revision: taskRevision }, 'shared Task fields changed during controlled sharing')
    const publication = selectedPublication(scope.data, currentProjection.selectedSources, a.manifest.files.shared)
    equal(publication, { ...localPublication, source: { ...localPublication.source, revision: taskRevision } },
      'shared owner publication changed during controlled sharing')
  }
  const aRead = local(request(a, 3))
  const peerPublication = selectedPublication(aRead.data, aRead.fields.selectedSources, b.manifest.files.shared)
  check(peerPublication.peerContribution !== undefined && peerPublication.localContribution === undefined, 'peer Write lacks peer grant')
  check(peerPublication.peerContribution.ended === undefined, 'peer publication is withdrawn')
  const peerGrant = peerPublication.peerContribution.grant
  check(peerPublication.publishedAt < peerGrant.expiresAt, 'peer publication was admitted after grant expiry')
  equal(peerGrant.taskId, peerPublication.source.taskId, 'peer publication grant differs from its source Task')
  equal([peerGrant.source, peerGrant.maxSamples, peerGrant.maxSampleBytes, peerGrant.expiresAt],
    [{ kind: 'tool-observations', name: 'session-work', tools: ['Write'] }, 8, 8192, projection.expiresAt],
    'peer grant changed its permitted source or limits')
  const peerReport = peerObservation.parse(observation(peerPublication, 'peer'))
  equal({ taskId: peerGrant.taskId, ownerPeerId: peerGrant.ownerPeerId, contributorPeerId: peerGrant.contributorPeerId,
    grantId: peerGrant.grantId, generation: peerGrant.generation,
    captureId: peerGrant.captureId, captureGeneration: peerGrant.captureGeneration },
  projection.peerCapture, 'contribution grant differs from original read capture')
  equal([peerReport.grantId, peerReport.observerPeerId, peerReport.capture.id, peerReport.capture.generation, peerReport.sourceName],
    [peerGrant.grantId, peerGrant.contributorPeerId, peerGrant.captureId, peerGrant.captureGeneration, peerGrant.source.name], 'peer observation attribution differs from grant')
  const bWrite = completedWrite(b, b.manifest.files.shared)
  check(bWrite.callSeq > adopted.seq && bWrite.resultSeq < ended.seq, 'peer shared write is outside its adopted interval')
  check(completedWrite(b, b.manifest.files.afterLeave).callSeq > ended.seq, 'local after-leave write precedes leave')
  equal([peerReport.fields.path, peerReport.fields.content, peerReport.sequence],
    [bWrite.path.slice('project/'.length), bWrite.text, 1], 'peer report differs from source write')
  equal(peerReport.sourceId, sourceId(b, bWrite, peerGrant, 1, 'native-tool'), 'peer sourceId differs from actual execution coordinates')
  const peerSample = peerContributionRequestSchema.parse({ grant: peerGrant, sourceId: peerReport.sourceId,
    sequence: peerReport.sequence, result: result(peerReport) })
  equal(peerPublication.id, peerContributionPublicationId(peerSample), 'peer publicationId differs from exact sample')
  const privateFile = b.manifest.files.private
  check(privateFile !== undefined, 'missing private baseline file')
  check(completedWrite(b, privateFile).resultSeq < planned.seq, 'private work was not completed before joining')
  // Private and shared facts use the same nonce, so inspect the private fact value rather than the role-wide nonce.
  const privateFact = /"([^"]+)"/u.exec(privateFile.text)?.[1]
  check(privateFact !== undefined && a.requests.every(item => !JSON.stringify(item.messages).includes(privateFact)), 'private content leaked to peer')
  noPeerText(a, [0, 1, 2], [b.manifest.files.shared.text])
  noPeerText(b, [0, 1], [a.manifest.files.shared.text])
  for (const index of [5, 6]) {
    const current = request(b, index)
    const scope = message(current, 'scope-agent-context')
    equal(scope.source, withdrawalMessage('left').source, 'leave retained an active scope source')
    equal(scope.content, withdrawalMessage('left').content, 'leave retained old scope body')
    check(current.eventCount > ended.seq, 'post-leave request precedes recorded leave')
    check(current.contextBytes <= 8000, 'post-leave context exceeds 8000 bytes')
    noPeerText(b, [index], [a.manifest.files.shared.text, a.manifest.files.afterLeave.text])
  }
  const afterWrite = completedWrite(a, a.manifest.files.afterLeave)
  const afterSample = localContributionRequestSchema.parse({ grant: localGrant,
    sourceId: sourceId(a, afterWrite, localGrant, 2, 'native-local-tool'), sequence: 2,
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
      fields: { rootIndex: 0, path: afterWrite.path.slice('project/'.length), content: afterWrite.text } } })
  const afterPublicationId = localContributionPublicationId(afterSample)
  const afterLocal = local(request(a, 5))
  const afterSource = { kind: 'publication', taskId: afterLocal.fields.taskId, revision: afterLocal.fields.taskRevision,
    publicationId: afterPublicationId }
  const afterOmissions = afterLocal.fields.omittedSources.filter(item => item.source.kind === 'publication'
    && item.source.publicationId === afterPublicationId)
  const afterSelected = afterLocal.fields.selectedSources.some(item => item.kind === 'publication'
    && item.publicationId === afterPublicationId)
  const afterBody = afterLocal.data.publications.some(item => item.id === afterPublicationId
    || item.source.publicationId === afterPublicationId)
  const ownerAfterAdmissionVerified = afterOmissions.length > 0 || afterSelected || afterBody
  if (ownerAfterAdmissionVerified) {
    check(!afterSelected && !afterBody && afterOmissions.length === 1
      && afterOmissions[0]?.reason === 'self-published' && isDeepStrictEqual(afterOmissions[0].source, afterSource),
    'owner after-leave write lacks exact admitted source')
  }
  const ownerAfterAdmissionEvidence = ownerAfterAdmissionVerified ? 'captured-projection' : 'not-in-captured-request'
  return { localTasks: { A: aLocal.fields.taskId, B: bLocal.fields.taskId },
    directions: { AtoB: { sourceId: localReport.sourceId, publicationId: localPublication.id, callSeq: aWrite.callSeq,
      resultSeq: aWrite.resultSeq, receiveRequest: 2, receiveSourceSeqs: request(b, 2).sourceSeqs },
    BtoA: { sourceId: peerReport.sourceId, publicationId: peerPublication.id, callSeq: bWrite.callSeq,
      resultSeq: bWrite.resultSeq, receiveRequest: 3, receiveSourceSeqs: request(a, 3).sourceSeqs } },
    leave: { adoptionId: planned.value.adoptionId, plannedSeq: planned.seq, adoptedSeq: adopted.seq, endedSeq: ended.seq,
      retainedLocal: plan.retainedLocal, target: plan.target, derivedOwnerAfterPublicationId: afterPublicationId,
      ownerAfterAdmissionVerified, ownerAfterAdmissionEvidence } }
}

/** Verify complete static A/B exports without starting an application or accessing recorded absolute paths.
 * @param options Explicit export directories and optional finite file limits.
 * @returns Material-consistency evidence; physical device and UI provenance remain unverified.
 */
export async function verifyTwoDeviceEvidence(options: { aDirectory: string; bDirectory: string; limits?: ExportLimits }) {
  const limits = exportLimitsSchema.parse(options.limits ?? exportLimits)
  const [aRoot, bRoot] = await exportRoots(options.aDirectory, options.bDirectory)
  const a = await verifyEndpoint(new ExportReader(aRoot, limits), 'A')
  const b = await verifyEndpoint(new ExportReader(bRoot, limits), 'B')
  const pair = verifyPair(a, b)
  return { version: 1 as const, status: 'passed' as const, physicalDevicesVerified: false as const,
    controlledRequests: a.requests.length + b.requests.length, externalModelTrialsVerified: false as const,
    localBaseline: 'join-plan' as const, preJoinUiAssignmentVerified: false as const,
    crossDeviceAfterLeaveOrderVerified: false as const, assurance: 'export-material-consistency' as const,
    ...pair, endpoints: {
      A: { sessionId: a.session.id, requests: a.requests.length, recordedCleanTermination: a.termination, files: a.hashes },
      B: { sessionId: b.session.id, requests: b.requests.length, recordedCleanTermination: b.termination, files: b.hashes },
    } }
}
/** Parse the offline CLI without reading any application configuration.
 * @param args Exact A/B export arguments.
 * @returns The same independently reconstructed report as the API.
 */
export async function runTwoDeviceVerification(args: readonly string[]) {
  const [aFlag, a, bFlag, b] = args
  if (args.length !== 4 || aFlag !== '--a' || bFlag !== '--b' || a === undefined || b === undefined) {
    throw new Error('usage: two-device-verify.ts --a <export-directory> --b <export-directory>')
  }
  return verifyTwoDeviceEvidence({ aDirectory: resolve(a), bDirectory: resolve(b) })
}
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runTwoDeviceVerification(process.argv.slice(2)), null, 2) + '\n') }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1 }
}
