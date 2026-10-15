# NOTES: kết quả kiểm chứng

Kiểm chứng ngày 2026-10-15 trên WSL2, Ubuntu 26.04.1, Cockpit 360-1 (bridge Python), node nvm v24.21.0 (runtime đích: node 22).
Bản đầy đủ hơn nằm ở `guide/02-verified-findings.md` ngoài repo.

## Baseline upstream (trước khi sửa)

- `npm run typecheck`: **1 lỗi có sẵn** ở `src/modules/sidebar/tests/recentConversationTitleSync.test.ts(50,67)` (thiếu `backgroundSessionIds`). Không liên quan tới fork.
- `npm test` (server): 619 test, 618 pass, 1 skip, 0 fail.
- `npm run test:client`: 106 file, 730 test pass.
- `npm run build:server`: OK, ra `dist-server/{server,shared}`.

## Transport

- `http-stream2` hỗ trợ `unix`. Request body được bridge buffer tới khi nhận `done`. Response stream theo từng chunk (SSE realtime). Control `response` (status + headers) tới trước body.
- Lỗi kết nối tới socket → channel `close` với `problem: "not-found"`.
- **`websocket-stream1` KHÔNG tồn tại** trên bridge Python 360 (`close problem:not-supported`). Channel `stream` + `unix` + `binary` thì chạy, nên WebSocket được cài tay (RFC 6455) trên channel đó. Tool: `guide/tools/bridge-probe.py`.
- `cockpit.http()` của cockpit.js: callback `.stream()` chỉ chạy với status 2xx; non-2xx thì promise reject kèm body ở tham số thứ 2 → không đủ cho fetch shim. **Quyết định:** fetch shim dùng thẳng `cockpit.channel({payload:'http-stream2', unix, binary:true, method, path, headers})`, `channel.send(Uint8Array)`, `channel.control({command:'done'})`, sự kiện `control` (command `response`), `message`, `close`.
- `cockpit.channel({binary:true})` gửi `binary:"raw"` lên bridge; `send(Uint8Array)` và `message` nhận `Uint8Array`.
- Đã có sẵn trong `cockpit.channel`: `flow-control: true`.

## CSP

`cockpit/packages.py` (`get_content_security_policy`) lấy default `default-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; font-src 'self' data:; img-src 'self' data:`, rồi key `content-security-policy` trong manifest **ghi đè từng directive**. Chỉ áp cho HTML. Cần `script-src 'self' blob:` (plugin nạp qua `import(blobURL)`), `worker-src 'self' blob:`.
Kết luận về `'unsafe-eval'`: xem mục "CSP: kết quả thử" cuối file (cập nhật ở Phase 2).

## IS_PLATFORM (đủ file)

| File | Hành vi khi `IS_PLATFORM=true` | Quyết định |
|---|---|---|
| `server/modules/auth/auth.middleware.ts` | Dùng `userDb.getFirstUser()` thay JWT cho HTTP và WS | Giữ. Cần `ensurePlatformUser()` |
| `server/modules/websocket/services/websocket-auth.service.ts` | Bỏ kiểm token WS | Giữ |
| `server/modules/agent/agent.routes.ts`, `agent.module.ts` | `/api/agent` tin request, dùng user đầu tiên (không cần API key) | Giữ: chỉ truy cập được qua unix socket mode 600 của chính user |
| `server/modules/browser-use/browser-use-runtime.ts` | Chế độ `cloud` thay vì `local` | Tắt cả browser-use (feature `browserUse:false`) |
| `server/index.ts`, `server/shared/utils.ts` | Chỉ truyền cờ | Giữ |
| `src/shared/api.ts`, `useFileTreeUpload.ts` | Không gửi bearer token | Giữ |
| `src/shared/context/WebSocketContext.tsx`, `shell/utils/socket.ts` | URL WS không có `?token=`, dựng từ `window.location.host` | Giữ; shim bắt theo path |
| `src/modules/auth/*` (ProtectedRoute, AuthContext, AuthScreenLayout) | Bỏ màn login | Giữ (mong muốn) |
| `src/modules/provider-auth/ProviderLoginModal.tsx` | Project path login = `/workspace` (không tồn tại); codex dùng `--device-auth` | **Patch** `/workspace` → `''` khi `IS_COCKPIT` (server fallback `process.cwd()`, ensure đặt cwd = `$HOME`). Giữ `--device-auth` |
| `src/modules/mcp/McpServers.tsx` | Ẩn `TeamMcpFeatureCard` | Giữ |
| `src/modules/sidebar/SidebarHeader.tsx` | Logo là link tới cloudcli.ai/dashboard | **Patch** chỉ bọc link khi không phải cockpit |
| `src/modules/sidebar/SidebarFooter.tsx`, `GitHubStarBadge.tsx`, `AboutTab.tsx` | Ẩn dòng brand / star / mục About | Giữ |
| `src/modules/version-upgrade/VersionUpgradeModal.tsx` | Đếm ngược reload khi server đã update | Giữ nhưng không bao giờ hiện (xem useVersionCheck) |
| `src/shared/hooks/useVersionCheck.ts` (không dùng IS_PLATFORM) | Gọi `api.github.com` (CSP chặn) | **Patch**: bỏ qua check GitHub khi `IS_COCKPIT` |

## plugins.json và plugin cài sẵn

- File: `~/.claude-code-ui/plugins.json`, dạng `{ "<name>": { "enabled": bool, ... } }`, ghi mode 0600.
- `scanPlugins()` coi plugin là enabled khi `config[name]?.enabled !== false` → plugin chưa có key là **bật mặc định**; không cần script bật.
- `entry.isDirectory()` loại symlink → patch (xem PATCHES).
- `resolvePluginAssetPath` dùng `realpathSync` cho cả hai vế nên symlink tới `/usr/lib/agent-ui/plugins/<name>` vẫn qua kiểm tra traversal.
- Cả 2 plugin: `tsc` build, chỉ có devDependencies, `server.listen(0,'127.0.0.1')`.

## Runtime files của backend

- `findApplicationRoot()` đi lên tới thư mục `server` gần nhất, nếu cha là `dist-server` thì lấy cha của nó. Stage `app/dist-server/server/index.js` → root = `app/`.
- Backend đọc từ `APP_ROOT`: `package.json` (version, system routes, cli), `.env` (không bắt buộc; thiếu thì chỉ log), `public/` và `dist/` (static, chỉ dùng cho standalone). `shared/` được tsc build vào `dist-server/shared`.
- Cockpit: **không** copy `public/` hay `dist/`; mọi đường dẫn không khớp trả 404 thay vì redirect Vite.
- Backend cockpit đọc thêm `cockpit/features.json` (stage copy vào `app/cockpit/features.json`).

## Binary Claude/Codex

`server/modules/providers/list/claude/claude-runtime.provider.js:232-238` chỉ đặt `pathToClaudeCodeExecutable` trên Windows; trên Linux SDK dùng binary đi kèm của `@anthropic-ai/claude-agent-sdk`. CLI `claude` (login, shell) lấy từ `PATH` của backend → `$HOME/.local/bin` đặt đầu.

## Linger

`Linger=no`, `UserStopDelaySec=10`: đóng phiên cuối thì user manager tắt và kill backend. polkit `set-self-linger` cho phép user tự bật (`allow_any=yes`). `agent-ui-ensure` tự `loginctl enable-linger` (tắt bằng `AGENT_UI_LINGER=0`) và ghi marker `~/.cloudcli/agent-ui-linger-enabled` để uninstall hoàn tác.

## Ghi chú vận hành

- `MemoryMax` có tác dụng trên máy này (`user@1000.service` delegate `cpu memory pids`). Trên máy khác kiểm tra `cat /sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`.
- Path `AF_UNIX` ≤ 108 byte.
- Shell (pty) gắn với WebSocket; watchdog đếm WS (`wss.clients`) + chat run đang chạy, không đếm pty mồ côi.


## CSP: kết quả thử (Phase 2)

Bỏ `'unsafe-eval'` khỏi `script-src`: app, editor (CodeMirror), Files, Shell (xterm), plugin (import qua blob) đều chạy bình thường. Đã grep bundle: `mermaid`, `cytoscape` và bundle chính không có `eval(` hay `new Function(`. `connect-src 'self' blob: data:` đủ vì mọi traffic đi qua channel Cockpit (không có `ws:`/`wss:`).
Chỉ còn lỗi CSP có chủ đích: `api.github.com` (GitHubStarBadge / kiểm tra version) bị chặn.

## Cách kiểm thử trình duyệt (không cần đăng nhập Cockpit)

`cockpit/test/e2e/harness.mjs` phục vụ package đã build ở một origin giả (`https://cockpit.test`), gắn đúng CSP mà Cockpit sẽ gửi (tính từ manifest như `packages.py`), thay `cockpit.js` bằng bản giả có channel `http-stream2`/`stream` và `spawn()` chạy Node-side tới unix socket thật của backend. Không mở cổng mạng. Cần Playwright (`PLAYWRIGHT_DIR`), chạy được trên Ubuntu 26.04 bằng `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright install chromium-headless-shell`.
Cái này kiểm: bundle + shim + backend thật + CSP. Không kiểm: cockpit-ws/iframe/đăng nhập (đã kiểm riêng bằng `guide/tools/bridge-probe.py` với cockpit-bridge thật).

## Lưu ý khi test: Shell tab

Tab Shell của một project mở **phiên của provider đang chọn** (Codex/Claude), không phải bash trơn. Gõ vào đó sẽ gửi prompt cho agent thật. Muốn shell trơn dùng plugin Terminal.

## Kết quả checklist (đã chạy ngày 2026-10-15, WSL2 Ubuntu 26.04, Cockpit 360)

Bản cài thật (`/usr/lib/agent-ui`, node 22 từ apt) được kiểm bằng `cockpit/test/e2e/*` (trình duyệt headless, backend thật, không đăng nhập Cockpit), `cockpit/test/*.sh` và lệnh trực tiếp.

| # | Kịch bản | Kết quả |
|---|---|---|
| 1 | `install.sh` chạy hết, chạy lần 2 | PASS (nhiều lần chạy, lần sau dùng cache `node_modules`/plugin). Chưa thử trên Ubuntu 24.04 sạch |
| 2 | Cổng đang nghe | PASS: không có cổng mới ngoài `127.0.0.1:<ngẫu nhiên>` của plugin server |
| 3 | Hai user | PASS ở mức hệ thống: `ploi26` và user tạm `an` (đã xoá) có 2 backend, 2 socket, `an` và `ploi26` không truy cập được socket của nhau (Permission denied), mỗi user DB riêng. Chưa thử 2 phiên đăng nhập Cockpit song song bằng trình duyệt |
| 4 | Hai tab một backend | PASS với 3 `agent-ui-ensure` song song (một unit). Chưa kiểm đồng bộ realtime giữa 2 tab |
| 5 | Chat Claude chạy lệnh | PASS (prompt chạy `echo`, UI hiện tool call + output). Không dùng kịch bản nginx vì máy không có |
| 6 | Chat Codex sửa file | PASS với `GPT-5.6 Luna` (file đúng nội dung trên đĩa). `gpt-5.4`/`gpt-5.5`/`gpt-5.4-mini` bị tài khoản ChatGPT từ chối: do tài khoản/danh sách model của SDK, không phải của fork |
| 7 | Resume session từ terminal | Sidebar liệt kê session có sẵn trong `~/.claude`/`~/.codex`. Chưa thử chat tiếp trên session cũ |
| 8 | Đóng mọi tab khi agent đang chạy | PASS: lệnh `sleep 20` vẫn chạy xong, backend vẫn active, mở lại thấy kết quả (cần linger, đã bật) |
| 9 | Idle-exit rồi tự khởi động lại | PASS (bản cài thật, `AGENT_UI_IDLE_MINUTES=1`) |
| 10 | Upload, sửa file, git, shell | Sửa+lưu file PASS; Source Control hiện file đổi PASS; upload multipart qua shim PASS (200, file nằm trong `~/.cloudcli/assets`); Shell qua `/shell` PASS (Codex TUI, terminal login Claude). Chưa thử commit bằng UI |
| 11 | Tab Usage | Tab hiện, RPC chạy và báo lỗi rõ ràng khi chưa đăng nhập (user mới). Máy này có sẵn bản cài tay của 2 plugin (tên thư mục khác) nên bản bundled không được liên kết, số liệu thật chưa kiểm |
| 12 | User mới chưa login agent | PASS: onboarding Git identity → "Connect Your AI Agents" (chỉ Claude + Codex), nút Login mở terminal login ngay trên web |
| 13 | Tính năng tắt | PASS: `/api/{worktrees,taskmaster,voice,browser-use,browser-use-mcp,scheduled-messages,notifications,projects/clone}` = 404; UI không hiện tab/mục/provider tương ứng |
| 14 | Điện thoại | PASS ở viewport 390×780: không tràn ngang, menu hoạt động. Chưa thử máy thật |
| 15 | Gỡ cài đặt | PASS U1–U7 trên máy thật (dry-run, gỡ khi backend chạy, chạy lại, cài lại, gỡ bằng bản copy đã cài). `--purge` chỉ thử trong sandbox (`cockpit/test/uninstall-test.sh`) để không xoá dữ liệu thật |

### Chưa kiểm / hạn chế

- **Đường đi thật qua cockpit-ws + iframe + đăng nhập** chưa chạy trong trình duyệt (không có cách đăng nhập tự động mà không dùng mật khẩu tài khoản). Đã thay bằng: cockpit-bridge thật (`guide/tools/bridge-probe.py`), CSP tính đúng thuật toán `packages.py`, và `cockpit.js` giả. Cần một lần mở thử bằng tay.
- Tin nhắn người dùng hiện trùng ở cuối hội thoại sau một tool call: API lịch sử của backend đã trả 2 bản ghi `text:user`, tức là hành vi của upstream, không phải của shim.
- Gỡ cài đặt xoá `/var/lib/agent-ui` nên lần cài lại không còn biết CLI nào do mình cài (`--remove-cli` khi đó không gỡ gì).
- Bản cài tay plugin cùng tên của user thắng bản bundled (registry từ chối trùng `name`); `agent-ui-ensure` tránh tạo symlink thứ hai.

## Open questions

- URL repo nội bộ chưa có: không thêm remote `origin`, không push.
- Linger được bật mặc định (cần cho yêu cầu "đóng tab agent vẫn chạy"); tắt bằng `AGENT_UI_LINGER=0`.
