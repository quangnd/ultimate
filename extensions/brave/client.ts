const API_BASE_URL = 'https://api.search.brave.com/res/v1'
const REQUEST_TIMEOUT_MS = 20_000

export interface BraveResultItem {
  title?: string
  url: string
  description?: string
}

export interface BraveSearchResponse {
  type?: string
  web?: { results?: BraveResultItem[] }
}

export class BraveApiError extends Error {
  constructor(
    message: string,
    status?: number,
    /** Whether the evidence (headers or a response field) actually says the monthly quota is exhausted, not just rate-limited for a moment. */
    quotaExhausted = false,
  ) {
    super(message)
    this.name = 'BraveApiError'
    this.status = status
    this.quotaExhausted = quotaExhausted
  }
  readonly status?: number
  readonly quotaExhausted: boolean
}

function redact(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') return value.replaceAll(apiKey, '[redacted]')
  if (Array.isArray(value)) return value.map((item) => redact(item, apiKey))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(apiKey, '[redacted]'),
        redact(item, apiKey),
      ]),
    )
  return value
}

/**
 * `X-RateLimit-Remaining: <burst>, <monthly>` (Brave's rate-limiting guide): the second number is what is left of
 * the monthly quota. Only a 429 with that number present and at zero counts as quota exhaustion; anything else is
 * treated as a temporary burst limit, never guessed from the HTTP status alone.
 */
export function monthlyRemaining(headers: Headers): number | undefined {
  const value = headers.get('x-ratelimit-remaining')
  if (!value) return undefined
  const parts = value.split(',').map((part) => part.trim())
  if (parts.length < 2 || !parts[1]) return undefined
  const monthly = Number(parts[1])
  return Number.isFinite(monthly) ? monthly : undefined
}

export async function braveSearch(
  query: string,
  count: number,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<BraveSearchResponse> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const url = new URL(`${process.env.ULTIMATE_BRAVE_TEST_URL ?? API_BASE_URL}/web/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'x-subscription-token': apiKey,
      },
      signal: requestSignal,
    })
  } catch {
    if (signal?.aborted) throw new Error('Brave Search request was cancelled.')
    if (timeoutSignal.aborted)
      throw new Error(`Brave Search request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`)
    throw new Error('Could not reach the Brave Search API.')
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    if (signal?.aborted) throw new Error('Brave Search request was cancelled.')
    if (timeoutSignal.aborted)
      throw new Error(`Brave Search request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`)
    throw new Error('Could not reach the Brave Search API.')
  }

  if (!response.ok) throw createApiError(response.status, raw, response.headers, apiKey)

  let payload: unknown
  try {
    // Decode first: JSON escaping must not defeat credential redaction.
    payload = raw ? redact(JSON.parse(raw), apiKey) : undefined
  } catch {
    throw new BraveApiError('Brave Search API returned an invalid JSON response.', response.status)
  }
  if (!payload || typeof payload !== 'object')
    throw new BraveApiError('Brave Search API returned an empty response.', response.status)
  return validateResponse(payload, response.status)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/**
 * The response envelope: a plain object with the `type` string the API always sends (`"search"` on success; see
 * Brave's Web Search API reference), an optional `web` object, and an optional array of valid result items. `type`
 * alone rules out `{}` and other unrecognizable bodies a real success response never sends.
 */
function validateResponse(payload: unknown, status: number): BraveSearchResponse {
  if (
    !record(payload) ||
    typeof payload.type !== 'string' ||
    (payload.web !== undefined &&
      (!record(payload.web) ||
        (payload.web.results !== undefined &&
          (!Array.isArray(payload.web.results) ||
            !payload.web.results.every(
              (item) =>
                record(item) &&
                typeof item.url === 'string' &&
                (item.title === undefined || typeof item.title === 'string') &&
                (item.description === undefined || typeof item.description === 'string'),
            )))))
  )
    throw new BraveApiError('Brave Search API returned an unexpected response shape.', status)
  return payload
}

function createApiError(
  status: number,
  raw: string,
  headers: Headers,
  apiKey: string,
): BraveApiError {
  if (status === 401 || status === 403)
    return new BraveApiError(
      'BRAVE_API_KEY was rejected. Replace it in the Secrets panel (⌘K → Secrets).',
      status,
    )
  if (status === 429) {
    const remaining = monthlyRemaining(headers)
    if (remaining === 0)
      return new BraveApiError(
        'Brave Search monthly quota is exhausted (X-RateLimit-Remaining reports 0 for the month). Wait for the reset or upgrade the plan.',
        status,
        true,
      )
    return new BraveApiError('Brave Search rate limit exceeded. Wait and try again.', status)
  }
  // Decode first so redaction sees the real key even if JSON-escaped it, then re-encode a bounded, safe summary.
  let apiMessage: string | undefined
  try {
    const parsed = redact(JSON.parse(raw), apiKey) as { error?: { message?: unknown } }
    if (typeof parsed?.error?.message === 'string') apiMessage = parsed.error.message.slice(0, 500)
  } catch {
    /* Non-JSON body: fall through to a generic message, never forwarding its raw, unredacted text. */
  }
  return new BraveApiError(
    apiMessage
      ? `Brave Search API request failed with HTTP ${status}: ${apiMessage}`
      : `Brave Search API request failed with HTTP ${status}.`,
    status,
  )
}
