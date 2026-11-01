/** Real recorded input retention must not become another external SDK submission. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { turnActions } from './sdk-snapshot-turn-actions.ts'

const recorded = readFileSync(new URL('../../snapshots/sdk/task-context-failure-recovery/writer.expected.jsonl', import.meta.url), 'utf8')

interface RecordedRow {
  readonly type: string
  readonly data?: {
    target?: string
    start?: number
    readonly inserted?: readonly { readonly content: readonly { readonly text?: string }[] }[]
  }
}

it('preserves the two explicit prompts in an existing failure recovery recording', () => {
  expect(turnActions(recorded)).toEqual([
    { turn: 1, content: [{ type: 'text', text: 'Keep my original implementation request.' }] },
    { turn: 2, content: [{ type: 'text', text: 'Continue with the concise current Task.' }] },
  ])
})

it('submits the later prompt instead of resubmitting a retained original message id', () => {
  const events = recorded.trimEnd().split('\n').map(line => JSON.parse(line) as RecordedRow)
  for (const event of events) {
    const data = event.data
    if (event.type === 'agent/inbox/spliced' && data?.target === 'next-step') data.target = 'next-turn'
    if (event.type === 'agent/inbox/spliced' && data?.inserted?.some(message =>
      message.content.some(block => block.text === 'Continue with the concise current Task.'))) data.start = 2
  }
  expect(turnActions(events.map(event => JSON.stringify(event)).join('\n'))).toEqual(turnActions(recorded))
})

it('keeps a second external submission when its text repeats an earlier prompt', () => {
  const repeated = recorded.replaceAll('Continue with the concise current Task.', 'Keep my original implementation request.')
  expect(turnActions(repeated).map(action => action.content)).toEqual([
    [{ type: 'text', text: 'Keep my original implementation request.' }],
    [{ type: 'text', text: 'Keep my original implementation request.' }],
  ])
})
