/** Bounded final selections demonstrate source fairness without depending on callback order alone. */
import { expect, it } from 'vitest'
import { selectReportedGroups, type ReportedSelectionGroup } from '../src/reported-selection.ts'

interface Publication { readonly id: string; readonly text: string }
type Group = ReportedSelectionGroup<Publication>
function group(id: string, source: string, kind: Group['kind'], publishedAt: number, size = 24): Group {
  return { value: { id, text: '文'.repeat(size) }, source, kind, publishedAt }
}
function frame(publications: readonly Publication[]): string {
  return `<development-task-context>\n${JSON.stringify({ publications })}\n</development-task-context>`
}
function allowance(groups: readonly Group[]): number {
  return Buffer.byteLength(frame(groups.map(item => item.value)), 'utf8')
}
function select(groups: readonly Group[], maxBytes: number) {
  const retained: Publication[] = []
  const attempts = new Map<string, number>()
  selectReportedGroups(groups, (publication) => {
    attempts.set(publication.id, (attempts.get(publication.id) ?? 0) + 1)
    if (Buffer.byteLength(frame([...retained, publication]), 'utf8') > maxBytes) return false
    retained.push(publication)
    return true
  })
  const text = frame(retained)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(maxBytes)
  expect([...attempts.values()].every(count => count === 1)).toBe(true)
  return { ids: retained.map(item => item.id), text, attempts }
}

it('retains complete terminal notices before newer work and skips a terminal that cannot fit', () => {
  const oversized = group('big', 'closed-large', 'terminal', 200, 4096)
  const terminalA = group('ta1', 'closed-a', 'terminal', 2)
  const terminalB = group('tb1', 'closed-b', 'terminal', 1)
  const command = group('cmd', 'live', 'command', 100)
  const result = select([command, terminalB, oversized, terminalA], allowance([terminalA, terminalB]))
  expect(result.ids).toEqual(['ta1', 'tb1'])
  expect(result.text).not.toContain('cmd')
  expect(result.attempts.get('big')).toBe(1)
})

it('keeps a current command from each source before a second newer command from one source', () => {
  const a1 = group('ac1', 'a', 'command', 100)
  const a2 = group('ac2', 'a', 'command', 99)
  const a3 = group('ac3', 'a', 'command', 98)
  const b1 = group('bc1', 'b', 'command', 50)
  const c1 = group('cc1', 'c', 'command', 40)
  const budget = allowance([a1, b1, c1])
  expect(select([a1, a2, a3, b1, c1], budget).ids).toEqual(['ac1', 'bc1', 'cc1'])
  expect(select([a1, a2, a3, b1, c1], budget - 1).ids).toEqual(['ac1', 'bc1'])
})

it('continues within an oversized command source until one group fits, without retrying rejected groups', () => {
  const aBig = group('abg', 'a', 'command', 100, 4096)
  const aFit = group('af1', 'a', 'command', 90)
  const bFit = group('bf1', 'b', 'command', 80)
  const result = select([aBig, aFit, bFit], allowance([aFit, bFit]))
  expect(result.ids).toEqual(['af1', 'bf1'])
  expect(result.attempts).toEqual(new Map([['abg', 1], ['af1', 1], ['bf1', 1]]))
})

it('gives one successful file opportunity only to admitted command sources before remaining file sources', () => {
  const rejectedCommand = group('ac0', 'a', 'command', 110, 4096)
  const acceptedCommand = group('bc1', 'b', 'command', 100)
  const unqualifiedFile = group('af1', 'a', 'file', 90)
  const otherFile = group('cf1', 'c', 'file', 95)
  const oversizedFile = group('bbg', 'b', 'file', 30, 4096)
  const qualifiedFile = group('bf1', 'b', 'file', 20)
  const secondQualifiedFile = group('bf2', 'b', 'file', 10)
  const input = [rejectedCommand, acceptedCommand, unqualifiedFile, otherFile, oversizedFile, qualifiedFile, secondQualifiedFile]
  const result = select(input, allowance([acceptedCommand, qualifiedFile, otherFile]))
  expect(result.ids).toEqual(['bc1', 'bf1', 'cf1'])
  expect(result.attempts.get('ac0')).toBe(1)
  expect(result.attempts.get('bbg')).toBe(1)
  expect(result.text).not.toContain('af1')
  expect(result.text).not.toContain('bf2')
})

it('shares remaining space across file-only and ordinary publication sources', () => {
  const a1 = group('af1', 'a', 'file', 100)
  const a2 = group('af2', 'a', 'file', 99)
  const a3 = group('af3', 'a', 'file', 98)
  const b1 = group('bf1', 'b', 'file', 50)
  const c1 = group('co1', 'c', 'other', 40)
  const publications = [a1, a2, a3, b1, c1]
  expect(select(publications, allowance([a1, b1, c1])).ids).toEqual(['af1', 'bf1', 'co1'])
})

it('reaches a smaller file in the same source before yielding its successful opportunity', () => {
  const aBig = group('abg', 'a', 'file', 100, 4096)
  const aFit = group('af1', 'a', 'file', 99)
  const bFit = group('bf1', 'b', 'other', 98)
  const result = select([aBig, aFit, bFit], allowance([aFit, bFit]))
  expect(result.ids).toEqual(['af1', 'bf1'])
  expect(result.attempts.size).toBe(3)
})

it('uses captured order to break equal timestamps within and between source queues', () => {
  const b1 = group('bf1', 'b', 'file', 10)
  const a1 = group('af1', 'a', 'file', 10)
  const b2 = group('bf2', 'b', 'file', 10)
  const a2 = group('af2', 'a', 'file', 10)
  const c1 = group('cf1', 'c', 'file', 10)
  const input = [b1, a1, b2, a2, c1]
  const before = structuredClone(input)
  const result = select(input, allowance([b1, a1, c1, b2]))
  expect(result.ids).toEqual(['bf1', 'af1', 'cf1', 'bf2'])
  expect(input).toEqual(before)
})

it('does not call admission for an empty captured selection', () => {
  const result = select([], allowance([]))
  expect(result.ids).toEqual([])
  expect(result.attempts.size).toBe(0)
})

it('propagates admission failure without attempting unrelated groups afterward', () => {
  const input = [group('ac1', 'a', 'command', 100), group('bf1', 'b', 'file', 90)]
  const error = new Error('complete renderer failed')
  const retained: Publication[] = []
  const calls: string[] = []
  expect(() => {
    selectReportedGroups(input, (value) => {
      calls.push(value.id)
      if (value.id === 'ac1') throw error
      retained.push(value)
      return true
    })
  }).toThrow(error)
  expect(calls).toEqual(['ac1'])
  expect(retained).toEqual([])
})
