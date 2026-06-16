'use client';

import React from 'react';
import { ExternalLink, Search, CheckCircle2, Loader2 } from 'lucide-react';
import type { UvToolsSettings } from '@/components/settings/uvToolsPreferences';
import { autoDiscoverUvToolsPath } from '@/components/settings/uvToolsPreferences';

interface UvToolsSettingsTabProps {
  uvToolsSettings: UvToolsSettings;
  onUvToolsSettingsChange: (next: UvToolsSettings) => void;
}

const FOUND_GLOW_DURATION_MS = 5000;

export function UvToolsSettingsTab({
  uvToolsSettings,
  onUvToolsSettingsChange,
}: UvToolsSettingsTabProps) {
  const [discoveryBusy, setDiscoveryBusy] = React.useState(false);
  const [showFoundGlow, setShowFoundGlow] = React.useState(false);
  const [showNotFound, setShowNotFound] = React.useState(false);
  const foundGlowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const notFoundTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
        className="rounded-lg border p-3"
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              UVTools Integration
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Automatically open sliced print files in UVTools for further inspection and repair.
              After slicing, the file is sent directly to UVTools for analysis.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Enable UVTools Integration
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Adds a &ldquo;Send to UVTools&rdquo; option in the slicing panel.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onUvToolsSettingsChange({ ...uvToolsSettings, enabled: !uvToolsSettings.enabled })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={uvToolsSettings.enabled
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
            >
              {uvToolsSettings.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {uvToolsSettings.enabled && (
          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  UVTools Executable Path
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Use auto-discover or enter the path to UVTools.exe manually.
                </div>
              </div>
              <button
                type="button"
                onClick={handleAutoDiscover}
                disabled={discoveryBusy}
                className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 transition-all duration-700"
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
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                ) : showFoundGlow ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-secondary)' }} />
                ) : (
                  <Search className="h-4 w-4 shrink-0" />
                )}
                {discoveryBusy ? 'Scanning…' : showFoundGlow ? 'Found!' : 'Auto-Discover'}
              </button>
            </div>

            <div className="mt-2">
              <input
                type="text"
                value={uvToolsSettings.customPath}
                onChange={(e) => onUvToolsSettingsChange({ ...uvToolsSettings, customPath: e.target.value })}
                placeholder="Select or type the path to UVTools.exe"
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
