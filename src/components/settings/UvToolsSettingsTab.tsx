'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { ExternalLink, Search, CheckCircle2 } from 'lucide-react';
import { Button, SegmentedControl, SettingRow, Spinner } from '@/components/atoms';
import type { UvToolsSettings } from '@/components/settings/uvToolsPreferences';
import { autoDiscoverUvToolsPath } from '@/components/settings/uvToolsPreferences';
import { detectPlatform } from '@/hooks/usePlatform';

interface UvToolsSettingsTabProps {
  uvToolsSettings: UvToolsSettings;
  onUvToolsSettingsChange: (next: UvToolsSettings) => void;
}

const FOUND_GLOW_DURATION_MS = 5000;

export function UvToolsSettingsTab({
  uvToolsSettings,
  onUvToolsSettingsChange,
}: UvToolsSettingsTabProps) {
  const { _ } = useLingui();
  const [discoveryBusy, setDiscoveryBusy] = React.useState(false);
  const [showFoundGlow, setShowFoundGlow] = React.useState(false);
  const [showNotFound, setShowNotFound] = React.useState(false);
  const foundGlowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const notFoundTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Resolved in an effect so the server-rendered markup and the first client
  // render agree; macOS points at the `.app` bundle, not at an executable.
  const [isMac, setIsMac] = React.useState(false);
  const executableLabel = isMac ? 'UVtools.app' : 'UVTools.exe';

  React.useEffect(() => {
    setIsMac(detectPlatform() === 'mac');
  }, []);

  React.useEffect(() => {
    return () => {
      if (foundGlowTimerRef.current) clearTimeout(foundGlowTimerRef.current);
      if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);
    };
  }, []);

  const handleAutoDiscover = React.useCallback(async () => {
    setDiscoveryBusy(true);
    setShowFoundGlow(false);
    setShowNotFound(false);
    if (foundGlowTimerRef.current) clearTimeout(foundGlowTimerRef.current);
    if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);

    try {
      const foundPath = await autoDiscoverUvToolsPath();
      if (foundPath) {
        onUvToolsSettingsChange({ ...uvToolsSettings, customPath: foundPath });
        setShowFoundGlow(true);
        foundGlowTimerRef.current = setTimeout(() => {
          setShowFoundGlow(false);
          foundGlowTimerRef.current = null;
        }, FOUND_GLOW_DURATION_MS);
      } else {
        setShowNotFound(true);
        notFoundTimerRef.current = setTimeout(() => {
          setShowNotFound(false);
          notFoundTimerRef.current = null;
        }, FOUND_GLOW_DURATION_MS);
      }
    } catch {
      setShowNotFound(true);
      notFoundTimerRef.current = setTimeout(() => {
        setShowNotFound(false);
        notFoundTimerRef.current = null;
      }, FOUND_GLOW_DURATION_MS);
    } finally {
      setDiscoveryBusy(false);
    }
  }, [onUvToolsSettingsChange, uvToolsSettings]);

  return (
    <div className="space-y-3">
      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <ExternalLink className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              UVTools Integration
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Automatically open sliced print files in UVTools for further inspection and repair.
              After slicing, the file is sent directly to UVTools for analysis.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Enable UVTools Integration`)}
          description={_(msg`Adds a “Send to UVTools” option in the slicing panel.`)}
        >
          <SegmentedControl
            label={_(msg`Enable UVTools Integration`)}
            options={[
              { value: 'off', label: _(msg`OFF`) },
              { value: 'on', label: _(msg`ON`) },
            ]}
            value={uvToolsSettings.enabled ? 'on' : 'off'}
            onChange={(next) => onUvToolsSettingsChange({ ...uvToolsSettings, enabled: next === 'on' })}
          />
        </SettingRow>

        {uvToolsSettings.enabled && (
          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <SettingRow
              label={_(msg`UVTools Executable Path`)}
              description={_(msg`Use auto-discover or enter the path to ${executableLabel} manually.`)}
            >
              <Button
                variant="secondary"
                size="auto"
                onClick={handleAutoDiscover}
                disabled={discoveryBusy}
                className="!h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 transition-all duration-700"
                style={showFoundGlow
                  ? {
                      background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 88%)',
                    }
                  : showNotFound
                    ? {
                        background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)',
                      }
                    : {}}
              >
                {discoveryBusy ? (
                  <Spinner size="md" className="shrink-0" />
                ) : showFoundGlow ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-secondary)' }} />
                ) : (
                  <Search className="h-4 w-4 shrink-0" />
                )}
                {discoveryBusy ? 'Scanning…' : showFoundGlow ? 'Found!' : 'Auto-Discover'}
              </Button>
            </SettingRow>

            <div className="mt-2">
              <input
                type="text"
                value={uvToolsSettings.customPath}
                onChange={(e) => onUvToolsSettingsChange({ ...uvToolsSettings, customPath: e.target.value })}
                placeholder={`Select or type the path to ${executableLabel}`}
                className="w-full rounded-md border px-2.5 py-1.5 text-xs font-mono"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-strong)',
                }}
                spellCheck={false}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
