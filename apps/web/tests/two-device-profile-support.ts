/** Process and read-only evidence helpers for the two-device Web profile calibration. */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { expect } from 'vitest'
import { z } from 'zod'
import type { DevicePreparation } from '../../../scripts/scope-evaluation/two-device-prepare.ts'

const messageSchema = z.looseObject({
  role: z.string(), content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  source: z.looseObject({ kind: z.string(), form: z.string().optional(),
    projection: z.looseObject({ text: z.string() }).optional() }),
})
const requestSchema = z.looseObject({
  version: z.literal(1), index: z.number().int().nonnegative(), sessionId: z.string(),
  turn: z.number().int().positive(), step: z.number().int().positive(), eventCount: z.number().int().positive(),
  prefixSha256: z.string(), header: z.looseObject({ cwd: z.string() }),
  messages: z.array(messageSchema), tools: z.array(z.unknown()), contextBytes: z.number().int().nonnegative(),
  sourceSeqs: z.array(z.object({ kind: z.string(), seq: z.number().int().nonnegative() })),
})
const verificationSchema = z.looseObject({
  version: z.literal(1), final: z.boolean(), status: z.enum(['running', 'passed', 'failed']),
  expectedRequests: z.number().int().positive(), observedRequests: z.number().int().nonnegative(),
  verifiedRequests: z.number().int().nonnegative(), activeStreams: z.number().int().nonnegative(), failures: z.array(z.string()),
  sessions: z.array(z.looseObject({ sessionId: z.string(), latestTurnId: z.number().int().positive().nullable(),
    idle: z.boolean(), eventCount: z.number().int().nonnegative(), path: z.string(),
    bytes: z.number().int().nonnegative(), sha256: z.string(), requestReconstruction: z.literal(true) })),
})
const eventSchema = z.looseObject({ type: z.string(), seq: z.number().int().nonnegative(), data: z.unknown() })

/** An actual frozen model request emitted by the endpoint's observer. */
export type ObservedRequest = z.infer<typeof requestSchema>
/** The endpoint's independently persisted request reconstruction result. */
export type DeviceVerification = z.infer<typeof verificationSchema>
/** An original Session event, read without rewriting or normalizing its data. */
export type PersistedEvent = z.infer<typeof eventSchema>

/** Read the observer's complete request lines after its settlement report.
 * @param device - private endpoint preparation.
 * @returns all original request records in their observed order.
 */
export async function readRequests(device: DevicePreparation): Promise<ObservedRequest[]> {
  const text = await readFile(join(device.evidencePath, 'requests.jsonl'), 'utf8')
  if (text === '') return []
  if (!text.endsWith('\n')) throw new Error('Observer request evidence has an incomplete row')
  return text.trimEnd().split('\n').map(line => requestSchema.parse(JSON.parse(line) as unknown))
}

/** Read the atomic verification result without starting a Session or performing a scope read.
 * @param device - private endpoint preparation.
 * @returns the original observer result.
 */
export async function readVerification(device: DevicePreparation): Promise<DeviceVerification> {
  return verificationSchema.parse(JSON.parse(await readFile(join(device.evidencePath, 'verification.json'), 'utf8')) as unknown)
}

/** Await the exact ordinary turn and number of requests, including durable reconstruction.
 * @param device - private endpoint preparation.
 * @param turn - expected completed ordinary turn.
 * @param requests - cumulative model requests after that turn.
 * @returns the settled verification result.
 */
export async function settled(device: DevicePreparation, turn: number, requests: number): Promise<DeviceVerification> {
  let result: DeviceVerification | undefined
  await expect.poll(async () => {
    result = await readVerification(device)
    if (result.status === 'failed') throw new Error(`Endpoint ${device.role} evidence failed: ${result.failures.join('; ')}`)
    return result.status === 'passed' && result.observedRequests === requests && result.verifiedRequests === requests
      && result.activeStreams === 0 && result.sessions.length === 1
      && result.sessions[0]?.idle === true && result.sessions[0].latestTurnId === turn
  }, { timeout: 30_000 }).toBe(true)
  if (result === undefined) throw new Error('Endpoint has no settled verification')
  expect(result.expectedRequests).toBe(device.expectedRequests)
  return result
}

/** Read the single verified Session from its own endpoint's persistence directory.
 * @param device - private endpoint preparation.
 * @returns the persisted header and complete original events.
 */
export async function persisted(device: DevicePreparation): Promise<{ header: unknown; events: PersistedEvent[] }> {
  const verification = await readVerification(device)
  expect(verification.sessions).toHaveLength(1)
  const session = verification.sessions[0]
  if (session === undefined) throw new Error('Endpoint Session was not persisted')
  const lines = (await readFile(join(device.sessionRoot, session.path), 'utf8')).trimEnd().split('\n')
  const header: unknown = JSON.parse(lines[0] ?? 'null')
  return { header, events: lines.slice(1).map(line => eventSchema.parse(JSON.parse(line) as unknown)) }
}

/** Start the shipped Web profile as a separate process with its private home and explicit keyless patch.
 * @param repo - built repository containing the supported dsh launcher.
 * @param device - endpoint preparation containing no collaborator's filesystem data.
 * @returns its authenticated local URL and a quiescent, idempotent stop operation.
 */
export async function startDevice(repo: string, device: DevicePreparation): Promise<{
  url: string
  pid: number
  stop: () => Promise<void>
}> {
  const env: NodeJS.ProcessEnv = { ...device.environment, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const launch = resolveExampleLaunch({ mode: 'lib', srcBin: join(repo, 'apps/cli/src/bin.ts'), env,
    configArgs: ['--profile', 'web', '--patch', device.overlayPath, '--no-open', '--host', '127.0.0.1', '--port', '0'] })
  const child = spawn(launch.command, launch.args, { cwd: device.workspace, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  void closed.catch(() => undefined)
  const ready = Promise.withResolvers<string>()
  let stdout = ''
  let stderr = ''
  let readyObserved = false
  const redact = (value: string): string => value.replace(/([?&]token=)[^\s&#)]+/gu, '$1[redacted]')
  const timeout = setTimeout(() => {
    ready.reject(new Error(`Endpoint ${device.role} Web readiness timed out: ${redact(stderr)}`))
  }, 90_000)
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-262144)
    const match = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)
    if (match?.[1] === undefined || readyObserved) return
    readyObserved = true
    clearTimeout(timeout)
    ready.resolve(match[1])
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-262144) })
  void closed.then((result) => {
    if (!readyObserved) ready.reject(new Error(`Endpoint ${device.role} exited before Web readiness: ${JSON.stringify(result)} ${redact(stderr)}`))
  }, (error: unknown) => { ready.reject(error) }).finally(() => { clearTimeout(timeout) })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      let forced = false
      let result: { code: number | null; signal: NodeJS.Signals | null } | undefined
      const force = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 15_000)
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        result = await closed
        expect(forced, redact(stderr)).toBe(false)
        expect(result, redact(stderr)).toEqual({ code: 0, signal: null })
      } finally {
        clearTimeout(force)
        await writeFile(join(device.root, 'process-exit.json'), JSON.stringify({ version: 1, pid: child.pid ?? null,
          closeObserved: result !== undefined, code: result?.code ?? null, signal: result?.signal ?? null, forced }, null, 2) + '\n')
        await writeFile(join(device.root, 'stdout.log'), redact(stdout))
        await writeFile(join(device.root, 'stderr.log'), redact(stderr))
      }
    })()
    return stopping
  }
  try {
    const url = await ready.promise
    if (child.pid === undefined) throw new Error('Endpoint Web process has no PID')
    return { url, pid: child.pid, stop }
  } catch (error) {
    try { await stop() } catch (closing) { throw new AggregateError([error, closing], 'Web startup and cleanup failed') }
    throw error
  }
}
