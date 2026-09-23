/** Parsed launcher controls and untouched Web arguments. */
export interface AgentHarnessStartOptions {
  dryRun: boolean
  noOpen: boolean
  rebuild: boolean
  webArgs: string[]
}

/** Parse launcher-only flags and leave Web flags untouched. */
export function parseArguments(args: string[]): AgentHarnessStartOptions

/** Resolve the pnpm executable already running this package script. */
export function pnpmInvocation(
  environment?: NodeJS.ProcessEnv,
  nodeExecutable?: string,
): { command: string; prefix: string[] }

/** Add the single-node product defaults without overriding explicit Web flags. */
export function webArguments(args: string[]): string[]

/** Return the loopback URL corresponding to the requested Web port. */
export function localNodeUrl(args: string[]): string | undefined

/** Select an explicit, durable-log, installation, or newly generated local node id. */
export function resolveNodeId(
  environment?: NodeJS.ProcessEnv,
  host?: string,
  storedNodeId?: string,
  persistedNodeId?: string,
  entropy?: string,
): string

/** Read one valid owner id from the development-room storage document. */
export function storedRoomNodeId(value: unknown): string | undefined

/** Read one valid installation identity record. */
export function storedNodeIdentity(value: unknown): string | undefined

/** Minimal storage document fields retained by standalone-id migration. */
export interface AgentHarnessStorageDocument {
  unit?: { name?: string; version?: number }
  tables?: {
    logs?: Record<string, { entries?: Array<Record<string, unknown> & { nodeId?: string }> }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** Rewrite one legacy standalone storage document to a stable installation id. */
export function migrateStandaloneStorageDocument(
  value: AgentHarnessStorageDocument,
  expectedName: string,
  nodeId: string,
): AgentHarnessStorageDocument | undefined

/** Persist one installation identity and migrate legacy standalone logs before boot. */
export function ensureNodeIdentity(
  environment?: NodeJS.ProcessEnv,
  host?: string,
  entropy?: string,
): Promise<string>

/** Decide whether this source revision needs dependency installation and build. */
export function buildRequired(options: {
  force: boolean
  source: { revision: string; clean: boolean } | undefined
  recordedRevision: string | undefined
  artifactsReady: boolean
}): boolean

/** Resolve the platform browser opener for one loopback URL. */
export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] }
