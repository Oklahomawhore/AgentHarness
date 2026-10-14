import { describe, expect, it, vi } from 'vitest'
import type { ClaudeScopeSessionKey, ClaudeScopeSessionSummary, ClaudeScopeSetupResult, DevelopmentTaskId } from '@deepseek-ai/dsh-api-remotes/client'
import { createClaudeScopeDirectory, type ClaudeScopePort } from '../src/client/claude-scopes.ts'

const A: ClaudeScopeSessionSummary = { sessionKey: 'a' as ClaudeScopeSessionKey, sessionId: 'claude-a', cwd: '/project', observedAt: 1, ended: false, readRevision: 0 }
const B: ClaudeScopeSessionSummary = { ...A, sessionKey: 'b' as ClaudeScopeSessionKey, sessionId: 'claude-b' }
const TASK = 'task' as DevelopmentTaskId
const PROJECT = { projectPath: '/project', settingsPath: '/project/.claude/settings.local.json', profileName: 'scope-hook' }
const GRANT = { sessionKey: A.sessionKey, taskId: TASK, responsibility: 'API', roots: ['/project'], bashCommands: [] }

function port(overrides: Partial<ClaudeScopePort> = {}): ClaudeScopePort {
  let sessions = [A, B]
  return {
    sessions: async () => sessions,
    setup: async () => ({ ...PROJECT, outcome: 'configured' }),
    projectSetup: async () => ({ ...PROJECT, state: 'configured' }),
    removeSetup: async () => ({ ...PROJECT, outcome: 'removed' }),
    join: async (request) => {
      const session = { ...(request.sessionKey === B.sessionKey ? B : A), taskId: request.taskId, responsibility: request.responsibility }
      sessions = sessions.map(item => item.sessionKey === session.sessionKey ? session : item)
      return session
    },
    leave: async (request) => {
      const session = request.sessionKey === B.sessionKey ? B : A
      sessions = sessions.map(item => item.sessionKey === session.sessionKey ? session : item)
      return session
    },
    ...overrides,
  }
}

describe('Claude scope directory', () => {
  it('deduplicates refresh and rejects an older list after an exact-session join', async () => {
    const read = Promise.withResolvers<readonly ClaudeScopeSessionSummary[]>()
    const sessions = vi.fn().mockImplementationOnce(() => read.promise).mockResolvedValue([{ ...A, taskId: TASK }, B])
    const directory = createClaudeScopeDirectory(port({ sessions }), vi.fn())
    directory.refresh()
    expect(sessions).toHaveBeenCalledOnce()
    await directory.join(GRANT)
    read.resolve([A, B])
    await read.promise
    await vi.waitFor(() => { expect(directory.getSnapshot().sessions).toEqual([{ ...A, taskId: TASK }, B]) })
    directory.dispose()
  })

  it('reads again when an approval event arrives during a stale session read', async () => {
    const stale = Promise.withResolvers<readonly ClaudeScopeSessionSummary[]>()
    const active: ClaudeScopeSessionSummary = { ...A, taskId: TASK, sharingState: 'active' }
    const sessions = vi.fn().mockImplementationOnce(() => stale.promise).mockResolvedValue([active])
    const directory = createClaudeScopeDirectory(port({ sessions }), vi.fn())
    directory.refresh()
    directory.refresh()
    stale.resolve([{ ...A, taskId: TASK, sharingState: 'awaiting-approval' }])
    await vi.waitFor(() => { expect(directory.getSnapshot().sessions).toEqual([active]) })
    expect(sessions).toHaveBeenCalledTimes(2)
    directory.dispose()
  })

  it('keeps independent sessions and a later leave when an older join settles last', async () => {
    const joined = Promise.withResolvers<ClaudeScopeSessionSummary>()
    const directory = createClaudeScopeDirectory(port({
      join: request => request.sessionKey === A.sessionKey ? joined.promise : Promise.resolve({ ...B, taskId: TASK }),
    }), vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('ready') })
    const pending = directory.join(GRANT)
    await directory.join({ ...GRANT, sessionKey: B.sessionKey })
    await directory.leave({ sessionKey: A.sessionKey })
    joined.resolve({ ...A, taskId: TASK })
    await pending
    expect(directory.getSnapshot().sessions).toEqual([A, { ...B, taskId: TASK }])
    directory.dispose()
  })

  it('discards prior connection reads, grants, and setup outcomes after reset', async () => {
    const oldRead = Promise.withResolvers<readonly ClaudeScopeSessionSummary[]>()
    const oldJoin = Promise.withResolvers<ClaudeScopeSessionSummary>()
    const oldSetup = Promise.withResolvers<ClaudeScopeSetupResult>()
    const sessions = vi.fn().mockImplementationOnce(() => oldRead.promise).mockResolvedValue([B])
    const directory = createClaudeScopeDirectory(port({ sessions, join: () => oldJoin.promise, setup: () => oldSetup.promise }), vi.fn())
    const joining = directory.join(GRANT)
    const configuring = directory.setup(PROJECT)
    directory.reset()
    await vi.waitFor(() => { expect(directory.getSnapshot().sessions).toEqual([B]) })
    oldRead.resolve([A])
    oldJoin.resolve({ ...A, taskId: TASK })
    oldSetup.resolve({ ...PROJECT, outcome: 'configured' })
    await Promise.all([oldRead.promise, joining, configuring])
    expect(directory.getSnapshot()).toEqual({ sessions: [B], status: 'ready' })
    directory.dispose()
  })

  it('retains the most recent project operation and removes hooks without changing membership', async () => {
    const setup = Promise.withResolvers<ClaudeScopeSetupResult>()
    const directory = createClaudeScopeDirectory(port({ setup: () => setup.promise }), vi.fn())
    await directory.join(GRANT)
    const pending = directory.setup(PROJECT)
    await directory.projectSetup(PROJECT)
    expect(directory.getSnapshot().project?.state).toBe('configured')
    await directory.removeSetup(PROJECT)
    setup.resolve({ ...PROJECT, outcome: 'configured' })
    await pending
    expect(directory.getSnapshot().project?.state).toBe('not-configured')
    expect(directory.getSnapshot().sessions[0]?.taskId).toBe(TASK)
    directory.dispose()
  })

  it.each(['gateway/service-unavailable', 'gateway/method-unavailable'])('exposes capability absence for %s without logging a session failure', async (code) => {
    const onError = vi.fn()
    const directory = createClaudeScopeDirectory(port({ sessions: async () => { throw Object.assign(new Error('internal'), { code }) } }), onError)
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('unavailable') })
    expect(onError).not.toHaveBeenCalled()
    directory.dispose()
  })

  it('reports read failure and recovers with a refresh', async () => {
    const error = new Error('connection lost')
    const sessions = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([A])
    const onError = vi.fn()
    const directory = createClaudeScopeDirectory(port({ sessions }), onError)
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('error') })
    expect(onError).toHaveBeenCalledWith(error)
    directory.refresh()
    await vi.waitFor(() => { expect(directory.getSnapshot().sessions).toEqual([A]) })
    directory.dispose()
  })

  it('preserves the observed membership on a rejected mutation and suppresses disposed reads', async () => {
    const directory = createClaudeScopeDirectory(port({ join: async () => { throw new Error('denied') } }), vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().sessions).toEqual([A, B]) })
    await expect(directory.join(GRANT)).rejects.toThrow('denied')
    expect(directory.getSnapshot().sessions).toEqual([A, B])
    directory.dispose()
    const read = Promise.withResolvers<readonly ClaudeScopeSessionSummary[]>()
    const late = createClaudeScopeDirectory(port({ sessions: () => read.promise }), vi.fn())
    const listener = vi.fn()
    late.subscribe(listener)
    late.dispose()
    read.resolve([A])
    await read.promise
    expect(listener).not.toHaveBeenCalled()
    expect(late.getSnapshot().sessions).toEqual([])
  })

  it.each([false, true])('invalidates a read issued during a grant until settlement (failure=%s)', async (failure) => {
    const staleRead = Promise.withResolvers<readonly ClaudeScopeSessionSummary[]>()
    const mutation = Promise.withResolvers<ClaudeScopeSessionSummary>()
    const after = failure ? [A, B] : [{ ...A, taskId: TASK }, B]
    const sessions = vi.fn().mockResolvedValueOnce([A, B]).mockImplementationOnce(() => staleRead.promise).mockResolvedValue(after)
    const directory = createClaudeScopeDirectory(port({ sessions, join: () => mutation.promise }), vi.fn())
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('ready') })
    const joining = directory.join(GRANT)
    directory.refresh()
    if (failure) {
      const rejected = expect(joining).rejects.toThrow('failed grant')
      mutation.reject(new Error('failed grant'))
      await rejected
    } else {
      mutation.resolve({ ...A, taskId: TASK })
      await joining
    }
    staleRead.resolve([{ ...A, responsibility: 'obsolete' }])
    await vi.waitFor(() => { expect(sessions).toHaveBeenCalledTimes(3) })
    expect(directory.getSnapshot().sessions).toEqual(after)
    directory.dispose()
  })

  it('isolates throwing subscribers and diagnostics and releases failed reads for retry', async () => {
    const sessions = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([A])
    const onError = vi.fn(() => { throw new Error('broken diagnostic consumer') })
    const directory = createClaudeScopeDirectory(port({ sessions }), onError)
    directory.subscribe(() => { throw new Error('broken subscriber') })
    const observer = vi.fn()
    directory.subscribe(observer)
    await vi.waitFor(() => { expect(directory.getSnapshot().status).toBe('error') })
    expect(observer).toHaveBeenCalledOnce()
    directory.refresh()
    await vi.waitFor(() => { expect(directory.getSnapshot().sessions).toEqual([A]) })
    expect(observer).toHaveBeenCalledTimes(2)
    directory.dispose()
  })

  it('rejects disposed mutations before sending any RPC', async () => {
    const join = vi.fn()
    const setup = vi.fn()
    const directory = createClaudeScopeDirectory(port({ join, setup }), vi.fn())
    directory.dispose()
    await expect(directory.join(GRANT)).rejects.toThrow('disposed')
    await expect(directory.setup(PROJECT)).rejects.toThrow('disposed')
    expect(join).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
  })
})
