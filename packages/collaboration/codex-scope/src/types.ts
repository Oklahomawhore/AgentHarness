/** Authenticated management and hook inputs for externally owned Codex conversations. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ScopeInvitation } from '@deepseek-ai/dsh-scope-access/types'
import type { ExternalScopeReceive } from '@deepseek-ai/dsh-scope-access/receiving'

/** Installation-local identity of one Codex logical receiving scope. */
export type CodexScopeSessionKey = Branded<'CodexScopeSessionKey'>
/** Stable identity of the configured Codex client installation. */
export type CodexScopeClientId = Branded<'CodexScopeClientId'>

/** One observed Codex session; observation alone grants no receiving permission. */
export interface CodexScopeSessionSummary {
  readonly sessionKey: CodexScopeSessionKey
  readonly clientId: CodexScopeClientId
  readonly sessionId: string
  readonly cwd?: string | undefined
  readonly observedAt: number
  readonly readRevision: number
  readonly receiveSubscriptionId?: ExternalScopeReceive['subscriptionId'] | undefined
  readonly receiveTaskId?: ExternalScopeReceive['taskId'] | undefined
  readonly receiveState?: ExternalScopeReceive['status'] | undefined
}

/** Explicit receiving consent at the displayed local selection revision. */
export interface CodexScopeReceiveRequest {
  readonly sessionKey: CodexScopeSessionKey
  readonly expectedReadRevision: number
  readonly invitation: ScopeInvitation
}

/** Stop only the receiving selection displayed to the caller. */
export interface CodexScopeLeaveRequest {
  readonly sessionKey: CodexScopeSessionKey
  readonly expectedReadRevision: number
}

/** Codex supplies its parent's session ID to descendant hooks; that ID selects their shared receiving scope. */
export interface CodexScopeHookRequest {
  readonly clientId: CodexScopeClientId
  readonly sessionId: string
  readonly cwd: string
  readonly event: 'UserPromptSubmit' | 'PostToolUse'
}

/** Prepared hook text; Codex separately owns model admission and conversation history. */
export interface CodexScopeHookResult {
  readonly output: {
    readonly hookSpecificOutput?: {
      readonly hookEventName: CodexScopeHookRequest['event']
      readonly additionalContext: string
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A local receiving scope changed after durable persistence.
     * @param sessionKey - external scope whose authenticated inventory can be refreshed.
     * @mode emit
     */
    'codex-scope/session-changed'(sessionKey: CodexScopeSessionKey): void
  }
}
