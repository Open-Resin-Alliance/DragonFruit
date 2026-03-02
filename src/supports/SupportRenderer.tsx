"use client";

import React, { useSyncExternalStore, forwardRef, useImperativeHandle, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { addKnot, addRoot, removeRootById, subscribe, getSnapshot, updateKnot } from './state';
import { TrunkRenderer } from './SupportTypes/Trunk/TrunkRenderer';
import { BranchRenderer } from './SupportTypes/Branch/BranchRenderer';
import { LeafRenderer } from './SupportTypes/Leaf/LeafRenderer';
import { BraceRenderer } from './SupportTypes/Brace/BraceRenderer';
import { TwigRenderer } from './SupportTypes/Twig/TwigRenderer';
import { StickRenderer } from './SupportTypes/Stick/StickRenderer';
import { SupportBraceRenderer } from './SupportTypes/SupportBrace/SupportBraceRenderer';
import { InstancedShaftGroup, type InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import { InstancedJointGroup, type InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import { InstancedRootsGroup, type InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import { InstancedContactConeGroup, type InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { useBracePlacementState } from './SupportTypes/Brace/bracePlacementState';
import { useSupportBraceStoreState } from './SupportTypes/SupportBrace/supportBraceStore';
import { useJointInteraction } from './SupportPrimitives/Joint/useJointInteraction';
import { useKnotInteraction } from './SupportPrimitives/Knot/useKnotInteraction';
import { JointCreationManager } from './SupportPrimitives/Joint/JointCreationManager';
import { JointGizmo } from './SupportPrimitives/Joint/JointGizmo';
import { KnotGizmo } from './SupportPrimitives/Knot/KnotGizmo';
import { BezierGizmoManager } from './Curves/BezierGizmo/BezierGizmoManager';
import { ContactDisk, SupportMode } from './types';
import { useJointCreationState } from './SupportPrimitives/Joint/jointCreationState';
import { useSupportHistoryHandlers } from './history/useSupportHistoryHandlers';
import { subscribeToSettings, getSettingsSnapshot } from './Settings/state';
import { emitSupportModelPointerHover, emitSupportModelPointerSelect, handleSupportClick } from './interaction/clickHandlers';
import { getEmptySelectedSupportIdsSnapshot, getSelectedSupportIds, subscribeSupportMultiSelection } from './interaction/supportMultiSelection';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { getRaftSettings, subscribeToRaftStore } from './Rafts/Crenelated/RaftState';
import { JOINT_DIAMETER_OFFSET_MM } from './constants';
import { DEBUG_SECTION_COLORS as AUTO_BRACING_DEBUG_SECTION_COLORS } from './autoBracing/settings';

interface SupportRendererProps {
    mode?: SupportMode;
    navigationLodActive?: boolean;
    hidePlateContactPrimitives?: boolean;
    clipLower?: number | null;
    clipUpper?: number | null;
    supportColorsByModelId?: Record<string, string>;
    hoverTintColor?: string;
    hoverTintStrength?: number;
    selectedTintStrength?: number;
    activeModelId?: string | null;
    selectedModelIds?: string[];
    hoverModelId?: string | null;
    modelDropOffsetsById?: Record<string, number>;
    modelFilterId?: string | null;
    excludeModelId?: string | null;
    excludeModelIds?: string[];
    passive?: boolean;
    disableSelectionAndHover?: boolean;
    ghostOpacity?: number;
    ghostRenderOrder?: number;
}

interface SupportShaftSet {
    supportId: string;
    modelId?: string;
    shafts: InstancedShaft[];
}

interface SupportJointSet {
    supportId: string;
    modelId?: string;
    joints: InstancedJoint[];
}

const BATCHED_SHAFT_RADIAL_SEGMENTS = 10;
const BATCHED_SHAFT_LOW_RADIAL_SEGMENTS = 6;
const BATCHED_SHAFT_HIGH_INSTANCE_THRESHOLD = 1200;
const BATCHED_JOINT_WIDTH_SEGMENTS = 12;
const BATCHED_JOINT_HEIGHT_SEGMENTS = 10;
const MULTI_SELECTION_DETAIL_THRESHOLD = 24;
const BULK_MULTI_SELECTED_COLOR = '#80fffd';
const SCENE_JOINT_DIAMETER_BLEND_MM = JOINT_DIAMETER_OFFSET_MM * 0.75;

export const SupportRenderer = forwardRef<THREE.Group, SupportRendererProps>(({ mode, navigationLodActive = false, hidePlateContactPrimitives = false, clipLower, clipUpper, activeModelId = null, selectedModelIds = [], hoverModelId = null, modelDropOffsetsById, modelFilterId = null, excludeModelId = null, excludeModelIds = [], passive = false, disableSelectionAndHover = false, ghostOpacity = 1, ghostRenderOrder = 0 }, ref) => {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedSupportIds = useSyncExternalStore(
        subscribeSupportMultiSelection,
        getSelectedSupportIds,
        getEmptySelectedSupportIdsSnapshot,
    );
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const raftSettings = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
    const supportBraceState = useSupportBraceStoreState();
    const { isActive: isJointCreationActive } = useJointCreationState();
    const { altActive: braceAltActive } = useBracePlacementState();

    const selectionEnabled = mode === 'support';
    const effectiveSelectedSupportIds = selectionEnabled ? selectedSupportIds : [];
    const selectedSupportIdSet = useMemo(() => new Set(effectiveSelectedSupportIds), [effectiveSelectedSupportIds]);
    const selectedId = selectionEnabled ? state.selectedId : null;
    const selectedCategory = selectionEnabled ? state.selectedCategory : null;
    const hasSupportMultiSelection = effectiveSelectedSupportIds.length > 0;
    const useMultiSelectionDetail = hasSupportMultiSelection && selectedId !== null && selectedSupportIds.length <= MULTI_SELECTION_DETAIL_THRESHOLD;
    const dimNonSelected = selectedId !== null || hasSupportMultiSelection;
    const hideUnselectedKnots = selectedId !== null || hasSupportMultiSelection;
    const enableTwigSceneBatching = false;

    const interactionHooksEnabled = !passive;
    const [gizmoInteractionLockActive, setGizmoInteractionLockActive] = React.useState(false);
    const knotGizmoInteractionLockTimeoutRef = React.useRef<number | null>(null);
    const rawHoveredCategory = state.hoveredCategory as string | null | undefined;
    const jointCategoryHoverSuppressed = rawHoveredCategory === 'joint' || rawHoveredCategory === 'join';
    const supportInteractionSuppressed = mode === 'support' && (disableSelectionAndHover || gizmoInteractionLockActive);
    const supportSelectionAndHoverSuppressed = supportInteractionSuppressed || (mode === 'support' && jointCategoryHoverSuppressed);
    const supportPointerInteractable = interactionHooksEnabled && mode === 'support' && !navigationLodActive;
    const isInteractable = supportPointerInteractable && !supportInteractionSuppressed;
    const isPreparePointerInteractable = interactionHooksEnabled && mode === 'prepare' && !navigationLodActive;
    const isPointerInteractable = supportPointerInteractable || isPreparePointerInteractable;
    const ghostOpacityClamped = Math.max(0.05, Math.min(1, ghostOpacity));
    const ghostTransparent = ghostOpacityClamped < 0.999;
    const selectedModelIdSet = useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
    const excludedModelIdSet = useMemo(() => new Set(excludeModelIds.filter((id): id is string => Boolean(id))), [excludeModelIds]);
    const hidePlateContactPrimitivesEffective = hidePlateContactPrimitives;
    const restrictToActiveModel = mode === 'support' && !!activeModelId;
    const suppressHover = supportSelectionAndHoverSuppressed || isJointCreationActive || !isInteractable || braceAltActive;
    const [immediateModelHoverId, setImmediateModelHoverId] = React.useState<string | null>(null);
    const [sceneHoveredSupportId, setSceneHoveredSupportId] = React.useState<string | null>(null);
    const [marqueeHoveredSupportId, setMarqueeHoveredSupportId] = React.useState<string | null>(null);
    const pendingSceneHoverClearFrameRef = React.useRef<number | null>(null);
    const orbitInteractionActiveRef = React.useRef(false);
    const entitySegmentModelIdById = useMemo(() => {
        const map = new Map<string, string | undefined>();

        for (const trunk of Object.values(state.trunks)) {
            for (const segment of trunk.segments) map.set(segment.id, trunk.modelId);
        }

        for (const branch of Object.values(state.branches)) {
            for (const segment of branch.segments) map.set(segment.id, branch.modelId);
        }

        for (const twig of Object.values(state.twigs)) {
            for (const segment of twig.segments) map.set(segment.id, twig.modelId);
        }

        for (const stick of Object.values(state.sticks)) {
            for (const segment of stick.segments) map.set(segment.id, stick.modelId);
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            for (const segment of supportBrace.segments) map.set(segment.id, supportBrace.modelId);
        }

        return map;
    }, [state.trunks, state.branches, state.twigs, state.sticks, supportBraceState.supportBraces]);

    const entityModelIdByKnotId = useMemo(() => {
        const map = new Map<string, string | undefined>();

        const resolveByParentShaftId = (parentShaftId: string): string | undefined => {
            if (parentShaftId.startsWith('braceSegment:')) {
                const braceId = parentShaftId.slice('braceSegment:'.length);
                return state.braces[braceId]?.modelId;
            }
            if (parentShaftId.startsWith('leafCone:')) {
                const leafId = parentShaftId.slice('leafCone:'.length);
                return state.leaves[leafId]?.modelId;
            }
            return entitySegmentModelIdById.get(parentShaftId);
        };

        for (const knot of Object.values(state.knots)) {
            map.set(knot.id, resolveByParentShaftId(knot.parentShaftId));
        }

        for (const knot of Object.values(supportBraceState.knots)) {
            map.set(knot.id, resolveByParentShaftId(knot.parentShaftId));
        }

        return map;
    }, [state.knots, state.braces, state.leaves, supportBraceState.knots, entitySegmentModelIdById]);

    const resolveSupportModelId = React.useCallback((modelId?: string, supportId?: string) => {
        if (modelId) return modelId;
        if (!supportId) return undefined;

        const trunk = state.trunks[supportId];
        if (trunk?.modelId) return trunk.modelId;

        const branch = state.branches[supportId];
        if (branch) return branch.modelId ?? entityModelIdByKnotId.get(branch.parentKnotId);

        const leaf = state.leaves[supportId];
        if (leaf) return leaf.modelId ?? entityModelIdByKnotId.get(leaf.parentKnotId);

        const brace = state.braces[supportId];
        if (brace) {
            return brace.modelId
                ?? entityModelIdByKnotId.get(brace.startKnotId)
                ?? entityModelIdByKnotId.get(brace.endKnotId);
        }

        const twig = state.twigs[supportId];
        if (twig?.modelId) return twig.modelId;

        const stick = state.sticks[supportId];
        if (stick?.modelId) return stick.modelId;

        const supportBrace = supportBraceState.supportBraces[supportId];
        if (supportBrace) {
            return supportBrace.modelId
                ?? supportBraceState.roots[supportBrace.rootId]?.modelId
                ?? entityModelIdByKnotId.get(supportBrace.hostKnotId);
        }

        return undefined;
    }, [state.trunks, state.branches, state.leaves, state.braces, state.twigs, state.sticks, supportBraceState.supportBraces, supportBraceState.roots, entityModelIdByKnotId]);

    const isModelVisible = React.useCallback((modelId?: string, supportId?: string) => {
        const resolvedModelId = resolveSupportModelId(modelId, supportId);

        if ((restrictToActiveModel || modelFilterId || excludeModelId || excludedModelIdSet.size > 0) && !resolvedModelId) return false;
        if (restrictToActiveModel && resolvedModelId !== activeModelId) return false;
        if (modelFilterId && resolvedModelId !== modelFilterId) return false;
        if (excludeModelId && resolvedModelId === excludeModelId) return false;
        if (resolvedModelId && excludedModelIdSet.has(resolvedModelId)) return false;
        return true;
    }, [resolveSupportModelId, restrictToActiveModel, activeModelId, modelFilterId, excludeModelId, excludedModelIdSet]);

    useEffect(() => {
        if (!interactionHooksEnabled) return;

        const handleImmediateModelHover = (event: Event) => {
            if (orbitInteractionActiveRef.current) return;
            if (supportSelectionAndHoverSuppressed) return;
            const customEvent = event as CustomEvent<{ modelId?: string | null }>;
            setImmediateModelHoverId(customEvent.detail?.modelId ?? null);
        };

        const handleOrbitStartOrChange = () => {
            orbitInteractionActiveRef.current = true;
            if (pendingSceneHoverClearFrameRef.current != null) {
                cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
                pendingSceneHoverClearFrameRef.current = null;
            }

            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            setMarqueeHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
        };

        const handleOrbitEnd = () => {
            orbitInteractionActiveRef.current = false;
        };

        const handleSupportMarqueeHover = (event: Event) => {
            if (supportSelectionAndHoverSuppressed) {
                setMarqueeHoveredSupportId((prev) => (prev === null ? prev : null));
                emitSupportModelPointerHover(null);
                return;
            }

            const customEvent = event as CustomEvent<{ supportId?: string | null; modelId?: string | null }>;
            const supportId = customEvent.detail?.supportId ?? null;
            const modelId = customEvent.detail?.modelId ?? null;

            setMarqueeHoveredSupportId(supportId);
            emitSupportModelPointerHover(modelId);
        };

        const forceOrbitInactive = () => {
            orbitInteractionActiveRef.current = false;
        };

        window.addEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
        window.addEventListener('picking-orbit-start', handleOrbitStartOrChange);
        window.addEventListener('picking-orbit-change', handleOrbitStartOrChange);
        window.addEventListener('picking-orbit-end', handleOrbitEnd);
        window.addEventListener('support-marquee-hover', handleSupportMarqueeHover as EventListener);
        window.addEventListener('pointerup', forceOrbitInactive, true);
        window.addEventListener('pointercancel', forceOrbitInactive, true);
        window.addEventListener('mouseup', forceOrbitInactive, true);
        window.addEventListener('contextmenu', forceOrbitInactive, true);
        window.addEventListener('blur', forceOrbitInactive);
        document.addEventListener('visibilitychange', forceOrbitInactive);
        return () => {
            window.removeEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
            window.removeEventListener('picking-orbit-start', handleOrbitStartOrChange);
            window.removeEventListener('picking-orbit-change', handleOrbitStartOrChange);
            window.removeEventListener('picking-orbit-end', handleOrbitEnd);
            window.removeEventListener('support-marquee-hover', handleSupportMarqueeHover as EventListener);
            window.removeEventListener('pointerup', forceOrbitInactive, true);
            window.removeEventListener('pointercancel', forceOrbitInactive, true);
            window.removeEventListener('mouseup', forceOrbitInactive, true);
            window.removeEventListener('contextmenu', forceOrbitInactive, true);
            window.removeEventListener('blur', forceOrbitInactive);
            document.removeEventListener('visibilitychange', forceOrbitInactive);
        };
    }, [interactionHooksEnabled, supportInteractionSuppressed, supportSelectionAndHoverSuppressed]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const refreshFromGlobals = () => {
            const w = window as any;
            const knotDragging = !!w.__knotGizmoDragging;
            const jointDragging = !!w.__jointGizmoDragging;
            const dragging = knotDragging || jointDragging;
            const knotGuardUntil = typeof w.__knotGizmoGuardUntil === 'number' ? w.__knotGizmoGuardUntil : 0;
            const jointGuardUntil = typeof w.__jointGizmoGuardUntil === 'number' ? w.__jointGizmoGuardUntil : 0;
            const guardUntil = Math.max(knotGuardUntil, jointGuardUntil);
            const now = Date.now();
            const guardActive = guardUntil > now;
            const nextActive = dragging || guardActive;
            setGizmoInteractionLockActive(nextActive);

            if (knotGizmoInteractionLockTimeoutRef.current != null) {
                window.clearTimeout(knotGizmoInteractionLockTimeoutRef.current);
                knotGizmoInteractionLockTimeoutRef.current = null;
            }

            if (!dragging && guardActive) {
                knotGizmoInteractionLockTimeoutRef.current = window.setTimeout(() => {
                    knotGizmoInteractionLockTimeoutRef.current = null;
                    refreshFromGlobals();
                }, Math.max(0, guardUntil - now + 1));
            }
        };

        const handleKnotGizmoInteractionLock = (event: Event) => {
            const detail = (event as CustomEvent<{ active?: boolean; guardUntil?: number }>).detail;
            if (typeof detail?.active !== 'boolean') {
                refreshFromGlobals();
                return;
            }

            const guardUntil = typeof detail.guardUntil === 'number' ? detail.guardUntil : 0;
            const now = Date.now();
            const nextActive = detail.active || guardUntil > now;
            setGizmoInteractionLockActive(nextActive);

            if (knotGizmoInteractionLockTimeoutRef.current != null) {
                window.clearTimeout(knotGizmoInteractionLockTimeoutRef.current);
                knotGizmoInteractionLockTimeoutRef.current = null;
            }

            if (!detail.active && guardUntil > now) {
                knotGizmoInteractionLockTimeoutRef.current = window.setTimeout(() => {
                    knotGizmoInteractionLockTimeoutRef.current = null;
                    refreshFromGlobals();
                }, Math.max(0, guardUntil - now + 1));
            }
        };

        const handleJointGizmoInteractionLock = (event: Event) => {
            const detail = (event as CustomEvent<{ active?: boolean; guardUntil?: number }>).detail;
            if (typeof detail?.active !== 'boolean') {
                refreshFromGlobals();
                return;
            }

            const w = window as any;
            if (typeof detail.active === 'boolean') {
                w.__jointGizmoDragging = detail.active;
            }
            if (typeof detail.guardUntil === 'number') {
                w.__jointGizmoGuardUntil = detail.guardUntil;
            }

            refreshFromGlobals();
        };

        refreshFromGlobals();
        window.addEventListener('knot-gizmo-interaction-lock', handleKnotGizmoInteractionLock as EventListener);
        window.addEventListener('joint-gizmo-interaction-lock', handleJointGizmoInteractionLock as EventListener);
        return () => {
            window.removeEventListener('knot-gizmo-interaction-lock', handleKnotGizmoInteractionLock as EventListener);
            window.removeEventListener('joint-gizmo-interaction-lock', handleJointGizmoInteractionLock as EventListener);
            if (knotGizmoInteractionLockTimeoutRef.current != null) {
                window.clearTimeout(knotGizmoInteractionLockTimeoutRef.current);
                knotGizmoInteractionLockTimeoutRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!supportSelectionAndHoverSuppressed) return;

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
        setMarqueeHoveredSupportId((prev) => (prev === null ? prev : null));
        setImmediateModelHoverId((prev) => (prev === null ? prev : null));
        emitSupportModelPointerHover(null);
    }, [supportSelectionAndHoverSuppressed]);

    useEffect(() => {
        return () => {
            if (pendingSceneHoverClearFrameRef.current != null) {
                cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
                pendingSceneHoverClearFrameRef.current = null;
            }
        };
    }, []);

    const effectiveHoverModelId = supportSelectionAndHoverSuppressed ? null : (immediateModelHoverId ?? hoverModelId);
    const hoveredCategoryForVisual = supportSelectionAndHoverSuppressed ? 'none' : state.hoveredCategory;
    const hoveredIdForVisual = supportSelectionAndHoverSuppressed ? null : state.hoveredId;

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const w = window as any;
        const knotGuardUntil = typeof w.__knotGizmoGuardUntil === 'number' ? w.__knotGizmoGuardUntil : 0;
        const jointGuardUntil = typeof w.__jointGizmoGuardUntil === 'number' ? w.__jointGizmoGuardUntil : 0;
        const guardUntil = Math.max(knotGuardUntil, jointGuardUntil);
        w.__supportRendererDebug = {
            supportInteractionSuppressed,
            supportSelectionAndHoverSuppressed,
            disableSelectionAndHover,
            gizmoInteractionLockActive,
            jointCategoryHoverSuppressed,
            knotGizmoDragging: !!w.__knotGizmoDragging,
            jointGizmoDragging: !!w.__jointGizmoDragging,
            knotGizmoGuardUntil: guardUntil,
            knotOnlyGuardUntil: knotGuardUntil,
            jointOnlyGuardUntil: jointGuardUntil,
            immediateModelHoverId,
            externalHoverModelId: hoverModelId,
            effectiveHoverModelId,
            sceneHoveredSupportId,
            marqueeHoveredSupportId,
            rawHoveredCategory: state.hoveredCategory,
            rawHoveredId: state.hoveredId,
            hoveredCategoryForVisual,
            hoveredIdForVisual,
        };
    }, [
        supportInteractionSuppressed,
        supportSelectionAndHoverSuppressed,
        disableSelectionAndHover,
        gizmoInteractionLockActive,
        jointCategoryHoverSuppressed,
        immediateModelHoverId,
        hoverModelId,
        effectiveHoverModelId,
        sceneHoveredSupportId,
        marqueeHoveredSupportId,
        state.hoveredCategory,
        state.hoveredId,
        hoveredCategoryForVisual,
        hoveredIdForVisual,
    ]);

    useSupportHistoryHandlers(interactionHooksEnabled);

    // Backfill Support Brace root/knot into global support state so raft + knot tools include them.
    useEffect(() => {
        if (!interactionHooksEnabled) return;

        const rootDiffers = (
            a: { modelId?: string; diameter: number; diskHeight: number; coneHeight: number; transform: { pos: { x: number; y: number; z: number } } },
            b: { modelId?: string; diameter: number; diskHeight: number; coneHeight: number; transform: { pos: { x: number; y: number; z: number } } },
        ) => {
            return a.modelId !== b.modelId
                || a.diameter !== b.diameter
                || a.diskHeight !== b.diskHeight
                || a.coneHeight !== b.coneHeight
                || a.transform.pos.x !== b.transform.pos.x
                || a.transform.pos.y !== b.transform.pos.y
                || a.transform.pos.z !== b.transform.pos.z;
        };

        const knotDiffers = (
            a: { t?: number; parentShaftId: string; diameter?: number; pos: { x: number; y: number; z: number } },
            b: { t?: number; parentShaftId: string; diameter?: number; pos: { x: number; y: number; z: number } },
        ) => {
            return a.parentShaftId !== b.parentShaftId
                || a.t !== b.t
                || a.diameter !== b.diameter
                || a.pos.x !== b.pos.x
                || a.pos.y !== b.pos.y
                || a.pos.z !== b.pos.z;
        };

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            const root = supportBraceState.roots[supportBrace.rootId];
            if (root) {
                const existingRoot = state.roots[root.id] as typeof root | undefined;
                if (!existingRoot || rootDiffers(existingRoot, root)) {
                    addRoot(root);
                }
            }

            const hostKnot = supportBraceState.knots[supportBrace.hostKnotId];
            if (hostKnot) {
                const existingKnot = state.knots[hostKnot.id] as typeof hostKnot | undefined;
                if (!existingKnot) {
                    addKnot(hostKnot);
                } else if (knotDiffers(existingKnot, hostKnot)) {
                    updateKnot(hostKnot);
                }
            }
        }

        const trunkRootIds = new Set(Object.values(state.trunks).map((trunk) => trunk.rootId));
        const supportBraceRootIds = new Set(Object.values(supportBraceState.supportBraces).map((supportBrace) => supportBrace.rootId));
        for (const rootId of Object.keys(state.roots)) {
            if (trunkRootIds.has(rootId)) continue;
            if (supportBraceRootIds.has(rootId)) continue;
            removeRootById(rootId);
        }
    }, [supportBraceState.supportBraces, supportBraceState.roots, supportBraceState.knots, state.roots, state.knots, state.trunks, interactionHooksEnabled]);

    // Enable joint dragging
    useJointInteraction(isInteractable);
    // Enable knot sliding
    useKnotInteraction(isInteractable);

    // Expose the group ref to parent components
    const groupRef = React.useRef<THREE.Group>(null);
    useImperativeHandle(ref, () => groupRef.current!);

    const clippingPlanes = useMemo(() => {
        const planes: THREE.Plane[] = [];

        if (clipLower != null) {
            planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
        }

        if (clipUpper != null) {
            planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
        }

        return planes;
    }, [clipLower, clipUpper]);

    const resolveBaseColor = useMemo(() => {
        const baseHex = '#a3a3a3';
        const hoverTintHex = '#ff8800';
        const hoveredColor = new THREE.Color(baseHex).lerp(new THREE.Color(hoverTintHex), 0.5).getStyle();

        return (modelId?: string) => {
            const isSelectedModelSupport = !!modelId && (modelId === activeModelId || selectedModelIdSet.has(modelId));
            if (isSelectedModelSupport) return '#ff8800';

            const isHoveredModelSupport = !!effectiveHoverModelId && !!modelId && modelId === effectiveHoverModelId;
            if (isHoveredModelSupport) return hoveredColor;

            return baseHex;
        };
    }, [activeModelId, effectiveHoverModelId, selectedModelIdSet]);

    const resolveSceneSupportColor = React.useCallback((modelId: string | undefined, supportId: string) => {
        if (hasSupportMultiSelection && !useMultiSelectionDetail && selectedSupportIdSet.has(supportId)) {
            return BULK_MULTI_SELECTED_COLOR;
        }

        return dimNonSelected ? '#666666' : resolveBaseColor(modelId);
    }, [hasSupportMultiSelection, useMultiSelectionDetail, selectedSupportIdSet, dimNonSelected, resolveBaseColor]);

    const resolveModelDropOffsetZ = React.useCallback((modelId?: string) => {
        if (!modelId) return 0;
        return modelDropOffsetsById?.[modelId] ?? 0;
    }, [modelDropOffsetsById]);

    const applyDropToVec3Like = React.useCallback((pos: { x: number; y: number; z: number }, modelId?: string) => {
        const zOffset = resolveModelDropOffsetZ(modelId);
        if (Math.abs(zOffset) < 1e-6) return pos;
        return {
            x: pos.x,
            y: pos.y,
            z: pos.z + zOffset,
        };
    }, [resolveModelDropOffsetZ]);

    const selectedTrunkIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && selectedCategory === 'trunk') {
            selected.add(selectedId);
            return selected;
        }

        for (const trunk of Object.values(state.trunks)) {
            const isTrunkSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(trunk.id)) || selectedId === trunk.id;
            const isChildSelected = hasSingleSelection
                ? trunk.segments.some((segment) =>
                    segment.id === selectedId
                    || segment.topJoint?.id === selectedId
                    || segment.bottomJoint?.id === selectedId,
                )
                : false;
            if (isTrunkSelected || isChildSelected) selected.add(trunk.id);
        }

        return selected;
    }, [state.trunks, selectedId, selectedCategory, selectedSupportIdSet, useMultiSelectionDetail]);

    const selectedBranchIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && selectedCategory === 'branch') {
            selected.add(selectedId);
            return selected;
        }

        for (const branch of Object.values(state.branches)) {
            const isBranchSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(branch.id)) || selectedId === branch.id;
            const isKnotSelected = hasSingleSelection ? branch.parentKnotId === selectedId : false;
            const isChildSelected = hasSingleSelection
                ? branch.segments.some((segment) =>
                    segment.id === selectedId
                    || segment.topJoint?.id === selectedId
                    || segment.bottomJoint?.id === selectedId,
                )
                : false;
            if (isBranchSelected || isKnotSelected || isChildSelected) selected.add(branch.id);
        }

        return selected;
    }, [state.branches, selectedId, selectedCategory, selectedSupportIdSet, useMultiSelectionDetail]);

    const selectedBraceIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && state.braces[selectedId]) {
            selected.add(selectedId);
            return selected;
        }

        for (const brace of Object.values(state.braces)) {
            const isBraceSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(brace.id)) || selectedId === brace.id;
            const isSegmentSelected = hasSingleSelection ? selectedId === `braceSegment:${brace.id}` : false;
            const isEndpointSelected = hasSingleSelection ? selectedId === brace.startKnotId || selectedId === brace.endKnotId : false;
            if (isBraceSelected || isSegmentSelected || isEndpointSelected) selected.add(brace.id);
        }

        return selected;
    }, [state.braces, selectedId, selectedSupportIdSet, useMultiSelectionDetail]);

    const selectedTwigIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && selectedCategory === 'twig') {
            selected.add(selectedId);
            return selected;
        }

        for (const twig of Object.values(state.twigs)) {
            const isTwigSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(twig.id)) || selectedId === twig.id;
            const isChildSelected = hasSingleSelection
                ? twig.segments.some((segment) =>
                    segment.id === selectedId
                    || segment.topJoint?.id === selectedId
                    || segment.bottomJoint?.id === selectedId,
                )
                : false;
            if (isTwigSelected || isChildSelected) selected.add(twig.id);
        }

        return selected;
    }, [state.twigs, selectedId, selectedCategory, selectedSupportIdSet, useMultiSelectionDetail]);

    const selectedStickIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && selectedCategory === 'stick') {
            selected.add(selectedId);
            return selected;
        }

        for (const stick of Object.values(state.sticks)) {
            const isStickSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(stick.id)) || selectedId === stick.id;
            const isChildSelected = hasSingleSelection
                ? stick.segments.some((segment) =>
                    segment.id === selectedId
                    || segment.topJoint?.id === selectedId
                    || segment.bottomJoint?.id === selectedId,
                )
                : false;
            if (isStickSelected || isChildSelected) selected.add(stick.id);
        }

        return selected;
    }, [state.sticks, selectedId, selectedCategory, selectedSupportIdSet, useMultiSelectionDetail]);

    const selectedSupportBraceIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && supportBraceState.supportBraces[selectedId]) {
            selected.add(selectedId);
            return selected;
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            const isSupportBraceSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(supportBrace.id)) || selectedId === supportBrace.id;
            const isHostKnotSelected = hasSingleSelection ? selectedId === supportBrace.hostKnotId : false;
            const isChildSelected = hasSingleSelection
                ? supportBrace.segments.some((segment) =>
                    segment.id === selectedId
                    || segment.topJoint?.id === selectedId
                    || segment.bottomJoint?.id === selectedId,
                )
                : false;
            if (isSupportBraceSelected || isHostKnotSelected || isChildSelected) selected.add(supportBrace.id);
        }

        return selected;
    }, [supportBraceState.supportBraces, selectedId, selectedSupportIdSet, useMultiSelectionDetail]);

    const selectedLeafIds = useMemo(() => {
        const selected = new Set<string>();
        const hasSingleSelection = !!selectedId;
        if (!hasSingleSelection && !useMultiSelectionDetail) return selected;

        if (hasSingleSelection && selectedCategory === 'leaf') {
            selected.add(selectedId);
            return selected;
        }

        for (const leaf of Object.values(state.leaves)) {
            const isLeafSelected = (useMultiSelectionDetail && selectedSupportIdSet.has(leaf.id)) || selectedId === leaf.id;
            const isKnotSelected = hasSingleSelection ? leaf.parentKnotId === selectedId : false;
            if (isLeafSelected || isKnotSelected) selected.add(leaf.id);
        }

        return selected;
    }, [state.leaves, selectedId, selectedCategory, selectedSupportIdSet, useMultiSelectionDetail]);

    const trunkShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        const rootsSettings = settings.roots;
        const baseFlare = settings.baseFlare;
        const baseFlareEnabled = baseFlare.enabled;

        for (const trunk of Object.values(state.trunks)) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;
            const root = state.roots[trunk.rootId];
            if (!root) continue;

            const shafts: InstancedShaft[] = [];

            const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
            const diskHeight = rootsSettings.diskHeightMm;
            const coneHeight = baseFlareEnabled ? baseFlare.heightMm : ((root as unknown as { height?: number }).height ?? 1.5);
            const effectiveConeHeight = baseFlareEnabled ? coneHeight : 0;
            let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, diskHeight + effectiveConeHeight));

            for (const segment of trunk.segments) {
                if (segment.type === 'bezier') {
                    if (segment.topJoint) {
                        currentStart = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
                    } else if (trunk.contactCone) {
                        const socketPos = getFinalSocketPosition(trunk.contactCone);
                        currentStart = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                    }
                    continue;
                }

                let endPoint: THREE.Vector3;
                if (segment.topJoint) {
                    endPoint = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
                } else if (trunk.contactCone) {
                    const socketPos = getFinalSocketPosition(trunk.contactCone);
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
                }

                shafts.push({
                    id: segment.id,
                    start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                    end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                    diameter: segment.diameter,
                    supportId: trunk.id,
                    modelId: trunk.modelId,
                });

                currentStart = endPoint;
            }

            if (shafts.length > 0) {
                result.set(trunk.id, {
                    supportId: trunk.id,
                    modelId: trunk.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [state.trunks, state.roots, settings.baseFlare, settings.roots, restrictToActiveModel, activeModelId]);

    const branchShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const branch of Object.values(state.branches)) {
            if (!isModelVisible(branch.modelId, branch.id)) continue;
            const parentKnot = state.knots[branch.parentKnotId];
            if (!parentKnot) continue;

            const shafts: InstancedShaft[] = [];
            let currentStart = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);

            for (const segment of branch.segments) {
                if (segment.type === 'bezier') {
                    if (segment.topJoint) {
                        currentStart = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
                    }
                    continue;
                }

                let endPoint: THREE.Vector3;
                if (segment.topJoint) {
                    endPoint = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
                } else if (branch.contactCone) {
                    const socketPos = getFinalSocketPosition(branch.contactCone);
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 5));
                }

                shafts.push({
                    id: segment.id,
                    start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                    end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                    diameter: segment.diameter,
                    supportId: branch.id,
                    modelId: branch.modelId,
                });

                currentStart = endPoint;
            }

            if (shafts.length > 0) {
                result.set(branch.id, {
                    supportId: branch.id,
                    modelId: branch.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [state.branches, state.knots, restrictToActiveModel, activeModelId]);

    const braceShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const brace of Object.values(state.braces)) {
            if (!isModelVisible(brace.modelId, brace.id)) continue;
            if (brace.curve?.type === 'bezier') continue;

            const startKnot = state.knots[brace.startKnotId];
            const endKnot = state.knots[brace.endKnotId];
            if (!startKnot || !endKnot) continue;

            const diameter = Math.max(0.001, brace.profile?.diameter ?? 1.0);
            result.set(brace.id, {
                supportId: brace.id,
                modelId: brace.modelId,
                shafts: [{
                    id: `braceSegment:${brace.id}`,
                    start: startKnot.pos,
                    end: endKnot.pos,
                    diameter,
                    supportId: brace.id,
                    modelId: brace.modelId,
                }],
            });
        }

        return result;
    }, [state.braces, state.knots, restrictToActiveModel, activeModelId]);

    const twigShaftsBySupport = useMemo(() => {
        if (!enableTwigSceneBatching) {
            return new Map<string, SupportShaftSet>();
        }

        const result = new Map<string, SupportShaftSet>();

        const getDiskTipCenter = (disk: ContactDisk) => {
            const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
            return {
                x: disk.pos.x + disk.surfaceNormal.x * thickness,
                y: disk.pos.y + disk.surfaceNormal.y * thickness,
                z: disk.pos.z + disk.surfaceNormal.z * thickness,
            };
        };

        for (const twig of Object.values(state.twigs)) {
            if (!isModelVisible(twig.modelId, twig.id)) continue;

            const shafts: InstancedShaft[] = [];
            let fullyBatchable = true;

            for (const segment of twig.segments) {
                let startPoint: THREE.Vector3;
                let endPoint: THREE.Vector3;
                let diameterStart = segment.diameter;
                let diameterEnd = segment.diameter;

                if (segment.bottomJoint) {
                    startPoint = new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z);
                } else {
                    const diskATipCenter = getDiskTipCenter(twig.contactDiskA);
                    startPoint = new THREE.Vector3(diskATipCenter.x, diskATipCenter.y, diskATipCenter.z);
                    diameterStart = twig.contactDiskA.contactDiameterMm;
                }

                if (segment.topJoint) {
                    endPoint = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
                } else {
                    const diskBTipCenter = getDiskTipCenter(twig.contactDiskB);
                    endPoint = new THREE.Vector3(diskBTipCenter.x, diskBTipCenter.y, diskBTipCenter.z);
                    diameterEnd = twig.contactDiskB.contactDiameterMm;
                }

                const isUniformDiameter = Math.abs(diameterStart - diameterEnd) < 1e-6;
                if (segment.type === 'bezier' || !isUniformDiameter) {
                    fullyBatchable = false;
                }

                if (segment.type !== 'bezier' && isUniformDiameter) {
                    shafts.push({
                        id: segment.id,
                        start: { x: startPoint.x, y: startPoint.y, z: startPoint.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        diameter: segment.diameter,
                        supportId: twig.id,
                        modelId: twig.modelId,
                    });
                }
            }

            if (fullyBatchable && shafts.length > 0) {
                result.set(twig.id, {
                    supportId: twig.id,
                    modelId: twig.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [state.twigs, restrictToActiveModel, activeModelId, enableTwigSceneBatching]);

    const stickShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const stick of Object.values(state.sticks)) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;

            const shafts: InstancedShaft[] = [];
            let fullyBatchable = true;

            for (const segment of stick.segments) {
                const startPoint = segment.bottomJoint
                    ? new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z)
                    : (() => {
                        const socket = getFinalSocketPosition(stick.contactConeA);
                        return new THREE.Vector3(socket.x, socket.y, socket.z);
                    })();

                const endPoint = segment.topJoint
                    ? new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z)
                    : (() => {
                        const socket = getFinalSocketPosition(stick.contactConeB);
                        return new THREE.Vector3(socket.x, socket.y, socket.z);
                    })();

                if (segment.type === 'bezier') {
                    fullyBatchable = false;
                } else {
                    shafts.push({
                        id: segment.id,
                        start: { x: startPoint.x, y: startPoint.y, z: startPoint.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        diameter: segment.diameter,
                        supportId: stick.id,
                        modelId: stick.modelId,
                    });
                }
            }

            if (fullyBatchable && shafts.length > 0) {
                result.set(stick.id, {
                    supportId: stick.id,
                    modelId: stick.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [state.sticks, restrictToActiveModel, activeModelId]);

    const supportBraceShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (!isModelVisible(supportBrace.modelId, supportBrace.id)) continue;

            const root = supportBraceState.roots[supportBrace.rootId];
            const hostKnot = supportBraceState.knots[supportBrace.hostKnotId];
            if (!root || !hostKnot) continue;

            const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
            const startZ = root.diskHeight + root.coneHeight;
            let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, startZ));

            const shafts: InstancedShaft[] = [];
            let fullyBatchable = true;

            supportBrace.segments.forEach((segment, index) => {
                const isLast = index === supportBrace.segments.length - 1;

                const endPoint = segment.topJoint
                    ? new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z)
                    : new THREE.Vector3(hostKnot.pos.x, hostKnot.pos.y, hostKnot.pos.z);

                const diameterStart = isLast ? supportBrace.profile.terminalStartDiameterMm : undefined;
                const diameterEnd = isLast ? supportBrace.profile.terminalEndDiameterMm : undefined;
                const isUniformDiameter = (diameterStart == null && diameterEnd == null)
                    || (diameterStart != null && diameterEnd != null && Math.abs(diameterStart - diameterEnd) < 1e-6);

                if (segment.type === 'bezier' || !isUniformDiameter) {
                    fullyBatchable = false;
                } else {
                    shafts.push({
                        id: segment.id,
                        start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        diameter: segment.diameter,
                        supportId: supportBrace.id,
                        modelId: supportBrace.modelId,
                    });
                }

                currentStart = endPoint;
            });

            if (fullyBatchable && shafts.length > 0) {
                result.set(supportBrace.id, {
                    supportId: supportBrace.id,
                    modelId: supportBrace.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [supportBraceState.supportBraces, supportBraceState.roots, supportBraceState.knots, restrictToActiveModel, activeModelId]);

    const segmentModelIdById = useMemo(() => {
        const map = new Map<string, string | undefined>();

        for (const trunk of Object.values(state.trunks)) {
            for (const segment of trunk.segments) {
                map.set(segment.id, trunk.modelId);
            }
        }

        for (const branch of Object.values(state.branches)) {
            for (const segment of branch.segments) {
                map.set(segment.id, branch.modelId);
            }
        }

        for (const twig of Object.values(state.twigs)) {
            for (const segment of twig.segments) {
                map.set(segment.id, twig.modelId);
            }
        }

        for (const stick of Object.values(state.sticks)) {
            for (const segment of stick.segments) {
                map.set(segment.id, stick.modelId);
            }
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            for (const segment of supportBrace.segments) {
                map.set(segment.id, supportBrace.modelId);
            }
        }

        return map;
    }, [state.trunks, state.branches, state.twigs, state.sticks, supportBraceState.supportBraces]);

    const modelIdByKnotId = useMemo(() => {
        const map = new Map<string, string | undefined>();

        for (const knot of Object.values(state.knots)) {
            const parentShaftId = knot.parentShaftId;
            let modelId: string | undefined;

            if (parentShaftId.startsWith('braceSegment:')) {
                const braceId = parentShaftId.slice('braceSegment:'.length);
                modelId = state.braces[braceId]?.modelId;
            } else if (parentShaftId.startsWith('leafCone:')) {
                const leafId = parentShaftId.slice('leafCone:'.length);
                modelId = state.leaves[leafId]?.modelId;
            } else {
                modelId = segmentModelIdById.get(parentShaftId);
            }

            map.set(knot.id, modelId);
        }

        for (const knot of Object.values(supportBraceState.knots)) {
            const parentShaftId = knot.parentShaftId;
            let modelId: string | undefined;

            if (parentShaftId.startsWith('braceSegment:')) {
                const braceId = parentShaftId.slice('braceSegment:'.length);
                modelId = state.braces[braceId]?.modelId;
            } else if (parentShaftId.startsWith('leafCone:')) {
                const leafId = parentShaftId.slice('leafCone:'.length);
                modelId = state.leaves[leafId]?.modelId;
            } else {
                modelId = segmentModelIdById.get(parentShaftId);
            }

            map.set(knot.id, modelId);
        }

        return map;
    }, [state.knots, state.braces, state.leaves, supportBraceState.knots, segmentModelIdById]);

    const contactConesBySupport = useMemo(() => {
        const result = new Map<string, { supportId: string; modelId?: string; cones: InstancedContactCone[] }>();

        for (const trunk of Object.values(state.trunks)) {
            const modelId = trunk.modelId;
            if (!isModelVisible(modelId)) continue;
            if (!trunk.contactCone) continue;

            result.set(trunk.id, {
                supportId: trunk.id,
                modelId,
                cones: [{
                    id: trunk.contactCone.id,
                    supportId: trunk.id,
                    modelId,
                    pos: trunk.contactCone.pos,
                    normal: trunk.contactCone.normal,
                    surfaceNormal: trunk.contactCone.surfaceNormal,
                    diskLengthOverride: trunk.contactCone.diskLengthOverride,
                    profile: trunk.contactCone.profile,
                }],
            });
        }

        for (const branch of Object.values(state.branches)) {
            const modelId = branch.modelId ?? modelIdByKnotId.get(branch.parentKnotId);
            if (!isModelVisible(modelId)) continue;
            if (!branch.contactCone) continue;

            result.set(branch.id, {
                supportId: branch.id,
                modelId,
                cones: [{
                    id: branch.contactCone.id,
                    supportId: branch.id,
                    modelId,
                    pos: branch.contactCone.pos,
                    normal: branch.contactCone.normal,
                    surfaceNormal: branch.contactCone.surfaceNormal,
                    diskLengthOverride: branch.contactCone.diskLengthOverride,
                    profile: branch.contactCone.profile,
                }],
            });
        }

        for (const stick of Object.values(state.sticks)) {
            const modelId = stick.modelId;
            if (!isModelVisible(modelId)) continue;

            result.set(stick.id, {
                supportId: stick.id,
                modelId,
                cones: [
                    {
                        id: stick.contactConeA.id,
                        supportId: stick.id,
                        modelId,
                        pos: stick.contactConeA.pos,
                        normal: stick.contactConeA.normal,
                        surfaceNormal: stick.contactConeA.surfaceNormal,
                        diskLengthOverride: stick.contactConeA.diskLengthOverride,
                        profile: stick.contactConeA.profile,
                    },
                    {
                        id: stick.contactConeB.id,
                        supportId: stick.id,
                        modelId,
                        pos: stick.contactConeB.pos,
                        normal: stick.contactConeB.normal,
                        surfaceNormal: stick.contactConeB.surfaceNormal,
                        diskLengthOverride: stick.contactConeB.diskLengthOverride,
                        profile: stick.contactConeB.profile,
                    },
                ],
            });
        }

        for (const leaf of Object.values(state.leaves)) {
            const modelId = leaf.modelId ?? modelIdByKnotId.get(leaf.parentKnotId);
            if (!isModelVisible(modelId)) continue;

            result.set(leaf.id, {
                supportId: leaf.id,
                modelId,
                cones: [{
                    id: leaf.contactCone.id,
                    supportId: leaf.id,
                    modelId,
                    pos: leaf.contactCone.pos,
                    normal: leaf.contactCone.normal,
                    surfaceNormal: leaf.contactCone.surfaceNormal,
                    diskLengthOverride: leaf.contactCone.diskLengthOverride,
                    profile: leaf.contactCone.profile,
                }],
            });
        }

        return result;
    }, [state.trunks, state.branches, state.sticks, state.leaves, modelIdByKnotId, restrictToActiveModel, activeModelId, modelFilterId, excludeModelId]);

    const trunkJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const trunk of Object.values(state.trunks)) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of trunk.segments) {
                if (segment.topJoint && !seen.has(segment.topJoint.id)) {
                    seen.add(segment.topJoint.id);
                    joints.push({
                        id: segment.topJoint.id,
                        pos: segment.topJoint.pos,
                        diameter: segment.topJoint.diameter,
                        supportId: trunk.id,
                        modelId: trunk.modelId,
                    });
                }
            }

            if (joints.length > 0) {
                result.set(trunk.id, {
                    supportId: trunk.id,
                    modelId: trunk.modelId,
                    joints,
                });
            }
        }

        return result;
    }, [state.trunks, restrictToActiveModel, activeModelId]);

    const branchJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const branch of Object.values(state.branches)) {
            if (!isModelVisible(branch.modelId, branch.id)) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of branch.segments) {
                if (segment.topJoint && !seen.has(segment.topJoint.id)) {
                    seen.add(segment.topJoint.id);
                    joints.push({
                        id: segment.topJoint.id,
                        pos: segment.topJoint.pos,
                        diameter: segment.topJoint.diameter,
                        supportId: branch.id,
                        modelId: branch.modelId,
                    });
                }
            }

            if (joints.length > 0) {
                result.set(branch.id, {
                    supportId: branch.id,
                    modelId: branch.modelId,
                    joints,
                });
            }
        }

        return result;
    }, [state.branches, restrictToActiveModel, activeModelId]);

    const twigJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const twig of Object.values(state.twigs)) {
            if (!isModelVisible(twig.modelId, twig.id)) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of twig.segments) {
                if (segment.bottomJoint && !seen.has(segment.bottomJoint.id)) {
                    seen.add(segment.bottomJoint.id);
                    joints.push({
                        id: segment.bottomJoint.id,
                        pos: segment.bottomJoint.pos,
                        diameter: segment.bottomJoint.diameter,
                        supportId: twig.id,
                        modelId: twig.modelId,
                    });
                }

                if (segment.topJoint && !seen.has(segment.topJoint.id)) {
                    seen.add(segment.topJoint.id);
                    joints.push({
                        id: segment.topJoint.id,
                        pos: segment.topJoint.pos,
                        diameter: segment.topJoint.diameter,
                        supportId: twig.id,
                        modelId: twig.modelId,
                    });
                }
            }

            if (joints.length > 0) {
                result.set(twig.id, {
                    supportId: twig.id,
                    modelId: twig.modelId,
                    joints,
                });
            }
        }

        return result;
    }, [state.twigs, restrictToActiveModel, activeModelId]);

    const stickJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const stick of Object.values(state.sticks)) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of stick.segments) {
                if (segment.bottomJoint && !seen.has(segment.bottomJoint.id)) {
                    seen.add(segment.bottomJoint.id);
                    joints.push({
                        id: segment.bottomJoint.id,
                        pos: segment.bottomJoint.pos,
                        diameter: segment.bottomJoint.diameter,
                        supportId: stick.id,
                        modelId: stick.modelId,
                    });
                }

                if (segment.topJoint && !seen.has(segment.topJoint.id)) {
                    seen.add(segment.topJoint.id);
                    joints.push({
                        id: segment.topJoint.id,
                        pos: segment.topJoint.pos,
                        diameter: segment.topJoint.diameter,
                        supportId: stick.id,
                        modelId: stick.modelId,
                    });
                }
            }

            if (joints.length > 0) {
                result.set(stick.id, {
                    supportId: stick.id,
                    modelId: stick.modelId,
                    joints,
                });
            }
        }

        return result;
    }, [state.sticks, restrictToActiveModel, activeModelId]);

    const supportBraceJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (!isModelVisible(supportBrace.modelId, supportBrace.id)) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of supportBrace.segments) {
                if (segment.topJoint && !seen.has(segment.topJoint.id)) {
                    seen.add(segment.topJoint.id);
                    joints.push({
                        id: segment.topJoint.id,
                        pos: segment.topJoint.pos,
                        diameter: segment.topJoint.diameter,
                        supportId: supportBrace.id,
                        modelId: supportBrace.modelId,
                    });
                }
            }

            if (joints.length > 0) {
                result.set(supportBrace.id, {
                    supportId: supportBrace.id,
                    modelId: supportBrace.modelId,
                    joints,
                });
            }
        }

        return result;
    }, [supportBraceState.supportBraces, restrictToActiveModel, activeModelId]);

    const sceneBatchedJointGroups = useMemo(() => {
        const grouped = new Map<string, InstancedJoint[]>();

        const pushJoints = (color: string, joints: InstancedJoint[]) => {
            const existing = grouped.get(color);
            const adjusted = joints.map((joint) => ({
                ...joint,
                pos: applyDropToVec3Like(joint.pos, joint.modelId),
                diameter: Math.max(0.001, joint.diameter - SCENE_JOINT_DIAMETER_BLEND_MM),
            }));
            if (existing) {
                existing.push(...adjusted);
            } else {
                grouped.set(color, adjusted);
            }
        };

        for (const trunk of Object.values(state.trunks)) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;
            if (selectedTrunkIds.has(trunk.id)) continue;
            const jointSet = trunkJointsBySupport.get(trunk.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(trunk.modelId, trunk.id);
            pushJoints(color, jointSet.joints);
        }

        for (const branch of Object.values(state.branches)) {
            if (!isModelVisible(branch.modelId, branch.id)) continue;
            if (selectedBranchIds.has(branch.id)) continue;
            const jointSet = branchJointsBySupport.get(branch.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(branch.modelId, branch.id);
            pushJoints(color, jointSet.joints);
        }

        for (const twig of Object.values(state.twigs)) {
            if (!isModelVisible(twig.modelId, twig.id)) continue;
            if (selectedTwigIds.has(twig.id)) continue;
            const jointSet = twigJointsBySupport.get(twig.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(twig.modelId, twig.id);
            pushJoints(color, jointSet.joints);
        }

        for (const stick of Object.values(state.sticks)) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;
            if (selectedStickIds.has(stick.id)) continue;
            const jointSet = stickJointsBySupport.get(stick.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(stick.modelId, stick.id);
            pushJoints(color, jointSet.joints);
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (!isModelVisible(supportBrace.modelId, supportBrace.id)) continue;
            if (selectedSupportBraceIds.has(supportBrace.id)) continue;
            const jointSet = supportBraceJointsBySupport.get(supportBrace.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(supportBrace.modelId, supportBrace.id);
            pushJoints(color, jointSet.joints);
        }

        return Array.from(grouped.entries()).map(([color, joints]) => ({ color, joints }));
    }, [
        disableSelectionAndHover,
        state.trunks,
        state.branches,
        state.twigs,
        state.sticks,
        supportBraceState.supportBraces,
        restrictToActiveModel,
        activeModelId,
        selectedTrunkIds,
        selectedBranchIds,
        selectedTwigIds,
        selectedStickIds,
        selectedSupportBraceIds,
        trunkJointsBySupport,
        branchJointsBySupport,
        twigJointsBySupport,
        stickJointsBySupport,
        supportBraceJointsBySupport,
        applyDropToVec3Like,
        dimNonSelected,
        resolveBaseColor,
        resolveSceneSupportColor,
    ]);

    const sceneBatchedTwigShaftGroups = useMemo(() => {
        if (!enableTwigSceneBatching) {
            return [] as Array<{ modelId?: string; shafts: InstancedShaft[] }>;
        }

        const grouped = new Map<string, { modelId?: string; shafts: InstancedShaft[] }>();

        for (const twig of Object.values(state.twigs)) {
            if (!isModelVisible(twig.modelId, twig.id)) continue;
            const shaftSet = twigShaftsBySupport.get(twig.id);
            if (!shaftSet) continue;
            if (selectedTwigIds.has(twig.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const existing = grouped.get(modelKey) ?? { modelId: shaftSet.modelId, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));
            if (existing.shafts.length > 0) grouped.set(modelKey, existing);
        }

        return Array.from(grouped.values());
    }, [state.twigs, twigShaftsBySupport, selectedTwigIds, restrictToActiveModel, activeModelId, applyDropToVec3Like, enableTwigSceneBatching]);

    const sceneBatchedStickShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; shafts: InstancedShaft[] }>();

        for (const stick of Object.values(state.sticks)) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;
            const shaftSet = stickShaftsBySupport.get(stick.id);
            if (!shaftSet) continue;
            if (selectedStickIds.has(stick.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const existing = grouped.get(modelKey) ?? { modelId: shaftSet.modelId, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));
            if (existing.shafts.length > 0) grouped.set(modelKey, existing);
        }

        return Array.from(grouped.values());
    }, [state.sticks, stickShaftsBySupport, selectedStickIds, restrictToActiveModel, activeModelId, applyDropToVec3Like]);

    const sceneBatchedSupportBraceShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; shafts: InstancedShaft[] }>();

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (!isModelVisible(supportBrace.modelId, supportBrace.id)) continue;
            const shaftSet = supportBraceShaftsBySupport.get(supportBrace.id);
            if (!shaftSet) continue;
            if (selectedSupportBraceIds.has(supportBrace.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const existing = grouped.get(modelKey) ?? { modelId: shaftSet.modelId, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));
            if (existing.shafts.length > 0) grouped.set(modelKey, existing);
        }

        return Array.from(grouped.values());
    }, [supportBraceState.supportBraces, supportBraceShaftsBySupport, selectedSupportBraceIds, restrictToActiveModel, activeModelId, applyDropToVec3Like]);

    const sceneBatchedBraceShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; debugSection?: 'initial' | 'repeating' | null; shafts: InstancedShaft[] }>();

        const sectionColorsEnabled = !!settings.autoBracing.debugSectionColorsEnabled;
        const splitByDebugSection = sectionColorsEnabled && !dimNonSelected;

        for (const brace of Object.values(state.braces)) {
            if (!isModelVisible(brace.modelId, brace.id)) continue;
            const shaftSet = braceShaftsBySupport.get(brace.id);
            if (!shaftSet) continue;

            if (selectedBraceIds.has(brace.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const debugSection = splitByDebugSection
                ? (brace.debugSection ?? null)
                : null;
            const groupKey = debugSection ? `${modelKey}:${debugSection}` : modelKey;

            const existing = grouped.get(groupKey);
            if (existing) {
                existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                    ...shaft,
                    start: applyDropToVec3Like(shaft.start, shaft.modelId),
                    end: applyDropToVec3Like(shaft.end, shaft.modelId),
                })));
            } else {
                grouped.set(groupKey, {
                    modelId: shaftSet.modelId,
                    debugSection,
                    shafts: shaftSet.shafts.map((shaft) => ({
                        ...shaft,
                        start: applyDropToVec3Like(shaft.start, shaft.modelId),
                        end: applyDropToVec3Like(shaft.end, shaft.modelId),
                    })),
                });
            }
        }

        return Array.from(grouped.values());
    }, [state.braces, braceShaftsBySupport, selectedBraceIds, restrictToActiveModel, activeModelId, applyDropToVec3Like, settings.autoBracing.debugSectionColorsEnabled, dimNonSelected]);

    const sceneBatchedTrunkShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; shafts: InstancedShaft[] }>();

        for (const trunk of Object.values(state.trunks)) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;
            const shaftSet = trunkShaftsBySupport.get(trunk.id);
            if (!shaftSet) continue;

            if (selectedTrunkIds.has(trunk.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const existing = grouped.get(modelKey) ?? { modelId: shaftSet.modelId, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));

            if (existing.shafts.length > 0) grouped.set(modelKey, existing);
        }

        return Array.from(grouped.values());
    }, [state.trunks, trunkShaftsBySupport, selectedTrunkIds, restrictToActiveModel, activeModelId, applyDropToVec3Like]);

    const sceneBatchedBranchShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; shafts: InstancedShaft[] }>();

        for (const branch of Object.values(state.branches)) {
            if (!isModelVisible(branch.modelId)) continue;
            const shaftSet = branchShaftsBySupport.get(branch.id);
            if (!shaftSet) continue;

            if (selectedBranchIds.has(branch.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const existing = grouped.get(modelKey) ?? { modelId: shaftSet.modelId, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));

            if (existing.shafts.length > 0) {
                grouped.set(modelKey, existing);
            }
        }

        return Array.from(grouped.values());
    }, [state.branches, branchShaftsBySupport, selectedBranchIds, restrictToActiveModel, activeModelId, applyDropToVec3Like]);

    const sceneBatchedTrunkRootGroups = useMemo(() => {
        if (hidePlateContactPrimitivesEffective) return [] as Array<{ color: string; roots: InstancedRoot[] }>;

        const grouped = new Map<string, InstancedRoot[]>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const trunk of Object.values(state.trunks)) {
            if (!isModelVisible(trunk.modelId)) continue;
            if (selectedTrunkIds.has(trunk.id)) continue;

            const root = state.roots[trunk.rootId];
            if (!root) continue;

            const shaftDiameter = Math.max(0.001, trunk.segments[0]?.diameter ?? 1.5);
            const topRadius = shaftDiameter / 2;
            const bottomRadius = Math.max(0.001, root.diameter / 2);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

            const color = resolveSceneSupportColor(trunk.modelId, trunk.id);
            const rootsForColor = grouped.get(color) ?? [];
            rootsForColor.push({
                id: root.id,
                supportId: trunk.id,
                modelId: trunk.modelId,
                basePos: applyDropToVec3Like({
                    x: root.transform.pos.x,
                    y: root.transform.pos.y,
                    z: root.transform.pos.z + verticalOffset,
                }, trunk.modelId),
                bottomRadius,
                topRadius,
                effectiveDiskHeight,
                coneHeight: Math.max(0, root.coneHeight),
            });

            if (rootsForColor.length > 0) {
                grouped.set(color, rootsForColor);
            }
        }

        return Array.from(grouped.entries()).map(([color, roots]) => ({ color, roots }));
    }, [
        hidePlateContactPrimitivesEffective,
        raftSettings.bottomMode,
        raftSettings.thickness,
        state.trunks,
        state.roots,
        dimNonSelected,
        resolveBaseColor,
        resolveSceneSupportColor,
        applyDropToVec3Like,
        selectedTrunkIds,
        restrictToActiveModel,
        activeModelId,
    ]);

    const sceneBatchedSupportBraceRootGroups = useMemo(() => {
        if (hidePlateContactPrimitivesEffective) return [] as Array<{ color: string; roots: InstancedRoot[] }>;

        const grouped = new Map<string, InstancedRoot[]>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (!isModelVisible(supportBrace.modelId, supportBrace.id)) continue;
            if (selectedSupportBraceIds.has(supportBrace.id)) continue;

            const root = supportBraceState.roots[supportBrace.rootId];
            if (!root) continue;

            const shaftDiameter = Math.max(
                0.001,
                supportBrace.segments[0]?.diameter ?? supportBrace.profile.bodyDiameterMm,
            );
            const topRadius = shaftDiameter / 2;
            const bottomRadius = Math.max(0.001, root.diameter / 2);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

            const color = resolveSceneSupportColor(supportBrace.modelId, supportBrace.id);
            const rootsForColor = grouped.get(color) ?? [];
            rootsForColor.push({
                id: root.id,
                supportId: supportBrace.id,
                modelId: supportBrace.modelId,
                basePos: applyDropToVec3Like({
                    x: root.transform.pos.x,
                    y: root.transform.pos.y,
                    z: root.transform.pos.z + verticalOffset,
                }, supportBrace.modelId),
                bottomRadius,
                topRadius,
                effectiveDiskHeight,
                coneHeight: Math.max(0, root.coneHeight),
            });

            if (rootsForColor.length > 0) {
                grouped.set(color, rootsForColor);
            }
        }

        return Array.from(grouped.entries()).map(([color, roots]) => ({ color, roots }));
    }, [
        hidePlateContactPrimitivesEffective,
        raftSettings.bottomMode,
        raftSettings.thickness,
        supportBraceState.supportBraces,
        supportBraceState.roots,
        selectedSupportBraceIds,
        dimNonSelected,
        resolveBaseColor,
        resolveSceneSupportColor,
        applyDropToVec3Like,
        restrictToActiveModel,
        activeModelId,
    ]);

    const sceneBatchedContactConeGroups = useMemo(() => {
        const grouped = new Map<string, InstancedContactCone[]>();

        const pushCone = (color: string, cone: InstancedContactCone) => {
            const conesForColor = grouped.get(color) ?? [];
            conesForColor.push(cone);
            if (conesForColor.length > 0) grouped.set(color, conesForColor);
        };

        for (const trunk of Object.values(state.trunks)) {
            if (selectedTrunkIds.has(trunk.id)) continue;
            const coneSet = contactConesBySupport.get(trunk.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, trunk.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        for (const branch of Object.values(state.branches)) {
            if (selectedBranchIds.has(branch.id)) continue;
            const coneSet = contactConesBySupport.get(branch.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, branch.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        for (const stick of Object.values(state.sticks)) {
            if (selectedStickIds.has(stick.id)) continue;
            const coneSet = contactConesBySupport.get(stick.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, stick.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        for (const leaf of Object.values(state.leaves)) {
            if (selectedLeafIds.has(leaf.id)) continue;
            const coneSet = contactConesBySupport.get(leaf.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, leaf.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        return Array.from(grouped.entries()).map(([color, cones]) => ({ color, cones }));
    }, [
        state.trunks,
        state.branches,
        state.sticks,
        state.leaves,
        contactConesBySupport,
        selectedTrunkIds,
        selectedBranchIds,
        selectedStickIds,
        selectedLeafIds,
        applyDropToVec3Like,
        dimNonSelected,
        resolveBaseColor,
        resolveSceneSupportColor,
    ]);

    const sceneBatchedShaftInstanceCount = useMemo(() => {
        const countGroups = [
            sceneBatchedTrunkShaftGroups,
            sceneBatchedBranchShaftGroups,
            sceneBatchedBraceShaftGroups,
            sceneBatchedTwigShaftGroups,
            sceneBatchedStickShaftGroups,
            sceneBatchedSupportBraceShaftGroups,
        ];

        let total = 0;
        for (const groups of countGroups) {
            for (const group of groups) {
                total += group.shafts.length;
            }
        }

        return total;
    }, [
        sceneBatchedTrunkShaftGroups,
        sceneBatchedBranchShaftGroups,
        sceneBatchedBraceShaftGroups,
        sceneBatchedTwigShaftGroups,
        sceneBatchedStickShaftGroups,
        sceneBatchedSupportBraceShaftGroups,
    ]);

    const sceneBatchedShaftRadialSegments = sceneBatchedShaftInstanceCount >= BATCHED_SHAFT_HIGH_INSTANCE_THRESHOLD
        ? BATCHED_SHAFT_LOW_RADIAL_SEGMENTS
        : BATCHED_SHAFT_RADIAL_SEGMENTS;

    const hoveredSupportShaftSet = useMemo(() => {
        if (!isInteractable) return null;

        const hoveredSupportId = marqueeHoveredSupportId ?? sceneHoveredSupportId ?? (hoveredCategoryForVisual === 'support' ? hoveredIdForVisual : null);
        if (!hoveredSupportId) return null;

        const trunkSet = trunkShaftsBySupport.get(hoveredSupportId);
        if (trunkSet) return trunkSet;

        const branchSet = branchShaftsBySupport.get(hoveredSupportId);
        if (branchSet) return branchSet;

        const braceSet = braceShaftsBySupport.get(hoveredSupportId);
        if (braceSet) return braceSet;

        const twigSet = twigShaftsBySupport.get(hoveredSupportId);
        if (twigSet) return twigSet;

        const stickSet = stickShaftsBySupport.get(hoveredSupportId);
        if (stickSet) return stickSet;

        const supportBraceSet = supportBraceShaftsBySupport.get(hoveredSupportId);
        if (supportBraceSet) return supportBraceSet;

        return null;
    }, [isInteractable, marqueeHoveredSupportId, sceneHoveredSupportId, hoveredCategoryForVisual, hoveredIdForVisual, trunkShaftsBySupport, branchShaftsBySupport, braceShaftsBySupport, twigShaftsBySupport, stickShaftsBySupport, supportBraceShaftsBySupport]);

    const hoveredSupportOverlayShafts = useMemo(() => {
        if (!hoveredSupportShaftSet) return [] as InstancedShaft[];

        return hoveredSupportShaftSet.shafts.map((shaft) => ({
            ...shaft,
            start: applyDropToVec3Like(shaft.start, shaft.modelId),
            end: applyDropToVec3Like(shaft.end, shaft.modelId),
            diameter: shaft.diameter * 1.02,
        }));
    }, [hoveredSupportShaftSet, applyDropToVec3Like]);

    const hoveredSupportConeSet = useMemo(() => {
        if (!isInteractable) return null;

        const hoveredSupportId = marqueeHoveredSupportId ?? sceneHoveredSupportId ?? (hoveredCategoryForVisual === 'support' ? hoveredIdForVisual : null);
        if (!hoveredSupportId) return null;

        return contactConesBySupport.get(hoveredSupportId) ?? null;
    }, [isInteractable, marqueeHoveredSupportId, sceneHoveredSupportId, hoveredCategoryForVisual, hoveredIdForVisual, contactConesBySupport]);

    const hoveredSupportOverlayCones = useMemo(() => {
        if (!hoveredSupportConeSet) return [] as InstancedContactCone[];
        return hoveredSupportConeSet.cones.map((cone) => ({
            ...cone,
            pos: applyDropToVec3Like(cone.pos, cone.modelId),
        }));
    }, [hoveredSupportConeSet, applyDropToVec3Like]);

    const hoveredSupportJointSet = useMemo(() => {
        if (!isInteractable) return null;

        const hoveredSupportId = marqueeHoveredSupportId ?? sceneHoveredSupportId ?? (hoveredCategoryForVisual === 'support' ? hoveredIdForVisual : null);
        if (!hoveredSupportId) return null;

        const trunkSet = trunkJointsBySupport.get(hoveredSupportId);
        if (trunkSet) return trunkSet;

        const branchSet = branchJointsBySupport.get(hoveredSupportId);
        if (branchSet) return branchSet;

        const twigSet = twigJointsBySupport.get(hoveredSupportId);
        if (twigSet) return twigSet;

        const stickSet = stickJointsBySupport.get(hoveredSupportId);
        if (stickSet) return stickSet;

        const supportBraceSet = supportBraceJointsBySupport.get(hoveredSupportId);
        if (supportBraceSet) return supportBraceSet;

        return null;
    }, [
        isInteractable,
        marqueeHoveredSupportId,
        sceneHoveredSupportId,
        hoveredCategoryForVisual,
        hoveredIdForVisual,
        trunkJointsBySupport,
        branchJointsBySupport,
        twigJointsBySupport,
        stickJointsBySupport,
        supportBraceJointsBySupport,
    ]);

    const hoveredSupportOverlayJoints = useMemo(() => {
        if (!hoveredSupportJointSet) return [] as InstancedJoint[];

        return hoveredSupportJointSet.joints.map((joint) => ({
            ...joint,
            pos: applyDropToVec3Like(joint.pos, joint.modelId),
            diameter: joint.diameter * 1.06,
        }));
    }, [hoveredSupportJointSet, applyDropToVec3Like]);

    const handleSceneBatchedShaftClick = React.useCallback((shaft: InstancedShaft, event: { nativeEvent?: Event }) => {
        if (!isPointerInteractable) return;
        if (isPreparePointerInteractable) {
            emitSupportModelPointerSelect(shaft.modelId ?? null);
            return;
        }

        if (supportSelectionAndHoverSuppressed) {
            const e = event as unknown as { point?: THREE.Vector3 | { x: number; y: number; z: number } };
            const point = e.point
                ? { x: (e.point as any).x, y: (e.point as any).y, z: (e.point as any).z }
                : null;

            window.dispatchEvent(new CustomEvent('shaft-click', {
                detail: {
                    segmentId: shaft.id,
                    point,
                    intersection: event,
                },
            }));
            return;
        }

        if (!shaft.supportId) return;
        handleSupportClick(event, shaft.supportId, isInteractable);
    }, [isPointerInteractable, isPreparePointerInteractable, isInteractable, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedShaftPointerMove = React.useCallback((shaft: InstancedShaft, event: { point?: { x: number; y: number; z: number } | THREE.Vector3 } | null) => {
        if (!isPointerInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (supportSelectionAndHoverSuppressed) {
            window.dispatchEvent(new CustomEvent('shaft-hover', {
                detail: {
                    segmentId: shaft.id,
                    point: null,
                    intersection: null,
                },
            }));
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
            return;
        }

        if (mode === 'support') {
            const point = event?.point
                ? { x: (event.point as any).x, y: (event.point as any).y, z: (event.point as any).z }
                : null;

            window.dispatchEvent(new CustomEvent('shaft-hover', {
                detail: {
                    segmentId: shaft.id,
                    point,
                    intersection: event,
                },
            }));
        }

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = shaft.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(shaft.modelId ?? null);
    }, [isPointerInteractable, mode, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedShaftPointerOut = React.useCallback((entity: { id: string } | null) => {
        if (!isPointerInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (mode === 'support') {
            window.dispatchEvent(new CustomEvent('shaft-leave', {
                detail: { segmentId: entity?.id ?? null },
            }));
        }

        if (supportSelectionAndHoverSuppressed) {
            window.dispatchEvent(new CustomEvent('shaft-leave', {
                detail: { segmentId: null },
            }));
            return;
        }

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
        }

        pendingSceneHoverClearFrameRef.current = requestAnimationFrame(() => {
            pendingSceneHoverClearFrameRef.current = null;
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
        });
    }, [isPointerInteractable, mode, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedRootClick = React.useCallback((root: InstancedRoot, event: { nativeEvent?: Event }) => {
        if (!isPointerInteractable) return;
        if (isPreparePointerInteractable) {
            emitSupportModelPointerSelect(root.modelId ?? null);
            return;
        }
        if (supportSelectionAndHoverSuppressed) return;
        if (!root.supportId) return;
        handleSupportClick(event, root.supportId, isInteractable);
    }, [isPointerInteractable, isPreparePointerInteractable, isInteractable, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedRootPointerMove = React.useCallback((root: InstancedRoot) => {
        if (!isPointerInteractable) return;
        if (orbitInteractionActiveRef.current) return;
        if (supportSelectionAndHoverSuppressed) {
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
            return;
        }

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = root.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(root.modelId ?? null);
    }, [isPointerInteractable, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedConeClick = React.useCallback((cone: InstancedContactCone, event: { nativeEvent?: Event }) => {
        if (!isPointerInteractable) return;
        if (isPreparePointerInteractable) {
            emitSupportModelPointerSelect(cone.modelId ?? null);
            return;
        }
        if (supportSelectionAndHoverSuppressed) return;
        if (!cone.supportId) return;
        handleSupportClick(event, cone.supportId, isInteractable);
    }, [isPointerInteractable, isPreparePointerInteractable, isInteractable, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedConePointerMove = React.useCallback((cone: InstancedContactCone) => {
        if (!isPointerInteractable) return;
        if (orbitInteractionActiveRef.current) return;
        if (supportSelectionAndHoverSuppressed) {
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
            return;
        }

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = cone.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(cone.modelId ?? null);
    }, [isPointerInteractable, supportSelectionAndHoverSuppressed]);

    const handleSceneBatchedJointClick = React.useCallback((joint: InstancedJoint, event: { nativeEvent?: Event }) => {
        if (!isPointerInteractable) return;
        if (isPreparePointerInteractable) {
            emitSupportModelPointerSelect(joint.modelId ?? null);
            return;
        }
        if (supportInteractionSuppressed) return;
        if (!joint.supportId) return;
        handleSupportClick(event, joint.supportId, isInteractable);
    }, [isPointerInteractable, isPreparePointerInteractable, isInteractable, supportInteractionSuppressed]);

    const handleSceneBatchedJointPointerMove = React.useCallback((joint: InstancedJoint) => {
        if (!isPointerInteractable) return;
        if (orbitInteractionActiveRef.current) return;
        if (supportInteractionSuppressed) {
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
            return;
        }

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = joint.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(joint.modelId ?? null);
    }, [isPointerInteractable, supportInteractionSuppressed]);

    useEffect(() => {
        const root = groupRef.current;
        if (!root) return;

        const nextClippingPlanes = clippingPlanes.length > 0 ? clippingPlanes : null;

        const applyMaterialClipping = (material: THREE.Material) => {
            const clipMaterial = material as THREE.Material & { clippingPlanes?: THREE.Plane[] | null };
            if (clipMaterial.clippingPlanes === nextClippingPlanes) return;
            clipMaterial.clippingPlanes = nextClippingPlanes;
            material.needsUpdate = true;
        };

        const applyMaterialGhostOpacity = (material: THREE.Material) => {
            const renderMaterial = material as THREE.Material & {
                transparent?: boolean;
                opacity?: number;
                depthWrite?: boolean;
            };

            let changed = false;

            if (renderMaterial.transparent !== ghostTransparent) {
                renderMaterial.transparent = ghostTransparent;
                changed = true;
            }

            if (typeof renderMaterial.opacity === 'number' && Math.abs(renderMaterial.opacity - ghostOpacityClamped) > 1e-4) {
                renderMaterial.opacity = ghostOpacityClamped;
                changed = true;
            }

            if (typeof renderMaterial.depthWrite === 'boolean') {
                const nextDepthWrite = !ghostTransparent;
                if (renderMaterial.depthWrite !== nextDepthWrite) {
                    renderMaterial.depthWrite = nextDepthWrite;
                    changed = true;
                }
            }

            if (changed) material.needsUpdate = true;
        };

        const applyMeshRenderOrder = (mesh: THREE.Mesh) => {
            if (mesh.renderOrder !== ghostRenderOrder) {
                mesh.renderOrder = ghostRenderOrder;
            }
        };

        root.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.material) return;
            applyMeshRenderOrder(mesh);

            if (Array.isArray(mesh.material)) {
                mesh.material.forEach((material) => {
                    applyMaterialClipping(material);
                    applyMaterialGhostOpacity(material);
                });
            } else {
                applyMaterialClipping(mesh.material);
                applyMaterialGhostOpacity(mesh.material);
            }
        });
    }, [clippingPlanes, ghostOpacityClamped, ghostTransparent, ghostRenderOrder]);

    return (
        <group ref={groupRef}>
            {/* Joint Creation Manager */}
            <JointCreationManager />

            {/* Joint Gizmo */}
            <JointGizmo />
            {/* Knot Gizmo (for sliding knots along shafts) */}
            <KnotGizmo />
            <BezierGizmoManager />

            {/* Render Trunks */}
            {sceneBatchedTrunkShaftGroups.map((group) => (
                <group key={`scene-trunk-batch:${group.modelId ?? 'none'}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={dimNonSelected ? '#666666' : resolveBaseColor(group.modelId)}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {sceneBatchedJointGroups.map((group) => (
                <InstancedJointGroup
                    key={`scene-joint-batch:${group.color}:${group.joints.length}`}
                    joints={group.joints}
                    color={group.color}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                    heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                    onJointClick={isPointerInteractable ? handleSceneBatchedJointClick : undefined}
                    onJointPointerMove={isPointerInteractable ? handleSceneBatchedJointPointerMove : undefined}
                    onJointPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {sceneBatchedTrunkRootGroups.map((group) => (
                <InstancedRootsGroup
                    key={`scene-trunk-root-batch:${group.color}:${group.roots.length}`}
                    roots={group.roots}
                    color={group.color}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onRootClick={isPointerInteractable ? handleSceneBatchedRootClick : undefined}
                    onRootPointerMove={isPointerInteractable ? handleSceneBatchedRootPointerMove : undefined}
                    onRootPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {sceneBatchedSupportBraceRootGroups.map((group) => (
                <InstancedRootsGroup
                    key={`scene-support-brace-root-batch:${group.color}:${group.roots.length}`}
                    roots={group.roots}
                    color={group.color}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onRootClick={isPointerInteractable ? handleSceneBatchedRootClick : undefined}
                    onRootPointerMove={isPointerInteractable ? handleSceneBatchedRootPointerMove : undefined}
                    onRootPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {sceneBatchedContactConeGroups.map((group) => (
                <InstancedContactConeGroup
                    key={`scene-cone-batch:${group.color}:${group.cones.length}`}
                    cones={group.cones}
                    color={group.color}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onConeClick={isPointerInteractable ? handleSceneBatchedConeClick : undefined}
                    onConePointerMove={isPointerInteractable ? handleSceneBatchedConePointerMove : undefined}
                    onConePointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {hoveredSupportOverlayShafts.length > 0 && hoveredSupportShaftSet && (
                <InstancedShaftGroup
                    key={`scene-hover-overlay:${hoveredSupportShaftSet.supportId}:${hoveredSupportOverlayShafts.length}`}
                    shafts={hoveredSupportOverlayShafts}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportShaftSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.3}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                    onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {hoveredSupportOverlayCones.length > 0 && hoveredSupportConeSet && (
                <InstancedContactConeGroup
                    key={`scene-cone-hover-overlay:${hoveredSupportConeSet.supportId}:${hoveredSupportOverlayCones.length}`}
                    cones={hoveredSupportOverlayCones}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportConeSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.3}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onConeClick={isPointerInteractable ? handleSceneBatchedConeClick : undefined}
                    onConePointerMove={isPointerInteractable ? handleSceneBatchedConePointerMove : undefined}
                    onConePointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {hoveredSupportOverlayJoints.length > 0 && hoveredSupportJointSet && (
                <InstancedJointGroup
                    key={`scene-joint-hover-overlay:${hoveredSupportJointSet.supportId}:${hoveredSupportOverlayJoints.length}`}
                    joints={hoveredSupportOverlayJoints}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportJointSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.3}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                    heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                    onJointClick={isPointerInteractable ? handleSceneBatchedJointClick : undefined}
                    onJointPointerMove={isPointerInteractable ? handleSceneBatchedJointPointerMove : undefined}
                    onJointPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {Object.values(state.trunks).map(trunk => {
                if (!isModelVisible(trunk.modelId, trunk.id)) return null;
                const root = state.roots[trunk.rootId];
                if (!root) return null;

                const effectiveSelected = selectedTrunkIds.has(trunk.id);
                const hasBezierSegment = trunk.segments.some((s) => s.type === 'bezier');
                const renderDetailedTrunk = effectiveSelected || hasBezierSegment;
                if (!renderDetailedTrunk) return null;

                const isTrunkHovered = (hoveredCategoryForVisual === 'support' && hoveredIdForVisual === trunk.id)
                    || sceneHoveredSupportId === trunk.id
                    || marqueeHoveredSupportId === trunk.id;
                const deferTrunkInteractionToSceneBatch = !effectiveSelected && !hasBezierSegment;

                return (
                    <group key={trunk.id}>
                    <TrunkRenderer
                        key={trunk.id}
                        trunk={trunk}
                        root={root}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isTrunkHovered}
                        baseColor={resolveBaseColor(trunk.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected}
                        deferInteractionToSceneBatch={deferTrunkInteractionToSceneBatch}
                        deferRootsToSceneBatch={!effectiveSelected}
                        deferContactConesToSceneBatch={!effectiveSelected && !!trunk.contactCone}
                        hidePlateContactPrimitives={hidePlateContactPrimitivesEffective}
                    />
                    </group>
                );
            })}

            {/* Render Branches */}
            {sceneBatchedBranchShaftGroups.map((group) => (
                <group key={`scene-branch-batch:${group.modelId ?? 'none'}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={dimNonSelected ? '#666666' : resolveBaseColor(group.modelId)}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {Object.values(state.branches).map(branch => {
                if (!isModelVisible(branch.modelId, branch.id)) return null;
                const knot = state.knots[branch.parentKnotId];
                if (!knot) return null;

                const effectiveSelected = selectedBranchIds.has(branch.id);
                const hasBezierSegment = branch.segments.some((s) => s.type === 'bezier');
                const renderDetailedBranch = effectiveSelected || hasBezierSegment;
                if (!renderDetailedBranch) return null;

                const isBranchHovered = (hoveredCategoryForVisual === 'support' && hoveredIdForVisual === branch.id)
                    || sceneHoveredSupportId === branch.id
                    || marqueeHoveredSupportId === branch.id;
                const deferBranchInteractionToSceneBatch = !effectiveSelected && !hasBezierSegment;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={branch.id}>
                    <BranchRenderer
                        key={branch.id}
                        branch={branch}
                        parentKnot={knot}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isBranchHovered}
                        baseColor={resolveBaseColor(branch.modelId)}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected}
                        deferInteractionToSceneBatch={deferBranchInteractionToSceneBatch}
                        deferContactConesToSceneBatch={!effectiveSelected && !!branch.contactCone}
                    />
                    </group>
                );
            })}

            {/* Render Leaves */}
            {Object.values(state.leaves).map(leaf => {
                if (!isModelVisible(leaf.modelId, leaf.id)) return null;
                const knot = state.knots[leaf.parentKnotId];
                if (!knot) return null;

                const effectiveSelected = selectedLeafIds.has(leaf.id);
                if (!effectiveSelected) return null;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={leaf.id}>
                    <LeafRenderer
                        key={leaf.id}
                        leaf={leaf}
                        parentKnot={knot}
                        isSelected={effectiveSelected}
                        dimNonSelected={dimNonSelected}
                        baseColor={resolveBaseColor(leaf.modelId)}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferContactConesToSceneBatch={!effectiveSelected && !!leaf.contactCone}
                    />
                    </group>
                );
            })}

            {/* Render Twigs */}
            {Object.values(state.twigs).map(twig => {
                if (!isModelVisible(twig.modelId, twig.id)) return null;
                const effectiveSelected = selectedTwigIds.has(twig.id);
                const isTwigBatchable = twigShaftsBySupport.has(twig.id);
                const renderDetailedTwig = effectiveSelected || !isTwigBatchable;
                if (!renderDetailedTwig) return null;

                const isTwigHovered = (hoveredCategoryForVisual === 'support' && hoveredIdForVisual === twig.id)
                    || sceneHoveredSupportId === twig.id
                    || marqueeHoveredSupportId === twig.id;
                const deferTwigInteractionToSceneBatch = !effectiveSelected && isTwigBatchable;

                return (
                    <group key={twig.id}>
                    <TwigRenderer
                        key={twig.id}
                        twig={twig}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isTwigHovered}
                        baseColor={resolveBaseColor(twig.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && isTwigBatchable}
                        deferInteractionToSceneBatch={deferTwigInteractionToSceneBatch}
                    />
                    </group>
                );
            })}

            {sceneBatchedTwigShaftGroups.map((group) => (
                <group key={`scene-twig-batch:${group.modelId ?? 'none'}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={dimNonSelected ? '#666666' : resolveBaseColor(group.modelId)}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {/* Render Sticks */}
            {Object.values(state.sticks).map(stick => {
                if (!isModelVisible(stick.modelId, stick.id)) return null;
                const effectiveSelected = selectedStickIds.has(stick.id);
                const isStickBatchable = stickShaftsBySupport.has(stick.id);
                const renderDetailedStick = effectiveSelected || !isStickBatchable;
                if (!renderDetailedStick) return null;

                const isStickHovered = (hoveredCategoryForVisual === 'support' && hoveredIdForVisual === stick.id)
                    || sceneHoveredSupportId === stick.id
                    || marqueeHoveredSupportId === stick.id;
                const deferStickInteractionToSceneBatch = !effectiveSelected && isStickBatchable;

                return (
                    <group key={stick.id}>
                    <StickRenderer
                        key={stick.id}
                        stick={stick}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isStickHovered}
                        baseColor={resolveBaseColor(stick.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && isStickBatchable}
                        deferInteractionToSceneBatch={deferStickInteractionToSceneBatch}
                        deferContactConesToSceneBatch={!effectiveSelected}
                    />
                    </group>
                );
            })}

            {sceneBatchedStickShaftGroups.map((group) => (
                <group key={`scene-stick-batch:${group.modelId ?? 'none'}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={dimNonSelected ? '#666666' : resolveBaseColor(group.modelId)}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {/* Render Braces */}
            {sceneBatchedBraceShaftGroups.map((group) => (
                <group key={`scene-brace-batch:${group.modelId ?? 'none'}:${group.debugSection ?? 'none'}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={
                            dimNonSelected
                                ? '#666666'
                                : (settings.autoBracing.debugSectionColorsEnabled && group.debugSection
                                    ? AUTO_BRACING_DEBUG_SECTION_COLORS[group.debugSection]
                                    : resolveBaseColor(group.modelId))
                        }
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {Object.values(state.braces).map(brace => {
                if (!isModelVisible(brace.modelId, brace.id)) return null;
                const startKnot = state.knots[brace.startKnotId];
                const endKnot = state.knots[brace.endKnotId];
                if (!startKnot || !endKnot) return null;

                const effectiveSelected = selectedBraceIds.has(brace.id);
                const isBraceBatchable = braceShaftsBySupport.has(brace.id);
                const renderDetailedBrace = effectiveSelected || !isBraceBatchable;
                if (!renderDetailedBrace) return null;

                const isBraceHovered = (hoveredCategoryForVisual === 'support' && hoveredIdForVisual === brace.id)
                    || sceneHoveredSupportId === brace.id
                    || marqueeHoveredSupportId === brace.id;
                const deferBraceInteractionToSceneBatch = !effectiveSelected && isBraceBatchable;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={brace.id}>
                    <BraceRenderer
                        key={brace.id}
                        brace={brace}
                        startKnot={startKnot}
                        endKnot={endKnot}
                        isSelected={effectiveSelected}
                        dimNonSelected={dimNonSelected}
                        baseColor={resolveBaseColor(brace.modelId)}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isHovered={isBraceHovered}
                        isInteractable={isInteractable}
                        deferStraightShaftToSceneBatch={!effectiveSelected && isBraceBatchable}
                        deferInteractionToSceneBatch={deferBraceInteractionToSceneBatch}
                        debugSectionColors={settings.autoBracing.debugSectionColorsEnabled}
                    />
                    </group>
                );
            })}

            {/* Render Support Braces */}
            {Object.values(supportBraceState.supportBraces).map((supportBrace) => {
                if (!isModelVisible(supportBrace.modelId, supportBrace.id)) return null;
                const root = supportBraceState.roots[supportBrace.rootId];
                const hostKnot = supportBraceState.knots[supportBrace.hostKnotId];
                if (!root || !hostKnot) return null;

                const effectiveSelected = selectedSupportBraceIds.has(supportBrace.id);
                const isSupportBraceBatchable = supportBraceShaftsBySupport.has(supportBrace.id);
                const renderDetailedSupportBrace = effectiveSelected || !isSupportBraceBatchable;
                if (!renderDetailedSupportBrace) return null;

                const isSupportBraceHovered = (hoveredCategoryForVisual === 'support' && hoveredIdForVisual === supportBrace.id)
                    || sceneHoveredSupportId === supportBrace.id
                    || marqueeHoveredSupportId === supportBrace.id;
                const deferSupportBraceInteractionToSceneBatch = !effectiveSelected && isSupportBraceBatchable;
                const showKnot = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={supportBrace.id}>
                    <SupportBraceRenderer
                        key={supportBrace.id}
                        supportBrace={supportBrace}
                        root={root}
                        hostKnot={hostKnot}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isSupportBraceHovered}
                        baseColor={resolveBaseColor(supportBrace.modelId)}
                        showKnot={showKnot}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && isSupportBraceBatchable}
                        deferInteractionToSceneBatch={deferSupportBraceInteractionToSceneBatch}
                        hidePlateContactPrimitives={hidePlateContactPrimitivesEffective}
                    />
                    </group>
                );
            })}

            {sceneBatchedSupportBraceShaftGroups.map((group) => (
                <group key={`scene-support-brace-batch:${group.modelId ?? 'none'}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={dimNonSelected ? '#666666' : resolveBaseColor(group.modelId)}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}
        </group>
    );
});

SupportRenderer.displayName = 'SupportRenderer';
