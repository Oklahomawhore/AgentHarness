/** Wire compression preserves exact projections and bounds untrusted decoding before JSON admission. */

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import { describe, expect, it } from 'vitest'
import { decodeReadResponse, encodeReadResponse } from '../src/read-codec.ts'
import { projectionDigest, projectionSchema } from '../src/schema.ts'
import { peerCaptureSchema } from '../src/subscription-schema.ts'
import { readResponseSchema } from '../src/state.ts'

const uuid = '11111111-1111-4111-8111-111111111111'
const taskId = brandString<DevelopmentTaskId>(`task-${uuid}`)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const envelope = (value: unknown) => ({ encoding: 'gzip-base64', data: gzipSync(JSON.stringify(value)).toString('base64') })
const legacy = projectionSchema.parse({
  projectionId: '93684fa93b807d3fc0e04c2e38a80a21fcb2f175739f24b103a886601cda6e0f',
  taskId: 'task-scope', taskRevision: 7, ownerPeerId: 'peer-owner', recipientPeerId: 'peer-recipient',
  grantId: uuid, grantGeneration: '22222222-2222-4222-8222-222222222222',
  expiresAt: 1900000000000, backend: { id: 'fixture', revision: '1' }, maxContextBytes: 1024,
  text: 'exact context', selectedSources: [{ kind: 'task', taskId: 'task-scope', revision: 7 }], omittedSources: [],
})

function response(count = 300, text = '最新完整报告。') {
  const fields = { ...legacy, taskId, taskRevision: count + 2, version: 2 as const,
    activation: { kind: 'exact' as const }, text, maxContextBytes: Buffer.byteLength(text),
    selectedSources: [{ kind: 'task' as const, taskId, revision: count + 2 }],
    omittedSources: Array.from({ length: count }, (_, index) => ({
      source: { kind: 'publication' as const, taskId, revision: count + 2,
        publicationId: `context-peer-observation-${hash(String(index))}` },
      reason: index % 2 === 0 ? 'superseded' as const : 'withdrawn' as const,
    })),
  }
  const projection = projectionSchema.parse({ ...fields, projectionId: projectionDigest(fields) })
  return readResponseSchema.parse({ requestId: uuid, subscriptionId: uuid, generation: uuid, result: { status: 'active', projection } })
}

const wide = { maxResponseBytes: 2_097_152, maxDecodedResponseBytes: 2_097_152 }

describe('complete scope read encoding', () => {
  it('keeps fitting legacy projections and denial replies in their original representation', async () => {
    const inputs = [readResponseSchema.parse({ requestId: uuid, subscriptionId: uuid, generation: uuid,
      result: { status: 'active', projection: legacy } }),
    readResponseSchema.parse({ requestId: uuid, subscriptionId: uuid, generation: uuid, result: { status: 'denied' } })]
    for (const input of inputs) {
      const limits = { maxResponseBytes: size(input), maxDecodedResponseBytes: size(input) }
      expect(await encodeReadResponse(input, limits)).toBe(input)
      expect(await decodeReadResponse(JSON.parse(JSON.stringify(input)), limits)).toEqual(input)
      const packed = envelope(input)
      expect(await decodeReadResponse(packed, { ...limits, maxResponseBytes: size(packed) })).toEqual(input)
    }
  })

  it('round-trips ordered high-entropy source coverage without changing text or its digest', async () => {
    const input = response()
    const limits = { maxResponseBytes: 60000, maxDecodedResponseBytes: size(input) }
    expect(size(input)).toBeGreaterThan(limits.maxResponseBytes)
    const encoded = await encodeReadResponse(input, limits)
    expect(encoded).toMatchObject({ encoding: 'gzip-base64' })
    expect(size(encoded)).toBeLessThanOrEqual(limits.maxResponseBytes)
    expect(await decodeReadResponse(encoded, limits)).toEqual(input)
  })

  it('preserves an exact original capture in a compressed version-three projection', async () => {
    const input = response()
    if (input.result.status !== 'active') throw new Error('Expected active fixture')
    const previous = input.result.projection
    const peerCapture = peerCaptureSchema.parse({ ownerPeerId: previous.ownerPeerId, contributorPeerId: previous.recipientPeerId,
      taskId, grantId: uuid, generation: uuid, captureId: uuid, captureGeneration: uuid })
    const fields = { ...previous, version: 3 as const, activation: { kind: 'exact' as const }, peerCapture }
    const projection = projectionSchema.parse({ ...fields, projectionId: projectionDigest(fields) })
    const captured = readResponseSchema.parse({ ...input, result: { status: 'active', projection } })
    const limits = { maxResponseBytes: 60000, maxDecodedResponseBytes: size(captured) }
    expect(await decodeReadResponse(await encodeReadResponse(captured, limits), limits)).toEqual(captured)
  })

  it('counts complete multibyte JSON at exact decoded and encoded limits', async () => {
    const input = response(300, '多字节😀'.repeat(100))
    const encoded = await encodeReadResponse(input, { ...wide, maxResponseBytes: 60000 })
    const limits = { maxResponseBytes: size(encoded), maxDecodedResponseBytes: size(input) }
    expect(await encodeReadResponse(input, limits)).toEqual(encoded)
    expect(await decodeReadResponse(encoded, limits)).toEqual(input)
    await expect(encodeReadResponse(input, { ...limits, maxDecodedResponseBytes: limits.maxDecodedResponseBytes - 1 }))
      .rejects.toThrow('decoded response exceeds budget')
    await expect(decodeReadResponse(encoded, { ...limits, maxDecodedResponseBytes: limits.maxDecodedResponseBytes - 1 }))
      .rejects.toThrow()
    await expect(encodeReadResponse(input, { ...limits, maxResponseBytes: limits.maxResponseBytes - 1 }))
      .rejects.toThrow('encoded response exceeds budget')
    await expect(decodeReadResponse(encoded, { ...limits, maxResponseBytes: limits.maxResponseBytes - 1 }))
      .rejects.toThrow('encoded response exceeds budget')
  })

  it('applies the decoded ceiling even when the ordinary wire representation fits', async () => {
    const input = response(0)
    await expect(encodeReadResponse(input, { ...wide, maxDecodedResponseBytes: size(input) - 1 }))
      .rejects.toThrow('decoded response exceeds budget')
    await expect(decodeReadResponse(input, { ...wide, maxDecodedResponseBytes: size(input) - 1 }))
      .rejects.toThrow('decoded response exceeds budget')
  })

  it('rejects an expansion bomb using the native output limit before parsing JSON', async () => {
    const compressed = envelope({ padding: 'x'.repeat(100000) })
    expect(size(compressed)).toBeLessThan(1024)
    await expect(decodeReadResponse(compressed, { maxResponseBytes: 1024, maxDecodedResponseBytes: 2048 }))
      .rejects.toMatchObject({ message: 'scope-access: decoded response exceeds budget', cause: { code: 'ERR_BUFFER_TOO_LARGE' } })
  })

  it('also bounds native compression when even compressed bytes cannot fit', async () => {
    await expect(encodeReadResponse(response(300), { ...wide, maxResponseBytes: 100 }))
      .rejects.toMatchObject({ message: 'scope-access: encoded response exceeds budget', cause: { code: 'ERR_BUFFER_TOO_LARGE' } })
  })

  it.each([
    { encoding: 'brotli-base64', data: 'AAAA' },
    { encoding: 'gzip-base64', data: '', future: true },
    { encoding: 'gzip-base64' },
    { encoding: 'gzip-base64', data: 7 },
    null,
    'not a response',
  ])('rejects unsupported wire values without interpreting them as another encoding: %j', async (raw) => {
    await expect(decodeReadResponse(raw, wide)).rejects.toThrow()
  })

  it.each(['AA', 'AB==', ' AA==', 'AA==\n', 'AA-_', '!!!', 'AA==='])('rejects noncanonical base64 %j', async (data) => {
    await expect(decodeReadResponse({ encoding: 'gzip-base64', data }, wide)).rejects.toThrow('noncanonical response base64')
  })

  it('rejects malformed, truncated, and corrupted gzip streams', async () => {
    const valid = gzipSync(JSON.stringify(response()))
    const corrupt = Buffer.from(valid)
    corrupt[corrupt.length - 1] = 1
    for (const bytes of [Buffer.from('not gzip'), valid.subarray(0, valid.length - 1), corrupt]) {
      await expect(decodeReadResponse({ encoding: 'gzip-base64', data: bytes.toString('base64') }, wide)).rejects.toThrow()
    }
  })

  it('rejects invalid UTF-8, invalid JSON, unknown response fields, and changed projection digests after decoding', async () => {
    for (const raw of [Buffer.from([0xff]), Buffer.from('{')]) {
      await expect(decodeReadResponse({ encoding: 'gzip-base64', data: gzipSync(raw).toString('base64') }, wide)).rejects.toThrow()
    }
    const input = response()
    await expect(decodeReadResponse(envelope({ ...input, future: true }), wide)).rejects.toThrow()
    if (input.result.status !== 'active') throw new Error('Expected active fixture')
    const changed = { ...input, result: { ...input.result, projection: { ...input.result.projection, text: 'changed' } } }
    await expect(decodeReadResponse(envelope(changed), wide)).rejects.toThrow('projection identity')
  })
})
