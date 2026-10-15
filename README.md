<div align="center">
 <img src="public/logo.svg" alt="Agent UI for Cockpit" width="64" height="64">
 <h1>Agent UI for Cockpit</h1>
 <p>A <a href="https://cockpit-project.org/">Cockpit</a> plugin to use <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, and <a href="https://developers.openai.com/codex">Codex</a>.<br>Use it locally or remotely to view your active projects and sessions from Cockpit.</p>
</div>

---

## Quick Start

You need an Ubuntu server with Cockpit installed.

**1. Install**

```bash
git clone <this-repo> agent-ui-cockpit && cd agent-ui-cockpit
sudo ./cockpit/install.sh
```

The script installs anything missing (Node.js 22, git, the Claude Code and Codex CLIs), builds the app and the bundled plugins, then adds it to Cockpit. Run it again at any time to update. Add `--skip-cli` if you manage the CLIs yourself.

**2. Open it**

Go to `https://<your-server>:9090`, log in with your Linux user, press F5, and click **AI Agent** in the menu.

**3. Log in to your agents**

The first time you open it, the page walks you through logging in to Claude Code and Codex right in the browser. No SSH needed.

**Update**

```bash
git pull && sudo ./cockpit/install.sh
```

**Uninstall**

```bash
sudo ./cockpit/uninstall.sh            # keeps user data
sudo ./cockpit/uninstall.sh --purge    # also deletes the app's data (~/.cloudcli, ~/.claude-code-ui)
```

`~/.claude` and `~/.codex` are never touched. Add `--dry-run` to see what would be removed.

> **Cursor CLI** is turned off by default. Install the Cursor CLI, set `"cursor": true` under `providers` in `cockpit/features.json`, and run the install again.

---

## Security & Tools Configuration

**🔒 Important Notice**: Each user only ever gets their own agent. The app runs as the Linux user who logged in to Cockpit, with that user's own accounts and files. Nothing listens on a network port: the backend is reached through a socket that only its owner can open.

### How it is isolated

- **One backend per user**: it runs as that user, started the first time they open the page. All their tabs and devices share it.
- **Login is Cockpit's**: there is no separate app password. Whoever can log in to Cockpit as a user can use that user's agent.
- **Closing the tab doesn't stop the agent**: the backend shuts down by itself after 30 minutes with no open tab and no running agent, and starts again when the page is reopened.
- **Memory limit**: the backend and everything the agent runs share a 3 GB limit by default (`AGENT_UI_MEMORY_MAX`).

### Enabling Tools

All Claude Code tools are **disabled by default**, just like in the original app. To let an agent do more:

1. **Open Tools Settings** - Click the gear icon in the sidebar
2. **Enable Selectively** - Turn on only the tools you need, or "skip permissions" for full access
3. **Root access** - If an agent needs `sudo`, give that Linux user `sudo` rights yourself. Don't log in to Cockpit as root: Claude Code refuses to skip permissions as root

**Recommended approach**: Start with basic tools enabled and add more as needed.

### Turning features off

Features you don't use can be switched off in `cockpit/features.json`, for example worktrees, voice, Cursor or OpenCode. A disabled feature is hidden in the page and its API is not served. Run the install again after editing it.

> **Note**: the bundled Claude Usage and Codex Usage plugins run a small helper on `127.0.0.1` with no authentication. On a server shared by people who don't trust each other, turn off `plugins` in `cockpit/features.json`.

---

## Acknowledgments

### Built With
- **[CloudCLI UI (claudecodeui)](https://github.com/siteboon/claudecodeui)** - The app this plugin is forked from, tag `v1.37.4` (commit `7c3049fe`)
- **[Claude Usage plugin](https://github.com/HandyS11/cloudcli-plugin-claude-usage)** by HandyS11 - Bundled, commit `18facf77173744f48f905fc574aafa6f0692fe64`
- **[Codex Usage plugin](https://github.com/dongwook-chan/cloudcli-plugin-codex-usage)** by dongwook-chan - Bundled, commit `cba6a38ec62b1163559f43ff835f5f4d2bd53a9d`
- **[Cockpit](https://cockpit-project.org/)** - The web console that hosts the plugin
- **[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)** - Runs Claude Code (`@anthropic-ai/claude-agent-sdk` 0.3.300)
- **[Codex SDK](https://developers.openai.com/codex)** - Runs Codex (`@openai/codex` and `@openai/codex-sdk` 0.162.1)

### Inspired From
- **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** - The original desktop and mobile UI for Claude Code, Cursor CLI and Codex. Its full README is kept in [docs/README.upstream.md](docs/README.upstream.md).

---

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text.

This plugin is a modified version of [claudecodeui](https://github.com/siteboon/claudecodeui), which is licensed under AGPL-3.0-or-later. If you run it for other users, you must make your modified source code available to them. The bundled Claude Usage and Codex Usage plugins are MIT licensed.

---

<div align="center">
 <strong>Made with care for the Claude Code, Cursor and Codex community.</strong>
</div>
