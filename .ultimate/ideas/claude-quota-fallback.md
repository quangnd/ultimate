Status: idea

# Auto fallback from Claude Opus to GPT-6.1 Sol on quota exhaustion, back once reset

## The ask

Opus 5.5 runs out of quota (standard plan, limited Claude tokens) and Ultimate just fails until the reset. Can it
fall back to GPT-6.1 Sol automatically, and switch back to Opus once quota returns, without the user changing the
model by hand?

Assessed in branch #716 (2026-11-14), read-only: no code changed.

## What exists today

- `extensions/pause`: a 429 rate limit (one Pi retries) pauses the whole host until Play, optionally auto-Play
  after N minutes. Quota/usage-limit/billing errors are on Pi's no-retry list, so the run just fails instead of
  pausing (`lib/rate-limit.ts:12`, pi-ai's `isRetryableAssistantError`).
- `extensions/models/fallback.ts`: switches a conversation's model, but only when its provider has **no login at
  all** (`fallback.ts:38`). A quota error leaves the login valid, so this never fires for it.
- `extensions/health`: classifies provider errors; it buckets quota/usage-limit text as `capacity`
  (`extensions/health/store.ts:52-57`), the same bucket as "busy, not broken" 429/529 overload, and capacity never
  flags a provider failing. **Don't build quota detection on health's classification — it's designed to stay quiet
  for exactly this error.**
- `extensions/claude-code`: wraps pi-claude-code. It has structured rate-limit info (`rate_limit_info.resetsAt`,
  `pi-claude-code/src/billing.ts:10-18`) but only attaches it as a diagnostic on a message that still **completed**,
  not on the failure. When the account is actually exhausted, pi-claude-code throws its own synthetic error instead
  (`claude-cli.ts:1110-1113`, "Claude Code billing: this request was charged to Claude usage credits instead of
  your plan limits...") and `resetsAt` is not interpolated into that string.

## How a quota error actually looks

No confirmed real-world sample exists on this machine or in this codebase. Searched conversation history for
"usage limit", "usage credits", "limit reached", `rate_limit_event`: **no hits**. The two shapes on record are
synthetic test fixtures:

- Retryable overload (pause test, `extensions/pause/test/pause.test.ts:379`): *"This request would exceed your
  account's rate limit. Please try again later."* — Pi retries this one, `pause` catches it.
- Non-retryable quota (pause test, `pause.test.ts:522`): *"429 You exceeded your current quota
  (insufficient_quota)"* — pi-ai's classifier excludes `insufficient_quota`, `quota exceeded`, `billing`, `usage
  limit reached` from retry, so this just fails the run.

**Risk: detection is unverified.** The pattern any implementation watches for has to be built from pi-ai's generic
classifier text, not a confirmed real Claude message. Expect the first real hit to need a pattern adjustment —
log it raw the first time, don't assume the regex is right.

**Separate case: overage billing.** If the error means Anthropic already charged the request to paid usage
credits instead of the plan (pi-claude-code's specific guard, `billing.ts:31-37`), that's real money on top of the
plan. Switching away is exactly the right call there, more urgently than for a plain wait-for-reset quota error.

## Recommended design (not yet built)

A new extension that detects the non-retryable claude-code billing/quota pattern (via `onCommit`, same approach as
`pause`), then:

- **Switch:** when any conversation on `claude-code/*` hits it, switch **every** conversation currently running on
  claude-code to `openai-codex/gpt-6.1-sol`, recording each one's original model so it can be restored. (The quota
  is one shared Anthropic account — scoping to @ultimate only would leave branches silently failing.)
- **Switch back:** use `resetsAt` when a recent diagnostic has it; otherwise a fixed ~5h window, same timer pattern
  as `pause`'s auto-Play (`extensions/pause/server.ts`, `arm`/`autoPlay`). But don't restore automatically — **ask
  the user first**, since restoring costs a full uncached turn on Opus and the user has limited tokens.
- **Where:** `<project>/.ultimate/extensions/`, not core `extensions/`. This is this fork's quota problem, not a
  general Ultimate feature; keeping it project-local means zero upstream merge conflicts with `HazAT/ultimate` and
  no `divergence-register-rule` memory needed.

Code delta: roughly 300-450 lines across 4-6 files (api/refs/server/README + tests), no `server/`, `shared/` or
`patches/` changes. Reuses `fallback.ts`'s model-write pattern, `pause`'s commit-watching and timer/arm pattern,
`health`'s sanitize word-list for recognizing billing/quota text safely.

## Easier alternative (not chosen, but cheap)

Skip the automatic parts entirely: a one-click "Switch to Sol" action next to the existing pause/autoplay UI, and a
"back to Opus" button the user presses once they know the reset happened. No `resetsAt` plumbing, no timer, no
flapping risk, maybe 40% of the code. Good fallback plan if the auto-detection pattern turns out unreliable in
practice.

## Risks and judgement

| Risk | Judgement |
|---|---|
| Context > 500K when switching to Sol | Acceptable — 500K-window compaction profile already exists (`server/harness.ts:66-73`), just compacts sooner than on Opus's 1M window |
| Prompt-cache loss + uncached first turn each switch | Acceptable — same cost `fallback.ts`'s login-fallback already pays today |
| Tool-id / replay incompatibility across providers | Acceptable — already solved and running in production (`docs/pi-upstream.md`'s tool-id-rewrite patch), proven by `fallback.ts` already moving conversations between claude-code and openai-codex |
| Flapping back and forth | Acceptable only with a one-shot timer (like `pause`'s autoPlay), not retry-and-probe |
| A run already mid-turn | Acceptable — hook only fires on new input, same as `fallback.ts`, a run already in flight just fails once |
| Subscription-to-subscription rule in `fallback.ts` | Not a blocker — both claude-code and openai-codex are marked `isSubscription: true` by Pi, so this switch is exactly what that rule already allows |
| claude-code README's ToS note on rotating accounts | Not a concern here — that note is about dodging limits by switching *accounts*; this is an ordinary model choice, same as picking Sol by hand in the model picker |
| Upstream merge conflicts | Avoided — new extension only imports from `fallback.ts`/`pause`, never edits them, and lives in `.ultimate/extensions/` (not core) |
| **Detection is unverified** (new, from @ultimate's review) | Real risk — no confirmed real Claude quota error text exists anywhere in this codebase or history. First hit should be logged raw and the pattern adjusted from it. Expect one miss. |
| **Overage billing** (new, from @ultimate's review) | If this is what the error means, it's real money, and switching away is unambiguously correct — the card for this feature should say so plainly when it fires. |

## Decisions and picks (agreed, not yet started)

1. **Where it lives:** (a) core `extensions/`; (b) `.ultimate/extensions/`, project-local. **Picked: b.**
2. **Trigger scope:** (a) account-wide — one conversation hitting the limit switches every claude-code
   conversation; (b) per-conversation only. **Picked: a** (quota is shared by the whole account).
3. **Switch-back timing:** (a) fixed ~5h window; (b) use `resetsAt` when present, fall back to (a). **Picked: b.**
4. **Switch-back trigger:** (a) fully automatic; (b) automatic switch-away, ask before switching back.
   **Picked: b** (limited tokens; switching back costs a full uncached turn, so the user decides when to spend it).

User confirmed these picks on 2026-11-14 but said: don't build yet. Parked here until there's a go.
