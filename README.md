# Agent UI cho Cockpit · Agent UI for Cockpit

README này có 2 phần · This README has 2 parts:

- [🇻🇳 Tiếng Việt](#-tiếng-việt)
- [🇬🇧 English](#-english)

---

## 🇻🇳 Tiếng Việt

### Đây là gì?

Đây là bản fork của **claudecodeui**, được chỉnh lại để chạy như một **plugin của Cockpit**.

Cài xong, ai đăng nhập Cockpit bằng user Linux của mình là thấy menu **AI Agent**. Vào đó là chat được với **Claude Code** và **Codex**, bằng chính tài khoản và dữ liệu của user đó (`~/.claude`, `~/.codex`). Không cần SSH, không cần mở thêm port nào.

### Lấy từ đâu?

| Thành phần | Repo | Phiên bản / commit |
|---|---|---|
| App gốc (fork) | [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | tag `v1.37.4`, commit `7c3049fe` |
| Plugin Claude Usage (cài sẵn) | [HandyS11/cloudcli-plugin-claude-usage](https://github.com/HandyS11/cloudcli-plugin-claude-usage) | commit `18facf77173744f48f905fc574aafa6f0692fe64` |
| Plugin Codex Usage (cài sẵn) | [dongwook-chan/cloudcli-plugin-codex-usage](https://github.com/dongwook-chan/cloudcli-plugin-codex-usage) | commit `cba6a38ec62b1163559f43ff835f5f4d2bd53a9d` |

Hai commit plugin được ghim trong `cockpit/plugins.lock.json`. Muốn lên bản mới thì sửa `ref` ở đó rồi cài lại.

Bên trong đang dùng `@anthropic-ai/claude-agent-sdk` 0.3.300, `@openai/codex` và `@openai/codex-sdk` 0.162.1. Danh sách model không ghi cứng mà lấy thẳng từ Claude Code và Codex theo tài khoản đang đăng nhập, nên có model mới là tự hiện.

### Cài thế nào?

Cần một máy Ubuntu đã có Cockpit. Clone repo về rồi chạy:

```bash
sudo ./cockpit/install.sh
```

Script tự lo hết:

- cài thứ còn thiếu (Node.js 22, git, …);
- build app và 2 plugin;
- chép vào Cockpit.

Xong thì mở `https://<server>:9090`, đăng nhập, bấm F5 là thấy menu **AI Agent**. Lần đầu vào, app sẽ hướng dẫn login Claude và Codex ngay trên web.

Cập nhật bản mới:

```bash
git pull && sudo ./cockpit/install.sh
```

### Gỡ thế nào?

```bash
sudo ./cockpit/uninstall.sh
```

Mặc định chỉ gỡ phần đã cài vào hệ thống, **dữ liệu của user được giữ lại**.

- Muốn xóa luôn dữ liệu của app (`~/.cloudcli`, `~/.claude-code-ui`): thêm `--purge`.
- Muốn xem trước nó sẽ xóa gì: thêm `--dry-run`.
- `~/.claude` và `~/.codex` thì không bao giờ bị đụng tới.

### Chạy ra sao?

- Mỗi user có một backend riêng, chạy dưới chính user đó.
- Backend chỉ nói chuyện qua unix socket mà chỉ user đó mở được. Không mở port, không cần nginx hay proxy.
- Đóng tab thì agent vẫn chạy tiếp. Không ai dùng 30 phút thì backend tự tắt, mở lại trang là tự bật lên.
- Muốn tắt bớt tính năng (worktree, voice, Cursor, OpenCode, …) thì sửa `cockpit/features.json` rồi cài lại.

### Muốn tìm hiểu sâu hơn?

| File | Nội dung |
|---|---|
| `cockpit/README.md` | Tài liệu kỹ thuật: kiến trúc, dev, test, xử lý sự cố |
| `cockpit/NOTES.md` | Những gì đã kiểm chứng, kết quả test |
| `cockpit/PATCHES.md` | Danh sách file của upstream đã sửa và lý do |
| `docs/README.upstream.md` | README gốc của claudecodeui |

### Bản quyền

- App gốc dùng license **AGPL-3.0**, nên bản fork này cũng phải để source cho người dùng xem được.
- Hai plugin Usage dùng license **MIT**.

---

## 🇬🇧 English

### What is this?

This is a fork of **claudecodeui**, reworked to run as a **Cockpit plugin**.

Once it's installed, anyone who logs in to Cockpit with their Linux user gets an **AI Agent** menu. From there they can chat with **Claude Code** and **Codex**, using their own account and data (`~/.claude`, `~/.codex`). No SSH, and no extra ports to open.

### Where does it come from?

| Part | Repo | Version / commit |
|---|---|---|
| Base app (forked) | [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | tag `v1.37.4`, commit `7c3049fe` |
| Claude Usage plugin (bundled) | [HandyS11/cloudcli-plugin-claude-usage](https://github.com/HandyS11/cloudcli-plugin-claude-usage) | commit `18facf77173744f48f905fc574aafa6f0692fe64` |
| Codex Usage plugin (bundled) | [dongwook-chan/cloudcli-plugin-codex-usage](https://github.com/dongwook-chan/cloudcli-plugin-codex-usage) | commit `cba6a38ec62b1163559f43ff835f5f4d2bd53a9d` |

The two plugin commits are pinned in `cockpit/plugins.lock.json`. To move to a newer version, change the `ref` there and reinstall.

Under the hood it uses `@anthropic-ai/claude-agent-sdk` 0.3.300 and `@openai/codex` / `@openai/codex-sdk` 0.162.1. Model lists aren't hard-coded: they come straight from Claude Code and Codex for the logged-in account, so new models show up on their own.

### How do I install it?

You need an Ubuntu machine that already runs Cockpit. Clone the repo and run:

```bash
sudo ./cockpit/install.sh
```

The script does the rest:

- installs whatever is missing (Node.js 22, git, …);
- builds the app and the two plugins;
- copies everything into Cockpit.

Then open `https://<server>:9090`, log in, and press F5. The **AI Agent** menu is there. The first time you open it, the app walks you through logging in to Claude and Codex right in the browser.

To update:

```bash
git pull && sudo ./cockpit/install.sh
```

### How do I remove it?

```bash
sudo ./cockpit/uninstall.sh
```

By default it only removes what was installed on the system. **User data is kept.**

- To also delete the app's data (`~/.cloudcli`, `~/.claude-code-ui`), add `--purge`.
- To see what it would remove first, add `--dry-run`.
- `~/.claude` and `~/.codex` are never touched.

### How does it work?

- Every user gets their own backend, running as that user.
- The backend only talks over a unix socket that only that user can open. No ports, no nginx, no proxy.
- Closing the tab doesn't stop a running agent. After 30 minutes with nobody using it the backend shuts down, and it starts again when you reopen the page.
- To turn features off (worktrees, voice, Cursor, OpenCode, …), edit `cockpit/features.json` and reinstall.

### Want more detail?

| File | What's in it |
|---|---|
| `cockpit/README.md` | Technical docs: architecture, development, tests, troubleshooting |
| `cockpit/NOTES.md` | What was verified, and the test results |
| `cockpit/PATCHES.md` | Every upstream file that was changed, and why |
| `docs/README.upstream.md` | The original claudecodeui README |

### License

- The base app is **AGPL-3.0**, so this fork has to keep its source available to the people who use it.
- The two Usage plugins are **MIT**.
