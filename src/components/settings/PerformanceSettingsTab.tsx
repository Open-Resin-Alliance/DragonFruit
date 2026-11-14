'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Cpu, ImageIcon, Trash2, Zap } from 'lucide-react';
import { SegmentedControl, SettingRow } from '@/components/atoms';
import type { SlicingPerformanceSettings } from '@/components/settings/performancePreferences';
import { cleanupAllPrintTempArtifacts, cleanupStalePrintTempArtifacts } from '@/features/slicing/tauri/nativeSlicerBridge';

const SLICING_ENGINE_CRATE = 'dragonfruit-slicing-engine';
type TranslateFn = (descriptor: MessageDescriptor) => string;

function formatCleanedStaleAlert(translate: TranslateFn, count: number): string {
  return translate(msg`Cleaned ${plural(count, { one: '# temp file', other: '# temp files' })} older than 1 hour.`);
}

function formatCleanedAllAlert(translate: TranslateFn, count: number): string {
  return translate(msg`Cleaned ${plural(count, { one: '# temp file', other: '# temp files' })}.`);
}


export type SlicingThumbnailRenderSettings = {
  includeGradient: boolean;
  includeBuildPlate: boolean;
  includeGrid: boolean;
};
interface PerformanceSettingsTabProps {
  settings: SlicingPerformanceSettings;
  onChange: (settings: SlicingPerformanceSettings) => void;
  thumbnailSettings: SlicingThumbnailRenderSettings;
  onThumbnailSettingsChange: (settings: SlicingThumbnailRenderSettings) => void;
  showPngCompressionControls?: boolean;
}

export function PerformanceSettingsTab({
  settings,
  onChange,
  thumbnailSettings,
  onThumbnailSettingsChange,
  showPngCompressionControls = true,
}: PerformanceSettingsTabProps) {
  const { _ } = useLingui();
  const patch = React.useCallback((partial: Partial<SlicingPerformanceSettings>) => {
    onChange({ ...settings, ...partial });
  }, [onChange, settings]);

  const patchThumbnailSettings = React.useCallback((partial: Partial<SlicingThumbnailRenderSettings>) => {
    onThumbnailSettingsChange({
      ...thumbnailSettings,
      ...partial,
    });
  }, [onThumbnailSettingsChange, thumbnailSettings]);

  // Null until the native side answers; outside Tauri it never does.
  const [engineVersion, setEngineVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const v = await invoke<string>('get_slicer_engine_version');
        if (!cancelled && typeof v === 'string' && v.trim()) setEngineVersion(v.trim());
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  const pngCompressionMode: 'auto' | 'on' | 'off' = settings.pngCompressionStrategy === 'auto'
    ? 'auto'
    : settings.pngCompressionStrategy === 'fastest'
      ? 'off'
      : 'on';

  return (
    <div className="space-y-3">
      {/* Slicing Engine Metadata */}
      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Cpu className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans>Slicing Engine</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Native Rust slicing via the DragonFruit engine.</Trans>
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div>
              <div style={{ color: 'var(--text-muted)' }}><Trans>Crate</Trans></div>
              <div className="font-semibold" style={{ color: 'var(--text-strong)' }}>{SLICING_ENGINE_CRATE}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)' }}><Trans>Version</Trans></div>
              <div className="font-semibold" style={{ color: 'var(--text-strong)' }}>{engineVersion ?? '-'}</div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <ImageIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans>Thumbnail Rendering</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Configure what appears in generated export/slice thumbnails.</Trans>
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <SettingRow
            label={_(msg`Background gradient`)}
            description={_(msg`Scene mood overlay in thumbnail`)}
          >
            <SegmentedControl
              label={_(msg`Background gradient`)}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
              value={thumbnailSettings.includeGradient ? 'on' : 'off'}
              onChange={(next) => patchThumbnailSettings({ includeGradient: next === 'on' })}
            />
          </SettingRow>

          <SettingRow
            label={_(msg`Build plate`)}
            description={_(msg`Render build plate in thumbnail`)}
          >
            <SegmentedControl
              label={_(msg`Build plate`)}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
              value={thumbnailSettings.includeBuildPlate ? 'on' : 'off'}
              onChange={(next) => patchThumbnailSettings({ includeBuildPlate: next === 'on' })}
            />
          </SettingRow>

          <SettingRow
            label={_(msg`Grid`)}
            description={_(msg`Render build grid in thumbnail`)}
          >
            <SegmentedControl
              label={_(msg`Grid`)}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
              value={thumbnailSettings.includeGrid ? 'on' : 'off'}
              onChange={(next) => patchThumbnailSettings({ includeGrid: next === 'on' })}
            />
          </SettingRow>
        </div>
      </section>

      {showPngCompressionControls && (
        <section
          className="rounded-md border p-3"
          style={{
            background: 'var(--surface-1)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div className="flex items-start gap-2">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
              }}
            >
              <Zap className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            </span>
            <div className="flex-1">
              <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                <Trans>PNG Compression</Trans>
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                <Trans>Enable or disable PNG compression for PNG-based formats.</Trans>
              </p>
            </div>
          </div>

          <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <SettingRow
              label={_(msg`Compression`)}
              description={_(msg`Auto adapts by AA level, Off is fastest, On favors smaller PNG files`)}
            >
              <SegmentedControl
                label={_(msg`Compression`)}
                options={[
                  { value: 'auto', label: _(msg`Auto`) },
                  { value: 'off', label: _(msg`Off`) },
                  { value: 'on', label: _(msg`On`) },
                ]}
                value={pngCompressionMode}
                onChange={(next) => patch({
                  pngCompressionStrategy: next === 'auto'
                    ? 'auto'
                    : next === 'off'
                      ? 'fastest'
                      : 'balanced',
                })}
              />
            </SettingRow>
          </div>
        </section>
      )}

      {/* Temp File Cleanup Section */}
      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Trash2 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans>Temp File Cleanup</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Free disk space by removing temporary slice files.</Trans>
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={async () => {
              try {
                const removed = await cleanupStalePrintTempArtifacts(60 * 60);
                alert(formatCleanedStaleAlert(_, removed));
              } catch (error) {
                console.error('[Cleanup] Failed:', error);
                alert(_(msg`Cleanup failed. See console for details.`));
              }
            }}
            className="w-full rounded-md border p-2.5 text-left transition-all hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent),var(--surface-0)_92%)]"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans>Clean Stale Files</Trans>
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Remove temp files older than 1 hour</Trans>
            </div>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (!confirm(_(msg`Delete ALL temporary slice files? This cannot be undone.`))) return;
              try {
                const removed = await cleanupAllPrintTempArtifacts();
                alert(formatCleanedAllAlert(_, removed));
              } catch (error) {
                console.error('[Cleanup] Failed:', error);
                alert(_(msg`Cleanup failed. See console for details.`));
              }
            }}
            className="w-full rounded-md border p-2.5 text-left transition-all hover:border-red-500/50 hover:bg-red-500/5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans>Clean All Files</Trans>
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Emergency cleanup: delete all temp slices</Trans>
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}

export default PerformanceSettingsTab;
