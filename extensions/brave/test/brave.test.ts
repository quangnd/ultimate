import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import brave from '../server.ts'
import { braveSearch } from '../client.ts'
import { truncateToolOutput } from '../output.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
})
async function fixture(enabled = true) {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const notice = vi.fn<(message: string) => void>()
  const host = {
    userHome: root,
    notice,
    resource: <T>(_key: string, create: () => T) => create(),
    extensions: () => (enabled ? [{ name: 'secrets', enabled: true, server: {} }] : []),
  } as unknown as ExtensionHost
  const tool = brave(host).tools![0]
  const details = vi.fn<(value: unknown, context: unknown) => Promise<void>>(async () => {})
  const api = { details }
  const run = async (args: unknown, signal?: AbortSignal) =>
    tool.execute(args as never, api as never, { abortSignal: signal } as never)
  return { root, run, details, notice, tool: tool as unknown as { replay: string } }
}
async function fake(
  handler: (
    query: URLSearchParams,
    key: string | undefined,
  ) => {
    status?: number
    data?: unknown
    raw?: string
    headers?: Record<string, string>
    hang?: boolean
  },
) {
  const server = createServer((request, response) => {
    expect(request.method).toBe('GET')
    expect(request.url).toMatch(/^\/web\/search\?/)
    const result = handler(
      new URL(request.url!, 'http://localhost').searchParams,
      request.headers['x-subscription-token'] as string | undefined,
    )
    if (result.hang) return
    response.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
      ...result.headers,
    })
    response.end(result.raw ?? JSON.stringify(result.data))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  vi.stubEnv('ULTIMATE_BRAVE_TEST_URL', `http://127.0.0.1:${address.port}`)
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
}
const result = (n: number) => ({
  title: `Result ${n}`,
  url: `https://example.com/${n}`,
  description: `description ${n}`,
})

it('sends query and count, auth header, and maps title/url/description in rank order; declares a safe-replay tool', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'stored-sentinel')
  const requests: { query: URLSearchParams; key: string | undefined }[] = []
  await fake((query, key) => {
    requests.push({ query, key })
    return { data: { type: 'search', web: { results: [result(1), result(2)] } } }
  })
  const output = await f.run({ query: 'ultimate agent', count: 2 })
  expect(requests[0].query.get('q')).toBe('ultimate agent')
  expect(requests[0].query.get('count')).toBe('2')
  expect(requests[0].key).toBe('stored-sentinel')
  const text = JSON.stringify(output)
  expect(text).toContain('Result 1')
  expect(text).toContain('https://example.com/2')
  expect(text).toContain('not verified page content')
  expect(text.indexOf('example.com/1')).toBeLessThan(text.indexOf('example.com/2'))
  expect(f.details.mock.calls[0][0]).toMatchObject({
    status: 'success',
    results: [
      { url: 'https://example.com/1', title: 'Result 1', description: 'description 1' },
      { url: 'https://example.com/2', title: 'Result 2', description: 'description 2' },
    ],
  })
  expect(f.tool.replay).toBe('safe')
})

it('defaults count to 5 and reports no results for an empty response', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  const requests: URLSearchParams[] = []
  await fake((query) => {
    requests.push(query)
    return { data: { type: 'search', web: { results: [] } } }
  })
  const output = await f.run({ query: 'nothing' })
  expect(requests[0].get('count')).toBe('5')
  expect(JSON.stringify(output)).toContain('No results for: nothing')
})

it('treats a response without a web key as no results, not an error', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ data: { type: 'search' } }))
  const output = await f.run({ query: 'q' })
  expect(output).not.toHaveProperty('isError')
  expect(JSON.stringify(output)).toContain('No results for')
})

it('treats a documented-nullable web (null) and web.results (null) as no results, not an error', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  for (const data of [
    { type: 'search', web: null },
    { type: 'search', web: { results: null } },
  ]) {
    await fake(() => ({ data }))
    const output = await f.run({ query: 'q' })
    expect(output).not.toHaveProperty('isError')
    expect(JSON.stringify(output)).toContain('No results for')
  }
})

it('treats a documented-nullable result description (null or absent) as no description, not an error', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({
    data: {
      type: 'search',
      web: {
        results: [
          { title: 'No description field', url: 'https://example.com/a' },
          { title: 'Null description', url: 'https://example.com/b', description: null },
        ],
      },
    },
  }))
  const output = await f.run({ query: 'q' })
  expect(output).not.toHaveProperty('isError')
  expect(f.details.mock.calls[0][0]).toMatchObject({
    results: [
      { url: 'https://example.com/a', title: 'No description field', description: null },
      { url: 'https://example.com/b', title: 'Null description', description: null },
    ],
  })
})

it('rejects a malformed response shape as an error', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  for (const data of [
    {},
    { type: 'search', web: { results: [{ title: 'no url' }] } },
    { type: 'search', web: { results: [{ url: 'https://example.com', title: 123 }] } },
    { type: 'search', web: 'broken' },
    [],
  ]) {
    await fake(() => ({ data }))
    const output = await f.run({ query: 'q' })
    expect(output).toHaveProperty('isError', true)
    expect(JSON.stringify(output)).toContain('unexpected response shape')
  }
})

it('reports missing key or disabled secrets with one notice', async () => {
  const f = await fixture()
  for (let i = 0; i < 2; i++)
    expect(JSON.stringify(await f.run({ query: 'test' }))).toContain('⌘K → Secrets')
  expect(f.notice).toHaveBeenCalledTimes(1)
  const disabled = await fixture(false)
  await writeSecret(disabled.root, 'BRAVE_API_KEY', 'key')
  expect(JSON.stringify(await disabled.run({ query: 'test' }))).toContain('BRAVE_API_KEY')
})

it('maps 401/403 as rejected credentials with an actionable message', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'secret-sentinel')
  for (const status of [401, 403]) {
    await fake(() => ({ status, data: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } } }))
    const output = await f.run({ query: 'test' })
    expect(output).toHaveProperty('isError', true)
    const text = JSON.stringify(output)
    expect(text).toContain('rejected')
    expect(text).toContain('Secrets panel')
  }
})

it('maps error.code SUBSCRIPTION_NOT_FOUND as rejected credentials regardless of HTTP status', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ status: 422, data: { error: { code: 'SUBSCRIPTION_NOT_FOUND' } } }))
  const output = await f.run({ query: 'test' })
  expect(JSON.stringify(output)).toContain('rejected')
})

it('maps error.code QUOTA_LIMITED as the monthly request quota, not credit or a temporary rate limit', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ status: 429, data: { error: { code: 'QUOTA_LIMITED' } } }))
  const output = await f.run({ query: 'test' })
  const text = JSON.stringify(output)
  expect(text).toContain('quota')
  expect(text).not.toContain('credit')
  expect(f.details.mock.calls[0][0]).toMatchObject({ limitReason: 'quota' })
})

it('maps error.code CREDIT_EXHAUSTED as prepaid/free credit, distinct from the request quota', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ status: 429, data: { error: { code: 'CREDIT_EXHAUSTED' } } }))
  const output = await f.run({ query: 'test' })
  const text = JSON.stringify(output)
  expect(text).toContain('credit')
  expect(text).not.toContain('quota')
  expect(f.details.mock.calls[0][0]).toMatchObject({ limitReason: 'credit' })
})

it('maps error.code RATE_LIMITED as temporary even with a monthly-exhausted header, trusting the code over the header', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({
    status: 429,
    data: { error: { code: 'RATE_LIMITED' } },
    headers: { 'x-ratelimit-remaining': '0, 0' },
  }))
  const output = await f.run({ query: 'test' })
  const text = JSON.stringify(output)
  expect(text).toContain('rate limit')
  expect(text).not.toContain('quota')
  expect(f.details.mock.calls[0][0]).toMatchObject({ limitReason: 'rate-limit' })
})

it('without an error.code, falls back to the rate-limit header only as supporting evidence: a plain 429 is temporary', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ status: 429, data: {} }))
  const output = await f.run({ query: 'test' })
  const text = JSON.stringify(output)
  expect(text).toContain('rate limit')
  expect(text).not.toContain('quota')
  expect(f.details.mock.calls[0][0]).toMatchObject({ limitReason: 'rate-limit' })
})

it('without an error.code, a 429 with X-RateLimit-Remaining reporting 0 for the month is reported as quota, hedged', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ status: 429, data: {}, headers: { 'x-ratelimit-remaining': '1, 0' } }))
  const output = await f.run({ query: 'test' })
  const text = JSON.stringify(output)
  expect(text).toContain('quota')
  expect(text).toContain('appears exhausted')
  expect(f.details.mock.calls[0][0]).toMatchObject({ limitReason: 'quota' })
})

it('never forwards a non-JSON HTTP error body, redacting the key if echoed', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'secret-sentinel')
  await fake(() => ({ status: 502, raw: 'secret-sentinel raw confidential diagnostic' }))
  const output = await f.run({ query: 'test' })
  expect(JSON.stringify(output)).toContain('HTTP 502')
  expect(JSON.stringify(output)).not.toMatch(/secret-sentinel|confidential/)
})

it('redacts the key from a JSON error body (error.detail) it echoes', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'secret-sentinel')
  await fake(() => ({ status: 500, data: { error: { detail: 'bad token secret-sentinel' } } }))
  const output = await f.run({ query: 'test' })
  const text = JSON.stringify(output)
  expect(text).toContain('[redacted]')
  expect(text).not.toContain('secret-sentinel')
})

it('redacts the key from a successful payload that echoes it, in output and details', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'secret-sentinel')
  await fake(() => ({
    data: {
      type: 'search',
      web: {
        results: [
          {
            title: 'echo secret-sentinel',
            url: 'https://example.com/secret-sentinel',
            description: 'contains secret-sentinel',
          },
        ],
      },
    },
  }))
  const output = await f.run({ query: 'test' })
  expect(JSON.stringify([output, f.details.mock.calls])).not.toContain('secret-sentinel')
  expect(JSON.stringify(output)).toContain('[redacted]')
})

it('maps invalid JSON and an empty response as errors', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  let raw: string | undefined
  await fake(() => ({ raw }))
  for (const value of ['not json', 'null']) {
    raw = value
    expect(await f.run({ query: 'test' })).toHaveProperty('isError', true)
  }
})

it('caps output at about 8KiB', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({
    data: {
      type: 'search',
      web: {
        results: Array.from({ length: 20 }, (_, i) => ({
          ...result(i),
          description: 'x'.repeat(5000),
        })),
      },
    },
  }))
  const output = await f.run({ query: 'test' })
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(9 * 1024)
  expect(JSON.stringify(output)).toContain('truncated')
  for (const input of ['ü'.repeat(20000), 'x'.repeat(20000)]) {
    const out = truncateToolOutput(input)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(8 * 1024)
  }
})

it('maps abort, timeout (with and without a caller signal) and network failure without leaking diagnostic errors', async () => {
  await fake(() => ({ hang: true }))
  const controller = new AbortController()
  const request = braveSearch('q', 5, controller.signal, 'key')
  controller.abort()
  await expect(request).rejects.toThrow('cancelled')

  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
    AbortSignal.abort(new DOMException('Timeout', 'TimeoutError')),
  )
  // Without a caller signal: the client's own timeout still fires.
  await expect(braveSearch('q', 5, undefined, 'key')).rejects.toThrow('timed out after 20 seconds')
  // With a caller signal present but not aborted: the timeout still wins, not a generic cancellation.
  await expect(braveSearch('q', 5, new AbortController().signal, 'key')).rejects.toThrow(
    'timed out after 20 seconds',
  )
  vi.restoreAllMocks()

  vi.stubEnv('ULTIMATE_BRAVE_TEST_URL', 'http://127.0.0.1:1')
  await expect(braveSearch('q', 5, undefined, 'key')).rejects.toThrow('Could not reach')
})

it('a cancelled call during the tool run reports cancellation, not a network error', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'key')
  await fake(() => ({ hang: true }))
  const controller = new AbortController()
  const run = f.run({ query: 'test' }, controller.signal)
  controller.abort()
  const output = await run
  expect(JSON.stringify(output)).toContain('cancelled')
})
