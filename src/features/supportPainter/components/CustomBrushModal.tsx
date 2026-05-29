import React, { useState } from 'react';
import {
  X,
  ChevronUp,
  ChevronDown,
  Info,
  Settings,
  Grid,
} from 'lucide-react';
import { Card, IconButton, Button } from '@/components/ui/primitives';
import { SymmetricalClockWidget } from './SymmetricalClockWidget';
import { OverhangArcGauge } from './OverhangArcGauge';
import { type CustomBrushTemplate, type CustomSupportOperation } from '../supportPainterTypes';

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

const DEFAULT_TEMPLATE: CustomBrushTemplate = {
  id: '',
  name: 'New Custom Brush',
  color: '#FF5B6F',
  selection: {
    normalConeAngleMinDeg: 15,
    normalConeAngleMaxDeg: 45,
    overhangSlopeMinDeg: 0,
    overhangSlopeMaxDeg: 60,
    curvatureMin: 0.0,
    curvatureMax: 1.0,
    dihedralAngleToleranceDeg: 30,
  },
  operations: [...DEFAULT_OPERATIONS],
};

export function CustomBrushModal({
  initialBrush,
  onClose,
  onSave,
}: CustomBrushModalProps) {
  const isEditing = !!initialBrush;
  const [brush, setBrush] = useState<CustomBrushTemplate>(() => {
    if (initialBrush) {
      // Symmetrize map operations
      return {
        ...initialBrush,
        selection: { ...initialBrush.selection },
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

  const [expandedOp, setExpandedOp] = useState<string | null>(null);

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

  const updateOp = (index: number, updates: Partial<CustomSupportOperation>) => {
    setBrush(prev => {
      const nextOps = [...prev.operations];
      nextOps[index] = {
        ...nextOps[index],
        ...updates,
      } as CustomSupportOperation;
      return { ...prev, operations: nextOps };
    });
  };

  const updateOpSpacing = (index: number, updates: Partial<CustomSupportOperation['spacing']>) => {
    setBrush(prev => {
      const nextOps = [...prev.operations];
      nextOps[index] = {
        ...nextOps[index],
        spacing: { ...nextOps[index].spacing, ...updates },
      } as CustomSupportOperation;
      return { ...prev, operations: nextOps };
    });
  };

  const updateOpSuppression = (index: number, updates: Partial<CustomSupportOperation['suppression']>) => {
    setBrush(prev => {
      const nextOps = [...prev.operations];
      nextOps[index] = {
        ...nextOps[index],
        suppression: { ...nextOps[index].suppression, ...updates },
      } as CustomSupportOperation;
      return { ...prev, operations: nextOps };
    });
  };

  // Move operations up/down
  const moveOp = (index: number, dir: 'up' | 'down') => {
    if (dir === 'up' && index === 0) return;
    if (dir === 'down' && index === brush.operations.length - 1) return;

    setBrush(prev => {
      const nextOps = [...prev.operations];
      const targetIdx = dir === 'up' ? index - 1 : index + 1;
      const temp = nextOps[index];
      nextOps[index] = nextOps[targetIdx];
      nextOps[targetIdx] = temp;
      return { ...prev, operations: nextOps };
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md bg-black/45 animate-fade-in"
      style={{ fontFamily: 'Inter, sans-serif' }}
    >
      <div
        className="w-full max-w-2xl rounded-xl border flex flex-col max-h-[88vh] overflow-hidden shadow-2xl"
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

        {/* Scrollable Container */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5 scrollbar-thin">
          
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
                      className="w-4 h-4 rounded-full border border-black/40 hover:scale-110 transition-transform flex items-center justify-center"
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

          {/* Dials & Topology Selectors */}
          <div
            className="p-4 rounded-xl border grid grid-cols-2 gap-6"
            style={{
              background: 'var(--surface-2, #0d1117)',
              borderColor: 'var(--border-subtle, #2d3748)',
            }}
          >
            <SymmetricalClockWidget
              valueMin={brush.selection.normalConeAngleMinDeg}
              valueMax={brush.selection.normalConeAngleMaxDeg}
              onChange={(min, max) =>
                updateSelection({ normalConeAngleMinDeg: min, normalConeAngleMaxDeg: max })
              }
            />

            <OverhangArcGauge
              valueMin={brush.selection.overhangSlopeMinDeg}
              valueMax={brush.selection.overhangSlopeMaxDeg}
              onChange={(min, max) =>
                updateSelection({ overhangSlopeMinDeg: min, overhangSlopeMaxDeg: max })
              }
            />
          </div>

          {/* Slider Controls for Curvature / Dihedral */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5 text-xs">
              <span className="font-semibold">Curvature Sensitivity</span>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={brush.selection.curvatureMax}
                  onChange={e => updateSelection({ curvatureMax: parseFloat(e.target.value) })}
                  className="flex-1 accent-accent"
                />
                <span className="font-bold min-w-[32px] text-right">
                  {brush.selection.curvatureMax.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 text-xs">
              <span className="font-semibold">Dihedral Step Tolerance</span>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="5"
                  value={brush.selection.dihedralAngleToleranceDeg}
                  onChange={e =>
                    updateSelection({ dihedralAngleToleranceDeg: parseInt(e.target.value) })
                  }
                  className="flex-1 accent-accent"
                />
                <span className="font-bold min-w-[32px] text-right">
                  {brush.selection.dihedralAngleToleranceDeg}°
                </span>
              </div>
            </div>
          </div>

          {/* Pipeline Sequencer Stack */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
              Operations Precedence Sequencer
            </span>
            
            <div className="flex flex-col gap-2">
              {brush.operations.map((op, index) => {
                const isExpanded = expandedOp === op.type;
                const label =
                  op.type === 'minima'
                    ? 'Local Minima Placement'
                    : op.type === 'perimeter'
                      ? 'Perimeter Contour Pathing'
                      : ' poisson disc / infill populator';

                return (
                  <div
                    key={op.type}
                    className="flex flex-col rounded-xl border overflow-hidden transition-all"
                    style={{
                      background: op.enabled
                        ? 'var(--surface-2, #1d242e)'
                        : 'rgba(29, 36, 46, 0.45)',
                      borderColor: isExpanded ? brush.color : 'var(--border-subtle, #2d3748)',
                      opacity: op.enabled ? 1 : 0.65,
                    }}
                  >
                    {/* Operation Card Header */}
                    <div className="flex items-center justify-between px-4 py-3 select-none">
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          checked={op.enabled}
                          onChange={e => updateOp(index, { enabled: e.target.checked })}
                          className="w-4 h-4 rounded text-accent focus:ring-0 accent-accent cursor-pointer"
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="font-semibold text-xs capitalize truncate">
                            {op.type} stage
                          </span>
                          <span className="text-[9px] text-gray-400 truncate">{label}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Sort buttons */}
                        <IconButton
                          onClick={() => moveOp(index, 'up')}
                          disabled={index === 0}
                          className="!p-0.5"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton
                          onClick={() => moveOp(index, 'down')}
                          disabled={index === brush.operations.length - 1}
                          className="!p-0.5"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </IconButton>

                        <button
                          type="button"
                          onClick={() => setExpandedOp(isExpanded ? null : op.type)}
                          className="text-[10px] ml-1 px-2 py-1 rounded border font-semibold flex items-center gap-1 hover:bg-black/20"
                          style={{
                            borderColor: 'var(--border-subtle, #2d3748)',
                            color: 'var(--text-strong)',
                          }}
                        >
                          <Info className="w-3 h-3" />
                          Config
                        </button>
                      </div>
                    </div>

                    {/* Collapsible Config Area */}
                    {isExpanded && (
                      <div
                        className="px-4 pb-4 pt-3 flex flex-col gap-4 border-t text-xs leading-normal"
                        style={{
                          borderColor: 'var(--border-subtle, #2d3748)',
                          background: 'rgba(0,0,0,0.15)',
                        }}
                      >
                        {/* Spacing Parameters */}
                        <div className="flex flex-col gap-2.5">
                          <h4 className="font-bold text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
                            <Grid className="w-3.5 h-3.5" />
                            Spacing settings
                          </h4>
                          
                          <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                              <span>Base Spacing (mm)</span>
                              <input
                                type="number"
                                step="0.1"
                                min="0.5"
                                value={op.spacing.baseSpacingMm}
                                onChange={e =>
                                  updateOpSpacing(index, {
                                    baseSpacingMm: parseFloat(e.target.value),
                                  })
                                }
                                className="px-2.5 py-1.5 rounded border font-medium outline-none"
                                style={{
                                  background: 'var(--surface-1, #151a22)',
                                  borderColor: 'var(--border-subtle, #2d3748)',
                                }}
                              />
                            </div>

                            {/* Perimeter-specific fields */}
                            {op.type === 'perimeter' && (
                              <>
                                <div className="flex flex-col gap-1">
                                  <span>Advanced Solver Mode</span>
                                  <select
                                    value={op.spacing.solverMode || 'standard'}
                                    onChange={e =>
                                      updateOpSpacing(index, {
                                        solverMode: e.target.value as any,
                                      })
                                    }
                                    className="px-2.5 py-1.5 rounded border font-medium outline-none cursor-pointer"
                                    style={{
                                      background: 'var(--surface-1, #151a22)',
                                      borderColor: 'var(--border-subtle, #2d3748)',
                                    }}
                                  >
                                    <option value="standard">Standard Walk</option>
                                    <option value="closest">Even (Closest Spacing)</option>
                                    <option value="add">Even (Add / Density)</option>
                                    <option value="remove">Even (Remove / Sparser)</option>
                                  </select>
                                </div>

                                <div className="col-span-2 flex flex-col gap-1">
                                  <span>Variable Spacing Sequence (comma-separated, e.g. 1.0, 2.0)</span>
                                  <input
                                    type="text"
                                    value={op.spacing.sequence?.join(', ') || ''}
                                    onChange={e => {
                                      const arr = e.target.value
                                        .split(',')
                                        .map(s => parseFloat(s.trim()))
                                        .filter(n => !isNaN(n));
                                      updateOpSpacing(index, {
                                        sequence: arr.length > 0 ? arr : undefined,
                                      });
                                    }}
                                    className="px-2.5 py-1.5 rounded border font-medium outline-none"
                                    style={{
                                      background: 'var(--surface-1, #151a22)',
                                      borderColor: 'var(--border-subtle, #2d3748)',
                                    }}
                                    placeholder="Empty defaults to Base Spacing throughout loop"
                                  />
                                </div>

                                <div className="col-span-2 flex items-center gap-2 mt-1">
                                  <input
                                    type="checkbox"
                                    checked={op.spacing.useInflectionPoints || false}
                                    onChange={e =>
                                      updateOpSpacing(index, {
                                        useInflectionPoints: e.target.checked,
                                      })
                                    }
                                    className="w-4 h-4 rounded accent-accent cursor-pointer"
                                    id="inflect-check"
                                  />
                                  <label htmlFor="inflect-check" className="cursor-pointer font-medium select-none">
                                    Split loop at curve inflection points and solve segments evenly
                                  </label>
                                </div>
                              </>
                            )}

                            {/* Infill-specific fields */}
                            {op.type === 'infill' && (
                              <>
                                <div className="flex flex-col gap-1">
                                  <span>Infill Pattern</span>
                                  <select
                                    value={op.spacing.infillPattern || 'PoissonDisc'}
                                    onChange={e =>
                                      updateOpSpacing(index, {
                                        infillPattern: e.target.value as any,
                                      })
                                    }
                                    className="px-2.5 py-1.5 rounded border font-medium outline-none cursor-pointer"
                                    style={{
                                      background: 'var(--surface-1, #151a22)',
                                      borderColor: 'var(--border-subtle, #2d3748)',
                                    }}
                                  >
                                    <option value="PoissonDisc">Poisson Disc (Organic)</option>
                                    <option value="Grid">Orthogonal Grid</option>
                                    <option value="Honeycomb">Honeycomb (Hexagonal)</option>
                                    <option value="Concentric">Concentric Offset Rings</option>
                                  </select>
                                </div>

                                <div className="col-span-2 flex items-center gap-2 mt-1">
                                  <input
                                    type="checkbox"
                                    checked={op.spacing.seedFromMinima || false}
                                    onChange={e =>
                                      updateOpSpacing(index, { seedFromMinima: e.target.checked })
                                    }
                                    className="w-4 h-4 rounded accent-accent cursor-pointer"
                                    id="seed-check"
                                  />
                                  <label htmlFor="seed-check" className="cursor-pointer font-medium select-none">
                                    Snap infill pattern coordinates origin to Vertical Z-minima anchor
                                  </label>
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Proximity Suppression Rules */}
                        <div className="flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                          <h4 className="font-bold text-[10px] uppercase tracking-wider text-gray-400">
                            Proximity Suppression settings
                          </h4>

                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={op.suppression.enabled}
                              onChange={e =>
                                updateOpSuppression(index, { enabled: e.target.checked })
                              }
                              className="w-4 h-4 rounded accent-accent cursor-pointer"
                              id={`suppress-check-${op.type}`}
                            />
                            <label
                              htmlFor={`suppress-check-${op.type}`}
                              className="cursor-pointer font-medium select-none"
                            >
                              Enable candidate proximity checking
                            </label>
                          </div>

                          {op.suppression.enabled && (
                            <div className="grid grid-cols-2 gap-3 mt-1 animate-fade-in">
                              <div className="flex flex-col gap-1">
                                <span>Suppression Distance (mm)</span>
                                <input
                                  type="number"
                                  step="0.1"
                                  min="0.5"
                                  value={op.suppression.distanceMm}
                                  onChange={e =>
                                    updateOpSuppression(index, {
                                      distanceMm: parseFloat(e.target.value),
                                    })
                                  }
                                  className="px-2.5 py-1.5 rounded border font-medium outline-none"
                                  style={{
                                    background: 'var(--surface-1, #151a22)',
                                    borderColor: 'var(--border-subtle, #2d3748)',
                                  }}
                                />
                              </div>

                              <div className="flex flex-col gap-1.5">
                                <span>Suppress Against Stages:</span>
                                <div className="flex flex-wrap gap-2">
                                  {['minima', 'perimeter', 'infill'].map(t => {
                                    const active = op.suppression.suppressAgainst.includes(t as any);
                                    return (
                                      <button
                                        key={t}
                                        type="button"
                                        onClick={() => {
                                          const current = op.suppression.suppressAgainst;
                                          const next = current.includes(t as any)
                                            ? current.filter(x => x !== t)
                                            : [...current, t as any];
                                          updateOpSuppression(index, { suppressAgainst: next });
                                        }}
                                        className="text-[10px] font-semibold px-2 py-1 rounded border capitalize transition-colors"
                                        style={{
                                          background: active
                                            ? brush.color
                                            : 'var(--surface-1, #151a22)',
                                          borderColor: active
                                            ? brush.color
                                            : 'var(--border-subtle, #2d3748)',
                                          color: 'var(--text-strong)',
                                        }}
                                      >
                                        {t}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
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
