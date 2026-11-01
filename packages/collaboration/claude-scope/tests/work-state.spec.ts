import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { peerContributionPayloadDigest, peerContributionPublicationId } from '@deepseek-ai/dsh-development-task/schema'
import { workContributionSchema } from '../src/contribution-state.ts'
import { contributionProposalSource } from '../src/contribution-source.ts'
import { scopeDigest } from '../src/projection.ts'
import type { ClaudeScopeContributionSource } from '../src/types.ts'
import { validateWorkLease } from '../src/work-capture.ts'
import { workLeaseSchema } from '../src/work-state.ts'

const identity = { sessionKey: 'source-session', captureId: 'original-capture', captureGeneration: 'original-generation' }
const source = { kind: 'claude-work', tools: ['Write', 'Edit'],
  commands: [{ rootIndex: 0, command: 'pnpm test' }], stopReports: true } as const
const digestText = (text: string) => createHash('sha256').update(text).digest('hex')
const keyFor = (...parts: readonly unknown[]) =>
  `work:${scopeDigest([identity.sessionKey, identity.captureId, identity.captureGeneration, ...parts])}`

function captureRecord(selection: ClaudeScopeContributionSource = source) {
  const proposal = { contributorPeerId: 'source-peer', captureId: identity.captureId, captureGeneration: identity.captureGeneration,
    source: contributionProposalSource(selection) }
  return workContributionSchema.parse({ proposal, source: selection,
    policy: { roots: [resolve('source-root')], bashCommands: [], revision: 'policy' }, state: 'active', sequence: 1,
    invitation: { version: 1, kind: 'claude-work-contribution', ownerAddress: '/ip4/127.0.0.1/tcp/7000/p2p/owner',
      grant: { ...proposal, version: 1, taskId: 'shared-task', ownerPeerId: 'owner-peer',
        grantId: 'original-grant', generation: 'grant-generation',
        expiresAt: 2_000_000_000_000, maxSamples: 8, maxSampleBytes: 4096 } } })
}

function fileResult(tool: 'Write' | 'Edit', terminal: 'PostToolUse' | 'PostToolUseFailure') {
  const fields = { rootIndex: 0, path: 'result.txt' }
  return { kind: 'tool-observation', version: 1, tool, reportedStatus: terminal === 'PostToolUse' ? 'success' : 'failure',
    fields: terminal === 'PostToolUse'
      ? tool === 'Write' ? { ...fields, content: 'original content' }
        : { ...fields, oldString: 'before', newString: 'after', replaceAll: false }
      : tool === 'Write' ? { ...fields, error: 'write failed' } : { ...fields, replaceAll: false, error: 'edit failed' },
    omissions: terminal === 'PostToolUse' ? [] : tool === 'Write' ? ['content'] : ['oldString', 'newString'] }
}

function commandResult(terminal: 'PostToolUse' | 'PostToolUseFailure') {
  const fields = { rootIndex: 0, command: 'pnpm test' }
  return { kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent: terminal,
    fields: terminal === 'PostToolUse' ? { ...fields, stdout: 'tests passed', stderr: '', interrupted: false }
      : { ...fields, error: 'Exit code 7' },
    omissions: [] }
}

function toolRecord(tool: 'Write' | 'Edit' | 'Bash' = 'Write', terminal: 'PostToolUse' | 'PostToolUseFailure' = 'PostToolUse') {
  const key = keyFor('tool', 'original-tool')
  return { key, record: { ...identity, kind: 'tool', toolUseId: 'original-tool', toolName: tool,
    argumentDigest: digestText('original arguments'), authorizedInputDigest: digestText('authorized arguments'),
    terminal, completionDigest: digestText('original completion'), sample: { sourceId: scopeDigest([key, terminal, 1]), sequence: 1,
      result: tool === 'Bash' ? commandResult(terminal) : fileResult(tool, terminal) } } }
}

function stopRecord(active = false) {
  const text = 'Original assistant report'
  const textDigest = digestText(text)
  const key = keyFor('Stop', 'original-prompt', textDigest, active)
  return { key, record: { ...identity, kind: 'stop-report', promptId: 'original-prompt', textDigest, stopHookActive: active,
    sample: { sourceId: key.slice('work:'.length), sequence: 1,
      result: { kind: 'claude-stop-report', version: 7, text, sha256: textDigest, stopHookActive: active } } } }
}

function parseStored(record: unknown) {
  const stored: unknown = JSON.parse(JSON.stringify(record))
  return workLeaseSchema.parse(stored)
}

function admittedRecord(record: unknown) {
  const lease = parseStored(record)
  const invitation = captureRecord().invitation
  if (lease.kind === 'prompt' || lease.sample === undefined || invitation === undefined) {
    throw new Error('An admission fixture requires its original sample and invitation')
  }
  const { grant } = invitation
  const request = { grant, ...lease.sample }
  return { ...lease, receipt: { taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
    grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration,
    revision: 2, event: { nodeId: 'owner-node', seq: 2, kind: 'context-published' }, sourceId: lease.sample.sourceId,
    sequence: lease.sample.sequence, payloadDigest: peerContributionPayloadDigest(request),
    publicationId: peerContributionPublicationId(request) } }
}

function expectRejected(key: string, record: unknown, message: string, capture = captureRecord()) {
  const restored = parseStored(record)
  expect(() => { validateWorkLease(key, restored, capture) }).toThrow(message)
}

describe('persisted Claude work lease associations', () => {
  it('restores prompt permission and an uncompleted tool lease without inventing a sample', () => {
    const prompt = parseStored({ ...identity, kind: 'prompt', promptId: 'original-prompt' })
    expect(() => { validateWorkLease(keyFor('prompt'), prompt, captureRecord()) }).not.toThrow()
    const { key, record } = toolRecord()
    const { sample: _sample, terminal: _terminal, completionDigest: _completion, ...pending } = record
    const restored = parseStored(pending)
    expect(() => { validateWorkLease(key, restored, captureRecord()) }).not.toThrow()
    expect(restored).not.toHaveProperty('sample')
    expect(restored).not.toHaveProperty('receipt')
  })

  it.each(['Write', 'Edit', 'Bash'] as const)('restores complete %s reports and their exact owner receipts for both terminal hooks', (tool) => {
    for (const terminal of ['PostToolUse', 'PostToolUseFailure'] as const) {
      const { key, record } = toolRecord(tool, terminal)
      const admitted = admittedRecord(record)
      const restored = parseStored(admitted)
      expect(restored).toEqual(admitted)
      expect(() => { validateWorkLease(key, restored, captureRecord()) }).not.toThrow()
    }
  })

  it.each([false, true])('restores the original Stop text and receipt with stop_hook_active=%s', (active) => {
    const { key, record } = stopRecord(active)
    const admitted = admittedRecord(record)
    expect(parseStored(admitted)).toEqual(admitted)
    expect(() => { validateWorkLease(key, parseStored(admitted), captureRecord()) }).not.toThrow()
  })

  it.each(['captureId', 'captureGeneration'] as const)('rejects a persisted row attributed to another %s', (field) => {
    const { key, record } = toolRecord()
    expectRejected(key, { ...record, [field]: 'another-capture' }, 'different capture identity')
  })

  it('rejects work rows associated with independently selected file or API captures', () => {
    const capture = captureRecord()
    const { key, record } = toolRecord()
    for (const selection of [{ kind: 'tool-observations', tools: ['Write'] },
      { name: 'api', method: 'post', path: '/result', filePath: resolve('source-root', 'api.json') }] as const) {
      const replacement = workContributionSchema.parse({ ...capture, source: selection, state: 'prepared', invitation: undefined,
        proposal: { ...capture.proposal, source: contributionProposalSource(selection) } })
      expectRejected(key, record, 'different capture identity', replacement)
    }
  })

  it('rejects another durable key or a changed source Session even when the capture still exists', () => {
    const { key, record } = toolRecord()
    expectRejected(`${key}-changed`, record, 'original local permission')
    expectRejected(key, { ...record, sessionKey: 'another-session' }, 'original local permission')
  })

  it('rejects prompt and Stop rows after their original Stop permission is removed', () => {
    const capture = captureRecord({ ...source, stopReports: false })
    expectRejected(keyFor('prompt'), { ...identity, kind: 'prompt', promptId: 'original-prompt' }, 'original local permission', capture)
    const { key, record } = stopRecord()
    expectRejected(key, record, 'original local permission', capture)
  })

  it('rejects file and command rows when their original collection categories disappear', () => {
    const file = toolRecord()
    expectRejected(file.key, file.record, 'original local permission', captureRecord({ ...source, tools: ['Edit'] }))
    const command = toolRecord('Bash')
    expectRejected(command.key, command.record, 'original local permission', captureRecord({ ...source, commands: [] }))
  })

  it('rejects retained samples when their owner invitation is absent', () => {
    const { key, record } = toolRecord()
    const capture = workContributionSchema.parse({ ...captureRecord(), state: 'prepared', invitation: undefined })
    expectRejected(key, record, 'different source identity', capture)
  })

  it('rejects a sample from a future capture sequence or another immutable source id', () => {
    const { key, record } = toolRecord()
    expectRejected(key, { ...record, sample: { ...record.sample, sequence: 2 } }, 'different source identity')
    expectRejected(key, { ...record, sample: { ...record.sample, sourceId: digestText('another source') } }, 'different source identity')
  })

  it('rejects a Stop row containing a file result, changed original text, or another active flag', () => {
    const { key, record } = stopRecord()
    const replace = (result: unknown) => ({ ...record, sample: { ...record.sample, result } })
    expectRejected(key, replace(fileResult('Write', 'PostToolUse')), 'Stop sample differs')
    const text = 'Another report with its own valid digest'
    expectRejected(key, replace({ ...record.sample.result, text, sha256: digestText(text) }), 'Stop sample differs')
    expectRejected(key, replace({ ...record.sample.result, stopHookActive: true }), 'Stop sample differs')
  })

  it.each(['terminal', 'completionDigest'] as const)('rejects a tool sample whose original %s disappeared', (field) => {
    const { key, record } = toolRecord()
    const terminal = field === 'terminal' ? undefined : record.terminal
    expectRejected(key, { ...record, [field]: undefined,
      sample: { ...record.sample, sourceId: scopeDigest([key, terminal, record.sample.sequence]) } }, 'leased tool completion')
  })

  it('rejects a command sample for another result kind, terminal event, root, or command', () => {
    const { key, record } = toolRecord('Bash')
    const original = commandResult('PostToolUse')
    for (const result of [fileResult('Write', 'PostToolUse'), commandResult('PostToolUseFailure'),
      { ...original, fields: { ...original.fields, rootIndex: 1 } },
      { ...original, fields: { ...original.fields, command: 'pnpm build' } }]) {
      expectRejected(key, { ...record, sample: { ...record.sample, result } }, 'leased tool completion')
    }
  })

  it('rejects a file sample carrying another result kind, tool, or terminal status', () => {
    const { key, record } = toolRecord()
    for (const result of [commandResult('PostToolUse'), fileResult('Edit', 'PostToolUse'), fileResult('Write', 'PostToolUseFailure')]) {
      expectRejected(key, { ...record, sample: { ...record.sample, result } }, 'leased tool completion')
    }
  })

  it('rejects an owner receipt whose original sample or invitation disappeared', () => {
    const { key, record } = toolRecord()
    const admitted = admittedRecord(record)
    const withoutSample = { ...admitted, sample: undefined }
    expectRejected(key, withoutSample, 'receipt has no original sample')
    const capture = workContributionSchema.parse({ ...captureRecord(), state: 'prepared', invitation: undefined })
    expectRejected(key, withoutSample, 'receipt has no original sample', capture)
  })

  it('rejects an owner receipt reassigned to a different grant', () => {
    const { key, record } = toolRecord()
    const admitted = admittedRecord(record)
    expectRejected(key, { ...admitted, receipt: { ...admitted.receipt, grantId: 'another-grant' } }, 'does not match its invitation')
  })

  it.each(['sourceId', 'sequence', 'payloadDigest', 'publicationId'] as const)('rejects a receipt with a changed admitted %s', (field) => {
    const { key, record } = toolRecord()
    const admitted = admittedRecord(record)
    const changed = field === 'sequence' ? 2 : field === 'publicationId' ? 'another-publication' : digestText('another admitted value')
    expectRejected(key, { ...admitted, receipt: { ...admitted.receipt, [field]: changed } }, 'does not match its sample')
  })

  it('rejects changed report content under an otherwise unchanged original receipt', () => {
    const { key, record } = toolRecord()
    const admitted = admittedRecord(record)
    const result = fileResult('Write', 'PostToolUse')
    expectRejected(key, { ...admitted, sample: { ...record.sample, result: { ...result,
      fields: { rootIndex: 0, path: 'result.txt', content: 'rewritten after owner admission' } } } }, 'does not match its sample')
  })
})
