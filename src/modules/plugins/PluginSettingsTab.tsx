import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginIcon from '@/modules/plugins/PluginIcon';

/** Used by settings to enable or disable the plugins bundled with Cockpit. */
export default function PluginSettingsTab() {
  const { t } = useTranslation('settings');
  const { plugins, loading, togglePlugin } = usePlugins();
  // Shows toggle failures without hiding the installed plugin list.
  const [error, setError] = useState<string | null>(null);
  // Prevents a second toggle while the server is applying the first change.
  const [pending, setPending] = useState<string | null>(null);
  const bundledPlugins = plugins.filter((plugin) => plugin.bundled);

  const toggle = async (name: string, enabled: boolean) => {
    setPending(name);
    setError(null);
    try {
      const result = await togglePlugin(name, enabled);
      if (!result.success) setError(result.error || t('pluginSettings.toggleFailed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('pluginSettings.toggleFailed'));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('pluginSettings.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">Bundled Claude Usage and Codex Usage plugins.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {loading ? <Loader2 className="h-5 w-5 animate-spin" aria-label={t('pluginSettings.scanningPlugins')} /> : bundledPlugins.map((plugin) => (
        <div key={plugin.name} className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
          <PluginIcon pluginName={plugin.name} iconFile={plugin.icon} className="h-5 w-5" />
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold">{plugin.displayName}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${t(plugin.enabled ? 'pluginSettings.disable' : 'pluginSettings.enable')} ${plugin.displayName}`}
            disabled={pending !== null}
            onClick={() => void toggle(plugin.name, !plugin.enabled)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${plugin.enabled ? 'bg-primary' : 'bg-muted-foreground/40'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${plugin.enabled ? 'left-0.5 translate-x-5' : 'left-0.5'}`} />
          </button>
        </div>
      ))}
    </div>
  );
}
