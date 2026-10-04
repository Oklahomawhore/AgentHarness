import type { ScopeAgentLocalContributionCapture, ScopeAgentLocalContributionRequest,
  ScopeAgentLocalContributionStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { agentId, capture } from './native-contribution-fixture.client.ts'

type Grant = ScopeAgentLocalContributionCapture['grant']
export const binding = {
  taskId: 'local-task' as Grant['taskId'], bindingId: 'local-binding' as Grant['bindingId'],
  expectedBindingEpoch: { nodeId: 'local-node' as Grant['expectedBindingEpoch']['nodeId'], seq: 4 },
}
export const unbound: ScopeAgentLocalContributionStatus = {
  agentId, participantId: 'agent-participant' as Grant['participantId'], assignment: null,
  eligibility: 'no-local-task', revision: 0, capture: null,
}
export const assigned: ScopeAgentLocalContributionStatus = { ...unbound, eligibility: 'eligible', assignment: binding }
export const localCapture: ScopeAgentLocalContributionCapture = {
  selection: capture.selection, roots: ['/project'], tools: ['write'], state: 'active', collecting: true,
  pendingSamples: 0, issue: null, collectionIssue: null,
  grant: { version: 1, ...binding, participantId: 'agent-participant' as Grant['participantId'],
    ...capture.selection, source: { kind: 'tool-observations', name: 'Native file work', tools: ['Write'] },
    expiresAt: 2100000000000, maxSamples: 8, maxSampleBytes: 4096 },
}
export const localRequest: ScopeAgentLocalContributionRequest = {
  agentId, expectedCapture: null, ...binding, roots: ['/project'], tools: ['write'], limits: capture.limits,
}
export const tasks = [{ id: binding.taskId, objective: 'Improve retry coordination' }]
