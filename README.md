# AI Quick Fix

Adds extension-based Quick Fix actions in the form:

- `Fix With "<name>"`

## Publish To VS Code Marketplace

Publish scripts use `npx` with a temporary Node 20 runtime, so your global Node version does not block packaging/publishing.

1. Confirm `publisher` in `package.json` matches your Marketplace publisher ID.
2. Optional but recommended: add `repository`, `bugs`, and `homepage` links in `package.json`.
3. Create a publisher:
    - Go to https://marketplace.visualstudio.com/manage
4. Create a Personal Access Token (PAT) in Azure DevOps:
    - Scope: `Marketplace (Manage)`
5. Login once from this project:
    - `npm run publish:login -- <publisher-id>`
6. Build and package:
    - `npm run build`
    - `npm run package`
7. Publish:
    - Patch release: `npm run publish:patch`
    - Minor release: `npm run publish:minor`
    - Major release: `npm run publish:major`

Generated `.vsix` files can also be shared directly for manual install.

## Settings

Set these in `settings.json`:

```json
{
    "ai-quick-fix.codex": true,
    "ai-quick-fix.claude": true,
    "ai-quick-fix.codex-cli": false,
    "ai-quick-fix.claude-cli": false,
    "ai-quick-fix.enable-wsl-routes": true,
    "ai-quick-fix.cli-output-mode": "minimal"
}
```

- `ai-quick-fix.codex`: enable/disable Codex quick fix.
- `ai-quick-fix.claude`: enable/disable Claude quick fix.
- `ai-quick-fix.codex-cli`: enable/disable Codex CLI quick fix.
- `ai-quick-fix.claude-cli`: enable/disable Claude CLI quick fix.
- `ai-quick-fix.enable-wsl-routes`: enable/disable WSL route probing and execution.
- `ai-quick-fix.cli-output-mode`: `minimal` (default) shows only route + one-line result; `verbose` shows prompt and captured CLI output.

## Behavior

- Prompt payload is always minimal and includes only:
    - diagnostic message
    - line number
    - content of the error line
- Extension-based fixers validate command availability and fail with explicit missing-command errors.
- No full-context prompt mode and no context-window expansion.
- No configurable Codex command; Codex always uses `chatgpt.implementTodo`.
- CLI fixers are shown only when a working route is detected.
- CLI route discovery checks native command, `bash`, `wsl --exec`, and `wsl bash`, then persists the working route.
- Codex CLI routes prioritize writable execution (`--sandbox workspace-write`) and auto-fallback if output reports a read-only sandbox.
- CLI prompt explicitly asks for one short status line and avoids file/diff echo to reduce output tokens.
- CLI output defaults to minimal one-line summary mode in the extension output channel; enable verbose mode for debugging.

## Hardcoded extension routing

- `Codex`:
    - always sends line-targeted payload `{ fileName, line, comment }` to `chatgpt.implementTodo`
- `Claude`:
    - first tries `claude-vscode.editor.open(sessionId, prompt)` so Claude opens and submits the prompt in chat
    - falls back to `claude-vscode.terminal.open(prompt, ["-p"], "beside")` if editor flow fails
- `Codex CLI`:
    - tries `codex` / `codex-cli` via native, `bash`, `wsl --exec`, and `wsl bash`
    - runs with `exec` and a minimal quick-fix prompt
- `Claude CLI`:
    - tries `claude` / `claude-cli` via native, `bash`, `wsl --exec`, and `wsl bash`
    - runs with `-p` or `--print` and a minimal quick-fix prompt
