// Build-time constants injected by cockpit/vite.config.cockpit.ts (`define`). They are undefined in upstream's own
// vite/vitest runs, so every reader goes through cockpit/features.ts, which tolerates their absence.
declare const __AGENT_UI_FEATURES__: Record<string, unknown> | undefined;
declare const __AGENT_UI_LIB__: string | undefined;
declare const __AGENT_UI_COCKPIT__: boolean | undefined;
