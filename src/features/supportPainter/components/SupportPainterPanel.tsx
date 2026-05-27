import React, { useState } from 'react';
import * as THREE from 'three';
import { supportPainterStore, useSupportPainterState } from '../supportPainterStore';
import { type BrushType, BRUSH_COLORS } from '../supportPainterTypes';
import { generateSupportsFromPainter } from '../supportScriptingEngine';

export function SupportPainterPanel({
  onExit,
  activeModelId,
  getActiveMesh,
}: {
  onExit?: () => void;
  activeModelId?: string | null;
  getActiveMesh?: () => THREE.Mesh | null;
}) {
  const state = useSupportPainterState();
  const [isGenerating, setIsGenerating] = useState(false);

  const handleExit = () => {
    supportPainterStore.deactivate();
    if (onExit) onExit();
  };

  const handleGenerate = async () => {
    if (!activeModelId || !getActiveMesh || state.regions.size === 0) return;
    const mesh = getActiveMesh();
    if (!mesh) return;

    setIsGenerating(true);
    try {
      await generateSupportsFromPainter(activeModelId, mesh, Array.from(state.regions.values()));
      supportPainterStore.clearAll();
      handleExit();
    } catch (err) {
      console.error('[SupportPainterPanel] Generation failed', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const activeColor = BRUSH_COLORS[state.activeBrush];

  return (
    <div
      className="absolute left-3 top-20 z-[70] w-[320px] rounded-xl border p-4 shadow-2xl flex flex-col gap-4 transition-all duration-300"
      style={{
        background: 'color-mix(in srgb, var(--surface-0) 85%, transparent)',
        backdropFilter: 'blur(16px)',
        borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 30%)',
        color: 'var(--text-strong)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: activeColor }} />
          <h3 className="text-sm font-semibold tracking-wide" style={{ fontFamily: 'var(--font-geist-sans)' }}>
            Support Painter
          </h3>
        </div>
        <button
          type="button"
          onClick={handleExit}
          className="rounded-md p-1 hover:bg-white/10 transition-colors text-xs opacity-70 hover:opacity-100"
          title="Exit paint mode"
        >
          ✕
        </button>
      </div>

      {/* Brushes Selection */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider opacity-60 font-semibold">
          Select Smart Brush
        </span>
        <div className="grid grid-cols-2 gap-2">
          {(['MacroFace', 'Ridge', 'Point', 'Cylinder', 'Ring'] as BrushType[]).map((brush) => {
            const isSelected = state.activeBrush === brush;
            const brushColor = BRUSH_COLORS[brush];
            return (
              <button
                key={brush}
                type="button"
                onClick={() => supportPainterStore.setActiveBrush(brush)}
                className={`flex flex-col items-center justify-center p-2.5 rounded-lg border transition-all duration-200 ${
                  isSelected ? 'scale-[1.02] shadow-md' : 'opacity-70 hover:opacity-100'
                }`}
                style={{
                  background: isSelected
                    ? `color-mix(in srgb, ${brushColor} 12%, var(--surface-1))`
                    : 'var(--surface-1)',
                  borderColor: isSelected ? brushColor : 'var(--border-subtle)',
                }}
              >
                <div
                  className="w-3.5 h-3.5 rounded-full mb-1 border"
                  style={{ backgroundColor: brushColor, borderColor: isSelected ? '#ffffff50' : 'transparent' }}
                />
                <span className="text-[11px] font-medium">{brush}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Interaction Context Help */}
      <div
        className="rounded-lg p-2.5 text-[11px] leading-relaxed border"
        style={{
          background: 'color-mix(in srgb, var(--surface-1), transparent 50%)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-muted)',
        }}
      >
        {state.modifierKeys.alt ? (
          <div className="flex items-center gap-1.5 text-orange-400">
            <span className="font-bold">Subtract Mode active:</span> Click on a painted triangle to delete its entire region.
          </div>
        ) : (
          <div>
            Click model to paint regions. Hold <kbd className="px-1 rounded bg-neutral-800 text-[10px] border border-neutral-700">Alt</kbd> + click to subtract.
          </div>
        )}
      </div>

      {/* Painted ROI Regions List */}
      <div className="flex flex-col gap-1.5 flex-1 min-h-[140px] max-h-[260px] overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider opacity-60 font-semibold">
            Painted Regions ({state.regions.size})
          </span>
          {state.regions.size > 0 && (
            <button
              type="button"
              onClick={() => supportPainterStore.clearAll()}
              className="text-[10px] text-red-400 hover:text-red-300 font-medium hover:underline transition-all"
            >
              Clear All
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-1.5 scrollbar-thin">
          {state.regions.size === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center text-[11px] opacity-40 italic">
              No regions painted yet
            </div>
          ) : (
            Array.from(state.regions.values())
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((region) => (
                <div
                  key={region.id}
                  className="flex items-center justify-between p-2 rounded-lg border text-xs bg-white/5"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded border" style={{ backgroundColor: region.color, borderColor: '#ffffff20' }} />
                    <div className="flex flex-col">
                      <span className="font-medium">{region.brushType}</span>
                      <span className="text-[9px] opacity-50">Seed #{region.seedTriangleId}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 opacity-80">
                      {region.triangleIds.size} tri
                    </span>
                    <button
                      type="button"
                      onClick={() => supportPainterStore.removeRegion(region.id)}
                      className="p-1 hover:bg-red-500/20 rounded text-[10px] text-red-400 hover:text-red-300 transition-colors"
                      title="Delete region"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))
          )}
        </div>
      </div>

      {/* Footer Support Generation */}
      <button
        type="button"
        disabled={state.regions.size === 0 || isGenerating}
        onClick={handleGenerate}
        className={`w-full py-2.5 rounded-lg text-xs font-semibold text-center border transition-all duration-200 ${
          state.regions.size === 0 || isGenerating
            ? 'opacity-40 cursor-not-allowed bg-neutral-800 border-neutral-700 text-neutral-400'
            : 'hover:scale-[1.01] hover:shadow-lg active:scale-[0.99] border-[#ff5b6f]/30 text-white cursor-pointer'
        }`}
        style={{
          background: state.regions.size === 0 || isGenerating
            ? 'var(--surface-1)'
            : 'linear-gradient(135deg, #ff5b6f 0%, #d92b43 100%)',
          borderColor: state.regions.size === 0 || isGenerating
            ? 'var(--border-subtle)'
            : '#ff5b6f50',
        }}
      >
        {isGenerating ? 'Generating Supports...' : `Generate Supports (${state.regions.size} Regions)`}
      </button>
    </div>
  );
}
