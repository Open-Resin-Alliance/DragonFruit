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
  Square,
  Settings,
  Save,
  X,
  Download,
  Upload,
} from 'lucide-react';
import { Card, CardHeader, IconButton, Button, Toast, ToastViewport } from '@/components/ui/primitives';
import { supportPainterStore, useSupportPainterState } from '../supportPainterStore';
import { type BrushType, type CustomBrushTemplate, type CustomSupportOperation, BRUSH_COLORS, upgradePipeline, arePipelinesEquivalent, type SupportPlacementScript, type ROIRegion } from '../supportPainterTypes';
import { generateSupportsFromPainter, regenerateSupportsForRoi } from '../supportScriptingEngine';
import { subscribeToSettings, getSettings } from '@/supports/Settings';
import {
  subscribe as subscribeToSupports,
  getSnapshot as getSupportsSnapshot,
  setSnapshot as setSupportSnapshot,
  beginSupportStateBatch,
  endSupportStateBatch,
} from '@/supports/state';
import { deleteSupportsForRoi } from '@/supports/PlacementLogic/SupportModelLinker';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { PAINT_ROI_STRIP, PAINT_ROI_ADD } from '../supportPainterHistoryTypes';
import { pushHistory } from '@/history/historyStore';
import { CustomBrushModal } from './CustomBrushModal';
import { SupportPipelineEditor } from './SupportPipelineEditor';
import { DivergentScriptWarningModal } from './DivergentScriptWarningModal';
import { ImportConflictModal } from './ImportConflictModal';
import {
  pickSavePathWithNativeDialogOptions,
  pickOpenFilesWithNativeDialog,
  writeBytesToNativePath,
  readPrintArtifactBytesFromPath,
} from '@/features/slicing/tauri/nativeSlicerBridge';

const BRUSH_DETAILS: Record<
  BrushType,
  { label: string; desc: string; icon: React.ComponentType<any> }
> = {
  Marker: {
    label: 'Marker Brush',
    desc: 'Brush with rotated shapes & collision strategies',
    icon: CircleDot,
  },
  MacroFace: {
    label: 'MacroFace',
    desc: 'Paint coplanar surfaces',
    icon: Focus,
  },
  TexturedFace: {
    label: 'Textured Face',
    desc: 'Paint textured / macro faces',
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
  RoughEdge: {
    label: 'Rough Edge',
    desc: 'Paint tattered edge crease',
    icon: Cylinder,
  },
  SoftRidge: {
    label: 'Soft Ridge',
    desc: 'Trace bottom soft ridge spine',
    icon: GitCommit,
  },
  Ring: {
    label: 'Z-Plane Ring',
    desc: 'Horizontal Z-plane slice',
    icon: Circle,
  },
  ManualCircle: {
    label: 'Manual Circle',
    desc: 'Manual circular geodesic brush',
    icon: Circle,
  },
  ManualSquare: {
    label: 'Manual Square',
    desc: 'Manual square geodesic brush',
    icon: Square,
  },
  PointPath: {
    label: 'Point Path',
    desc: 'Select points to draw centerline paths',
    icon: GitCommit,
  },
  PointPerimeter: {
    label: 'Point Perimeter',
    desc: 'Draw an enclosed perimeter boundary loop',
    icon: Circle,
  },
  SharpCorner: {
    label: 'Sharp Corner',
    desc: 'Propagate along sharp crease edges',
    icon: GitCommit,
  },
  MinimaIslands: {
    label: 'Minima Islands',
    desc: 'Auto-detected local vertical minima islands',
    icon: WandSparkles,
  },
  'Unk Legacy Brush': {
    label: 'Unk Legacy Brush',
    desc: 'Unknown legacy support brush',
    icon: Cylinder,
  },
};

function getSupportTips(supportState: any, activeModelId: string): THREE.Vector3[] {
  const tips: THREE.Vector3[] = [];

  const pushCone = (cone?: any) => {
    if (cone && cone.pos) {
      tips.push(new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z));
    }
  };

  const pushDisk = (disk?: any) => {
    if (disk && disk.pos) {
      tips.push(new THREE.Vector3(disk.pos.x, disk.pos.y, disk.pos.z));
    }
  };

  if (!supportState) return tips;

  // Trunks
  if (supportState.trunks) {
    for (const t of Object.values(supportState.trunks) as any[]) {
      if (t.modelId === activeModelId) {
        pushCone(t.contactCone);
      }
    }
  }

  // Branches
  if (supportState.branches) {
    for (const b of Object.values(supportState.branches) as any[]) {
      if (b.modelId === activeModelId) {
        pushCone(b.contactCone);
      }
    }
  }

  // Leaves
  if (supportState.leaves) {
    for (const l of Object.values(supportState.leaves) as any[]) {
      if (l.modelId === activeModelId) {
        pushCone(l.contactCone);
      }
    }
  }

  // Twigs
  if (supportState.twigs) {
    for (const tw of Object.values(supportState.twigs) as any[]) {
      if (tw.modelId === activeModelId) {
        pushDisk(tw.contactDiskA);
        pushDisk(tw.contactDiskB);
      }
    }
  }

  // Sticks
  if (supportState.sticks) {
    for (const st of Object.values(supportState.sticks) as any[]) {
      if (st.modelId === activeModelId) {
        pushCone(st.contactConeA);
        pushCone(st.contactConeB);
      }
    }
  }

  // Anchors
  if (supportState.anchors) {
    for (const a of Object.values(supportState.anchors) as any[]) {
      if (a.modelId === activeModelId) {
        pushCone(a.contactCone);
      }
    }
  }

  return tips;
}

export function SupportPainterPanel({
  activeModelId,
  onModeChange,
}: {
  activeModelId?: string | null;
  onModeChange?: (mode: 'support' | 'supportPainter') => void;
}) {
  const state = useSupportPainterState();
  const activeSettings = useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
  const supportState = useSyncExternalStore(subscribeToSupports, getSupportsSnapshot, getSupportsSnapshot);
  const [expandedRegions, setExpandedRegions] = useState<Record<string, boolean>>({});
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');
  const [isMaintenanceExpanded, setIsMaintenanceExpanded] = useState(false);
  const [isDiagnosticsExpanded, setIsDiagnosticsExpanded] = useState(true);
  const [isCustomBrushExpanded, setIsCustomBrushExpanded] = useState(true);
  const trunkWidth = activeSettings?.shaft?.diameterMm ?? 1.0;
  const defaultSpacing = isNaN(trunkWidth) ? 4.0 : trunkWidth * 4.0;

  const [isGenerating, setIsGenerating] = useState(false);
  const [isEditingMarkerRadius, setIsEditingMarkerRadius] = useState(false);
  const [tempMarkerRadius, setTempMarkerRadius] = useState('');
  const [showCustomBrushModal, setShowCustomBrushModal] = useState(false);
  const [editingCustomBrush, setEditingCustomBrush] = useState<CustomBrushTemplate | null>(null);
  const [expanded, setExpanded] = useState(false);  // collapsed = support mode, expanded = painter mode
  const [isScanning, setIsScanning] = useState(false);
  const [pipelineEditingContext, setPipelineEditingContext] = useState<'active' | 'roi' | null>(null);
  const [editingPipeline, setEditingPipeline] = useState<CustomSupportOperation[]>([]);
  const [editingPlacementScriptId, setEditingPlacementScriptId] = useState<string | null>(null);
  const [showDivergentModal, setShowDivergentModal] = useState(false);
  const activeSelectedIds = Array.from(state.selectedRegionIds).filter(id => state.regions.has(id));
  const [scriptNameInput, setScriptNameInput] = useState('');
  const [isSavingScript, setIsSavingScript] = useState(false);

  const handleExportConfigs = async () => {
    try {
      const configPackJson = supportPainterStore.exportConfigPack();
      const filename = 'support-painter-configs.json';
      const destinationPath = await pickSavePathWithNativeDialogOptions(filename, {
        filters: [{ name: 'Config Pack', extensions: ['json'] }]
      });
      if (destinationPath) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(configPackJson);
        await writeBytesToNativePath(destinationPath, bytes);
        supportPainterStore.showToast([`Successfully exported config pack to ${destinationPath}`]);
      }
    } catch (err: any) {
      if (err !== 'Save cancelled by user' && err?.message !== 'Save cancelled by user') {
        console.error('[SupportPainterPanel] Failed exporting configuration pack:', err);
        supportPainterStore.showToast([`Export failed: ${err?.message || err}`]);
      }
    }
  };

  const handleImportConfigs = async () => {
    try {
      const picked = await pickOpenFilesWithNativeDialog('bundle', false);
      if (picked && picked.length > 0) {
        const filePath = picked[0].path;
        const bytes = await readPrintArtifactBytesFromPath(filePath);
        const decoder = new TextDecoder();
        const content = decoder.decode(bytes);
        const res = supportPainterStore.importConfigPack(content);
        if (res.success) {
          supportPainterStore.showToast([`Successfully loaded configuration pack.`]);
        } else {
          supportPainterStore.showToast([`Failed loading pack: ${res.error}`]);
        }
      }
    } catch (err: any) {
      if (err !== 'Open cancelled by user' && err?.message !== 'Open cancelled by user') {
        console.error('[SupportPainterPanel] Failed importing configuration pack:', err);
        supportPainterStore.showToast([`Import failed: ${err?.message || err}`]);
      }
    }
  };

  // Find matched script for Active tab to keep inline input synchronized
  const activeCustomBrush = state.activeCustomBrushId ? state.customBrushes.get(state.activeCustomBrushId) : undefined;
  const rawPipeline = state.activeBrushPipeline || (activeCustomBrush?.operations) || upgradePipeline(undefined, state.activeBrush, defaultSpacing);
  const currentPipeline = upgradePipeline(rawPipeline, state.activeBrush, defaultSpacing);

  const activeScript = state.activePlacementScriptId ? state.placementScripts.get(state.activePlacementScriptId) : null;
  const isActiveScriptEquivalent = activeScript && arePipelinesEquivalent(
    upgradePipeline(activeScript.operations, state.activeBrush, defaultSpacing),
    currentPipeline
  );

  const matchedActiveScript = isActiveScriptEquivalent ? activeScript : Array.from(state.placementScripts.values()).find(script => {
    const scriptOps = upgradePipeline(script.operations, state.activeBrush, defaultSpacing);
    return arePipelinesEquivalent(scriptOps, currentPipeline);
  });

  // Keep script name input synchronized with matched active script
  useEffect(() => {
    if (matchedActiveScript) {
      setScriptNameInput(matchedActiveScript.isBuiltIn ? `${matchedActiveScript.name} (Custom)` : matchedActiveScript.name);
    } else {
      setScriptNameInput('');
    }
  }, [matchedActiveScript?.id]);

  const getDefaultPipeline = (brushType: BrushType): CustomSupportOperation[] => {
    return upgradePipeline(undefined, brushType, defaultSpacing);
  };

  const getComparisonPipeline = (
    context: 'active' | 'roi' | null,
    regionId?: string | null
  ): CustomSupportOperation[] | undefined => {
    if (!context) return undefined;
    if (context === 'active') {
      return getDefaultPipeline(state.activeBrush);
    } else if (context === 'roi' && regionId) {
      const region = state.regions.get(regionId);
      if (!region) return undefined;
      
      if (region.support) {
        const isPointPathOrMarker = region.brushType === 'PointPath' || region.brushType === 'Marker' || region.brushType === 'SharpCorner';
        const isLineBrush = region.brushType === 'Ridge' || region.brushType === 'SoftRidge' || region.brushType === 'SharpCorner' || (
          region.brushType === 'PointPath' && region.brush?.parameters?.pointPathMode === 'line'
        );
        const isMinimaIslands = region.brushType === 'MinimaIslands';
        const params = region.support.parameters;
        return [
          {
            type: 'minima',
            enabled: isMinimaIslands || (!isPointPathOrMarker && !isLineBrush),
            suppression: {
              enabled: !isMinimaIslands && params.suppressionSettings?.minima?.mode !== 'none',
              distanceMm: params.minimaSuppressionRadiusMm ?? defaultSpacing,
              suppressAgainst: params.suppressionSettings?.minima?.types || ['minima'],
            },
            spacing: {
              baseSpacingMm: params.minimaSuppressionRadiusMm ?? defaultSpacing,
            },
          },
          {
            type: 'perimeter',
            enabled: !isMinimaIslands && !isPointPathOrMarker && !isLineBrush,
            suppression: {
              enabled: false,
              distanceMm: params.perimeterSpacingMm ?? defaultSpacing,
              suppressAgainst: params.suppressionSettings?.perimeter?.types || [],
            },
            spacing: {
              baseSpacingMm: params.perimeterSpacingMm ?? defaultSpacing,
              solverMode: 'standard',
              useInflectionPoints: false,
            },
          },
          {
            type: 'infill',
            enabled: !isMinimaIslands && !isLineBrush,
            suppression: {
              enabled: true,
              distanceMm: params.infillSpacingMm ?? defaultSpacing,
              suppressAgainst: params.suppressionSettings?.infill?.types || ['minima', 'perimeter', 'infill'],
            },
            spacing: {
              baseSpacingMm: params.infillSpacingMm ?? defaultSpacing,
              infillPattern: 'PoissonDisc',
              seedFromMinima: true,
            },
          },
          {
            type: 'centerline',
            enabled: !isMinimaIslands && isLineBrush,
            suppression: {
              enabled: true,
              distanceMm: params.perimeterSpacingMm ?? defaultSpacing,
              suppressAgainst: params.suppressionSettings?.centerline?.types || ['minima', 'perimeter', 'infill', 'centerline'],
            },
            spacing: {
              baseSpacingMm: params.perimeterSpacingMm ?? defaultSpacing,
              seedFromMinima: true,
            },
          },
        ];
      }
      return getDefaultPipeline(region.brushType);
    }
    return undefined;
  };

  // Partition regions into Pending vs Completed/Saved History
  const regionsArray = Array.from(state.regions.values());
  const pendingRegions = regionsArray.filter(
    (r) => r.support === undefined && r.loops === undefined
  );
  const completedRegions = regionsArray.filter(
    (r) => r.support !== undefined || r.loops !== undefined
  );

  // Dynamically calculate vertical minima support coverage stats using 0.3mm threshold
  const totalMinima = state.scannedMinima?.length ?? 0;
  let supportedMinima = 0;
  let unsupportedMinima = 0;

  if (totalMinima > 0 && activeModelId) {
    const tips = getSupportTips(supportState, activeModelId);
    for (const item of state.scannedMinima || []) {
      const minPos = new THREE.Vector3(item.position.x, item.position.y, item.position.z);
      const isSupported = tips.some((tip) => minPos.distanceTo(tip) <= 0.3);
      if (isSupported) {
        supportedMinima++;
      } else {
        unsupportedMinima++;
      }
    }
  }

  const purgeEmptySessionRois = () => {
    const state = supportPainterStore.getSnapshot();
    if (state.roiTrackingMode === 'voxl' || state.roiTrackingMode === 'session') {
      return;
    }
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

        if (totalChildSupports === 0 && region.brushType !== 'MinimaIslands') {
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
    const mesh = supportPainterStore.getActiveMesh();
    if (!activeModelId || !mesh || pendingRegions.length === 0) return;
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

    // Reset completed metadata so region becomes pending/active again
    const nextRegions = new Map(beforeRegions);
    const region = nextRegions.get(regionId);
    if (region) {
      const updatedRegion = {
        ...region,
        support: undefined,
        loops: undefined,
        placedCount: undefined,
        attemptedCount: undefined,
      };
      nextRegions.set(regionId, updatedRegion);
    }

    setSupportSnapshot(nextState);
    supportPainterStore.restoreRegions(nextRegions);

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: 'Remove supports for region',
      payload: {
        before: beforeState,
        after: nextState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: nextRegions,
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

  const handleRemoveSupportsForRegions = (regionIds: string[]) => {
    const beforeState = getSupportsSnapshot();
    let nextState = beforeState;
    const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);
    const nextRegions = new Map(beforeRegions);

    beginSupportStateBatch();
    try {
      for (const regionId of regionIds) {
        nextState = deleteSupportsForRoi(nextState, regionId);
        const region = nextRegions.get(regionId);
        if (region) {
          nextRegions.set(regionId, {
            ...region,
            support: undefined,
            loops: undefined,
            placedCount: undefined,
            attemptedCount: undefined,
          });
        }
      }
      setSupportSnapshot(nextState);
      supportPainterStore.restoreRegions(nextRegions);
    } finally {
      endSupportStateBatch();
    }

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: `Remove supports for ${regionIds.length} regions`,
      payload: {
        before: beforeState,
        after: nextState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: nextRegions,
      },
    });
  };

  const handleDeleteRegions = (regionIds: string[]) => {
    const beforeState = getSupportsSnapshot();
    let nextState = beforeState;
    const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);
    const nextRegions = new Map(beforeRegions);

    beginSupportStateBatch();
    try {
      for (const regionId of regionIds) {
        nextState = deleteSupportsForRoi(nextState, regionId);
        nextRegions.delete(regionId);
      }
      setSupportSnapshot(nextState);
      supportPainterStore.restoreRegions(nextRegions);
    } finally {
      endSupportStateBatch();
    }

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: `Delete ${regionIds.length} ROI regions and supports`,
      payload: {
        before: beforeState,
        after: nextState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: nextRegions,
      },
    });
  };

  const handleRemoveRoisOnly = (regionIds: string[]) => {
    const beforeState = getSupportsSnapshot();
    const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);
    const nextRegions = new Map(beforeRegions);

    for (const regionId of regionIds) {
      nextRegions.delete(regionId);
    }

    supportPainterStore.restoreRegions(nextRegions);

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: `Remove ${regionIds.length} ROIs Only`,
      payload: {
        before: beforeState,
        after: beforeState,
        painterRegionsBefore: beforeRegions,
        painterRegionsAfter: nextRegions,
      },
    });
  };

  const handleRecalculateRegions = async (regionIds: string[]) => {
    const activeMesh = supportPainterStore.getActiveMesh();
    if (!activeModelId || !activeMesh || regionIds.length === 0) return;

    setIsGenerating(true);
    try {
      const snap = supportPainterStore.getSnapshot();
      const targetRegions = regionIds
        .map((id) => snap.regions.get(id))
        .filter(Boolean) as ROIRegion[];

      // Purge supports for all targeted ROIs first in a single batch
      const beforeState = getSupportsSnapshot();
      let nextState = beforeState;
      for (const id of regionIds) {
        nextState = deleteSupportsForRoi(nextState, id);
      }
      setSupportSnapshot(nextState);

      // Sequentially regenerate supports using supportScriptingEngine batch execution
      await generateSupportsFromPainter(activeModelId, activeMesh, targetRegions);
    } catch (err) {
      console.error('[SupportPainterPanel] Batch regeneration failed', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClearAllRegionsAndSupports = () => {
    const beforeState = getSupportsSnapshot();
    let nextState = beforeState;
    
    for (const regionId of state.regions.keys()) {
      nextState = deleteSupportsForRoi(nextState, regionId);
    }
    
    setSupportSnapshot(nextState);
    supportPainterStore.clearAll();
    
    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: 'Delete all ROI regions and supports',
      payload: {
        before: beforeState,
        after: nextState,
        painterRegionsBefore: new Map(state.regions),
        painterRegionsAfter: new Map(),
      },
    });
  };

  const handleScanMinima = async () => {
    if (!activeModelId) return;
    setIsScanning(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const activeMesh = supportPainterStore.getActiveMesh();
      if (!activeMesh) {
        throw new Error('Active mesh not available');
      }
      
      // Force update the world matrix to propagate any recent rotation/scale/translation from parent groups
      activeMesh.updateMatrixWorld(true);
      
      console.log('[SupportPainterPanel] Extracting transformed world-space positions...');
      let geom = activeMesh.geometry;
      let needsDispose = false;
      if (geom.index) {
        geom = geom.toNonIndexed();
        needsDispose = true;
      }
      const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
      const matrix = activeMesh.matrixWorld;
      const positions: number[] = [];
      const tempV = new THREE.Vector3();
      
      for (let i = 0; i < posAttr.count; i++) {
        tempV.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        tempV.applyMatrix4(matrix);
        positions.push(tempV.x, tempV.y, tempV.z);
      }
      
      if (needsDispose) {
        geom.dispose();
      }
      
      console.log('[SupportPainterPanel] Updating Rust model cache with current build-plate orientation...');
      await invoke('initialize_support_painter_model', { modelId: activeModelId, positions });
      
      console.log('[SupportPainterPanel] Invoking minima scan on Rust backend...');
      const minimaList = await invoke<{ vertexIndex: number; position: any; seedTriangleId: number }[]>(
        'find_all_local_minima',
        { modelId: activeModelId }
      );
      
      if (minimaList.length === 0) {
        supportPainterStore.clearScannedMinima();
        supportPainterStore.showToast(['No new local vertical minima detected relative to build plate.']);
      } else {
        // Store all scanned minima in painter store for dynamic HUD tracking
        supportPainterStore.setScannedMinima(minimaList);

        // Extract active support tip positions
        const tips = getSupportTips(supportState, activeModelId);

        // Filter minima list to isolate unsupported ones using 0.3mm threshold
        const unsupportedMinima = minimaList.filter((item) => {
          const minPos = new THREE.Vector3(item.position.x, item.position.y, item.position.z);
          return !tips.some((tip) => minPos.distanceTo(tip) <= 0.3);
        });

        if (unsupportedMinima.length === 0) {
          supportPainterStore.showToast([
            'Minima scan complete!',
            `All ${minimaList.length} vertical minima are already supported.`
          ]);
        } else {
          supportPainterStore.commitMinimaIslands(unsupportedMinima, matrix);
          supportPainterStore.showToast([
            'Minima scan complete!',
            `Committed ${unsupportedMinima.length} unsupported island regions (out of ${minimaList.length} total) relative to build plate.`
          ]);
        }
      }
    } catch (err) {
      console.error('[SupportPainterPanel] Minima scan failed', err);
      supportPainterStore.showToast(['Minima scan failed.', String(err)]);
    } finally {
      setIsScanning(false);
    }
  };

  const handleListItemClick = (event: React.MouseEvent, regionId: string, index: number) => {
    event.stopPropagation();
    const currentSelection = new Set(state.selectedRegionIds);
    const sortedRegions = [...completedRegions].sort((a, b) => b.createdAt - a.createdAt);

    if (event.ctrlKey || event.metaKey) {
      if (currentSelection.has(regionId)) {
        currentSelection.delete(regionId);
      } else {
        currentSelection.add(regionId);
      }
      supportPainterStore.setSelectedRegionIds(currentSelection, index);
    } else if (event.shiftKey && state.lastSelectedIndex !== null) {
      const lastIdx = state.lastSelectedIndex;
      const start = Math.min(lastIdx, index);
      const end = Math.max(lastIdx, index);
      
      currentSelection.clear();
      for (let i = start; i <= end; i++) {
        currentSelection.add(sortedRegions[i].id);
      }
      supportPainterStore.setSelectedRegionIds(currentSelection, lastIdx);
    } else {
      currentSelection.clear();
      currentSelection.add(regionId);
      supportPainterStore.setSelectedRegionIds(currentSelection, index);
    }
  };

  const activeDetails = BRUSH_DETAILS[state.activeBrush] || BRUSH_DETAILS.MacroFace;
  const isCustomMarker = !!(activeCustomBrush && activeCustomBrush.baseBrush === 'Marker');
  const isMarkerActive = state.activeBrush === 'Marker' || isCustomMarker;

  return (
    <Card className="flex flex-col max-h-full min-h-0">
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
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 flex-1 min-h-0">
          {/* Tab Headers */}
          <div className="flex border-b border-[var(--border-subtle)] mb-2 flex-shrink-0">
            <button
              onClick={() => setActiveTab('active')}
              className={`flex-1 py-2 text-center text-xs font-semibold border-b-2 transition-all ${
                activeTab === 'active'
                  ? 'border-[var(--accent)] text-[var(--text-strong)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]'
              }`}
            >
              Active
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-2 text-center text-xs font-semibold border-b-2 transition-all ${
                activeTab === 'history'
                  ? 'border-[var(--accent)] text-[var(--text-strong)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]'
              }`}
            >
              History &amp; Tools
            </button>
          </div>

          {activeTab === 'active' ? (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 scrollbar-thin flex flex-col gap-3">
              {/* 1. Painted Regions (Pending List) */}
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
                  onClick={() => supportPainterStore.clearPending()}
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





              {/* 3. Smart Brush */}
          {/* Brush Selection */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span
                className="text-[10px] uppercase tracking-wider font-bold"
                style={{ color: 'var(--text-muted)' }}
              >
                SMART BRUSH
              </span>
              <div className="flex items-center bg-surface-1 rounded border border-border-subtle p-0.5 text-[9px] font-semibold" style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => supportPainterStore.setSmartBrushesDisplayMode('std')}
                  className="px-1.5 py-0.5 rounded transition-all"
                  style={{
                    backgroundColor: state.smartBrushesDisplayMode === 'std' ? 'var(--accent)' : 'transparent',
                    color: state.smartBrushesDisplayMode === 'std' ? '#fff' : 'var(--text-muted)',
                  }}
                >
                  Std
                </button>
                <button
                  type="button"
                  onClick={() => supportPainterStore.setSmartBrushesDisplayMode('ext')}
                  className="px-1.5 py-0.5 rounded transition-all"
                  style={{
                    backgroundColor: state.smartBrushesDisplayMode === 'ext' ? 'var(--accent)' : 'transparent',
                    color: state.smartBrushesDisplayMode === 'ext' ? '#fff' : 'var(--text-muted)',
                  }}
                >
                  Ext
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(BRUSH_DETAILS) as BrushType[])
                .filter((brush) => brush !== 'ManualCircle' && brush !== 'ManualSquare' && brush !== 'MinimaIslands' && brush !== 'Unk Legacy Brush')
                .filter((brush) => {
                  if (state.smartBrushesDisplayMode === 'std') {
                    const hiddenBrushes = new Set<BrushType>(['Point', 'RoughEdge', 'SoftRidge', 'Ring', 'PointPath', 'PointPerimeter', 'SharpCorner']);
                    return !hiddenBrushes.has(brush);
                  }
                  return true;
                })
                .map((brush) => {
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
            {totalMinima > 0 && (
              <div
                className="flex flex-col gap-1 p-2 rounded-lg border text-center text-xs mt-1"
                style={{
                  background: 'var(--surface-2)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <div
                  className="font-bold uppercase tracking-wide text-[10px]"
                  style={{ color: 'var(--text-strong)' }}
                >
                  Minima
                </div>
                <div
                  className="text-[11px] flex justify-center gap-2"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <span>Unsupported <strong style={{ color: 'var(--accent)' }}>{unsupportedMinima}</strong></span>
                  <span>|</span>
                  <span>supported <strong style={{ color: 'var(--success, #10b981)' }}>{supportedMinima}</strong></span>
                  <span>|</span>
                  <span>Total <strong style={{ color: 'var(--text-strong)' }}>{totalMinima}</strong></span>
                </div>
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleScanMinima}
              className="w-full !text-[11px] py-1.5 flex items-center justify-center gap-1.5 mt-1 border"
              disabled={isScanning || !activeModelId}
              style={{
                borderColor: 'var(--accent, #4a90e2)',
                background: 'var(--surface-2)',
              }}
            >
              {isScanning ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--accent, #4a90e2)' }} />
                  <span className="font-bold">Scanning Minima Islands...</span>
                </>
              ) : (
                <>
                  <WandSparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent, #4a90e2)' }} />
                  <span className="font-bold">Scan for local minima islands</span>
                </>
              )}
            </Button>
          </div>

          {/* Geodesic Radius Slider (for Point and Manual Geodesic brushes) */}
          {(state.activeBrush === 'Point' || state.activeBrush === 'ManualCircle' || state.activeBrush === 'ManualSquare') && (
            <div
              className="flex flex-col gap-1.5 p-2.5 rounded-lg border text-xs"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="flex justify-between">
                <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Brush Radius
                </span>
                <span className="font-bold" style={{ color: 'var(--accent)' }}>
                  {state.brushRadiusMm.toFixed(1)} mm
                </span>
              </div>
              <input
                type="range"
                min="0.5"
                max="50.0"
                step="0.5"
                value={state.brushRadiusMm}
                onChange={(e) => supportPainterStore.setBrushRadiusMm(parseFloat(e.target.value))}
                className="w-full accent-accent cursor-pointer"
              />
            </div>
          )}

          {/* Marker Brush Controls */}
          {isMarkerActive && (
            <div
              className="flex flex-col gap-3 p-2.5 rounded-lg border text-xs text-left"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="font-bold uppercase tracking-wider text-[10px] text-gray-400 border-b pb-1">
                Marker Brush Settings
              </div>

              {/* Marker Radius */}
              {!isCustomMarker && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                      Marker Radius
                    </span>
                    {isEditingMarkerRadius ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0.1"
                        max="20"
                        className="w-20 px-1.5 py-0.5 rounded text-right font-bold text-xs"
                        style={{
                          background: 'var(--surface-1)',
                          borderColor: 'var(--border-subtle)',
                          color: 'var(--accent)',
                        }}
                        autoFocus
                        value={tempMarkerRadius}
                        onChange={(e) => setTempMarkerRadius(e.target.value)}
                        onBlur={() => {
                          const val = parseFloat(tempMarkerRadius);
                          if (!isNaN(val) && val >= 0.1 && val <= 20) {
                            supportPainterStore.setMarkerRadiusMm(val);
                          }
                          setIsEditingMarkerRadius(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = parseFloat(tempMarkerRadius);
                            if (!isNaN(val) && val >= 0.1 && val <= 20) {
                              supportPainterStore.setMarkerRadiusMm(val);
                            }
                            setIsEditingMarkerRadius(false);
                          } else if (e.key === 'Escape') {
                            setIsEditingMarkerRadius(false);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="font-bold cursor-pointer hover:underline"
                        style={{ color: 'var(--accent)' }}
                        title="Click to edit numerically"
                        onClick={() => {
                          setTempMarkerRadius(state.markerRadiusMm.toString());
                          setIsEditingMarkerRadius(true);
                        }}
                      >
                        {state.markerRadiusMm.toFixed(2)} mm
                      </span>
                    )}
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max={Math.max(6.0, state.markerRadiusMm)}
                    step="0.1"
                    value={state.markerRadiusMm}
                    onChange={(e) => supportPainterStore.setMarkerRadiusMm(parseFloat(e.target.value))}
                    className="w-full accent-accent cursor-pointer"
                  />
                </div>
              )}

              {/* Tip Shape */}
              {!isCustomMarker && (
                <div className="flex flex-col gap-1">
                  <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Tip Footprint Shape
                  </span>
                  <select
                    value={state.markerTipShape}
                    onChange={(e) => supportPainterStore.setMarkerTipShape(e.target.value as any)}
                    className="w-full text-[11px] px-2 py-1.5 rounded border outline-none font-medium cursor-pointer"
                    style={{
                      background: 'var(--surface-1)',
                      borderColor: 'var(--border-subtle)',
                      color: 'var(--text-strong)',
                    }}
                  >
                    <option value="circle">Circle Tip</option>
                    <option value="line">Line Tip (0.5mm width)</option>
                    <option value="rectangle">Rectangle Tip (2:1 aspect)</option>
                    <option value="square">Square Tip</option>
                    <option value="hexagon">Hexagon Tip</option>
                  </select>
                </div>
              )}

              {/* Visual Rotation Angle Gizmo (Dial) */}
              {((isCustomMarker ? activeCustomBrush.selection.markerTipShape : state.markerTipShape) !== 'circle') && (
                <div className="flex flex-col gap-2">
                  <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Tip Rotation Angle
                  </span>
                  <div className="flex items-center gap-4">
                    {/* SVG Rotation Gizmo Dial */}
                    <div className="relative w-12 h-12 flex-shrink-0">
                      <svg
                        className="w-full h-full cursor-pointer select-none"
                        viewBox="0 0 100 100"
                        onPointerDown={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const handlePointerMove = (moveEv: PointerEvent) => {
                             const cx = rect.left + rect.width / 2;
                             const cy = rect.top + rect.height / 2;
                             const dx = moveEv.clientX - cx;
                             const dy = moveEv.clientY - cy;
                             let angleRad = Math.atan2(dy, dx);
                             // Convert to 0-360 degrees
                             let angleDeg = Math.round((angleRad * 180) / Math.PI);
                             if (angleDeg < 0) angleDeg += 360;
                             
                             if (!isNaN(angleDeg)) {
                               if (isCustomMarker) {
                                 supportPainterStore.updateCustomBrush(activeCustomBrush.id, {
                                   selection: {
                                     ...activeCustomBrush.selection,
                                     markerTipRotationDeg: angleDeg,
                                   }
                                 });
                               } else {
                                 supportPainterStore.setMarkerTipRotationDeg(angleDeg);
                               }
                             }
                           };

                          handlePointerMove(e.nativeEvent);

                          const handlePointerUp = () => {
                            window.removeEventListener('pointermove', handlePointerMove);
                            window.removeEventListener('pointerup', handlePointerUp);
                          };

                          window.addEventListener('pointermove', handlePointerMove);
                          window.addEventListener('pointerup', handlePointerUp);
                        }}
                      >
                        {/* Outer track */}
                        <circle cx="50" cy="50" r="45" fill="var(--surface-1)" stroke="var(--border-subtle)" strokeWidth="4" />
                        {/* Selected angle radius line indicator */}
                        {(() => {
                          const angleRaw = isCustomMarker ? (activeCustomBrush.selection.markerTipRotationDeg ?? 0) : state.markerTipRotationDeg;
                          const angle = isNaN(angleRaw) ? 0 : angleRaw;
                          const angleRad = (angle * Math.PI) / 180;
                          const tx = 50 + 40 * Math.cos(angleRad);
                          const ty = 50 + 40 * Math.sin(angleRad);
                          return (
                            <>
                              <line x1="50" y1="50" x2={tx} y2={ty} stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" />
                              <circle cx={tx} cy={ty} r="8" fill="#fff" stroke="var(--accent)" strokeWidth="2" />
                            </>
                          );
                        })()}
                        {/* Center hub */}
                        <circle cx="50" cy="50" r="6" fill="var(--text-muted)" />
                      </svg>
                    </div>

                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="360"
                        step="5"
                        value={(() => {
                          const val = isCustomMarker ? (activeCustomBrush.selection.markerTipRotationDeg ?? 0) : state.markerTipRotationDeg;
                          return isNaN(val) ? 0 : val;
                        })()}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val)) {
                            if (isCustomMarker) {
                              supportPainterStore.updateCustomBrush(activeCustomBrush.id, {
                                selection: {
                                  ...activeCustomBrush.selection,
                                  markerTipRotationDeg: val,
                                }
                              });
                            } else {
                              supportPainterStore.setMarkerTipRotationDeg(val);
                            }
                          }
                        }}
                        className="flex-1 accent-accent cursor-pointer"
                      />
                      <span className="font-bold min-w-[36px] text-right" style={{ color: 'var(--text-strong)' }}>
                        {(() => {
                          const val = isCustomMarker ? (activeCustomBrush.selection.markerTipRotationDeg ?? 0) : state.markerTipRotationDeg;
                          return isNaN(val) ? 0 : val;
                        })()}°
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Eraser Mode Toggle */}
              {!isCustomMarker && (
                <div className="flex items-center justify-between">
                  <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Eraser Mode
                  </span>
                  <input
                    type="checkbox"
                    checked={state.markerEraserMode}
                    onChange={(e) => supportPainterStore.setMarkerEraserMode(e.target.checked)}
                    className="w-4 h-4 cursor-pointer accent-accent"
                  />
                </div>
              )}

              {/* Collision Mode Strategy */}
              {!isCustomMarker && (
                <div className="flex flex-col gap-1">
                  <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Collision Paint Strategy
                  </span>
                  <select
                    value={state.markerCollisionMode}
                    onChange={(e) => supportPainterStore.setMarkerCollisionMode(e.target.value as any)}
                    className="w-full text-[11px] px-2 py-1.5 rounded border outline-none font-medium cursor-pointer"
                    style={{
                      background: 'var(--surface-1)',
                      borderColor: 'var(--border-subtle)',
                      color: 'var(--text-strong)',
                    }}
                  >
                    <option value="fence">Fence Mode (Blocked by other ROIs)</option>
                    <option value="push">Push / Erode Mode (Overwrites other ROIs)</option>
                    <option value="merge">Merge Mode (Unites adjacent ROIs)</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Point Path Brush Controls */}
          {state.activeBrush === 'PointPath' && (
            <div
              className="flex flex-col gap-3 p-2.5 rounded-lg border text-xs text-left"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="font-bold uppercase tracking-wider text-[10px] text-gray-400 border-b pb-1">
                Point Path settings
              </div>



              {/* Control Points counter and actions */}
              <div className="flex flex-col gap-2 border-t pt-2 mt-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex justify-between text-[11px] text-gray-400">
                  <span>Placed control points:</span>
                  <span className="font-bold text-white">{state.pointPathPoints.length}</span>
                </div>

                <div className="flex gap-1.5 mt-1">
                  <Button
                    className="flex-1 text-[11px] py-1 bg-red-600 hover:bg-red-700 text-white font-semibold"
                    disabled={state.pointPathPoints.length === 0}
                    onClick={() => supportPainterStore.clearPointPathPoints()}
                  >
                    Clear points
                  </Button>
                  <Button
                    className="flex-1 text-[11px] py-1 bg-green-600 hover:bg-green-700 text-white font-semibold"
                    disabled={state.pointPathPoints.length < 2}
                    onClick={() => {
                      const firstPt = state.pointPathPoints[0];
                      if (firstPt) {
                        const newId = supportPainterStore.commitPointPathRegion({
                          seedTriangleId: firstPt.faceIndex
                        });
                        const nextSnap = supportPainterStore.getSnapshot();
                        const addedRegion = nextSnap.regions.get(newId);
                        if (addedRegion) {
                          pushHistory({
                            type: PAINT_ROI_ADD,
                            description: 'Paint line path region of interest',
                            payload: { region: addedRegion },
                          });
                        }
                      }
                    }}
                  >
                    Commit path
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Point Perimeter Brush Controls */}
          {state.activeBrush === 'PointPerimeter' && (
            <div
              className="flex flex-col gap-3 p-2.5 rounded-lg border text-xs text-left"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="font-bold uppercase tracking-wider text-[10px] text-gray-400 border-b pb-1">
                Point Perimeter settings
              </div>



              {/* Control Points counter and actions */}
              <div className="flex flex-col gap-2 border-t pt-2 mt-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex justify-between text-[11px] text-gray-400">
                  <span>Placed control points:</span>
                  <span className="font-bold text-white">{state.pointPathPoints.length}</span>
                </div>

                <div className="flex gap-1.5 mt-1">
                  <Button
                    className="flex-1 text-[11px] py-1 bg-red-600 hover:bg-red-700 text-white font-semibold"
                    disabled={state.pointPathPoints.length === 0}
                    onClick={() => supportPainterStore.clearPointPathPoints()}
                  >
                    Clear points
                  </Button>
                  <Button
                    className="flex-1 text-[11px] py-1 bg-green-600 hover:bg-green-700 text-white font-semibold"
                    disabled={state.pointPathPoints.length < 3}
                    onClick={() => {
                      const firstPt = state.pointPathPoints[0];
                      if (firstPt) {
                        const activeMesh = supportPainterStore.getActiveMesh();
                        supportPainterStore.setPointPathClosed(true);
                        const newId = supportPainterStore.commitPointPathRegion({
                          seedTriangleId: firstPt.faceIndex,
                          brushType: 'PointPerimeter',
                          matrixWorld: activeMesh?.matrixWorld,
                        });
                        const nextSnap = supportPainterStore.getSnapshot();
                        const addedRegion = nextSnap.regions.get(newId);
                        if (addedRegion) {
                          pushHistory({
                            type: PAINT_ROI_ADD,
                            description: 'Paint point perimeter region',
                            payload: { region: addedRegion },
                          });
                        }
                      }
                    }}
                  >
                    Commit loop
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Sharp Corner Brush Controls */}
          {state.activeBrush === 'SharpCorner' && (
            <div
              className="flex flex-col gap-3 p-2.5 rounded-lg border text-xs text-left"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="font-bold uppercase tracking-wider text-[10px] text-gray-400 border-b pb-1">
                Sharp Corner settings
              </div>

              {/* Dihedral angle tolerance slider */}
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-center font-semibold text-text-strong">
                  <span>Dihedral angle threshold</span>
                  <span className="font-bold text-accent">
                    {state.sharpCornerDihedralThresholdDeg}°
                  </span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="90"
                  step="1"
                  value={state.sharpCornerDihedralThresholdDeg}
                  onChange={(e) => supportPainterStore.setSharpCornerDihedralThresholdDeg(parseInt(e.target.value))}
                  className="w-full accent-accent cursor-pointer"
                />
              </div>

              {/* Wrap curves toggle */}
              <div className="flex justify-between items-center mt-1 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Wrap curves
                </span>
                <input
                  type="checkbox"
                  checked={state.sharpCornerWrapCurves}
                  onChange={(e) => supportPainterStore.setSharpCornerWrapCurves(e.target.checked)}
                  className="w-4 h-4 accent-accent cursor-pointer"
                />
              </div>
            </div>
          )}

              {/* 4. Select Custom Brush */}
          {/* Custom Brushes Selection Section */}
          <div className="flex flex-col gap-2 border-t pt-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <div
              className="flex items-center gap-1 cursor-pointer select-none"
              onClick={() => setIsCustomBrushExpanded(!isCustomBrushExpanded)}
            >
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  setIsCustomBrushExpanded(!isCustomBrushExpanded);
                }}
                className="!p-0.5 animate-none"
                title={isCustomBrushExpanded ? "Collapse Custom Brushes" : "Expand Custom Brushes"}
              >
                {isCustomBrushExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </IconButton>
              <span
                className="text-[10px] uppercase tracking-wider font-bold"
                style={{ color: 'var(--text-muted)' }}
              >
                CUSTOM BRUSH
              </span>
            </div>
            {isCustomBrushExpanded && (
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
            )}
          </div>
          
          {/* Support Placement Script Selection Dropdown & Actions */}
          {(() => {
            const activeCustomBrush = state.activeCustomBrushId ? state.customBrushes.get(state.activeCustomBrushId) : undefined;
            const rawPipeline = state.activeBrushPipeline || (activeCustomBrush?.operations) || getDefaultPipeline(state.activeBrush);
            const currentPipeline = upgradePipeline(rawPipeline, state.activeBrush, defaultSpacing);
            
            // Find if current custom support operations matches any known placement script
            const activeScript = state.activePlacementScriptId ? state.placementScripts.get(state.activePlacementScriptId) : null;
            const isActiveScriptEquivalent = activeScript && arePipelinesEquivalent(
              upgradePipeline(activeScript.operations, state.activeBrush, defaultSpacing),
              currentPipeline
            );

            const matchedScript = isActiveScriptEquivalent ? activeScript : Array.from(state.placementScripts.values()).find(script => {
              const scriptOps = upgradePipeline(script.operations, state.activeBrush, defaultSpacing);
              return arePipelinesEquivalent(scriptOps, currentPipeline);
            });
            
            const handleSelectScript = (e: React.ChangeEvent<HTMLSelectElement>) => {
              const scriptId = e.target.value;
              if (scriptId === 'unsaved') return;
              const script = state.placementScripts.get(scriptId);
              if (script) {
                supportPainterStore.setActivePlacementScriptId(scriptId);
                supportPainterStore.setActiveBrushPipeline(JSON.parse(JSON.stringify(script.operations)));
              }
            };

            const handleSaveScript = () => {
              if (!isSavingScript) {
                setScriptNameInput('');
                setIsSavingScript(true);
                return;
              }

              const name = scriptNameInput.trim();
              if (!name) return;
              
              const existingCustom = Array.from(state.placementScripts.values()).find(
                s => s.name.toLowerCase() === name.toLowerCase() && !s.isBuiltIn
              );
              
              const scriptId = existingCustom ? existingCustom.id : `custom-script-${Date.now()}`;
              const newScript = {
                id: scriptId,
                name,
                operations: JSON.parse(JSON.stringify(currentPipeline)),
                isBuiltIn: false
              };
              
              supportPainterStore.addPlacementScript(newScript);
              supportPainterStore.setActivePlacementScriptId(scriptId);
              supportPainterStore.showToast([`Saved placement script "${name}"`]);
              setIsSavingScript(false);
            };

            const handleDeleteScript = () => {
              if (!matchedScript || matchedScript.isBuiltIn) return;
              if (confirm(`Are you sure you want to delete the placement script "${matchedScript.name}"?`)) {
                supportPainterStore.deletePlacementScript(matchedScript.id);
                supportPainterStore.showToast([`Deleted placement script "${matchedScript.name}"`]);
              }
            };

            const handleCancelSaveScript = () => {
              setIsSavingScript(false);
              setScriptNameInput('');
            };

            return (
              <div
                className="flex flex-col gap-2 p-2.5 rounded-lg border text-xs"
                style={{
                  background: 'var(--surface-2, #1a202c)',
                  borderColor: 'var(--border-subtle, #2d3748)',
                }}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="text-[10px] uppercase tracking-wider font-bold"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    SUPPORT PLACEMENT SCRIPT
                  </span>
                </div>
                <div className="flex items-center gap-1 w-full min-w-0">
                  {isSavingScript ? (
                    <input
                      type="text"
                      value={scriptNameInput}
                      onChange={(e) => setScriptNameInput(e.target.value)}
                      placeholder="Enter Support Script Name"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleSaveScript();
                        } else if (e.key === 'Escape') {
                          handleCancelSaveScript();
                        }
                      }}
                      className="flex-1 min-w-0 bg-surface-1 text-text-strong text-[11px] px-1.5 py-1 rounded border border-border-subtle outline-none"
                      style={{
                        background: 'var(--surface-1, #151a22)',
                        borderColor: 'var(--border-subtle, #2d3748)',
                        color: 'var(--text-strong, #f3f4f6)',
                      }}
                    />
                  ) : (
                    <select
                      value={matchedScript ? matchedScript.id : 'unsaved'}
                      onChange={handleSelectScript}
                      className="flex-1 min-w-0 bg-surface-1 text-text-strong text-[11px] px-1.5 py-1 rounded border border-border-subtle outline-none"
                      style={{
                        background: 'var(--surface-1, #151a22)',
                        borderColor: 'var(--border-subtle, #2d3748)',
                        color: 'var(--text-strong, #f3f4f6)',
                      }}
                    >
                      {!matchedScript && (
                        <option value="unsaved">(Unsaved)</option>
                      )}
                      {Array.from(state.placementScripts.values())
                        .filter(script => {
                          const isCenterlineOnlyBrush = state.activeBrush === 'PointPath' || state.activeBrush === 'SharpCorner';
                          const isScriptCenterline = script.id === 'default-centerline-detail' || script.operations.some(op => op.type === 'centerline' && op.enabled);
                          if (isCenterlineOnlyBrush) {
                            return isScriptCenterline;
                          } else {
                            return !isScriptCenterline || script.id !== 'default-centerline-detail';
                          }
                        })
                        .map(script => (
                          <option key={script.id} value={script.id}>
                            {script.name}
                          </option>
                        ))}
                    </select>
                  )}
                  
                  <IconButton
                    onClick={handleSaveScript}
                    disabled={isSavingScript && !scriptNameInput.trim()}
                    className="!p-1 hover:bg-black/20 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Save Placement Script"
                  >
                    <Save className="w-3.5 h-3.5" style={{ color: (isSavingScript && !scriptNameInput.trim()) ? 'var(--text-muted)' : 'var(--accent, #4a90e2)' }} />
                  </IconButton>

                  {isSavingScript ? (
                    <IconButton
                      onClick={handleCancelSaveScript}
                      className="!p-1 hover:bg-black/20"
                      title="Cancel Saving"
                    >
                      <X className="w-3.5 h-3.5" style={{ color: 'var(--text-muted, #718096)' }} />
                    </IconButton>
                  ) : (
                    <IconButton
                      onClick={handleDeleteScript}
                      disabled={!matchedScript || matchedScript.isBuiltIn}
                      className="!p-1 hover:bg-black/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={matchedScript?.isBuiltIn ? "Cannot delete built-in script" : "Delete Placement Script"}
                    >
                      <Trash className="w-3.5 h-3.5" style={{ color: (!matchedScript || matchedScript.isBuiltIn) ? 'var(--text-muted, #718096)' : 'var(--danger, #ef4444)' }} />
                    </IconButton>
                  )}
                </div>

                <div className="flex items-center gap-1 mt-1.5 w-full justify-between">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleImportConfigs}
                    className="!text-[9px] py-1 px-1.5 flex-1 flex items-center justify-center gap-0.5 hover:bg-black/10"
                    title="Import configurations pack"
                  >
                    <Download className="w-3 h-3 text-sky-400" />
                    <span>Import</span>
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleExportConfigs}
                    className="!text-[9px] py-1 px-1.5 flex-1 flex items-center justify-center gap-0.5 hover:bg-black/10"
                    title="Export custom configurations pack"
                  >
                    <Upload className="w-3 h-3 text-emerald-400" />
                    <span>Export</span>
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const activeCustomBrush = state.activeCustomBrushId ? state.customBrushes.get(state.activeCustomBrushId) : undefined;
                      const rawPipeline = state.activeBrushPipeline || (activeCustomBrush?.operations) || getDefaultPipeline(state.activeBrush);
                      const currentPipeline = upgradePipeline(rawPipeline, state.activeBrush, defaultSpacing);
                      setEditingPipeline(JSON.parse(JSON.stringify(currentPipeline)));
                      setEditingPlacementScriptId(matchedScript ? matchedScript.id : 'unsaved');
                      setPipelineEditingContext('active');
                    }}
                    className="!text-[9px] py-1 px-1.5 flex-1 flex items-center justify-center gap-0.5 hover:bg-black/10"
                    title="Edit current support placement sequence"
                  >
                    <Settings className="w-3 h-3 text-sky-400" style={{ color: 'var(--accent, #4a90e2)' }} />
                    <span>Edit Script</span>
                  </Button>
                </div>
              </div>
            );
          })()}



              {/* 6. Compact Direct Click-to-Generate Toggle */}
          {/* Direct Click-to-Generate Toggle */}
          <div
            className="flex items-center justify-between p-2 rounded-lg border text-xs"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <span className="font-semibold text-xs" style={{ color: 'var(--text-strong)' }}>
              Direct Click-to-Generate
            </span>
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

              {/* 7. Generate Supports Button */}
          {/* Generate Button */}
          <Button
            variant="accent"
            size="sm"
            className="w-full"
            disabled={pendingRegions.length === 0 || isGenerating}
            onClick={handleGenerate}
          >
            {isGenerating ? 'Generating…' : 'Generate Supports (' + pendingRegions.length + ')'}
          </Button>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 scrollbar-thin flex flex-col gap-3">
              {/* 1. Completed ROI History & Saves list */}
          {/* ROI History and Saves Rollup */}
          <div
            className="flex flex-col gap-1.5 border-t pt-2.5 text-left flex-1 min-h-0"
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
              {state.regions.size > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("Are you sure you want to delete all ROI regions and their supports?")) {
                      handleClearAllRegionsAndSupports();
                    }
                  }}
                  className="text-[10px] font-semibold transition-colors duration-150 py-0.5 px-1.5 rounded hover:bg-red-500/10"
                  style={{
                    color: 'var(--danger, #ef4444)',
                  }}
                >
                  Delete All
                </button>
              )}
            </div>

            {isHistoryExpanded && (
              <div className="flex flex-col gap-2.5 mt-1 flex-1 min-h-0">
                <div className="flex-1 min-h-[140px] max-h-[45vh] overflow-y-auto pr-1 flex flex-col gap-1.5 scrollbar-thin">
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
                      .map((region, index) => {
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

                        const isSelected = state.selectedRegionIds.has(region.id);

                        return (
                          <div
                            key={region.id}
                            className="flex flex-col p-2 rounded-lg border text-xs gap-1 transition-all duration-150"
                            onClick={(e) => handleListItemClick(e, region.id, index)}
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
                </div>
              </div>
            )}
          </div>

              {/* 2. Boolean Operators Action Bar */}
          {/* Boolean Operators Action Bar */}
          {activeSelectedIds.length >= 2 && (
            <div
              className="flex flex-col gap-2 p-2.5 rounded-lg border text-xs my-2.5"
              style={{
                background: 'var(--surface-3, #2a2b36)',
                borderColor: 'var(--accent, #ec4899)',
                boxShadow: '0 0 10px rgba(236, 72, 153, 0.25)',
              }}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-[10px] uppercase tracking-wider text-[#ec4899]">
                  Boolean Operators
                </span>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {activeSelectedIds.length} regions selected
                </span>
              </div>
              <div className="flex gap-2 justify-stretch">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    supportPainterStore.booleanOperate('union', activeSelectedIds[0], activeSelectedIds[1]);
                    supportPainterStore.setSelectedRegionIds(new Set());
                  }}
                  className="flex-1 py-1 rounded bg-[#ec4899] text-white font-bold hover:bg-[#db2777] transition-all text-center"
                  title="Merge regions (A ∪ B)"
                >
                  Union (∪)
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    supportPainterStore.booleanOperate('subtract', activeSelectedIds[0], activeSelectedIds[1]);
                    supportPainterStore.setSelectedRegionIds(new Set());
                  }}
                  className="flex-1 py-1 rounded text-white font-bold hover:bg-[#4b5563] border border-[#ec4899]/50 transition-all text-center"
                  style={{ background: 'var(--surface-2, #374151)' }}
                  title="Subtract B from A (A \ B)"
                >
                  Subtract (∖)
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    supportPainterStore.booleanOperate('intersect', activeSelectedIds[0], activeSelectedIds[1]);
                    supportPainterStore.setSelectedRegionIds(new Set());
                  }}
                  className="flex-1 py-1 rounded text-white font-bold hover:bg-[#4b5563] border border-[#ec4899]/50 transition-all text-center"
                  style={{ background: 'var(--surface-2, #374151)' }}
                  title="Intersect A and B (A ∩ B)"
                >
                  Intersect (∩)
                </button>
              </div>
            </div>
          )}

          {/* Selected ROI Actions */}
          {(() => {
            const selectedIds = Array.from(state.selectedRegionIds).filter(id => state.regions.has(id));
            const isSelectionActive = selectedIds.length >= 1;
            const isSingleSelection = selectedIds.length === 1;
            const firstSelectedRegion = isSelectionActive ? completedRegions.find(r => r.id === selectedIds[0]) : null;

            let totalChildSupports = 0;
            for (const id of selectedIds) {
              const regionTrunks = Object.values(supportState.trunks).filter(t => t.roiId === id);
              const regionBranches = Object.values(supportState.branches).filter(b => b.roiId === id);
              const regionLeaves = Object.values(supportState.leaves).filter(l => l.roiId === id);
              const regionTwigs = Object.values(supportState.twigs).filter(t => t.roiId === id);
              const regionSticks = Object.values(supportState.sticks).filter(s => s.roiId === id);
              const regionAnchors = Object.values(supportState.anchors).filter(a => a.roiId === id);
              totalChildSupports += regionTrunks.length + regionBranches.length + regionLeaves.length + regionTwigs.length + regionSticks.length + regionAnchors.length;
            }

            return (
              <div
                className="flex flex-col gap-2 border-t pt-2.5 text-left font-medium"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <span
                  className="text-[10px] uppercase tracking-wider font-bold"
                  style={{ color: 'var(--accent, #ec4899)' }}
                >
                  Selected ROI Actions {isSelectionActive && `(${selectedIds.length})`}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {/* Left Column */}
                  <div className="flex flex-col gap-1.5">
                    {/* Erase Supports */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => isSelectionActive && handleRemoveSupportsForRegions(selectedIds)}
                      className="w-full !text-[10px] py-1.5 flex items-center justify-start px-2 gap-1.5"
                      disabled={!isSelectionActive || totalChildSupports === 0}
                      style={{
                        opacity: (!isSelectionActive || totalChildSupports === 0) ? 0.4 : 1,
                        cursor: (!isSelectionActive || totalChildSupports === 0) ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Eraser className="w-3.5 h-3.5" style={{ color: (!isSelectionActive || totalChildSupports === 0) ? 'var(--text-muted)' : 'var(--warning, #f59e0b)' }} />
                      <span>Erase Supports</span>
                    </Button>
                    {/* Delete ROI Only */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (isSelectionActive) {
                          handleRemoveRoisOnly(selectedIds);
                          supportPainterStore.setSelectedRegionIds(new Set());
                        }
                      }}
                      className="w-full !text-[10px] py-1.5 flex items-center justify-start px-2 gap-1.5"
                      disabled={!isSelectionActive}
                      style={{
                        opacity: !isSelectionActive ? 0.4 : 1,
                        cursor: !isSelectionActive ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Trash className="w-3.5 h-3.5" style={{ color: !isSelectionActive ? 'var(--text-muted)' : 'var(--text-strong)' }} />
                      <span>Delete ROI Only</span>
                    </Button>
                    {/* Delete ROI & Supports */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (isSelectionActive) {
                          handleDeleteRegions(selectedIds);
                          supportPainterStore.setSelectedRegionIds(new Set());
                        }
                      }}
                      className="w-full !text-[10px] py-1.5 flex items-center justify-start px-2 gap-1.5"
                      disabled={!isSelectionActive}
                      style={{
                        opacity: !isSelectionActive ? 0.4 : 1,
                        cursor: !isSelectionActive ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" style={{ color: !isSelectionActive ? 'var(--text-muted)' : 'var(--danger, #ef4444)' }} />
                      <span>Delete ROI &amp; Supp.</span>
                    </Button>
                  </div>

                  {/* Right Column */}
                  <div className="flex flex-col gap-1.5">
                    {/* Edit ROI Supports */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (!isSelectionActive) return;
                        if (selectedIds.length === 1) {
                          const first = state.regions.get(selectedIds[0])!;
                          const rawPipeline = first.customBrush?.operations || getDefaultPipeline(first.brushType);
                          const currentPipeline = upgradePipeline(rawPipeline, first.brushType, defaultSpacing);
                          setEditingPipeline(JSON.parse(JSON.stringify(currentPipeline)));
                          setEditingPlacementScriptId(first.placementScriptId || 'unsaved');
                          setPipelineEditingContext('roi');
                        } else {
                          // Check for divergence
                          const first = state.regions.get(selectedIds[0])!;
                          const firstScriptId = first.placementScriptId || 'unsaved';
                          const firstPipeline = first.customBrush?.operations || getDefaultPipeline(first.brushType);
                          const firstPipelineUpgraded = upgradePipeline(firstPipeline, first.brushType, defaultSpacing);
                          
                          let divergent = false;
                          for (let i = 1; i < selectedIds.length; i++) {
                            const other = state.regions.get(selectedIds[i])!;
                            const otherScriptId = other.placementScriptId || 'unsaved';
                            const otherPipeline = other.customBrush?.operations || getDefaultPipeline(other.brushType);
                            const otherPipelineUpgraded = upgradePipeline(otherPipeline, other.brushType, defaultSpacing);
                            if (otherScriptId !== firstScriptId || !arePipelinesEquivalent(firstPipelineUpgraded, otherPipelineUpgraded)) {
                              divergent = true;
                              break;
                            }
                          }
                          
                          if (divergent) {
                            setShowDivergentModal(true);
                          } else {
                            setEditingPipeline(JSON.parse(JSON.stringify(firstPipelineUpgraded)));
                            setEditingPlacementScriptId(firstScriptId);
                            setPipelineEditingContext('roi');
                          }
                        }
                      }}
                      className="w-full !text-[10px] py-1.5 flex items-center justify-start px-2 gap-1.5"
                      disabled={!isSelectionActive}
                      title="Edit ROI Supports"
                      style={{
                        opacity: !isSelectionActive ? 0.4 : 1,
                        cursor: !isSelectionActive ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Settings className="w-3.5 h-3.5" style={{ color: !isSelectionActive ? 'var(--text-muted)' : 'var(--accent)' }} />
                      <span>Edit ROI Supports</span>
                    </Button>
                    {/* Recalculate ROI Supports */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        if (isSelectionActive) {
                          await handleRecalculateRegions(selectedIds);
                        }
                      }}
                      className="w-full !text-[10px] py-1.5 flex items-center justify-start px-2 gap-1.5"
                      disabled={!isSelectionActive}
                      style={{
                        opacity: !isSelectionActive ? 0.4 : 1,
                        cursor: !isSelectionActive ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <RefreshCw className="w-3.5 h-3.5 animate-none" style={{ color: !isSelectionActive ? 'var(--text-muted)' : 'var(--accent)' }} />
                      <span>Recalculate ROI</span>
                    </Button>
                    {/* Recalculate All Supports */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        const activeMesh = supportPainterStore.getActiveMesh();
                        if (activeModelId && activeMesh && completedRegions.length > 0) {
                          const allIds = completedRegions.map(r => r.id);
                          await handleRecalculateRegions(allIds);
                        }
                      }}
                      className="w-full !text-[10px] py-1.5 flex items-center justify-start px-2 gap-1.5"
                      disabled={completedRegions.length === 0}
                      style={{
                        opacity: completedRegions.length === 0 ? 0.4 : 1,
                        cursor: completedRegions.length === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <RefreshCw className="w-3.5 h-3.5" style={{ color: completedRegions.length === 0 ? 'var(--text-muted)' : 'var(--text-strong)' }} />
                      <span>Recalculate All</span>
                    </Button>
                  </div>
                </div>

                {isSingleSelection && firstSelectedRegion && (
                  <div
                    className="flex flex-col gap-1 p-2 rounded-lg border text-xs mt-2"
                    style={{
                      background: 'var(--surface-2, #1a202c)',
                      borderColor: 'var(--border-subtle, #2d3748)',
                    }}
                  >
                    <span className="font-semibold text-[10px] text-gray-300">
                      ROI Placement Script
                    </span>
                    {(() => {
                      const matchedScriptId = firstSelectedRegion.placementScriptId || 'unsaved';
                      const matchedScript = state.placementScripts.get(matchedScriptId);

                      const handleSelectRoiScript = (e: React.ChangeEvent<HTMLSelectElement>) => {
                        const scriptId = e.target.value;
                        if (scriptId === 'unsaved') {
                          supportPainterStore.updateRegionCustomBrush(firstSelectedRegion.id, firstSelectedRegion.customBrush?.operations || [], 'unsaved');
                          return;
                        }
                        const script = state.placementScripts.get(scriptId);
                        if (script) {
                          supportPainterStore.updateRegionCustomBrush(firstSelectedRegion.id, JSON.parse(JSON.stringify(script.operations)), scriptId);
                          const activeMesh = supportPainterStore.getActiveMesh();
                          if (activeModelId && activeMesh) {
                            void regenerateSupportsForRoi(activeModelId, activeMesh, firstSelectedRegion.id);
                          }
                        }
                      };

                      return (
                        <select
                          value={matchedScriptId}
                          onChange={handleSelectRoiScript}
                          className="w-full bg-surface-1 text-text-strong text-[11px] px-2 py-1.5 rounded border border-border-subtle outline-none mt-1 cursor-pointer"
                          style={{
                            background: 'var(--surface-1, #151a22)',
                            borderColor: 'var(--border-subtle, #2d3748)',
                            color: 'var(--text-strong, #f3f4f6)',
                          }}
                        >
                          {matchedScriptId === 'unsaved' && (
                            <option value="unsaved">(Unsaved Placement Script)</option>
                          )}
                          {Array.from(state.placementScripts.values()).map(script => (
                            <option key={script.id} value={script.id}>
                                {script.name}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })()}

              {/* 4. Storage & Maintenance Tools rollup */}
          {/* Storage & Maintenance Rollup Collapsible */}
          <div
            className="flex flex-col gap-2 border-t pt-2.5 text-left font-medium"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => setIsMaintenanceExpanded(!isMaintenanceExpanded)}
            >
              <div className="flex items-center gap-1">
                <IconButton
                  className="!p-0.5 animate-none"
                  title={isMaintenanceExpanded ? "Collapse Utilities" : "Expand Utilities"}
                >
                  {isMaintenanceExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                </IconButton>
                <span
                  className="text-[10px] uppercase tracking-wider font-bold"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Storage &amp; Maintenance Tools
                </span>
              </div>
            </div>

            {isMaintenanceExpanded && (
              <div className="flex flex-col gap-2.5 mt-1">
                {/* ROI Storage Mode Dropdown */}
                <div
                  className="flex flex-col gap-1.5 p-2 rounded-lg border text-xs"
                  style={{
                    background: 'var(--surface-2)',
                    borderColor: 'var(--border-subtle)',
                  }}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-xs" style={{ color: 'var(--text-strong)' }}>
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

                {/* Strip ROI Buttons */}
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
              </div>
            )}
          </div>

          {/* Placement Diagnostics Walker Collapsible */}
          {state.failedCandidates.length > 0 && (
            <div
              className="flex flex-col gap-2 border-t pt-2.5 text-left font-medium"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <div
                className="flex items-center justify-between cursor-pointer select-none"
                onClick={() => setIsDiagnosticsExpanded(!isDiagnosticsExpanded)}
              >
                <div className="flex items-center gap-1">
                  <IconButton
                    className="!p-0.5 animate-none"
                    title={isDiagnosticsExpanded ? "Collapse Diagnostics" : "Expand Diagnostics"}
                  >
                    {isDiagnosticsExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                  </IconButton>
                  <span
                    className="text-[10px] uppercase tracking-wider font-bold"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Placement Diagnostics ({state.failedCandidates.length})
                  </span>
                </div>
              </div>

              {isDiagnosticsExpanded && (
                <div className="flex flex-col gap-2.5 mt-1">
                  {(() => {
                    const activeIndex = state.activeFailureIndex ?? 0;
                    const activeCandidate = state.failedCandidates[activeIndex];
                    if (!activeCandidate) return null;
                    
                    const formatCoord = (val: number) => val.toFixed(2);
                    const stageLabel = activeCandidate.stage.charAt(0).toUpperCase() + activeCandidate.stage.slice(1);

                    return (
                      <div
                        className="flex flex-col gap-1.5 p-2 rounded-lg border text-xs"
                        style={{
                          background: 'var(--surface-2, #1a202c)',
                          borderColor: 'var(--border-subtle, #2d3748)',
                        }}
                      >
                        <div className="flex justify-between items-center font-bold">
                          <span style={{ color: 'var(--text-strong)' }}>
                            Failure {activeIndex + 1} of {state.failedCandidates.length}
                          </span>
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider"
                            style={{
                              background: 'rgba(239, 68, 68, 0.15)',
                              color: 'var(--danger, #ef4444)',
                            }}
                          >
                            {stageLabel}
                          </span>
                        </div>

                        <div className="flex flex-col gap-1 font-medium text-[11px] leading-relaxed mt-0.5" style={{ color: 'var(--text-strong)' }}>
                          <div>
                            <span style={{ color: 'var(--text-muted)' }}>Reason:</span>{' '}
                            <span className="font-semibold" style={{ color: 'var(--danger, #ef4444)' }}>
                              {activeCandidate.reason}
                            </span>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-muted)' }}>Coordinate:</span>{' '}
                            <span className="font-mono text-[10px]">
                              [{formatCoord(activeCandidate.pos.x)}, {formatCoord(activeCandidate.pos.y)}, {formatCoord(activeCandidate.pos.z)}]
                            </span>
                          </div>
                        </div>

                        {/* Prev / Next / Clear actions */}
                        <div className="flex items-center gap-1.5 mt-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => supportPainterStore.goToPrevFailure()}
                            className="flex-1 !text-[10px] py-1"
                          >
                            Prev
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => supportPainterStore.goToNextFailure()}
                            className="flex-1 !text-[10px] py-1"
                          >
                            Next
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => supportPainterStore.clearFailedCandidates()}
                            className="flex-1 !text-[10px] py-1 hover:!bg-red-500/10"
                            style={{ color: 'var(--danger, #ef4444)' }}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
            </div>
          )}
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

      {pipelineEditingContext !== null && (
        <SupportPipelineEditor
          initialPipeline={editingPipeline}
          comparisonPipeline={getComparisonPipeline(pipelineEditingContext, state.selectedRegionId)}
          onChange={setEditingPipeline}
          onClose={() => setPipelineEditingContext(null)}
          placementScriptId={editingPlacementScriptId}
          onPlacementScriptIdChange={setEditingPlacementScriptId}
          onSave={async () => {
            if (pipelineEditingContext === 'active') {
              supportPainterStore.setActiveBrushPipeline(editingPipeline);
              if (editingPlacementScriptId) {
                supportPainterStore.setActivePlacementScriptId(editingPlacementScriptId);
              }
            } else if (pipelineEditingContext === 'roi') {
              const selectedIds = Array.from(state.selectedRegionIds).filter(id => state.regions.has(id));
              if (selectedIds.length > 1) {
                // Batch update of the placement script and pipeline operations
                beginSupportStateBatch();
                try {
                  for (const regionId of selectedIds) {
                    supportPainterStore.updateRegionCustomBrush(regionId, editingPipeline, editingPlacementScriptId);
                  }
                } finally {
                  endSupportStateBatch();
                }
                const activeMesh = supportPainterStore.getActiveMesh();
                if (activeModelId && activeMesh) {
                  const targetRegions = selectedIds.map(id => state.regions.get(id)).filter(Boolean) as ROIRegion[];
                  setIsGenerating(true);
                  try {
                    // Purge supports for all targeted ROIs first in a single batch
                    const beforeState = getSupportsSnapshot();
                    let nextState = beforeState;
                    for (const id of selectedIds) {
                      nextState = deleteSupportsForRoi(nextState, id);
                    }
                    setSupportSnapshot(nextState);

                    await generateSupportsFromPainter(activeModelId, activeMesh, targetRegions);
                  } finally {
                    setIsGenerating(false);
                  }
                }
              } else {
                // Single ROI update
                const activeSelected = state.selectedRegionId ? state.regions.get(state.selectedRegionId) : null;
                if (activeSelected) {
                  supportPainterStore.updateRegionCustomBrush(activeSelected.id, editingPipeline, editingPlacementScriptId);
                  const activeMesh = supportPainterStore.getActiveMesh();
                  if (activeModelId && activeMesh) {
                    void regenerateSupportsForRoi(activeModelId, activeMesh, activeSelected.id);
                  }
                }
              }
            }
            setPipelineEditingContext(null);
          }}
          colorTheme={
            pipelineEditingContext === 'active'
              ? BRUSH_COLORS[state.activeBrush]
              : (state.selectedRegionId ? state.regions.get(state.selectedRegionId)?.color : undefined)
          }
        />
      )}
      {showDivergentModal && (
        <DivergentScriptWarningModal
          selectedRegions={activeSelectedIds.map(id => state.regions.get(id)).filter(Boolean) as ROIRegion[]}
          placementScripts={state.placementScripts}
          onClose={() => setShowDivergentModal(false)}
          onConfirm={() => {
            setShowDivergentModal(false);
            const first = state.regions.get(activeSelectedIds[0])!;
            const firstScriptId = first.placementScriptId || 'unsaved';
            const firstPipeline = first.customBrush?.operations || getDefaultPipeline(first.brushType);
            const firstPipelineUpgraded = upgradePipeline(firstPipeline, first.brushType, defaultSpacing);
            setEditingPipeline(JSON.parse(JSON.stringify(firstPipelineUpgraded)));
            setEditingPlacementScriptId(firstScriptId);
            setPipelineEditingContext('roi');
          }}
        />
      )}
      {state.conflictState && (
        <ImportConflictModal
          conflicts={state.conflictState.conflicts}
          onClose={() => supportPainterStore.cancelImportConflicts()}
          onResolve={(resolutions) => supportPainterStore.resolveImportConflicts(resolutions)}
        />
      )}
    </Card>
  );
}
