/** The offline runner rejects ambiguous and accidental live-run invocations. */

import { describe, expect, it } from 'vitest'
import { parseRequest } from './run.ts'

describe('scope evaluation CLI', () => {
  it('requires an explicit fresh output target and reproducible integer seed', () => {
    expect(parseRequest(['--output', '/tmp/scope-study', '--seed', '20261003']))
      .toEqual({ output: '/tmp/scope-study', seed: 20261003 })
    for (const args of [[], ['--live'], ['--output', 'x', '--seed', '-1'],
      ['--output', 'x', '--seed', '1.5'], ['--output', 'x', '--seed', '01'],
      ['--output', 'x', '--seed', '1', '--provider', 'anything']]) {
      expect(() => parseRequest(args)).toThrow()
    }
  })
})
