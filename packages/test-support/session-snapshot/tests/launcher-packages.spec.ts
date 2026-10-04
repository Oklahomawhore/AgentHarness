import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeProfilePatch } from '../src/launcher.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(packageName: string): { root: string; source: string; link: string } {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-package-'))
  roots.push(root)
  const source = join(root, 'cordis.snapshot.yml')
  writeFileSync(source, JSON.stringify([{ insert: [{ id: 'provider', name: packageName }] }]))
  return { root, source, link: join(root, '.dsh', 'profiles', 'node_modules', packageName) }
}

describe('snapshot profile package resolution', () => {
  it('links its declared replay provider when the authored patch has no package alias', () => {
    const packageName = '@deepseek-ai/dsh-llm-replay'
    const { root, source, link } = fixture(packageName)
    const authoredSearch = createRequire(pathToFileURL(source)).resolve.paths(packageName) ?? []
    expect(authoredSearch.some(path => existsSync(join(path, packageName, 'package.json')))).toBe(false)

    materializeProfilePatch(source, root, root, 0)

    const expected = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-llm-replay/package.json'))
    expect(realpathSync(link)).toBe(realpathSync(expected))
  })

  it('keeps an authored same-name provider ahead of the snapshot dependency', () => {
    const packageName = '@deepseek-ai/dsh-llm-replay'
    const { root, source, link } = fixture(packageName)
    const authoredPackage = join(root, 'node_modules', packageName)
    mkdirSync(authoredPackage, { recursive: true })
    writeFileSync(join(authoredPackage, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.0' }))

    materializeProfilePatch(source, root, root, 0)

    expect(realpathSync(link)).toBe(realpathSync(authoredPackage))
  })

  it('leaves unknown bare packages to installed profile resolution', () => {
    const packageName = '@snapshot-fixture/not-installed'
    const { root, source, link } = fixture(packageName)

    const materialized = materializeProfilePatch(source, root, root, 0)

    expect(existsSync(link)).toBe(false)
    expect(readFileSync(materialized, 'utf8')).toContain(packageName)
  })
})
