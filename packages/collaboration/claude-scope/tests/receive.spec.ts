import type { ScopeAccessProjection as AccessProjection } from '@deepseek-ai/dsh-scope-access/types'
import { afterEach, expect, it, vi } from 'vitest'
import { receivedScopeProjection } from '../src/receive.ts'
import type { ScopeReceive, ScopeSession } from '../src/state.ts'

const receive: ScopeReceive = {
  subscriptionId: 'subscription-fixture' as ScopeReceive['subscriptionId'], generation: 'local-generation' as ScopeReceive['generation'],
  taskId: 'task-fixture' as ScopeReceive['taskId'], ownerPeerId: 'owner-peer' as ScopeReceive['ownerPeerId'],
  grantId: 'grant-fixture' as ScopeReceive['grantId'], grantGeneration: 'grant-generation' as ScopeReceive['grantGeneration'],
  expiresAt: 10000, status: 'pending',
}
const session: ScopeSession & { readonly receive: ScopeReceive } = {
  sessionKey: 'recipient-key' as ScopeSession['sessionKey'], sessionId: 'private-session',
  participantId: 'recipient' as ScopeSession['participantId'], bindingId: 'binding' as ScopeSession['bindingId'],
  observedAt: 1, ended: false, receive,
}
const projection: AccessProjection = {
  projectionId: 'owner-projection' as AccessProjection['projectionId'], taskId: receive.taskId, taskRevision: 4,
  ownerPeerId: receive.ownerPeerId, recipientPeerId: 'recipient-peer' as AccessProjection['recipientPeerId'],
  grantId: receive.grantId, grantGeneration: receive.grantGeneration, expiresAt: receive.expiresAt,
  backend: { id: 'text', revision: '3' }, maxContextBytes: 2000,
  text: 'The current required field is displayName. 界',
  selectedSources: [{ kind: 'task', taskId: receive.taskId, revision: 4 }], omittedSources: [],
}
afterEach(() => { vi.restoreAllMocks() })

it('retains exact independent context and distinct offline, revoked, and expired notices', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100)
  const active = receivedScopeProjection(session, { status: 'active', projection }, 4000)
  const retained = { ...session, lastProjectionId: active.projectionId }
  for (const status of ['unavailable', 'revoked', 'expired', 'left'] as const) {
    const suspended = receivedScopeProjection(retained, { status }, 4000)
    expect(suspended.kind).toBe('suspended')
    expect(suspended.selectedSources).toEqual([])
    expect(suspended.text).not.toContain('displayName')
    await expect(suspended.text + '\n').toMatchFileSnapshot(new URL(`./expected/receive-${status}.txt`, import.meta.url).pathname)
  }
  await expect(active.text + '\n').toMatchFileSnapshot(new URL('./expected/receive-active.txt', import.meta.url).pathname)
  expect(active.text).not.toContain('private-session')
})

it('checks expiry after owner authorization and measures the complete UTF-8 frame', () => {
  vi.spyOn(Date, 'now').mockReturnValue(100)
  const active = receivedScopeProjection(session, { status: 'active', projection }, 4000)
  const bytes = Buffer.byteLength(active.text)
  expect(receivedScopeProjection(session, { status: 'active', projection }, bytes).text.length).toBeGreaterThan(0)
  expect(() => receivedScopeProjection(session, { status: 'active', projection }, bytes - 1)).toThrow('complete Hook budget')
  vi.spyOn(Date, 'now').mockReturnValue(10001)
  const expired = receivedScopeProjection(session, { status: 'active', projection }, 4000)
  expect(expired.receive?.status).toBe('expired')
  expect(expired.text).not.toContain('displayName')
})
