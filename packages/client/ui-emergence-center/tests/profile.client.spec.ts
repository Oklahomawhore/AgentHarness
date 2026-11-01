import { describe, expect, it, vi } from 'vitest'
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

  it.each([null, 'old-profile', {}, { id: 'Human Jet', displayName: 'Jet' },
    { id: 'human-jet', displayName: 7 }])('replaces invalid browser JSON %j with a persistable identity', (value) => {
    const target = storage(JSON.stringify(value))
    const created = loadEmergenceProfile(target, () => 'replacement')
    expect(created).toEqual({ id: 'human-replacement', displayName: '' })
    expect(loadEmergenceProfile(target, () => 'unused')).toEqual(created)
  })

  it('still supplies a new identity when browser policy denies preference reads and writes', () => {
    const denied = new Error('storage denied')
    const target = {
      getItem: vi.fn(() => { throw denied }),
      setItem: vi.fn(() => { throw denied }),
    }
    const created = loadEmergenceProfile(target, () => 'private-window')
    expect(created).toEqual({ id: 'human-private-window', displayName: '' })
    expect(() => { saveEmergenceProfile(target, { ...created, displayName: 'Jet' }) }).toThrow(denied)
  })

  it('persists profile edits', () => {
    const target = storage()
    const profile = { id: 'human-jet' as never, displayName: 'Jet' }
    saveEmergenceProfile(target, profile)
    expect(loadEmergenceProfile(target)).toEqual(profile)
  })
})
