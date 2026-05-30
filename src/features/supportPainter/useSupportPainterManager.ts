import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { supportPainterStore, useSupportPainterState } from './supportPainterStore';
import { PAINT_ROI_ADD, PAINT_ROI_REMOVE, PAINT_ROI_STRIP } from './supportPainterHistoryTypes';
import { pushHistory, registerHistoryHandler } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { type ROIRegion } from './supportPainterTypes';
import { buildClientAdjacencyMap, proposeRegionOnClient } from './useClientAdjacencyMap';

/**
 * Pure Client-Side Headless coordinator for Support Painter mode.
 * Coordinates hover region proposals using local JS adjacency walks (zero Tauri/Rust IPC delay)
 * and drives instant highlights and commits.
 */
export function useSupportPainterManager(
  isActive: boolean,
  activeModelId: string | null = null,
  geometry: THREE.BufferGeometry | null = null,
  meshResolver?: () => THREE.Mesh | null
) {
  const {
    hoveredTriangleId,
    activeBrush,
    brushRadiusMm,
    activeCustomBrushId,
    customBrushes,
    markerRadiusMm,
    markerTipShape,
    markerTipRotationDeg,
    markerCollisionMode,
    pointPathPoints,
    pointPathWidthMm,
    pointPathMode,
    pointPathClosed,
  } = useSupportPainterState();
  const [initializedModelId, setInitializedModelId] = useState<string | null>(null);

  // 1. Register history undo/redo handlers for painting
  useEffect(() => {
    if (!isActive) return;

    const undoAdd = registerHistoryHandler(PAINT_ROI_ADD, (action, direction) => {
      const { region } = action.payload as { region: ROIRegion };
      if (direction === 'undo') {
        supportPainterStore.removeRegion(region.id);
      } else {
        const currentRegions = new Map(supportPainterStore.getSnapshot().regions);
        currentRegions.set(region.id, region);
        supportPainterStore.restoreRegions(currentRegions);
      }
    });

    const undoRemove = registerHistoryHandler(PAINT_ROI_REMOVE, (action, direction) => {
      const { region } = action.payload as { region: ROIRegion };
      if (direction === 'undo') {
        const currentRegions = new Map(supportPainterStore.getSnapshot().regions);
        currentRegions.set(region.id, region);
        supportPainterStore.restoreRegions(currentRegions);
      } else {
        supportPainterStore.removeRegion(region.id);
      }
    });

    const undoStrip = registerHistoryHandler(PAINT_ROI_STRIP, (action, direction) => {
      const { beforeRegions } = action.payload as { beforeRegions: Map<string, ROIRegion> };
      if (direction === 'undo') {
        supportPainterStore.restoreRegions(beforeRegions);
      } else {
        supportPainterStore.stripRoiData();
      }
    });

    const undoReplace = registerHistoryHandler(SUPPORT_EDIT_REPLACE, (action, direction) => {
      const payload = action.payload as {
        painterRegionsBefore?: Map<string, ROIRegion>;
        painterRegionsAfter?: Map<string, ROIRegion>;
      };
      if (!payload.painterRegionsBefore || !payload.painterRegionsAfter) return;
      if (direction === 'undo') {
        supportPainterStore.restoreRegions(payload.painterRegionsBefore);
      } else {
        supportPainterStore.restoreRegions(payload.painterRegionsAfter);
      }
    });

    return () => {
      undoAdd();
      undoRemove();
      undoStrip();
      undoReplace();
    };
  }, [isActive]);

  // 2. Track modifier key state and pointer up at window level
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const keys: { alt?: boolean; shift?: boolean } = {};
      if (e.key === 'Alt') keys.alt = true;
      if (e.key === 'Shift') keys.shift = true;

      if (Object.keys(keys).length > 0) {
        supportPainterStore.setModifierKeys(keys);
      }

      if (e.key === '[') {
        supportPainterStore.adjustBrushRadiusMm(-0.5);
      }
      if (e.key === ']') {
        supportPainterStore.adjustBrushRadiusMm(0.5);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const keys: { alt?: boolean; shift?: boolean } = {};
      if (e.key === 'Alt') keys.alt = false;
      if (e.key === 'Shift') keys.shift = false;

      if (Object.keys(keys).length > 0) {
        supportPainterStore.setModifierKeys(keys);
      }
    };

    const handlePointerUp = () => {
      supportPainterStore.setInteractionPhase('Idle');

      // Post-stroke connected-component orphan pruning
      const snapshot = supportPainterStore.getSnapshot();
      if (snapshot.selectedRegionId) {
        supportPainterStore.pruneOrphans(snapshot.selectedRegionId);
      }
    };

    const handleBlur = () => {
      supportPainterStore.setModifierKeys({ alt: false, shift: false });
      supportPainterStore.setInteractionPhase('Idle');
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerUp, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerUp, true);
      window.removeEventListener('blur', handleBlur);
      supportPainterStore.setModifierKeys({ alt: false, shift: false });
      supportPainterStore.setInteractionPhase('Idle');
    };
  }, [isActive]);

  // 3. Build & Cache the Client Adjacency Map locally (in LOCAL SPACE)
  useEffect(() => {
    if (!isActive || !activeModelId || !geometry) {
      supportPainterStore.setClientAdjacencyMap(null);
      setInitializedModelId(null);
      return;
    }

    const currentMap = supportPainterStore.getClientAdjacencyMap();
    if (currentMap && initializedModelId === activeModelId) {
      return;
    }

    try {
      console.log(`[SupportPainterManager] Indexing client-side face adjacency map (local space) for model ${activeModelId}`);
      const newMap = buildClientAdjacencyMap(geometry);
      
      supportPainterStore.setClientAdjacencyMap(newMap);
      setInitializedModelId(activeModelId);
      console.log(`[SupportPainterManager] Indexing complete! ${newMap.faceCount} faces cached in JavaScript.`);
    } catch (err) {
      console.error('[SupportPainterManager] Adjacency map construction failed', err);
      supportPainterStore.setClientAdjacencyMap(null);
      setInitializedModelId(null);
    }
  }, [isActive, activeModelId, geometry, initializedModelId]);

  // 4. Synchronous, Low-Latency Client-Side Region Proposal (runs in <1ms!)
  const activeCustomBrush = activeCustomBrushId ? customBrushes.get(activeCustomBrushId) : undefined;
  const customBrushParamsJson = activeCustomBrush ? JSON.stringify(activeCustomBrush.selection) : '';
  const pointPathPointsJson = JSON.stringify(pointPathPoints);

  useEffect(() => {
    const snap = supportPainterStore.getSnapshot();
    const activeCustomBrush = activeCustomBrushId ? customBrushes.get(activeCustomBrushId) : undefined;
    const activeBrushType = activeCustomBrush ? (activeCustomBrush.baseBrush || 'MacroFace') : activeBrush;
    const isPointPath = activeBrushType === 'PointPath';

    if (!isActive || !activeModelId || initializedModelId !== activeModelId) {
      return;
    }

    if (hoveredTriangleId === null && !isPointPath) {
      return;
    }

    const map = supportPainterStore.getClientAdjacencyMap();
    if (!map) {
      console.warn('[SupportPainterManager] Client adjacency map not available!');
      return;
    }

    try {
      // Resolve the live mesh and its up-to-date matrixWorld dynamically at hover time
      const mesh = meshResolver?.();
      const matrixWorld = mesh?.matrixWorld || new THREE.Matrix4();
      
      console.log(`[SupportPainterManager] Running proposal on seed: ${hoveredTriangleId}, active brush: ${activeBrush}, mesh resolved: ${!!mesh}`);
      
      const isCustomMarker = activeCustomBrush && activeCustomBrush.baseBrush === 'Marker';

      const radius = isCustomMarker
        ? (activeCustomBrush.selection.markerRadiusMm ?? 1.5)
        : snap.markerRadiusMm;

      const shape = isCustomMarker
        ? (activeCustomBrush.selection.markerTipShape ?? 'circle')
        : snap.markerTipShape;

      const rotation = isCustomMarker
        ? (activeCustomBrush.selection.markerTipRotationDeg ?? 0)
        : snap.markerTipRotationDeg;

      const collisionMode = isCustomMarker
        ? (activeCustomBrush.selection.markerCollisionMode ?? 'fence')
        : snap.markerCollisionMode;

      const markerParams = {
        radiusMm: radius,
        shape,
        rotationDeg: rotation,
        collisionMode,
      };

      const pointPathParams = {
        points: snap.pointPathPoints,
        widthMm: snap.pointPathWidthMm,
        mode: snap.pointPathMode,
        closed: snap.pointPathClosed,
      };

      const occupiedFaces = new Set<number>();
      for (const [id, reg] of snap.regions.entries()) {
        if (id === snap.selectedRegionId) continue;
        for (const tid of reg.triangleIds) {
          occupiedFaces.add(tid);
        }
      }

      // Execute the brush walk synchronously in JavaScript using the live transform
      const isCircleOrSquare = activeBrushType === 'Point' || activeBrushType === 'ManualCircle' || activeBrushType === 'ManualSquare';
      const effectiveRadius = isCircleOrSquare ? brushRadiusMm * 0.5 : brushRadiusMm;
      
      const proposedIds = proposeRegionOnClient(
        map,
        hoveredTriangleId ?? -1,
        activeBrushType,
        matrixWorld,
        activeBrushType === 'Marker' ? radius : effectiveRadius,
        activeCustomBrush,
        markerParams,
        occupiedFaces,
        pointPathParams
      );
      
      console.log(`[SupportPainterManager] Smart brush search returned ${proposedIds.length} triangles.`);
      supportPainterStore.setProposedTriangleIds(proposedIds);
    } catch (err) {
      console.error('[SupportPainterManager] Client proposal failed', err);
    }
  }, [
    isActive,
    activeModelId,
    hoveredTriangleId,
    activeBrush,
    initializedModelId,
    meshResolver,
    brushRadiusMm,
    activeCustomBrushId,
    customBrushParamsJson,
    markerRadiusMm,
    markerTipShape,
    markerTipRotationDeg,
    markerCollisionMode,
    pointPathPointsJson,
    pointPathWidthMm,
    pointPathMode,
    pointPathClosed,
  ]);
}
