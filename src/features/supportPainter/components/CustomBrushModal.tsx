import React, { useState } from 'react';
import {
  X,
  Settings,
  Sliders,
  Grid,
} from 'lucide-react';
import { IconButton, Button } from '@/components/ui/primitives';
import { SymmetricalClockWidget } from './SymmetricalClockWidget';
import { OverhangArcGauge } from './OverhangArcGauge';
import { SupportPipelineEditor } from './SupportPipelineEditor';
import { type CustomBrushTemplate, type CustomSupportOperation, type BrushType } from '../supportPainterTypes';

const safeNum = (val: number | undefined, fallback: number): number => {
  return val === undefined || isNaN(val) ? fallback : val;
};

interface CustomBrushModalProps {
  initialBrush?: CustomBrushTemplate | null;
  onClose: () => void;
  onSave: (brush: CustomBrushTemplate) => void;
}

const PRESET_COLORS = [
  '#FF5B6F', // pink/red
  '#4A90E2', // blue
  '#E2844A', // orange
  '#7ED321', // green
  '#9B59B6', // purple
  '#F5A623', // yellow
  '#00D2C4', // teal
];

const DEFAULT_OPERATIONS: CustomSupportOperation[] = [
  {
    type: 'minima',
    enabled: true,
    suppression: {
      enabled: true,
      distanceMm: 1.5,
      suppressAgainst: ['minima'],
    },
    spacing: {
      baseSpacingMm: 1.5,
    },
  },
  {
    type: 'perimeter',
    enabled: true,
    suppression: {
      enabled: true,
      distanceMm: 2.0,
      suppressAgainst: ['minima', 'perimeter'],
    },
    spacing: {
      baseSpacingMm: 2.0,
      sequence: [1.0, 2.0],
      solverMode: 'closest',
      useInflectionPoints: true,
    },
  },
  {
    type: 'infill',
    enabled: true,
    suppression: {
      enabled: true,
      distanceMm: 3.5,
      suppressAgainst: ['minima', 'perimeter', 'infill'],
    },
    spacing: {
      baseSpacingMm: 4.0,
      infillPattern: 'PoissonDisc',
      seedFromMinima: true,
    },
  },
];

const presets: Record<BrushType, Partial<CustomBrushTemplate['selection']>> = {
  MacroFace: {
    enableSlopeLimit: true,
    enableNormalConeLimit: true,
    enableDihedralLimit: true,
    enableCurvatureLimit: false,
    normalConeAngleMinDeg: 15,
    normalConeAngleMaxDeg: 45,
    overhangSlopeMinDeg: 0,
    overhangSlopeMaxDeg: 60,
    curvatureMin: 0.0,
    curvatureMax: 1.0,
    dihedralAngleToleranceDeg: 30,
  },
  Ridge: {
    creaseSeedAngleDeg: 8,
    creasePropagateAngleDeg: 3,
    ridgeAlignmentTolerance: 0.3,
  },
  Point: {
    geodesicPathType: 'circle',
  },
  Ring: {
    zHeightEnvelopeToleranceMm: 0.1,
  },
  Marker: {
    markerRadiusMm: 0.2,
    markerTipShape: 'circle',
    markerTipRotationDeg: 0,
    markerEraserMode: false,
    markerCollisionMode: 'fence',
  },
  CylinderSides: {},
  CylinderMinima: {},
  ManualCircle: {},
  ManualSquare: {},
  PointPath: {
    pointPathWidthMm: 0.2,
    pointPathMode: 'line',
  },
  MinimaIslands: {},
};

const DEFAULT_TEMPLATE: CustomBrushTemplate = {
  id: '',
  name: 'New Custom Brush',
  color: '#FF5B6F',
  baseBrush: 'MacroFace',
  selection: {
    enableSlopeLimit: true,
    enableNormalConeLimit: true,
    enableDihedralLimit: true,
    enableCurvatureLimit: false,
    normalConeAngleMinDeg: 15,
    normalConeAngleMaxDeg: 45,
    overhangSlopeMinDeg: 0,
    overhangSlopeMaxDeg: 60,
    curvatureMin: 0.0,
    curvatureMax: 1.0,
    dihedralAngleToleranceDeg: 30,
    creaseSeedAngleDeg: 8,
    creasePropagateAngleDeg: 3,
    ridgeAlignmentTolerance: 0.3,
    geodesicPathType: 'circle',
    zHeightEnvelopeToleranceMm: 0.1,
    markerRadiusMm: 1.5,
    markerTipShape: 'circle',
    markerTipRotationDeg: 0,
    markerEraserMode: false,
    markerCollisionMode: 'fence',
  },
  operations: [...DEFAULT_OPERATIONS],
};

export function CustomBrushModal({
  initialBrush,
  onClose,
  onSave,
}: CustomBrushModalProps) {
  const isEditing = !!initialBrush;
  const [activeTab, setActiveTab] = useState<'selection' | 'pipeline'>('selection');
  const [brush, setBrush] = useState<CustomBrushTemplate>(() => {
    if (initialBrush) {
      return {
        ...initialBrush,
        baseBrush: initialBrush.baseBrush || 'MacroFace',
        selection: { ...DEFAULT_TEMPLATE.selection, ...initialBrush.selection },
        operations: initialBrush.operations.map(op => ({
          ...op,
          suppression: { ...op.suppression, suppressAgainst: [...op.suppression.suppressAgainst] },
          spacing: { ...op.spacing, sequence: op.spacing.sequence ? [...op.spacing.sequence] : undefined },
        })),
      };
    }
    return {
      ...DEFAULT_TEMPLATE,
      id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
      operations: DEFAULT_OPERATIONS.map(op => ({
        ...op,
        suppression: { ...op.suppression, suppressAgainst: [...op.suppression.suppressAgainst] },
        spacing: { ...op.spacing, sequence: op.spacing.sequence ? [...op.spacing.sequence] : undefined },
      })),
    };
  });

  const handleSave = () => {
    if (!brush.name.trim()) {
      alert('Please enter a brush name.');
      return;
    }
    onSave(brush);
  };

  const updateSelection = (updates: Partial<typeof brush.selection>) => {
    setBrush(prev => ({
      ...prev,
      selection: { ...prev.selection, ...updates },
    }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md bg-black/45 animate-fade-in"
      style={{ fontFamily: 'Inter, sans-serif' }}
    >
      <div
        className="w-full max-w-2xl rounded-xl border flex flex-col h-[85vh] max-h-[85vh] overflow-hidden shadow-2xl"
        style={{
          background: 'var(--surface-1, #151a22)',
          borderColor: 'var(--border-subtle, #2d3748)',
          color: 'var(--text-strong, #f7fafc)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-subtle, #2d3748)' }}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5" style={{ color: brush.color }} />
            <h2 className="text-base font-bold">
              {isEditing ? 'Configure Custom Support Brush' : 'Create Custom Support Brush'}
            </h2>
          </div>
          <IconButton onClick={onClose} className="!p-1">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Tab Headers Selector */}
        <div
          className="flex border-b text-xs font-bold"
          style={{ borderColor: 'var(--border-subtle, #2d3748)' }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('selection')}
            className="flex items-center gap-1.5 pb-3 pt-3 px-5 border-b-2 transition-all cursor-pointer font-bold uppercase tracking-wider text-[11px]"
            style={{
              borderColor: activeTab === 'selection' ? brush.color : 'transparent',
              color: activeTab === 'selection' ? 'var(--text-strong, #fff)' : '#9ca3af',
            }}
          >
            <Sliders className="w-3.5 h-3.5" />
            Selection Topology
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('pipeline')}
            className="flex items-center gap-1.5 pb-3 pt-3 px-5 border-b-2 transition-all cursor-pointer font-bold uppercase tracking-wider text-[11px]"
            style={{
              borderColor: activeTab === 'pipeline' ? brush.color : 'transparent',
              color: activeTab === 'pipeline' ? 'var(--text-strong, #fff)' : '#9ca3af',
            }}
          >
            <Grid className="w-3.5 h-3.5" />
            Placement Pipeline
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
          {activeTab === 'selection' ? (
            <div className="flex flex-col gap-5">
              {/* Identity & Color */}
              <div className="flex flex-col gap-2.5">
                <div className="flex gap-4">
                  <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
                      Brush Name
                    </label>
                    <input
                      type="text"
                      value={brush.name}
                      onChange={e => setBrush(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full text-sm px-3 py-2 rounded-lg border outline-none font-medium transition-colors"
                      style={{
                        background: 'var(--surface-2, #1d242e)',
                        borderColor: 'var(--border-subtle, #2d3748)',
                        color: 'var(--text-strong, #f7fafc)',
                      }}
                      placeholder="e.g. Detailed Organic Columns"
                    />
                  </div>

                  <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
                      Base Selection Style
                    </label>
                    <select
                      value={brush.baseBrush || 'MacroFace'}
                      onChange={e => {
                        const val = e.target.value as BrushType;
                        setBrush(prev => ({
                          ...prev,
                          baseBrush: val,
                          selection: {
                            ...prev.selection,
                            ...presets[val],
                          }
                        }));
                      }}
                      className="w-full text-sm px-3 py-2 rounded-lg border outline-none font-medium transition-colors"
                      style={{
                        background: 'var(--surface-2, #1d242e)',
                        borderColor: 'var(--border-subtle, #2d3748)',
                        color: 'var(--text-strong, #f7fafc)',
                      }}
                    >
                      <option value="MacroFace">Macro Overhang (MacroFace)</option>
                      <option value="Ridge">Crease/Ridge Line (Ridge)</option>
                      <option value="Point">Manual Geodesic (Point)</option>
                      <option value="Ring">Horizontal Ring (Ring)</option>
                      <option value="Marker">Rotated Tip Marker (Marker)</option>
                      <option value="PointPath">Point Path & Closed Loop (PointPath)</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
                      Color Picker
                    </label>
                    <div className="flex items-center gap-1.5 h-[38px] px-2 rounded-lg border"
                      style={{
                        background: 'var(--surface-2, #1d242e)',
                        borderColor: 'var(--border-subtle, #2d3748)',
                      }}>
                      {PRESET_COLORS.map(c => (
                        <button
                          key={c}
                          onClick={() => setBrush(prev => ({ ...prev, color: c }))}
                          className="w-4 h-4 rounded-full border border-black/40 hover:scale-110 transition-transform flex items-center justify-center cursor-pointer"
                          style={{
                            background: c,
                            boxShadow: brush.color === c ? '0 0 8px ' + c : 'none',
                            borderWidth: brush.color === c ? '2px' : '1px',
                            borderColor: brush.color === c ? '#fff' : 'rgba(0,0,0,0.3)',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Preset Starting Templates Select Bar */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
                  Preset Starting Templates
                </label>
                <div className="flex gap-2">
                  {(['MacroFace', 'Ridge', 'Point', 'Ring', 'Marker', 'PointPath'] as BrushType[]).map(type => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setBrush(prev => ({
                          ...prev,
                          baseBrush: type,
                          name: `Custom ${type} Brush`,
                          selection: {
                            ...prev.selection,
                            ...presets[type],
                          }
                        }));
                      }}
                      className="text-xs px-3 py-1.5 rounded border transition-colors font-semibold cursor-pointer hover:bg-white/10"
                      style={{
                        background: brush.baseBrush === type ? brush.color : 'transparent',
                        borderColor: brush.baseBrush === type ? brush.color : 'var(--border-subtle, #2d3748)',
                        color: brush.baseBrush === type ? '#fff' : 'var(--text-strong, #f7fafc)',
                      }}
                    >
                      {type} Preset
                    </button>
                  ))}
                </div>
              </div>

              {/* MacroFace base style controls */}
              {(brush.baseBrush === 'MacroFace' || !brush.baseBrush) && (
                <div className="flex flex-col gap-5">
                  <div
                    className="p-4 rounded-xl border flex flex-col gap-6"
                    style={{
                      background: 'var(--surface-2, #0d1117)',
                      borderColor: 'var(--border-subtle, #2d3748)',
                    }}
                  >
                    <div className="grid grid-cols-2 gap-6">
                      <div className="flex flex-col gap-2" style={{ opacity: brush.selection.enableNormalConeLimit !== false ? 1 : 0.4 }}>
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Normal Cone Limit</label>
                          <input
                            type="checkbox"
                            checked={brush.selection.enableNormalConeLimit !== false}
                            onChange={e => updateSelection({ enableNormalConeLimit: e.target.checked })}
                            className="w-4 h-4 cursor-pointer accent-accent"
                          />
                        </div>
                        <SymmetricalClockWidget
                          valueMin={brush.selection.normalConeAngleMinDeg}
                          valueMax={brush.selection.normalConeAngleMaxDeg}
                          onChange={(min, max) =>
                            updateSelection({ normalConeAngleMinDeg: min, normalConeAngleMaxDeg: max })
                          }
                        />
                      </div>

                      <div className="flex flex-col gap-2" style={{ opacity: brush.selection.enableSlopeLimit !== false ? 1 : 0.4 }}>
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Overhang Slope Limit</label>
                          <input
                            type="checkbox"
                            checked={brush.selection.enableSlopeLimit !== false}
                            onChange={e => updateSelection({ enableSlopeLimit: e.target.checked })}
                            className="w-4 h-4 cursor-pointer accent-accent"
                          />
                        </div>
                        <OverhangArcGauge
                          valueMin={brush.selection.overhangSlopeMinDeg}
                          valueMax={brush.selection.overhangSlopeMaxDeg}
                          onChange={(min, max) =>
                            updateSelection({ overhangSlopeMinDeg: min, overhangSlopeMaxDeg: max })
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5 text-xs" style={{ opacity: brush.selection.enableCurvatureLimit ? 1 : 0.4 }}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-gray-300">Curvature Sensitivity</span>
                        <input
                          type="checkbox"
                          checked={!!brush.selection.enableCurvatureLimit}
                          onChange={e => updateSelection({ enableCurvatureLimit: e.target.checked })}
                          className="w-3.5 h-3.5 cursor-pointer accent-accent"
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          disabled={!brush.selection.enableCurvatureLimit}
                          /* ORIGINAL:
                          value={brush.selection.curvatureMax}
                          */
                          value={safeNum(brush.selection.curvatureMax, 1.0)}
                          onChange={e => updateSelection({ curvatureMax: parseFloat(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer disabled:opacity-50"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {brush.selection.curvatureMax.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5 text-xs" style={{ opacity: brush.selection.enableDihedralLimit !== false ? 1 : 0.4 }}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-gray-300">Dihedral Step Tolerance</span>
                        <input
                          type="checkbox"
                          checked={brush.selection.enableDihedralLimit !== false}
                          onChange={e => updateSelection({ enableDihedralLimit: e.target.checked })}
                          className="w-3.5 h-3.5 cursor-pointer accent-accent"
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="5"
                          max="60"
                          step="5"
                          disabled={brush.selection.enableDihedralLimit === false}
                          /* ORIGINAL:
                          value={brush.selection.dihedralAngleToleranceDeg}
                          */
                          value={safeNum(brush.selection.dihedralAngleToleranceDeg, 30)}
                          onChange={e =>
                            updateSelection({ dihedralAngleToleranceDeg: parseInt(e.target.value) })
                          }
                          className="flex-1 accent-accent cursor-pointer disabled:opacity-50"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {brush.selection.dihedralAngleToleranceDeg}°
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Ridge base style controls */}
              {brush.baseBrush === 'Ridge' && (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Crease Hysteresis Seed Threshold</span>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="2"
                          max="40"
                          step="1"
                          /* ORIGINAL:
                          value={brush.selection.creaseSeedAngleDeg ?? 8}
                          */
                          value={safeNum(brush.selection.creaseSeedAngleDeg, 8)}
                          onChange={e => updateSelection({ creaseSeedAngleDeg: parseInt(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {brush.selection.creaseSeedAngleDeg ?? 8}°
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Crease Hysteresis Propagation Threshold</span>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="1"
                          max="30"
                          step="1"
                          /* ORIGINAL:
                          value={brush.selection.creasePropagateAngleDeg ?? 3}
                          */
                          value={safeNum(brush.selection.creasePropagateAngleDeg, 3)}
                          onChange={e => updateSelection({ creasePropagateAngleDeg: parseInt(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {brush.selection.creasePropagateAngleDeg ?? 3}°
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t pt-4" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Ridge Crease Alignment Strength</span>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="0.1"
                          max="0.9"
                          step="0.05"
                          /* ORIGINAL:
                          value={brush.selection.ridgeAlignmentTolerance ?? 0.3}
                          */
                          value={safeNum(brush.selection.ridgeAlignmentTolerance, 0.3)}
                          onChange={e => updateSelection({ ridgeAlignmentTolerance: parseFloat(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {(brush.selection.ridgeAlignmentTolerance ?? 0.3).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Point base style controls */}
              {brush.baseBrush === 'Point' && (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Geodesic Brush Footprint Shape</span>
                      <select
                        value={brush.selection.geodesicPathType ?? 'circle'}
                        onChange={e => updateSelection({ geodesicPathType: e.target.value as any })}
                        className="px-2.5 py-1.5 rounded border text-xs outline-none cursor-pointer"
                        style={{
                          background: 'var(--surface-2, #1d242e)',
                          borderColor: 'var(--border-subtle, #2d3748)',
                          color: 'var(--text-strong, #fff)',
                        }}
                      >
                        <option value="circle">Circular Dijkstra Geodesic</option>
                        <option value="square">Tangent-Clamped Square</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Ring base style controls */}
              {brush.baseBrush === 'Ring' && (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Z-Plane Ring Height Window (± mm)</span>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="0.05"
                          max="2.0"
                          step="0.05"
                          /* ORIGINAL:
                          value={brush.selection.zHeightEnvelopeToleranceMm ?? 0.1}
                          */
                          value={safeNum(brush.selection.zHeightEnvelopeToleranceMm, 0.1)}
                          onChange={e => updateSelection({ zHeightEnvelopeToleranceMm: parseFloat(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {(brush.selection.zHeightEnvelopeToleranceMm ?? 0.1).toFixed(2)} mm
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Marker base style controls */}
              {brush.baseBrush === 'Marker' && (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Marker Stroke Radius (mm)</span>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="0.1"
                          max="50.0"
                          step="0.1"
                          /* ORIGINAL:
                          value={brush.selection.markerRadiusMm ?? 1.5}
                          */
                          value={safeNum(brush.selection.markerRadiusMm, 1.5)}
                          onChange={e => updateSelection({ markerRadiusMm: parseFloat(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {(brush.selection.markerRadiusMm ?? 1.5).toFixed(1)} mm
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Tip Shape Footprint</span>
                      <select
                        value={brush.selection.markerTipShape ?? 'circle'}
                        onChange={e => updateSelection({ markerTipShape: e.target.value as any })}
                        className="px-2.5 py-1.5 rounded border text-xs outline-none cursor-pointer"
                        style={{
                          background: 'var(--surface-2, #1d242e)',
                          borderColor: 'var(--border-subtle, #2d3748)',
                          color: 'var(--text-strong, #fff)',
                        }}
                      >
                        <option value="circle">Circle Tip</option>
                        <option value="line">Line Tip (0.5mm width)</option>
                        <option value="rectangle">Rectangle Tip (2:1 aspect)</option>
                        <option value="square">Square Tip</option>
                        <option value="hexagon">Hexagon Tip</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t pt-4" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Marker Tip Rotation (degrees)</span>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="0"
                          max="360"
                          step="5"
                          disabled={brush.selection.markerTipShape === 'circle'}
                          /* ORIGINAL:
                          value={brush.selection.markerTipRotationDeg ?? 0}
                          */
                          value={safeNum(brush.selection.markerTipRotationDeg, 0)}
                          onChange={e => updateSelection({ markerTipRotationDeg: parseInt(e.target.value) })}
                          className="flex-1 accent-accent cursor-pointer disabled:opacity-50"
                        />
                        <span className="font-bold min-w-[32px] text-right">
                          {brush.selection.markerTipRotationDeg ?? 0}°
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Marker Paint Strategy</span>
                      <select
                        value={brush.selection.markerCollisionMode ?? 'fence'}
                        onChange={e => updateSelection({ markerCollisionMode: e.target.value as any })}
                        className="px-2.5 py-1.5 rounded border text-xs outline-none cursor-pointer"
                        style={{
                          background: 'var(--surface-2, #1d242e)',
                          borderColor: 'var(--border-subtle, #2d3748)',
                          color: 'var(--text-strong, #fff)',
                        }}
                      >
                        <option value="fence">Fence Mode (Blocked by other ROIs)</option>
                        <option value="push">Push / Erode Mode (Subtractive Intersection)</option>
                        <option value="merge">Merge Mode (Unite Touched ROIs)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t pt-4" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                    <div className="flex flex-row items-center justify-between gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Selective Eraser Mode</span>
                      <input
                        type="checkbox"
                        checked={!!brush.selection.markerEraserMode}
                        onChange={e => updateSelection({ markerEraserMode: e.target.checked })}
                        className="w-4 h-4 cursor-pointer accent-accent"
                      />
                    </div>
                  </div>
                </div>
              )}

              {brush.baseBrush === 'PointPath' && (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5 text-xs">
                      <span className="font-semibold text-gray-300">Point Path Mode</span>
                      <select
                        value={brush.selection.pointPathMode ?? 'line'}
                        onChange={e => updateSelection({ pointPathMode: e.target.value as any })}
                        className="px-2.5 py-1.5 rounded border text-xs outline-none cursor-pointer"
                        style={{
                          background: 'var(--surface-2, #1d242e)',
                          borderColor: 'var(--border-subtle, #2d3748)',
                          color: 'var(--text-strong, #fff)',
                        }}
                      >
                        <option value="line">Segment Path (Line)</option>
                        <option value="polygon">Closed Loop (Polygon Flood Fill)</option>
                      </select>
                    </div>

                    {brush.selection.pointPathMode !== 'polygon' && (
                      <div className="flex flex-col gap-1.5 text-xs">
                        <span className="font-semibold text-gray-300">Path Stroke Width (mm)</span>
                        <div className="flex items-center gap-3">
                          <input
                            type="range"
                            min="0.5"
                            max="20.0"
                            step="0.5"
                            /* ORIGINAL:
                            value={brush.selection.pointPathWidthMm ?? 2.0}
                            */
                            value={safeNum(brush.selection.pointPathWidthMm, 2.0)}
                            onChange={e => updateSelection({ pointPathWidthMm: parseFloat(e.target.value) })}
                            className="flex-1 accent-accent cursor-pointer"
                          />
                          <span className="font-bold min-w-[32px] text-right">
                            {(brush.selection.pointPathWidthMm ?? 2.0).toFixed(1)} mm
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <SupportPipelineEditor
              initialPipeline={brush.operations}
              onChange={ops => setBrush(prev => ({ ...prev, operations: ops }))}
              isEmbedded={true}
              colorTheme={brush.color}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2.5 px-5 py-4 border-t"
          style={{ borderColor: 'var(--border-subtle, #2d3748)' }}
        >
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} style={{ background: brush.color, color: '#fff' }}>
            Save Brush Template
          </Button>
        </div>
      </div>
    </div>
  );
}
