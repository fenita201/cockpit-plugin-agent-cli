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

## Open questions

- URL repo nội bộ chưa có → không thêm remote `origin`, không push.
