import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { formatPendingTaskCount } from '../src/client/EmergenceCenterPanel.tsx'

const css = readFileSync(new URL('../src/client/EmergenceCenterPanel.module.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('Emergence Center pending Task badge', () => {
  it('renders the fixed 0, 9, 99, and 100 count states', () => {
    expect([0, 9, 99, 100].map(formatPendingTaskCount)).toEqual(['0', '9', '99', '99+'])
  })

  it('keeps the wide badge stable with tabular digits', () => {
    expect(rule('.trigger')).toContain('position: relative')
    expect(rule('.triggerLabel')).toContain('min-width: 0')
    expect(rule('.pendingCount')).toContain('min-width: 24px')
    expect(rule('.pendingCount')).toContain('font-variant-numeric: tabular-nums')
    expect(rule('.pendingCount')).toContain('white-space: nowrap')
  })

  it('anchors 99+ entirely inside the narrow rail button', () => {
    const badge = rule('.rail .pendingCount')
    expect(badge).toContain('top: 1px')
    expect(badge).toContain('right: 1px')
    expect(badge).toContain('max-width: 30px')
    expect(badge).not.toMatch(/(?:top|right):\s*-/u)
  })
})
