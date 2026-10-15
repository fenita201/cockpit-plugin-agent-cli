# PATCHES: file upstream đã sửa (base: claudecodeui v1.37.4, `7c3049fe`)

Nguyên tắc: patch nhỏ nhất, gọi sang code trong `cockpit/`. Khi rebase lên tag mới, conflict chỉ nằm ở các file dưới đây.

| File | Lý do | Cách sửa |
|---|---|---|
| `server/index.ts` | Chạy trên unix socket, tắt module theo `features.json`, idle watchdog, seed user platform | Thêm 1 import từ `../cockpit/server/cockpit-runtime.js`. `createWebSocketServer` gán vào `wss`. Mỗi `app.use('/api/<module>')` của module có thể tắt bọc `if (isFeatureEnabled('x'))`. Thêm `app.use(cockpitNotFound)` trước static/catch-all. `ensurePlatformUser()` sau `initializeDatabase()`. `configureWebPush` / `initializeScheduledMessageDispatcher` bọc theo feature. `server.listen(PORT,HOST,cb)` → `await listenCockpit(server, cb)`. Thêm `startIdleWatchdog(...)` trong callback. `writeLocalServerMarker` return sớm khi có `AGENT_UI_SOCKET`. Dòng log "Server URL" in socket |
| `server/tsconfig.json` | Biên dịch `cockpit/server/**` cùng backend (ra `dist-server/cockpit/server`) | Thêm `../cockpit/server/**/*.ts` vào `include`; loại `*.test.ts` khỏi `exclude` |
| `server/modules/plugins/plugin-registry.service.ts` | Plugin cài sẵn là symlink; đánh dấu `bundled` | `scanPlugins()`: `entry.isDirectory()` → chấp nhận cả symlink trỏ tới thư mục. Thêm `isBundledPlugin()` (realpath nằm trong `AGENT_UI_LIB`) và trường `bundled` trong kết quả |
| `server/modules/plugins/plugins.service.ts` (+ test) | Chặn update/uninstall plugin bundled | Hàm `assertNotBundled()` gọi ở đầu `update()` và `uninstall()` → 403 `PLUGIN_BUNDLED` |
| `src/App.tsx` | Plugin Cockpit chạy trong iframe, không điều khiển path | `BrowserRouter` → `HashRouter`; `basename` rỗng khi `IS_COCKPIT` |
| `src/main.tsx` | Không đăng ký Service Worker | Chỉ register khi `isFeatureEnabled('pwa')` |
| `src/modules/auth/AuthLoadingScreen.tsx`, `AuthScreenLayout.tsx` | Path tuyệt đối `/logo.svg` | `` `${import.meta.env.BASE_URL}logo.svg` `` |
| `src/modules/provider-auth/ProviderLoginModal.tsx` | Platform mode dùng `/workspace` (không có trên server) | `IS_PLATFORM && !IS_COCKPIT ? '/workspace' : ''` |
| `src/modules/sidebar/SidebarHeader.tsx` | Logo là link ra cloudcli.ai/dashboard | Hai chỗ `IS_PLATFORM ?` → `IS_PLATFORM && !IS_COCKPIT ?` |
| `src/modules/sidebar/hooks/useGitHubStars.ts`, `src/shared/hooks/useVersionCheck.ts` | Gọi `api.github.com` (CSP chặn) | `if (IS_COCKPIT) return;` đầu effect |
| `src/modules/settings/SettingsSidebar.tsx` | Ẩn mục Settings của tính năng tắt | `NAV_ITEMS` = `ALL_NAV_ITEMS.filter(isSettingsTabEnabled)` |
| `src/modules/project-workspace/WorkspaceTabs.tsx` | Ẩn tab theo feature | Lọc `BASE_TABS`, tab browser/tasks, tab plugin theo `isFeatureEnabled` |
| `src/modules/git-panel/GitViewTabs.tsx` | Ẩn view worktrees | `TABS` lọc theo `worktrees` |
| `src/modules/chat/hooks/useVoiceAvailable.ts`, `src/modules/chat/composer/ChatComposer.tsx`, `src/modules/chat/composer/useScheduledMessages.ts` | Voice, lên lịch tin nhắn | Điều kiện `isFeatureEnabled('voice' / 'scheduledMessages')` |
| `src/modules/browser-use/hooks/useBrowserUseEnabled.ts`, `src/modules/settings/hooks/useWebPush.ts` | Không gọi API của module tắt | Return sớm theo feature |
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
| `README.md` → `docs/README.upstream.md` | README gốc nói về app standalone | README mới ở gốc repo (Việt + Anh) giới thiệu bản Cockpit; README upstream giữ nguyên ở `docs/README.upstream.md` (sửa đường dẫn logo). Khi rebase: lấy README mới của upstream đặt vào `docs/` |
