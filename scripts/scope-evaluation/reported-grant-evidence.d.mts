/** Independent reported-frame expansion shared by script and SDK evidence consumers. */
/** Expand indexed grants and observations while preserving every literal field and original report text order.
 * @param value - Actual decoded reported payload.
 * @param revision - Recorded reported backend revision.
 * @returns Detached payload with complete grant objects; malformed tables throw.
 */
export function expandReportedGrants(value: unknown, revision: '3' | '4' | '5'): unknown
