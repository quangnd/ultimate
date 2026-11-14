Lightweight web search with the Brave Search API (needs a Brave Search API key). It searches the public web through `brave_search` and needs `secrets` on as well; it does not read page content.

Set `BRAVE_API_KEY` in the Secrets panel (⌘K → Secrets), obtained from https://api-dashboard.search.brave.com. Missing or rejected credentials produce a tool error and one process-local notice, never an in-chat credential form.

`brave_search(query, count?)` returns up to `count` results (5 by default, 20 at most), each a title, URL, and description, in Brave's ranking order. These are **search snippets, not verified page content**: to actually inspect a result, open its URL with the `browser` or `screenshot` tool (or `web_fetch` if `parallel` is enabled instead of this extension; the two are not meant to run together).

Calls are read-only and replay-safe, with a 20-second timeout and cancellation. Output is capped at about 8 KiB. Errors are classified from Brave's documented `error.code` (`QUOTA_LIMITED`: the plan's monthly request quota is used up; `CREDIT_EXHAUSTED`: prepaid/free credit is used up, a separate thing from the quota; `RATE_LIMITED`: temporary; `SUBSCRIPTION_TOKEN_INVALID`/`SUBSCRIPTION_NOT_FOUND`: the key was rejected). When a 429 body carries no code, the `X-RateLimit-Remaining` monthly figure is used as supporting evidence only, never on its own for a code-bearing response. `ULTIMATE_BRAVE_TEST_URL` overrides the API base only for local fake-server tests; never set it in production.

Disabled by default, like `parallel`. Its tool name (`brave_search`) does not collide with `parallel`'s (`web_search`, `web_fetch`), but the two give the agent the same capability twice; keep only one enabled to avoid confusing an agent with two web-search tools.
