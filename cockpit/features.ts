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

/**
 * Whether an LLM provider ('claude' or 'codex', the only two this build ships) is on, so an admin can hide one in
 * features.json. Always true outside the Cockpit build.
 */
export function isProviderEnabled(provider: string): boolean {
  if (!IS_COCKPIT) return true;
  const providers = features.providers;
  return typeof providers === 'object' && providers !== null && (providers as Record<string, unknown>)[provider] === true;
}

/** Filters a provider list down to the providers enabled in features.json (identity outside the Cockpit build). */
export function enabledProviders<T extends string>(providers: readonly T[]): T[] {
  return providers.filter((provider) => isProviderEnabled(provider));
}

/** Which Settings dialog sections exist in the Cockpit build. Unlisted sections (agents, appearance, about) always do. */
const SETTINGS_TAB_FEATURE: Record<string, string> = {
  git: 'git',
  plugins: 'plugins',
};

/** Whether a Settings dialog section should be shown. */
export function isSettingsTabEnabled(tab: string): boolean {
  const feature = SETTINGS_TAB_FEATURE[tab];
  return feature === undefined || isFeatureEnabled(feature);
}
