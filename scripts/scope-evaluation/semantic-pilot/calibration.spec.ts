/** Built named-profile checks use production DeepSeek HTTP transport and controlled SSE replies, never a model. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const driver = fileURLToPath(new URL('./driver.mjs', import.meta.url))
const enabled = process.env.DSH_SEMANTIC_PILOT_CALIBRATION === '1' && process.platform !== 'win32'
const envelopeSchema = z.object({ model: z.string(), stream: z.literal(true),
  messages: z.array(z.object({ role: z.string(), content: z.string() })) })
const inputSchema = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string() })) })
const resultSchema = z.object({ status: z.string(), streamAttempts: z.number(), dispatchAttempts: z.number(),
  liveModelAttempts: z.number(), liveModelResponseCases: z.number(), completedProjections: z.number(), unknownUsage: z.boolean(),
  cases: z.array(z.object({ id: z.string(), outcome: z.string(), semanticFidelity: z.string() })),
  unattemptedCases: z.array(z.string()) })
const processSchema = z.object({ code: z.number().nullable(), signal: z.string().nullable(),
  timedOut: z.boolean(), interrupted: z.string().nullable() })

async function runDriver(args: string[], credential = false): Promise<{ code: number | null; text: string }> {
  const env = { PATH: process.env.PATH, HOME: tmpdir(), ...credential ? { DEEPSEEK_API_KEY: 'calibration-placeholder-not-a-secret' } : {} }
  const child = spawn(process.execPath, [driver, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; let timedOut = false; let spawnError: Error | undefined
  let killer: NodeJS.Timeout | undefined
  child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString() })
  child.on('error', (error) => { spawnError = error })
  const timeout = setTimeout(() => {
    timedOut = true; child.kill('SIGTERM')
    killer = setTimeout(() => child.kill('SIGKILL'), 10000)
  }, 60000)
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    expect({ timedOut, signal: exit.signal, spawnError }, text).toEqual({ timedOut: false, signal: null, spawnError: undefined })
    return { code: exit.code, text }
  } finally { clearTimeout(timeout); clearTimeout(killer) }
}

async function calibration(mode: 'complete' | 'missing-usage' | 'malformed' | 'deadline', inspect: (run: string, calls: () => number) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'semantic-pilot-calibration-'))
  const requests: unknown[] = []
  const errors: Error[] = []
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const envelope = envelopeSchema.parse(JSON.parse(raw))
      requests.push(envelope)
      expect(request.url).toBe('/chat/completions')
      expect(envelope.model).toBe('deepseek-flash')
      const input = inputSchema.parse(JSON.parse(envelope.messages.at(-1)?.content ?? 'null'))
      if (mode === 'deadline') return
      const reply = mode === 'malformed' ? '{broken-json' : JSON.stringify({ version: 1,
        decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
        updates: [{ text: 'Controlled transport calibration; no semantic quality verdict.',
          sources: input.sources.map(source => ({ sourceId: source.sourceId, quote: source.body.slice(0, 32) })) }] })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frame = (value: unknown): void => { response.write(`data: ${JSON.stringify(value)}\n\n`) }
      frame({ id: 'calibration', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
        choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })
      frame({ id: 'calibration', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...mode === 'missing-usage' ? {} : { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } } })
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => { errors.push(error instanceof Error ? error : new Error(String(error))); response.destroy() })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no assigned TCP port')
    const fixture = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const study = { ...fixture, execution: { kind: 'transport-calibration', endpoint: `http://127.0.0.1:${address.port}`, apiKeyEnv: 'DEEPSEEK_API_KEY' },
      ...mode === 'deadline' ? { semantic: { ...(fixture.semantic as Record<string, unknown>), timeoutMs: 2000 } } : {} }
    const studyPath = join(root, 'study.json'); const run = join(root, 'run')
    await writeFile(studyPath, JSON.stringify(study))
    expect(await runDriver(['prepare', '--repo', repo, '--run', run, '--study', studyPath])).toMatchObject({ code: 0 })
    await inspect(run, () => requests.length)
    expect(errors).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) resolve()
        else reject(error)
      })
    })
    await rm(root, { recursive: true, force: true })
  }
}

async function readResult(run: string, phase = 'execute'): Promise<z.infer<typeof resultSchema>> {
  const processResult = processSchema.parse(JSON.parse(await readFile(join(run, phase, 'process-result.json'), 'utf8')))
  expect(processResult).toMatchObject({ signal: null, timedOut: false, interrupted: null })
  const result = resultSchema.parse(JSON.parse(await readFile(join(run, phase, 'result.json'), 'utf8')))
  expect(result).toMatchObject({ liveModelAttempts: 0, liveModelResponseCases: 0 })
  return result
}

it.skipIf(!enabled)('preflights without HTTP, dispatches exactly six summaries, and refuses a repeated phase', async () => {
  await calibration('complete', async (run, calls) => {
    expect(await runDriver(['preflight', '--run', run])).toMatchObject({ code: 0 })
    expect(await readResult(run, 'preflight')).toMatchObject({ streamAttempts: 0, completedProjections: 0 })
    expect(calls()).toBe(0)
    expect(await runDriver(['execute', '--run', run], true)).toMatchObject({ code: 0 })
    const result = await readResult(run)
    expect(result).toMatchObject({ dispatchAttempts: 6, streamAttempts: 6,
      completedProjections: 6, unknownUsage: false, unattemptedCases: [] })
    expect(result.cases.every(row => row.outcome === 'completed' && row.semanticFidelity === 'unreviewed')).toBe(true)
    expect(calls()).toBe(6)
    const audit = z.object({ events: z.array(z.object({ type: z.string() })) })
      .parse(JSON.parse(await readFile(join(run, 'execute', 'audit-readback.json'), 'utf8')))
    expect(audit.events.filter(event => event.type === 'context/semantic-request')).toHaveLength(6)
    expect(audit.events.filter(event => event.type === 'context/semantic-result')).toHaveLength(6)
    expect(await runDriver(['execute', '--run', run], true)).toMatchObject({ code: 1 })
    expect(calls()).toBe(6)
  })
}, 120000)

for (const mode of ['missing-usage', 'deadline'] as const) {
  it.skipIf(!enabled)(`stops subsequent dispatch after ${mode} and closes the Host without a kill`, async () => {
    await calibration(mode, async (run, calls) => {
      expect(await runDriver(['execute', '--run', run], true)).toMatchObject({ code: 1 })
      const result = await readResult(run)
      expect(result).toMatchObject({ dispatchAttempts: 1, unknownUsage: true })
      expect(result.unattemptedCases).toHaveLength(5)
      expect(calls()).toBe(1)
    })
  }, 90000)
}

it.skipIf(!enabled)('retains malformed model output as failed projections without retrying cells', async () => {
  await calibration('malformed', async (run, calls) => {
    expect(await runDriver(['execute', '--run', run], true)).toMatchObject({ code: 1 })
    expect(await readResult(run)).toMatchObject({ dispatchAttempts: 6, completedProjections: 0, unknownUsage: false })
    expect(calls()).toBe(6)
  })
}, 90000)

it.skipIf(!enabled)('rejects frozen-input changes and invalid flags before network dispatch', async () => {
  await calibration('complete', async (run, calls) => {
    expect(await runDriver(['execute', '--run', run, '--unknown', 'value'], true)).toMatchObject({ code: 1 })
    await writeFile(join(run, 'rubric.json'), '{}\n')
    const result = await runDriver(['execute', '--run', run], true)
    expect(result.code).toBe(1)
    expect(result.text).toContain('Frozen input changed')
    expect(calls()).toBe(0)
  })
}, 90000)

it.skipIf(!enabled)('fails without a credential before entering the production stream', async () => {
  await calibration('complete', async (run, calls) => {
    expect(await runDriver(['execute', '--run', run])).toMatchObject({ code: 1 })
    expect(await readResult(run)).toMatchObject({ streamAttempts: 0, dispatchAttempts: 0, completedProjections: 0 })
    expect(calls()).toBe(0)
  })
}, 90000)

it.skipIf(!enabled)('rejects increased call budgets and nonlocal calibration endpoints during preparation', async () => {
  await calibration('complete', async (run, calls) => {
    const fixture = JSON.parse(await readFile(join(run, 'fixtures.json'), 'utf8')) as Record<string, unknown>
    const invalid = [
      { ...fixture, semantic: { ...(fixture.semantic as Record<string, unknown>), maxCalls: 7 } },
      { ...fixture, execution: { kind: 'transport-calibration', endpoint: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' } },
    ]
    for (const [index, study] of invalid.entries()) {
      const path = join(run, `invalid-${index}.json`)
      await writeFile(path, JSON.stringify(study))
      expect(await runDriver(['prepare', '--repo', repo, '--run', join(run, `rejected-${index}`), '--study', path]))
        .toMatchObject({ code: 1 })
    }
    expect(calls()).toBe(0)
  })
}, 90000)
