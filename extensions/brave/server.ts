import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { braveSearch, BraveApiError } from './client.ts'
import type { BraveResultItem } from './client.ts'
import { truncateResultText, truncateToolOutput } from './output.ts'

export const secrets = [
  {
    name: 'BRAVE_API_KEY',
    description: 'Brave Search API key for web search',
    url: 'https://api-dashboard.search.brave.com',
  },
]
const DEFAULT_COUNT = 5
const MAX_COUNT = 20
const missing =
  'Missing BRAVE_API_KEY or secrets is not enabled. Enable secrets and add BRAVE_API_KEY in the Secrets panel (⌘K → Secrets).'

export default function brave(host: ExtensionHost) {
  const notices = host.resource('brave:missing-key', () => ({ sent: false }))
  async function key() {
    if (
      host
        .extensions()
        .some(
          (extension) =>
            extension.name === 'secrets' &&
            extension.enabled &&
            extension.server &&
            !extension.server.error,
        )
    ) {
      const value = await readSecret(host.userHome, 'BRAVE_API_KEY')
      if (value) return value
    }
    if (!notices.sent) {
      notices.sent = true
      host.notice(missing)
    }
    throw new Error(missing)
  }
  return defineExtension({
    name: 'brave',
    tools: [
      defineTool({
        name: 'brave_search',
        // Repeating a search only reads public web results; it changes no project state.
        replay: 'safe',
        description:
          "Search the public web with the Brave Search API. Returns ranked results (title, URL, description) as search snippets, not verified page content: the description is Brave's excerpt of the page, not a guarantee of what the page currently says. To inspect a result, open its URL with the browser or screenshot tool. Output is limited to about 8KiB.",
        parameters: obj({
          query: str({
            minLength: 1,
            maxLength: 600,
            description: 'The search query, in up to 600 characters.',
          }),
          count: opt(
            int({
              minimum: 1,
              maximum: MAX_COUNT,
              description: `Number of results to return. Defaults to ${DEFAULT_COUNT}, at most ${MAX_COUNT}.`,
            }),
          ),
        }),
        async execute(args, api, context) {
          try {
            const count = args.count ?? DEFAULT_COUNT
            const response = await braveSearch(args.query, count, context.abortSignal, await key())
            const results = summarize(response.web?.results ?? [])
            const details = { status: 'success' as const, query: args.query, results }
            await api.details(details, context)
            const text = results.length
              ? `Search snippets for "${args.query}" (not verified page content; open a URL to inspect it):\n\n` +
                results
                  .map(
                    (result, index) =>
                      `${index + 1}. ${result.title || 'Untitled page'}\nURL: ${result.url}${result.description ? `\n${result.description}` : ''}`,
                  )
                  .join('\n\n')
              : `No results for: ${args.query}`
            return { output: [{ type: 'text', text: truncateToolOutput(text) }] }
          } catch (error) {
            const result = failure(error)
            await api.details(result.details, context)
            return result.output
          }
        },
      }),
    ],
  })
}
function failure(error: unknown) {
  const text = truncateToolOutput(
    error instanceof Error ? error.message : 'Brave Search request failed.',
  )
  return {
    details: {
      status: 'error' as const,
      error: text,
      httpStatus: error instanceof BraveApiError ? (error.status ?? null) : null,
      quotaExhausted: error instanceof BraveApiError ? error.quotaExhausted : false,
    },
    output: { isError: true, output: [{ type: 'text' as const, text }] },
  }
}
function summarize(results: BraveResultItem[]) {
  return results.slice(0, MAX_COUNT).map((item) => ({
    url: item.url.slice(0, 2048),
    title: item.title?.slice(0, 500) ?? null,
    description: item.description ? truncateResultText(item.description) : null,
  }))
}
