/** Host-only delegation and lifecycle of the installed Task injector. */

export type {} from '@deepseek-ai/cordis'

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** Live Task injector instance; unloading permanently aborts its signal and removes the service. */
export interface DevelopmentTaskContextAdmissionCapability {
  readonly signal: AbortSignal
}

/** Task admission after other pre-step listeners return, before any Task computation or injection. */
export interface DevelopmentTaskContextAdmission {
  readonly agent: Agent
  readonly decision: Extract<PreStepDecision, { kind: 'enter' }>
  /** Actual inbox claims from the turn, excluding context synthesized by pre-step listeners. */
  readonly claimed: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Installed Task injector; managed receivers must retain and recheck its live signal. */
    developmentTaskContextAdmission: DevelopmentTaskContextAdmissionCapability
  }
  interface Events {
    /**
     * Delegate Task admission to one managed local receiver; unhandled requests use passive injection.
     * A managing listener owns the decision without calling next; other listeners must delegate.
     * @param input - actual claims, accepted pre-step decision, Agent, and cancellation.
     * @param next - continue to another listener or the original passive Task consumer.
     * @mode waterfall
     */
    'development-task-context/admit'(input: DevelopmentTaskContextAdmission, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  }
}
