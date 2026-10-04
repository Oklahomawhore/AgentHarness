/** The experiment plan preserves paired coverage and never implies executed trials. */

import { describe, expect, it } from 'vitest'
import { planTrials, sha256 } from './plan.ts'

describe('scope study registration', () => {
  it('orders each case and condition once, reproducibly, before execution', () => {
    const plan = planTrials(20261003)
    expect(plan).toHaveLength(20)
    expect(new Set(plan.map(trial => trial.id)).size).toBe(20)
    for (const caseId of ['F1', 'F2', 'F3', 'F4', 'F5']) {
      expect(plan.filter(trial => trial.caseId === caseId).map(trial => trial.condition).sort()).toEqual(['E', 'N', 'R', 'S'])
    }
    expect(planTrials(20261003)).toEqual(plan)
    expect(planTrials(20261004)).not.toEqual(plan)
  })

  it('rejects an unreproducible numeric seed and hashes exact text bytes', () => {
    for (const seed of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => planTrials(seed)).toThrow('seed')
    }
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('abc\n')).not.toBe(sha256('abc'))
  })
})
