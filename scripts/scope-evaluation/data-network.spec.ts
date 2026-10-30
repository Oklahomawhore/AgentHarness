/** Explicit proxy selection cannot consult ambient proxy defaults or change local coordinator routing. */
import { describe, expect, it } from 'vitest'
import { resolveDataNetwork } from './data-network.ts'

describe('registered model network environment', () => {
  it('leaves direct routes empty without inspecting ambient proxies or requiring Node proxy support', () => {
    const environment = { get HTTPS_PROXY(): string { throw new Error('ambient proxy must not be read') } }
    expect(resolveDataNetwork({ kind: 'direct' }, environment, false)).toEqual({})
  })

  it.each(['http://proxy.example:8080/', 'https://user:fake-password@proxy.example:8443/'])
  ('forwards only the selected proxy and excludes every local coordinator host: %s', (url) => {
    const actual = resolveDataNetwork({ kind: 'env-proxy', urlEnv: 'https_proxy' }, {
      https_proxy: url, HTTPS_PROXY: 'http://unselected.example:9000', HTTP_PROXY: 'http://unselected.example:9001',
      NO_PROXY: '*', OPENAI_API_KEY: 'unselected-test-key',
    }, true)
    expect(actual).toEqual({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' })
  })

  it('rejects missing selected references rather than falling back to another proxy', () => {
    for (const selected of [undefined, '']) {
      expect(() => resolveDataNetwork({ kind: 'env-proxy', urlEnv: 'selected_proxy' },
        { selected_proxy: selected, HTTPS_PROXY: 'http://ambient.example:9000' }, true)).toThrow('selected_proxy is unavailable')
    }
  })

  it('rejects an unsupported Node before resolving its selected reference', () => {
    const environment = { get selected_proxy(): string { throw new Error('proxy must not be read') } }
    expect(() => resolveDataNetwork({ kind: 'env-proxy', urlEnv: 'selected_proxy' }, environment, false))
      .toThrow('requires Node support for --use-env-proxy')
  })

  it.each(['private-value-not-a-url', 'socks5://user:private-value@proxy.example:1080',
    'file:///private-value', 'http://user:private-value@proxy.example/?credential=private-value',
    'https://proxy.example/#private-value'])('rejects invalid proxy values without exposing them: %s', (url) => {
    let message = ''
    try { resolveDataNetwork({ kind: 'env-proxy', urlEnv: 'selected_proxy' }, { selected_proxy: url }, true) } catch (error) {
      if (!(error instanceof Error)) throw error
      message = error.message
    }
    expect(message).toContain('selected proxy must')
    expect(message).not.toContain('private-value')
    expect(message).not.toContain(url)
  })
})
