import type {
  ScopeAgentContributionCapture, ScopeAgentContributionRequest, ScopeAgentContributionStatus, ScopeContributionEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const agentId = 'native-source' as SessionId
export const applicationEntry = {
  version: 1, kind: 'contribution-entry', sourceKind: 'tool-observations',
  entryId: 'entry-a' as ScopeContributionEntry['entryId'], taskId: 'task-a' as ScopeContributionEntry['taskId'],
  ownerPeerId: 'owner-peer' as ScopeContributionEntry['ownerPeerId'],
  ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner-peer', expiresAt: 2100000000000,
} satisfies ScopeContributionEntry
export const capture: ScopeAgentContributionCapture & { readonly entry: typeof applicationEntry } = {
  routeRevision: 0,
  selection: {
    captureId: 'capture-a' as ScopeAgentContributionCapture['selection']['captureId'],
    captureGeneration: 'generation-a' as ScopeAgentContributionCapture['selection']['captureGeneration'],
  },
  proposal: {
    contributorPeerId: 'source-peer' as ScopeAgentContributionCapture['proposal']['contributorPeerId'],
    captureId: 'capture-a' as ScopeAgentContributionCapture['selection']['captureId'],
    captureGeneration: 'generation-a' as ScopeAgentContributionCapture['selection']['captureGeneration'],
    source: { kind: 'tool-observations', name: 'Native file work', tools: ['Write', 'Edit'] },
  },
  roots: ['/project'], tools: ['write', 'edit'], entry: applicationEntry,
  limits: { expiresAt: 2090000000000, maxSamples: 8, maxSampleBytes: 4096 },
  invitation: null, receiving: null, state: 'prepared', collecting: false, application: 'waiting', issue: null, collectionIssue: null, pendingSamples: 0,
}
export const emptyStatus: ScopeAgentContributionStatus = { agentId, eligibility: 'eligible', revision: 0, capture: null }
export const capturedStatus: ScopeAgentContributionStatus = { ...emptyStatus, revision: 1, capture }
export const request: ScopeAgentContributionRequest = {
  agentId, expectedCapture: null, entry: applicationEntry, roots: ['/project'], tools: ['write'], limits: capture.limits,
}
