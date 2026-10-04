import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh/types'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type {
  DevelopmentNodeId, DevelopmentParticipantId, DevelopmentTaskBindingId, DevelopmentTaskObservedSourceId,
  DevelopmentTaskArtifactId, DevelopmentTaskArtifactGrantId, DevelopmentTaskAdmitRemoteObservedContextResult,
} from '@deepseek-ai/dsh-development-task/types'
import { developmentTaskAdmitRemoteObservedContextResultSchema } from '@deepseek-ai/dsh-development-task/schema'
import DevelopmentTaskMeshService from '@deepseek-ai/dsh-development-task-mesh'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { admitScopeObservation, flushCompletionSamples } from '../src/admission.ts'
import { scopeDigest } from '../src/projection.ts'
import { claudeScopeDomainSpec, type ScopeGrant, type ScopeSession, type ScopeToolLease } from '../src/state.ts'
import type { ClaudeScopeSessionKey } from '../src/types.ts'

const OWNER = 'owner-node' as DevelopmentNodeId
const SOURCE = 'source-node' as DevelopmentNodeId
const PARTICIPANT = 'source-agent' as DevelopmentParticipantId
const BINDING = 'source-binding' as DevelopmentTaskBindingId
const contexts: Context[] = []

class ControlledMesh extends DevelopmentMeshService {
  respond: (payload: unknown) => Promise<unknown> = async () => { throw new Error('fixture transport is not connected') }
  list(): DevelopmentMeshSnapshot {
    return { nodeId: this.ctx.developmentRooms.list().nodeId, clusterId: 'test', secretFingerprint: 'test', peers: [] }
  }
  publish(): void {}
  async command(_ownerNodeId: DevelopmentNodeId, _channel: string, payload: unknown): Promise<unknown> {
    return this.respond(payload)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function node(nodeId: DevelopmentNodeId) {
  const ctx = new Context()
  contexts.push(ctx)
  new DevelopmentRoomService(ctx, { nodeId, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 4096 })
  new DevelopmentTaskService(ctx, {
    maxTasks: 16, maxEventsPerTask: 64, maxMergeParents: 4,
    maxContextBlockBytes: 65536, maxLineageTasks: 16, maxTextBytes: 8192, roomRetryIntervalMs: 10_000,
  })
  const network = new ControlledMesh(ctx)
  await ctx.plugin(DevelopmentTaskMeshService)
  return { ctx, network }
}

async function fixture() {
  const owner = await node(OWNER)
  const source = await node(SOURCE)
  await source.ctx.developmentRooms.announce({ id: PARTICIPANT, kind: 'agent', displayName: 'Source Agent' })
  await owner.ctx.developmentRooms.acceptPresenceReplica(source.ctx.developmentRooms.list().participants[0]!, SOURCE)
  const human = 'owner-human' as DevelopmentParticipantId
  await owner.ctx.developmentRooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Observe work', scope: 'API work', createdBy: human })
  await source.ctx.developmentTasks.acceptLogReplica(owner.ctx.developmentTasks.log()[0]!, OWNER)
  await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId: PARTICIPANT, bindingId: BINDING })
  const bound = source.ctx.developmentTasks.assignmentLog().at(-1)!
  const epoch = { nodeId: SOURCE, seq: bound.seq }
  const interval = await owner.ctx.developmentTasks.approveObservedInterval({
    taskId: task.id, sourceNodeId: SOURCE, participantId: PARTICIPANT, bindingId: BINDING, expectedBindingEpoch: epoch,
  })
  const grant: ScopeGrant = { taskId: task.id, epoch, policy: { revision: 'policy-one', roots: ['/project'], bashCommands: [] },
    responsibility: 'backend', openApiSources: [], remote: { ownerNodeId: OWNER, intervalId: interval.id },
  }
  const session: ScopeSession = { sessionKey: 'session-key' as ClaudeScopeSessionKey, sessionId: 'external-session',
    participantId: PARTICIPANT, bindingId: BINDING, observedAt: 1, ended: false, grant,
  }
  await source.ctx.plugin(Storage)
  const memory = new MemoryStorageBackend(new MemoryMediaPool())
  source.ctx.effect(() => source.ctx.storage.backend.register('memory', memory))
  const facility = new DomainFacility(source.ctx, { backend: 'memory' })
  source.ctx.effect(() => () => facility.closeAll())
  const domain = await facility.open(claudeScopeDomainSpec)
  const installationId = 'installation-one'
  await domain.global.set({ installationId })
  const event = 'PostToolUse' as const
  const toolUseId = 'tool-one'
  const text = '  exact authorized text  '
  const sample = { text,
    sourceId: scopeDigest([installationId, session.sessionId, toolUseId, event, epoch]) as DevelopmentTaskObservedSourceId,
  }
  const lease: ScopeToolLease = { sessionKey: session.sessionKey, taskId: task.id, epoch, policyRevision: grant.policy.revision,
    toolUseId, toolName: 'Write', inputDigest: 'd'.repeat(64), terminal: { event, textDigest: scopeDigest([text]) }, completion: sample,
  }
  await domain.table('leases').put('lease-one', lease)
  const reply = async (payload: unknown) => developmentTaskAdmitRemoteObservedContextResultSchema.parse(
    await owner.ctx.developmentMesh.channel('development-task/v1')!.command!(payload, SOURCE),
  )
  source.network.respond = reply
  return { owner: owner.ctx, ctx: source.ctx, network: source.network, reply, session, grant, domain, sample, lease }
}

type Result = DevelopmentTaskAdmitRemoteObservedContextResult
const wrongResponses: readonly { readonly name: string; readonly change: (value: Result) => unknown }[] = [
  { name: 'Task', change: value => ({ ...value, receipt: { ...value.receipt, taskId: 'another-task' } }) },
  { name: 'owner', change: value => ({ ...value, receipt: { ...value.receipt, ownerNodeId: 'another-owner' } }) },
  { name: 'interval', change: value => ({ ...value, receipt: { ...value.receipt, intervalId: 'b'.repeat(64) } }) },
  { name: 'source', change: value => ({ ...value, receipt: { ...value.receipt, sourceId: 'c'.repeat(64) } }) },
  { name: 'receipt publication', change: value => ({ ...value, receipt: { ...value.receipt, publicationId: 'another-publication' } }) },
  { name: 'event owner', change: value => ({ ...value, receipt: { ...value.receipt, event: { ...value.receipt.event, nodeId: 'another-owner' } } }) },
  { name: 'publication id', change: value => ({ ...value, publication: { ...value.publication, id: 'another-publication' } }) },
  { name: 'publisher', change: value => ({ ...value, publication: { ...value.publication, publishedBy: 'another-agent' } }) },
  { name: 'publication interval', change: value => ({ ...value, publication: { ...value.publication, observedIntervalId: 'b'.repeat(64) } }) },
  { name: 'text', change: value => ({ ...value, publication: { ...value.publication, text: 'different observation' } }) },
  { name: 'withdrawal', change: value => ({ ...value, publication: { ...value.publication, observedIntervalEnded: true } }) },
  { name: 'uri', change: value => ({ ...value, publication: { ...value.publication, uri: 'https://example.invalid/other' } }) },
]

describe('remote observation receipt attribution', () => {
  it.each(wrongResponses)('retains its exact pending tool source after a well-formed wrong $name response', async ({ change }) => {
    const test = await fixture()
    test.network.respond = async payload => change(await test.reply(payload))
    await expect(flushCompletionSamples(test.ctx, test.domain, test.session, test.grant, new AbortController().signal, () => true))
      .rejects.toThrow('does not match')
    expect(test.domain.table('leases').get('lease-one')).toEqual(test.lease)
    expect(test.owner.developmentTasks.get({ taskId: test.grant.taskId }).context).toHaveLength(1)
    test.network.respond = test.reply
    await expect(flushCompletionSamples(test.ctx, test.domain, test.session, test.grant, new AbortController().signal, () => true))
      .resolves.toBe(true)
    const retained = test.domain.table('leases').get('lease-one')!
    expect(retained.completionAdmitted).toBe(true)
    expect(retained.completion?.receipt?.publicationId).toBe(`context-observation-${test.sample.sourceId}`)
    expect(test.owner.developmentTasks.get({ taskId: test.grant.taskId }).context).toHaveLength(1)
  })

  it('rejects a stored publication mismatch and reuses an exact receipt without requesting a replica', async () => {
    const test = await fixture()
    const admitted = await admitScopeObservation(test.ctx, test.session, test.grant, test.sample)
    if (admitted.receipt === undefined) throw new Error('fixture remote receipt missing')
    test.network.respond = async () => { throw new Error('owner offline') }
    await expect(admitScopeObservation(test.ctx, test.session, test.grant, {
      ...test.sample, receipt: { ...admitted.receipt, publicationId: 'another-publication' },
    })).rejects.toThrow('admission receipt does not match')
    await expect(admitScopeObservation(test.ctx, test.session, test.grant, { ...test.sample, receipt: admitted.receipt }))
      .resolves.toEqual({ outcome: 'reused', receipt: admitted.receipt })
  })

  it('compares every returned artifact field with its exact pending sample and Task-stamped source', async () => {
    const test = await fixture()
    const sample = { ...test.sample, observation: {
      kind: 'openapi-artifact' as const, version: 1 as const, artifactId: 'api-one' as DevelopmentTaskArtifactId,
      sourceName: 'Orders API', grantId: 'grant-one' as DevelopmentTaskArtifactGrantId, sequence: 1,
      operation: { method: 'post' as const, path: '/orders' }, state: 'valid' as const, sha256: 'a'.repeat(64),
      facts: { operationId: 'createOrder', requestBodyRequired: true, requiredRequestFields: ['name'], responseStatuses: ['201'], deprecated: false },
    } }
    const original = await admitScopeObservation(test.ctx, test.session, test.grant, sample)
    const variants = [
      { observerNodeId: 'another-observer' }, { sourceId: 'b'.repeat(64) },
      { binding: { id: 'another-binding', epoch: test.grant.epoch } },
      { binding: { id: BINDING, epoch: { ...test.grant.epoch, seq: test.grant.epoch.seq + 1 } } },
      { facts: { ...sample.observation.facts, requestBodyRequired: false } }, { sha256: 'b'.repeat(64) },
    ]
    for (const mutation of variants) {
      test.network.respond = async (payload) => {
        const value = await test.reply(payload)
        return { ...value, publication: { ...value.publication, observation: { ...value.publication.observation, ...mutation } } }
      }
      await expect(admitScopeObservation(test.ctx, test.session, test.grant, sample)).rejects.toThrow('remote publication does not match')
    }
    test.network.respond = test.reply
    await expect(admitScopeObservation(test.ctx, test.session, test.grant, sample))
      .resolves.toEqual({ outcome: 'reused', receipt: original.receipt })
  })
})
