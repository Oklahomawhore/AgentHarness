import { describe, expect, it, vi } from 'vitest'
import { createNativeLocalContributionDirectory, type NativeLocalContributionPort } from '../src/client/native-local-contributions.ts'
import { agentId, capture, capturedStatus, emptyStatus } from './native-contribution-fixture.client.ts'
import { createNativeContributionDirectory, type NativeContributionPort } from '../src/client/native-contributions.ts'
import { assigned, binding, localCapture, localRequest, unbound } from './native-local-contribution-fixture.client.ts'

function fixture(initial = unbound) {
  const port: NativeLocalContributionPort = {
    status: vi.fn(async () => initial), checkout: vi.fn(async () => undefined),
    request: vi.fn(async () => undefined), stopLocal: vi.fn(async () => initial),
  }
  return { port, source: createNativeLocalContributionDirectory(port, vi.fn()) }
}

describe('owner-local contribution directory', () => {
  it('stops local and peer captures independently and keeps only the unresolved destination pending across reset', async () => {
    const localCaptureId = 'independent-local-capture' as typeof localCapture.selection.captureId
    const distinctLocalCapture = { ...localCapture, selection: { ...localCapture.selection, captureId: localCaptureId },
      grant: { ...localCapture.grant, captureId: localCaptureId } }
    const { port, source } = fixture({ ...assigned, capture: distinctLocalCapture })
    const peerPort: NativeContributionPort = { status: vi.fn(async () => capturedStatus),
      request: vi.fn(async () => capturedStatus), recoverRoute: vi.fn(async () => capturedStatus),
      leaveJoin: vi.fn(async () => emptyStatus), stop: vi.fn(async () => emptyStatus) }
    const peer = createNativeContributionDirectory(peerPort, vi.fn())
    const held = Promise.withResolvers<typeof assigned>()
    try {
      await source.directory.refresh(agentId); await peer.directory.refresh(agentId)
      vi.mocked(port.stopLocal).mockReturnValue(held.promise)
      const localStop = source.stop({ agentId, expectedCapture: distinctLocalCapture.selection })
      expect(source.directory.getSnapshot()[agentId]?.pending).toBe(true)
      expect(peer.directory.getSnapshot()[agentId]?.pending).toBe(false)
      await peer.stop({ agentId, expectedCapture: capture.selection })
      expect(peerPort.stop).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: capture.selection })
      expect(port.stopLocal).toHaveBeenCalledExactlyOnceWith({ agentId, expectedCapture: distinctLocalCapture.selection })
      source.reset(); peer.reset()
      await source.directory.refresh(agentId); await peer.directory.refresh(agentId)
      expect(source.directory.getSnapshot()[agentId]?.pending).toBe(true)
      expect(peer.directory.getSnapshot()[agentId]?.pending).toBe(false)
      await source.stop({ agentId, expectedCapture: distinctLocalCapture.selection })
      expect(port.stopLocal).toHaveBeenCalledOnce()
      vi.mocked(port.status).mockResolvedValue(assigned)
      held.resolve(assigned)
      await localStop
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ pending: false, value: assigned })
      expect(peer.directory.getSnapshot()[agentId]?.value).toEqual(capturedStatus)
    } finally { held.resolve(assigned); source.dispose(); peer.dispose() }
  })

  it('checks out using the Host participant identity and rereads instead of assuming capture permission', async () => {
    const { port, source } = fixture()
    try {
      await source.directory.refresh(agentId)
      vi.mocked(port.status).mockResolvedValue(assigned)
      await source.checkout(agentId, binding.taskId)
      expect(port.checkout).toHaveBeenCalledExactlyOnceWith({ taskId: binding.taskId, participantId: unbound.participantId })
      expect(source.directory.getSnapshot()[agentId]?.value).toEqual(assigned)
      expect(port.request).not.toHaveBeenCalled()
      await source.checkout(agentId, binding.taskId)
      expect(port.checkout).toHaveBeenCalledOnce()
    } finally { source.dispose() }
  })

  it('rejects a stale binding epoch before sending and recovers an uncertain committed request by reading', async () => {
    const { port, source } = fixture(assigned)
    try {
      await source.directory.refresh(agentId)
      await source.request({ ...localRequest, expectedBindingEpoch: { ...binding.expectedBindingEpoch, seq: 3 } })
      expect(port.request).not.toHaveBeenCalled()
      await source.directory.refresh(agentId)
      vi.mocked(port.request).mockRejectedValue(new Error('lost reply'))
      vi.mocked(port.status).mockResolvedValue({ ...assigned, revision: 1, capture: localCapture })
      await source.request(localRequest)
      expect(port.request).toHaveBeenCalledOnce()
      expect(source.directory.getSnapshot()[agentId]?.value?.capture).toEqual(localCapture)
      await source.request(localRequest)
      expect(port.request).toHaveBeenCalledOnce()
    } finally { source.dispose() }
  })

  it('keeps a sent checkout locked through reset and publishes the current authority after settlement', async () => {
    const { port, source } = fixture()
    const held = Promise.withResolvers<undefined>()
    try {
      await source.directory.refresh(agentId)
      vi.mocked(port.checkout).mockReturnValue(held.promise)
      const mutation = source.checkout(agentId, binding.taskId)
      source.reset()
      await source.directory.refresh(agentId)
      expect(source.directory.getSnapshot()[agentId]?.pending).toBe(true)
      await source.checkout(agentId, binding.taskId)
      expect(port.checkout).toHaveBeenCalledOnce()
      vi.mocked(port.status).mockResolvedValue(assigned)
      held.resolve(undefined)
      await mutation
      expect(source.directory.getSnapshot()[agentId]).toMatchObject({ pending: false, status: 'ready', value: assigned })
    } finally { held.resolve(undefined); source.dispose() }
  })

  it('allows exact stopping even when the Agent is cold and invalidates observed bindings', async () => {
    const { port, source } = fixture({ ...assigned, eligibility: 'not-live', capture: localCapture })
    try {
      await source.directory.refresh(agentId)
      await source.stop({ agentId, expectedCapture: localCapture.selection })
      expect(port.stopLocal).toHaveBeenCalledOnce()
      const reads = vi.mocked(port.status).mock.calls.length
      source.assignmentsChanged()
      await source.directory.refresh(agentId)
      expect(vi.mocked(port.status).mock.calls.length).toBeGreaterThan(reads)
    } finally { source.dispose() }
  })
})
