'use client';

import React from 'react';
import { HexColorPicker } from 'react-colorful';
import { RotateCcw } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import {
  DEFAULT_MESH_SMOOTHING_SETTINGS,
  clampMeshSmoothingBrushSizeMm,
  getMeshSmoothingSettings,
  loadMeshSmoothingSettingsFromLocalStorage,
  saveMeshSmoothingSettingsToLocalStorage,
  setMeshSmoothingSettings,
  subscribeToMeshSmoothingSettings,
  updateMeshSmoothingSettings,
  type MeshSmoothingFalloff,
} from './settings';

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="py-0.5 text-center text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-strong)' }}>
      {title}
    </div>
  );
}

export function MeshSmoothingSettingsPanel() {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [settings, setSettings] = React.useState(() => getMeshSmoothingSettings());

  React.useEffect(() => {
    loadMeshSmoothingSettingsFromLocalStorage();
    setSettings(getMeshSmoothingSettings());

    const unsubscribe = subscribeToMeshSmoothingSettings(() => {
      setSettings(getMeshSmoothingSettings());
    });

    return () => {
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    saveMeshSmoothingSettingsToLocalStorage();
  }, [
    settings.brushSizeMm,
    settings.strength,
    settings.highlightColor,
    settings.falloff,
    settings.iterations,
  ]);

  const clampedColorInput = React.useMemo(() => {
    const raw = settings.highlightColor.trim();
    return raw.startsWith('#') ? raw.toUpperCase() : `#${raw.toUpperCase()}`;
  }, [settings.highlightColor]);

  const brushCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, #4f8cff, var(--border-subtle) 78%)',
    background: 'color-mix(in srgb, #4f8cff, var(--surface-1) 94%)',
  };

  const highlightCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, #8f6cff, var(--border-subtle) 80%)',
    background: 'color-mix(in srgb, #8f6cff, var(--surface-1) 95%)',
  };

  const valueInputClass = 'ui-input h-8 w-full px-2 text-xs sm:text-sm text-center tabular-nums no-spinners';

  return (
    <Card className="w-full overflow-x-hidden shadow-xl">
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
              className="!p-0.5"
              title={expanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Mesh Smoothing</h3>
          </>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2 max-h-[calc(100vh-var(--topbar-height)-88px)] overflow-y-auto custom-scrollbar">

          {/* BRUSH SECTION */}
          <div className="rounded-md border p-2" style={brushCardStyle}>
            <SectionHeader title="Brush" />
            <div className="pt-1.5 space-y-2">
              <div className="relative">
                <NumberInput
                  value={settings.brushSizeMm}
                  onChange={(val) => updateMeshSmoothingSettings({ brushSizeMm: clampMeshSmoothingBrushSizeMm(val) })}
                  className={valueInputClass}
                  showStepper={false}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
              </div>

              <div className="relative">
                <NumberInput
                  value={settings.strength}
                  onChange={(val) => updateMeshSmoothingSettings({ strength: Math.min(1, Math.max(0, val)) })}
                  className={valueInputClass}
                  step={0.01}
                  showStepper={false}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>Strength</span>
              </div>

              <div className="relative">
                <NumberInput
                  value={settings.iterations}
                  onChange={(val) => updateMeshSmoothingSettings({ iterations: Math.round(Math.min(20, Math.max(1, val))) })}
                  className={valueInputClass}
                  step={1}
                  showStepper={false}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>Iterations</span>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                {(['linear', 'smooth', 'sharp'] as MeshSmoothingFalloff[]).map((falloff) => (
                  <button
                    key={falloff}
                    type="button"
                    onClick={() => updateMeshSmoothingSettings({ falloff })}
                    className="min-h-[36px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                    style={
                      settings.falloff === falloff
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)',
                            color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                          }
                    }
                  >
                    {falloff}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* HIGHLIGHT SECTION */}
          <div className="rounded-md border p-2" style={highlightCardStyle}>
            <SectionHeader title="Highlight" />
            <div className="pt-1.5 space-y-2">
              <div className="flex items-center gap-2">
                <div
                  className="h-8 w-8 shrink-0 rounded-md border"
                  style={{
                    background: settings.highlightColor,
                    borderColor: 'color-mix(in srgb, var(--border-subtle), white 8%)',
                  }}
                />
                <input
                  type="text"
                  value={clampedColorInput}
                  onChange={(e) => updateMeshSmoothingSettings({ highlightColor: e.target.value })}
                  className="ui-input flex-1 min-w-0 h-8 text-xs uppercase"
                  placeholder="#269EFF"
                />
              </div>

              <div
                className="h-28 rounded-md border p-1 overflow-hidden"
                data-no-drag="true"
                style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-0), transparent 6%)' }}
              >
                <HexColorPicker
                  data-no-drag="true"
                  color={settings.highlightColor}
                  onChange={(c) => updateMeshSmoothingSettings({ highlightColor: c })}
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
            </div>
          </div>

          <button
            type="button"
            className="ui-button ui-button-secondary w-full !h-8 px-3 text-xs inline-flex items-center justify-center gap-1.5"
            onClick={() => setMeshSmoothingSettings({ ...DEFAULT_MESH_SMOOTHING_SETTINGS })}
          >
            <RotateCcw className="w-3 h-3" />
            Reset Defaults
          </button>

        </div>
      )}
    </Card>
  );
}
