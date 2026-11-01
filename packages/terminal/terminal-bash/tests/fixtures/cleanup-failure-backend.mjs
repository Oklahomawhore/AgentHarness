/** Exercise real terminal startup error propagation through the shipped tool. */
import { BashTerminalBackend, Config } from '@deepseek-ai/dsh-terminal-bash'
import { SubprocessTerminalCleanupError } from '@deepseek-ai/dsh-subprocess'

export const name = 'pty-startup-cleanup-failure'
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections']
export function apply(ctx) {
  ctx.effect(() => ctx.terminals.registerBackend(new BashTerminalBackend(ctx, Config({ shellPath: 'snapshot-shell', shellArgs: [] }), async () => {
    throw new SubprocessTerminalCleanupError(new Error('process inspection failed'), new Error('terminal exit unconfirmed'))
  })))
}
