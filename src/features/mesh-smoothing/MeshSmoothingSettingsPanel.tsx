'use client';

import React from 'react';
import { HexColorPicker } from 'react-colorful';
import { RotateCcw } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
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

const FALLOFF_LABELS: Record<MeshSmoothingFalloff, MessageDescriptor> = {
  linear: msg({ message: 'Linear', context: 'Brush falloff', comment: 'Smoothing brush falloff: strength fades evenly from the centre to the edge. Rendered uppercase on a narrow button.' }),
  smooth: msg({ message: 'Smooth', context: 'Brush falloff', comment: 'Smoothing brush falloff: strength fades along a soft curve. Adjective, not the verb. Rendered uppercase on a narrow button.' }),
  sharp: msg({ message: 'Sharp', context: 'Brush falloff', comment: 'Smoothing brush falloff: strength drops quickly away from the centre. Rendered uppercase on a narrow button.' }),
};

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="py-0.5 text-center text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-strong)' }}>
      {title}
    </div>
  );
}

export function MeshSmoothingSettingsPanel() {
  const { _ } = useLingui();
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
            <PanelCollapseToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Mesh Smoothing</Trans></h3>
          </>
        )}
      />

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2 max-h-[calc(100vh-var(--topbar-height)-88px)] overflow-y-auto custom-scrollbar">

          {/* BRUSH SECTION */}
          <div className="rounded-md border p-2" style={brushCardStyle}>
            <SectionHeader title={_(msg`Brush`)} />
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
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}><Trans>Strength</Trans></span>
              </div>

              <div className="relative">
                <NumberInput
                  value={settings.iterations}
                  onChange={(val) => updateMeshSmoothingSettings({ iterations: Math.round(Math.min(20, Math.max(1, val))) })}
                  className={valueInputClass}
                  step={1}
                  showStepper={false}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}><Trans>Iterations</Trans></span>
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
                    {_(FALLOFF_LABELS[falloff])}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* HIGHLIGHT SECTION */}
          <div className="rounded-md border p-2" style={highlightCardStyle}>
            <SectionHeader title={_(msg({ message: 'Highlight', comment: 'Section heading: the colour that marks the area the smoothing brush touches.' }))} />
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

          <Button
            variant="secondary"
            size="auto"
            className="w-full !h-8 px-3 text-xs inline-flex items-center justify-center gap-1.5"
            onClick={() => setMeshSmoothingSettings({ ...DEFAULT_MESH_SMOOTHING_SETTINGS })}
          >
            <RotateCcw className="w-3 h-3" />
            <Trans>Restore defaults</Trans>
          </Button>

        </div>
      )}
    </Card>
  );
}
