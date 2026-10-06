/** Awaited loopback SSE fixture for the production HTTP adapter; replies are controlled calibration data. */
import { createServer } from 'node:http'
import { z } from 'zod'

const envelopeSchema = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.unknown() }).loose()) })
/** Model-visible HTTP payload passed to a controlled calibration responder. */
export type DataHttpEnvelope = z.infer<typeof envelopeSchema>
/** Controlled response and optional failure injection; neither represents real model inference. */
export interface DataHttpReply {
  readonly kind: string
  readonly delta: Readonly<Record<string, unknown>>
  readonly finish: 'stop' | 'tool_calls'
  readonly omitUsage?: boolean
  readonly cancel?: AbortController
}

/** Open a private local endpoint and retain requests and handler failures until quiescent close.
 * @param reply Controlled responder; it may inspect only the actual HTTP envelope supplied by the provider.
 * @returns Loopback endpoint, observations, and a close operation awaiting every handler.
 */
export async function openDataHttpFixture(reply: (envelope: DataHttpEnvelope) => DataHttpReply) {
  const calls: { kind: string; body: DataHttpEnvelope }[] = []
  const errors: unknown[] = []; const pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const work = (async () => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        size += bytes.length
        if (size > 1048576) throw new Error('calibration request exceeds byte bound')
        chunks.push(bytes)
      }
      if (request.url !== '/chat/completions' || request.headers.authorization !== 'Bearer transport-calibration-not-a-secret') {
        throw new Error('calibration received an unexpected route or credential')
      }
      const envelope = envelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      const value = reply(envelope)
      calls.push({ kind: value.kind, body: envelope })
      if (value.cancel !== undefined) {
        const disconnected = new Promise<void>(resolve => response.once('close', resolve))
        value.cancel.abort(new Error('calibration cancels an actual ordinary HTTP stream'))
        await disconnected
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (data: unknown): void => { response.write(`data: ${JSON.stringify(data)}\n\n`) }
      const identity = { id: `calibration-${calls.length}`, object: 'chat.completion.chunk', model: envelope.model, created: 1 }
      frame({ ...identity, choices: [{ index: 0, delta: { role: 'assistant', ...value.delta }, finish_reason: null }] })
      frame({ ...identity, choices: [{ index: 0, delta: {}, finish_reason: value.finish }],
        ...value.omitUsage === true ? {} : { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } } })
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => { errors.push(error); response.destroy() }).finally(() => pending.delete(work))
    pending.add(work)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no calibration address')
  return { endpoint: `http://127.0.0.1:${address.port}`, calls, errors, async close() {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
    await Promise.allSettled(pending)
  } }
}
