import { contributionEntrySchema } from '@deepseek-ai/dsh-scope-access/schema'
import { describe, expect, it } from 'vitest'
import { contributionEntryMatches, resolveContributionSource } from '../src/contribution-source.ts'
import type { ClaudeScopeContributionSource } from '../src/types.ts'

describe('local Claude contribution selection', () => {
  it('allows Stop reports without roots while refusing file tool collection without selected roots', async () => {
    const source: ClaudeScopeContributionSource = { kind: 'claude-work', tools: [], commands: [], stopReports: true }
    const signal = new AbortController().signal
    expect(await resolveContributionSource(source, [], signal)).toEqual(source)
    await expect(resolveContributionSource({ ...source, tools: ['Write'] }, [], signal))
      .rejects.toThrow('Tool collection requires roots')
    await expect(resolveContributionSource({ ...source, commands: [{ command: 'pnpm test', rootIndex: 1 }] }, ['/project'], signal))
      .rejects.toThrow('Command root is not selected')
  })

  it('normalizes tool and command order without changing their selected root indices', async () => {
    const source: ClaudeScopeContributionSource = { kind: 'claude-work', tools: ['Write', 'Edit'], stopReports: false,
      commands: [{ command: 'z-command', rootIndex: 1 }, { command: 'z-command', rootIndex: 0 }, { command: 'a-command', rootIndex: 0 }] }
    expect(await resolveContributionSource(source, ['/first', '/second'], new AbortController().signal))
      .toEqual({ ...source, tools: ['Edit', 'Write'], commands: [
        { command: 'a-command', rootIndex: 0 }, { command: 'z-command', rootIndex: 0 }, { command: 'z-command', rootIndex: 1 },
      ] })
    expect(source.tools).toEqual(['Write', 'Edit'])
    expect(source.commands[0]).toEqual({ command: 'z-command', rootIndex: 1 })
  })

  it('keeps historical OpenAPI application entries limited to declaration sources', () => {
    const entry = contributionEntrySchema.parse({ version: 1, kind: 'openapi-contribution-entry',
      entryId: '56846085-9ea0-4b99-8a3b-a4ab7af55ad0', taskId: 'task-one', ownerPeerId: 'owner-one',
      ownerAddress: 'https://example.invalid/owner', expiresAt: 1000 })
    expect(contributionEntryMatches(entry, { name: 'orders', method: 'post', path: '/orders', filePath: '/local/api.json' })).toBe(true)
    expect(contributionEntryMatches(entry, { kind: 'tool-observations', tools: ['Write'] })).toBe(false)
    expect(contributionEntryMatches(entry, { kind: 'claude-work', tools: [], commands: [], stopReports: true })).toBe(false)
  })
})
