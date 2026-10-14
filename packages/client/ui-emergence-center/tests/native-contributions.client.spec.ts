import { describe, expect, it, vi } from 'vitest'
import type { ScopeAgentContributionStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { createNativeContributionDirectory, type NativeContributionPort } from '../src/client/native-contributions.ts'
import { agentId, capture, capturedStatus, emptyStatus, request } from './native-contribution-fixture.client.ts'

function fixture(status: NativeContributionPort['status'] = vi.fn(async () => emptyStatus)) {
  const port: NativeContributionPort = {
    recoverRoute: vi.fn(async () => capturedStatus), status, leaveJoin: vi.fn(async () => emptyStatus),
    request: vi.fn(async () => capturedStatus), stop: vi.fn(async () => emptyStatus),
  }
  return { port, source: createNativeContributionDirectory(port, vi.fn()) }
}

describe('native contribution management', () => {
  it('retains a sent request lock across reset and recovers committed state after a lost reply', async () => {
    let authority = emptyStatus
    const pending = Promise.withResolvers<ScopeAgentContributionStatus>()
    const { source, port } = fixture(vi.fn(async () => authority))
    vi.mocked(port.request).mockReturnValue(pending.promise)
    try {
      await source.directory.refresh(agentId)
      const sent = source.request(request)
      source.reset(); await source.directory.refresh(agentId)
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ status: 'ready', pending: true, value: emptyStatus })
      await source.request(request)
      expect(port.request).toHaveBeenCalledOnce()
      authority = capturedStatus
      pending.reject(new Error('reply lost'))
      await sent
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ status: 'ready', pending: false, value: capturedStatus })
      await source.request(request)
      expect(port.request).toHaveBeenCalledOnce()
    } finally { source.dispose() }
  })

  it('drops a delayed read after a change and refreshes same-revision live eligibility', async () => {
    const pending = Promise.withResolvers<ScopeAgentContributionStatus>()
    const status = vi.fn<NativeContributionPort['status']>().mockReturnValueOnce(pending.promise).mockResolvedValue(capturedStatus)
    const { source } = fixture(status)
    try {
      const first = source.directory.refresh(agentId)
      await Promise.resolve()
      source.changed(agentId, 1)
      await source.directory.refresh(agentId)
      pending.resolve(emptyStatus); await first
      expect(source.directory.getSnapshot()[agentId]?.value).toEqual(capturedStatus)
      const cold: ScopeAgentContributionStatus = { ...capturedStatus, eligibility: 'not-live' }
      status.mockResolvedValue(cold)
      source.changed(agentId, 1); await source.directory.refresh(agentId)
      expect(source.directory.getSnapshot()[agentId]?.value).toEqual(cold)
      source.changed('unopened' as typeof agentId, 10)
      expect(status).toHaveBeenCalledTimes(3)
    } finally { source.dispose() }
  })

  it('keeps unknown outcomes inert until an explicit status read succeeds, without replaying the request', async () => {
    const status = vi.fn<NativeContributionPort['status']>().mockResolvedValueOnce(emptyStatus)
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(capturedStatus)
    const { source, port } = fixture(status)
    vi.mocked(port.request).mockRejectedValueOnce(new Error('lost reply'))
    try {
      await source.directory.refresh(agentId)
      await source.request(request)
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ status: 'error', pending: false, value: emptyStatus })
      await source.request(request)
      expect(port.request).toHaveBeenCalledOnce()
      await source.directory.refresh(agentId)
      expect(source.directory.getSnapshot()[agentId]?.value).toEqual(capturedStatus)
      expect(port.request).toHaveBeenCalledOnce()
    } finally { source.dispose() }
  })

  it('rejects stale capture actions and permits exact stop when the Agent is no longer eligible', async () => {
    const { source, port } = fixture(vi.fn(async () => ({ ...capturedStatus, eligibility: 'fork' as const })))
    try {
      await source.directory.refresh(agentId)
      await source.stop({ agentId, expectedCapture: { ...capture.selection,
        captureGeneration: 'old' as typeof capture.selection.captureGeneration } })
      expect(port.stop).not.toHaveBeenCalled()
      await source.directory.refresh(agentId)
      await source.request({ ...request, expectedCapture: capture.selection })
      expect(port.request).not.toHaveBeenCalled()
      await source.stop({ agentId, expectedCapture: capture.selection })
      expect(port.stop).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
    } finally { source.dispose() }
  })

  it('does not publish a response older than a delivered revision and stops calls after disposal', async () => {
    const { source, port } = fixture()
    await source.directory.refresh(agentId)
    source.changed(agentId, 3)
    await source.directory.refresh(agentId)
    expect(source.directory.getSnapshot()[agentId]?.status).toBe('error')
    source.dispose()
    await source.request(request); await source.directory.refresh(agentId)
    source.changed(agentId, 4)
    expect(port.request).not.toHaveBeenCalled()
    expect(port.status).toHaveBeenCalledTimes(2)
  })
})


describe('joint leave ownership', () => {
  it('keeps a sent leave locked through reset and rereads its outcome instead of repeating either operation', async () => {
    let authority = capturedStatus
    const pending = Promise.withResolvers<ScopeAgentContributionStatus>()
    const { source, port } = fixture(vi.fn(async () => authority))
    vi.mocked(port.leaveJoin).mockReturnValue(pending.promise)
    try {
      await source.directory.refresh(agentId)
      const operation = { agentId, expectedCapture: capture.selection }
      const sent = source.leaveJoin(operation)
      source.reset(); await source.directory.refresh(agentId)
      await source.leaveJoin(operation); await source.stop(operation)
      expect(port.leaveJoin).toHaveBeenCalledOnce()
      expect(port.stop).not.toHaveBeenCalled()
      expect(source.directory.getSnapshot()[agentId]?.pending).toBe(true)
      authority = { ...emptyStatus, revision: 2 }
      pending.reject(new Error('committed reply lost'))
      await sent
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ pending: false, status: 'ready', value: authority })
      await source.leaveJoin(operation)
      expect(port.leaveJoin).toHaveBeenCalledOnce()
    } finally { source.dispose() }
  })
})


describe('receiving continuation ownership', () => {
  it('blocks new requests and stale stops while preserving exact continuation cancellation through reset and lost replies', async () => {
    const continuation: NonNullable<ScopeAgentContributionStatus['receivingContinuation']> = {
      routeRevision: 0, selection: capture.selection, entry: capture.entry, intent: 'cancel-pending', receiving: {
        adoptionId: 'join-a' as NonNullable<ScopeAgentContributionStatus['receivingContinuation']>['receiving']['adoptionId'],
        state: 'failed', invitation: null,
      },
    }
    let authority: ScopeAgentContributionStatus = { ...emptyStatus, revision: 2, receivingContinuation: continuation }
    const pending = Promise.withResolvers<ScopeAgentContributionStatus>()
    const { source, port } = fixture(vi.fn(async () => authority))
    vi.mocked(port.stop).mockReturnValue(pending.promise)
    try {
      await source.directory.refresh(agentId)
      await source.request(request)
      await source.directory.refresh(agentId)
      await source.request({ ...request, expectedCapture: capture.selection })
      expect(port.request).not.toHaveBeenCalled()
      await source.stop({ agentId, expectedCapture: { ...capture.selection,
        captureGeneration: 'older' as typeof capture.selection.captureGeneration } })
      expect(port.stop).not.toHaveBeenCalled()
      await source.directory.refresh(agentId)
      const operation = { agentId, expectedCapture: capture.selection }
      const sent = source.stop(operation)
      source.reset(); await source.directory.refresh(agentId)
      await source.stop(operation); await source.leaveJoin(operation)
      expect(port.stop).toHaveBeenCalledExactlyOnceWith(operation)
      expect(port.leaveJoin).not.toHaveBeenCalled()
      authority = { ...emptyStatus, revision: 3 }
      pending.reject(new Error('committed cancellation reply lost')); await sent
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ status: 'ready', pending: false, value: authority })
      await source.leaveJoin(operation)
      expect(port.leaveJoin).not.toHaveBeenCalled()
    } finally { source.dispose() }
  })
})

describe('native route mutation ownership', () => {
  it('retains a sent recovery through reset and lost reply, then rejects stale displayed addresses', async () => {
    let authority: ScopeAgentContributionStatus = { ...capturedStatus, eligibility: 'not-live', capture: { ...capture, state: 'ending' } }
    const pending = Promise.withResolvers<ScopeAgentContributionStatus>()
    const { source, port } = fixture(vi.fn(async () => authority))
    vi.mocked(port.recoverRoute).mockReturnValueOnce(pending.promise)
    const entry = { ...capture.entry, ownerAddress: '/ip4/127.0.0.1/tcp/2/p2p/owner-peer' }
    const request = { agentId, expectedCapture: capture.selection, expectedRouteRevision: 0,
      expectedOwnerAddress: capture.entry.ownerAddress, entry }
    try {
      await source.directory.refresh(agentId)
      const sent = source.recoverRoute(request)
      source.reset(); await source.directory.refresh(agentId)
      await source.recoverRoute(request); await source.stop({ agentId, expectedCapture: capture.selection })
      expect(port.recoverRoute).toHaveBeenCalledExactlyOnceWith(request)
      expect(port.stop).not.toHaveBeenCalled()
      authority = { ...authority, revision: 2, capture: { ...capture, state: 'ending', entry } }
      pending.reject(new Error('route committed, reply lost')); await sent
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ pending: false, value: authority })
      await source.recoverRoute(request)
      expect(port.recoverRoute).toHaveBeenCalledOnce()
      expect(port.request).not.toHaveBeenCalled()
    } finally { source.dispose() }
  })
})
