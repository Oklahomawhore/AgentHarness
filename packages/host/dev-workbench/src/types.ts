import type { Branded } from '@deepseek-ai/dsh-brand'

/** Human-readable configured identity of one development task. */
export type DevWorkbenchEntryId = Branded<'DevWorkbenchEntryId'>

/** Human-readable configured identity of one browser view. */
export type DevWorkbenchViewId = Branded<'DevWorkbenchViewId'>

/** Public lifecycle of one managed development task. */
export type DevWorkbenchEntryPhase = 'idle' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'

/** HTTP availability reported independently from process lifecycle. */
export type DevWorkbenchReadinessState = 'checking' | 'ready' | 'delayed'

/** Latest readiness observation for one running development task. */
export interface DevWorkbenchReadinessSnapshot {
  readonly url: string
  readonly state: DevWorkbenchReadinessState
  readonly checkedAt?: number
  readonly statusCode?: number
  readonly error?: string
}

/** One browser destination attached to a managed task. */
export interface DevWorkbenchView {
  readonly id: DevWorkbenchViewId
  readonly label: string
  readonly url: string
}

/** Current exit facts for a settled task. */
export interface DevWorkbenchOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
}

/** Current task state exposed to the trusted browser client. */
export interface DevWorkbenchEntrySnapshot {
  readonly id: DevWorkbenchEntryId
  readonly label: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly views: readonly DevWorkbenchView[]
  readonly phase: DevWorkbenchEntryPhase
  readonly readiness?: DevWorkbenchReadinessSnapshot
  readonly pid?: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly outcome?: DevWorkbenchOutcome
  readonly error?: string
  readonly stdout: string
  readonly stderr: string
  readonly stdoutLossy: boolean
  readonly stderrLossy: boolean
  readonly stdoutSpillPath?: string
  readonly stderrSpillPath?: string
}

/** Point-in-time state of every configured development task. */
export interface DevWorkbenchSnapshot {
  readonly entries: readonly DevWorkbenchEntrySnapshot[]
}
