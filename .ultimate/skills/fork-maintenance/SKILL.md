---
name: fork-maintenance
description: 'Keep this fork in step with upstream and register what it changes: merge upstream/main (the user says "sync đi" or presses Update with @ultimate on a diverged clone), and close out any branch that changes core files with a divergence report. Use before merging upstream, and before the final report of a branch that touches core.'
---

# Maintain the fork

This repository is the user's fork: `origin` is `quangnd/ultimate`, where the lander pushes, and `upstream` is
`HazAT/ultimate`. Every core change is a place where an upstream merge can conflict, so each one is registered, and
each merge reads the register.

## What counts as core

`server/`, `shared/`, `web/`, `lib/`, built-in `extensions/`, `agents/`, `skills/`, `scripts/`, and anything else an
upstream merge can conflict with. `.ultimate/extensions/` and `~/.ultimate/` are not core: prefer them over a core
edit, and say in the report why a core edit was needed.

## Closing out a core change

Before your final report, put these facts in it, under the heading `Divergence report`. @ultimate writes them into a
`diverge-<topic>` memory (you do not):

- **What** it changes, in a few lines.
- **Why**: the user's goal.
- **Where**: the commits and your `#conversation`.
- **How to test it**: a command or a flow that fails without the change.
- **Upstream overlap**: the upstream area or file it touches, and whether upstream has something similar.

A change that reworks or drops an earlier divergence says which `diverge-*` memory to update or delete.

## Syncing upstream

1. `git fetch upstream`, then `git merge upstream/main`: a normal merge commit. Never rebase, reset or force-push.
2. Read every `diverge-*` memory (`memory` lists them) before resolving a conflict, then decide per conflict:
   - upstream already does it: drop ours;
   - upstream restructured the area: re-port our intent onto the new code;
   - unrelated: keep both;
   - unsure: ask the user with a card, naming the memory and the two options.
3. Expected conflict spots: `extensions/voice/` (`web.solid.tsx`, `button.solid.tsx`, `server.ts`, `refs.ts`, README and tests: the voice shortcut
   `mod+alt+v` with the `voice.shortcut` user setting, and Send; upstream declined PR #195, so this carry is permanent;
   upstream also edits voice's imports and README, so merge those into our version). A personal or project facet still
   written in React (`web.tsx`) shows an error card after a merge: move it with `extensions/README.md` "Moving a React
   facet to Solid". In
   `.ultimate/settings.json`, keep `lander.checks` as ours: the machine sets those numbers (`diverge-lander-checks`).
   Keep `modelFamilies` as ours too unless `ultimate.models()` lists the models upstream names: a merge once moved
   review and fast to `gpt-6.2-*`, which this machine's catalog does not have.
   The collapsed write/edit cards (`~/.ultimate/extensions/tool-cards`), the reviewer-architecture thinking
   (`.ultimate/agents/reviewer-architecture.thinking.md`) and the Dream thresholds are not core: they should never
   conflict. The thresholds (55% and 35%) live in the Automations panel, and since upstream 34dcbea1 a new chapter
   keeps them; if a Fall asleep ever resets them to 70 and 50, edit both again in the panel.
   Agent files load in sorted order and an overlay needs its base loaded first, so the overlay's name must sort
   after `reviewer-architecture.md`: do not rename it to sort earlier (`reviewer-architecture-thinking.md` does).
4. Check that each local change survived: `git diff upstream/main --stat` lists only what the fork adds, and each
   `diverge-*` memory's change is in it.
5. Run `pnpm check` and the tests of the files you resolved by hand (`pnpm test <path>`). Then type-check the personal
   extension against the merged clone: `node scripts/check-extension.ts ~/.ultimate/extensions/tool-cards`. A
   failure means upstream changed `@/sdk`, `Tool` or `ToolHeader`: fix the extension, which is outside the repository,
   and check once that a streaming write or edit card stays closed and a finished edit opens (it relies on upstream's
   `Write` closing when it first renders after streaming and on `Edit`'s `defaultOpen`).
6. In the report, say whether landing the merge needs a restart: yes when `server/`, `shared/`, `patches/` or
   `pnpm-lock.yaml` changed against the previous main (`git diff --stat HEAD~1 -- server shared patches pnpm-lock.yaml`
   on the merge commit), otherwise no. Tell @ultimate which `diverge-*` memories are now stale or dropped.

## Before you submit (pre-flight)

The lander reads `lander.checks` from the host checkout's `.ultimate/settings.json` (main), never from your branch. A
change to that block on your branch does nothing for your own landing: ask @ultimate to commit it on main first, then
merge main into your branch.

Main's checks are two commands: `pnpm check` (120 s), then `VITEST_MAX_WORKERS=4 pnpm test:affected` (1500 s).
`test:affected` takes only a base argument, so a reporter flag such as `--reporter=verbose` cannot be passed to it
(`scripts/test.ts`). A sync, and any change under `lib/`, `server/` or `shared/`, runs both whole suites inside that
one check.

1. Compare main's checks with yours: `git -C <host clone> show HEAD:.ultimate/settings.json` against your copy. If
   they differ, merge main into your branch before submitting, or the lander's own merge conflicts on that block.
2. Check the load: `uptime`. This machine idles around 30 (WindowServer, Chrome). Submit only when the 1-minute load
   is below 35 and `mds_stores` is quiet (`ps -Ao pcpu,comm -r | grep mds_stores`).
3. Run `pnpm test:affected` yourself before submitting, and the e2e tests of every file you resolved by hand
   (`pnpm test:e2e <path>`), so a real failure shows up here first.

## When the lander rejects

After the first rejection, read the lander's failing output (lander conversation, `ultimate.lander` entries), not just
its verdict, and decide which kind it is:

- **A test fails on an assertion** in an area the merge touched: a real failure. Fix it.
- **Timeouts or hook timeouts in tests the merge did not touch**: possibly load, but only provisionally. Run one
  failing test alone on your branch and on main. It counts as load only if it passes alone on both; then resubmit once
  when the load is below 35. If it fails alone, it is one of the other causes seen so far:
  - a branch setting the lander ignores (the lander uses main's `lander.checks`, not yours);
  - the 120 s stall guard (`Stalled: no output for 2 min`): a silent run was stopped, so look for a test or check that
    prints nothing for two minutes;
  - a total-time cap: the check hit its `timeout` while tests were still passing (raise it on main, not on the branch);
  - a platform-only test bug, such as a shortcut test that presses `Control+k` where macOS needs `mod+k`.

After two rejections, stop. Report to @ultimate with the failing tests, the load at the time, and the kind above. Do
not change the lander settings or resubmit until it answers.
