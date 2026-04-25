'use client';

import React from 'react';
import { MATCAP_OPTIONS, MESH_SHADER_OPTIONS, type MatcapVariant, type MeshShaderType } from '@/features/shaders/mesh';
import { HexColorPicker } from 'react-colorful';
import { MeshShaderPreviewSlot } from '@/components/settings/meshSettings/MeshShaderPreviewSlot';
import { MeshShaderPreviewCanvas } from '@/components/settings/meshSettings/MeshShaderPreviewCanvas';
import { SelectionHighlightDropdown } from '@/components/controls/SelectionHighlightDropdown';
import type { SelectionHighlightMode } from '@/components/selection';
import { Input, Select } from '@/components/ui/primitives';
import { Layers, MousePointer2, SlidersHorizontal } from 'lucide-react';

type PreviewModelConfig = {
  label: string;
  file: string;
};

type PreviewModelsManifest = {
  models: PreviewModelConfig[];
};

type MeshSettingsTabProps = {
  shaderType: MeshShaderType;
  onShaderTypeChange: (shaderType: MeshShaderType) => void;
  matcapVariant: MatcapVariant;
  onMatcapVariantChange: (variant: MatcapVariant) => void;
  flatUseVertexColors: boolean;
  onFlatUseVertexColorsChange: (value: boolean) => void;
  toonSteps: number;
  onToonStepsChange: (value: number) => void;
  meshColor: string;
  onMeshColorChange: (color: string) => void;
  ambientIntensity: number;
  onAmbientIntensityChange: (value: number) => void;
  directionalIntensity: number;
  onDirectionalIntensityChange: (value: number) => void;
  materialRoughness: number;
  onMaterialRoughnessChange: (value: number) => void;
  xrayOpacity: number;
  onXrayOpacityChange: (value: number) => void;
  heatmapBlend: number;
  onHeatmapBlendChange: (value: number) => void;
  heatmapContrast: number;
  onHeatmapContrastChange: (value: number) => void;
  heatmapColors: string[];
  onHeatmapColorChange: (index: number, color: string) => void;
  selectionColor: string;
  hoverColor: string;
  selectionHighlightMode: SelectionHighlightMode;
  onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
  hoverTintStrength: number;
  onHoverTintStrengthChange: (value: number) => void;
  selectedTintStrength: number;
  onSelectedTintStrengthChange: (value: number) => void;
};

export function MeshSettingsTab({
  shaderType,
  onShaderTypeChange,
  matcapVariant,
  onMatcapVariantChange,
  flatUseVertexColors,
  onFlatUseVertexColorsChange,
  toonSteps,
  onToonStepsChange,
  meshColor,
  onMeshColorChange,
  ambientIntensity,
  onAmbientIntensityChange,
  directionalIntensity,
  onDirectionalIntensityChange,
  materialRoughness,
  onMaterialRoughnessChange,
  xrayOpacity,
  onXrayOpacityChange,
  heatmapBlend,
  onHeatmapBlendChange,
  heatmapContrast,
  onHeatmapContrastChange,
  heatmapColors,
  onHeatmapColorChange,
  selectionColor,
  hoverColor,
  selectionHighlightMode,
  onSelectionHighlightModeChange,
  hoverTintStrength,
  onHoverTintStrengthChange,
  selectedTintStrength,
  onSelectedTintStrengthChange,
}: MeshSettingsTabProps) {
  const [previewModel, setPreviewModel] = React.useState<string>('knot');
  const [stlPreviewModels, setStlPreviewModels] = React.useState<PreviewModelConfig[]>([]);
  const [activeColorIndex, setActiveColorIndex] = React.useState<number>(0);
  const [isPreviewHovered, setIsPreviewHovered] = React.useState(false);
  const [isPreviewSelected, setIsPreviewSelected] = React.useState(false);

  React.useEffect(() => {
    if (selectionHighlightMode === 'none') {
      setIsPreviewSelected(false);
    }
  }, [selectionHighlightMode]);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/mesh-preview-models/models.json', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as PreviewModelsManifest;
        if (!cancelled && Array.isArray(data.models)) {
          setStlPreviewModels(data.models);
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const totalLight = ambientIntensity + directionalIntensity;
  const lightness = Math.min(4, Math.max(0, totalLight));
  const contrast = totalLight > 0 ? directionalIntensity / totalLight : 0.5;
  const previewSelectedTintColor = selectionHighlightMode === 'spotlight' ? '#ffffff' : selectionColor;
  const previewSelectedTintStrength = selectionHighlightMode === 'spotlight'
    ? Math.max(selectedTintStrength, 0.94)
    : selectedTintStrength;

  const showLighting = shaderType === 'soft_clay' || shaderType === 'toon' || shaderType === 'xray';
  const showRoughness = shaderType === 'soft_clay' || shaderType === 'xray';
  const hasRenderingOptions =
    shaderType === 'matcap' ||
    shaderType === 'flat_unlit' ||
    shaderType === 'toon' ||
    showRoughness ||
    showLighting ||
    shaderType === 'overhang_heatmap';

  const activeHexColor = activeColorIndex === 0 ? meshColor : heatmapColors[activeColorIndex - 1];
  const onActiveHexChange = React.useCallback((c: string) => {
    if (activeColorIndex === 0) onMeshColorChange(c);
    else onHeatmapColorChange(activeColorIndex - 1, c);
  }, [activeColorIndex, onMeshColorChange, onHeatmapColorChange]);

  const onLightnessChange = React.useCallback((next: number) => {
    const c = contrast;
    onAmbientIntensityChange((1 - c) * next);
    onDirectionalIntensityChange(c * next);
  }, [contrast, onAmbientIntensityChange, onDirectionalIntensityChange]);

  const onContrastChange = React.useCallback((next: number) => {
    const t = lightness;
    onAmbientIntensityChange((1 - next) * t);
    onDirectionalIntensityChange(next * t);
  }, [lightness, onAmbientIntensityChange, onDirectionalIntensityChange]);

  return (
    <div className="space-y-3">

      {/* ── Shader & Preview ─────────────────────────────────── */}
      <section
        className="rounded-lg border p-3"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex items-start gap-2 mb-3">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <Layers className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Shader &amp; Preview
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Choose the active render shader and tune the mesh color.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-2">
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
              Shader Type
            </label>
            <Select
              value={shaderType}
              onChange={(e) => onShaderTypeChange(e.target.value as MeshShaderType)}
              className="w-full !h-8"
            >
              {MESH_SHADER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </div>

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
              Preview Model
            </label>
            <Select
              value={previewModel}
              onChange={(e) => setPreviewModel(e.target.value)}
              className="w-full !h-8"
            >
              <option value="cube">Cube</option>
              <option value="sphere">Sphere</option>
              <option value="knot">Knot</option>
              {stlPreviewModels.map((m) => (
                <option key={m.file} value={`stl:/mesh-preview-models/${m.file}`}>{m.label}</option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div
            className="rounded-md border overflow-hidden"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', aspectRatio: '10 / 7' }}
          >
            <MeshShaderPreviewSlot
              shaderType={shaderType}
              matcapVariant={matcapVariant}
              flatUseVertexColors={flatUseVertexColors}
              toonSteps={toonSteps}
              meshColor={meshColor}
              materialRoughness={materialRoughness}
              previewModel={previewModel}
              ambientIntensity={ambientIntensity}
              directionalIntensity={directionalIntensity}
              xrayOpacity={xrayOpacity}
              heatmapBlend={heatmapBlend}
              heatmapContrast={heatmapContrast}
              heatmapColors={heatmapColors}
              hoverTintStrength={0.5}
              selectedTintStrength={0.75}
            />
          </div>

          <div
            className="rounded-md border p-2 flex flex-col gap-1.5"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', aspectRatio: '10 / 7' }}
          >
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-medium whitespace-nowrap shrink-0" style={{ color: 'var(--text-muted)' }}>
                {activeColorIndex === 0 ? 'Mesh Color' : `Heatmap ${activeColorIndex}`}
              </label>
              <Input
                type="text"
                value={activeHexColor}
                onChange={(e) => onActiveHexChange(e.target.value)}
                className="flex-1 !h-7 min-w-0"
                placeholder="#a3a3a3"
              />
            </div>

            <div className="flex-1 min-h-0 rounded overflow-hidden" style={{ background: 'var(--surface-2)' }}>
              <HexColorPicker
                color={activeHexColor}
                onChange={onActiveHexChange}
                style={{ width: '100%', height: '100%' }}
              />
            </div>

            {shaderType === 'overhang_heatmap' && (
              <div className="flex items-center gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={() => setActiveColorIndex(0)}
                  className="h-5 w-5 rounded border transition-all"
                  style={{
                    backgroundColor: meshColor,
                    borderColor: activeColorIndex === 0 ? 'var(--text-strong)' : 'var(--border-strong)',
                    boxShadow: activeColorIndex === 0 ? '0 0 0 1px var(--accent)' : 'none',
                  }}
                  title="Mesh Color"
                />
                <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border-subtle)' }} />
                {heatmapColors.map((color, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveColorIndex(idx + 1)}
                    className="flex-1 h-5 rounded border transition-all"
                    style={{
                      backgroundColor: color,
                      borderColor: activeColorIndex === idx + 1 ? 'var(--text-strong)' : 'var(--border-strong)',
                      boxShadow: activeColorIndex === idx + 1 ? '0 0 0 1px var(--accent)' : 'none',
                    }}
                    title={`Heatmap Color ${idx + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {hasRenderingOptions && (
          <>
            <div className="flex items-center gap-2 mt-3">
              <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
              <span className="flex items-center gap-1.5 text-[11px] font-semibold shrink-0" style={{ color: 'var(--text-muted)' }}>
                <SlidersHorizontal className="h-3 w-3" />
                Rendering Options
              </span>
              <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
            </div>

            <div className="grid grid-cols-2 gap-2 mt-2">
            {shaderType === 'matcap' && (
              <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <label className="text-[11px] font-medium block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  Matcap Style
                </label>
                <Select
                  value={matcapVariant}
                  onChange={(e) => onMatcapVariantChange(e.target.value as MatcapVariant)}
                  className="w-full !h-8"
                >
                  {MATCAP_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </Select>
              </div>
            )}

            {shaderType === 'flat_unlit' && (
              <div className="col-span-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Vertex Colors</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Sample per-vertex color data when available.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onFlatUseVertexColorsChange(!flatUseVertexColors)}
                    className="h-9 min-w-[72px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                    style={flatUseVertexColors
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
                    {flatUseVertexColors ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
            )}

            {shaderType === 'toon' && (
              <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-medium" style={{ color: 'var(--text-muted)' }}>Toon Steps</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{toonSteps}</span>
                </div>
                <input
                  type="range" min="2" max="16" step="1"
                  value={toonSteps}
                  onChange={(e) => onToonStepsChange(parseInt(e.target.value, 10))}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                />
              </div>
            )}

            {showRoughness && (
              <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-medium" style={{ color: 'var(--text-muted)' }}>Roughness</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{materialRoughness.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0.0" max="1.0" step="0.05"
                  value={materialRoughness}
                  onChange={(e) => onMaterialRoughnessChange(parseFloat(e.target.value))}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                />
              </div>
            )}

            {showLighting && (
              <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-medium" style={{ color: 'var(--text-muted)' }}>Lightness</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{lightness.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0.2" max="3.0" step="0.05"
                  value={lightness}
                  onChange={(e) => onLightnessChange(parseFloat(e.target.value))}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                />
              </div>
            )}

            {showLighting && (
              <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-medium" style={{ color: 'var(--text-muted)' }}>Contrast</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{contrast.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0.05" max="0.95" step="0.01"
                  value={contrast}
                  onChange={(e) => onContrastChange(parseFloat(e.target.value))}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                />
              </div>
            )}

            {shaderType === 'xray' && (
              <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-medium" style={{ color: 'var(--text-muted)' }}>X-Ray Opacity</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{xrayOpacity.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0.02" max="0.85" step="0.01"
                  value={xrayOpacity}
                  onChange={(e) => onXrayOpacityChange(parseFloat(e.target.value))}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                />
              </div>
            )}

            {shaderType === 'overhang_heatmap' && (
              <>
                <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="font-medium" style={{ color: 'var(--text-muted)' }}>Heatmap Blend</span>
                    <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{heatmapBlend.toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0.0" max="1.0" step="0.01"
                    value={heatmapBlend}
                    onChange={(e) => onHeatmapBlendChange(parseFloat(e.target.value))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                  />
                </div>
                <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="font-medium" style={{ color: 'var(--text-muted)' }}>Heatmap Contrast</span>
                    <span className="font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{heatmapContrast.toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0.5" max="3.0" step="0.05"
                    value={heatmapContrast}
                    onChange={(e) => onHeatmapContrastChange(parseFloat(e.target.value))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                  />
                </div>
              </>
            )}
          </div>
          </>
        )}
      </section>

      {/* ── Selection ────────────────────────────────────────── */}
      <section
        className="rounded-lg border p-3"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex items-start gap-2 mb-3">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <MousePointer2 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Selection
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              How selected and hovered models are emphasized throughout the app.
            </p>
          </div>
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-stretch">
          <div className="min-w-0 space-y-2">
            <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Highlight Mode</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Visual style applied to selected and hovered meshes.</div>
                </div>
                <SelectionHighlightDropdown
                  value={selectionHighlightMode}
                  onChange={onSelectionHighlightModeChange}
                  fullWidth={false}
                />
              </div>
            </div>

            <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Colors</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Selection (Theme Accent)</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={selectionColor}
                      readOnly
                      disabled
                      className="h-8 w-10 shrink-0 rounded border"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', opacity: 0.7 }}
                    />
                    <input
                      type="text"
                      value={selectionColor}
                      readOnly
                      className="ui-input h-8 w-[7.5rem] min-w-0"
                      placeholder="#ec2a77"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Hover (Theme Accent Hover)</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={hoverColor}
                      readOnly
                      disabled
                      className="h-8 w-10 shrink-0 rounded border"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', opacity: 0.7 }}
                    />
                    <input
                      type="text"
                      value={hoverColor}
                      readOnly
                      className="ui-input h-8 w-[7.5rem] min-w-0"
                      placeholder="#ec2a77"
                    />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Managed by <strong>UI &amp; Theme</strong> → <strong>Accent</strong> and <strong>Accent Hover</strong>.
              </p>
            </div>

            <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Tint Intensity</div>
              <div className="space-y-2">
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span style={{ color: 'var(--text-muted)' }}>Hover</span>
                    <span className="tabular-nums" style={{ color: 'var(--text-strong)' }}>{hoverTintStrength.toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={hoverTintStrength}
                    onChange={(e) => onHoverTintStrengthChange(parseFloat(e.target.value))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span style={{ color: 'var(--text-muted)' }}>Selected</span>
                    <span className="tabular-nums" style={{ color: 'var(--text-strong)' }}>{selectedTintStrength.toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={selectedTintStrength}
                    onChange={(e) => onSelectedTintStrengthChange(parseFloat(e.target.value))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[16rem] lg:min-h-full lg:justify-self-end">
            <div
              className="rounded-lg border p-2 w-full lg:w-[20rem] shrink-0 flex flex-col gap-2"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-0)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Selection Preview</span>
                <span
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors"
                  style={
                    isPreviewSelected && selectionHighlightMode !== 'none'
                      ? {
                          color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                          borderColor: 'color-mix(in srgb, var(--accent), white 12%)',
                          background: 'color-mix(in srgb, var(--accent), transparent 22%)',
                        }
                      : isPreviewHovered
                        ? {
                            color: 'var(--text-strong)',
                            borderColor: 'var(--border-strong)',
                            background: 'var(--surface-2)',
                          }
                        : {
                            color: 'var(--text-muted)',
                            borderColor: 'var(--border-subtle)',
                            background: 'transparent',
                          }
                  }
                >
                  {isPreviewSelected && selectionHighlightMode !== 'none'
                    ? 'selected'
                    : isPreviewHovered
                      ? 'hovered'
                      : 'idle'}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                <MeshShaderPreviewCanvas
                  shaderType="soft_clay"
                  matcapVariant="neutral"
                  flatUseVertexColors={true}
                  useVertexColors={false}
                  toonSteps={5}
                  meshColor="#a3a3a3"
                  materialRoughness={0.65}
                  previewModel="knot"
                  ambientIntensity={0.6}
                  directionalIntensity={0.8}
                  xrayOpacity={0.25}
                  heatmapBlend={0}
                  heatmapContrast={1}
                  hoverTintColor={hoverColor}
                  selectedTintColor={previewSelectedTintColor}
                  hoverTintStrength={hoverTintStrength}
                  selectedTintStrength={previewSelectedTintStrength}
                  isSelected={selectionHighlightMode !== 'none' && isPreviewSelected}
                  isHovered={isPreviewHovered}
                  onHoverChange={setIsPreviewHovered}
                  onPress={() => setIsPreviewSelected((prev) => !prev)}
                  onCanvasPress={() => setIsPreviewSelected(false)}
                />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
