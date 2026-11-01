/** Pin source identities and advance one explicit fixture phase without depending on wall-clock scheduling. */
import { apply as applyTurnIdentities } from '../scope-turn-outcomes/identity-fixture.mjs'
let phase = 0
/** Loader identity. */
export const name = 'mixed-source-snapshot-identities'
/** Select the timestamp phase used for later, independently observed source work. */
export function setPhase(value) { phase = value }
/** Preserve deterministic message identities and restore every process-wide clock change at disposal. */
export function apply(ctx) {
  const originalNow = Date.now
  applyTurnIdentities(ctx)
  const epoch = Date.now()
  Date.now = () => epoch + phase * 1000
  ctx.effect(() => () => { Date.now = originalNow; phase = 0 })
}
