# Ultimate on Windows (native, phase 0)

This is the install and first-run guide for running Ultimate directly on Windows 11 (no WSL, no admin rights). It is a first port: the core works, several features are switched off. A GitHub Actions job (`.github/workflows/windows.yml`) runs the same smoke test on a Windows runner on every push, so a break shows up there first.

## What works and what does not (phase 0)

Works: the web UI, chat with a model, the `bash` tool (through Git Bash), read/write/edit, the durable conversation, and extensions you put in `%USERPROFILE%\.ultimate\extensions`.

Not ready yet:

- Hot reload on save. Changes to extensions and code apply after you stop and start `pnpm start` again. This includes a new user extension.
- The `restart` tool and core swaps after code changes: restart by hand.
- Background commands started by the `bash` tool.
- Worktrees and the lander (branches that land into a clone), so @ultimate's branch workflow is limited.
- The browser and screenshot tools.
- Previews (`instance start`), which also need symlinks.
- Automation scripts.

## Install (no admin)

1. **Node 26 LTS.** Download the zip or the per-user installer from nodejs.org. With the zip, unpack it (for example to `%LOCALAPPDATA%\Programs\node`) and add that folder to your user PATH. Check in a new terminal: `node --version` prints `v26...`.
2. **pnpm 11.8.0:** `npm i -g pnpm@11.8.0`, then `pnpm --version`.
3. **Git for Windows 2.54 or newer, installed for the current user.** Older Git silently ignores the hooks that attribute commits to conversations. The per-user install lands in `%LOCALAPPDATA%\Programs\Git`; `git.exe` is on PATH through its `cmd` folder, while `bash.exe` is not. That is fine: Ultimate finds Git Bash next to `git.exe`.
4. **Long paths:** `git config --global core.longpaths true`.
5. **Clone to a short path**, for example `C:\ult`:

   ```text
   git clone https://github.com/quangnd/ultimate C:\ult
   cd C:\ult
   ```

   A short path keeps you far from the 260 character path limit. The repository's `.gitattributes` makes every checkout use LF line endings, whatever `core.autocrlf` says.

6. `pnpm install`. The first install is slow because Defender scans every file; let it finish.

## Check the machine: the doctor

```text
node scripts\windows-doctor.ts
```

It prints one line per check (`PASS`, `WARN`, `FAIL`, `SKIP`, `INFO`) with the evidence, a fix hint for every `WARN` and `FAIL`, and a verdict on the last line. To send the result back, save it and paste the whole file:

```text
node scripts\windows-doctor.ts > doctor.txt 2>&1
```

The checks that matter most are the last three: they run a native program, a native Node addon and the SQLite module from `node_modules`. If they fail, company policy (AppLocker, WDAC or antivirus) is blocking unsigned `.exe` or `.node` files, and Ultimate cannot start until IT allows that folder.

## Start

```text
pnpm start
```

Ultimate runs on its own repository, opens your default browser at `http://127.0.0.1:4747` (the first free port from 4747 if that one is taken) and prints the URL in the terminal. Add `--no-open`, or set `ULTIMATE_NO_OPEN=1`, to stay in the terminal and open the URL yourself. `Ctrl+C` stops it.

State (conversations, settings, the web bundle) lives in `%USERPROFILE%\.ultimate`. Pi shares `%USERPROFILE%\.pi\agent` for logins and models.

## Log in to a model

- **Claude Code:** install the `claude` CLI and log in with it (`claude`). Ultimate uses it as the `claude-code` provider.
- **GitHub Copilot and the rest:** in Ultimate press `Ctrl+K`, choose **Log in to a provider** and follow the steps.

OpenAI Codex is not available from this laptop, but Ultimate's built-in model families use it by default. The next section remaps them.

## Model families

Ultimate picks a model per job through named families (`tiny` for titles and summaries, `fast`, `review`, `default`). Create `%USERPROFILE%\.ultimate\model-families.json`:

```json
{
  "recent": {
    "families": {
      "default": { "model": "claude-code/claude-opus-5-5" },
      "tiny": { "model": "github-copilot/claude-haiku-5.5", "thinking": "low" },
      "fast": { "model": "github-copilot/claude-sonnet-5.5" },
      "review": { "model": "github-copilot/claude-sonnet-5.5", "thinking": "high" }
    }
  }
}
```

`recent` is what a project without its own families starts from. Press `Ctrl+K`, choose **Model families** to see which models your accounts actually list, and change a family there if a name above is missing.

## Which shell the bash tool uses

Git Bash, found from the folder of `git.exe` (and the usual install folders). To use another `bash.exe`, set `shellPath` in `%USERPROFILE%\.pi\agent\settings.json`:

```json
{ "shellPath": "C:\\path\\to\\bash.exe" }
```

The `bash.exe` in `System32` is the WSL launcher; do not point at it.

## Prove that user extensions load

`test\fixtures\windows-hello` is a tiny extension: a `hello` tool and a marker text in the status line.

```text
Copy-Item -Recurse test\fixtures\windows-hello $env:USERPROFILE\.ultimate\extensions\hello
```

(In PowerShell; the target folder must end up named `hello`.) Stop `pnpm start` and start it again. Then:

- The bottom status line shows `hello-user-extension-marker`.
- Ask the agent "Use the hello tool". The tool result reads `hello from a user extension`.
- `Ctrl+K`, **Extensions…** lists `hello` as a user extension.

If it is missing, send back the terminal output and the doctor report.

## Known limits and risks

- Unsigned `.exe` and `.node` files in `node_modules` may be blocked by company policy. This is the biggest unknown; the doctor tests it first.
- Windows has no process groups like Linux: if you close the terminal window instead of pressing `Ctrl+C`, child processes can stay behind. Check Task Manager for stray `node.exe` and `bash.exe`, and stop Ultimate with `Ctrl+C`.
- Defender makes the first `pnpm install` and the first start slow.
