Status: idea

# A `web_fetch(url)` tool, borrowing pi-web-access's page-reading pipeline

## Asked

Without web access, coordinators read pages through `browser` and raw HTML, which is slow and costly in tokens.
Brave Search (PR quangnd/ultimate#1, `brave_search`) adds search, but only snippets. The user asked @ultimate to
study https://github.com/nicobailon/pi-web-access (MIT, v0.48.0, commit 896d75b, about 37,500 lines of TypeScript
in 100+ files, 30+ search providers) and decided to park the result as an idea (#41).

## How pi-web-access reads a page (`extract.ts`)

1. Ask for Markdown first (some docs sites serve it).
2. Cap the download at 5 MB. Detect a Cloudflare challenge and report it as blocked, not as an empty page.
3. Parse with `linkedom`, no browser.
4. Run `@mozilla/readability` (Firefox reader mode) to keep the article.
5. Convert to Markdown with `turndown`.
6. If Readability keeps under half the page's visible text, retry with `defuddle` and keep the fuller result.
7. Handle PDFs separately with `unpdf`.

`ssrf-protection.ts` (602 lines) blocks localhost, private and LAN ranges and cloud metadata addresses, including
after redirects.

## Worth borrowing

The fetch → SSRF check → Readability → Markdown pipeline, with a length cap and Cloudflare detection. That is
three dependencies (`linkedom`, `@mozilla/readability`, `turndown`), with MIT attribution in a comment.

## Not worth borrowing

- the 30 providers and their automatic fallback chain;
- `chrome-cookies.ts`, which reads the user's Chrome cookies for Gemini Web, a security risk on a work machine;
- the MCP server, video and YouTube support, and the curator summaries;
- installing the package as is: it targets plain Pi, not Pi Durable (untested), and it brings all of the above
  with it.

## Proposed when picked up

One `web_fetch(url)` tool in its own PR after #1. Rough estimate 250 to 350 lines plus 3 dependencies, not
measured. No paid API. Pages built by JavaScript still go through `browser`.

## Risks

- SSRF, which must be covered from day one;
- sites that block plain fetches (Cloudflare);
- three new dependencies to justify in the commit;
- one more divergence from HazAT/ultimate (record it as a `diverge-*` memory).

## Interim tip

In `browser`, an `eval` step with `document.body.innerText` returns just the visible text.

## Decide after

PR #1 has merged and the user has used Brave for a while. Start with an assessment branch.
