/** Options accepted by the AgentHarness alpha launcher. */
export interface DevelopmentRoomLaunchOptions {
  dryRun: boolean
  help: boolean
  noOpen: boolean
  openAll: boolean
  rebuild: boolean
}

/** One stable node address printed after startup. */
export interface DevelopmentRoomNodeUrl {
  service: string
  role: string
  url: string
}

/** Stable node URLs printed after the Compose health checks pass. */
export const nodeUrls: readonly DevelopmentRoomNodeUrl[]

/** Parse the launcher's closed flag set. */
export function parseArguments(args: string[]): DevelopmentRoomLaunchOptions

/** Parse git-credential's line protocol without logging its values. */
export function parseCredential(output: string): Record<string, string>

/** Build the Compose up arguments for normal reuse or an explicit clean rebuild. */
export function composeUpArguments(options: Pick<DevelopmentRoomLaunchOptions, 'rebuild'>): string[]

/** Decide whether every required service has one healthy container. */
export function allNodesHealthy(containerIds: string[], healthStates: string[]): boolean

/** Resolve the platform command that opens a URL in the default browser. */
export function browserCommand(platform: NodeJS.Platform, url: string): { command: string, args: string[] }
