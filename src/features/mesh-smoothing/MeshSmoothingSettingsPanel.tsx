'use client';

import React from 'react';
import { HexColorPicker } from 'react-colorful';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_MESH_SMOOTHING_SETTINGS,
  MESH_SMOOTHING_BRUSH_SIZE_MM,
  clampMeshSmoothingBrushSizeMm,
  getMeshSmoothingSettings,
  loadMeshSmoothingSettingsFromLocalStorage,
  saveMeshSmoothingSettingsToLocalStorage,
  setMeshSmoothingSettings,
  subscribeToMeshSmoothingSettings,
  updateMeshSmoothingSettings,
  type MeshSmoothingFalloff,
} from './settings';

export function MeshSmoothingSettingsPanel() {
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

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2 space-y-2">

        <div
          className="rounded-md border p-2 space-y-2"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Brush Dynamics
          </div>

          <div className="space-y-0.5">
            <label className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>Brush Size</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums" style={{ color: 'var(--text-strong)', background: 'var(--surface-0)' }}>
                {settings.brushSizeMm.toFixed(2)} mm
              </span>
            </label>
            <input
              type="range"
              min={MESH_SMOOTHING_BRUSH_SIZE_MM.min}
              max={MESH_SMOOTHING_BRUSH_SIZE_MM.max}
              step={MESH_SMOOTHING_BRUSH_SIZE_MM.step}
              value={settings.brushSizeMm}
              onChange={(e) => updateMeshSmoothingSettings({ brushSizeMm: clampMeshSmoothingBrushSizeMm(parseFloat(e.target.value)) })}
              className="ui-range"
            />
          </div>

          <div className="space-y-0.5">
            <label className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>Strength</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums" style={{ color: 'var(--text-strong)', background: 'var(--surface-0)' }}>
                {settings.strength.toFixed(2)}
              </span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings.strength}
              onChange={(e) => updateMeshSmoothingSettings({ strength: parseFloat(e.target.value) })}
              className="ui-range"
            />
          </div>

          <div className="space-y-1">
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Falloff</div>
            <div
              className="flex rounded-md overflow-hidden border"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              {(['linear', 'smooth', 'sharp'] as MeshSmoothingFalloff[]).map((falloff, i) => (
                <button
                  key={falloff}
                  type="button"
                  onClick={() => updateMeshSmoothingSettings({ falloff })}
                  className={`flex-1 py-1 text-[11px] font-medium capitalize transition-colors${i > 0 ? ' border-l' : ''}`}
                  style={
                    settings.falloff === falloff
                      ? { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--border-subtle)' }
                      : { background: 'var(--surface-1)', color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }
                  }
                >
                  {falloff}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-0.5">
            <label className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>Iterations</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums" style={{ color: 'var(--text-strong)', background: 'var(--surface-0)' }}>
                {settings.iterations}
              </span>
            </label>
            <input
              type="range"
              min="1"
              max="20"
              step="1"
              value={settings.iterations}
              onChange={(e) => updateMeshSmoothingSettings({ iterations: parseInt(e.target.value, 10) })}
              className="ui-range"
            />
          </div>
        </div>

        <div
          className="rounded-md border p-2 space-y-2"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Paint Highlight
          </div>

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
              className="ui-input flex-1 h-8 text-xs uppercase"
              placeholder="#269EFF"
            />
          </div>

          <div
            className="h-36 rounded-md border p-1 overflow-hidden"
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

        <button
          type="button"
          className="ui-button ui-button-secondary w-full !h-8 px-3 text-xs inline-flex items-center justify-center gap-1.5"
          onClick={() => setMeshSmoothingSettings({ ...DEFAULT_MESH_SMOOTHING_SETTINGS })}
        >
          <RotateCcw className="w-3 h-3" />
          Reset Defaults
        </button>

      </div>
    </div>
  );
}
