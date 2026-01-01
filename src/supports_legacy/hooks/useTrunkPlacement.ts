import { useCallback, useRef, useEffect } from 'react';
import type * as THREE from 'three';
import type { SupportInstance, SupportMode } from '@/supports_legacy/types';
import { getCurrentSupportSettings, addSupport, subscribeToStore } from '@/supports_legacy/state';
import { validateTipPlacement, DEFAULT_PLACEMENT_CONFIG } from '@/supports_legacy/validation';
import { createSupportFromRaycast } from '@/supports_legacy/placement';

interface UseTrunkPlacementArgs {
  mode: SupportMode;
  jointCreationMode: boolean;
  supports: SupportInstance[];
  setSupportPreview: (p: {
    tip: { x: number; y: number; z: number };
    base: { x: number; y: number; z: number };
    tipNormal: { x: number; y: number; z: number };
    validationLevel?: 'valid' | 'invalid';
    joints?: any[];
    parentBaseId?: string | null;
  } | null) => void;
  setValidationMessage: (msg: string | null) => void;
  selectedJointId?: string | null;
}

export function useTrunkPlacement({ mode, jointCreationMode, supports, setSupportPreview, setValidationMessage, selectedJointId }: UseTrunkPlacementArgs) {
  const lastHitRef = useRef<THREE.Intersection | null>(null);

  const onSupportHover = useCallback((hit: THREE.Intersection | null) => {
    lastHitRef.current = hit;
    // Don't show preview when dragging a joint
    if (mode !== 'support' || !hit || jointCreationMode || selectedJointId) {
      setSupportPreview(null);
      return;
    }

    const settings = getCurrentSupportSettings();
    const plateZ = 0;
    let newSupport = createSupportFromRaycast(hit, settings, plateZ);

    if (newSupport) {
      // Apply grid snapping and merging logic for preview
      if (settings.grid?.enabled) {
        const { calculateGridMerge } = require('../Grid/merging');
        // We need to simulate the merge to see what the support will look like
        const mergeResult = calculateGridMerge(newSupport, supports, settings.grid.spacingMm);

        // The preview should show the 'supportToAdd' from the merge result.
        // If it became a branch, its base will be high up on the trunk.
        // If it became a trunk, it will be the full support.
        newSupport = mergeResult.supportToAdd;
      }

      const validation = validateTipPlacement(newSupport!.tip, settings, supports, DEFAULT_PLACEMENT_CONFIG);
      setSupportPreview({
        tip: newSupport!.tip,
        base: newSupport!.base,
        tipNormal: newSupport!.tipNormal,
        validationLevel: validation.level,
        joints: newSupport!.joints,
        parentBaseId: newSupport!.parentBaseId,
      });
    } else {
      setSupportPreview(null);
    }
  }, [mode, supports, jointCreationMode, setSupportPreview, selectedJointId]);

  // Subscribe to store changes to update preview immediately when settings change
  useEffect(() => {
    const unsubscribe = subscribeToStore(() => {
      if (lastHitRef.current) {
        onSupportHover(lastHitRef.current);
      }
    });
    return unsubscribe;
  }, [onSupportHover]);

  const onSupportClick = useCallback((hit: THREE.Intersection) => {
    if (mode !== 'support' || jointCreationMode) return;

    const settings = getCurrentSupportSettings();
    const plateZ = 0;

    // Create initial candidate from raycast
    let newSupport = createSupportFromRaycast(hit, settings, plateZ);

    if (newSupport) {
      // Grid Logic
      if (settings.grid?.enabled) {
        const { calculateGridMerge } = require('../Grid/merging'); // Dynamic import to avoid circular deps if any, though static is fine here usually
        const { supportToAdd, supportsToUpdate } = calculateGridMerge(
          newSupport,
          supports,
          settings.grid.spacingMm
        );

        // Update the candidate with the result from merge logic (snapped pos, parentId, diameter, etc.)
        newSupport = supportToAdd;

        // Apply updates to existing supports (re-parenting, diameter changes)
        if (supportsToUpdate.length > 0) {
          const { updateSupport } = require('../state');
          supportsToUpdate.forEach((s: SupportInstance) => updateSupport(s));
        }
      }

      const validation = validateTipPlacement(newSupport!.tip, settings, supports, DEFAULT_PLACEMENT_CONFIG);

      // Note: If it's a branch (has parentBaseId), we might want to skip some validation or use different rules?
      // For now, we validate tip placement as usual.

      if (validation.level === 'invalid') {
        setValidationMessage(validation.message || 'Cannot place support here');
        setTimeout(() => setValidationMessage(null), 2000);
        return;
      }

      if (newSupport) {
        addSupport(newSupport);
      }
    }
  }, [mode, supports, jointCreationMode, setValidationMessage]);

  return { onSupportHover, onSupportClick };
}
