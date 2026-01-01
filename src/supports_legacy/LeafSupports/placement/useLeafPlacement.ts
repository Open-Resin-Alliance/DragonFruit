import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { SupportInstance, SupportMode, SupportSettings } from '@/supports_legacy/types';
import type { LeafPlacementState } from '@/supports_legacy/LeafSupports/types';
import { snapToSupport } from '@/supports_legacy/LeafSupports/snapping/snapToSupport';
import { LEAF_SNAP_DISTANCE } from '@/supports_legacy/LeafSupports/constants';
import { createLeaf } from '@/supports_legacy/LeafSupports/createLeaf';

interface UseLeafPlacementArgs {
  mode: SupportMode;
  supports: SupportInstance[];
  addSupport: (support: SupportInstance) => void;
  getCurrentSupportSettings: () => SupportSettings;
  clearPreview?: () => void; // Add callback to clear trunk preview
}

export function useLeafPlacement({ mode, supports, addSupport, getCurrentSupportSettings, clearPreview }: UseLeafPlacementArgs) {
  const [state, setState] = useState<LeafPlacementState>({
    isActive: false,
    contactPoint: null,
    contactNormal: null,
    socketPoint: null,
    socketNormal: null,
    parentSupportId: null,
    snapPoint: null,
    snapNormal: null,
  });
  const stateRef = useRef(state);
  const [ctrlAltDown, setCtrlAltDown] = useState(false);
  const [socketFollowPosition, setSocketFollowPosition] = useState<{ x: number; y: number; z: number } | null>(null);
  const [justFinalized, setJustFinalized] = useState(false); // Prevent immediate restart after placing leaf

  // Keep ref in sync with state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Track Ctrl+Alt key combination globally (BOTH must be pressed)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Only activate when BOTH Ctrl AND Alt are pressed
      if (e.ctrlKey && e.altKey) {
        setCtrlAltDown(true);
        console.log('[Leaf] Ctrl+Alt detected - leaf mode activated');
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Deactivate if either key is released
      if (e.key === 'Control' || e.key === 'Alt') {
        setCtrlAltDown(false);
        setJustFinalized(false); // Clear the flag when keys are released
        console.log('[Leaf] Key released - leaf mode deactivated');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const leafModeActive = useMemo(() => mode === 'support' && ctrlAltDown, [mode, ctrlAltDown]);

  // Reset leaf state when Ctrl+Alt is released
  useEffect(() => {
    if (!ctrlAltDown && state.isActive) {
      setState({
        isActive: false,
        contactPoint: null,
        contactNormal: null,
        socketPoint: null,
        socketNormal: null,
        parentSupportId: null,
        snapPoint: null,
        snapNormal: null,
      });
      setSocketFollowPosition(null);
    }
  }, [ctrlAltDown, state.isActive]);

  // Update snap state based on current socket position
  const updateSnap = useCallback((socketPos: { x: number; y: number; z: number }, cameraPos?: { x: number; y: number; z: number }) => {
    if (!leafModeActive || !state.contactPoint) return;

    // Try snapping to nearest support (with camera position for depth-aware prioritization)
    const snap = snapToSupport(socketPos, supports, LEAF_SNAP_DISTANCE, cameraPos);
    if (snap) {
      console.log('[Leaf] Snapped to support:', snap.supportId, 'at distance:', Math.sqrt(
        Math.pow(socketPos.x - snap.position.x, 2) +
        Math.pow(socketPos.y - snap.position.y, 2) +
        Math.pow(socketPos.z - snap.position.z, 2)
      ).toFixed(2), 'mm');
      setState(prev => ({
        ...prev,
        isActive: true,
        socketPoint: snap.position,
        socketNormal: snap.normal,
        parentSupportId: snap.supportId,
        snapPoint: snap.position,
        snapNormal: snap.normal,
      }));
      setSocketFollowPosition(snap.position);
    } else {
      // No snap: use free 3D position
      setState(prev => ({
        ...prev,
        isActive: true,
        socketPoint: socketPos,
        socketNormal: null,
        parentSupportId: null,
        snapPoint: null,
        snapNormal: null,
      }));
      setSocketFollowPosition(socketPos);
    }
  }, [leafModeActive, state.contactPoint, supports]);

  const handleHover = useCallback((hit: THREE.Intersection | null, mouseWorldPos?: { x: number; y: number; z: number }, cameraPos?: { x: number; y: number; z: number }, hoveredSupportId?: string | null) => {
    if (!leafModeActive) return;
    if (!state.contactPoint) return;
    
    // SIMPLE: If mouse is over a support (hoveredSupportId exists), snap to it. Otherwise, don't snap.
    if (hoveredSupportId && hit?.point) {
      // Mouse is over a support - use the EXACT hit point from the raycast
      // This is accurate because the raycast hit the support's geometry
      const hitPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
      console.log('[Leaf] Mouse over support:', hoveredSupportId, '- using raycast hit point');
      
      // Use snapToSupport with a small distance to find the closest shaft point near the hit
      // This ensures we snap to the shaft segment that was actually hit, not a far-away segment
      const snap = snapToSupport(hitPos, supports.filter(s => s.id === hoveredSupportId), 5.0, cameraPos);
      
      if (snap) {
        console.log('[Leaf] SNAPPED to shaft at:', snap.position);
        setState(prev => ({
          ...prev,
          isActive: true,
          socketPoint: snap.position,
          socketNormal: snap.normal,
          parentSupportId: hoveredSupportId,
          snapPoint: snap.position,
          snapNormal: snap.normal,
        }));
        setSocketFollowPosition(snap.position);
      } else {
        console.log('[Leaf] Using hit point directly (no snap within 5mm)');
        // If snap fails, use the hit point directly - we know we're on the support
        setState(prev => ({
          ...prev,
          isActive: true,
          socketPoint: hitPos,
          socketNormal: { x: 0, y: 0, z: 1 },
          parentSupportId: hoveredSupportId,
          snapPoint: hitPos,
          snapNormal: { x: 0, y: 0, z: 1 },
        }));
        setSocketFollowPosition(hitPos);
      }
    } else {
      // Mouse is NOT over a support - just follow mouse, no snap
      const mouse = (hit?.point ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null) || mouseWorldPos;
      if (mouse) {
        setState(prev => ({
          ...prev,
          isActive: true,
          socketPoint: mouse,
          socketNormal: null,
          parentSupportId: null,
          snapPoint: null,
          snapNormal: null,
        }));
        setSocketFollowPosition(mouse);
      }
    }
  }, [leafModeActive, state.contactPoint, supports]);

  const handleClick = useCallback((hit: THREE.Intersection) => {
    const currentState = stateRef.current;
    console.log('[Leaf] handleClick called, leafModeActive:', leafModeActive, 'hasContact:', !!currentState.contactPoint, 'ctrlAltDown:', ctrlAltDown, 'justFinalized:', justFinalized);

    // Prevent starting new leaf immediately after finalizing one
    if (justFinalized) {
      console.log('[Leaf] Ignoring click - just finalized, release keys first');
      return;
    }

    // Allow if leaf mode active OR if we're waiting for second click
    if (!leafModeActive && !currentState.contactPoint) {
      console.log('[Leaf] Ignoring click - leaf mode not active and no contact set');
      return;
    }

    if (!currentState.contactPoint) {
      // First click: set contact point on model (requires model hit)
      if (!hit?.point || !hit?.face?.normal) {
        console.log('[Leaf] First click ignored - no valid hit data');
        return;
      }
      const p = hit.point;
      const n = hit.face.normal;
      console.log('[Leaf] First click - contact set at', p);
      
      const newState = {
        isActive: true,
        contactPoint: { x: p.x, y: p.y, z: p.z },
        contactNormal: { x: n.x, y: n.y, z: n.z },
        socketPoint: null,
        socketNormal: null,
        parentSupportId: null,
        snapPoint: null,
        snapNormal: null,
      };
      stateRef.current = newState;
      setState(newState);
      console.log('[Leaf] State updated - waiting for socket placement');
    } else {
      // Second click: finalize leaf (only if snapped to a support)
      console.log('[Leaf] Second click - snap state:', currentState.parentSupportId);
      if (!currentState.parentSupportId || !currentState.snapPoint || !currentState.snapNormal || !currentState.contactPoint || !currentState.contactNormal) {
        console.log('[Leaf] Cannot finalize - not snapped to support or missing contact data');
        return;
      }

      // Create leaf support from contact point to snap position
      const settings = getCurrentSupportSettings();

      const leafSupport = createLeaf({
        contactPoint: currentState.contactPoint,
        contactNormal: currentState.contactNormal,
        socketPoint: currentState.snapPoint,
        socketNormal: currentState.snapNormal,
        parentSupportId: currentState.parentSupportId,
        settings,
      });

      // Add the leaf support
      addSupport(leafSupport);

      // Reset state completely
      const resetState = {
        isActive: false,
        contactPoint: null,
        contactNormal: null,
        socketPoint: null,
        socketNormal: null,
        parentSupportId: null,
        snapPoint: null,
        snapNormal: null,
      };
      stateRef.current = resetState;
      setState(resetState);
      setSocketFollowPosition(null);
      setJustFinalized(true); // Set flag to prevent immediate restart
      
      // Clear trunk preview to prevent it from showing with stale leaf data
      if (clearPreview) {
        clearPreview();
      }
      
      console.log('[Leaf] Leaf created and state reset');
    }
  }, [leafModeActive, ctrlAltDown, addSupport, getCurrentSupportSettings, justFinalized]);

  const reset = useCallback(() => {
    setState({
      isActive: false,
      contactPoint: null,
      contactNormal: null,
      socketPoint: null,
      socketNormal: null,
      parentSupportId: null,
      snapPoint: null,
      snapNormal: null,
    });
    setSocketFollowPosition(null);
  }, []);

  return {
    leafModeActive,
    state,
    stateRef,
    socketFollowPosition,
    handleHover,
    handleClick,
    updateSnap,
    reset,
  };
}
