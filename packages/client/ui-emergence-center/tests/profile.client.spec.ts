import { describe, expect, it } from 'vitest'
import { loadEmergenceProfile, saveEmergenceProfile } from '../src/client/profile.ts'

function storage(initial?: string): Storage {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set('dsh.emergence-center.profile.v1', initial)
  return {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(key) ?? null },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(key) },
    setItem(key, value) { values.set(key, value) },
  }
}

describe('Emergence Center browser profile', () => {
  it('creates and retains one opaque browser participant', () => {
    const target = storage()
    const created = loadEmergenceProfile(target, () => 'fixed-uuid')
    expect(created).toEqual({ id: 'human-fixed-uuid', displayName: '' })
    expect(loadEmergenceProfile(target, () => 'unused')).toEqual(created)
  })

  it('replaces corrupt retained data with a blank profile', () => {
    const target = storage('{not-json')
    expect(loadEmergenceProfile(target, () => 'replacement')).toEqual({
      id: 'human-replacement',
      displayName: '',
    })
  })

  it('persists profile edits', () => {
    const target = storage()
    const profile = { id: 'human-jet' as never, displayName: 'Jet' }
    saveEmergenceProfile(target, profile)
    expect(loadEmergenceProfile(target)).toEqual(profile)
  })
})
