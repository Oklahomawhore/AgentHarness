/** Stable ids of AI clients recognized by the AgentHarness setup registry. */
export type McpClientId =
  | 'cursor'
  | 'codex'
  | 'claude-code'
  | 'workbuddy'
  | 'codebuddy'
  | 'trae'
  | 'doubao'

/** How AgentHarness can register its bridge with one client. */
export type McpClientSetupMechanism = 'json' | 'cli' | 'manual'

/** Current safe-to-report configuration state. */
export type McpClientSetupState =
  | 'configured'
  | 'not-configured'
  | 'conflict'
  | 'manual'
  | 'not-installed'
  | 'failed'

/** Result of the latest requested setup operation. */
export type McpClientSetupOutcome =
  | 'configured'
  | 'already-configured'
  | 'conflict'
  | 'manual'
  | 'not-installed'
  | 'failed'

/** Public detection and setup state for one client. */
export interface McpClientSnapshot {
  readonly id: McpClientId
  readonly label: string
  readonly detected: boolean
  readonly mechanism: McpClientSetupMechanism
  readonly state: McpClientSetupState
  readonly canSetup: boolean
  readonly participantId: string
  readonly displayName: string
  readonly restartRequired: boolean
  readonly configPath?: string
  readonly detail?: string
}

/** Complete point-in-time client registry. */
export interface McpClientSetupSnapshot {
  readonly clients: readonly McpClientSnapshot[]
}

/** Browser request to configure one supported client. */
export interface McpClientSetupRequest {
  readonly clientId: McpClientId
  readonly displayName?: string
}

/** Exact result of one client setup attempt plus its refreshed state. */
export interface McpClientSetupResult {
  readonly outcome: McpClientSetupOutcome
  readonly client: McpClientSnapshot
}
