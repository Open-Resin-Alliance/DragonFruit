import React, { useState } from 'react';
import {
  ChevronUp,
  ChevronDown,
  Info,
  Grid,
  X,
  Trash,
} from 'lucide-react';
import { IconButton, Button } from '@/components/ui/primitives';
import { type CustomSupportOperation, type CustomSupportOperationType } from '../supportPainterTypes';
import { getPresetList, getPresetById } from '@/supports/Settings/presets';

interface SupportPipelineEditorProps {
  initialPipeline: CustomSupportOperation[];
  comparisonPipeline?: CustomSupportOperation[];
  onChange: (pipeline: CustomSupportOperation[]) => void;
  isEmbedded?: boolean;
  onSave?: () => void;
  onClose?: () => void;
  colorTheme?: string; // Sourced from brush color
}

export function SupportPipelineEditor({
  initialPipeline,
  comparisonPipeline,
  onChange,
  isEmbedded = false,
  onSave,
  onClose,
  colorTheme = '#FF5B6F',
}: SupportPipelineEditorProps) {
  const [expandedOp, setExpandedOp] = useState<string | null>(null);

  const updateOp = (index: number, updates: Partial<CustomSupportOperation>) => {
    const nextOps = initialPipeline.map((op, idx) => {
      if (idx === index) {
        return { ...op, ...updates };
      }
      return op;
    }) as CustomSupportOperation[];
    onChange(nextOps);
  };

  const updateOpSpacing = (index: number, updates: Partial<CustomSupportOperation['spacing']>) => {
    const nextOps = initialPipeline.map((op, idx) => {
      if (idx === index) {
        return {
          ...op,
          spacing: { ...op.spacing, ...updates },
        };
      }
      return op;
    }) as CustomSupportOperation[];
    onChange(nextOps);
  };

  const updateOpSuppression = (index: number, updates: Partial<CustomSupportOperation['suppression']>) => {
    const nextOps = initialPipeline.map((op, idx) => {
      if (idx === index) {
        return {
          ...op,
          suppression: { ...op.suppression, ...updates },
        };
      }
      return op;
    }) as CustomSupportOperation[];
    onChange(nextOps);
  };

  const moveOp = (index: number, dir: 'up' | 'down') => {
    if (dir === 'up' && index === 0) return;
    if (dir === 'down' && index === initialPipeline.length - 1) return;

    const nextOps = [...initialPipeline];
    const targetIdx = dir === 'up' ? index - 1 : index + 1;
    const temp = nextOps[index];
    nextOps[index] = nextOps[targetIdx];
    nextOps[targetIdx] = temp;
    onChange(nextOps);
  };

  const addOp = (type: CustomSupportOperationType) => {
    const defaultSpacing = 4.0;
    const newOp: CustomSupportOperation = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      type,
      enabled: true,
      supportPresetId: 'structure',
      isIntervalDirectlyEdited: false,
      insetDistanceMm: 0.0,
      wrapFraction: 100,
      enableZHeightDensity: false,
      minimaStartInterval: 0,
      minimaEndInterval: 100,
      endSpacingMm: defaultSpacing,
      zFactor: 2.0,
      zFactorCurve: 'linear',
      suppression: {
        enabled: type !== 'perimeter',
        distanceMm: defaultSpacing,
        suppressAgainst: type === 'minima' ? ['minima'] : type === 'infill' ? ['minima', 'perimeter', 'infill'] : ['minima', 'perimeter', 'infill', 'centerline'],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        solverMode: 'standard',
        useInflectionPoints: false,
        infillPattern: 'PoissonDisc',
        seedFromMinima: true,
        attemptLeafCreation: type === 'minima',
      },
    };
    onChange([...initialPipeline, newOp]);
  };

  const deleteOp = (index: number) => {
    const nextOps = initialPipeline.filter((_, idx) => idx !== index);
    onChange(nextOps);
  };

  const applyPresetToOp = (index: number, presetId: string) => {
    const nextOps = initialPipeline.map((op, idx) => {
      if (idx === index) {
        const preset = getPresetById(presetId);
        const shaftDiameter = preset?.settings?.shaft?.diameterMm ?? 1.0;
        const newSpacing = op.isIntervalDirectlyEdited ? op.spacing.baseSpacingMm : shaftDiameter * 4.0;
        
        return {
          ...op,
          supportPresetId: presetId,
          spacing: {
            ...op.spacing,
            baseSpacingMm: newSpacing,
          }
        };
      }
      return op;
    }) as CustomSupportOperation[];
    onChange(nextOps);
  };

  const renderContent = () => {
    return (
      <div className="flex flex-col gap-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
          Operations Precedence Sequencer
        </span>
        
        <div className="flex flex-col gap-2.5">
          {initialPipeline.map((op, index) => {
            const opKey = op.id || `${op.type}-${index}`;
            const isExpanded = expandedOp === opKey;
            const compOp = comparisonPipeline?.find(c => c.type === op.type);
            const label =
              op.type === 'minima'
                ? 'Local Minima Placement'
                : op.type === 'perimeter'
                  ? 'Perimeter Contour Pathing'
                  : op.type === 'centerline'
                    ? '1D Centerline Diameter Spine Path'
                    : 'Poisson Disc Infill Populator';

            return (
              <div
                key={opKey}
                className="flex flex-col rounded-xl border overflow-hidden transition-all"
                style={{
                  background: 'var(--surface-2, #1d242e)',
                  borderColor: isExpanded ? colorTheme : 'var(--border-subtle, #2d3748)',
                }}
              >
                {/* Operation Card Header */}
                <div className="flex items-center justify-between px-4 py-3 select-none">
                  <div className="flex items-center gap-3 min-w-0">
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
                      disabled={index === initialPipeline.length - 1}
                      className="!p-0.5"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </IconButton>
                    
                    <IconButton
                      onClick={() => deleteOp(index)}
                      className="!p-0.5 hover:bg-red-500/10"
                      title="Delete step from stack"
                    >
                      <Trash className="w-3.5 h-3.5" style={{ color: 'var(--danger, #ef4444)' }} />
                    </IconButton>

                    <button
                      type="button"
                      onClick={() => setExpandedOp(isExpanded ? null : opKey)}
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
                        {/* Support Preset Selection Dropdown */}
                        <div className="col-span-2 flex flex-col gap-1 border-b pb-2.5 mb-1.5" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                          <span className="font-semibold text-gray-300">Preset Size Binding</span>
                          <select
                            value={op.supportPresetId || 'structure'}
                            onChange={e => applyPresetToOp(index, e.target.value)}
                            className="px-2.5 py-1.5 rounded border font-medium outline-none cursor-pointer text-xs"
                            style={{
                              background: 'var(--surface-1, #151a22)',
                              borderColor: 'var(--border-subtle, #2d3748)',
                              color: 'var(--text-strong)',
                            }}
                          >
                            {getPresetList().map(p => (
                              <option key={p.id} value={p.id}>
                                {p.name} preset ({p.settings.shaft.diameterMm.toFixed(2)} mm column)
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5 justify-between w-full">
                            <span className="flex items-center gap-1">
                              {op.enableZHeightDensity
                                ? 'Base Spacing (mm) [Managed by Z-Density]'
                                : op.type === 'minima' && op.spacing.attemptLeafCreation
                                  ? 'Leaf Search Interval (mm)'
                                  : 'Base Spacing (mm)'}
                            </span>
                            {compOp && compOp.spacing.baseSpacingMm !== op.spacing.baseSpacingMm && (
                              <span className="text-[9px] text-[#A5A6B5] font-semibold bg-black/35 px-1.5 py-0.5 rounded">
                                Last: {compOp.spacing.baseSpacingMm.toFixed(1)} mm
                              </span>
                            )}
                          </div>
                          <input
                            type="number"
                            step="0.1"
                            min="0.5"
                            disabled={op.enableZHeightDensity}
                            value={isNaN(op.spacing.baseSpacingMm) ? '' : op.spacing.baseSpacingMm}
                            onChange={e => {
                              const val = parseFloat(e.target.value);
                              updateOp(index, {
                                isIntervalDirectlyEdited: true,
                                spacing: {
                                  ...op.spacing,
                                  baseSpacingMm: isNaN(val) ? 0 : val,
                                }
                              });
                            }}
                            className="px-2.5 py-1.5 rounded border font-medium outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{
                              background: 'var(--surface-1, #151a22)',
                              borderColor: 'var(--border-subtle, #2d3748)',
                            }}
                          />
                        </div>

                        {op.type === 'perimeter' && (
                          <>
                            <div className="flex flex-col gap-1">
                              <span>Inset Distance (mm)</span>
                              <input
                                type="number"
                                step="0.1"
                                min="0.0"
                                value={isNaN(op.insetDistanceMm ?? 0.0) ? '' : (op.insetDistanceMm ?? 0.0)}
                                onChange={e => {
                                  const val = parseFloat(e.target.value);
                                  updateOp(index, {
                                    insetDistanceMm: isNaN(val) ? 0.0 : val,
                                  });
                                }}
                                className="px-2.5 py-1.5 rounded border font-medium outline-none"
                                style={{
                                  background: 'var(--surface-1, #151a22)',
                                  borderColor: 'var(--border-subtle, #2d3748)',
                                }}
                              />
                            </div>

                            <div className="flex flex-col gap-1">
                              <span>Wrap Limit (Z) (%)</span>
                              <div className="flex items-center gap-2">
                                <input
                                  type="range"
                                  min="1"
                                  max="100"
                                  step="1"
                                  value={op.wrapFraction ?? 100}
                                  onChange={e => {
                                    const val = parseInt(e.target.value, 10);
                                    updateOp(index, {
                                      wrapFraction: isNaN(val) ? undefined : val,
                                    });
                                  }}
                                  className="flex-1 accent-accent h-1.5 rounded-lg appearance-none cursor-pointer bg-gray-700"
                                />
                                <input
                                  type="number"
                                  step="1"
                                  min="1"
                                  max="100"
                                  value={op.wrapFraction === undefined ? '' : op.wrapFraction}
                                  onChange={e => {
                                    const val = parseInt(e.target.value, 10);
                                    updateOp(index, {
                                      wrapFraction: isNaN(val) ? undefined : val,
                                    });
                                  }}
                                  className="w-16 px-2 py-1 rounded border font-medium outline-none text-right"
                                  style={{
                                    background: 'var(--surface-1, #151a22)',
                                    borderColor: 'var(--border-subtle, #2d3748)',
                                  }}
                                />
                              </div>
                            </div>
                          </>
                        )}
                        
                        {/* Minima-specific fields */}
                        {op.type === 'minima' && (
                          <div className="col-span-2 flex flex-col gap-1.5 mt-1 border-b pb-3" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={op.spacing.attemptLeafCreation || false}
                                onChange={e =>
                                  updateOpSpacing(index, { attemptLeafCreation: e.target.checked })
                                }
                                className="w-4 h-4 rounded accent-accent cursor-pointer"
                                id={`leaf-check-${op.type}`}
                              />
                              <label htmlFor={`leaf-check-${op.type}`} className="cursor-pointer font-medium select-none text-[11px] text-gray-200">
                                Attempt leaf support creation for Z-minima
                              </label>
                            </div>
                            <p className="text-[10px] text-gray-400 leading-normal pl-6">
                              When enabled, Z-minima points that fall within the search interval of an already successfully placed support trunk will branch off as a lightweight leaf contact cone instead of creating a full, separate vertical column.
                            </p>
                          </div>
                        )}

                        {/* Perimeter-specific fields */}
                        {op.type === 'perimeter' && (
                          <>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5 justify-between w-full">
                                <span>Advanced Solver Mode</span>
                                {compOp && compOp.spacing.solverMode !== op.spacing.solverMode && (
                                  <span className="text-[9px] text-[#A5A6B5] font-semibold bg-black/35 px-1.5 py-0.5 rounded capitalize">
                                    Last: {compOp.spacing.solverMode || 'standard'}
                                  </span>
                                )}
                              </div>
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
                                id={`inflect-check-${op.type}`}
                              />
                              <label htmlFor={`inflect-check-${op.type}`} className="cursor-pointer font-medium select-none">
                                Split loop at curve inflection points and solve segments evenly
                              </label>
                            </div>
                          </>
                        )}

                        {/* Infill-specific fields */}
                        {op.type === 'infill' && (
                          <>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5 justify-between w-full">
                                <span>Infill Pattern</span>
                                {compOp && compOp.spacing.infillPattern !== op.spacing.infillPattern && (
                                  <span className="text-[9px] text-[#A5A6B5] font-semibold bg-black/35 px-1.5 py-0.5 rounded capitalize">
                                    Last: {compOp.spacing.infillPattern || 'PoissonDisc'}
                                  </span>
                                )}
                              </div>
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
                                id={`seed-check-${op.type}`}
                              />
                              <label htmlFor={`seed-check-${op.type}`} className="cursor-pointer font-medium select-none">
                                Snap infill pattern coordinates origin to Vertical Z-minima anchor
                              </label>
                            </div>
                          </>
                        )}

                        {/* Centerline-specific fields */}
                        {op.type === 'centerline' && (
                          <div className="col-span-2 flex items-center gap-2 mt-1">
                            <input
                              type="checkbox"
                              checked={op.spacing.seedFromMinima || false}
                              onChange={e =>
                                updateOpSpacing(index, { seedFromMinima: e.target.checked })
                              }
                              className="w-4 h-4 rounded accent-accent cursor-pointer"
                              id={`seed-check-${op.type}`}
                            />
                            <label htmlFor={`seed-check-${op.type}`} className="cursor-pointer font-medium select-none">
                              Snap centerline coordinates origin to vertical Z-minima (work outwards symmetrically)
                            </label>
                          </div>
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
                            <div className="flex items-center gap-1.5 justify-between w-full">
                              <span>Suppression Distance (mm)</span>
                              {compOp && compOp.suppression.distanceMm !== op.suppression.distanceMm && (
                                <span className="text-[9px] text-[#A5A6B5] font-semibold bg-black/35 px-1.5 py-0.5 rounded">
                                  Last: {compOp.suppression.distanceMm.toFixed(1)} mm
                                </span>
                              )}
                            </div>
                            <input
                              type="number"
                              step="0.1"
                              min="0.5"
                              /* ORIGINAL:
                              value={op.suppression.distanceMm}
                              onChange={e =>
                                updateOpSuppression(index, {
                                  distanceMm: parseFloat(e.target.value),
                                })
                              }
                              */
                              value={isNaN(op.suppression.distanceMm) ? '' : op.suppression.distanceMm}
                              onChange={e => {
                                const val = parseFloat(e.target.value);
                                updateOpSuppression(index, {
                                  distanceMm: isNaN(val) ? 0 : val,
                                });
                              }}
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
                              {['minima', 'perimeter', 'infill', 'centerline'].map(t => {
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
                                        ? colorTheme
                                        : 'var(--surface-1, #151a22)',
                                      borderColor: active
                                        ? colorTheme
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

                    {op.type !== 'minima' && (
                      <div className="flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={op.enableZHeightDensity || false}
                              onChange={e =>
                                updateOp(index, {
                                  enableZHeightDensity: e.target.checked,
                                  isIntervalDirectlyEdited: true,
                                })
                              }
                              className="w-4 h-4 rounded accent-accent cursor-pointer"
                              id={`zheight-check-${opKey}`}
                            />
                            <label
                              htmlFor={`zheight-check-${opKey}`}
                              className="cursor-pointer font-semibold select-none text-xs text-gray-200"
                            >
                              Enable Z-Height Tip Spacing
                            </label>
                          </div>
                          
                          {op.enableZHeightDensity && (
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-semibold text-gray-300">Scaling Curve</span>
                              <select
                                value={op.zFactorCurve ?? 'linear'}
                                onChange={e =>
                                  updateOp(index, { zFactorCurve: e.target.value as any, isIntervalDirectlyEdited: true })
                                }
                                className="px-2 py-1 rounded border font-semibold outline-none cursor-pointer text-[11px]"
                                style={{
                                  background: 'var(--surface-1, #151a22)',
                                  borderColor: 'var(--border-subtle, #2d3748)',
                                  color: 'var(--text-strong)',
                                }}
                              >
                                <option value="linear">Linear</option>
                                <option value="sigmoid">Sigmoidal</option>
                                <option value="parabolic">Parabolic</option>
                              </select>
                            </div>
                          )}
                        </div>

                        {op.enableZHeightDensity && (
                          <div className="grid grid-cols-2 gap-3 mt-1.5 animate-fade-in">
                            {/* Row 1: Starting Tip Spacing and End Tip Spacing */}
                            <div className="flex flex-col gap-1">
                              <span className="font-semibold text-gray-300">Starting Tip Spacing (mm)</span>
                              <input
                                type="number"
                                step="0.1"
                                min="0.5"
                                value={isNaN(op.spacing.baseSpacingMm) ? '' : op.spacing.baseSpacingMm}
                                onChange={e => {
                                  const val = parseFloat(e.target.value);
                                  updateOp(index, {
                                    isIntervalDirectlyEdited: true,
                                    spacing: {
                                      ...op.spacing,
                                      baseSpacingMm: isNaN(val) ? 0 : val,
                                    }
                                  });
                                }}
                                className="px-2.5 py-1.5 rounded border font-medium outline-none"
                                style={{
                                  background: 'var(--surface-1, #151a22)',
                                  borderColor: 'var(--border-subtle, #2d3748)',
                                }}
                              />
                            </div>

                            <div className="flex flex-col gap-1">
                              <span className="font-semibold text-gray-300">End Tip Spacing (mm)</span>
                              <input
                                type="number"
                                step="0.1"
                                min="0.5"
                                value={isNaN(op.endSpacingMm ?? 4.0) ? '' : (op.endSpacingMm ?? 4.0)}
                                onChange={e => {
                                  const val = parseFloat(e.target.value);
                                  updateOp(index, {
                                    endSpacingMm: isNaN(val) ? 4.0 : val,
                                    isIntervalDirectlyEdited: true,
                                  });
                                }}
                                className="px-2.5 py-1.5 rounded border font-medium outline-none"
                                style={{
                                  background: 'var(--surface-1, #151a22)',
                                  borderColor: 'var(--border-subtle, #2d3748)',
                                }}
                              />
                            </div>

                            {/* Row 2: Start Offset (Z) (%) and End Offset (Z) (%) */}
                            <div className="flex flex-col gap-1">
                              <span className="font-semibold text-gray-300">Start Offset (Z) (%)</span>
                              <div className="flex items-center gap-2">
                                <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={op.minimaStartInterval ?? 0}
                                  onChange={e => {
                                    const val = parseInt(e.target.value, 10);
                                    updateOp(index, {
                                      minimaStartInterval: isNaN(val) ? undefined : val,
                                      isIntervalDirectlyEdited: true,
                                    });
                                  }}
                                  className="flex-1 accent-accent h-1.5 rounded-lg appearance-none cursor-pointer bg-gray-700"
                                />
                                <input
                                  type="number"
                                  step="1"
                                  min="0"
                                  max="100"
                                  value={op.minimaStartInterval === undefined ? '' : op.minimaStartInterval}
                                  onChange={e => {
                                    const val = parseInt(e.target.value, 10);
                                    updateOp(index, {
                                      minimaStartInterval: isNaN(val) ? undefined : val,
                                      isIntervalDirectlyEdited: true,
                                    });
                                  }}
                                  className="w-16 px-2 py-1 rounded border font-medium outline-none text-right"
                                  style={{
                                    background: 'var(--surface-1, #151a22)',
                                    borderColor: 'var(--border-subtle, #2d3748)',
                                  }}
                                />
                              </div>
                            </div>

                            <div className="flex flex-col gap-1">
                              <span className="font-semibold text-gray-300">End Offset (Z) (%)</span>
                              <div className="flex items-center gap-2">
                                <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={typeof op.minimaEndInterval === 'number' ? op.minimaEndInterval : 100}
                                  onChange={e => {
                                    const val = parseInt(e.target.value, 10);
                                    updateOp(index, {
                                      minimaEndInterval: isNaN(val) ? undefined : val,
                                      isIntervalDirectlyEdited: true,
                                    });
                                  }}
                                  className="flex-1 accent-accent h-1.5 rounded-lg appearance-none cursor-pointer bg-gray-700"
                                />
                                <input
                                  type="number"
                                  step="1"
                                  min="0"
                                  max="100"
                                  value={op.minimaEndInterval === undefined ? '' : op.minimaEndInterval}
                                  onChange={e => {
                                    const val = parseInt(e.target.value, 10);
                                    updateOp(index, {
                                      minimaEndInterval: isNaN(val) ? undefined : val,
                                      isIntervalDirectlyEdited: true,
                                    });
                                  }}
                                  className="w-16 px-2 py-1 rounded border font-medium outline-none text-right"
                                  style={{
                                    background: 'var(--surface-1, #151a22)',
                                    borderColor: 'var(--border-subtle, #2d3748)',
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Operation Stack Appender Controls */}
        <div className="flex flex-col gap-2 border-t pt-4 mt-3" style={{ borderColor: 'var(--border-subtle, #2d3748)' }}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
            Append New Operation to Stack
          </span>
          <div className="flex flex-wrap gap-2">
            {(['minima', 'perimeter', 'infill', 'centerline'] as CustomSupportOperationType[]).map(type => {
              const label = type === 'minima' ? '+ Add Minima' : type === 'perimeter' ? '+ Add Perimeter' : type === 'infill' ? '+ Add Infill' : '+ Add Centerline';
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => addOp(type)}
                  className="text-xs font-semibold px-3 py-1.5 rounded border transition-colors hover:bg-black/20"
                  style={{
                    borderColor: colorTheme,
                    color: colorTheme,
                    background: 'transparent',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  if (isEmbedded) {
    return renderContent();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md bg-black/45 animate-fade-in"
      style={{ fontFamily: 'Inter, sans-serif' }}
    >
      <div
        className="w-full max-w-xl rounded-xl border flex flex-col max-h-[85vh] overflow-hidden shadow-2xl"
        style={{
          background: 'var(--surface-1, #151a22)',
          borderColor: 'var(--border-subtle, #2d3748)',
          color: 'var(--text-strong, #f7fafc)',
        }}
      >
        {/* Standalone Modal Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-subtle, #2d3748)' }}
        >
          <div className="flex items-center gap-2">
            <Grid className="w-5 h-5" style={{ color: colorTheme }} />
            <h2 className="text-base font-bold">Configure Support Generation Sequence</h2>
          </div>
          {onClose && (
            <IconButton onClick={onClose} className="!p-1">
              <X className="w-4 h-4" />
            </IconButton>
          )}
        </div>

        {/* Modal Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
          {renderContent()}
        </div>

        {/* Standalone Modal Footer */}
        <div
          className="flex items-center justify-end gap-2.5 px-5 py-4 border-t"
          style={{ borderColor: 'var(--border-subtle, #2d3748)' }}
        >
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          )}
          {onSave && (
            <Button onClick={onSave} style={{ background: colorTheme, color: '#fff' }}>
              Apply Changes
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
