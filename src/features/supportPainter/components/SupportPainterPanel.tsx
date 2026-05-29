import React, { useState, useEffect, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import {
  Focus,
  Spline,
  CircleDot,
  Cylinder,
  GitCommit,
  Circle,
  WandSparkles,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Trash2,
  Trash,
  RefreshCw,
  Eraser,
  Plus,
  Sliders,
} from 'lucide-react';
import { Card, CardHeader, IconButton, Button, Toast, ToastViewport } from '@/components/ui/primitives';
import { supportPainterStore, useSupportPainterState } from '../supportPainterStore';
import { type BrushType, type CustomBrushTemplate, BRUSH_COLORS } from '../supportPainterTypes';
import { generateSupportsFromPainter, regenerateSupportsForRoi } from '../supportScriptingEngine';
import { subscribeToSettings, getSettings } from '@/supports/Settings';
import {
  subscribe as subscribeToSupports,
  getSnapshot as getSupportsSnapshot,
  setSnapshot as setSupportSnapshot,
} from '@/supports/state';
import { deleteSupportsForRoi } from '@/supports/PlacementLogic/SupportModelLinker';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { PAINT_ROI_STRIP } from '../supportPainterHistoryTypes';
import { pushHistory } from '@/history/historyStore';
import { CustomBrushModal } from './CustomBrushModal';

const BRUSH_DETAILS: Record<
  BrushType,
  { label: string; desc: string; icon: React.ComponentType<any> }
> = {
  MacroFace: {
    label: 'MacroFace',
    desc: 'Paint coplanar surfaces',
    icon: Focus,
  },
  Ridge: {
    label: 'Ridge Crease',
    desc: 'Trace 1D convex crease',
    icon: Spline,
  },
  Point: {
    label: 'Point Geodesic',
    desc: 'Geodesic circular brush',
    icon: CircleDot,
  },
  CylinderSides: {
    label: 'Cyl. Sides',
    desc: 'Paint cylinder side bands',
    icon: Cylinder,
  },
  CylinderMinima: {
    label: 'Cyl. Minima',
    desc: 'Trace bottom cylinder spine',
    icon: GitCommit,
  },
  Ring: {
    label: 'Z-Plane Ring',
    desc: 'Horizontal Z-plane slice',
    icon: Circle,
  },
};

export function SupportPainterPanel({
  activeModelId,
  getActiveMesh,
  onModeChange,
}: {
  activeModelId?: string | null;
  getActiveMesh?: () => THREE.Mesh | null;
  onModeChange?: (mode: 'support' | 'supportPainter') => void;
}) {
  const state = useSupportPainterState();
  const activeSettings = useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
  const supportState = useSyncExternalStore(subscribeToSupports, getSupportsSnapshot, getSupportsSnapshot);
  const [expandedRegions, setExpandedRegions] = useState<Record<string, boolean>>({});
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const trunkWidth = activeSettings.shaft.diameterMm;
  const defaultSpacing = trunkWidth * 4.0;

  const [isGenerating, setIsGenerating] = useState(false);
  const [showCustomBrushModal, setShowCustomBrushModal] = useState(false);
  const [editingCustomBrush, setEditingCustomBrush] = useState<CustomBrushTemplate | null>(null);
  const [expanded, setExpanded] = useState(false);  // collapsed = support mode, expanded = painter mode

  // Partition regions into Pending vs Completed/Saved History
  const regionsArray = Array.from(state.regions.values());
  const pendingRegions = regionsArray.filter(
    (r) => r.support === undefined && r.loops === undefined
  );
  const completedRegions = regionsArray.filter(
    (r) => r.support !== undefined || r.loops !== undefined
  );

  const purgeEmptySessionRois = () => {
    const currentSnapshot = getSupportsSnapshot();
    const currentRegions = Array.from(supportPainterStore.getSnapshot().regions.values());
    const nextRegionsMap = new Map(supportPainterStore.getSnapshot().regions);

    let changed = false;
    for (const region of currentRegions) {
      const hasCompleted = region.support !== undefined || region.loops !== undefined;
      if (hasCompleted && !region.loadedFromVoxl) {
        const regionTrunks = Object.values(currentSnapshot.trunks).filter(t => t.roiId === region.id);
        const regionBranches = Object.values(currentSnapshot.branches).filter(b => b.roiId === region.id);
        const regionLeaves = Object.values(currentSnapshot.leaves).filter(l => l.roiId === region.id);
        const regionTwigs = Object.values(currentSnapshot.twigs).filter(t => t.roiId === region.id);
        const regionSticks = Object.values(currentSnapshot.sticks).filter(s => s.roiId === region.id);
        const regionAnchors = Object.values(currentSnapshot.anchors).filter(a => a.roiId === region.id);
        const totalChildSupports = regionTrunks.length + regionBranches.length + regionLeaves.length + regionTwigs.length + regionSticks.length + regionAnchors.length;

        if (totalChildSupports === 0) {
          nextRegionsMap.delete(region.id);
          changed = true;
        }
      }
    }

    if (changed) {
      supportPainterStore.restoreRegions(nextRegionsMap);
    }
  };

  // Deactivate painter if panel unmounts while still expanded
  useEffect(() => {
    return () => {
      purgeEmptySessionRois();
      supportPainterStore.deactivate();
    };
  }, []);

  // Synchronize active model ID to support painter store
  useEffect(() => {
    supportPainterStore.setActiveModelId(activeModelId || null);
  }, [activeModelId]);

  // Chevron is the mode-switch control
  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      supportPainterStore.activate();
      onModeChange?.('supportPainter');
    } else {
      purgeEmptySessionRois();
      supportPainterStore.deactivate();
      onModeChange?.('support');
    }
  };

  const handleGenerate = async () => {
    if (!activeModelId || !getActiveMesh || pendingRegions.length === 0) return;
    const mesh = getActiveMesh();
    if (!mesh) return;

    setIsGenerating(true);
    try {
      await generateSupportsFromPainter(activeModelId, mesh, pendingRegions);
      // Preserve ROIs in store for non-destructive recalculation/dashboard
    } catch (err) {
      console.error('[SupportPainterPanel] Generation failed', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRemoveSupportsForRoi = (regionId: string) => {
    const beforeState = getSupportsSnapshot();
    const nextState = deleteSupportsForRoi(beforeState, regionId);
    const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);
    setSupportSnapshot(nextState);

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: 'Remove supports for region',
      payload: {
        before: beforeState,
        after: nextState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: beforeRegions,
      },
    });
  };

  const handleDeleteRegion = (regionId: string) => {
    const beforeState = getSupportsSnapshot();
    const nextState = deleteSupportsForRoi(beforeState, regionId);
    const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);
    const nextRegions = new Map(beforeRegions);
    nextRegions.delete(regionId);

    setSupportSnapshot(nextState);
    supportPainterStore.restoreRegions(nextRegions);

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: 'Delete ROI region and supports',
      payload: {
        before: beforeState,
        after: nextState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: nextRegions,
      },
    });
  };

  const handleRemoveRoiOnly = (regionId: string) => {
    const beforeState = getSupportsSnapshot();
    const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);
    const nextRegions = new Map(beforeRegions);
    nextRegions.delete(regionId);

    supportPainterStore.restoreRegions(nextRegions);

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: 'Remove ROI Only',
      payload: {
        before: beforeState,
        after: beforeState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: nextRegions,
      },
    });
  };

  const activeDetails = BRUSH_DETAILS[state.activeBrush] || BRUSH_DETAILS.MacroFace;

  return (
    <Card>
      <CardHeader
        left={
          <>
            <IconButton
              onClick={handleToggle}
              className="!p-0.5"
              title={expanded ? 'Close Support Painter' : 'Open Support Painter'}
            >
              {expanded
                ? <ChevronDown className="w-3 h-3" />
                : <ChevronRight className="w-3 h-3" />}
            </IconButton>
            <WandSparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Support Painter
            </h3>
          </>
        }
      />

      {expanded && (
      <div className="px-3 pb-3 pt-1 flex flex-col gap-3">

          {/* Direct Click-to-Generate Toggle */}
          <div
            className="flex items-center justify-between p-2.5 rounded-lg border text-xs"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex flex-col gap-0.5 min-w-0 pr-2">
              <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                Direct Click-to-Generate
              </span>
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                Generate supports instantly on click
              </span>
            </div>
            <button
              type="button"
              onClick={() => supportPainterStore.setDirectGenEnabled(!state.directGenEnabled)}
              className="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
              style={{
                backgroundColor: state.directGenEnabled ? 'var(--accent)' : 'var(--surface-1)',
              }}
            >
              <span
                className="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
                style={{
                  transform: state.directGenEnabled ? 'translateX(16px)' : 'translateX(0)',
                }}
              />
            </button>
          </div>

          {/* ROI Storage Mode Dropdown */}
          <div
            className="flex flex-col gap-2 p-2.5 rounded-lg border text-xs"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                ROI Storage Mode
              </span>
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                Controls how ROI data is saved/loaded
              </span>
            </div>
            <select
              value={state.roiTrackingMode}
              onChange={(e) => supportPainterStore.setRoiTrackingMode(e.target.value as any)}
              className="w-full text-[11px] px-2 py-1.5 rounded border outline-none font-medium transition-colors cursor-pointer"
              style={{
                background: 'var(--surface-1)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-strong)',
              }}
            >
              <option value="voxl">Persistent VOXL (Recommended)</option>
              <option value="session">Session-Only</option>
              <option value="none">None (Purge on change)</option>
            </select>
          </div>

          {/* Brush Selection */}
          <div className="flex flex-col gap-2">
            <span
              className="text-[10px] uppercase tracking-wider font-bold"
              style={{ color: 'var(--text-muted)' }}
            >
              Select Smart Brush
            </span>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(BRUSH_DETAILS) as BrushType[]).map((brush) => {
                const isSelected = state.activeBrush === brush && state.activeCustomBrushId === null;
                const details = BRUSH_DETAILS[brush];
                const brushColor = BRUSH_COLORS[brush];
                const Icon = details.icon;
                return (
                  <IconButton
                    key={brush}
                    active={isSelected}
                    onClick={() => {
                      supportPainterStore.setActiveBrush(brush);
                      supportPainterStore.setActiveCustomBrushId(null);
                    }}
                    className="w-full !justify-start gap-2 !p-2"
                    title={details.desc}
                  >
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: brushColor }}
                    />
                    <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="text-[11px] font-medium truncate">{details.label}</span>
                  </IconButton>
                );
              })}
            </div>
          </div>

          {/* Custom Brushes Selection Section */}
          <div className="flex flex-col gap-2 border-t pt-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <span
              className="text-[10px] uppercase tracking-wider font-bold"
              style={{ color: 'var(--text-muted)' }}
            >
              Select Custom Brush
            </span>
            <div className="flex flex-col gap-1.5">
              {Array.from(state.customBrushes.values()).map((c) => {
                const isSelected = state.activeCustomBrushId === c.id;
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-1.5 w-full rounded-lg border p-1 text-xs transition-colors"
                    style={{
                      background: isSelected ? 'var(--surface-0, #111827)' : 'var(--surface-2, #1f2937)',
                      borderColor: isSelected ? 'var(--accent, #4a90e2)' : 'var(--border-subtle, #374151)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        supportPainterStore.setActiveCustomBrushId(c.id);
                        supportPainterStore.setActiveBrush('MacroFace'); // Custom selections backed by MacroFace mesh walks
                      }}
                      className="flex-1 flex items-center gap-2 p-1.5 text-left font-medium text-[11px] min-w-0"
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: c.color }}
                      />
                      <span className="truncate flex-1" style={{ color: 'var(--text-strong, #f3f4f6)' }}>
                        {c.name}
                      </span>
                    </button>

                    <div className="flex items-center gap-1 flex-shrink-0 pr-1">
                      <IconButton
                        onClick={() => {
                          setEditingCustomBrush(c);
                          setShowCustomBrushModal(true);
                        }}
                        className="!p-1 hover:bg-black/20"
                        title="Edit Custom Brush"
                      >
                        <Sliders className="w-3.5 h-3.5" />
                      </IconButton>
                      <IconButton
                        onClick={() => {
                          supportPainterStore.deleteCustomBrush(c.id);
                        }}
                        className="!p-1 hover:bg-black/20"
                        title="Delete Custom Brush"
                      >
                        <Trash className="w-3.5 h-3.5" style={{ color: 'var(--danger, #ef4444)' }} />
                      </IconButton>
                    </div>
                  </div>
                );
              })}

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditingCustomBrush(null);
                  setShowCustomBrushModal(true);
                }}
                className="w-full !text-[10px] py-1.5 flex items-center justify-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" style={{ color: 'var(--accent, #4a90e2)' }} />
                Create Custom Brush
              </Button>
            </div>
          </div>

          {/* Interaction Context Hint */}
          <div
            className="rounded-lg p-2.5 text-[11px] leading-relaxed border"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-muted)',
            }}
          >
            {state.modifierKeys.alt ? (
              <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--warning, #f59e0b)' }}>
                <span className="font-bold">Subtract Mode active:</span>
                &nbsp;Click a painted triangle to delete its region.
              </div>
            ) : state.directGenEnabled ? (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium" style={{ color: 'var(--accent)' }}>
                  {activeDetails.label}: Instant Placement
                </span>
                <span>Click model to instantly generate &amp; place supports in the highlighted region.</span>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium" style={{ color: 'var(--text-strong)' }}>
                  {activeDetails.label}: {activeDetails.desc}
                </span>
                <span>
                  Click to paint. Hold{' '}
                  <kbd
                    className="px-1 rounded text-[10px] border"
                    style={{ background: 'var(--surface-0)', borderColor: 'var(--border-subtle)' }}
                  >
                    Alt
                  </kbd>
                  {' '}+ click to subtract.
                </span>
              </div>
            )}
          </div>

          {/* Painted Regions List (Pending Only) */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span
                className="text-[10px] uppercase tracking-wider font-bold"
                style={{ color: 'var(--text-muted)' }}
              >
                Painted Regions ({pendingRegions.length})
              </span>
              {pendingRegions.length > 0 && (
                <button
                  type="button"
                  onClick={() => supportPainterStore.clearAll()}
                  className="text-[10px] font-medium hover:underline transition-colors"
                  style={{ color: 'var(--danger, #ef4444)' }}
                >
                  Clear All
                </button>
              )}
            </div>

            <div className="max-h-[140px] overflow-y-auto pr-1 flex flex-col gap-1.5 scrollbar-thin">
              {pendingRegions.length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center py-3 text-center text-[11px] italic"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {state.directGenEnabled
                    ? 'Direct Generation Mode: Click mesh to instantly place supports'
                    : 'No pending regions painted yet'}
                </div>
              ) : (
                pendingRegions
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((region) => {
                    const details = BRUSH_DETAILS[region.brushType];

                    return (
                      <div
                        key={region.id}
                        className="flex flex-col p-2 rounded-lg border text-xs gap-1"
                        style={{
                          background: 'var(--surface-2)',
                          borderColor: 'var(--border-subtle)',
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <div
                              className="w-3 h-3 rounded border flex-shrink-0 animate-pulse"
                              style={{
                                backgroundColor: region.color,
                                borderColor: 'var(--border-subtle)',
                              }}
                            />
                            <div className="flex flex-col min-w-0">
                              <span
                                className="font-semibold truncate"
                                style={{ color: 'var(--text-strong)' }}
                              >
                                {details?.label || region.brushType} (Pending)
                              </span>
                              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                Seed #{region.seedTriangleId}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded border font-semibold"
                              style={{
                                background: 'var(--surface-1)',
                                borderColor: 'var(--border-subtle)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              {region.triangleIds.size} tri
                            </span>
                            <IconButton
                              onClick={() => supportPainterStore.removeRegion(region.id)}
                              className="!p-1"
                              title="Delete region"
                            >
                              <Trash2 className="w-3 h-3" />
                            </IconButton>
                          </div>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>

          {/* ROI History and Saves Rollup */}
          <div
            className="flex flex-col gap-1.5 border-t pt-2.5"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <IconButton
                  onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                  className="!p-0.5 animate-none"
                  title={isHistoryExpanded ? "Collapse History" : "Expand History"}
                >
                  {isHistoryExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                </IconButton>
                <span
                  className="text-[10px] uppercase tracking-wider font-bold cursor-pointer select-none"
                  onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                  style={{ color: 'var(--text-muted)' }}
                >
                  ROI History and Saves ({completedRegions.length})
                </span>
              </div>
            </div>

            {isHistoryExpanded && (
              <div className="flex flex-col gap-2.5 mt-1">
                <div className="max-h-[180px] overflow-y-auto pr-1 flex flex-col gap-1.5 scrollbar-thin">
                  {completedRegions.length === 0 ? (
                    <div
                      className="text-center py-4 text-[11px] italic"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      No saved or generated ROIs
                    </div>
                  ) : (
                    completedRegions
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map((region) => {
                        const details = BRUSH_DETAILS[region.brushType];
                        const isRegionExpanded = !!expandedRegions[region.id];

                        // Fetch generated support entities for this ROI region
                        const regionTrunks = Object.values(supportState.trunks).filter(t => t.roiId === region.id);
                        const regionBranches = Object.values(supportState.branches).filter(b => b.roiId === region.id);
                        const regionLeaves = Object.values(supportState.leaves).filter(l => l.roiId === region.id);
                        const regionTwigs = Object.values(supportState.twigs).filter(t => t.roiId === region.id);
                        const regionSticks = Object.values(supportState.sticks).filter(s => s.roiId === region.id);
                        const regionAnchors = Object.values(supportState.anchors).filter(a => a.roiId === region.id);
                        const totalChildSupports = regionTrunks.length + regionBranches.length + regionLeaves.length + regionTwigs.length + regionSticks.length + regionAnchors.length;

                        const isSelected = state.selectedRegionId === region.id;

                        return (
                          <div
                            key={region.id}
                            className="flex flex-col p-2 rounded-lg border text-xs gap-1 transition-all duration-150"
                            onClick={() => supportPainterStore.setSelectedRegionId(isSelected ? null : region.id)}
                            style={{
                              background: 'var(--surface-2)',
                              borderColor: isSelected ? 'var(--accent, #ec4899)' : 'var(--border-subtle)',
                              boxShadow: isSelected ? '0 0 10px rgba(236, 72, 153, 0.45)' : 'none',
                              cursor: 'pointer',
                            }}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {/* Chevron Toggle button */}
                                <IconButton
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedRegions(prev => ({
                                      ...prev,
                                      [region.id]: !prev[region.id],
                                    }));
                                  }}
                                  className="!p-0.5"
                                  title={isRegionExpanded ? "Collapse breakdown" : "Expand breakdown"}
                                >
                                  {isRegionExpanded ? (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronRight className="w-3.5 h-3.5" />
                                  )}
                                </IconButton>

                                <div
                                  className="w-3 h-3 rounded border flex-shrink-0"
                                  style={{
                                    backgroundColor: region.color,
                                    borderColor: 'var(--border-subtle)',
                                  }}
                                />
                                <div className="flex flex-col min-w-0">
                                  <div className="flex items-center gap-1 min-w-0">
                                    <span
                                      className="font-semibold truncate"
                                      style={{ color: totalChildSupports === 0 ? 'var(--warning, #eab308)' : 'var(--text-strong)' }}
                                    >
                                      {details?.label || region.brushType}
                                    </span>
                                  </div>
                                  <span
                                    className="text-[9px]"
                                    style={{ color: totalChildSupports === 0 ? 'var(--warning, #eab308)' : 'var(--text-muted)' }}
                                  >
                                    Seed #{region.seedTriangleId}
                                  </span>
                                </div>
                              </div>
                              <div 
                                className="flex flex-col gap-1 items-end select-none justify-center flex-shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span
                                  className="text-[9px] px-1.5 py-0.5 rounded border font-semibold text-right"
                                  style={{
                                    background: 'var(--surface-1)',
                                    borderColor: 'var(--border-subtle)',
                                    color: 'var(--text-muted)',
                                  }}
                                >
                                  {region.triangleIds.size} tri
                                </span>
                                <span
                                  className="text-[9px] px-1.5 py-0.5 rounded border font-semibold text-right"
                                  style={{
                                    background: 'var(--surface-1)',
                                    borderColor: 'var(--border-subtle)',
                                    color: totalChildSupports === 0 ? 'var(--danger, #ef4444)' : 'var(--text-muted)',
                                  }}
                                >
                                  {totalChildSupports}/{region.attemptedCount ?? totalChildSupports} sup
                                </span>
                              </div>
                            </div>

                            {/* Collapsible Support Child Breakdown */}
                            {isRegionExpanded && (
                              <div
                                className="mt-1 pl-6 pr-1 py-1.5 flex flex-col gap-1 border-t text-[10px]"
                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                              >
                                <div className="font-bold text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-strong)' }}>
                                  Child Support Breakdown ({totalChildSupports})
                                </div>
                                {totalChildSupports === 0 ? (
                                  <span className="italic text-[9px]">No supports generated.</span>
                                ) : (
                                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-medium text-[9px]">
                                    {regionTrunks.length > 0 && <div>Trunks: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{regionTrunks.length}</span></div>}
                                    {regionBranches.length > 0 && <div>Branches: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{regionBranches.length}</span></div>}
                                    {regionLeaves.length > 0 && <div>Leaves: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{regionLeaves.length}</span></div>}
                                    {regionTwigs.length > 0 && <div>Twigs: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{regionTwigs.length}</span></div>}
                                    {regionSticks.length > 0 && <div>Sticks: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{regionSticks.length}</span></div>}
                                    {regionAnchors.length > 0 && <div>Anchors: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{regionAnchors.length}</span></div>}
                                  </div>
                                )}

                                {/* Parameters Used */}
                                {region.support && (
                                  <div className="mt-2 border-t pt-2 flex flex-col gap-1 text-[9px]">
                                    <div className="font-bold text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-strong)' }}>
                                      Parameters at Last Generation
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-medium text-[9px] leading-normal">
                                      <div>Preset: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.presetName}</span></div>
                                      <div>Shaft Width: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.shaftDiameterMm.toFixed(2)} mm</span></div>
                                      <div>Perim Spacing: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.perimeterSpacingMm.toFixed(2)} mm</span></div>
                                      <div>Infill Spacing: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.infillSpacingMm.toFixed(2)} mm</span></div>
                                      {region.support.parameters.tipContactDiameterMm !== undefined && (
                                        <div>Tip Contact Ø: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.tipContactDiameterMm.toFixed(2)} mm</span></div>
                                      )}
                                      {region.support.parameters.tipLengthMm !== undefined && (
                                        <div>Tip Length: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.tipLengthMm.toFixed(2)} mm</span></div>
                                      )}
                                      {region.support.parameters.rootsDiameterMm !== undefined && (
                                        <div>Roots Base Ø: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.rootsDiameterMm.toFixed(2)} mm</span></div>
                                      )}
                                      {region.support.parameters.shaftMaxAngleDeg !== undefined && (
                                        <div>Max Overhang: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.shaftMaxAngleDeg}°</span></div>
                                      )}
                                      {region.support.parameters.baseFlareEnabled !== undefined && (
                                        <div>Base Flare: <span className="font-bold" style={{ color: 'var(--text-strong)' }}>{region.support.parameters.baseFlareEnabled ? 'Enabled' : 'Disabled'}</span></div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                  )}
                </div>                {/* Selected ROI Actions */}
                {(() => {
                  const selectedRegion = state.selectedRegionId ? completedRegions.find(r => r.id === state.selectedRegionId) : null;

                  let totalChildSupports = 0;
                  if (selectedRegion) {
                    const regionTrunks = Object.values(supportState.trunks).filter(t => t.roiId === selectedRegion.id);
                    const regionBranches = Object.values(supportState.branches).filter(b => b.roiId === selectedRegion.id);
                    const regionLeaves = Object.values(supportState.leaves).filter(l => l.roiId === selectedRegion.id);
                    const regionTwigs = Object.values(supportState.twigs).filter(t => t.roiId === selectedRegion.id);
                    const regionSticks = Object.values(supportState.sticks).filter(s => s.roiId === selectedRegion.id);
                    const regionAnchors = Object.values(supportState.anchors).filter(a => a.roiId === selectedRegion.id);
                    totalChildSupports = regionTrunks.length + regionBranches.length + regionLeaves.length + regionTwigs.length + regionSticks.length + regionAnchors.length;
                  }

                  const isBtnDisabled = selectedRegion === null;

                  return (
                    <div
                      className="flex flex-col gap-2 border-t pt-2.5"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <span
                        className="text-[10px] uppercase tracking-wider font-bold"
                        style={{ color: 'var(--accent, #ec4899)' }}
                      >
                        Selected ROI Actions
                      </span>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => selectedRegion && handleRemoveSupportsForRoi(selectedRegion.id)}
                          className="w-full !text-[10px] py-1 flex items-center justify-center gap-1.5"
                          disabled={isBtnDisabled || totalChildSupports === 0}
                          style={{
                            opacity: (isBtnDisabled || totalChildSupports === 0) ? 0.4 : 1,
                            cursor: (isBtnDisabled || totalChildSupports === 0) ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <Eraser className="w-3.5 h-3.5" style={{ color: (isBtnDisabled || totalChildSupports === 0) ? 'var(--text-muted)' : 'var(--warning, #f59e0b)' }} />
                          Erase ROI Supports
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            if (selectedRegion) {
                              handleDeleteRegion(selectedRegion.id);
                              supportPainterStore.setSelectedRegionId(null);
                            }
                          }}
                          className="w-full !text-[10px] py-1 flex items-center justify-center gap-1.5"
                          disabled={isBtnDisabled}
                          style={{
                            opacity: isBtnDisabled ? 0.4 : 1,
                            cursor: isBtnDisabled ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" style={{ color: isBtnDisabled ? 'var(--text-muted)' : 'var(--danger, #ef4444)' }} />
                          Delete ROI &amp; Supports
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            if (selectedRegion) {
                              handleRemoveRoiOnly(selectedRegion.id);
                              supportPainterStore.setSelectedRegionId(null);
                            }
                          }}
                          className="col-span-2 w-full !text-[10px] py-1 flex items-center justify-center gap-1.5"
                          disabled={isBtnDisabled}
                          style={{
                            opacity: isBtnDisabled ? 0.4 : 1,
                            cursor: isBtnDisabled ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <Trash className="w-3.5 h-3.5" style={{ color: isBtnDisabled ? 'var(--text-muted)' : 'var(--text-strong)' }} />
                          Remove ROI Only
                        </Button>
                      </div>
                    </div>
                  );
                })()}

                {/* ROI Maintenance Utilities inside rollup */}
                <div
                  className="flex flex-col gap-2 border-t pt-2.5"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <span
                    className="text-[10px] uppercase tracking-wider font-bold"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Maintenance Utilities
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const beforeRegions = new Map(state.regions);
                        pushHistory({
                          type: PAINT_ROI_STRIP,
                          description: 'Strip model ROI regions',
                          payload: { beforeRegions },
                        });
                        supportPainterStore.stripRoiData(activeModelId);
                      }}
                      className="w-full !text-[10px] py-1"
                      disabled={completedRegions.length === 0}
                    >
                      Strip ROI (Model)
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const beforeRegions = new Map(state.regions);
                        pushHistory({
                          type: PAINT_ROI_STRIP,
                          description: 'Strip all ROI regions',
                          payload: { beforeRegions },
                        });
                        supportPainterStore.stripRoiData();
                      }}
                      className="w-full !text-[10px] py-1"
                      disabled={completedRegions.length === 0}
                    >
                      Strip ROI (Global)
                    </Button>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      const activeMesh = getActiveMesh?.();
                      if (activeModelId && activeMesh && completedRegions.length > 0) {
                        // Batch regenerate supports sequentially for each completed region
                        for (const region of completedRegions) {
                          await regenerateSupportsForRoi(activeModelId, activeMesh, region.id);
                        }
                      }
                    }}
                    className="w-full !text-[10px] py-1 flex items-center justify-center gap-1.5 mt-0.5"
                    disabled={completedRegions.length === 0}
                  >
                    <RefreshCw className="w-3 h-3" />
                    Recalculate All Supports
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Spacing Overrides [SPACING_OVERRIDES_UI] */}
          {/* [AGENT_NOTE] User-customizable spacing overrides separately for perimeter and infill. */}
          <div
            className="flex flex-col gap-2 border-t pt-2.5"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span
              className="text-[10px] uppercase tracking-wider font-bold"
              style={{ color: 'var(--text-muted)' }}
            >
              Spacing Overrides
            </span>
            <div className="grid grid-cols-2 gap-3">
              {/* Perimeter Spacing */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-strong)' }}>
                  Perimeter Spacing
                </span>
                <div className="relative flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder={defaultSpacing.toFixed(1)}
                    value={state.perimeterSpacingOverride !== null ? state.perimeterSpacingOverride : ''}
                    onChange={(e) => {
                      const val = e.target.value === '' ? null : Math.max(0.1, parseFloat(e.target.value));
                      supportPainterStore.setPerimeterSpacingOverride(val);
                    }}
                    className="w-full text-[11px] pl-2 pr-6 py-1 rounded border outline-none font-medium transition-colors"
                    style={{
                      background: 'var(--surface-1)',
                      borderColor: 'var(--border-subtle)',
                      color: 'var(--text-strong)',
                    }}
                  />
                  <span className="absolute right-2 text-[9px] pointer-events-none" style={{ color: 'var(--text-muted)' }}>
                    mm
                  </span>
                </div>
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  Default: <span className="font-medium">{defaultSpacing.toFixed(1)} mm</span>
                </span>
              </div>

              {/* Infill Spacing */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-strong)' }}>
                  Infill Spacing
                </span>
                <div className="relative flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder={defaultSpacing.toFixed(1)}
                    value={state.infillSpacingOverride !== null ? state.infillSpacingOverride : ''}
                    onChange={(e) => {
                      const val = e.target.value === '' ? null : Math.max(0.1, parseFloat(e.target.value));
                      supportPainterStore.setInfillSpacingOverride(val);
                    }}
                    className="w-full text-[11px] pl-2 pr-6 py-1 rounded border outline-none font-medium transition-colors"
                    style={{
                      background: 'var(--surface-1)',
                      borderColor: 'var(--border-subtle)',
                      color: 'var(--text-strong)',
                    }}
                  />
                  <span className="absolute right-2 text-[9px] pointer-events-none" style={{ color: 'var(--text-muted)' }}>
                    mm
                  </span>
                </div>
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  Default: <span className="font-medium">{defaultSpacing.toFixed(1)} mm</span>
                </span>
              </div>
            </div>
          </div>

          {/* Generate Button */}
          <Button
            variant="accent"
            size="sm"
            className="w-full"
            disabled={pendingRegions.length === 0 || isGenerating}
            onClick={handleGenerate}
          >
            {isGenerating ? 'Generating…' : `Generate Supports (${pendingRegions.length})`}
          </Button>

        </div>
      )}

      {/* ─── Support Painter Toast Notification [TOAST_NOTIFICATION] ─── */}
      {/* [AGENT_NOTE] Mounts a floating toast viewport showing attempted vs placed counts upon completion. */}
      {state.toast && (
        <ToastViewport position="top-center" zIndex={9999} style={{ top: '1.25rem' }}>
          <Toast
            tone="info"
            shape="rounded"
            visible={true}
            enterOffsetPx={8}
            className="flex flex-col gap-1 items-start text-xs font-semibold py-2.5 px-4 shadow-xl border select-none transition-all duration-200"
            style={{
              animation: 'fadeIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards',
              minWidth: '240px',
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
              color: 'var(--text-strong)',
            }}
          >
            <div
              className="font-bold border-b pb-1 mb-0.5 w-full text-left"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-strong)' }}
            >
              Support Placement Summary
            </div>
            {state.toast.lines.map((line, idx) => (
              <div
                key={idx}
                className="text-left w-full whitespace-pre-wrap leading-relaxed font-medium"
                style={{
                  color: line.startsWith('  ') ? 'var(--text-muted)' : 'var(--text-strong)',
                  paddingLeft: line.startsWith('  ') ? '0.5rem' : '0',
                }}
              >
                {line}
              </div>
            ))}
          </Toast>
        </ToastViewport>
      )}

      {showCustomBrushModal && (
        <CustomBrushModal
          initialBrush={editingCustomBrush}
          onClose={() => {
            setShowCustomBrushModal(false);
            setEditingCustomBrush(null);
          }}
          onSave={(updated) => {
            if (editingCustomBrush) {
              supportPainterStore.updateCustomBrush(updated.id, updated);
            } else {
              supportPainterStore.addCustomBrush(updated);
            }
            setShowCustomBrushModal(false);
            setEditingCustomBrush(null);
          }}
        />
      )}
    </Card>
  );
}
