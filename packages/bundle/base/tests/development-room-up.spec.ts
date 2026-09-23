import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allNodesHealthy,
  browserCommand,
  composeUpArguments,
  nodeUrls,
  parseArguments,
  parseCredential,
} from '../../../../scripts/development-room-up.mjs'

const launcher = resolve(import.meta.dirname, '../../../../scripts/development-room-up.mjs')

describe('development-room zero-configuration launcher', () => {
  it('parses the closed option set and ignores the package-run separator', () => {
    expect(parseArguments([])).toEqual({
      dryRun: false,
      help: false,
      noOpen: false,
      openAll: false,
      rebuild: false,
    })
    expect(parseArguments(['--', '--no-open', '--open-all', '--rebuild', '--dry-run'])).toEqual({
      dryRun: true,
      help: false,
      noOpen: true,
      openAll: true,
      rebuild: true,
    })
    expect(() => parseArguments(['--unknown'])).toThrow('unknown option')
  })

  it('parses credential values containing equals without exposing them', () => {
    expect(parseCredential('protocol=https\nusername=alice\npassword=a=b=c\n')).toEqual({
      protocol: 'https',
      username: 'alice',
      password: 'a=b=c',
    })
  })

  it('requires exactly three healthy service containers before reuse', () => {
    expect(allNodesHealthy(['a', 'b', 'c'], ['healthy', 'healthy', 'healthy'])).toBe(true)
    expect(allNodesHealthy(['a', 'b'], ['healthy', 'healthy'])).toBe(false)
    expect(allNodesHealthy(['a', 'b', 'c'], ['healthy', 'starting', 'healthy'])).toBe(false)
  })

  it('adds force recreation only for an explicit rebuild', () => {
    expect(composeUpArguments({ rebuild: false })).not.toContain('--force-recreate')
    expect(composeUpArguments({ rebuild: true })).toContain('--force-recreate')
  })

  it('uses each platform default browser opener', () => {
    const [primaryNode] = nodeUrls
    if (!primaryNode) throw new Error('expected at least one development-room node')

    expect(browserCommand('darwin', primaryNode.url)).toEqual({ command: 'open', args: [primaryNode.url] })
    expect(browserCommand('linux', primaryNode.url)).toEqual({ command: 'xdg-open', args: [primaryNode.url] })
    expect(browserCommand('win32', primaryNode.url)).toEqual({
      command: 'cmd',
      args: ['/d', '/s', '/c', 'start', '', primaryNode.url],
    })
  })

  it('dry-runs without Docker or credential access and prints every node URL', () => {
    const output = execFileSync(process.execPath, [launcher, '--dry-run', '--no-open'], { encoding: 'utf8' })
    expect(output).toContain('docker compose')
    expect(output).not.toContain('--force-recreate')
    for (const node of nodeUrls) expect(output).toContain(node.url)
  })
})
