import type {
  ClaudeScopeJoinRequest,
  ClaudeScopeSessionKey, ClaudeScopeContributionDetail,
  ClaudeScopeLeaveRequest,
  ClaudeScopeSessionSummary,
  ClaudeScopeSetupRequest,
  ClaudeScopeSetupResult,
  ClaudeScopeProjectSetupResult,
  ClaudeScopeRemoveSetupResult,
  DevelopmentTaskApproveObservedIntervalRequest,
  DevelopmentTaskEndObservedIntervalRequest,
  DevelopmentTaskObservedInterval,
  DevelopmentTaskObservedReceipt,
  DevelopmentTaskCreateRequest,
  DevelopmentTaskId,
  DevelopmentTaskPublishContextRequest,
  DevelopmentTaskSnapshot,
  McpClientSetupRequest,
  McpClientSetupResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { McpClientSetupDirectory } from './mcp-clients.ts'
import type { ContributionDirectory } from './contribution-directory.ts'
import type { SourceContributionActions } from './SourceContributionPanel.tsx'
import type { OwnerContributionActions, OwnerContributionValue } from './OwnerContributionPanel.tsx'
import type { ScopeAccessActions } from './ScopeAccessPanel.tsx'
import type { ClaudeScopeDirectory } from './claude-scopes.ts'
import type { ObservedScopeDirectory } from './observed-scopes.ts'
import type { ParticipantDirectory } from './participant-directory.ts'
import type { EmergenceProfile } from './profile.ts'
import type { DevelopmentTaskDirectory } from './task-directory.ts'

/** Business operations and live state injected into the Emergence Center. */
export interface EmergenceCenterPanelFace extends ScopeAccessActions, SourceContributionActions, OwnerContributionActions {
  hooks: {
    participants: ParticipantDirectory
    tasks: DevelopmentTaskDirectory
    mcpClients: McpClientSetupDirectory
    claudeScopes: ClaudeScopeDirectory
    sourceContributions: ContributionDirectory<ClaudeScopeSessionKey, ClaudeScopeContributionDetail>
    ownerContributions: ContributionDirectory<DevelopmentTaskId, OwnerContributionValue>
    observedScopes: ObservedScopeDirectory
  }
  initialProfile: EmergenceProfile
  setProfile(profile: EmergenceProfile): Promise<void>
  focusTask(taskId: DevelopmentTaskId): Promise<void>
  createTask(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskSnapshot>
  publishContext(request: DevelopmentTaskPublishContextRequest): Promise<DevelopmentTaskSnapshot>
  setupClient(request: McpClientSetupRequest): Promise<McpClientSetupResult>
  setupClaudeHooks(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeSetupResult>
  checkClaudeHooks(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeProjectSetupResult>
  removeClaudeHooks(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeRemoveSetupResult>
  joinClaudeScope(request: ClaudeScopeJoinRequest): Promise<ClaudeScopeSessionSummary>
  leaveClaudeScope(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary>
  refreshClaudeScopes(): void
  approveObservedScope(request: DevelopmentTaskApproveObservedIntervalRequest): Promise<DevelopmentTaskObservedInterval>
  endObservedScope(request: DevelopmentTaskEndObservedIntervalRequest): Promise<DevelopmentTaskObservedReceipt>
  refreshObservedScopes(): void
  refresh(): void
}
