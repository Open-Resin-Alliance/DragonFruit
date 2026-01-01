import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { leafPlacementStore, useLeafPlacementState } from './leafPlacementState';
import { DEFAULT_KEYBINDINGS, matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';

const LEAF_KEY = DEFAULT_KEYBINDINGS.SUPPORTS.LEAF_PLACEMENT.key;
const LEAF_MODIFIER = DEFAULT_KEYBINDINGS.SUPPORTS.LEAF_PLACEMENT.modifier;

export function useLeafPlacement() {
    const { isPlacementDisabled } = useInteractionStatus();
    const state = useLeafPlacementState();

    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const isLeafHotkey = matchesConfiguredHotkeyDown(e, {
                key: LEAF_KEY,
                modifier: LEAF_MODIFIER,
            });

            if (isLeafHotkey) {
                e.preventDefault();
                leafPlacementStore.setHotkeyActive(true);
            }
        };

        const up = (e: KeyboardEvent) => {
            if (matchesConfiguredHotkeyUp(e, { key: LEAF_KEY, modifier: LEAF_MODIFIER })) {
                e.preventDefault();
                leafPlacementStore.setHotkeyActive(false);
                leafPlacementStore.reset();
            }
        };

        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
        };
    }, []);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && state.stage === 'awaitingBase') {
                leafPlacementStore.reset();
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [state.stage]);

    const onModelHover = useCallback((hit: THREE.Intersection | null) => {
        if (state.hotkeyActive && state.stage === 'idle' && hit) {
            const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
            leafPlacementStore.setHoverPosition(pos);
        } else if (!state.hotkeyActive || state.stage !== 'idle') {
            leafPlacementStore.setHoverPosition(null);
        }
    }, [state.hotkeyActive, state.stage]);

    const onModelClick = useCallback((hit: THREE.Intersection | null) => {
        if (!state.hotkeyActive || isPlacementDisabled || !hit) return;

        const surfaceNormal = calculateSmoothedNormal(hit);
        const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData?.modelId || 'unknown';

        leafPlacementStore.setTip(pos, surfaceNormal, modelId);
    }, [state.hotkeyActive, isPlacementDisabled]);

    const onSupportHover = useCallback((hit: THREE.Intersection | null) => { }, []);
    const onSupportClick = useCallback((hit: THREE.Intersection | null) => { }, []);

    useEffect(() => {
        if (isPlacementDisabled && state.stage === 'idle') {
            leafPlacementStore.reset();
        }
    }, [isPlacementDisabled, state.stage]);

    return {
        hotkeyActive: state.hotkeyActive,
        isActive: state.isActive,
        stage: state.stage,
        previewData: state.previewData,
        tipPosition: state.tipPosition,
        surfaceNormal: state.surfaceNormal,
        hoverPosition: state.hoverPosition,
        onModelHover,
        onModelClick,
        onSupportHover,
        onSupportClick,
    };
}
