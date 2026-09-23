import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'

describe('Emergence Center client entry', () => {
  it('declares every Remote namespace read by the assembled plugin', () => {
    expect(inject).toContain('remote.developmentTaskAssignments')
  })
})
