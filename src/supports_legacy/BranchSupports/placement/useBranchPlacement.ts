import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { SupportInstance, SupportMode, SupportSettings } from '@/supports_legacy/types';
import type { BranchPlacementState } from '../types';
import { getCurrentSupportSettings, addSupport } from '@/supports_legacy/state';
import { createBranch } from '../createBranch';
import { snapToTrunk } from '../snapping/snapToTrunk';
import { BRANCH_SNAP_DISTANCE_MM } from '../constants';
import { generateSupportId } from '@/supports_legacy/state';

interface UseBranchPlacementArgs {
  mode: SupportMode;
  supports: SupportInstance[];
  addSupport: (support: SupportInstance) => void;
  getCurrentSupportSettings: () => SupportSettings;
}

export function useBranchPlacement({ mode, supports, addSupport, getCurrentSupportSettings }: UseBranchPlacementArgs) {
  const [state, setState] = useState<BranchPlacementState>({ stage: 'idle', snap: null });
  const stateRef = useRef<BranchPlacementState>({ stage: 'idle', snap: null });
  const [altDown, setAltDown] = useState(false);
  const [baseFollowPosition, setBaseFollowPosition] = useState<{ x: number; y: number; z: number } | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Track Alt key globally (but NOT when Ctrl is also pressed - that's for leaf mode)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Only activate branch mode if Alt is pressed WITHOUT Ctrl
      if (e.altKey && !e.ctrlKey) setAltDown(true);
      // If Ctrl is pressed while Alt is down, deactivate branch mode
      if (e.ctrlKey && e.altKey) setAltDown(false);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltDown(false);
      // If Ctrl is released while Alt is still down, reactivate branch mode
      if (e.key === 'Control' && e.altKey) setAltDown(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const branchModeActive = useMemo(() => mode === 'support' && altDown, [mode, altDown]);

  // Reset branch state when Alt is released
  useEffect(() => {
    if (!altDown && state.stage !== 'idle') {
      setState({ stage: 'idle', snap: null });
      setBaseFollowPosition(null);
    }
  }, [altDown, state.stage]);

  // Update snap state based on current base position
  const updateSnap = useCallback((basePos: { x: number; y: number; z: number }, cameraPos?: { x: number; y: number; z: number }) => {
    if (!branchModeActive || (state.stage !== 'tipPlaced' && state.stage !== 'baseFollow')) return;

    // Try snapping to nearest trunk/branch (with camera position for depth-aware prioritization)
    const snap = snapToTrunk(basePos, supports, BRANCH_SNAP_DISTANCE_MM, cameraPos);
    if (snap) {
      setState(prev => ({ ...prev, stage: 'baseFollow', snap: { trunkId: snap.trunkId, position: snap.position } }));
      setBaseFollowPosition(snap.position);
    } else {
      // No snap: use free 3D position
      setState(prev => ({ ...prev, stage: 'baseFollow', snap: null }));
      setBaseFollowPosition(basePos);
    }
  }, [branchModeActive, state.stage, supports]);

  const handleHover = useCallback((hit: THREE.Intersection | null, mouseWorldPos?: { x: number; y: number; z: number }, cameraPos?: { x: number; y: number; z: number }) => {
    if (!branchModeActive) return;
    if (state.stage === 'tipPlaced' || state.stage === 'baseFollow') {
      // Use provided world position or fall back to hit point
      const mouse = mouseWorldPos || (hit?.point ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null);
      if (mouse) {
        updateSnap(mouse, cameraPos);
      }
    }
  }, [branchModeActive, state.stage, updateSnap]);

  const handleClick = useCallback((hit: THREE.Intersection) => {
    const currentStage = stateRef.current.stage;
    console.log('[Branch] handleClick called, branchModeActive:', branchModeActive, 'stage:', state.stage, 'refStage:', currentStage, 'altDown:', altDown);

    // Allow if branch mode active OR if we're in baseFollow (second click, Alt may be released)
    if (!branchModeActive && currentStage !== 'baseFollow') {
      console.log('[Branch] Ignoring click - branch mode not active and not in baseFollow');
      return;
    }

    if (currentStage === 'idle') {
      // First click: set contact and enter baseFollow (requires model hit)
      if (!hit?.point || !hit?.face?.normal) {
        console.log('[Branch] First click ignored - no valid hit data');
        return;
      }
      const p = hit.point;
      const n = hit.face.normal;
      console.log('[Branch] First click - contact set at', p);
      // Set contact and immediately enter baseFollow in one update
      const newState = {
        stage: 'baseFollow' as const,
        contact: { x: p.x, y: p.y, z: p.z },
        contactNormal: { x: n.x, y: n.y, z: n.z },
        snap: null,
      };
      stateRef.current = newState;
      setState(newState);
      console.log('[Branch] State updated to baseFollow');
    } else if (currentStage === 'baseFollow') {
      // Second click: finalize branch (only if snapped, click anywhere)
      const currentSnap = stateRef.current.snap;
      const currentContact = stateRef.current.contact;
      const currentContactNormal = stateRef.current.contactNormal;
      console.log('[Branch] Second click - snap state:', currentSnap);
      if (!currentSnap || !currentContact || !currentContactNormal) {
        console.log('[Branch] Cannot finalize - not snapped or missing contact data');
        return;
      }

      // Create branch support from contact point to snap position
      const settings = getCurrentSupportSettings();

      // Get parent support to determine branch joint diameter
      const parentSupport = supports.find(s => s.id === currentSnap.trunkId);
      const parentShaftDiameter = parentSupport?.settings.mid.diameterMm;

      const branchSupport = createBranch({
        tip: currentContact,
        tipNormal: currentContactNormal,
        base: currentSnap.position,
        trunkId: currentSnap.trunkId,
        settings,
        parentShaftDiameter
      });

      // Add the branch support
      addSupport(branchSupport);

      // Reset state
      setState({ stage: 'idle', snap: null });
      setBaseFollowPosition(null);
    }
  }, [branchModeActive, state.stage, state.snap]);

  const reset = useCallback(() => setState({ stage: 'idle', snap: null }), []);

  return {
    branchModeActive,
    state,
    stateRef,
    baseFollowPosition,
    handleHover,
    handleClick,
    updateSnap,
    reset,
  };
}
