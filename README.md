<div align="center">
 <img src="public/logo.svg" alt="Agent UI for Cockpit" width="64" height="64">
 <h1>Agent UI for Cockpit</h1>
 <p>A <a href="https://cockpit-project.org/">Cockpit</a> plugin to use <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> and <a href="https://developers.openai.com/codex">Codex</a>.<br>Use it locally or remotely to view your active projects and sessions from Cockpit.</p>
</div>

---

## Features

- **Claude Code and Codex chat** — Stream responses, reasoning and tool activity, choose models and reasoning effort, and stop a running turn. New conversations default to Codex when enabled.
- **Interactive Codex conversations** — Send follow-up instructions while Codex is working, answer its questions and respond to approval requests directly in chat.
- **Projects and sessions** — Browse your projects, reopen conversations and continue working from another browser or device with the same Cockpit account. Queue messages for later dispatch.
- **Files, Git and shell** — Browse and edit project files, inspect Git changes and use an integrated terminal without leaving Cockpit.
- **Chat attachments** — Attach images and files by picker, drag-and-drop or paste: up to 10 files, 50 MiB per file and 100 MiB total per message. Vietnamese filenames are preserved.
- **Permission controls** — Choose how much each agent can do. Save Codex defaults for one project or all projects, with session choices taking priority; changes apply to the next turn.
- **Commands, skills and MCP** — Use provider-specific slash commands, skills and project instructions (`CLAUDE.md` or `AGENTS.md`), and configure MCP servers from settings.
- **Usage plugins** — Enable or disable the bundled Claude Usage and Codex Usage panels to check account usage.
- **Browser workspace** — Use the interface on desktop or mobile, with light and dark themes and bundled fonts that support Vietnamese text.
- **Cockpit integration** — Log in through Cockpit and authenticate agents in the browser. Each Linux user gets their own backend, accounts and files.

---

## Quick Start

You need an Ubuntu server with Cockpit and a system-wide Node.js 22+ (see [Node.js](#nodejs) below).

**1. Install**

```bash
git clone https://github.com/fenita201/cockpit-plugin-agent-cli.git && cd cockpit-plugin-agent-cli
sudo ./cockpit/install.sh
```

The script first lists what is missing (system packages, the Claude Code and Codex CLIs) and asks before installing each one, then builds the app and the bundled plugins and adds it to Cockpit. It never installs Node.js: if Node is missing it tells you and stops. Run it again at any time to update. Use `--yes` to install everything without asking, or `--skip-cli` if you manage the CLIs yourself.

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

When you're done installing, `./cockpit/cleanup.sh` frees the build cache in the repo (add `--all` to also remove `node_modules`).

---

## Node.js

Agent UI needs **Node.js 22 or newer, installed system-wide** (root-owned, in `/usr/bin` or `/usr/local/bin`, with `npm` next to it). Every user's backend runs this Node, so it can't live in one person's home directory.

- **Using nvm?** A Node from nvm doesn't count: it sits in your home directory, which other users can't open, and it changes whenever you switch versions. Keep nvm for your own work and also install a system Node; the two don't conflict.
- **Install it**:
  - Ubuntu 26.04 and newer: `sudo apt install nodejs npm`
  - Older Ubuntu (apt only has Node 18): Node.js 22 from [NodeSource](https://github.com/nodesource/distributions), or the official tarball unpacked into `/usr/local`
- **Check it**: `/usr/bin/node -v && /usr/bin/npm -v`

**Which `node` do people get?**

| Who runs `node` | Which one |
|---|---|
| A user in their own terminal or in the **Shell** tab | Their nvm Node, if they use nvm (their `~/.bashrc` puts it first) |
| The Agent UI backend | Always the system Node |
| Commands run by Claude | The user's nvm Node, because Claude Code reads `~/.bashrc` |
| Commands run by Codex | Usually the system Node |

If a project needs one exact Node version, add a `.nvmrc` to it and ask the agent to run `nvm use` first, or use the project's `npm` scripts.

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

This build only ships what it uses: chat, sessions, files, git, shell, MCP, plugins and commands, for Claude Code and Codex. Each of these can still be switched off in `cockpit/features.json`. A disabled feature is hidden in the page. For chat, files, git, shell, plugins and commands its API is turned off too; sessions, MCP and the `providers` switches only hide things in the page. Run the install again after editing it.

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
- **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** - The original desktop and mobile UI for Claude Code, Cursor CLI and Codex. This plugin keeps only the Claude Code and Codex parts. See its [README](https://github.com/siteboon/claudecodeui#readme) for the standalone app.

---

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text.

This plugin is a modified version of [claudecodeui](https://github.com/siteboon/claudecodeui), which is licensed under AGPL-3.0-or-later. If you run it for other users, you must make your modified source code available to them. The bundled Claude Usage and Codex Usage plugins are MIT licensed.

---

<div align="center">
 <strong>Made with care for the Claude Code and Codex community.</strong>
</div>
