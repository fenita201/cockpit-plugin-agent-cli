import type { LLMProvider } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { enabledProviders } from '@cockpit/features';

/**
 * The provider the user last chose, shared by chat, the shell, the git panel and
 * the project workspace.
 *
 * It was read from localStorage in six places with four different hand-rolled
 * readers — only one of which validated the stored string — and written from
 * three modules. Nothing published a same-tab change, so the git panel's reader
 * (which listens only for the cross-tab `storage` event) never saw a switch made
 * in its own tab.
 *
 * The value now lives in `auth.db` through the preference store, which notifies
 * its subscribers synchronously — including in the tab that wrote — so the
 * choice both reaches every reader at once and follows the user between devices.
 */

// Cockpit fork: a stored choice for a disabled or retired provider (`cursor`, `opencode`) falls back to the default.
const PROVIDERS: LLMProvider[] = enabledProviders<LLMProvider>(['claude', 'codex']);

const DEFAULT_PROVIDER: LLMProvider = PROVIDERS.includes('codex') ? 'codex' : (PROVIDERS[0] ?? 'claude');

/** Used by workspace, chat, shell and git to read the selected enabled provider. */
export function readSelectedProvider(): LLMProvider {
  const stored = readUserPreference<string | null>('selectedProvider', null);
  return PROVIDERS.includes(stored as LLMProvider) ? (stored as LLMProvider) : DEFAULT_PROVIDER;
}

/** Used by provider selectors to persist a deliberate provider choice. */
export function writeSelectedProvider(provider: LLMProvider): void {
  writeUserPreference('selectedProvider', provider);
}
