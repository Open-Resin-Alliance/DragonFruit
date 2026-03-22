import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { leafPlacementStore, useLeafPlacementState } from './leafPlacementState';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';

export function useLeafPlacement() {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'LEAF_PLACEMENT');
    const LEAF_KEY = binding.key;
    const LEAF_MODIFIER = binding.modifier;
    const { isPlacementDisabled } = useInteractionStatus();
    const state = useLeafPlacementState();

    useEffect(() => {
        const requiredModifiers = (LEAF_MODIFIER ?? '')
            .split('+')
            .map((part) => part.trim().toLowerCase())
            .filter(Boolean);

        const keyLower = LEAF_KEY.toLowerCase();
        if (keyLower === 'alt') requiredModifiers.push('alt');
        if (keyLower === 'control' || keyLower === 'ctrl') requiredModifiers.push('ctrl');
        if (keyLower === 'shift') requiredModifiers.push('shift');
        if (keyLower === 'meta') requiredModifiers.push('meta');

        const expectsCtrl = requiredModifiers.includes('ctrl');
        const expectsAlt = requiredModifiers.includes('alt');
        const expectsShift = requiredModifiers.includes('shift');
        const expectsMeta = requiredModifiers.includes('meta');

        const isLeafComboHeld = (event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
            if (expectsCtrl && !event.ctrlKey) return false;
            if (expectsAlt && !event.altKey) return false;
            if (expectsShift && !event.shiftKey) return false;
            if (expectsMeta && !event.metaKey) return false;
            return true;
        };

        const pressedKeyMatchesLeafBinding = (eventKey: string) => {
            const key = eventKey.toLowerCase();
            const bindingKey = LEAF_KEY.toLowerCase();
            if (bindingKey === 'alt') return key === 'alt' || key === 'altgraph';
            if (bindingKey === 'control' || bindingKey === 'ctrl') return key === 'control';
            if (bindingKey === 'shift') return key === 'shift';
            if (bindingKey === 'meta') return key === 'meta';
            return key === bindingKey;
        };

        const pressedKeyIsLeafModifier = (eventKey: string) => {
            const key = eventKey.toLowerCase();
            if (expectsCtrl && key === 'control') return true;
            if (expectsAlt && (key === 'alt' || key === 'altgraph')) return true;
            if (expectsShift && key === 'shift') return true;
            if (expectsMeta && key === 'meta') return true;
            return false;
        };

        const cancelLeafMode = () => {
            const snapshot = leafPlacementStore.getSnapshot();
            if (!snapshot.hotkeyActive && snapshot.stage === 'idle') return;
            leafPlacementStore.setHotkeyActive(false);
            leafPlacementStore.reset();
        };

        const down = (e: KeyboardEvent) => {
            const isLeafHotkey = matchesConfiguredHotkeyDown(e, {
                key: LEAF_KEY,
                modifier: LEAF_MODIFIER,
            });

            const completingLeafCombo = isLeafComboHeld(e)
                && (pressedKeyMatchesLeafBinding(e.key) || pressedKeyIsLeafModifier(e.key));

            if (isLeafHotkey || completingLeafCombo) {
                e.preventDefault();
                leafPlacementStore.setHotkeyActive(true);
            }
        };

        const up = (e: KeyboardEvent) => {
            if (matchesConfiguredHotkeyUp(e, { key: LEAF_KEY, modifier: LEAF_MODIFIER })) {
                e.preventDefault();
                cancelLeafMode();
            }
        };

        const blur = () => {
            cancelLeafMode();
        };

        const pointerMove = (e: PointerEvent) => {
            const snapshot = leafPlacementStore.getSnapshot();
            if (!snapshot.hotkeyActive && snapshot.stage !== 'awaitingBase') return;
            if (isLeafComboHeld(e)) return;
            cancelLeafMode();
        };

        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        document.addEventListener('keyup', up, true);
        window.addEventListener('blur', blur);
        window.addEventListener('pointermove', pointerMove, true);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            document.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', blur);
            window.removeEventListener('pointermove', pointerMove, true);
        };
    }, [LEAF_KEY, LEAF_MODIFIER]);

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
