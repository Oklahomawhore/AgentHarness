/** Parsed options for one portable artifact build. */
export interface PortableBuildOptions {
  out: string
  target: string
  runtimeExecutable?: string
  runtimeLicense?: string
  skipBuild: boolean
  dryRun: boolean
}

export function parsePortableArguments(args: string[]): PortableBuildOptions
export function validatePortableOutput(output: string): string
export function portableCommand(command: string, args: string[], platform?: string, pnpmHome?: string): { command: string; args: string[] }
export function verifyPortablePayload(output: string, expectedWorkspacePackages?: readonly string[], target?: string): Promise<void>
export function prunePortableSources(output: string): Promise<void>
export function materializePortableWorkspaceClosure(output: string, target?: string): Promise<void>
export function buildPortable(options: PortableBuildOptions): Promise<{ output: string; archive: string }>
