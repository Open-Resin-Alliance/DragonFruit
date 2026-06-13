import { useEffect, useState, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { supportPainterStore, useSupportPainterState } from './supportPainterStore';
import { PAINT_ROI_ADD, PAINT_ROI_REMOVE, PAINT_ROI_STRIP } from './supportPainterHistoryTypes';
import { pushHistory, registerHistoryHandler } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { type ROIRegion, BRUSH_COLORS } from './supportPainterTypes';
import { buildClientAdjacencyMap, proposeRegionOnClient, walkSharpCorner } from './useClientAdjacencyMap';
import { getClipBounds } from '@/components/scene/SceneCanvas/clipBoundsStore';
import { deleteSupportsForRoi } from '@/supports/PlacementLogic/SupportModelLinker';
import { generateSupportsFromPainter } from '@/features/supportPainter/supportScriptingEngine';
import { getSnapshot as getSupportsSnapshot, setSnapshot as setSupportSnapshot } from '@/supports/state';
import { getShaftProfile } from '@/supports/Settings';

const getSnappedWorldPoint = (
  clickPoint: THREE.Vector3,
  faceIndex: number | undefined | null,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  size: { width: number; height: number },
  pointer: { x: number; y: number }
): THREE.Vector3 => {
  if (faceIndex === undefined || faceIndex === null) return clickPoint;
  const geom = mesh.geometry;
  const positionAttr = geom.getAttribute('position') as THREE.BufferAttribute;
  const indexAttr = geom.index;

  if (!positionAttr) return clickPoint;

  let i0 = faceIndex * 3;
  let i1 = faceIndex * 3 + 1;
  let i2 = faceIndex * 3 + 2;

  if (indexAttr) {
    i0 = indexAttr.getX(faceIndex * 3);
    i1 = indexAttr.getX(faceIndex * 3 + 1);
    i2 = indexAttr.getX(faceIndex * 3 + 2);
  }

  const v0 = new THREE.Vector3().fromBufferAttribute(positionAttr, i0).applyMatrix4(mesh.matrixWorld);
  const v1 = new THREE.Vector3().fromBufferAttribute(positionAttr, i1).applyMatrix4(mesh.matrixWorld);
  const v2 = new THREE.Vector3().fromBufferAttribute(positionAttr, i2).applyMatrix4(mesh.matrixWorld);

  const mouseX = ((pointer.x + 1) * size.width) / 2;
  const mouseY = (-(pointer.y - 1) * size.height) / 2;

  let bestPoint = clickPoint;
  let minDist = 12; // 12px snap radius

  const vertices = [v0, v1, v2];
  for (const v of vertices) {
    const proj = v.clone().project(camera);
    const projX = ((proj.x + 1) * size.width) / 2;
    const projY = (-(proj.y - 1) * size.height) / 2;
    const d = Math.sqrt((projX - mouseX) ** 2 + (projY - mouseY) ** 2);
    if (d < minDist) {
      minDist = d;
      bestPoint = v;
    }
  }

  return bestPoint;
};

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
        ? (activeCustomBrush.selection.markerCollisionMode ?? 'merge')
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

/**
 * 3D Viewport Event Interceptor Component.
 * Intercepts events in capture phase directly on the canvas element to prevent R3F propagation,
 * filters backfaces/clipping bounds, and drives state updates.
 */
export function SupportPainterInteractionController({
  activeModelId,
  geometry,
  meshResolver
}: {
  activeModelId: string | null;
  geometry: THREE.BufferGeometry | null;
  meshResolver: () => THREE.Mesh | null;
}) {
  const { camera, raycaster, gl, size } = useThree();
  const state = useSupportPainterState();
  const { isActive } = state;

  const lastHoveredFaceRef = useRef<number | null>(null);
  const lastHoveredPointRef = useRef<THREE.Vector3>(new THREE.Vector3());

  // Helper function for face validation (clipping and camera relative backface rejection)
  const getFirstValidIntersection = useCallback((
    intersections: THREE.Intersection[],
    rayDirection: THREE.Vector3,
    matrixWorld: THREE.Matrix4
  ): THREE.Intersection | null => {
    const { clipLower, clipUpper } = getClipBounds();
    for (const hit of intersections) {
      if (clipUpper != null && hit.point.z > clipUpper) continue;
      if (clipLower != null && hit.point.z < clipLower) continue;

      const normalLocal = hit.face?.normal;
      if (normalLocal) {
        const normalWorld = normalLocal.clone().applyNormalMatrix(
          new THREE.Matrix3().getNormalMatrix(matrixWorld)
        ).normalize();

        // Front-facing hits must point towards the camera (dot product < 0)
        if (normalWorld.dot(rayDirection) < 0) {
          return hit;
        }
      }
    }
    return null;
  }, []);

  // Frame loop for mouse hover detection
  useFrame(() => {
    if (!isActive || !activeModelId || state.modifierKeys.shift) {
      if (lastHoveredFaceRef.current !== null) {
        lastHoveredFaceRef.current = null;
        supportPainterStore.setHoveredTriangle(null);
      }
      return;
    }

    const mesh = meshResolver?.();
    if (!mesh) return;

    const intersections = raycaster.intersectObject(mesh);
    const validHit = getFirstValidIntersection(intersections, raycaster.ray.direction, mesh.matrixWorld);

    if (validHit && typeof validHit.faceIndex === 'number') {
      const faceIndex = validHit.faceIndex;
      const hitPoint = validHit.point;

      const faceChanged = faceIndex !== lastHoveredFaceRef.current;
      const distSq = hitPoint.distanceToSquared(lastHoveredPointRef.current);
      const movedEnough = distSq > 0.0025; // 0.05mm squared threshold

      if (faceChanged || movedEnough) {
        lastHoveredFaceRef.current = faceIndex;
        lastHoveredPointRef.current.copy(hitPoint);
        supportPainterStore.setHoveredTriangle(faceIndex, [hitPoint.x, hitPoint.y, hitPoint.z]);

        // Drag-to-paint / Drag-to-erase
        const snap = supportPainterStore.getSnapshot();
        const isDragging = (snap.interactionPhase === 'Expand' || snap.interactionPhase === 'Subtract');
        
        if (isDragging && snap.activeBrush !== 'PointPath' && snap.activeBrush !== 'PointPerimeter' && snap.activeBrush !== 'SharpCorner') {
          const map = supportPainterStore.getClientAdjacencyMap();
          if (map) {
            const activeCustomBrush = snap.activeCustomBrushId ? snap.customBrushes.get(snap.activeCustomBrushId) : undefined;
            const activeBrushType = activeCustomBrush ? (activeCustomBrush.baseBrush || 'MacroFace') : snap.activeBrush;

            const isCustomMarker = activeCustomBrush && activeCustomBrush.baseBrush === 'Marker';
            const radius = isCustomMarker ? (activeCustomBrush.selection.markerRadiusMm ?? 1.5) : snap.markerRadiusMm;
            const shape = isCustomMarker ? (activeCustomBrush.selection.markerTipShape ?? 'circle') : snap.markerTipShape;
            const rotation = isCustomMarker ? (activeCustomBrush.selection.markerTipRotationDeg ?? 0) : snap.markerTipRotationDeg;
            const collisionMode = isCustomMarker ? (activeCustomBrush.selection.markerCollisionMode ?? 'fence') : snap.markerCollisionMode;
            const eraserMode = activeCustomBrush ? activeCustomBrush.selection.markerEraserMode : snap.markerEraserMode;

            const markerParams = { radiusMm: radius, shape, rotationDeg: rotation, collisionMode };
            const occupiedFaces = new Set<number>();
            for (const [id, reg] of snap.regions.entries()) {
              if (id === snap.selectedRegionId) continue;
              for (const tid of reg.triangleIds) {
                occupiedFaces.add(tid);
              }
            }

            const isCircleOrSquare = activeBrushType === 'Point' || activeBrushType === 'ManualCircle' || activeBrushType === 'ManualSquare';
            const effectiveRadius = isCircleOrSquare ? snap.brushRadiusMm * 0.5 : snap.brushRadiusMm;

            const proposedIds = proposeRegionOnClient(
              map,
              faceIndex,
              activeBrushType,
              mesh.matrixWorld,
              activeBrushType === 'Marker' ? radius : effectiveRadius,
              activeCustomBrush,
              markerParams,
              occupiedFaces
            );

            if (proposedIds.length > 0) {
              const isMarker = activeBrushType === 'Marker';
              const isSubtract = snap.modifierKeys.alt || (isMarker && eraserMode) || (snap.interactionPhase === 'Subtract');
              if (isSubtract) {
                supportPainterStore.subtractTrianglesFromRegions(proposedIds);
              } else if (snap.selectedRegionId) {
                supportPainterStore.appendTrianglesToRegion(snap.selectedRegionId, proposedIds);
              }
            }
          }
        }
      }
    } else {
      if (lastHoveredFaceRef.current !== null) {
        lastHoveredFaceRef.current = null;
        supportPainterStore.setHoveredTriangle(null);
      }
    }
  });

  // Capture-phase pointer listeners registration on the canvas element
  useEffect(() => {
    if (!isActive || !activeModelId) return;

    const canvas = gl.domElement;

    const handlePointerDownCapture = (e: PointerEvent) => {
      if (e.button !== 0) return; // Left-click only
      if (e.shiftKey) return; // Shift key passes through to standard support placement

      const mesh = meshResolver?.();
      if (!mesh) return;

      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );

      const tempRaycaster = new THREE.Raycaster();
      tempRaycaster.setFromCamera(mouse, camera);

      const intersections = tempRaycaster.intersectObject(mesh);
      const validHit = getFirstValidIntersection(intersections, tempRaycaster.ray.direction, mesh.matrixWorld);

      if (validHit && typeof validHit.faceIndex === 'number') {
        // Intercept interaction completely!
        e.stopPropagation();
        e.preventDefault();

        const faceIndex = validHit.faceIndex;
        const hitPoint = validHit.point.clone();
        const snap = supportPainterStore.getSnapshot();

        if (e.ctrlKey || e.metaKey) {
          // Region selection logic
          let targetRegionId: string | null = null;
          for (const [id, region] of snap.regions.entries()) {
            if (region.triangleIds.has(faceIndex)) {
              targetRegionId = id;
              break;
            }
          }
          const nextSelection = new Set(snap.selectedRegionIds);
          if (targetRegionId) {
            if (e.shiftKey) {
              nextSelection.add(targetRegionId);
              supportPainterStore.setSelectedRegionIds(nextSelection);
            } else if (e.altKey) {
              nextSelection.delete(targetRegionId);
              supportPainterStore.setSelectedRegionIds(nextSelection);
            } else {
              supportPainterStore.setSelectedRegionId(targetRegionId);
            }
          } else {
            supportPainterStore.setSelectedRegionIds(new Set());
          }
          return;
        }

        if (snap.activeBrush === 'PointPath' || snap.activeBrush === 'PointPerimeter') {
          const snappedWorldPoint = getSnappedWorldPoint(
            hitPoint,
            faceIndex,
            mesh,
            camera,
            size,
            mouse
          );

          const invMatrixWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
          const localPoint = snappedWorldPoint.clone().applyMatrix4(invMatrixWorld);

          // Close loop detection (PointPerimeter snap to first point)
          if (snap.activeBrush === 'PointPerimeter' && snap.pointPathPoints.length >= 3) {
            const firstLocalPos = new THREE.Vector3(...snap.pointPathPoints[0].point);
            const firstWorldPos = firstLocalPos.clone().applyMatrix4(mesh.matrixWorld);
            const proj = firstWorldPos.clone().project(camera);
            const projX = ((proj.x + 1) * size.width) / 2;
            const projY = (-(proj.y - 1) * size.height) / 2;

            const mouseX = ((mouse.x + 1) * size.width) / 2;
            const mouseY = (-(mouse.y - 1) * size.height) / 2;
            const distPx = Math.sqrt((projX - mouseX) ** 2 + (projY - mouseY) ** 2);

            if (distPx < 15) {
              supportPainterStore.setPointPathClosed(true);
              const newId = supportPainterStore.commitPointPathRegion({
                seedTriangleId: snap.pointPathPoints[0].faceIndex,
                brushType: 'PointPerimeter',
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
              return;
            }
          }

          const normal = validHit.face?.normal
            ? [validHit.face.normal.x, validHit.face.normal.y, validHit.face.normal.z] as [number, number, number]
            : undefined;
          supportPainterStore.addPointPathPoint([localPoint.x, localPoint.y, localPoint.z], faceIndex, normal);
          return;
        }

        if (snap.activeBrush === 'SharpCorner') {
          const map = supportPainterStore.getClientAdjacencyMap();
          if (map) {
            const snappedWorldPoint = getSnappedWorldPoint(
              hitPoint,
              faceIndex,
              mesh,
              camera,
              size,
              mouse
            );

            const walkedPath = walkSharpCorner(
              map,
              mesh.geometry,
              faceIndex,
              snappedWorldPoint,
              mesh.matrixWorld,
              snap.sharpCornerDihedralThresholdDeg,
              snap.sharpCornerWrapCurves
            );

            if (walkedPath && walkedPath.length > 0) {
              supportPainterStore.clearPointPathPoints();
              for (const pt of walkedPath) {
                supportPainterStore.addPointPathPoint(pt.point, pt.faceIndex ?? faceIndex, pt.normal);
              }

              const newId = supportPainterStore.commitPointPathRegion({
                seedTriangleId: faceIndex,
                brushType: 'SharpCorner',
              });

              const nextSnap = supportPainterStore.getSnapshot();
              const addedRegion = nextSnap.regions.get(newId);
              if (addedRegion) {
                pushHistory({
                  type: PAINT_ROI_ADD,
                  description: 'Paint sharp corner region',
                  payload: { region: addedRegion },
                });
              }
            }
          }
          return;
        }

        if (snap.modifierKeys.alt) {
          supportPainterStore.setInteractionPhase('Subtract');
          const deletedId = supportPainterStore.removeRegionContainingTriangle(faceIndex);
          if (deletedId) {
            const deletedRegion = snap.regions.get(deletedId);
            if (deletedRegion) {
              const beforeState = getSupportsSnapshot();
              const nextState = deleteSupportsForRoi(beforeState, deletedId);
              const beforeRegions = new Map(snap.regions);
              const nextRegions = new Map(beforeRegions);
              nextRegions.delete(deletedId);

              setSupportSnapshot(nextState);
              supportPainterStore.restoreRegions(nextRegions);

              pushHistory({
                type: SUPPORT_EDIT_REPLACE,
                description: 'Subtract painted region and supports',
                payload: {
                  before: beforeState,
                  after: nextState,
                  painterRegionsBefore: beforeRegions,
                  painterRegionsAfter: nextRegions,
                },
              });
            }
          }
        } else if (snap.directGenEnabled) {
          const triangleIds = snap.proposedTriangleIds.size > 0
            ? new Set(snap.proposedTriangleIds)
            : new Set([faceIndex]);

          const activeCustomBrush = snap.activeCustomBrushId ? snap.customBrushes.get(snap.activeCustomBrushId) : undefined;
          const color = activeCustomBrush ? activeCustomBrush.color : BRUSH_COLORS[snap.activeBrush];

          let customBrushOverride = activeCustomBrush ? { ...activeCustomBrush } : undefined;
          if (snap.activeBrushPipeline) {
            customBrushOverride = {
              id: `temp-pipeline-${Date.now()}`,
              name: `Temp ${activeCustomBrush ? activeCustomBrush.name : snap.activeBrush} Config`,
              color,
              baseBrush: activeCustomBrush ? activeCustomBrush.baseBrush : snap.activeBrush,
              selection: activeCustomBrush ? { ...activeCustomBrush.selection } : {
                normalConeAngleMinDeg: 0,
                normalConeAngleMaxDeg: 90,
                overhangSlopeMinDeg: 0,
                overhangSlopeMaxDeg: 90,
                curvatureMin: 0,
                curvatureMax: 1,
                dihedralAngleToleranceDeg: 0,
              },
              operations: [...snap.activeBrushPipeline],
            };
          }

          const mockRegion: ROIRegion = {
            id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
            brushType: snap.activeBrush,
            seedTriangleId: faceIndex,
            triangleIds,
            color,
            proposedOnly: false,
            createdAt: Date.now(),
            customBrush: customBrushOverride,
          };

          generateSupportsFromPainter(activeModelId || 'active-model', mesh, [mockRegion])
            .catch((err) => console.error('[useSupportPainterManager] Direct generation failed', err));

          supportPainterStore.setHoveredTriangle(null);
          supportPainterStore.setProposedTriangleIds([]);
        } else {
          supportPainterStore.setInteractionPhase('Expand');
          const newId = supportPainterStore.commitRegion({
            seedTriangleId: faceIndex,
            brushType: snap.activeBrush,
          });
          const nextSnap = supportPainterStore.getSnapshot();
          const addedRegion = nextSnap.regions.get(newId);
          if (addedRegion) {
            pushHistory({
              type: PAINT_ROI_ADD,
              description: 'Paint region of interest',
              payload: { region: addedRegion },
            });
          }
        }
      }
    };

    const handlePointerMoveCapture = (e: PointerEvent) => {
      if (e.shiftKey) return;

      const mesh = meshResolver?.();
      if (!mesh) return;

      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );

      const tempRaycaster = new THREE.Raycaster();
      tempRaycaster.setFromCamera(mouse, camera);

      const intersections = tempRaycaster.intersectObject(mesh);
      const validHit = getFirstValidIntersection(intersections, tempRaycaster.ray.direction, mesh.matrixWorld);

      if (validHit && typeof validHit.faceIndex === 'number') {
        // Prevent event from bubbling to R3F's canvas event system
        e.stopPropagation();
      }
    };

    canvas.addEventListener('pointerdown', handlePointerDownCapture, { capture: true });
    canvas.addEventListener('pointermove', handlePointerMoveCapture, { capture: true });

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDownCapture, { capture: true });
      canvas.removeEventListener('pointermove', handlePointerMoveCapture, { capture: true });
    };
  }, [isActive, activeModelId, camera, gl.domElement, size, meshResolver, getFirstValidIntersection]);

  return null;
}
