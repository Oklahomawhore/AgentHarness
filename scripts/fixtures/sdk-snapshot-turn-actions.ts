/** External SDK submissions reconstructed from recorded inbox identities and turn boundaries. */

interface JsonObject {
  [key: string]: unknown
}

interface TurnAction {
  readonly turn: number
  readonly content?: JsonObject[]
}

/**
 * Submit each user message once, including when a blocked turn retains it ahead of a later prompt.
 * @param log - recorded Session JSONL with durable inbox splices.
 * @returns explicit submissions and background turn boundaries in recorded order.
 */
export function turnActions(log: string): TurnAction[] {
  const actions: TurnAction[] = []
  const nextTurn: JsonObject[] = []
  const submittedIds = new Set<string>()
  let current: TurnAction | undefined
  for (const line of log.split(/\r?\n/).filter(value => value.trim() !== '')) {
    const record = JSON.parse(line) as JsonObject
    const data = record.data as JsonObject | undefined
    if (record.type === 'agent/inbox/spliced' && data?.target === 'next-turn') {
      if (typeof data.start !== 'number') throw new Error('SDK snapshot Inbox splice has no start index')
      nextTurn.splice(data.start, typeof data.removedCount === 'number' ? data.removedCount : 0,
        ...Array.isArray(data.inserted) ? data.inserted as JsonObject[] : [])
    }
    if (record.type === 'turn/start') {
      if (typeof data?.turn !== 'number') throw new Error('SDK snapshot turn/start has no turn')
      const submitted = nextTurn.find((message) => {
        if ((message.source as JsonObject | undefined)?.kind !== 'user') return false
        if (typeof message.id !== 'string') throw new Error('SDK snapshot queued user input has no message id')
        return !submittedIds.has(message.id)
      })
      current = { turn: data.turn }
      if (submitted !== undefined && Array.isArray(submitted.content)) {
        submittedIds.add(submitted.id as string)
        current = { ...current, content: submitted.content as JsonObject[] }
      }
    }
    if (record.type === 'turn/end' && current !== undefined) {
      actions.push(current)
      current = undefined
    }
  }
  return actions
}
