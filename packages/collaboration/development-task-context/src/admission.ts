/** Host-only delegation and lifecycle of the installed Task injector. */

export type {} from '@deepseek-ai/cordis'

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** Task injector lifetimes selected by exact registered Agent and listener scope. */
export interface DevelopmentTaskContextAdmissionCapability {
  /**
   * Select the lifecycle of the injector that handles this Agent's admission.
   * @param agent - exact registered Agent whose pre-step needs Task admission.
   * @returns the injector signal, permanently aborted on unload, or undefined outside its registry or listener scope.
   */
  signalFor(agent: Agent): AbortSignal | undefined
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
  /**
   * Select unsubmitted inputs restored by the Task owner on failure or injector unload.
   * @param messages - ordinary claimed inputs retained by the managing receiver.
   */
  retainInput(messages: readonly UserMessage[]): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Installed Task injector; receivers retain and recheck the signal selected for their exact Agent. */
    developmentTaskContextAdmission: DevelopmentTaskContextAdmissionCapability
  }
  interface Events {
    /**
     * Delegate complete context admission; unhandled requests use passive Task injection.
     * Local receivers own Task computation; remote-only receivers compose after next returns.
     * The Task owner rechecks passive input after delegates return and owns failure restoration.
     * @param input - actual claims, accepted pre-step decision, Agent, and cancellation.
     * @param next - continue to another listener or the original passive Task consumer.
     * @mode waterfall
     */
    'development-task-context/admit'(input: DevelopmentTaskContextAdmission, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  }
}
