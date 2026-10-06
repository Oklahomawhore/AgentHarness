/** Exact owner-local Task and execution intervals for client behavior tests. */
import type { ScopeAgentBindingStatus, ScopeAgentLocalTaskTarget, ScopeAgentStatusResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { NativeScopeSnapshot } from '../src/client/native-scopes.ts'
import { binding, localCapture } from './native-local-contribution-fixture.client.ts'
import { state } from './native-scope-fixture.client.ts'

export const target: ScopeAgentLocalTaskTarget = { taskId: binding.taskId, taskBindingId: binding.bindingId,
  expectedBindingEpoch: binding.expectedBindingEpoch }
export const localExecution: ScopeAgentBindingStatus = { ...state, version: 2, mode: 'enabled', usedBudget: 2,
  automatic: { goal: 'Coordinate retry behavior', activationLimit: 5, maxStepsPerTurn: 3, minIntervalMs: 1000 },
  binding: { kind: 'local-task', id: 'execution-local' as NonNullable<ScopeAgentBindingStatus['binding']>['id'],
    target: { taskId: target.taskId, taskBindingId: target.taskBindingId, bindingEpoch: target.expectedBindingEpoch,
      participantId: localCapture.grant.participantId } } }
export function localObservation(value = state, localTask = target): ScopeAgentStatusResult {
  return { agentId: value.agentId, eligibility: value.binding === null ? 'task-conflict' : 'eligible', state: value,
    localTask, readStateSeq: 10 as Extract<ScopeAgentStatusResult, { state: unknown }>['readStateSeq'], asOfSeq: 10 as Extract<ScopeAgentStatusResult, { state: unknown }>['asOfSeq'], subscriptionState: 'unbound', activity: { request: null, completed: null, evaluation: null } }
}
export function localSnapshot(value = state): NativeScopeSnapshot {
  return { phase: 'ready', pending: false, issue: null, observation: localObservation(value) }
}
