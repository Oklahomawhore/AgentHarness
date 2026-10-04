/** Preregistered trial ordering and evidence labels for the scope collaboration study. */

import { createHash } from 'node:crypto'

/** One paired frontend/QA case; dry runs are never counted as these trials. */
export interface PlannedTrial {
  readonly id: string
  readonly caseId: 'F1' | 'F2' | 'F3' | 'F4' | 'F5'
  readonly condition: 'N' | 'E' | 'S' | 'R'
}

/** Conditions share authorization, admission timing, and complete context byte limits. */
export const conditions = {
  N: 'No shared update',
  E: 'Original admitted publication projection (production text v5)',
  S: 'One shared summary',
  R: 'Recipient-specific facts',
} as const

/** Stable content digest; no credential or ambient file discovery occurs here.
 * @param content Exact UTF-8 bytes represented by a string.
 * @returns Lowercase SHA-256 hex digest.
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Generate a reproducible order without running or scoring any model trial.
 * @param seed Nonnegative safe integer recorded before execution.
 * @returns All twenty case/condition pairs in seeded order.
 */
export function planTrials(seed: number): PlannedTrial[] {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a nonnegative safe integer')
  const caseIds = ['F1', 'F2', 'F3', 'F4', 'F5'] as const
  const conditionIds = ['N', 'E', 'S', 'R'] as const
  return caseIds.flatMap(caseId => conditionIds.map(condition => ({
    id: `${caseId}-${condition}`, caseId, condition,
  }))).sort((left, right) => {
    const a = sha256(`${seed}:${left.id}`)
    const b = sha256(`${seed}:${right.id}`)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** Live trials remain unregistered until every listed dependency has evidence. */
export const liveTrialRequirements = [
  'Named dsh profiles with real native Sessions and the production source/contribution pipeline',
  'Identical authorized observations, natural request admission, and byte budgets for N/E/S/R',
  'OS-isolated execution of unreviewed model artifacts with oracle and other projects inaccessible',
  'Frozen provider/model/reasoning/prompts plus per-session token, time, and monetary limits',
  'Actual request, tool, usage, projection, failure, and human-intervention evidence capture',
  'F4 authorized semantic-equivalence updates and responsibility routing verified through the production pipeline',
] as const
