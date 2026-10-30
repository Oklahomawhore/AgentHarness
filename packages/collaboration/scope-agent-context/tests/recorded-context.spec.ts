/** Recorded shared metadata follows current surface replacement and exact receiving identity. */
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { invitationSchema, projectionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { localContextTargetSchema } from '@deepseek-ai/dsh-development-task-context/local'
import { describe, expect, it } from 'vitest'
import { recordedScopeContext } from '../src/recorded-context.ts'
import { snapshotMessage, withdrawalMessage } from '../src/messages.ts'
import { initialState, stateSchema } from '../src/state.ts'

function fixture(capture = false) {
  const session = Session.create(SessionId(randomUUID()))
  const invitation = invitationSchema.parse({ version: 1, ownerPeerId: 'owner', recipientPeerId: 'reader',
    ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner', taskId: 'task', grantId: randomUUID(), generation: randomUUID(),
    expiresAt: 4_000_000_000_000, responsibility: 'Maintain my own implementation' })
  const originalCapture = { captureId: randomUUID(), captureGeneration: randomUUID() }
  const state = stateSchema.parse({ ...initialState(session.id), version: capture ? 4 : 1, mode: 'passive',
    binding: { id: randomUUID(), subscriptionId: randomUUID(), invitation, ...(capture ? { originalCapture } : {}) } })
  const binding = state.binding
  if (binding === null || binding.kind !== undefined) throw new Error('Expected a remote binding')
  const reasons = ['self-published', 'budget', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant'] as const
  const fields = { taskId: invitation.taskId, taskRevision: 7, ownerPeerId: invitation.ownerPeerId,
    recipientPeerId: invitation.recipientPeerId, grantId: invitation.grantId, grantGeneration: invitation.generation,
    expiresAt: invitation.expiresAt, backend: { id: 'fixture', revision: '1' }, maxContextBytes: 4000,
    text: '已记录的共享内容 🧭', selectedSources: [{ kind: 'task' as const, taskId: invitation.taskId, revision: 7 }],
    omittedSources: reasons.map((reason, index) => ({ reason,
      source: { kind: 'publication' as const, taskId: invitation.taskId, revision: 7, publicationId: `omitted-${index}` } })) }
  const peerCapture = {
    ownerPeerId: invitation.ownerPeerId, contributorPeerId: invitation.recipientPeerId, taskId: invitation.taskId,
    grantId: randomUUID(), generation: randomUUID(), ...originalCapture,
  }
  const complete = capture ? { ...fields, version: 3 as const, activation: { kind: 'exact' as const }, peerCapture } : fields
  const digestFields: unknown[] = [fields.taskId, fields.taskRevision, fields.ownerPeerId, fields.recipientPeerId,
    fields.grantId, fields.grantGeneration, fields.expiresAt, fields.backend.id, fields.backend.revision, fields.maxContextBytes,
    fields.text, [['task', fields.taskId, 7, null]],
    fields.omittedSources.map(item => [['publication', item.source.taskId, 7, item.source.publicationId], item.reason])]
  if (capture) digestFields.push(['scope-access-projection', 3, ['exact']],
    ['peer-capture', peerCapture.ownerPeerId, peerCapture.contributorPeerId, peerCapture.taskId, peerCapture.grantId,
      peerCapture.generation, peerCapture.captureId, peerCapture.captureGeneration])
  const projectionId = createHash('sha256').update(JSON.stringify(digestFields)).digest('hex')
  const projection = projectionSchema.parse({ ...complete, projectionId })
  const message = snapshotMessage(binding, projection, 8000)
  const event = session.append('user/message', message, { surfaceOp: 'append' })
  return { session, binding, projection, message, event, state }
}

describe('recorded shared context metadata', () => {
  it('counts declared source reasons and complete UTF-8 framing without exposing the body or a configured allowance', () => {
    const { session, binding, projection, message, event } = fixture()
    const value = recordedScopeContext(session, binding)
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(value).toEqual({ contextSeq: event.seq, bindingId: binding.id, subscriptionId: binding.subscriptionId,
      sharedBytes: Buffer.byteLength(text, 'utf8'), taskRevision: 7, selectedSourceCount: 1,
      omittedSourceCounts: { 'self-published': 1, budget: 1, unsupported: 1, superseded: 1, withdrawn: 1, 'recipient-irrelevant': 1 } })
    expect(value?.sharedBytes).toBeGreaterThan(Buffer.byteLength(projection.text, 'utf8'))
    expect(value?.sharedBytes).toBeGreaterThan(text.length)
    expect(JSON.stringify(value)).not.toContain(projection.text)
    expect(value).not.toHaveProperty('maxContextBytes')
    expect(value).not.toHaveProperty('turn')
    expect(recordedScopeContext(Session.create(session.id, session.snapshotEvents(), session.header), binding)).toEqual(value)
  })

  it('counts text blocks without including the text carried by another content type', () => {
    const { session, binding, message, event } = fixture()
    const before = recordedScopeContext(session, binding)
    const mixed = createUserMessage({ source: message.source,
      content: [...message.content, { type: 'reasoning', text: 'Non-text content 元数据' }] })
    const replacement = session.append('user/message', mixed, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
    })
    expect(recordedScopeContext(session, binding)).toEqual({ ...before, contextSeq: replacement.seq })
  })

  it('allows redundant withdrawn nodes but refuses two visible snapshots', () => {
    const { session, binding, message } = fixture()
    const before = recordedScopeContext(session, binding)
    session.append('user/message', withdrawalMessage('left'), { surfaceOp: 'append' })
    expect(recordedScopeContext(session, binding)).toEqual(before)
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(recordedScopeContext(session, binding)).toBeNull()
  })

  it.each(['withdrawn', 'unrelated'] as const)('does not recover shadowed snapshot metadata after a %s replacement', (kind) => {
    const { session, binding, event } = fixture()
    const message = kind === 'withdrawn' ? withdrawalMessage('failed')
      : createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated current message' }] })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
    })
    expect(session.eventAt(event.seq)).toEqual(event)
    expect(recordedScopeContext(session, binding)).toBeNull()
  })

  it.each(['taskId', 'ownerPeerId', 'recipientPeerId', 'grantId', 'generation', 'expiresAt'] as const)(
    'does not assign a recorded snapshot to a changed %s', (field) => {
      const { session, binding } = fixture()
      const invitation = invitationSchema.parse({ ...binding.invitation,
        [field]: field === 'expiresAt' ? binding.invitation.expiresAt + 1 : randomUUID() })
      expect(recordedScopeContext(session, { ...binding, invitation })).toBeNull()
    },
  )

  it.each(['id', 'subscriptionId'] as const)('does not reuse metadata after changing the receiving %s', (field) => {
    const { session, binding, state } = fixture()
    const changed = stateSchema.parse({ ...state, binding: { ...binding, [field]: randomUUID() } })
    expect(recordedScopeContext(session, changed.binding)).toBeNull()
    expect(recordedScopeContext(session, null)).toBeNull()
  })

  it('retains exact original-capture metadata without lending it to manual or different-capture bindings', () => {
    const { session, binding, state } = fixture(true)
    expect(recordedScopeContext(session, binding)).not.toBeNull()
    const original = binding.originalCapture
    if (original === undefined) throw new Error('Expected original capture')
    const manual = stateSchema.parse({ ...state, version: 1,
      binding: { id: binding.id, subscriptionId: binding.subscriptionId, invitation: binding.invitation } })
    expect(recordedScopeContext(session, manual.binding)).toBeNull()
    for (const field of ['captureId', 'captureGeneration'] as const) {
      const changed = stateSchema.parse({ ...state,
        binding: { ...binding, originalCapture: { ...binding.originalCapture, [field]: randomUUID() } } })
      expect(recordedScopeContext(session, changed.binding)).toBeNull()
    }
    const plain = fixture()
    expect(recordedScopeContext(plain.session, { ...plain.binding, originalCapture: original })).toBeNull()
  })

  it('keeps combined local responsibility separate from shared snapshot byte accounting', () => {
    const { session, binding, state } = fixture()
    const target = localContextTargetSchema.parse({ taskId: 'local-task', participantId: 'local-participant',
      taskBindingId: 'local-assignment', bindingEpoch: { nodeId: 'local-node', seq: 1 } })
    const combined = stateSchema.parse({ ...state, version: 3, binding: { ...binding, kind: 'local-task-scope', target,
      retainedLocal: { bindingId: randomUUID(), automatic: null } } }).binding
    expect(recordedScopeContext(session, combined)).toEqual(recordedScopeContext(session, binding))
    expect(recordedScopeContext(session, { kind: 'local-task', id: binding.id, target })).toBeNull()
  })
})
