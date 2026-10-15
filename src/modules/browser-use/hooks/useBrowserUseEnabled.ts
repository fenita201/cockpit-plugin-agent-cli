import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { isFeatureEnabled } from '@cockpit/features';

/** Tracks whether the Browser Use workspace is enabled in server settings. */
export function useBrowserUseEnabled() {
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);

  const loadBrowserUseSettings = useCallback(async () => {
    if (!isFeatureEnabled('browserUse')) {
      setBrowserUseEnabled(false);
      return;
    }
    try {
      const response = await api.browserUse.settings();
      const data = await response.json();
      setBrowserUseEnabled(Boolean(
        response.ok
        && data?.success !== false
        && data?.data?.settings?.enabled,
      ));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  return browserUseEnabled;
}
