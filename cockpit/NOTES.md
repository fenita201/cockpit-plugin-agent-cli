# NOTES: verification results

Verified on 2026-10-15 on WSL2, Ubuntu 26.04.1, Cockpit 360-1 (Python bridge), node via nvm v24.21.0 (target runtime: node 22).
A fuller version lives in `guide/02-verified-findings.md`, outside the repo.

## Upstream baseline (before any changes)

- `npm run typecheck`: **1 pre-existing error** in `src/modules/sidebar/tests/recentConversationTitleSync.test.ts(50,67)` (missing `backgroundSessionIds`). Not related to the fork.
- `npm test` (server): 619 tests, 618 pass, 1 skip, 0 fail.
- `npm run test:client`: 106 files, 730 tests pass.
- `npm run build:server`: OK, outputs `dist-server/{server,shared}`.

## Transport

- `http-stream2` supports `unix`. The bridge buffers the request body until it receives `done`. The response streams chunk by chunk (real-time SSE). The `response` control (status + headers) arrives before the body.
- A connection error to the socket → channel `close` with `problem: "not-found"`.
- **`websocket-stream1` does NOT exist** on the Python 360 bridge (`close problem:not-supported`). A `stream` + `unix` + `binary` channel does work, so WebSocket is implemented by hand (RFC 6455) on that channel. Tool: `guide/tools/bridge-probe.py`.
- `cockpit.http()` in cockpit.js: the `.stream()` callback only runs for 2xx status; for non-2xx the promise rejects with the body in the 2nd argument → not enough for the fetch shim. **Decision:** the fetch shim uses `cockpit.channel({payload:'http-stream2', unix, binary:true, method, path, headers})` directly, with `channel.send(Uint8Array)`, `channel.control({command:'done'})`, and the events `control` (command `response`), `message`, `close`.
- `cockpit.channel({binary:true})` sends `binary:"raw"` to the bridge; `send(Uint8Array)` and `message` receive `Uint8Array`.
- Already built into `cockpit.channel`: `flow-control: true`.

## CSP

`cockpit/packages.py` (`get_content_security_policy`) takes the default `default-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; font-src 'self' data:; img-src 'self' data:`, then the `content-security-policy` key in the manifest **overrides it directive by directive**. It applies only to HTML. We need `script-src 'self' blob:` (plugins load through `import(blobURL)`) and `worker-src 'self' blob:`.
Conclusion on `'unsafe-eval'`: see the "CSP: test results" section at the end of the file (updated in Phase 2).

## IS_PLATFORM (all files)

| File | Behavior when `IS_PLATFORM=true` | Decision |
|---|---|---|
| `server/modules/auth/auth.middleware.ts` | Uses `userDb.getFirstUser()` instead of JWT for HTTP and WS | Keep. Needs `ensurePlatformUser()` |
| `server/modules/websocket/services/websocket-auth.service.ts` | Skips the WS token check | Keep |
| ~~`server/modules/agent/agent.routes.ts`, `agent.module.ts`~~ | `/api/agent` trusts the request and uses the first user (no API key needed) | The whole agent module (Agent API for external automation) was deleted |
| ~~`server/modules/browser-use/browser-use-runtime.ts`~~ | `cloud` mode instead of `local` | The whole browser-use module was deleted |
| `server/index.ts`, `server/shared/utils.ts` | Only pass the flag along | Keep |
| `src/shared/api.ts`, `useFileTreeUpload.ts` | Do not send a bearer token | Keep |
| `src/shared/context/WebSocketContext.tsx`, `shell/utils/socket.ts` | WS URL has no `?token=`, built from `window.location.host` | Keep; the shim matches by path |
| `src/modules/auth/*` (ProtectedRoute, AuthContext, AuthScreenLayout) | Skips the login screen | Keep (wanted) |
| `src/modules/provider-auth/ProviderLoginModal.tsx` | Login project path = `/workspace` (does not exist); codex uses `--device-auth` | **Patch** `/workspace` → `''` when `IS_COCKPIT` (the server falls back to `process.cwd()`, and ensure sets cwd = `$HOME`). Keep `--device-auth` |
| `src/modules/mcp/McpServers.tsx` | Hides `TeamMcpFeatureCard` | Keep |
| `src/modules/sidebar/SidebarHeader.tsx` | The logo is a link to cloudcli.ai/dashboard | **Patch** to wrap the link only when not in cockpit |
| `src/modules/sidebar/SidebarFooter.tsx`, `GitHubStarBadge.tsx`, `AboutTab.tsx` | Hide the brand line / star / About section | Keep |
| ~~`src/modules/version-upgrade/`, `src/shared/hooks/useVersionCheck.ts`~~ | Update modal, calls `api.github.com` | Deleted (the self-update feature was removed) |

## plugins.json and bundled plugins

- File: `~/.claude-code-ui/plugins.json`, shaped `{ "<name>": { "enabled": bool, ... } }`, written with mode 0600.
- `scanPlugins()` treats a plugin as enabled when `config[name]?.enabled !== false` → a plugin with no key is **enabled by default**; no script is needed to enable it.
- `entry.isDirectory()` excludes symlinks → patched (see PATCHES).
- `resolvePluginAssetPath` uses `realpathSync` on both sides, so a symlink to `/usr/lib/agent-ui/plugins/<name>` still passes the traversal check.
- Both plugins: built with `tsc`, have only devDependencies, `server.listen(0,'127.0.0.1')`.

## Backend runtime files

- `findApplicationRoot()` walks up to the nearest `server` directory; if its parent is `dist-server`, it takes the parent of that. Staging `app/dist-server/server/index.js` → root = `app/`.
- The backend reads from `APP_ROOT`: `package.json` (version, system routes, cli), `.env` (optional; if missing it only logs), `public/` and `dist/` (static, used only for standalone). `shared/` is built by tsc into `dist-server/shared`.
- Cockpit: does **not** copy `public/` or `dist/`; every path that does not match returns 404 instead of a Vite redirect.
- The cockpit backend also reads `cockpit/features.json` (staging copies it to `app/cockpit/features.json`).

## Claude/Codex binaries

`server/modules/providers/list/claude/claude-runtime.provider.js:232-238` only sets `pathToClaudeCodeExecutable` on Windows; on Linux the SDK uses the binary bundled with `@anthropic-ai/claude-agent-sdk`. The `claude` CLI (login, shell) comes from the backend's `PATH` → `$HOME/.local/bin` is put first.

## Linger

`Linger=no`, `UserStopDelaySec=10`: when the last session closes, the user manager shuts down and kills the backend. polkit `set-self-linger` lets the user enable it themselves (`allow_any=yes`). `agent-ui-ensure` runs `loginctl enable-linger` itself (turn off with `AGENT_UI_LINGER=0`) and writes the marker `~/.cloudcli/agent-ui-linger-enabled` so uninstall can undo it.

## Operational notes

- `MemoryMax` takes effect on this machine (`user@1000.service` delegates `cpu memory pids`). On other machines, check `cat /sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`.
- `AF_UNIX` path ≤ 108 bytes.
- The shell (pty) is tied to the WebSocket; the watchdog counts WS (`wss.clients`) + running chat runs, and does not count orphaned ptys.


## CSP: test results (Phase 2)

Removed `'unsafe-eval'` from `script-src`: the app, editor (CodeMirror), Files, Shell (xterm) and plugins (imported via blob) all work normally. Grepped the bundle: `mermaid`, `cytoscape` and the main bundle contain no `eval(` or `new Function(`. `connect-src 'self' blob: data:` is enough because all traffic goes through Cockpit channels (no `ws:`/`wss:`).
The only CSP error left is intended: `api.github.com` (GitHubStarBadge) is blocked.

## How to test in a browser (no Cockpit login needed)

`cockpit/test/e2e/harness.mjs` serves the built package at a fake origin (`https://cockpit.test`), attaches the same CSP that Cockpit would send (computed from the manifest like `packages.py`), and replaces `cockpit.js` with a fake that has `http-stream2`/`stream` channels and `spawn()`, running Node-side to the backend's real unix socket. No network port is opened. Needs Playwright (`PLAYWRIGHT_DIR`); it runs on Ubuntu 26.04 with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright install chromium-headless-shell`.
This tests: bundle + shim + real backend + CSP. It does not test: cockpit-ws/iframe/login (tested separately with `guide/tools/bridge-probe.py` against the real cockpit-bridge).

## Note for testing: Shell tab

A project's Shell tab opens **a session of the selected provider** (Codex/Claude), not a plain bash. Typing there sends a prompt to the real agent. For a plain shell, use the Terminal plugin.

## Model catalogs (updated 2026-10-15)

- Upstream (v1.37.4, still the latest tag) uses a hand-written model list. On this machine: Claude shows "Fable 5"; Codex has `gpt-5.4`/`gpt-5.5`/`gpt-5.4-mini`, which the ChatGPT account rejects, and lacks `gpt-6.1-sol` (the default of CLI 0.162).
- **Claude:** `query({ prompt: <stream that never yields>, options: { persistSession: false } }).supportedModels()` returns the account's list in ~0.3–0.5 seconds and does **not** create a transcript (checked `~/.claude/projects`). This is why upstream turned this approach off (a real prompt creates junk sessions). Current result: `default`/`opus` → `claude-opus-5-5`, `claude-fable-5-1[1m]`, `sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-5-5`, all with effort low…max.
- **Codex:** `codex app-server` (the copy in `node_modules`, the same one the SDK runs) → `initialize` → `model/list` (paged with `nextCursor`). Result: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol/terra/luna`.
- `cockpit/server/model-catalog.ts`: runs only when `AGENT_UI_SOCKET` is set (turn off with `AGENT_UI_LIVE_MODELS=0`), caches for 10 minutes, refreshes early when the login files (`~/.claude/.credentials.json`, `~/.codex/auth.json`) change, times out after 20 seconds, and on error uses the hand-written list (updated) and retries after 1 minute. The UI switches a saved model that is no longer valid to the catalog's `DEFAULT`.
- SDK: `@anthropic-ai/claude-agent-sdk` 0.3.300, `@openai/codex` + `@openai/codex-sdk` 0.162.1 (latest stable as of 2026-10-15). Typecheck + 621 server tests pass. Upstream's `authTokenRefreshRemount.test.tsx` sometimes fails depending on timing (passes on rerun).

## Only Claude and Codex remain (Cursor, OpenCode removed)

- The code of the 2 providers has been fully deleted (`cockpit/PATCHES.md`, section "Deleted upstream files"). `LLMProvider` = `'claude' | 'codex'` on both server and client.
- **Provider gating kept:** `features.json` still has `providers: { claude, codex }` and `enabledProviders`/`isProviderEnabled` are still used, so an admin can hide one of the two. As before, this only hides it in the UI.
- **Old data (DB schema unchanged):** the `sessions.provider` column still allows `cursor`/`opencode` (the schema CHECK is unchanged). The session listing queries (`getAllSessions`, `getRecentSessionsPage`, `getArchivedSessions`, `getSessionsByProjectPath(Page)`, `countSessionsByProjectPath`) filter `provider IN ('claude','codex')`, so the sidebar and search do not see these rows; deleting a project still sees them (`...IncludingArchived`). Opening such a session directly: the API returns 400 `UNSUPPORTED_PROVIDER` (history, edit) or token usage `unsupported`, no crash. The watcher no longer watches `~/.cursor` and `opencode.db`, so no new rows appear.
- Preference `selectedProvider` = `cursor`/`opencode` → read as Claude. The localStorage keys `cursor-model`/`opencode-model` and the preferences `cursorPermissions`/`opencodePermissions` are ignored (not read, not deleted). A session with an unknown `__provider` does not change the selected provider.
- **AI commit messages:** upstream only accepts `claude`/`cursor` (choosing Codex gives a 400 error) and the writer reads the old message format (`claude-response`), so, from reading the code, with the current runtime you only get the fallback message `chore: update files`. It now accepts `claude` (model `sonnet`) and `codex` (the catalog's default model, permission `default`), and the writer reads the normalized message `{kind:'text', role:'assistant'}`. Test: `server/modules/git/tests/git-init.routes.test.ts`. Not yet tried with the real CLI.
- i18n strings that said "Claude/Cursor" or "Claude, Cursor, Codex and OpenCode" were changed to Claude/Codex. Keys used only for Cursor/OpenCode (e.g. `messageTypes.cursor`) are still in the locale files but are no longer used.

## Code review (2026-10-15) and fixes

An independent review agent (reading the diff + the Cockpit 360 bridge source) found 20 issues. Fixed (with regression tests; the new tests fail on the old code):

- **HIGH** setsid fallback: the backend inherited the lock fd of `agent-ui-ensure` → every later ensure hung for 30 seconds and then failed. Fixed with `9>&-`; `ensure-test.sh` checks the second call.
- **HIGH** upload in Files used XHR (not through the shim) → uses `fetch` when `IS_COCKPIT`.
- WS shim: the real `stream` channel reports a lost socket as `terminated` (not `not-found`) → retry before the handshake for both; the mock was fixed to match the real bridge. Closing the WS while ensure is running no longer opens a "zombie" connection. `error` is emitted only once. The accept value is computed before sending the upgrade (the check is never skipped). Checks RSV, masked frames from the server, control frames > 125 bytes or fragmented, total size of fragmented messages, and subprotocol.
- fetch shim: for URLs that do not belong to the backend, `new Request()` no longer swallows the body; abort during ensure is honored; rejects with `signal.reason`.
- EventSource: keeps the server's `retry:`; an `id:` without data is still sent back on reconnect.
- `agent-ui-ensure`: if the backend is running but slow to answer `/health`, it waits instead of restarting (before, it could kill the agent or run 2 backends). `--stop` checks `/proc/<pid>/cmdline` before killing.
- Backend: the socket is deleted on exit only if its dev/ino is still the process's own socket; umask is restored right after `listen()`; the watchdog also counts background work; a missing/broken `features.json` is a startup error (no silent fallback to defaults); WebSocket paths of disabled features (`/shell`, `/plugin-ws`, …) return 404; plugin servers do not run when `plugins` is off; a broken plugin symlink does not break the whole list.
- Queued messages ("send when this turn finishes"): the composer only saves to `session_drafts`; sending is done by a 30-second server poll. Upstream put this poll in the scheduled messages dispatcher, so when `scheduledMessages` was off, queued messages were never sent. When scheduled messages were deleted, this part was split out into `queued-message-dispatcher.service.ts` (websocket module) and runs under the `chat` feature.
- `uninstall.sh`: cleans symlinks in home **as the user** (`runuser` + `find -lname`, guarding against a race that swaps a directory for a symlink so root deletes some other file); `pkill` matches the full command line (does not hit `less …/index.js`); a refused `safe_rm` does not stop halfway. `install.sh` also uses `pkill` matching the full command line. `build-plugins.sh` does not let git/npm read the loop's stdin.

**Not fixed (noted):**
- The plugin servers of the 2 Usage plugins listen on `127.0.0.1:<random port>` with no authentication (upstream's plugin architecture). Another user on the same machine who finds the port can read someone else's usage figures (not tokens). Blocking this needs both plugins changed to require a secret header. On a machine with multiple users who do not trust each other, consider turning off `plugins`.
- The `providers` and `mcp` features are only hidden in the UI; the server does not block them.
- `authTokenRefreshRemount.test.tsx` (upstream) sometimes fails when the machine is under heavy load; passes on rerun (tried 4 times in a row, with and without the patch).

## Checklist results (run on 2026-10-15, WSL2 Ubuntu 26.04, Cockpit 360)

The real install (`/usr/lib/agent-ui`, node 22 from apt) was tested with `cockpit/test/e2e/*` (headless browser, real backend, no Cockpit login), `cockpit/test/*.sh` and direct commands.

| # | Scenario | Result |
|---|---|---|
| 1 | `install.sh` runs to the end, run a 2nd time | PASS (many runs; later runs use the `node_modules`/plugin cache). Not yet tried on a clean Ubuntu 24.04 |
| 2 | Listening ports | PASS: no new port other than the plugin servers' `127.0.0.1:<random>` |
| 3 | Two users | PASS at the system level: `ploi26` and temporary user `an` (deleted) have 2 backends, 2 sockets, `an` and `ploi26` cannot access each other's socket (Permission denied), each user has its own DB. Not yet tried with 2 parallel Cockpit login sessions in a browser |
| 4 | Two tabs, one backend | PASS with 3 parallel `agent-ui-ensure` (one unit). Real-time sync between 2 tabs not yet checked |
| 5 | Claude chat runs a command | PASS (prompt runs `echo`, the UI shows the tool call + output). The nginx scenario was not used because the machine does not have it |
| 6 | Codex chat edits a file | PASS with `GPT-5.6 Luna` (file has the right content on disk). `gpt-5.4`/`gpt-5.5`/`gpt-5.4-mini` are rejected by the ChatGPT account: caused by the account/SDK model list, not by the fork |
| 7 | Resume a session from the terminal | The sidebar lists existing sessions in `~/.claude`/`~/.codex`. Continuing a chat on an old session not yet tried |
| 8 | Close every tab while the agent is running | PASS: the `sleep 20` command still finishes, the backend stays active, reopening shows the result (needs linger, which is on) |
| 9 | Idle-exit, then automatic restart | PASS (real install, `AGENT_UI_IDLE_MINUTES=1`) |
| 10 | Upload, edit files, git, shell | Edit+save file PASS; Source Control shows changed files PASS; multipart upload through the shim PASS (200, file is in `~/.cloudcli/assets`); Shell through `/shell` PASS (Codex TUI, Claude login terminal). Committing from the UI not yet tried |
| 11 | Usage tab | The tab shows, RPC runs and reports a clear error when not logged in (new user). This machine already has hand-installed copies of the 2 plugins (different directory names), so the bundled copies are not linked; real figures not yet checked |
| 12 | New user not logged in to an agent | PASS: Git identity onboarding → "Connect Your AI Agents" (only Claude + Codex), the Login button opens a login terminal right in the web page |
| 13 | Disabled features | PASS: `/api/{worktrees,taskmaster,voice,browser-use,browser-use-mcp,scheduled-messages,notifications,projects/clone}` = 404; the UI does not show the matching tabs/sections/providers. Later, the code for voice, browser-use, self-update, PWA, notifications, scheduled messages, worktrees, TaskMaster, GitHub clone, Agent API/API keys, and the Cursor and OpenCode providers was fully deleted (no longer in `features.json`) |
| 14 | Phone | PASS at viewport 390×780: no horizontal overflow, the menu works. Not yet tried on a real device |
| 15 | Uninstall | PASS U1–U7 on the real machine (dry-run, uninstall while the backend runs, rerun, reinstall, uninstall with the installed copy). `--purge` only tried in a sandbox (`cockpit/test/uninstall-test.sh`) so as not to delete real data |

### Not tested / limitations

- **The real path through cockpit-ws + iframe + login** has not been run in a browser (there is no way to log in automatically without the account password). Replaced by: the real cockpit-bridge (`guide/tools/bridge-probe.py`), CSP computed with the same algorithm as `packages.py`, and a fake `cockpit.js`. Needs one manual try.
- The user's message shows twice at the end of the conversation after a tool call: the backend's history API already returns 2 `text:user` records, so this is upstream behavior, not the shim's.
- Uninstall deletes `/var/lib/agent-ui`, so a reinstall no longer knows which CLIs it installed (`--remove-cli` then removes nothing).
- A user's hand-installed plugin with the same name wins over the bundled copy (the registry rejects a duplicate `name`); `agent-ui-ensure` avoids creating a second symlink.

## Open questions

- No internal repo URL yet: do not add an `origin` remote, do not push.
- Linger is on by default (needed for the requirement "agent keeps running after the tab closes"); turn off with `AGENT_UI_LINGER=0`.
