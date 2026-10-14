/** Real local file operations with a stable display-only workspace label for content-addressed recorded tool evidence. */
import assert from 'node:assert/strict'
import { isAbsolute, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const { LocalFileSystem } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local')).href)

/** Preserve real target identities, path admission and IO; only the human-facing path label is made independent of mkdtemp. */
export default class FixtureFileSystem extends LocalFileSystem {
  async resolve(path, options) {
    const target = await super.resolve(path, options)
    const display = relative(this.config.cwd, target.displayPath)
    if (isAbsolute(display) || display === '..' || display.startsWith(`..${sep}`)) return target
    const result = { ...target, displayPath: `/workspace${display === '' ? '' : `/${display.split(sep).join('/')}`}` }
    assert.equal(result.targetKey, target.targetKey)
    assert.equal(this.processPath(result), super.processPath(target))
    return result
  }
}
