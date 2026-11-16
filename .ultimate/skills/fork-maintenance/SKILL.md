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
3. Expected conflict spots: `extensions/voice/web.tsx` and the two numbers in `extensions/dream/built-ins.ts`. In
   `.ultimate/settings.json`, keep `lander.checks` as ours: the machine sets those numbers (`diverge-lander-checks`).
   The collapsed write/edit cards (`~/.ultimate/extensions/tool-cards`) and the reviewer-architecture thinking
   (`.ultimate/agents/reviewer-architecture.thinking.md`) are not core: they should never conflict.
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

## When something fails twice

After two identical failures (a landing rejection, a timeout, the same test error), stop and diagnose the cause
before resubmitting. Read the lander's failing output, not just its verdict.
