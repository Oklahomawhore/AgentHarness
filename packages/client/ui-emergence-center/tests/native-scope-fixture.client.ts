/** Client-only string-generation invitation and observable fixtures for native scope controls. */
import type { ScopeAgentBindingStatus, ScopeAgentStatusResult, ScopeAgentRemoteBinding, ScopeInvitation } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

export const invitation: ScopeInvitation = {
  version: 1, ownerPeerId: 'owner-peer' as ScopeInvitation['ownerPeerId'], recipientPeerId: 'recipient-peer' as ScopeInvitation['recipientPeerId'],
  ownerAddress: '/ip4/127.0.0.1/tcp/4567/p2p/owner-peer', taskId: 'task-1' as ScopeInvitation['taskId'],
  grantId: 'e8488da3-919b-440c-81b4-8e7d2e3d7c21' as ScopeInvitation['grantId'],
  generation: '8e056326-8c7f-45bb-a241-f3f0b1e58e65' as ScopeInvitation['generation'],
  expiresAt: 4_000_000_000_000, responsibility: 'Frontend orders integration',
}
export const state: ScopeAgentBindingStatus = { version: 1, agentId: 'session-a' as ScopeAgentBindingStatus['agentId'],
  binding: null, automatic: null, mode: 'left', pauseReason: null, usedBudget: 0, lastActivationAt: null, pendingActivation: null }
export const bound: ScopeAgentBindingStatus = { ...state, mode: 'passive', binding: {
  id: 'binding-a' as NonNullable<ScopeAgentBindingStatus['binding']>['id'],
  subscriptionId: 'subscription-a' as ScopeAgentRemoteBinding['subscriptionId'], invitation,
} }
export function observation(value = state, seq = 1): Extract<ScopeAgentStatusResult, { state: unknown }> {
  return { agentId: value.agentId, eligibility: 'eligible', state: value, asOfSeq: seq as Extract<ScopeAgentStatusResult, { state: unknown }>['asOfSeq'],
    readStateSeq: seq as Extract<ScopeAgentStatusResult, { state: unknown }>['readStateSeq'], subscriptionState: value.binding === null ? 'unbound' : 'active', localTask: null }
}
export function observable<T>(initial: T): HostObservable<T> & { set(value: T): void; count(): number } {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { value = next; for (const listener of [...listeners]) listener() }, count: () => listeners.size }
}
