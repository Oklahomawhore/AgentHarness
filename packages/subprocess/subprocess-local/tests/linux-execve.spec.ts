import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const NONBLOCK = 0x800

beforeEach(() => {
  vi.doMock('node:fs', () => ({ constants: { O_NONBLOCK: NONBLOCK } }))
})

afterEach(() => {
  vi.doUnmock('koffi')
  vi.doUnmock('node:fs')
  vi.resetModules()
})

// Native calls and the Linux status constant are mocked, so these decisions run on every host.
describe('Linux libc execve binding', () => {
  it('preserves inherited stdio, null-terminates argv and envp, and reports execve errno', async () => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number) => {
      if (command === 2 || command === 4) return 0
      return command === 1 ? [1, 0, 5][fd] : [NONBLOCK | 0x400, 0x400, NONBLOCK | 2][fd]
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const load = vi.fn(() => ({ func }))
    const errno = vi.fn(() => 2)
    vi.doMock('koffi', () => ({ default: { errno, load } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    expect(loadLinuxExecve()).toBe(execve)
    expect(load).toHaveBeenCalledExactlyOnceWith(null)
    expect(func.mock.calls).toEqual([
      ['int execve(const char *pathname, const char **argv, const char **envp)'],
      ['int fcntl(int fd, int cmd, int arg)'],
    ])

    let failure: unknown
    try {
      execve('/missing/tool', ['tool', 'literal arg'], { A: '1', EMPTY: '' })
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
      [0, 4, 0x400],
      [1, 1, 0],
      [1, 3, 0],
      [2, 1, 0],
      [2, 2, 4],
      [2, 3, 0],
      [2, 4, 2],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith(
      '/missing/tool',
      ['tool', 'literal arg', null],
      ['A=1', 'EMPTY=', null],
    )
    expect(errno).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'execve',
      path: '/missing/tool',
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("ENOENT: no such file or directory, execve '/missing/tool'")
  })

  it('reports failure to read descriptor flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn(() => -1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF',
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl).toHaveBeenCalledExactlyOnceWith(0, 1, 0)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear close-on-exec before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(-1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO',
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('leaves already blocking stdio status flags unchanged', async () => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((_fd: number, command: number) => command === 1 ? 0 : 2)
    vi.doMock('koffi', () => ({ default: {
      errno: () => 2,
      load: () => ({ func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl }),
    } }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/missing/tool', ['tool'], {})).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0], [0, 3, 0],
      [1, 1, 0], [1, 3, 0],
      [2, 1, 0], [2, 3, 0],
    ])
    expect(nativeExecve).toHaveBeenCalledOnce()
  })

  it.each([3, 4])('reports failure in status operation %s before replacing the process', async (failedOperation) => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, command: number) => {
      if (command === failedOperation) return -1
      return command === 3 ? NONBLOCK | 2 : 0
    })
    const errno = vi.fn(() => 5)
    vi.doMock('koffi', () => ({ default: {
      errno,
      load: () => ({ func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl }),
    } }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO', errno: -5, syscall: 'fcntl',
    }))
    expect(nativeFcntl).toHaveBeenLastCalledWith(0, failedOperation, failedOperation === 4 ? 2 : 0)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })
})
