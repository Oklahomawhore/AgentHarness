export interface PortableReleaseArtifact {
  file: string
  sha256: string
  size: number
}

export interface PortableArchiveInspection {
  path: string
  manifest: Record<string, unknown> & { version: string }
  target: string
  sha256: string
  size: number
}

export function validateReleaseBaseUrl(value: string): string
export function portableTarget(platform: string, architecture: string): string
export function inspectPortableArchive(path: string): Promise<PortableArchiveInspection>
export function renderInstallScript(options: {
  baseUrl: string
  version: string
  artifacts: Record<string, PortableReleaseArtifact>
  clusterSecret?: string
  artifactBaseUrl?: string
}): string
export function renderPowerShellInstallScript(options: {
  baseUrl: string
  version: string
  artifacts: Record<string, PortableReleaseArtifact>
  clusterSecret?: string
  artifactBaseUrl?: string
}): string
export function parseStageArguments(args: string[]): { artifacts: string[]; out: string; baseUrl: string; clusterSecretFile?: string; github?: boolean }
export function stagePortableRelease(options: {
  artifacts: string[]
  out: string
  baseUrl: string
  clusterSecret?: string
  artifactBaseUrl?: string
  clusterSecretFile?: string
  github?: boolean
}): Promise<{
  output: string
  baseUrl: string
  version: string
  credential: { mode: 'prompt' } | { mode: 'embedded'; cluster: { clusterId: string; fingerprint: string } }
  manifest: { formatVersion: number; product: string; version: string; credential: { mode: 'prompt' } | { mode: 'embedded'; cluster: { clusterId: string; fingerprint: string } }; artifacts: Record<string, PortableReleaseArtifact> }
  installers: { shell?: string; powershell?: string }
  installer: string
}>
