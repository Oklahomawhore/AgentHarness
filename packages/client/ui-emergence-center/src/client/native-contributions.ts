/** Native source management with exact capture checks and durable-state rereads. */
import type {
  ScopeAgentContributionRequest, ScopeAgentContributionSelection, ScopeAgentContributionStatus,
  ScopeAgentContributionStopRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createContributionDirectory, type ContributionDirectory } from './contribution-directory.ts'

/** Host operations for explicit source permission, independent of receiving. */
export interface NativeContributionPort {
  readonly status: (request: { agentId: SessionId }) => Promise<ScopeAgentContributionStatus>
  readonly request: (request: ScopeAgentContributionRequest) => Promise<ScopeAgentContributionStatus>
  readonly leaveJoin: (request: ScopeAgentContributionStopRequest) => Promise<ScopeAgentContributionStatus>
  readonly stop: (request: ScopeAgentContributionStopRequest) => Promise<ScopeAgentContributionStatus>
}

/** Apply-owned source state and conditional management actions. */
export interface NativeContributionDirectory {
  readonly directory: ContributionDirectory<SessionId, ScopeAgentContributionStatus>
  request(request: ScopeAgentContributionRequest): Promise<void>
  stop(request: ScopeAgentContributionStopRequest): Promise<void>
  leaveJoin(request: ScopeAgentContributionStopRequest): Promise<void>
  changed(agentId: SessionId, revision: number): void
  reset(): void
  dispose(): void
}

function sameCapture(left: ScopeAgentContributionSelection | null, right: ScopeAgentContributionSelection | null): boolean {
  return left === null ? right === null : right !== null
    && left.captureId === right.captureId && left.captureGeneration === right.captureGeneration
}

/**
 * Retain sent-mutation locks through connection resets and refresh after every outcome.
 * @param port - exact native source Host methods with Remote failures unwrapped.
 * @param onError - local diagnostic observer.
 * @returns owned directory; no mutation is automatically retried.
 */
export function createNativeContributionDirectory(
  port: NativeContributionPort, onError: (error: unknown) => void,
): NativeContributionDirectory {
  const revisions = new Map<SessionId, number>()
  const directory = createContributionDirectory<SessionId, ScopeAgentContributionStatus>(async (agentId) => {
    const value = await port.status({ agentId })
    if (value.revision < (revisions.get(agentId) ?? 0)) throw new Error('Native contribution status predates its change notification')
    return value
  }, onError)
  const allowed = (agentId: SessionId, expected: ScopeAgentContributionSelection | null, stopping: boolean): boolean => {
    const entry = directory.getSnapshot()[agentId]
    if (entry?.status !== 'ready' || entry.pending || entry.value === undefined) return false
    const selection = entry.value.capture?.selection ?? entry.value.receivingContinuation?.selection ?? null
    if (!sameCapture(selection, expected)) { directory.invalidate(agentId); return false }
    return stopping || (entry.value.eligibility === 'eligible' && entry.value.receivingContinuation === undefined)
  }
  return {
    directory,
    async request(request) {
      if (!allowed(request.agentId, request.expectedCapture, false)) return
      await directory.mutate(request.agentId, () => port.request(request))
    },
    async stop(request) {
      if (!allowed(request.agentId, request.expectedCapture, true)) return
      await directory.mutate(request.agentId, () => port.stop(request))
    },
    async leaveJoin(request) {
      if (!allowed(request.agentId, request.expectedCapture, true)) return
      await directory.mutate(request.agentId, () => port.leaveJoin(request))
    },
    changed(agentId, revision) {
      if (directory.getSnapshot()[agentId] === undefined) return
      revisions.set(agentId, Math.max(revisions.get(agentId) ?? 0, revision))
      directory.invalidate(agentId)
    },
    reset() { revisions.clear(); directory.reset() },
    dispose() { revisions.clear(); directory.dispose() },
  }
}
