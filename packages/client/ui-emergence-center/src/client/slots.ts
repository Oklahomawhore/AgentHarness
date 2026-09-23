import type {
  DevelopmentTaskCreateRequest,
  DevelopmentTaskId,
  DevelopmentTaskPublishContextRequest,
  DevelopmentTaskSnapshot,
  McpClientSetupRequest,
  McpClientSetupResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { McpClientSetupDirectory } from './mcp-clients.ts'
import type { ParticipantDirectory } from './participant-directory.ts'
import type { EmergenceProfile } from './profile.ts'
import type { DevelopmentTaskDirectory } from './task-directory.ts'

/** Business operations and live state injected into the Emergence Center. */
export interface EmergenceCenterPanelFace {
  hooks: {
    participants: ParticipantDirectory
    tasks: DevelopmentTaskDirectory
    mcpClients: McpClientSetupDirectory
  }
  initialProfile: EmergenceProfile
  setProfile(profile: EmergenceProfile): Promise<void>
  focusTask(taskId: DevelopmentTaskId): Promise<void>
  createTask(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskSnapshot>
  publishContext(request: DevelopmentTaskPublishContextRequest): Promise<DevelopmentTaskSnapshot>
  setupClient(request: McpClientSetupRequest): Promise<McpClientSetupResult>
  refresh(): void
}
