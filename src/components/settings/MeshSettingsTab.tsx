'use client';

import React from 'react';
import { MATCAP_OPTIONS, MESH_SHADER_OPTIONS, type MatcapVariant, type MeshShaderType } from '@/features/shaders/mesh';
import { HexColorPicker } from 'react-colorful';
import { MeshShaderPreviewSlot } from '@/components/settings/meshSettings/MeshShaderPreviewSlot';
import { Input, Select } from '@/components/ui/primitives';

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
  hoverTintStrength: number;
  onHoverTintStrengthChange: (value: number) => void;
  selectedTintStrength: number;
  onSelectedTintStrengthChange: (value: number) => void;
  heatmapBlend: number;
  onHeatmapBlendChange: (value: number) => void;
  heatmapContrast: number;
  onHeatmapContrastChange: (value: number) => void;
  heatmapColors: string[];
  onHeatmapColorChange: (index: number, color: string) => void;
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
  hoverTintStrength,
  onHoverTintStrengthChange,
  selectedTintStrength,
  onSelectedTintStrengthChange,
  heatmapBlend,
  onHeatmapBlendChange,
  heatmapContrast,
  onHeatmapContrastChange,
  heatmapColors,
  onHeatmapColorChange,
}: MeshSettingsTabProps) {
  const [previewModel, setPreviewModel] = React.useState<string>('knot');
  const [stlPreviewModels, setStlPreviewModels] = React.useState<PreviewModelConfig[]>([]);
  const [activeColorIndex, setActiveColorIndex] = React.useState<number>(0);

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

  const showLighting = shaderType === 'soft_clay' || shaderType === 'toon' || shaderType === 'xray';
  const showRoughness = shaderType === 'soft_clay' || shaderType === 'xray';

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
    <div className="flex flex-col gap-2">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1 min-w-0">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Shader Type</label>
            <Select
              value={shaderType}
              onChange={(e) => onShaderTypeChange(e.target.value as MeshShaderType)}
              className="w-full !h-8"
            >
              {MESH_SHADER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1 min-w-0">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Preview Model</label>
            <Select
              value={previewModel}
              onChange={(e) => setPreviewModel(e.target.value)}
              className="w-full !h-8"
            >
              <option value="cube">Cube</option>
              <option value="sphere">Sphere</option>
              <option value="knot">Knot</option>
              {stlPreviewModels.map((m) => (
                <option key={m.file} value={`stl:/mesh-preview-models/${m.file}`}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div style={{ aspectRatio: '1 / 1' }}>
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
            className="bg-neutral-900/50 rounded-lg border border-neutral-700/50 p-2 flex flex-col gap-1.5"
            style={{ aspectRatio: '1 / 1' }}
          >
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                {activeColorIndex === 0 ? 'Mesh Color' : 'Heatmap Color'}
              </label>
              <Input
                type="text"
                value={activeColorIndex === 0 ? meshColor : heatmapColors[activeColorIndex - 1]}
                onChange={(e) => {
                  if (activeColorIndex === 0) onMeshColorChange(e.target.value);
                  else onHeatmapColorChange(activeColorIndex - 1, e.target.value);
                }}
                className="flex-1 !h-8"
                placeholder="#a3a3a3"
              />
            </div>

            <div className="flex-1 min-h-0 rounded-md overflow-hidden bg-neutral-800/40 p-1">
              <HexColorPicker
                color={activeColorIndex === 0 ? meshColor : heatmapColors[activeColorIndex - 1]}
                onChange={(c) => {
                  if (activeColorIndex === 0) onMeshColorChange(c);
                  else onHeatmapColorChange(activeColorIndex - 1, c);
                }}
                style={{ width: '100%', height: '100%' }}
              />
            </div>

            {shaderType === 'overhang_heatmap' && (
              <div className="flex gap-1.5 mt-1">
                <button
                  type="button"
                  onClick={() => setActiveColorIndex(0)}
                  className={`w-6 h-6 rounded border ${activeColorIndex === 0 ? 'border-white' : 'border-neutral-600'}`}
                  style={{ backgroundColor: meshColor }}
                  title="Mesh Color"
                />
                <div className="w-[1px] bg-neutral-700 mx-1" />
                {heatmapColors.map((color, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveColorIndex(idx + 1)}
                    className={`flex-1 h-6 rounded border ${activeColorIndex === idx + 1 ? 'border-white' : 'border-neutral-600'}`}
                    style={{ backgroundColor: color }}
                    title={`Heatmap Color ${idx + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-neutral-800 pt-2">
        <div className="grid grid-cols-2 gap-2">
          {shaderType === 'matcap' && (
            <div className="space-y-1 min-w-0">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Matcap</label>
              <Select
                value={matcapVariant}
                onChange={(e) => onMatcapVariantChange(e.target.value as MatcapVariant)}
                className="w-full !h-8"
              >
                {MATCAP_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {shaderType === 'flat_unlit' && (
            <div className="space-y-1 min-w-0">
              <label className="text-xs font-medium text-neutral-300">Flat / Unlit</label>
              <label className="flex items-center justify-between gap-3 rounded border border-neutral-700 bg-neutral-900 px-2 py-1">
                <span className="text-xs text-neutral-300">Use vertex colors</span>
                <input
                  type="checkbox"
                  checked={flatUseVertexColors}
                  onChange={(e) => onFlatUseVertexColorsChange(e.target.checked)}
                  className="h-4 w-4 accent-blue-500"
                />
              </label>
            </div>
          )}

          {shaderType === 'toon' && (
            <div className="space-y-0.5">
              <label className="text-xs text-neutral-400 flex justify-between">
                <span>Toon Steps</span>
                <span className="text-neutral-300">{toonSteps}</span>
              </label>
              <input
                type="range"
                min="2"
                max="16"
                step="1"
                value={toonSteps}
                onChange={(e) => onToonStepsChange(parseInt(e.target.value, 10))}
                className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )}

          {showRoughness && (
            <div className="space-y-0.5">
              <label className="text-xs text-neutral-400 flex justify-between">
                <span>Roughness</span>
                <span className="text-neutral-300">{materialRoughness.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.05"
                value={materialRoughness}
                onChange={(e) => onMaterialRoughnessChange(parseFloat(e.target.value))}
                className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )}

          {showLighting && (
            <div className="space-y-0.5">
              <label className="text-xs text-neutral-400 flex justify-between">
                <span>Lightness</span>
                <span className="text-neutral-300">{lightness.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min="0.2"
                max="3.0"
                step="0.05"
                value={lightness}
                onChange={(e) => onLightnessChange(parseFloat(e.target.value))}
                className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )}

          {showLighting && (
            <div className="space-y-0.5">
              <label className="text-xs text-neutral-400 flex justify-between">
                <span>Contrast</span>
                <span className="text-neutral-300">{contrast.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min="0.05"
                max="0.95"
                step="0.01"
                value={contrast}
                onChange={(e) => onContrastChange(parseFloat(e.target.value))}
                className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )}

          {shaderType === 'xray' && (
            <div className="space-y-0.5">
              <label className="text-xs text-neutral-400 flex justify-between">
                <span>X-ray Opacity</span>
                <span className="text-neutral-300">{xrayOpacity.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min="0.02"
                max="0.85"
                step="0.01"
                value={xrayOpacity}
                onChange={(e) => onXrayOpacityChange(parseFloat(e.target.value))}
                className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )}

          {shaderType === 'overhang_heatmap' && (
            <>
              <div className="space-y-0.5">
                <label className="text-xs text-neutral-400 flex justify-between">
                  <span>Heatmap Blend</span>
                  <span className="text-neutral-300">{heatmapBlend.toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.01"
                  value={heatmapBlend}
                  onChange={(e) => onHeatmapBlendChange(parseFloat(e.target.value))}
                  className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
              <div className="space-y-0.5">
                <label className="text-xs text-neutral-400 flex justify-between">
                  <span>Heatmap Contrast</span>
                  <span className="text-neutral-300">{heatmapContrast.toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="3.0"
                  step="0.05"
                  value={heatmapContrast}
                  onChange={(e) => onHeatmapContrastChange(parseFloat(e.target.value))}
                  className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            </>
          )}

          <div className="space-y-0.5">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Hover Tint Strength</span>
              <span className="text-neutral-300">{hoverTintStrength.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={hoverTintStrength}
              onChange={(e) => onHoverTintStrengthChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          <div className="space-y-0.5">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Selected Tint Strength</span>
              <span className="text-neutral-300">{selectedTintStrength.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={selectedTintStrength}
              onChange={(e) => onSelectedTintStrengthChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
