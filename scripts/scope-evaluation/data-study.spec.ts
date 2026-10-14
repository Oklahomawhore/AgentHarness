/** Public workspaces contain the initial policy while parent-only cases detect changed behavior. */
import { describe, expect, it } from 'vitest'
import { executePayment, parseCases, parsePolicy, sealDataArtifact } from './data-artifacts.ts'
import { createDataStudy, parseDataStudyConfig } from './data-study.ts'

const route = { provider: 'deepseek-official', endpointSource: { kind: 'deepseek-official' },
  network: { kind: 'direct' }, model: 'registered-model', endpoint: 'https://api.deepseek.com/',
  apiKeyEnv: 'EVALUATION_API_KEY', credentialsPath: '/nonexistent/selected-credentials.yaml',
  maxCalls: 6, maxInputBytes: 32768, maxOutputTokens: 2048, maxOutputBytes: 16384, timeoutMs: 30000 }
const config = { ordinary: route, semantic: { ...route, maxCalls: 2 }, limits: { contextBytes: 8192,
  maxArtifactBytes: 32768, wallTimeoutMs: 300000, cleanupTimeoutMs: 10000, operationTimeoutMs: 30000 } }

describe('ordinary Agent study registration', () => {
  it('registers routes without consulting the selected credential file and detaches input objects', () => {
    const input = structuredClone(config)
    const parsed = parseDataStudyConfig(input, 'live')
    input.ordinary.model = 'changed'
    input.limits.contextBytes = 2048
    expect(parsed.ordinary.model).toBe('registered-model')
    expect(parsed.limits.contextBytes).toBe(8192)
    expect(parsed.ordinary.credentialsPath).toBe('/nonexistent/selected-credentials.yaml')
  })

  it('requires explicit direct networking or one named proxy reference, including lowercase environment names', () => {
    const ordinary = { ...route, network: { kind: 'env-proxy', urlEnv: 'https_proxy' } }
    expect(parseDataStudyConfig({ ...config, ordinary }, 'live').ordinary.network).toEqual(ordinary.network)
    for (const network of [undefined, { kind: 'unknown' }, { kind: 'direct', urlEnv: 'HTTPS_PROXY' },
      { kind: 'env-proxy' }, { kind: 'env-proxy', urlEnv: '' }, { kind: 'env-proxy', urlEnv: 'bad-name' },
      { kind: 'env-proxy', urlEnv: '1PROXY' }, { kind: 'env-proxy', urlEnv: 'HTTPS_PROXY', url: 'http://secret' }]) {
      expect(() => parseDataStudyConfig({ ...config, ordinary: { ...route, network } }, 'live')).toThrow()
    }
    const local = { ...route, credentialsPath: null, endpoint: 'http://127.0.0.1:12345/v1',
      network: { kind: 'env-proxy', urlEnv: 'https_proxy' } }
    expect(() => parseDataStudyConfig({ ...config, ordinary: local, semantic: local }, 'transport-calibration'))
      .toThrow('requires direct networking')
  })

  it('requires the service identity separately from the production adapter route', () => {
    for (const endpointSource of [undefined, { kind: 'unknown' }, { kind: 'deepseek-official', name: 'ambiguous' },
      { kind: 'openai-compatible-gateway' }, { kind: 'openai-compatible-gateway', name: '' },
      { kind: 'openai-compatible-gateway', name: '  ' }, { kind: 'openai-compatible-gateway', name: 'x'.repeat(129) },
      { kind: 'openai-compatible-gateway', name: 'temorouter', apiKey: 'not-a-credential' }]) {
      expect(() => parseDataStudyConfig({ ...config, ordinary: { ...route, endpointSource } }, 'live')).toThrow()
    }
  })

  it.each(['https://gateway.example/', 'https://gateway.example/v1', 'https://gateway.example/api/v1/',
    'https://gateway.example:8443/custom/v1'])('retains an explicitly named HTTPS gateway and its exact base: %s', (endpoint) => {
    const ordinary = { ...route, endpointSource: { kind: 'openai-compatible-gateway', name: 'temorouter' },
      endpoint, apiKeyEnv: 'OPENAI_API_KEY', credentialsPath: null }
    const parsed = parseDataStudyConfig({ ...config, ordinary }, 'live')
    expect(parsed.ordinary).toEqual(ordinary)
    ordinary.endpointSource.name = 'changed'
    expect(parsed.ordinary.endpointSource).toEqual({ kind: 'openai-compatible-gateway', name: 'temorouter' })
    expect(parsed.semantic.endpointSource).toEqual({ kind: 'deepseek-official' })
  })

  it.each(['http://gateway.example/v1', 'http://127.0.0.1:12345/v1', 'https://gateway.example/v1?key=x',
    'https://gateway.example/v1#fragment', 'https://user:secret@gateway.example/v1'])
  ('refuses a named gateway with an insecure or credential-bearing endpoint: %s', (endpoint) => {
    const ordinary = { ...route, endpointSource: { kind: 'openai-compatible-gateway', name: 'temorouter' }, endpoint }
    expect(() => parseDataStudyConfig({ ...config, ordinary }, 'live')).toThrow()
  })

  it('keeps named-gateway calibration confined to loopback HTTP without credential files', () => {
    const local = { ...route, endpointSource: { kind: 'openai-compatible-gateway', name: 'local-http-calibration' },
      credentialsPath: null, endpoint: 'http://127.0.0.1:12345/v1' }
    const selected = { ...config, ordinary: local, semantic: local }
    expect(parseDataStudyConfig(selected, 'transport-calibration').ordinary).toEqual(local)
    expect(() => parseDataStudyConfig(selected, 'live')).toThrow()
    for (const endpoint of ['https://gateway.example/v1', 'http://gateway.example:12345/v1',
      'http://127.0.0.1/v1', 'https://127.0.0.1:12345/v1', 'http://127.0.0.1:12345/custom/v1']) {
      expect(() => parseDataStudyConfig({ ...selected, ordinary: { ...local, endpoint } }, 'transport-calibration')).toThrow()
    }
    expect(() => parseDataStudyConfig({ ...selected, ordinary: { ...local, credentialsPath: '/any/file.yaml' } },
      'transport-calibration')).toThrow('must not load credential files')
  })

  it.each(['http://api.deepseek.com/', 'https://other.example/', 'https://api.deepseek.com/?key=x',
    'https://user:secret@api.deepseek.com/', 'https://api.deepseek.com/v2', 'https://api.deepseek.com:8443/'])
  ('refuses a live route outside the registered endpoint: %s', (endpoint) => {
    expect(() => parseDataStudyConfig({ ...config, ordinary: { ...route, endpoint } }, 'live')).toThrow()
  })

  it('separates local calibration routes from live routes and rejects secret values and unbounded limits', () => {
    const local = { ...route, credentialsPath: null, endpoint: 'http://127.0.0.1:12345/' }
    expect(parseDataStudyConfig({ ...config, ordinary: local, semantic: local }, 'transport-calibration').ordinary.endpoint)
      .toBe(local.endpoint)
    expect(() => parseDataStudyConfig(config, 'transport-calibration')).toThrow()
    expect(() => parseDataStudyConfig({ ...config, ordinary: { ...local, credentialsPath: '/any/file.yaml' },
      semantic: local }, 'transport-calibration')).toThrow('must not load credential files')
    expect(() => parseDataStudyConfig({ ...config, ordinary: local }, 'live')).toThrow()
    for (const ordinary of [{ ...route, apiKey: 'not-a-credential' }, { ...route, maxCalls: 0 },
      { ...route, maxCalls: 13 }, { ...route, credentialsPath: 'relative.yaml' }, { ...route, timeoutMs: Infinity }]) {
      expect(() => parseDataStudyConfig({ ...config, ordinary }, 'live')).toThrow()
    }
    expect(() => parseDataStudyConfig({ ...config, semantic: { ...route, maxCalls: 1 } }, 'live')).toThrow('both recipient')
    expect(() => parseDataStudyConfig({ ...config, extra: true }, 'live')).toThrow()
  })
})

describe('payment work opportunity and private acceptance cases', () => {
  it('keeps both public baselines equal and permits exactly one distinct artifact per recipient', () => {
    const { runtime, oracle } = createDataStudy(42, parseDataStudyConfig(config, 'live'))
    for (const role of ['B', 'C'] as const) {
      const project = runtime.roles[role]
      expect(project.writableFiles).toEqual([project.artifactPath])
      expect(project.readableFiles.slice().sort()).toEqual(Object.keys(project.initialFiles).sort())
      expect(project.readableFiles).not.toContain(runtime.source.path)
      const publicPolicy = project.initialFiles['public/payment-policy.json']
      const publicCases = project.initialFiles['public/payment-cases.json']
      if (publicPolicy === undefined || publicCases === undefined) throw new Error('public files missing')
      const policy = parsePolicy(sealDataArtifact(publicPolicy))
      const cases = parseCases(sealDataArtifact(publicCases))
      expect(policy.maxRetries).toBe(3)
      for (const item of cases.cases) {
        expect(executePayment(policy, item.input)).toEqual(item.expected)
        expect(executePayment(oracle.reference, item.input)).toEqual(item.expected)
      }
      const visible = JSON.stringify({ goal: project.goal, files: project.initialFiles })
      expect(visible).not.toContain('maxRetries: 1')
      expect(visible).not.toContain('"maxRetries":1')
      for (const input of oracle.hiddenInputs) {
        if (input.body !== null) for (const value of Object.values(input.body)) {
          if (typeof value === 'string' && /^(order|account)-/.test(value)) expect(visible).not.toContain(value)
        }
      }
    }
    expect(runtime.roles.B.initialFiles['public/payment-policy.json']).toBe(runtime.roles.C.initialFiles['public/payment-policy.json'])
    expect(runtime.roles.B.initialFiles['public/payment-cases.json']).toBe(runtime.roles.C.initialFiles['public/payment-cases.json'])
    expect(runtime.roles.B.readableFiles).not.toContain(runtime.roles.C.artifactPath)
    expect(runtime.roles.C.readableFiles).not.toContain(runtime.roles.B.artifactPath)
  })

  it('binds the reference to the successful correction and distinguishes every declared mutant by behavior', () => {
    const { runtime, oracle } = createDataStudy(43, parseDataStudyConfig(config, 'live'))
    const corrected = runtime.source.initialContent.replace(runtime.source.correction.oldString, runtime.source.correction.newString)
    expect(corrected).toBe(runtime.source.expectedContent)
    expect(corrected).toContain(`maxRetries: ${oracle.reference.maxRetries}`)
    expect(corrected).not.toContain(runtime.source.failedEdit.oldString)
    for (const mutant of oracle.mutants) {
      expect(oracle.hiddenInputs.some(input => JSON.stringify(executePayment(mutant.policy, input))
        !== JSON.stringify(executePayment(oracle.reference, input))), mutant.id).toBe(true)
    }
  })

  it('reproduces public data without embedding the seed or private grading inputs in recipient files', () => {
    const parsed = parseDataStudyConfig(config, 'live')
    const first = createDataStudy(20261004, parsed)
    expect(createDataStudy(20261004, parsed)).toEqual(first)
    expect(createDataStudy(20261005, parsed).runtime.roles).not.toEqual(first.runtime.roles)
    const visible = JSON.stringify(first.runtime.roles)
    expect(visible).not.toContain('payment-json-hidden')
    expect(visible).not.toContain('20261004')
    for (const seed of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createDataStudy(seed, parsed)).toThrow('seed')
    }
  })
})
