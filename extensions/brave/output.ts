// Sized for this extension (~8 KiB per the spec), separate from parallel's 50 KiB default: not worth a shared
// `lib/` helper for ~15 lines used twice with different constants.
const MAX_OUTPUT_BYTES = 8 * 1024
const MAX_RESULT_TEXT_BYTES = 1000
const TRUNCATION_NOTICE = '\n[Output truncated to 8KiB.]'

/** Cuts `text` to at most `maxBytes`, UTF-8 safe, never splitting a multi-byte character. */
function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end--
  return text.slice(0, end)
}

/** One result's description, bounded so a handful of long snippets cannot alone blow the total output budget. */
export function truncateResultText(text: string): string {
  return truncateBytes(text, MAX_RESULT_TEXT_BYTES)
}

export function truncateToolOutput(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text
  const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf8')
  return `${truncateBytes(text, budget)}${TRUNCATION_NOTICE}`
}
