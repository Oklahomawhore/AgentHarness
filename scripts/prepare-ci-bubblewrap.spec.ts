/** The CI installer fails before sandbox-dependent gates when Ubuntu setup or the namespace probe fails. */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'prepare-ci-bubblewrap.sh')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Command shims observe installer sequencing; the hosted workflow owns the real namespace probe.
describe.skipIf(process.platform === 'win32')('Ubuntu bubblewrap preparation', () => {
  function run(failure: string) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ci-bwrap-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const calls = join(root, 'calls')
    for (const [name, source] of Object.entries({
      sudo: '#!/bin/bash\nexec "$@"\n',
      'apt-get': '#!/bin/bash\nprintf "apt-get %s\\n" "$*" >> "$CALLS"\n[[ "$FAILURE" != "apt-$1" ]]\n',
      sysctl: '#!/bin/bash\nprintf "sysctl %s\\n" "$*" >> "$CALLS"\n[[ "$FAILURE" != sysctl ]]\n',
      bwrap: '#!/bin/bash\nprintf "bwrap %s\\n" "$*" >> "$CALLS"\n[[ "$1" == --version || "$FAILURE" != probe ]]\n',
    })) {
      const path = join(bin, name)
      writeFileSync(path, source)
      chmodSync(path, 0o700)
    }
    const child = spawnSync('bash', [script], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CALLS: calls, FAILURE: failure },
      encoding: 'utf8', timeout: 10000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    return { child, calls: readFileSync(calls, 'utf8').trim().split('\n') }
  }

  it('installs the signed-repository package before requiring the actual namespace probe', () => {
    const result = run('')
    expect(result.child.status, result.child.stderr).toBe(0)
    expect(result.calls).toEqual([
      'apt-get update -q',
      'apt-get install --no-install-recommends -yq bubblewrap',
      'sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      'bwrap --version',
      'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true',
    ])
    expect(result.child.stdout).toContain('bubblewrap functional probe passed')
  })

  it.each([['apt-update', 1], ['apt-install', 2], ['sysctl', 3], ['probe', 5]] as const)(
    'stops after %s fails without reporting successful preparation', (failure, count) => {
      const result = run(failure)
      expect(result.child.status).not.toBe(0)
      expect(result.calls).toHaveLength(count)
      expect(result.child.stdout).not.toContain('functional probe passed')
    },
  )
})
