import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { collectConfigCatalog } from './gen-config-catalog.ts'

const directories: string[] = []
let catalog: ReturnType<typeof collectConfigCatalog>
beforeAll(() => { catalog = collectConfigCatalog() })
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('includes the real public Claude command plugin and its inherited transport limits', () => {
  const command = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-claude-scope/command')
  expect(command?.entry).toBe('packages/collaboration/claude-scope/src/command.ts')
  expect(command?.kind).toBe('config')
  expect(command?.schemaKeys).toEqual(expect.arrayContaining(['descriptorPath', 'maxRequestBytes', 'maxResponseBytes', 'timeoutMs']))
  expect(command?.pastes?.map(paste => paste.text).join('\n')).toContain('Maximum complete Typert response envelope size')
})

it('includes the real facts plugin and its exact responsibility-selection configuration', () => {
  const facts = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-development-task-context/facts')
  expect(facts?.entry).toBe('packages/collaboration/development-task-context/src/facts.ts')
  expect(facts?.kind).toBe('config')
  expect(facts?.schemaKeys).toEqual(expect.arrayContaining(['routes', 'routes[].responsibility', 'routes[].fields', 'unmatchedFields']))
  expect(facts?.pastes?.map(paste => paste.text).join('\n')).toContain('conflicts always retain all fields')
})

it('catalogues the semantic provider route, audit identity, and execution limits', () => {
  const semantic = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-development-task-context/semantic')
  expect(semantic?.kind).toBe('config')
  expect(semantic?.inject).toEqual(['llm', 'sessions', 'sessionPersistence'])
  expect(semantic?.schemaKeys).toEqual(expect.arrayContaining([
    'auditSessionId', 'provider', 'model', 'maxInputBytes', 'maxOutputTokens',
    'maxOutputBytes', 'timeoutMs', 'maxConcurrentCalls', 'maxCalls',
  ]))
})

it.each([
  { name: 'claude-scope', subpath: './command', target: undefined },
  { name: 'claude-scope', subpath: './command', target: null },
  { name: 'development-task-context', subpath: './facts', target: undefined },
  { name: 'development-task-context', subpath: './facts', target: null },
])('rejects an unexported $name $subpath entry ($target)', async ({ name, subpath, target }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-config-subpath-'))
  directories.push(root)
  const directory = join(root, 'packages', 'collaboration', name)
  await mkdir(join(directory, 'src'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/dsh-${name}`, exports: { '.': './lib/index.js', [subpath]: target },
  }))
  await writeFile(join(directory, 'src', 'index.ts'), 'export {}\n')
  expect(() => collectConfigCatalog(root)).toThrow('catalogued plugin subpath is absent from package exports')
})
