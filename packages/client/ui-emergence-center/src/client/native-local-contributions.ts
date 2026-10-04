/** Owner-local capture management with observed binding and capture checks. */
import type {
  DevelopmentTaskCheckoutRequest, DevelopmentTaskId, ScopeAgentContributionSelection,
  ScopeAgentContributionStopRequest, ScopeAgentLocalContributionRequest, ScopeAgentLocalContributionStatus,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createContributionDirectory, type ContributionDirectory } from './contribution-directory.ts'

/** Existing Task checkout and local capture methods, with Remote failures unwrapped. */
export interface NativeLocalContributionPort {
  readonly status: (request: { agentId: SessionId }) => Promise<ScopeAgentLocalContributionStatus>
  readonly checkout: (request: DevelopmentTaskCheckoutRequest) => Promise<unknown>
  readonly request: (request: ScopeAgentLocalContributionRequest) => Promise<unknown>
  readonly stop: (request: ScopeAgentContributionStopRequest) => Promise<unknown>
}

/** Owned local observations and commands using the last confirmed capture and binding. */
export interface NativeLocalContributionDirectory {
  readonly directory: ContributionDirectory<SessionId, ScopeAgentLocalContributionStatus>
  checkout(agentId: SessionId, taskId: DevelopmentTaskId): Promise<void>
  request(request: ScopeAgentLocalContributionRequest): Promise<void>
  stop(request: ScopeAgentContributionStopRequest): Promise<void>
  changed(agentId: SessionId, revision?: number): void
  assignmentsChanged(): void
  reset(): void
  dispose(): void
}

function sameCapture(left: ScopeAgentContributionSelection | null, right: ScopeAgentContributionSelection | null): boolean {
  return left === null ? right === null : right !== null
    && left.captureId === right.captureId && left.captureGeneration === right.captureGeneration
}

/**
 * Reread authority after all local management outcomes; never retry a sent command automatically.
 * @param port - Host methods that enforce live Agent and durable binding checks.
 * @param onError - isolated local diagnostic observer.
 * @returns an owned observable and guarded commands.
 */
export function createNativeLocalContributionDirectory(
  port: NativeLocalContributionPort, onError: (error: unknown) => void,
): NativeLocalContributionDirectory {
  const revisions = new Map<SessionId, number>()
  const directory = createContributionDirectory<SessionId, ScopeAgentLocalContributionStatus>(async (agentId) => {
    const value = await port.status({ agentId })
    if (value.revision < (revisions.get(agentId) ?? 0)) throw new Error('Local contribution status predates its change notification')
    return value
  }, onError)
  const observed = (agentId: SessionId): ScopeAgentLocalContributionStatus | undefined => {
    const entry = directory.getSnapshot()[agentId]
    return entry?.status === 'ready' && !entry.pending ? entry.value : undefined
  }
  return {
    directory,
    async checkout(agentId: SessionId, taskId: DevelopmentTaskId): Promise<void> {
      const value = observed(agentId)
      if (value === undefined || value.participantId === null || value.assignment !== null || value.capture !== null
        || value.eligibility !== 'no-local-task') return
      const participantId = value.participantId
      await directory.mutate(agentId, () => port.checkout({ taskId, participantId }))
    },
    async request(request: ScopeAgentLocalContributionRequest): Promise<void> {
      const value = observed(request.agentId)
      if (value === undefined || value.eligibility !== 'eligible') return
      const assignment = value.assignment
      if (!sameCapture(value.capture?.selection ?? null, request.expectedCapture) || assignment === null
        || assignment.taskId !== request.taskId || assignment.bindingId !== request.bindingId
        || assignment.expectedBindingEpoch.nodeId !== request.expectedBindingEpoch.nodeId
        || assignment.expectedBindingEpoch.seq !== request.expectedBindingEpoch.seq) {
        directory.invalidate(request.agentId)
        return
      }
      await directory.mutate(request.agentId, () => port.request(request))
    },
    async stop(request: ScopeAgentContributionStopRequest): Promise<void> {
      const value = observed(request.agentId)
      if (value === undefined) return
      if (!sameCapture(value.capture?.selection ?? null, request.expectedCapture)) {
        directory.invalidate(request.agentId)
        return
      }
      await directory.mutate(request.agentId, () => port.stop(request))
    },
    changed(agentId: SessionId, revision?: number): void {
      if (directory.getSnapshot()[agentId] === undefined) return
      if (revision !== undefined) revisions.set(agentId, Math.max(revisions.get(agentId) ?? 0, revision))
      directory.invalidate(agentId)
    },
    assignmentsChanged(): void {
      for (const agentId of Object.keys(directory.getSnapshot()) as SessionId[]) directory.invalidate(agentId)
    },
    reset(): void { revisions.clear(); directory.reset() },
    dispose(): void { revisions.clear(); directory.dispose() },
  }
}
