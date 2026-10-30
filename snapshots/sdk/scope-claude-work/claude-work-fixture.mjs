/** Owner-admitted Claude reports in real SDK requests; this fixture does not run an external CLI. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expandReportedGrants } from '../../../scripts/scope-evaluation/reported-grant-evidence.mjs'

const require = createRequire(new URL('../../../packages/collaboration/development-task-context/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
const { peerContributionPayloadDigest } = await load('@deepseek-ai/dsh-development-task')

/** Loader fixture identity. */
export const name = 'scope-claude-work-snapshot'
/** Production owner admission, original receiver and persisted request services. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const digest = value => createHash('sha256').update(value).digest('hex')
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const nodeId = 'snapshot-claude-work-owner'
const taskId = 'task-claude-work-snapshot'
const firstText = 'CLAUDE_STOP_FIRST: implementation is ready for review. 中文🙂\n'
const continuedText = 'CLAUDE_STOP_CONTINUED: the check failed; this response may continue.'
const command = 'pnpm test'

/** Admit selected reports, correction and withdrawal before requests from the same receiving Session. */
export async function apply(ctx) {
  const now = Date.now()
  const owner = 'snapshot-human-owner'
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  ctx.developmentTasks.restoreLog([{ nodeId, seq: 1, at: now, taskId, revision: 1, hiddenRoomId: 'room-claude-work-snapshot',
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: 'Review work from another person’s existing Claude session.', scope: 'Selected file, command and Stop reports.' } }])
  const grant = { version: 1, taskId, grantId: 'grant-claude-work-snapshot', generation: 'grant-generation-one',
    ownerPeerId: '12D3KooWCMEyhAgjMNJghrqKxvCpLipFmnepRNXXPBxVrz1VBXVe',
    contributorPeerId: '12D3KooWFCgiTqWhtsJ1Zj49VtnbFN7F3t1NoMhpZHZnQiF5mr3E',
    captureId: 'capture-claude-work-snapshot', captureGeneration: 'capture-generation-one',
    source: { kind: 'claude-work', version: 7, name: 'session-work', tools: ['Write'],
      commands: [{ command, rootIndex: 0 }], stopReports: true }, expiresAt: now + 60000, maxSamples: 5, maxSampleBytes: 8192 }
  const samples = []
  const requests = []
  let receiver
  let sequence = 0
  let sampledTurn = 0
  const admit = async result => {
    const sample = { grant, sequence: ++sequence, sourceId: digest(`claude-work-snapshot/${sequence}`), result }
    const admitted = await ctx.developmentTasks.admitPeerContribution(sample, grant.contributorPeerId)
    assert.equal(admitted.outcome, 'published')
    assert.equal(admitted.receipt.payloadDigest, peerContributionPayloadDigest(sample))
    samples.push({ sample, receipt: admitted.receipt, publication: admitted.publication })
  }
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    assert.equal(turn, sampledTurn + 1)
    assert.ok(turn <= 4)
    if (turn === 1) {
      receiver = agent
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing receiver' })
      await ctx.developmentTasks.checkout({ taskId, participantId, bindingId: 'binding-claude-work-snapshot', sessionLabel: 'Review' })
    } else {
      assert.equal(agent, receiver)
      if (turn === 2) {
        assert.equal((await ctx.developmentTasks.openPeerContribution(grant)).state, 'active')
        await admit({ kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
          fields: { rootIndex: 0, path: 'policy.md', content: 'CLAUDE_FILE: maxRetries=1\n' } })
        await admit({ kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent: 'PostToolUse', omissions: [],
          fields: { rootIndex: 0, command, stdout: 'CLAUDE_CHECK_OK', stderr: '', interrupted: false } })
        await admit({ kind: 'claude-stop-report', version: 7, text: firstText, sha256: digest(firstText), stopHookActive: false })
      } else if (turn === 3) {
        await admit({ kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent: 'PostToolUseFailure', omissions: [],
          fields: { rootIndex: 0, command, error: 'Exit code 7\nCLAUDE_CHECK_FAILED' } })
        await admit({ kind: 'claude-stop-report', version: 7, text: continuedText, sha256: digest(continuedText), stopHookActive: true })
      } else {
        await ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, grant.ownerPeerId)
        const retry = await ctx.developmentTasks.admitPeerContribution(samples[0].sample, grant.contributorPeerId)
        assert.equal(retry.outcome, 'reused')
        assert.deepEqual(retry.receipt, samples[0].receipt)
      }
    }
    sampledTurn = turn
    return decision
  })
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(receiver)
    const events = structuredClone(receiver.session.snapshotEvents())
    const messages = structuredClone(options.messages)
    const visible = messages.filter(message => message.source.kind === 'development-task-context')
    assert.equal(visible.length, 1)
    const frame = visible[0].source
    assert.equal(frame.form, 'snapshot')
    assert.equal(frame.version, 2)
    assert.deepEqual(frame.backend, { id: 'reported-files', revision: '6' })
    const text = body(visible[0])
    assert.ok(Buffer.byteLength(text) <= 12000)
    const encoded = JSON.parse(text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
    const decoded = expandReportedGrants(encoded, frame.backend.revision)
    const publications = ctx.developmentTasks.get({ taskId }).context
    for (const publication of decoded.publications) {
      const original = publications.find(value => value.id === publication.id)
      assert.ok(original)
      const { peerToolObservation: _tool, peerStopReport: _stop, ...literal } = original
      assert.deepEqual(publication, { source: { kind: 'publication', taskId, revision: frame.revision, publicationId: original.id }, ...literal })
    }
    assert.equal(frame.omittedSources.some(value => value.reason === 'budget'), false)
    if (sampledTurn === 1) assert.equal(decoded.publications.length, 0)
    else if (sampledTurn < 4) {
      assert.equal(decoded.publications.length, sampledTurn === 2 ? 3 : 4)
      assert.ok(text.includes('CLAUDE_FILE'))
      assert.ok(text.includes('CLAUDE_STOP_FIRST'))
      assert.equal(text.includes('CLAUDE_CHECK_OK'), sampledTurn === 2)
      assert.equal(text.includes('CLAUDE_CHECK_FAILED'), sampledTurn === 3)
      assert.equal(text.includes('CLAUDE_STOP_CONTINUED'), sampledTurn === 3)
      assert.ok(!text.includes('completed-turn-outcome'))
      assert.ok(!text.includes('"exitCode"'))
    } else {
      assert.equal(decoded.publications.length, 1)
      assert.equal(decoded.publications[0].peerContribution.ended, 'revoked')
      assert.equal(frame.omittedSources.filter(value => value.reason === 'withdrawn').length, 5)
      for (const marker of ['CLAUDE_FILE', 'CLAUDE_STOP_FIRST', 'CLAUDE_STOP_CONTINUED', 'CLAUDE_CHECK_OK', 'CLAUDE_CHECK_FAILED']) {
        assert.ok(!text.includes(marker))
      }
      assert.ok(events.some(event => event.type === 'user/message' && body(event.data).includes('CLAUDE_STOP_FIRST')))
    }
    assert.deepEqual(Session.create(receiver.id, events, receiver.session.header).deriveMessages(), messages)
    assert.equal(await ctx.sessions.flush(receiver.session), true)
    const handle = await ctx.sessionPersistence.open(receiver.id, 'read')
    try { assert.deepEqual((await handle.read()).events, events) } finally { await handle.close() }
    requests.push({ messages, events, header: receiver.session.header, projection: frame, encoded, decoded, publications })
    if (sampledTurn === 4) await writeFile(join(process.cwd(), '.dsh/claude-work-audit.json'), JSON.stringify({ grant, samples, requests }))
    yield* next()
  })
}
