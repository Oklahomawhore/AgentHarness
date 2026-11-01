import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import CodexScopeService from '../src/index.ts'
import type { CodexScopeClientId } from '../src/types.ts'

// Stable authority identities keep the complete prepared output reproducible without normalizing it.
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>()
  let sequence = 0
  return { ...crypto, randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` }
})
afterEach(cleanup)

it('records exact real-authority Codex hook output and its later termination notice', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const owner = await host('snapshot-owner')
  const recipient = await host('snapshot-recipient')
  await recipient.ctx.plugin(CodexScopeService, { maxSessions: 2, maxProjections: 4, maxContextBytes: 4096 })
  const service = recipient.ctx.codexScope
  const request = { clientId: 'snapshot-client' as CodexScopeClientId, sessionId: 'private-root-session',
    cwd: process.cwd(), event: 'UserPromptSubmit' as const }
  const signal = new AbortController().signal
  expect(await service.hook(request, signal)).toEqual({ output: {} })
  const task = await owner.createTask('Frontend must send displayName')
  const invitation = await owner.access.invite({ taskId: task.id, recipientPeerId: peer('snapshot-recipient'),
    ownerAddress: (await owner.access.identity()).addresses[0]!, expiresAt: 50_000, responsibility: 'frontend' })
  const observed = (await service.sessions())[0]!
  await service.receive({ sessionKey: observed.sessionKey, expectedReadRevision: 0, invitation })
  const active = await service.hook(request, signal)
  await expect(JSON.stringify(active, null, 2) + '\n')
    .toMatchFileSnapshot(fileURLToPath(new URL('./expected/active.json', import.meta.url)))
  await service.receiveLeave({ sessionKey: observed.sessionKey, expectedReadRevision: 1 })
  const stopped = await service.hook({ ...request, event: 'PostToolUse' }, signal)
  await expect(JSON.stringify(stopped, null, 2) + '\n')
    .toMatchFileSnapshot(fileURLToPath(new URL('./expected/left.json', import.meta.url)))
})
