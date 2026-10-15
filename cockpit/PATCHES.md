# PATCHES: file upstream đã sửa (base: claudecodeui v1.37.4, `7c3049fe`)

Nguyên tắc: patch nhỏ nhất, gọi sang code trong `cockpit/`. Khi rebase lên tag mới, conflict chỉ nằm ở các file dưới đây.

| File | Lý do | Cách sửa |
|---|---|---|
| `server/index.ts` | Chạy trên unix socket, tắt module theo `features.json`, idle watchdog, seed user platform | Thêm 1 import từ `../cockpit/server/cockpit-runtime.js`. `createWebSocketServer` gán vào `wss`. Mỗi `app.use('/api/<module>')` của module có thể tắt bọc `if (isFeatureEnabled('x'))`. Thêm `app.use(cockpitNotFound)` trước static/catch-all. `ensurePlatformUser()` sau `initializeDatabase()`. `initializeQueuedMessageDispatcher` (tách từ dispatcher của scheduled messages) chạy theo feature `chat`. `server.listen(PORT,HOST,cb)` → `await listenCockpit(server, cb)`. Thêm `startIdleWatchdog(...)` trong callback. `writeLocalServerMarker` return sớm khi có `AGENT_UI_SOCKET`. Dòng log "Server URL" in socket |
| `server/tsconfig.json` | Biên dịch `cockpit/server/**` cùng backend (ra `dist-server/cockpit/server`) | Thêm `../cockpit/server/**/*.ts` vào `include`; loại `*.test.ts` khỏi `exclude` |
| `server/modules/plugins/plugin-registry.service.ts` | Plugin cài sẵn là symlink; đánh dấu `bundled` | `scanPlugins()`: `entry.isDirectory()` → chấp nhận cả symlink trỏ tới thư mục. Thêm `isBundledPlugin()` (realpath nằm trong `AGENT_UI_LIB`) và trường `bundled` trong kết quả |
| `server/modules/plugins/plugins.service.ts` (+ test) | Chặn update/uninstall plugin bundled | Hàm `assertNotBundled()` gọi ở đầu `update()` và `uninstall()` → 403 `PLUGIN_BUNDLED` |
| `src/App.tsx` | Plugin Cockpit chạy trong iframe, không điều khiển path | `BrowserRouter` → `HashRouter`; `basename` rỗng khi `IS_COCKPIT` |
| `src/modules/auth/AuthLoadingScreen.tsx`, `AuthScreenLayout.tsx` | Path tuyệt đối `/logo.svg` | `` `${import.meta.env.BASE_URL}logo.svg` `` |
| `src/modules/provider-auth/ProviderLoginModal.tsx` | Platform mode dùng `/workspace` (không có trên server) | `IS_PLATFORM && !IS_COCKPIT ? '/workspace' : ''` |
| `src/modules/sidebar/SidebarHeader.tsx` | Logo là link ra cloudcli.ai/dashboard | Hai chỗ `IS_PLATFORM ?` → `IS_PLATFORM && !IS_COCKPIT ?` |
| `src/modules/sidebar/hooks/useGitHubStars.ts` | Gọi `api.github.com` (CSP chặn) | `if (IS_COCKPIT) return;` đầu effect |
| `src/modules/settings/SettingsSidebar.tsx` | Ẩn mục Settings của tính năng tắt | `NAV_ITEMS` = `ALL_NAV_ITEMS.filter(isSettingsTabEnabled)` |
| `src/modules/project-workspace/WorkspaceTabs.tsx` | Ẩn tab theo feature | Lọc `BASE_TABS`, tab tasks, tab plugin theo `isFeatureEnabled` |
| `src/modules/project-creation-wizard/StepConfiguration.tsx` | Ẩn ô clone GitHub | Bọc theo `projectCloneWizard` |
| `src/modules/task-master/context/TasksSettingsContext.tsx`, `TaskMasterContext.tsx` | TaskMaster tắt: không gọi `/api/taskmaster/*` | Return sớm; `tasksEnabled` = pref && feature |
| `src/shared/selectedProvider.ts`, `src/modules/provider-auth/hooks/useProviderAuthStatus.ts`, `src/modules/settings/tabs/agents-settings/AgentsSettingsTab.tsx`, `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx` | Provider cursor/opencode tắt (không xóa khỏi registry) | Danh sách provider lọc qua `enabledProviders` / `isProviderEnabled` |
| `src/modules/plugins/PluginSettingsTab.tsx`, `src/shared/types.ts` | Ẩn nút Update/Uninstall của plugin bundled | Trường `bundled?: boolean`; bọc 2 nút bằng `!plugin.bundled` |
| `tsconfig.json`, `vitest.config.ts`, `vite.config.js` | Alias `@cockpit` tới `cockpit/` | Thêm alias; `tsconfig.json` thêm các file frontend của `cockpit/` vào `include` |

| `src/modules/onboarding/AgentConnectionsStep.tsx` | Onboarding "Connect Your AI Agents" liệt kê cả Cursor/OpenCode | Lọc `providerCards` bằng `isProviderEnabled` |
| `server/modules/projects/projects.routes.ts` | Route clone GitHub theo `projectCloneWizard` | Bọc `router.use(createProjectCloneRouter(...))` trong `if (isFeatureEnabled('projectCloneWizard'))` |
| `package.json`, `package-lock.json` | SDK/CLI cũ không biết model mới (Codex 0.156 không có `gpt-6.1-sol`) | `@anthropic-ai/claude-agent-sdk` ^0.3.165 → ^0.3.300; `@openai/codex` 0.156.1 → 0.162.1; `@openai/codex-sdk` ^0.156.0 → ^0.162.1 (2026-10-15) |
| `server/modules/providers/list/claude/claude-models.provider.ts` | Danh sách model cứng (ghi "Fable 5", Haiku không có effort) | `getSupportedModels()` → `liveClaudeCatalog(CLAUDE_PREDEFINED_MODELS, ...)` (`cockpit/server/model-catalog.ts`); danh sách cứng chỉ còn là fallback, đã sửa nhãn Fable 5.1 + effort |
| `server/modules/providers/list/codex/codex-models.provider.ts` | Danh sách cứng lệch với tài khoản (có `gpt-5.4/5.5` bị ChatGPT từ chối, thiếu `gpt-6.1-sol`) | `getSupportedModels()` → `liveCodexCatalog(...)` (`codex app-server` `model/list`); fallback = 7 model hiện hành, mặc định `gpt-6.1-sol` |
| `src/modules/chat/hooks/useChatProviderState.ts` | Model Codex hiển thị trước khi catalog tải xong | `FALLBACK_DEFAULT_MODEL.codex` `gpt-5.4` → `gpt-6.1-sol` |
| `server/modules/providers/services/provider-runtime.service.ts` | Idle watchdog phải tính cả background work (sub-agent, lệnh chạy nền) | Thêm `countBackgroundWork()` |
| `src/modules/file-tree/hooks/useFileTreeUpload.ts` | XHR không đi qua shim của Cockpit | Khi `IS_COCKPIT` upload bằng `fetch` (bridge buffer cả body nên không đo được tiến độ byte) |
| `server/index.ts` (bổ sung) | WebSocket path của tính năng tắt; plugin server khi `plugins` tắt; watchdog | `rejectDisabledWebSocketPaths(server)` trước `createWebSocketServer`; `startEnabledPluginServers()` theo feature `plugins`; `getActiveRunCount` cộng `countBackgroundWork()` |
| `README.md` | README gốc nói về app standalone | Viết lại bằng tiếng Anh cho bản Cockpit (bố cục theo README upstream). Khi rebase: giữ bản của fork |
| `package.json`, `package-lock.json` (gọn) | Bỏ phần desktop/release không dùng | Xoá script `desktop*`, `server:bundle`, `release`, `update:platform`, cấu hình `build` (electron-builder) và devDependency `electron`, `electron-builder`, `release-it`, `@release-it/conventional-changelog`, `auto-changelog`, `sharp`, `cross-env` (bớt 365 package khi `npm ci`) |

## File upstream đã xoá (không dùng trong bản Cockpit)

Khi rebase, nếu upstream sửa các file này thì cứ giữ trạng thái đã xoá.

| Đã xoá | Lý do |
|---|---|
| `electron/`, `scripts/release/` | App desktop và bản đóng gói server bundle |
| `docker/`, `redirect-package/`, `release.sh`, `.release-it.json` | Docker sandbox, gói npm chuyển hướng, quy trình phát hành npm của upstream |
| `.github/` (workflows, issue templates) | CI và phát hành của upstream (publish npm, build desktop, Discord) |
| `plugins/starter` (submodule), `.gitmodules` | Plugin mẫu của upstream |
| `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/README.*.md` (8 bản dịch + README cũ), `docs/nginx-subpath-template.conf` | Tài liệu của app standalone |
| `public/screenshots/`, `public/convert-icons.md`, `public/generate-icons.js` | Ảnh minh hoạ README và công cụ tạo icon |
| `server/modules/voice/`, `src/shared/voiceConfig.ts`, `useVoiceInput`/`useVoiceAvailable`/`useTts`, `VoiceInputButton`, `MessageSpeakControl`, `voicePlayer`, `VoiceSettingsTab`, `useVoiceConfig` | Voice (mic + đọc to). Kèm: mount `/api/voice`, `api.voice`, `transcribeVoice`/`synthesizeVoice`, type `Voice*`, preference `voiceEnabled` và toggle trong Quick Settings, mục Settings "Voice" |
| `server/modules/browser-use/` (cả `browser-use-mcp`), `src/modules/browser-use/`, `BrowserUseSettingsTab` | Browser Use. Kèm: 2 mount `/api/browser-use*`, `stopAllSessions` khi tắt, lệnh CLI `browser-use-mcp`, `api.browserUse`, tab "Browser" (workspace + Settings), `AppTab`/`SettingsMainTab` `'browser'` |
| `server/modules/system/` (`POST /api/system/update`), `src/modules/version-upgrade/`, `src/shared/hooks/useVersionCheck.ts` | Tự cập nhật (git pull / `npm install -g`). Kèm: `api.system`, lệnh CLI `update` + kiểm tra npm khi `start`, banner "update available"/"restart required" ở sidebar, type `ReleaseInfo`/`InstallMode`. About và sidebar hiện version bằng `APP_VERSION`. `/health` giữ nguyên |
| `public/sw.js`, `public/manifest.json`, `public/clear-cache.html`, `public/icons/icon-*` | PWA. Kèm: đăng ký SW ở `src/main.tsx` và `index.html`, link manifest/apple-touch-icon, listener SW trong `ProjectEffects.tsx`, `isPWA`/`pwa-mode` (`useDeviceSettings`, sidebar, CSS `body.pwa-mode`) |
| `server/modules/notifications/`, repo `notification-preferences`/`notification-channel-endpoints`/`push-subscriptions`/`vapid-keys`, `NotificationsSettingsTab`, `useWebPush` | Thông báo web push + desktop. Kèm: mount `/api/notifications`, route `/api/settings/{notification-preferences,push/*}`, WebSocket `/desktop-notifications` (server, shim `API_PATH_RE`), `configureWebPush`, các lời gọi `notify*` trong runtime Claude/Codex/Cursor/OpenCode (cả hook `Notification` của Claude SDK), dependency `web-push`, `api.settings.{notificationPreferences,push}`, type `NotificationPreferencesState`, mục Settings "Notifications". Tiếng chuông khi xong lượt vẫn còn (bật mặc định, không còn toggle). Bảng DB giữ nguyên |
| `server/modules/scheduled-messages/`, repo `scheduled-messages.db`, `ScheduleMessagePopover`, `ScheduledMessageList`, `useScheduledMessages` | Lên lịch gửi tin nhắn. Kèm: mount `/api/scheduled-messages`, `api.scheduledMessages`, type `ScheduledMessage`, tuỳ chọn `interruptActiveRun` của `runDetachedChatTurn`. Phần gửi queued message (trước nằm trong dispatcher này) chuyển sang `server/modules/websocket/services/queued-message-dispatcher.service.ts`. Bảng DB giữ nguyên |
| `server/modules/worktrees/`, `WorktreesView`, `NewWorktreeModal`, `MergeWorktreeModal`, `RemoveWorktreeModal`, `useWorktreesController` | Quản lý git worktree. Kèm: mount `/api/worktrees`, `api.worktrees`, tab "Worktrees" của git panel (`GitPanelView` `'worktrees'`), type `Worktree*`/`GitCommandRunner` (server) và `WorktreeInfo`/`MergeWorktreeOptions`/`RemoveWorktreeOptions` (client), export `createProject`/`restoreArchivedProject`/`deleteOrArchiveProject` khỏi barrel projects, prop `onProjectSelect`/`onProjectsRefresh` của `WorkspaceMain`/`GitPanel` |
