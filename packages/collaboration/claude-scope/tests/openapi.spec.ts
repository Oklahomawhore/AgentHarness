import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenApiSources, sampleOpenApiSource } from '../src/openapi.ts'
import type { ClaudeScopeOpenApiSource } from '../src/types.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const directories: string[] = []
const signal = new AbortController().signal
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockReset().mockImplementation(realFs.open)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function document(operation: Record<string, unknown> = {}, version = '3.1.1'): Record<string, unknown> {
  return {
    openapi: version, info: { title: 'Synthetic API', version: '1' },
    paths: { '/items': {
      post: { operationId: 'createItem', responses: { '200': { description: 'Created' } }, ...operation },
    } },
  }
}

function body(schema: unknown, required?: boolean): Record<string, unknown> {
  return { ...(required === undefined ? {} : { required }), content: { 'application/json': { schema } } }
}

async function fixture(value: unknown = document()): Promise<{
  root: string
  outside: string
  source: ClaudeScopeOpenApiSource
  bytes: Buffer
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-openapi-')))
  directories.push(directory)
  const root = join(directory, 'project')
  const outside = join(directory, 'project-other')
  await mkdir(root)
  await mkdir(outside)
  const filePath = join(root, 'api.json')
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  await writeFile(filePath, bytes)
  return { root, outside, source: { name: 'API', filePath, method: 'post', path: '/items' }, bytes }
}

async function expectInvalid(value: unknown, reason: string): Promise<void> {
  const { source, bytes } = await fixture(value)
  expect(await sampleOpenApiSource(source, bytes.length, signal)).toEqual({
    state: 'invalid', sha256: createHash('sha256').update(bytes).digest('hex'), reason,
  })
}

function interceptOpen(action: (file: FileHandle) => void | Promise<void>): void {
  vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    const file = await realFs.open(path, flags, mode)
    await action(file)
    return file
  })
}

describe('explicit OpenAPI file grants', () => {
  it('normalizes an exact existing file while preserving case-sensitive operation identity', async () => {
    const { source, root } = await fixture()
    expect(await resolveOpenApiSources([{ ...source, name: '  API  ' }], [root], signal)).toEqual([source])
    expect(await resolveOpenApiSources([], [root], signal)).toEqual([])
  })

  it('rejects relative paths, directories, missing files, and prefix siblings', async () => {
    const { source, root, outside } = await fixture()
    const external = join(outside, 'api.json')
    await writeFile(external, '{}')
    for (const filePath of ['api.json', root, join(root, 'missing.json'), external]) {
      await expect(resolveOpenApiSources([{ ...source, filePath }], [root], signal)).rejects.toThrow('claude-scope:')
    }
    for (const change of [{ name: ' ' }, { path: 'https://example.test/api' }, { path: '/items?secret=value' }]) {
      await expect(resolveOpenApiSources([{ ...source, ...change }], [root], signal)).rejects.toThrow('require a name')
    }
  })

  it('rejects duplicate logical mappings and aliases for the same file operation', async () => {
    const { source, root } = await fixture()
    const second = join(root, 'second.json')
    await writeFile(second, '{}')
    await expect(resolveOpenApiSources([source, { ...source, filePath: second }], [root], signal)).rejects.toThrow('duplicate')
    await expect(resolveOpenApiSources([source, { ...source, name: 'Other API' }], [root], signal)).rejects.toThrow('duplicate')
    expect(await resolveOpenApiSources([source, { ...source, method: 'put' }], [root], signal)).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')('resolves an in-root link at grant time and rejects an outside target', async () => {
    const { source, root, outside } = await fixture()
    const link = join(root, 'alias.json')
    await symlink(source.filePath, link)
    expect(await resolveOpenApiSources([{ ...source, filePath: link }], [root], signal)).toEqual([source])
    await unlink(link)
    const external = join(outside, 'api.json')
    await writeFile(external, '{}')
    await symlink(external, link)
    await expect(resolveOpenApiSources([{ ...source, filePath: link }], [root], signal)).rejects.toThrow('inside the allowed roots')
  })

  it('cancels before granting any source', async () => {
    const { source, root } = await fixture()
    const controller = new AbortController()
    const reason = new Error('fixture cancellation')
    controller.abort(reason)
    await expect(resolveOpenApiSources([source], [root], controller.signal)).rejects.toBe(reason)
  })
})

describe('bounded OpenAPI declaration samples', () => {
  it('keeps exact field names, status strings and false values from the same hashed bytes', async () => {
    const { source, bytes } = await fixture(document({
      operationId: 'Create項目', deprecated: false,
      requestBody: body({ type: 'object', properties: { name: { type: 'string' } }, required: ['未描述', 'name'] }, false),
      responses: { '201': { description: 'Created' }, '2XX': { description: 'Other success' }, default: { description: 'Other' }, 'x-owner': 'ignored' },
    }))
    expect(await sampleOpenApiSource(source, bytes.length, signal)).toEqual({
      state: 'valid', sha256: createHash('sha256').update(bytes).digest('hex'),
      facts: { operationId: 'Create項目', requestBodyRequired: false, requiredRequestFields: ['name', '未描述'], responseStatuses: ['201', '2XX', 'default'], deprecated: false },
    })
    expect(open).toHaveBeenCalledWith(source.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  })

  it('separates an absent body from object fields and preserves a missing operationId', async () => {
    const { source } = await fixture(document({ operationId: undefined }))
    expect(await sampleOpenApiSource(source, 4096, signal)).toMatchObject({
      state: 'valid', facts: { requestBodyRequired: false, requiredRequestFields: [], responseStatuses: ['200'], deprecated: false },
    })
    const sampled = await sampleOpenApiSource(source, 4096, signal)
    if (sampled.state !== 'valid') throw new Error('fixture should be supported')
    expect(sampled.facts).not.toHaveProperty('operationId')
    await writeFile(source.filePath, JSON.stringify(document({ requestBody: body({ type: 'object', required: [] }, true), deprecated: true })))
    expect(await sampleOpenApiSource(source, 4096, signal)).toMatchObject({
      state: 'valid', facts: { requestBodyRequired: true, requiredRequestFields: [], deprecated: true },
    })
  })

  it('uses schema defaults only when their values are omitted', async () => {
    const { source } = await fixture(document({ requestBody: body({ type: 'object' }) }))
    expect(await sampleOpenApiSource(source, 4096, signal)).toMatchObject({
      state: 'valid', facts: { requestBodyRequired: false, requiredRequestFields: [], deprecated: false },
    })
    await expectInvalid(document({ deprecated: 'false' }), 'unsupported-operation')
    await expectInvalid(document({ requestBody: { ...body({ type: 'object' }), required: 'false' } }), 'unsupported-operation')
  })

  it.each([
    { type: 'object', allOf: [{ required: ['hidden'] }] },
    { type: 'object', $ref: 'https://example.test/private-schema' },
    { type: 'object', $dynamicRef: '#hidden' },
    { type: ['object', 'null'] },
    { type: 'object', nullable: true },
    { type: 'object', dependentRequired: { a: ['b'] } },
    { type: 'object', required: ['a', 'a'] },
    { type: 'object', required: [1] },
    { type: 'object', properties: { a: { type: 'string', readOnly: true } }, required: ['a'] },
    { type: 'object', properties: { a: { type: 'string', writeOnly: true } }, required: ['a'] },
    { type: 'object', properties: { a: { type: 'number', minimum: 1 } } },
    { type: 'object', properties: { a: { type: 'object', required: ['nested'] } } },
    false,
  ])('refuses unsupported schema semantics without presenting partial fields: %j', async (schema) => {
    await expectInvalid(document({ requestBody: body(schema) }), 'unsupported-operation')
  })

  it('refuses references and ambiguous media instead of fetching or choosing a convenient branch', async () => {
    await expectInvalid(document({ requestBody: { $ref: '#/components/requestBodies/Body' } }), 'unsupported-operation')
    await expectInvalid(document({ responses: { '200': { $ref: 'https://example.test/private' } } }), 'unsupported-operation')
    await expectInvalid(document({ requestBody: { content: {
      'application/json': { schema: { type: 'object' } }, 'application/*': { schema: { type: 'object' } },
    } } }), 'unsupported-operation')
  })

  it('distinguishes missing operations, unsupported documents and invalid bytes', async () => {
    await expectInvalid({ ...document(), paths: {} }, 'operation-missing')
    await expectInvalid({ ...document(), paths: { '/items': { get: {} } } }, 'operation-missing')
    await expectInvalid({ ...document(), paths: { '/items': { $ref: '#/components/pathItems/Items' } } }, 'unsupported-operation')
    await expectInvalid(document({}, '3.0.4'), 'unsupported-document')
    await expectInvalid({ ...document(), jsonSchemaDialect: 'https://example.test/dialect' }, 'unsupported-document')
    await expectInvalid({ ...document(), info: undefined }, 'unsupported-document')
    await expectInvalid(Buffer.from('{bad json'), 'invalid-json')
    await expectInvalid(Buffer.from([0xff, 0xfe]), 'invalid-json')
  })

  it.each(['20x', '600', '0200', 'success'])('rejects an invalid response key: %s', async (status) => {
    await expectInvalid(document({ responses: { [status]: { description: 'Unsupported status' } } }), 'unsupported-operation')
  })

  it('counts complete UTF-8 bytes and returns no digest for a partial sample', async () => {
    const { source, bytes } = await fixture(document({ summary: '中文🙂' }))
    expect((await sampleOpenApiSource(source, bytes.length, signal)).state).toBe('valid')
    expect(await sampleOpenApiSource(source, bytes.length - 1, signal)).toEqual({ state: 'unavailable', reason: 'too-large' })
    expect(await sampleOpenApiSource(source, 1, signal)).toEqual({ state: 'unavailable', reason: 'too-large' })
  })

  it('returns no stale facts after deletion or replacement by a directory', async () => {
    const { source } = await fixture()
    await unlink(source.filePath)
    expect(await sampleOpenApiSource(source, 4096, signal)).toEqual({ state: 'unavailable', reason: 'missing-file' })
    await mkdir(source.filePath)
    expect(await sampleOpenApiSource(source, 4096, signal)).toEqual({ state: 'unavailable', reason: 'not-readable' })
  })

  it.skipIf(process.platform === 'win32')('refuses symlink replacement after grant without reading the new target', async () => {
    const { source, outside } = await fixture()
    const external = join(outside, 'private.json')
    await writeFile(external, 'private fixture')
    await unlink(source.filePath)
    await symlink(external, source.filePath)
    expect(await sampleOpenApiSource(source, 4096, signal)).toEqual({ state: 'unavailable', reason: 'changed-during-read' })
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects same-handle modification during sampling and closes the file', async () => {
    const { source } = await fixture()
    let held: FileHandle | undefined
    interceptOpen((file) => {
      held = file
      const stat = file.stat.bind(file)
      let calls = 0
      vi.spyOn(file, 'stat').mockImplementation(async (options) => {
        if (++calls === 2) await writeFile(source.filePath, JSON.stringify(document({ operationId: 'changed' })))
        return await stat(options)
      })
    })
    expect(await sampleOpenApiSource(source, 4096, signal)).toEqual({ state: 'unavailable', reason: 'changed-during-read' })
    expect(held?.fd).toBe(-1)
  })

  it.skipIf(process.platform === 'win32')('rejects replacement of the pathname while holding the original inode', async () => {
    const { source, root } = await fixture()
    let held: FileHandle | undefined
    interceptOpen(async (file) => {
      held = file
      await rename(source.filePath, join(root, 'prior.json'))
      await writeFile(source.filePath, JSON.stringify(document({ operationId: 'replacement' })))
    })
    expect(await sampleOpenApiSource(source, 4096, signal)).toEqual({ state: 'unavailable', reason: 'changed-during-read' })
    expect(held?.fd).toBe(-1)
    expect((await lstat(source.filePath)).isFile()).toBe(true)
  })

  it('rejects cancellation after open and waits for file closure', async () => {
    const { source } = await fixture()
    const controller = new AbortController()
    const reason = new Error('sampling revoked')
    let held: FileHandle | undefined
    interceptOpen((file) => { held = file; controller.abort(reason) })
    await expect(sampleOpenApiSource(source, 4096, controller.signal)).rejects.toBe(reason)
    expect(held?.fd).toBe(-1)
  })

  it('stops at the byte limit when a file grows after the initial stat', async () => {
    const { source, bytes } = await fixture()
    let held: FileHandle | undefined
    interceptOpen((file) => {
      held = file
      const stat = file.stat.bind(file)
      vi.spyOn(file, 'stat').mockImplementationOnce(async (options) => {
        const before = await stat(options)
        await writeFile(source.filePath, Buffer.alloc(bytes.length + 128, 32))
        return before
      })
    })
    expect(await sampleOpenApiSource(source, bytes.length, signal)).toEqual({ state: 'unavailable', reason: 'too-large' })
    expect(held?.fd).toBe(-1)
  })

  it('cancels while an opened-file operation is pending and settles its handle', async () => {
    const { source } = await fixture()
    const controller = new AbortController()
    const reason = new Error('scope revoked during I/O')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held: FileHandle | undefined
    interceptOpen((file) => {
      held = file
      const stat = file.stat.bind(file)
      vi.spyOn(file, 'stat').mockImplementationOnce(async (options) => {
        const before = await stat(options)
        entered.resolve(undefined)
        await release.promise
        return before
      })
    })
    const sampling = sampleOpenApiSource(source, 4096, controller.signal)
    try {
      await entered.promise
      controller.abort(reason)
      release.resolve(undefined)
      await expect(sampling).rejects.toBe(reason)
      expect(held?.fd).toBe(-1)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([sampling])
    }
  })

  it('does not retain filesystem diagnostics or private paths in unavailable samples', async () => {
    const { source } = await fixture()
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error(`EACCES ${source.filePath}`), { code: 'EACCES' }))
    expect(await sampleOpenApiSource(source, 4096, signal)).toEqual({ state: 'unavailable', reason: 'not-readable' })
  })
})
