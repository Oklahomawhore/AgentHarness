export const MESH_SECRET_REF: 'AGENTHARNESS_MESH_SECRET'
export interface ClusterDescription { clusterId: string; fingerprint: string }
export interface ClusterCredential extends ClusterDescription { secret: string; source: 'environment' | 'credentials-file' }
export function harnessHome(environment?: NodeJS.ProcessEnv): string
export function validateClusterSecret(value: unknown): string
export function describeClusterSecret(value: string): ClusterDescription
export function readClusterCredential(environment?: NodeJS.ProcessEnv): Promise<ClusterCredential | undefined>
export function ensureClusterCredential(environment?: NodeJS.ProcessEnv): Promise<ClusterCredential>
export function joinCluster(secret: string, options?: { environment?: NodeJS.ProcessEnv; replace?: boolean }): Promise<ClusterDescription & { changed: boolean; source: string }>
