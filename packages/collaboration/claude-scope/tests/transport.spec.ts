import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/command.ts'
import { callClaudeScopeHook, ClaudeScopeCommandFailure } from '../src/transport.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function wireFixture(result: unknown, loginStatus = 303) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-scope-wire-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const privateDirectory = join(directory, 'private')
  await mkdir(privateDirectory, { mode: 0o700 })
  let rpcCalls = 0
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(loginStatus, { location: '/', 'set-cookie': 'dsh-auth-fixture=v1.a.b; Path=/' })
      response.end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      rpcCalls += 1
      const input = JSON.parse(body) as { rpcId: string }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: result } }))
    })
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const descriptorPath = join(privateDirectory, 'connection.json')
  await writeFile(descriptorPath, JSON.stringify({
    version: 1, generation: 'wire-test', launchUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/?token=fixture`,
  }), { mode: 0o600 })
  return {
    descriptorPath, privateDirectory,
    config: { descriptorPath, maxRequestBytes: 32768, maxResponseBytes: 32768 }, rpcCalls: () => rpcCalls,
  }
}

describe.skipIf(process.platform === 'win32')('Claude command wire parsing', () => {
  it('rejects cancellation before descriptor streaming without starting a request', async () => {
    const fixture = await wireFixture({})
    const controller = new AbortController()
    const reason = new Error('caller cancelled discovery')
    controller.abort(reason)
    await expect(callClaudeScopeHook(fixture.config, {}, controller.signal)).rejects.toBe(reason)
    expect(fixture.rpcCalls()).toBe(0)
  })

  it.each([
    { output: {}, receipt: { status: ['projected'] } },
    { output: { hookSpecificOutput: { hookEventName: ['UserPromptSubmit'], additionalContext: 'fact' } }, receipt: { status: 'projected' } },
    { output: { decision: 'block' }, receipt: { status: 'omitted' } },
    { output: { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'fact' } }, receipt: { status: 'projected' } },
  ])('rejects malformed or mismatched Hook output %#', async (result) => {
    const fixture = await wireFixture(result)
    await expect(callClaudeScopeHook(fixture.config, { hook_event_name: 'UserPromptSubmit' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'rpc-response-invalid' })
  })

  it('enforces the complete response byte budget at an exact multibyte limit', async () => {
    const value = { output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '中文🙂' } }, receipt: { status: 'projected' } }
    const fixture = await wireFixture(value)
    const bytes = Buffer.byteLength(JSON.stringify({ type: 'server-response', rpcId: '00000000-0000-0000-0000-000000000000', result: { ok: true, value } }))
    const input = { hook_event_name: 'UserPromptSubmit' }
    expect(await callClaudeScopeHook({ ...fixture.config, maxResponseBytes: bytes }, input, new AbortController().signal)).toEqual(value)
    await expect(callClaudeScopeHook({ ...fixture.config, maxResponseBytes: bytes - 1 }, input, new AbortController().signal))
      .rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('includes the RPC wrapper in the request bound before sending the request', async () => {
    const fixture = await wireFixture({ output: {}, receipt: { status: 'observed' } })
    await expect(callClaudeScopeHook({ ...fixture.config, maxRequestBytes: 200 }, { text: 'x'.repeat(100) }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'request-too-large' })
    expect(fixture.rpcCalls()).toBe(0)
  })

  it('maps missing shared discovery to the existing classified command failure', async () => {
    const fixture = await wireFixture({})
    const failure = await callClaudeScopeHook({
      ...fixture.config, descriptorPath: join(fixture.privateDirectory, 'missing.json'),
    }, {}, new AbortController().signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ClaudeScopeCommandFailure)
    expect(failure).toMatchObject({ code: 'descriptor-unavailable', message: 'descriptor-unavailable' })
    expect(fixture.rpcCalls()).toBe(0)
  })

  it('rejects a redirected login without forwarding the request', async () => {
    const fixture = await wireFixture({}, 302)
    await expect(callClaudeScopeHook(fixture.config, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'authentication-failed' })
    expect(fixture.rpcCalls()).toBe(0)
  })

  it('refuses symlink-shaped capability files', async () => {
    const fixture = await wireFixture({})
    const alias = join(fixture.privateDirectory, 'alias.json')
    await symlink(fixture.descriptorPath, alias)
    await expect(callClaudeScopeHook({ ...fixture.config, descriptorPath: alias }, {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    expect(fixture.rpcCalls()).toBe(0)
  })
})

it('rejects timeouts above the Node timer maximum at configuration', () => {
  expect(() => Config({ descriptorPath: '/fixture/connection.json', maxRequestBytes: 1, maxResponseBytes: 1, timeoutMs: 2147483648 }))
    .toThrow()
})
