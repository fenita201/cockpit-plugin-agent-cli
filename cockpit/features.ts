// Frontend feature flags for the Cockpit build, read from cockpit/features.json (injected at build time).
// Outside the Cockpit build (upstream tests, `vite dev`) every flag is on, so upstream behaviour is unchanged.

/** True only in the Cockpit build; use it to adjust platform-mode behaviour that does not suit Cockpit. */
export const IS_COCKPIT: boolean = typeof __AGENT_UI_COCKPIT__ !== 'undefined' && __AGENT_UI_COCKPIT__ === true;

const features: Record<string, unknown> = typeof __AGENT_UI_FEATURES__ !== 'undefined' ? __AGENT_UI_FEATURES__ ?? {} : {};

/** Whether a feature from features.json is on. Always true outside the Cockpit build. */
export function isFeatureEnabled(name: string): boolean {
  if (!IS_COCKPIT) return true;
  return features[name] === true;
}

/** Whether an LLM provider ('claude', 'codex', 'cursor', 'opencode') is on. Always true outside the Cockpit build. */
export function isProviderEnabled(provider: string): boolean {
  if (!IS_COCKPIT) return true;
  const providers = features.providers;
  return typeof providers === 'object' && providers !== null && (providers as Record<string, unknown>)[provider] === true;
}
