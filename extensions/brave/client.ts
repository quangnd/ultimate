const API_BASE_URL = 'https://api.search.brave.com/res/v1'
const REQUEST_TIMEOUT_MS = 20_000

/** `title` and `url` are required; `description` is documented nullable (absent, `null`, or a string). */
export interface BraveResultItem {
  title: string
  url: string
  description?: string | null
}

/** `web` is documented nullable: absent or `null` both mean no web results for the query. */
export interface BraveSearchResponse {
  type?: string
  web?: { results?: BraveResultItem[] | null } | null
}

/**
 * Brave's documented `error.code` values (Web Search API reference, 404/422/429 response schema). `QUOTA_LIMITED`
 * is the plan's request quota used up; `CREDIT_EXHAUSTED` is prepaid/free credit used up; `RATE_LIMITED` is
 * temporary. These are distinct application codes, not interchangeable.
 */
export type BraveErrorCode =
  | 'INTERNAL'
  | 'QUOTA_LIMITED'
  | 'RATE_LIMITED'
  | 'SUBSCRIPTION_TOKEN_INVALID'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'RESOURCE_NOT_ALLOWED'
  | 'OPTION_NOT_IN_PLAN'
  | 'USAGE_LIMIT_EXCEEDED'
  | 'INVALID_URL'
  | 'CREDIT_EXHAUSTED'

export type BraveLimitReason = 'quota' | 'credit' | 'rate-limit' | undefined

export class BraveApiError extends Error {
  constructor(
    message: string,
    status?: number,
    /** What kind of limit the evidence (a documented error.code, falling back to rate-limit headers) actually shows. */
    limitReason?: BraveLimitReason,
  ) {
    super(message)
    this.name = 'BraveApiError'
    this.status = status
    this.limitReason = limitReason
  }
  readonly status?: number
  readonly limitReason: BraveLimitReason
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
 * the monthly quota. Used only as supporting evidence when the body carries no `error.code` of its own; the code,
 * when present, is authoritative (a 429 with QUOTA_LIMITED or CREDIT_EXHAUSTED is decisive either way).
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
 * Brave's Web Search API reference), a `web` object that is documented nullable (absent or `null` both mean no web
 * results), and, if present, an array of result items whose `title`/`url` are required and `description` is
 * documented nullable (absent, `null`, or a string).
 */
function validateResponse(payload: unknown, status: number): BraveSearchResponse {
  if (!record(payload) || typeof payload.type !== 'string')
    throw new BraveApiError('Brave Search API returned an unexpected response shape.', status)
  const web = payload.web
  if (web === undefined || web === null) return payload
  if (!record(web))
    throw new BraveApiError('Brave Search API returned an unexpected response shape.', status)
  const results = web.results
  if (
    results !== undefined &&
    results !== null &&
    (!Array.isArray(results) ||
      !results.every(
        (item) =>
          record(item) &&
          typeof item.title === 'string' &&
          typeof item.url === 'string' &&
          (item.description === undefined ||
            item.description === null ||
            typeof item.description === 'string'),
      ))
  )
    throw new BraveApiError('Brave Search API returned an unexpected response shape.', status)
  return payload
}

/** Decoded, redacted `error.code` and `error.detail` from a Brave error body, per the documented error schema. */
function parseErrorBody(raw: string, apiKey: string): { code?: BraveErrorCode; detail?: string } {
  try {
    const parsed = redact(JSON.parse(raw), apiKey) as {
      error?: { code?: unknown; detail?: unknown }
    }
    const code =
      typeof parsed?.error?.code === 'string' ? (parsed.error.code as BraveErrorCode) : undefined
    const detail =
      typeof parsed?.error?.detail === 'string' ? parsed.error.detail.slice(0, 500) : undefined
    return { code, detail }
  } catch {
    // Non-JSON body: fall through to a generic message, never forwarding its raw, unredacted text.
    return {}
  }
}

function createApiError(
  status: number,
  raw: string,
  headers: Headers,
  apiKey: string,
): BraveApiError {
  // The documented error.code is authoritative when present; Brave's documented status codes are only
  // 404/422/429 (its web-search schema shows no 401/403), so an HTTP status alone is only a fallback below.
  const { code, detail } = parseErrorBody(raw, apiKey)
  if (code === 'SUBSCRIPTION_TOKEN_INVALID' || code === 'SUBSCRIPTION_NOT_FOUND')
    return new BraveApiError(
      'BRAVE_API_KEY was rejected. Replace it in the Secrets panel (⌘K → Secrets).',
      status,
    )
  if (code === 'QUOTA_LIMITED')
    return new BraveApiError(
      "Brave Search monthly request quota is used up (error.code: QUOTA_LIMITED). Wait for the plan's reset or upgrade it.",
      status,
      'quota',
    )
  if (code === 'CREDIT_EXHAUSTED')
    return new BraveApiError(
      'Brave Search prepaid/free credit is exhausted (error.code: CREDIT_EXHAUSTED). Add credit or upgrade the plan.',
      status,
      'credit',
    )
  if (code === 'RATE_LIMITED')
    return new BraveApiError(
      'Brave Search rate limit exceeded. Wait and try again.',
      status,
      'rate-limit',
    )
  if (status === 401 || status === 403)
    return new BraveApiError(
      'BRAVE_API_KEY was rejected. Replace it in the Secrets panel (⌘K → Secrets).',
      status,
    )
  if (status === 429) {
    // No error.code in the body: fall back to the documented rate-limit headers as supporting evidence only.
    const remaining = monthlyRemaining(headers)
    if (remaining === 0)
      return new BraveApiError(
        'Brave Search monthly quota appears exhausted (X-RateLimit-Remaining reports 0 for the month). Wait for the reset or upgrade the plan.',
        status,
        'quota',
      )
    return new BraveApiError(
      'Brave Search rate limit exceeded. Wait and try again.',
      status,
      'rate-limit',
    )
  }
  return new BraveApiError(
    detail
      ? `Brave Search API request failed with HTTP ${status}: ${detail}`
      : `Brave Search API request failed with HTTP ${status}.`,
    status,
  )
}
