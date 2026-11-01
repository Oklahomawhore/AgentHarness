/** Real shell startup over deterministic in-memory PTY output for transcript snapshots. */

import { PassThrough } from 'node:stream'
import { BashTerminalBackend, Config } from '@deepseek-ai/dsh-terminal-bash'

function terminalHandle() {
  const output = new PassThrough()
  const completion = Promise.withResolvers()
  let closed = false
  return {
    pid: 1,
    output,
    done: completion.promise,
    write: async () => {},
    inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
    signalForeground: async () => 1,
    terminate: async () => {
      if (closed) return
      closed = true
      output.end()
      completion.resolve({ exitCode: 0, signal: null })
    },
  }
}

class SnapshotSession {
  motd = ''
  statusValue = { kind: 'running' }
  scrollback = 'dsh> '
  startupStep = 0

  constructor(terminal) {
    this.terminal = terminal
  }

  startSend(request) {
    let viewport
    let waitReason = 'stdin_read'
    if (this.startupStep < 2) {
      const first = this.startupStep++ === 0
      viewport = first ? 'dsh> ' : ''
      waitReason = first ? 'inferred_idle' : 'stdin_read'
    } else {
      viewport = `${request.text}\nPTY_OK\ndsh> `
      this.scrollback += viewport
    }
    const result = {
      viewport,
      waitReason,
      sessionStatus: this.statusValue,
      truncated: false,
    }
    let consumed = false
    return {
      done: Promise.resolve(result),
      readOutput: () => {
        if (consumed) return { delta: '', truncated: false }
        consumed = true
        return { delta: viewport, truncated: false }
      },
      cancel: () => false,
    }
  }

  read(request) {
    const lines = this.scrollback.split('\n')
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    const end = lines.length - offset
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join('\n')
    return { text, totalLines: lines.length, lineBegin: offset, lineEnd: offset + text.split('\n').length, truncated: false }
  }

  signal() {
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status() {
    return this.statusValue
  }

  close() {
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    return this.terminal.terminate()
  }
}

/** Cordis plugin name. */
export const name = 'pty-snapshot-backend'
/** Registry and policy services used by the real shell startup. */
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections']

/** Register the deterministic snapshot backend. */
export function apply(ctx) {
  ctx.effect(() => ctx.terminals.registerBackend(new BashTerminalBackend(
    ctx,
    Config({ shellDialect: 'pwsh', shellPath: 'snapshot-pwsh', shellArgs: ['-NoLogo', '-NoProfile'] }),
    async () => terminalHandle(),
    terminal => new SnapshotSession(terminal),
  )))
}
