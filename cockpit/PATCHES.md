# PATCHES: file upstream đã sửa (base: claudecodeui v1.37.4, `7c3049fe`)

Nguyên tắc: patch nhỏ nhất, gọi sang code trong `cockpit/`. Khi rebase lên tag mới, conflict chỉ nằm ở các file dưới đây.

| File | Lý do | Cách sửa |
|---|---|---|
| `server/index.ts` | Chạy trên unix socket, tắt module theo `features.json`, idle watchdog, seed user platform | Thêm 1 import từ `../cockpit/server/cockpit-runtime.js`. `createWebSocketServer` gán vào `wss`. Mỗi `app.use('/api/<module>')` của module có thể tắt bọc `if (isFeatureEnabled('x'))`. Thêm `app.use(cockpitNotFound)` trước static/catch-all. `ensurePlatformUser()` sau `initializeDatabase()`. `configureWebPush` / `initializeScheduledMessageDispatcher` bọc theo feature. `server.listen(PORT,HOST,cb)` → `await listenCockpit(server, cb)`. Thêm `startIdleWatchdog(...)` trong callback. `writeLocalServerMarker` return sớm khi có `AGENT_UI_SOCKET`. Dòng log "Server URL" in socket |
| `server/tsconfig.json` | Biên dịch `cockpit/server/**` cùng backend (ra `dist-server/cockpit/server`) | Thêm `../cockpit/server/**/*.ts` vào `include`; loại `*.test.ts` khỏi `exclude` |
