// The lease test supplies fixed discovery facts; it never sends an HTTP request.
import { createClaudeScopeDescriptor } from '../../lib/types/transport.js'

export const name = 'descriptor-lease-owner-fixture'

export async function apply(ctx, config) {
  ctx.provide('connection', { authenticatedUrl: origin => `${origin}/?token=fixture-token` })
  ctx.provide('webServer', { port: 12345 })
  await createClaudeScopeDescriptor(ctx, config).ready
  process.stdin.resume()
  ctx.effect(() => () => { process.stdin.pause() })
}
