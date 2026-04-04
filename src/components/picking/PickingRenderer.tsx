/**
 * GPU Picking System - Offscreen Renderer
 * 
 * Performs the actual GPU picking by rendering pickable objects to a tiny
 * offscreen buffer with unique color IDs, then reading back the pixel data.
 */

"use client";

import { useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { RENDER_TARGET, TIMING } from './constants';
import { majorityVote, encodePickId } from './pickingUtils';
import { reportPickingRenderSample } from './pickingDiagnostics';
import type { PickableRegistration, PickingConfig } from './types';

interface PickingRendererProps {
  /** Map of pick IDs to their registrations */
  registrations: Map<number, PickableRegistration>;
  /** Current configuration */
  config: PickingConfig;
  /** Whether picking is paused */
  isPaused: boolean;
  /** Whether a drag is in progress */
  isDragging: boolean;
  /** Callback when a new pick result is available */
  onPick: (pickId: number, screenX: number, screenY: number) => void;
  /** Current mouse position in normalized device coordinates (-1 to 1) */
  mouseNDC: React.MutableRefObject<{ x: number; y: number } | null>;
}

function shouldExcludeFromPickClone(object: THREE.Object3D): boolean {
  return object.userData?.excludeFromPickingClone === true;
}

/**
 * PickingRenderer - Handles the offscreen render pass for GPU picking.
 * 
 * This component:
 * 1. Creates a tiny render target (3x3 pixels)
 * 2. On each frame (throttled), renders all pickable objects with their pick colors
 * 3. Reads back the pixels and performs majority vote
 * 4. Reports the winning pick ID to the parent
 */
export function PickingRenderer({
  registrations,
  config,
  isPaused,
  isDragging,
  onPick,
  mouseNDC,
}: PickingRendererProps) {
  const { gl, scene, camera } = useThree();
  
  // Render target for picking (3x3 pixels)
  const renderTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  
  // Pixel buffer for reading back
  const pixelBufferRef = useRef<Uint8Array>(new Uint8Array(RENDER_TARGET.SIZE * RENDER_TARGET.SIZE * 4));
  
  // Picking scene (separate from main scene)
  const pickSceneRef = useRef<THREE.Scene>(new THREE.Scene());

  // Cached pick objects keyed by pick ID (avoids per-pick cloning)
  const pickObjectCacheRef = useRef<Map<number, { sourceObject: THREE.Object3D; pickObject: THREE.Object3D }>>(new Map());
  
  // Picking camera (will be synced with main camera)
  const pickCameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  
  // Material cache to avoid recreating materials
  const materialCacheRef = useRef<Map<number, THREE.MeshBasicMaterial>>(new Map());
  
  // Timing control
  const lastPickTimeRef = useRef<number>(0);
  const previousWinnerRef = useRef<number>(0);
  const lastPointerMoveTimeRef = useRef<number>(0);
  const previousMouseNdcRef = useRef<{ x: number; y: number } | null>(null);
  const previousCameraWorldMatrixRef = useRef<THREE.Matrix4>(new THREE.Matrix4());
  const previousProjectionMatrixRef = useRef<THREE.Matrix4>(new THREE.Matrix4());
  const smoothedFrameMsRef = useRef<number>(1000 / 60);

  const disposePickObject = useCallback((pickId: number) => {
    const cached = pickObjectCacheRef.current.get(pickId);
    if (!cached) return;

    pickSceneRef.current.remove(cached.pickObject);
    pickObjectCacheRef.current.delete(pickId);
  }, []);
  
  // Initialize render target
  useEffect(() => {
    renderTargetRef.current = new THREE.WebGLRenderTarget(
      RENDER_TARGET.SIZE,
      RENDER_TARGET.SIZE,
      {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        // No multisampling for picking
        samples: 0,
      }
    );
    
    // Set background to black (pick ID 0 = nothing)
    pickSceneRef.current.background = new THREE.Color(0x000000);
    
    return () => {
      renderTargetRef.current?.dispose();
      // Dispose all cached materials
      for (const material of materialCacheRef.current.values()) {
        material.dispose();
      }
      materialCacheRef.current.clear();
    };
  }, []);
  
  // Get or create a picking material for a pick ID
  const getPickingMaterial = useCallback((pickId: number, noDepthTest: boolean = false): THREE.MeshBasicMaterial => {
    const cacheKey = noDepthTest ? pickId + 0x1000000 : pickId; // Offset for no-depth variants
    
    let material = materialCacheRef.current.get(cacheKey);
    if (!material) {
      const color = encodePickId(pickId);
      material = new THREE.MeshBasicMaterial({
        color,
        fog: false,
        depthTest: !noDepthTest,
        depthWrite: !noDepthTest,
        transparent: false,
        side: THREE.FrontSide,
      });
      materialCacheRef.current.set(cacheKey, material);
    }
    return material;
  }, []);

  const clonePickObject = useCallback((registration: PickableRegistration): THREE.Object3D | null => {
    if (!registration.object) return null;

    const pickId = registration.pickId;
    const sourceObject = registration.object;
    const isGizmo = registration.category === 'gizmo';
    const pickMaterial = getPickingMaterial(pickId, isGizmo);

    const pickObject = sourceObject.clone(true);
    pickObject.traverse((child) => {
      child.matrixAutoUpdate = false;
      if (shouldExcludeFromPickClone(child)) {
        child.visible = false;
        return;
      }
      if (child instanceof THREE.Mesh) {
        child.material = pickMaterial;
      }
    });

    return pickObject;
  }, [getPickingMaterial]);

  const syncPickObjectTransforms = useCallback((sourceObject: THREE.Object3D, pickObject: THREE.Object3D) => {
    const queue: Array<{ source: THREE.Object3D; pick: THREE.Object3D }> = [{ source: sourceObject, pick: pickObject }];

    while (queue.length > 0) {
      const next = queue.pop();
      if (!next) continue;

      const { source, pick } = next;

      pick.visible = source.visible && !shouldExcludeFromPickClone(source);
      pick.matrixAutoUpdate = false;
      pick.matrix.copy(source.matrix);
      pick.matrixWorld.copy(source.matrixWorld);

      const sourceChildren = source.children;
      const pickChildren = pick.children;
      const childCount = Math.min(sourceChildren.length, pickChildren.length);
      for (let i = 0; i < childCount; i += 1) {
        queue.push({ source: sourceChildren[i], pick: pickChildren[i] });
      }
    }
  }, []);

  const syncPickSceneCache = useCallback(() => {
    // Remove stale cache entries.
    for (const pickId of pickObjectCacheRef.current.keys()) {
      if (!registrations.has(pickId)) {
        disposePickObject(pickId);
      }
    }

    // Ensure every registration has a cached pick object.
    for (const [pickId, registration] of registrations.entries()) {
      if (!registration.object) {
        disposePickObject(pickId);
        continue;
      }

      const cached = pickObjectCacheRef.current.get(pickId);
      if (cached && cached.sourceObject === registration.object) {
        continue;
      }

      disposePickObject(pickId);

      const pickObject = clonePickObject(registration);
      if (!pickObject) continue;

      pickObjectCacheRef.current.set(pickId, {
        sourceObject: registration.object,
        pickObject,
      });
      pickSceneRef.current.add(pickObject);
    }
  }, [clonePickObject, disposePickObject, registrations]);
  
  // Perform the pick render
  const performPick = useCallback((ndcX: number, ndcY: number) => {
    if (!renderTargetRef.current || !camera) return;

    const pickStartMs = performance.now();

    // Ensure scene graph world matrices are current once per pick (instead of once per registration).
    scene.updateMatrixWorld(false);
    
    const pickScene = pickSceneRef.current;

    // Sync registration cache (add/remove/recreate only when needed).
    const syncStartMs = performance.now();
    syncPickSceneCache();
    const syncDurationMs = Math.max(0, performance.now() - syncStartMs);
    
    // Clone camera for picking (adjusted to render only the area under the mouse)
    // We'll use a small viewport centered on the mouse position
    const pickCamera = camera.clone() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    
    // Adjust projection matrix to render only a small region around the mouse.
    // IMPORTANT: setViewOffset expects drawing-buffer pixel coordinates,
    // not CSS pixel dimensions. Using CSS pixels causes hover offset at
    // non-1 DPR (especially visible on gizmo handles).
    const width = gl.domElement.width;
    const height = gl.domElement.height;

    // Convert NDC to pixel coordinates
    const pixelX = ((ndcX + 1) / 2) * width;
    const pixelY = ((1 - ndcY) / 2) * height; // Flip Y

    // Set up a sub-frustum that renders only the 3x3 pixel area
    const subWidth = RENDER_TARGET.SIZE;
    const subHeight = RENDER_TARGET.SIZE;

    // Apply sub-view for both perspective and orthographic cameras.
    if (typeof (pickCamera as any).setViewOffset === 'function') {
      (pickCamera as any).setViewOffset(
        width,
        height,
        pixelX - subWidth / 2,
        pixelY - subHeight / 2,
        subWidth,
        subHeight,
      );
    }
    
    pickCameraRef.current = pickCamera;
    
    // Sync cached transforms and dynamic visibility.
    let visiblePickObjects = 0;
    for (const [pickId, registration] of registrations.entries()) {
      const cached = pickObjectCacheRef.current.get(pickId);
      if (!cached || !registration.object) continue;

      const hasAllowedCategories = Array.isArray(config.allowedCategories) && config.allowedCategories.length > 0;
      const categoryAllowed = !hasAllowedCategories || config.allowedCategories!.includes(registration.category);
      const includeCategory = categoryAllowed && !(registration.category === 'gizmo' && !config.includeGizmo);
      cached.pickObject.visible = includeCategory;
      if (!includeCategory) continue;

      visiblePickObjects += 1;

      syncPickObjectTransforms(registration.object, cached.pickObject);
    }
    
    // Render to the pick target
    const currentRenderTarget = gl.getRenderTarget();
    gl.setRenderTarget(renderTargetRef.current);
    gl.clear(true, true, false); // clear color, clear depth, don't clear stencil
    gl.render(pickScene, pickCamera);
    
    // Read back pixels
    gl.readRenderTargetPixels(
      renderTargetRef.current,
      0, 0,
      RENDER_TARGET.SIZE, RENDER_TARGET.SIZE,
      pixelBufferRef.current
    );
    
    // Restore render target
    gl.setRenderTarget(currentRenderTarget);
    
    // Perform majority vote
    const winnerId = config.patchSize === 1
      ? (pixelBufferRef.current[0] << 16) | (pixelBufferRef.current[1] << 8) | pixelBufferRef.current[2]
      : majorityVote(pixelBufferRef.current, previousWinnerRef.current);
    
    previousWinnerRef.current = winnerId;

    const pickDurationMs = Math.max(0, performance.now() - pickStartMs);
    reportPickingRenderSample({
      pickDurationMs,
      syncDurationMs,
      cachedPickObjects: pickObjectCacheRef.current.size,
      visiblePickObjects,
    });
    
    // Report result
    onPick(winnerId, ndcX, ndcY);
  }, [camera, gl, scene, registrations, config, onPick, syncPickObjectTransforms, syncPickSceneCache]);
  
  // Run picking on each frame (throttled)
  useFrame((_, delta) => {
    if (!config.enabled || isPaused) return;
    if (!mouseNDC.current) return;

    const frameMs = Math.max(1, delta * 1000);
    smoothedFrameMsRef.current = THREE.MathUtils.lerp(smoothedFrameMsRef.current, frameMs, 0.15);
    
    const now = performance.now();
    const prevMouse = previousMouseNdcRef.current;
    const nextMouse = mouseNDC.current;
    const moved = !prevMouse
      || Math.abs(prevMouse.x - nextMouse.x) > 1e-4
      || Math.abs(prevMouse.y - nextMouse.y) > 1e-4;

    if (moved) {
      lastPointerMoveTimeRef.current = now;
      previousMouseNdcRef.current = { x: nextMouse.x, y: nextMouse.y };
    }

    const cameraWorldChanged = !previousCameraWorldMatrixRef.current.equals(camera.matrixWorld);
    const projectionChanged = !previousProjectionMatrixRef.current.equals(camera.projectionMatrix);
    const sceneMoved = cameraWorldChanged || projectionChanged;
    if (sceneMoved) {
      previousCameraWorldMatrixRef.current.copy(camera.matrixWorld);
      previousProjectionMatrixRef.current.copy(camera.projectionMatrix);
    }

    const idleMs = now - (lastPointerMoveTimeRef.current || now);
    const isIdleHover = !isDragging && idleMs >= TIMING.IDLE_THRESHOLD_MS;

    // If pointer is idle and unchanged, keep the last hit result and skip GPU picking work.
    if (isIdleHover && !moved && !sceneMoved) return;

    const measuredFps = 1000 / Math.max(1, smoothedFrameMsRef.current);
    const dynamicMaxHz = 120;

    const activeHoverHz = Math.min(
      dynamicMaxHz,
      Math.max(1, Math.max(config.hoverUpdateRate, measuredFps)),
    );

    const idleHoverHz = Math.max(
      8,
      Math.min(dynamicMaxHz, Math.max(config.hoverUpdateRate * 0.5, activeHoverHz * 0.5)),
    );

    const activeDragHz = Math.min(
      dynamicMaxHz,
      Math.max(1, Math.max(config.dragUpdateRate, measuredFps)),
    );

    const effectiveHoverHz = isIdleHover ? idleHoverHz : activeHoverHz;
    const minInterval = isDragging
      ? 1000 / Math.max(1, activeDragHz)
      : 1000 / Math.max(1, effectiveHoverHz);
    
    if (now - lastPickTimeRef.current < minInterval) return;
    
    lastPickTimeRef.current = now;
    performPick(mouseNDC.current.x, mouseNDC.current.y);
  });

  // Keep cache in sync even when pointer is idle, so next pick has no setup hitch.
  useFrame(() => {
    if (!config.enabled || isPaused) return;
    syncPickSceneCache();
  });

  // Cleanup any cached pick objects on unmount.
  useEffect(() => {
    return () => {
      for (const pickId of Array.from(pickObjectCacheRef.current.keys())) {
        disposePickObject(pickId);
      }
    };
  }, [disposePickObject]);
  
  // This component doesn't render anything visible
  return null;
}
