/** Independent owner pages for grants, single-use entries, and reusable-entry applicants. */
import type {
  DevelopmentTaskId, ScopeAccessIdentity, ScopeContributionInventory, ScopeContributionInventoryRequest,
  ScopeContributionApplications, ScopeContributionApplicationsRequest, ScopeGroupEntries, ScopeGroupEntriesRequest,
  ScopeGroupApplications, ScopeGroupApplicationsRequest, ScopeGroupEntryStatus,
} from '@deepseek-ai/dsh-api-remotes/client'

/** One reusable entry and its independently paged applicants. */
export interface OwnerGroupValue {
  readonly group: ScopeGroupEntryStatus
  readonly applications: ScopeGroupApplications
}

/** Owner-local inventories with the currently advertised addresses. */
export interface OwnerContributionValue {
  readonly identity: ScopeAccessIdentity
  readonly inventory: ScopeContributionInventory
  readonly applications: ScopeContributionApplications
  readonly groups: {
    readonly entries: readonly OwnerGroupValue[]
    readonly nextEntryId: ScopeGroupEntries['nextEntryId']
  }
}

/** Read-only owner methods; mutation settlement belongs to the shared contribution directory. */
export interface OwnerContributionPort {
  readonly identity: () => Promise<ScopeAccessIdentity>
  readonly contributionInventory: (request: ScopeContributionInventoryRequest) => Promise<ScopeContributionInventory>
  readonly contributionApplications: (request: ScopeContributionApplicationsRequest) => Promise<ScopeContributionApplications>
  readonly groupEntries: (request: ScopeGroupEntriesRequest) => Promise<ScopeGroupEntries>
  readonly groupApplications: (request: ScopeGroupApplicationsRequest) => Promise<ScopeGroupApplications>
}

/**
 * Read one bounded page from each unfinished owner inventory without conflating entry and applicant identities.
 * @param port - authenticated owner queries.
 * @param taskId - currently selected owned Task.
 * @param previous - retained pages for explicit load-more; omission refreshes all first pages.
 * @returns independent cursors and members keyed by their owner-assigned application identity.
 */
export async function readOwnerContributions(port: OwnerContributionPort, taskId: DevelopmentTaskId,
  previous?: OwnerContributionValue): Promise<OwnerContributionValue> {
  const [identity, grantPage, applicationPage, groupPage] = await Promise.all([
    port.identity(),
    previous?.inventory.nextGrantId === null ? undefined : port.contributionInventory({
      taskId, ...(previous?.inventory.nextGrantId == null ? {} : { afterGrantId: previous.inventory.nextGrantId }),
    }),
    previous?.applications.nextEntryId === null ? undefined : port.contributionApplications({
      taskId, ...(previous?.applications.nextEntryId == null ? {} : { afterEntryId: previous.applications.nextEntryId }),
    }),
    previous?.groups.nextEntryId === null ? undefined : port.groupEntries({
      taskId, ...(previous?.groups.nextEntryId == null ? {} : { afterEntryId: previous.groups.nextEntryId }),
    }),
  ])
  const grants = new Map(previous?.inventory.entries.map(item => [item.grant.grantId, item]))
  for (const item of grantPage?.entries ?? []) grants.set(item.grant.grantId, item)
  const applications = new Map(previous?.applications.entries.map(item => [item.entry.entryId, item]))
  for (const item of applicationPage?.entries ?? []) applications.set(item.entry.entryId, item)
  const groups = new Map(previous?.groups.entries.map(item => [item.group.entry.entryId, item.group]))
  for (const item of groupPage?.entries ?? []) groups.set(item.entry.entryId, item)
  const priorGroups = new Map(previous?.groups.entries.map(item => [item.group.entry.entryId, item.applications]))
  const entries = await Promise.all([...groups.values()].map(async (group): Promise<OwnerGroupValue> => {
    const prior = priorGroups.get(group.entry.entryId)
    if (prior?.nextApplicationId === null) return { group, applications: prior }
    const page = await port.groupApplications({ entryId: group.entry.entryId,
      ...(prior?.nextApplicationId == null ? {} : { afterApplicationId: prior.nextApplicationId }) })
    const members = new Map(prior?.entries.map(item => [item.applicationId, item]))
    for (const item of page.entries) members.set(item.applicationId, item)
    return { group, applications: { entries: [...members.values()], nextApplicationId: page.nextApplicationId } }
  }))
  return { identity,
    inventory: { entries: [...grants.values()],
      nextGrantId: grantPage === undefined ? previous?.inventory.nextGrantId ?? null : grantPage.nextGrantId },
    applications: { entries: [...applications.values()],
      nextEntryId: applicationPage === undefined ? previous?.applications.nextEntryId ?? null : applicationPage.nextEntryId },
    groups: { entries, nextEntryId: groupPage === undefined ? previous?.groups.nextEntryId ?? null : groupPage.nextEntryId },
  }
}
