# Agent UI for Cockpit

A fork of [claudecodeui](https://github.com/siteboon/claudecodeui) (v1.37.4) that runs **inside Cockpit** as the menu entry **AI Agent**.
Every Linux user who signs in to Cockpit gets Claude Code and Codex with their own account and data (`~/.claude`, `~/.codex`).
No port is opened, and there is no nginx, proxy or system service: each user's backend listens on a unix socket
(`/run/user/<uid>/agent-ui/server.sock`, mode 600) and is started on demand.

```
Browser ── HTTPS :9090 ── cockpit-ws ── cockpit-bridge (as the signed-in user)
   page (iframe):  bootstrap.ts → agent-ui-ensure → shims (fetch / EventSource / WebSocket) → React app
                                                       └── cockpit channels ── unix socket ── Node backend (systemd-run --user)
```

## Install / update / remove

```bash
sudo ./cockpit/install.sh [--skip-cli]     # build + install; run it again (after git pull) to update
sudo ./cockpit/uninstall.sh [--purge] [--remove-cli] [--dry-run] [--yes]
```

- `install.sh` installs what is missing (cockpit, git, rsync, build tools, Node.js 22 from apt, optionally the `claude` and `codex` CLIs),
  builds the frontend and backend with the same Node that will run them, builds the bundled plugins (Claude Usage, Codex Usage),
  smoke-tests the staged backend, then installs to `/usr/lib/agent-ui` and `/usr/share/cockpit/agent-ui`.
  It records what it installed in `/var/lib/agent-ui/install-state.json`.
- `uninstall.sh` stops every user's backend and removes the system files, per-user plugin symlinks and runtime dirs.
  By default **user data is kept**. `--purge` also deletes `~/.cloudcli` and `~/.claude-code-ui` for every user.
  `~/.claude` and `~/.codex` are never touched. `--remove-cli` removes the CLIs only if `install.sh` installed them.
  A copy is installed as `/usr/lib/agent-ui/bin/agent-ui-uninstall`, so it works after the repo is deleted.
  `install.sh --uninstall [...]` is an alias.

Then in Cockpit: press F5, open **AI Agent**. The first time, the page walks the user through Git identity and Claude/Codex login.

## Behaviour

- **One backend per user**, shared by all their tabs and devices. It is independent of the tabs: closing them does not stop a running agent.
- It exits after `AGENT_UI_IDLE_MINUTES` (default 30; `0` = never) with no connection and no running agent, and starts again when the page is opened.
- `agent-ui-ensure` enables **linger** for the user (`loginctl enable-linger`, allowed by polkit) so the backend survives the Cockpit session ending.
  Set `AGENT_UI_LINGER=0` to skip. `AGENT_UI_MEMORY_MAX` (default 3G) limits the backend and everything the agent runs.
- Features are switched in `cockpit/features.json` (providers, taskmaster, ...). Disabled modules are not mounted (their `/api/...` is 404) and are hidden in the UI.
- Full access for an agent: turn on "skip permissions" in Settings > Tools. For root commands give the user `sudo NOPASSWD`.
  Do not sign in to Cockpit as root (Claude Code refuses to bypass permissions as root).

## Layout

| Path | What |
|---|---|
| `cockpit/server/cockpit-runtime.ts` | unix-socket listen, idle watchdog, platform user, feature flags (backend) |
| `cockpit/shim/` | `fetch`, `EventSource` and `WebSocket` over Cockpit channels (WebSocket is an RFC 6455 client on a raw `stream` channel: Cockpit 360 has no `websocket-stream1`) |
| `cockpit/bootstrap.ts`, `index.html`, `vite.config.cockpit.ts`, `package/manifest.json` | the Cockpit page and its build |
| `cockpit/bin/agent-ui-ensure` | start/find the user's backend (`--status`, `--stop`) |
| `cockpit/install.sh`, `uninstall.sh` | system install / removal |
| `cockpit/dev-install.sh`, `dev-uninstall.sh` | per-user dev copy, no root: package "AI Agent (dev)" in `~/.local/share/cockpit` |
| `cockpit/features.json`, `plugins.lock.json` | enabled features; pinned bundled plugins |
| `cockpit/PATCHES.md`, `NOTES.md` | every upstream file changed (and why); verified facts, decisions, open questions |

## Development

```bash
./cockpit/dev-install.sh          # build + install the dev copy, then press F5 on the whole Cockpit page
./cockpit/scripts/test.sh         # upstream tests + cockpit tests
bash cockpit/test/uninstall-test.sh && bash cockpit/test/ensure-test.sh
journalctl --user -u agent-ui-dev -n 100 --no-pager
```

`cockpit/test/e2e/` drives the built package in headless Chromium without a Cockpit login (see NOTES.md).

## Updating to a new upstream release

```bash
git fetch upstream --tags && git rebase <new-tag>     # conflicts only in files listed in cockpit/PATCHES.md
./cockpit/scripts/test.sh && sudo ./cockpit/install.sh
```
Bundled plugins: change `ref` in `plugins.lock.json`.

## Troubleshooting

| Symptom | Check |
|---|---|
| "Không khởi động được AI Agent" | `/usr/lib/agent-ui/bin/agent-ui-ensure` in Cockpit's Terminal, then `journalctl --user -u agent-ui -n 100` |
| Blank page / CSP error | browser console of the iframe; `content-security-policy` in `package/manifest.json` |
| Menu missing | `cockpit-bridge --packages \| grep agent-ui`, then F5 on the whole page |
| No Usage tabs | `ls -l ~/.claude-code-ui/plugins` (a plugin the user installed under another directory name wins over the bundled one) |
| Codex model "not supported with a ChatGPT account" | pick another model in the picker; the list comes from the SDK, not from the account |
| Agent killed during a heavy build | raise `AGENT_UI_MEMORY_MAX` |
| Stop my backend now | `/usr/lib/agent-ui/bin/agent-ui-ensure --stop` |

License: upstream is AGPL-3.0-or-later; keep this fork's source available to its users. The bundled usage plugins are MIT.
