Status: idea

# Size the fast suite's workers and concurrency to the machine

## Asked

Landings kept failing on a docs-only change because `pnpm test` timed out (#716, five submissions). The user asked
for the root cause (#4260). The fix that landed is a settings change only: `.ultimate/settings.json` runs the lander
checks one after the other, with `pnpm test --maxWorkers=4` and total limits of 300 s and 360 s. The core changes
below were parked.

## Found (an 8-core Apple M1: 4 performance + 4 efficiency cores, 16 GB, swap already in use)

- The lander ran `pnpm test` and `pnpm test:e2e` at the same time, each capped at 180 s. Alone they take about 165 s
  and 204 s; together about 400 s with a load average above 250. Spotlight was not the cause: none of the test
  directories is indexed, and a `.metadata_never_index` file inside a folder is not honored.
- `vite.config.ts` fixes `maxWorkers: 8`, chosen upstream (035b2870) for a 52 s suite. Here 8 workers oversubscribe
  the efficiency cores: 168 s and 3 tests over 30 s, against 161 s and none with 4 workers.
- The tests that exceed 30 s are in files that use `it.concurrent` (extension-enablement, onboarding, conversations,
  lineage). Vitest's default `maxConcurrency` is 5 per worker, so 8 workers can start up to 40 test servers at once.
  On those 9 files, defaults gave 1 timeout; `--maxConcurrency=2` and `--maxWorkers=4` gave none, in about the same time.

## Options when picked up

- `maxWorkers: Math.min(8, availableParallelism() / 2)` in `vite.config.ts` (one line).
- `maxConcurrency: 2` in the same config (one line).
- Either would also help other machines with 8 or fewer cores, and could go upstream as a separate pull request.
  Risk: a slower suite on larger machines, and `pnpm test` must stay fast for CI.

## Revisit when

A landing fails on a test timeout even with the settings fix, or a branch's hand-run `pnpm test` collides with a
landing. A per-machine `VITEST_MAX_WORKERS=4` (honored by Vitest over the config) is the zero-code step before this.
