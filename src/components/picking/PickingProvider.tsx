/**
 * GPU Picking System - Provider Component
 * 
 * Wraps the scene and provides the picking context to all children.
 * Manages registrations, configuration, and coordinates the picking renderer.
 */

"use client";

import React, { useState, useCallback, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { PickingContext, EMPTY_PICK_RESULT } from './PickingContext';
import { PickingRenderer } from './PickingRenderer';
import { DEFAULT_PICKING_CONFIG, PICK_ID, GIZMO_PICK_IDS, GIZMO_PICK_ID_TO_HANDLE } from './constants';
import { isGizmoPickId } from './pickingUtils';
import { reportPickingRegistrations, reportPickingRuntimeState } from './pickingDiagnostics';
import type { 
  PickingConfig, 
  PickingResult, 
  PickableRegistration, 
  PickableCategory,
  GizmoHandleType,
  PickingContextValue 
} from './types';

interface PickingProviderProps {
  children: React.ReactNode;
  /** Initial configuration overrides */
  initialConfig?: Partial<PickingConfig>;
  /** Enable debug mode (shows pick info overlay) */
  debug?: boolean;
}

/**
 * PickingProvider - Main provider component for the GPU picking system.
 * 
 * Place this inside your R3F Canvas to enable GPU picking for all children.
 * 
 * @example
 * <Canvas>
 *   <PickingProvider debug>
 *     <YourScene />
 *   </PickingProvider>
 * </Canvas>
 */
export function PickingProvider({ 
  children, 
  initialConfig,
  debug = false,
}: PickingProviderProps) {
  // Configuration state
  const [config, setConfigState] = useState<PickingConfig>(() => ({
    ...DEFAULT_PICKING_CONFIG,
    ...initialConfig,
    debug,
  }));
  
  // Current pick result
  const [hit, setHit] = useState<PickingResult>(EMPTY_PICK_RESULT);
  
  // Pause state
  const [isPaused, setIsPaused] = useState(false);
  
  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  
  // Registration map (pickId -> registration)
  const registrationsRef = useRef<Map<number, PickableRegistration>>(new Map());
  
  // Next available dynamic pick ID
  const nextPickIdRef = useRef<number>(PICK_ID.DYNAMIC_START);
  
  // Mouse position in NDC (updated by pointer move handler)
  const mouseNDCRef = useRef<{ x: number; y: number } | null>(null);
  
  // Get the GL context for coordinate conversion
  const { gl } = useThree();
  
  /**
   * Register a pickable object.
   * Returns the assigned pick ID.
   */
  const register = useCallback((
    registration: Omit<PickableRegistration, 'pickId'>
  ): number => {
    let pickId: number;
    
    // Gizmo handles use fixed IDs
    if (registration.category === 'gizmo' && registration.gizmoHandle) {
      pickId = GIZMO_PICK_IDS[registration.gizmoHandle];
    } 
    // Model uses fixed ID
    else if (registration.category === 'model') {
      pickId = PICK_ID.MODEL;
    }
    // Dynamic objects get incrementing IDs
    else {
      pickId = nextPickIdRef.current++;
    }
    
    const fullRegistration: PickableRegistration = {
      ...registration,
      pickId,
    };
    
    registrationsRef.current.set(pickId, fullRegistration);
    reportPickingRegistrations(registrationsRef.current);
    
    // Debug logging disabled - uncomment if needed
    // if (config.debug) {
    //   console.log('[Picking] Registered:', fullRegistration);
    // }
    
    return pickId;
  }, [config.debug]);
  
  /**
   * Unregister a pickable object.
   */
  const unregister = useCallback((pickId: number) => {
    const registration = registrationsRef.current.get(pickId);
    registrationsRef.current.delete(pickId);
    reportPickingRegistrations(registrationsRef.current);
    
    // Debug logging disabled - uncomment if needed
    // if (config.debug && registration) {
    //   console.log('[Picking] Unregistered:', registration);
    // }
  }, [config.debug]);
  
  /**
   * Update configuration.
   */
  const setConfig = useCallback((updates: Partial<PickingConfig>) => {
    setConfigState(prev => ({ ...prev, ...updates }));
  }, []);
  
  /**
   * Handle pick result from the renderer.
   */
  const handlePick = useCallback((pickId: number, ndcX: number, ndcY: number) => {
    // Debug: Log picking results occasionally (e.g. if not none)
    if (config.debug && pickId !== PICK_ID.NONE) {
       console.log('[Picking] Picked ID:', pickId);
    }

    const timestamp = performance.now();
    const screenPosition = { x: ndcX, y: ndcY };
    
    // No hit
    if (pickId === PICK_ID.NONE) {
      setHit({
        pickId: PICK_ID.NONE,
        category: 'none',
        objectId: null,
        screenPosition,
        timestamp,
      });
      return;
    }
    
    // Model hit
    if (pickId === PICK_ID.MODEL) {
      setHit({
        pickId,
        category: 'model',
        objectId: null,
        screenPosition,
        timestamp,
      });
      return;
    }
    
    // Gizmo hit
    if (isGizmoPickId(pickId)) {
      const handleType = GIZMO_PICK_ID_TO_HANDLE[pickId] as GizmoHandleType | undefined;
      setHit({
        pickId,
        category: 'gizmo',
        objectId: null,
        gizmoHandle: handleType,
        screenPosition,
        timestamp,
      });
      return;
    }
    
    // Dynamic object hit - look up registration
    const registration = registrationsRef.current.get(pickId);
    if (registration) {
      setHit({
        pickId,
        category: registration.category,
        objectId: registration.objectId,
        parentId: registration.parentId,
        gizmoHandle: registration.gizmoHandle,
        screenPosition,
        timestamp,
      });
    } else {
      // Unknown ID - treat as nothing
      if (config.debug) {
        console.warn('[Picking] Unknown pick ID:', pickId);
      }
      setHit({
        pickId: PICK_ID.NONE,
        category: 'none',
        objectId: null,
        screenPosition,
        timestamp,
      });
    }
  }, [config.debug]);
  
  /**
   * Drag state handlers.
   */
  const onDragStart = useCallback(() => {
    setIsDragging(true);
  }, []);
  
  const onDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);
  
  /**
   * Pause/resume handlers.
   */
  const pause = useCallback(() => {
    setIsPaused(true);
  }, []);
  
  const resume = useCallback(() => {
    setIsPaused(false);
  }, []);
  
  /**
   * Context value - memoized to prevent unnecessary re-renders.
   */
  const contextValue: PickingContextValue = useMemo(() => ({
    hit,
    register,
    unregister,
    setConfig,
    config,
    onDragStart,
    onDragEnd,
    pause,
    resume,
    isPaused,
    isDragging, // Exposed
  }), [hit, register, unregister, setConfig, config, onDragStart, onDragEnd, pause, resume, isPaused, isDragging]);

  React.useEffect(() => {
    reportPickingRuntimeState({
      enabled: config.enabled,
      isPaused,
      isDragging,
    });
  }, [config.enabled, isPaused, isDragging]);

  React.useEffect(() => {
    reportPickingRegistrations(registrationsRef.current);
  }, []);
  
  return (
    <PickingContext.Provider value={contextValue}>
      {/* Pointer move handler to track mouse position */}
      <PointerTracker
        mouseNDCRef={mouseNDCRef}
        gl={gl}
        onPointerLeave={() => {
          setHit({
            pickId: 0,
            category: 'none',
            objectId: null,
            screenPosition: { x: 0, y: 0 },
            timestamp: performance.now(),
          });
        }}
      />
      
      {/* The picking renderer (invisible, runs in background) */}
      <PickingRenderer
        registrations={registrationsRef.current}
        config={config}
        isPaused={isPaused}
        isDragging={isDragging}
        onPick={handlePick}
        mouseNDC={mouseNDCRef}
      />
      
      {children}
    </PickingContext.Provider>
  );
}

/**
 * PointerTracker - Tracks mouse position and updates the NDC ref.
 * Separated to avoid re-rendering the entire provider on mouse move.
 */
function PointerTracker({ 
  mouseNDCRef, 
  gl,
  onPointerLeave,
}: { 
  mouseNDCRef: React.MutableRefObject<{ x: number; y: number } | null>;
  gl: THREE.WebGLRenderer;
  onPointerLeave?: () => void;
}) {
  React.useEffect(() => {
    const canvas = gl.domElement;

    if (typeof (canvas as any).tabIndex !== 'number') {
      (canvas as any).tabIndex = 0;
    }

    const focusCanvas = () => {
      if (typeof (canvas as any).focus === 'function') {
        (canvas as any).focus();
      }
    };
    
    const handlePointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      mouseNDCRef.current = { x, y };
    };
    
    const handlePointerLeave = () => {
      mouseNDCRef.current = null;
      onPointerLeave?.();
    };
    
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerenter', focusCanvas);
    canvas.addEventListener('pointerdown', focusCanvas);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerenter', focusCanvas);
      canvas.removeEventListener('pointerdown', focusCanvas);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [gl, mouseNDCRef, onPointerLeave]);
  
  return null;
}
