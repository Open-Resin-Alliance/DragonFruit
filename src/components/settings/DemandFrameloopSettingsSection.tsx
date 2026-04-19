'use client';

import React from 'react';
import { Gauge } from 'lucide-react';
import {
  getSavedDemandFrameloopSettings,
  saveDemandFrameloopSettings,
  subscribeToDemandFrameloopSettings,
  type DemandFrameloopPreference,
} from './demandFrameloopPreferences';

type PreferenceSelect = 'default' | 'on' | 'off';

function preferenceToSelect(preference: DemandFrameloopPreference): PreferenceSelect {
  if (preference === true) return 'on';
  if (preference === false) return 'off';
  return 'default';
}

function selectToPreference(value: PreferenceSelect): DemandFrameloopPreference {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return null;
}

export function DemandFrameloopSettingsSection() {
  const [settings, setSettings] = React.useState(() => getSavedDemandFrameloopSettings());

  React.useEffect(() => {
    return subscribeToDemandFrameloopSettings(() => {
      setSettings(getSavedDemandFrameloopSettings());
    });
  }, []);

  const handlePreferenceChange = (value: PreferenceSelect) => {
    saveDemandFrameloopSettings({
      ...settings,
      preference: selectToPreference(value),
    });
  };

  const handleOverlayToggle = (checked: boolean) => {
    saveDemandFrameloopSettings({
      ...settings,
      showDiagnosticsOverlay: checked,
    });
  };

  return (
    <section
      className="rounded-lg border p-3"
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Gauge className="h-4 w-4" style={{ color: 'var(--accent)' }} aria-hidden />
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
          Reduce idle CPU (beta)
        </h3>
      </div>
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        When enabled, the 3D scene only redraws when content changes. Lower idle CPU and battery
        drain, especially on Linux. Does not change peak frame rate. If you see stale visuals in a
        specific interaction, disable and report via GitHub issue #120.
      </p>

      <div className="grid grid-cols-[140px_1fr] items-center gap-2">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Rendering mode
        </label>
        <select
          className="ui-input h-8"
          value={preferenceToSelect(settings.preference)}
          onChange={(e) => handlePreferenceChange(e.target.value as PreferenceSelect)}
        >
          <option value="default">Follow platform default (currently: always render)</option>
          <option value="on">On (demand)</option>
          <option value="off">Off (always render)</option>
        </select>
      </div>

      <div className="grid grid-cols-[140px_1fr] items-center gap-2 mt-2">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Diagnostics overlay
        </label>
        <label className="inline-flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={settings.showDiagnosticsOverlay}
            onChange={(e) => handleOverlayToggle(e.target.checked)}
          />
          Show renders/sec + invalidation counter in the scene corner
        </label>
      </div>
    </section>
  );
}
