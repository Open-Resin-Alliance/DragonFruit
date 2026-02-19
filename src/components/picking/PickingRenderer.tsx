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
  
  // Picking camera (will be synced with main camera)
  const pickCameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  
  // Material cache to avoid recreating materials
  const materialCacheRef = useRef<Map<number, THREE.MeshBasicMaterial>>(new Map());
  
  // Timing control
  const lastPickTimeRef = useRef<number>(0);
  const previousWinnerRef = useRef<number>(0);
  
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
        side: THREE.DoubleSide, // Render both sides for reliable picking
      });
      materialCacheRef.current.set(cacheKey, material);
    }
    return material;
  }, []);
  
  // Perform the pick render
  const performPick = useCallback((ndcX: number, ndcY: number) => {
    if (!renderTargetRef.current || !camera) return;
    
    const pickScene = pickSceneRef.current;
    
    // Clear the pick scene
    while (pickScene.children.length > 0) {
      pickScene.remove(pickScene.children[0]);
    }
    
    // Clone camera for picking (adjusted to render only the area under the mouse)
    // We'll use a small viewport centered on the mouse position
    const pickCamera = camera.clone() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    
    // For perspective camera, we need to adjust the projection matrix
    // to render only a small region around the mouse
    if (pickCamera instanceof THREE.PerspectiveCamera) {
      // Calculate the region to render (in pixels)
      const pixelRatio = gl.getPixelRatio();
      const width = gl.domElement.width / pixelRatio;
      const height = gl.domElement.height / pixelRatio;
      
      // Convert NDC to pixel coordinates
      const pixelX = ((ndcX + 1) / 2) * width;
      const pixelY = ((1 - ndcY) / 2) * height; // Flip Y
      
      // Set up a sub-frustum that renders only the 3x3 pixel area
      const subWidth = RENDER_TARGET.SIZE;
      const subHeight = RENDER_TARGET.SIZE;
      
      // Adjust projection matrix for the sub-region
      pickCamera.setViewOffset(
        width, height,
        pixelX - subWidth / 2, pixelY - subHeight / 2,
        subWidth, subHeight
      );
    }
    
    pickCameraRef.current = pickCamera;
    
    // Add pickable objects to the pick scene with their pick materials
    for (const [pickId, registration] of registrations.entries()) {
      if (!registration.object) continue;
      
      // Skip gizmo handles if not included in config
      if (registration.category === 'gizmo' && !config.includeGizmo) continue;
      
      // Clone the object for picking
      const pickObject = registration.object.clone();
      
      // Apply picking material to all meshes in the object
      const isGizmo = registration.category === 'gizmo';
      const pickMaterial = getPickingMaterial(pickId, isGizmo);
      
      pickObject.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = pickMaterial;
        }
      });
      
      // Copy world transform - need to set both matrix and matrixWorld
      registration.object.updateMatrixWorld(true);
      pickObject.matrixAutoUpdate = false;

      // Copy world matrix directly to preserve full transform (including shear)
      pickObject.matrix.copy(registration.object.matrixWorld);
      pickObject.matrixWorld.copy(registration.object.matrixWorld);

      // No need to call updateMatrix / updateMatrixWorld since we've set them explicitly

      pickScene.add(pickObject);
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
    
    // Report result
    onPick(winnerId, ndcX, ndcY);
  }, [camera, gl, registrations, config, getPickingMaterial, onPick]);
  
  // Run picking on each frame (throttled)
  useFrame(() => {
    if (!config.enabled || isPaused) return;
    if (!mouseNDC.current) return;
    
    const now = performance.now();
    const minInterval = isDragging ? TIMING.MIN_DRAG_INTERVAL_MS : TIMING.MIN_HOVER_INTERVAL_MS;
    
    if (now - lastPickTimeRef.current < minInterval) return;
    
    lastPickTimeRef.current = now;
    performPick(mouseNDC.current.x, mouseNDC.current.y);
  });
  
  // This component doesn't render anything visible
  return null;
}
