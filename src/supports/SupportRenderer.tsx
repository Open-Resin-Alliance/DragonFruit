"use client";

import React, { useSyncExternalStore, forwardRef, useImperativeHandle, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { addKnot, addRoot, removeRootById, subscribe, getSnapshot } from './state';
import { TrunkRenderer } from './SupportTypes/Trunk/TrunkRenderer';
import { BranchRenderer } from './SupportTypes/Branch/BranchRenderer';
import { LeafRenderer } from './SupportTypes/Leaf/LeafRenderer';
import { BraceRenderer } from './SupportTypes/Brace/BraceRenderer';
import { TwigRenderer } from './SupportTypes/Twig/TwigRenderer';
import { StickRenderer } from './SupportTypes/Stick/StickRenderer';
import { SupportBraceRenderer } from './SupportTypes/SupportBrace/SupportBraceRenderer';
import { InstancedShaftGroup, type InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import { useBracePlacementState } from './SupportTypes/Brace/bracePlacementState';
import { useSupportBraceStoreState } from './SupportTypes/SupportBrace/supportBraceStore';
import { useJointInteraction } from './SupportPrimitives/Joint/useJointInteraction';
import { useKnotInteraction } from './SupportPrimitives/Knot/useKnotInteraction';
import { JointCreationManager } from './SupportPrimitives/Joint/JointCreationManager';
import { JointGizmo } from './SupportPrimitives/Joint/JointGizmo';
import { KnotGizmo } from './SupportPrimitives/Knot/KnotGizmo';
import { BezierGizmoManager } from './Curves/BezierGizmo/BezierGizmoManager';
import { SupportMode } from './types';
import { useJointCreationState } from './SupportPrimitives/Joint/jointCreationState';
import { useSupportHistoryHandlers } from './history/useSupportHistoryHandlers';
import { subscribeToSettings, getSettingsSnapshot } from './Settings/state';
import { emitSupportModelPointerHover, handleSupportClick } from './interaction/clickHandlers';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';

interface SupportRendererProps {
    mode?: SupportMode;
    hidePlateContactPrimitives?: boolean;
    clipLower?: number | null;
    clipUpper?: number | null;
    supportColorsByModelId?: Record<string, string>;
    hoverTintColor?: string;
    hoverTintStrength?: number;
    selectedTintStrength?: number;
    activeModelId?: string | null;
    hoverModelId?: string | null;
}

interface SupportShaftSet {
    supportId: string;
    modelId?: string;
    shafts: InstancedShaft[];
}

const BATCHED_SHAFT_RADIAL_SEGMENTS = 12;

export const SupportRenderer = forwardRef<THREE.Group, SupportRendererProps>(({ mode, hidePlateContactPrimitives = false, clipLower, clipUpper, activeModelId = null, hoverModelId = null }, ref) => {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const supportBraceState = useSupportBraceStoreState();
    const { isActive: isJointCreationActive } = useJointCreationState();
    const { altActive: braceAltActive } = useBracePlacementState();

    const dimNonSelected = state.selectedId !== null;
    const hideUnselectedKnots = state.selectedId !== null;

    const isInteractable = mode === 'support';
    const restrictToActiveModel = mode === 'support' && !!activeModelId;
    const suppressHover = isJointCreationActive || !isInteractable || braceAltActive;
    const [immediateModelHoverId, setImmediateModelHoverId] = React.useState<string | null>(null);
    const [sceneHoveredSupportId, setSceneHoveredSupportId] = React.useState<string | null>(null);
    const pendingSceneHoverClearFrameRef = React.useRef<number | null>(null);

    useEffect(() => {
        const handleImmediateModelHover = (event: Event) => {
            const customEvent = event as CustomEvent<{ modelId?: string | null }>;
            setImmediateModelHoverId(customEvent.detail?.modelId ?? null);
        };

        window.addEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
        return () => {
            window.removeEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
        };
    }, []);

    useEffect(() => {
        return () => {
            if (pendingSceneHoverClearFrameRef.current != null) {
                cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
                pendingSceneHoverClearFrameRef.current = null;
            }
        };
    }, []);

    const effectiveHoverModelId = immediateModelHoverId ?? hoverModelId;

    useSupportHistoryHandlers();

    // Backfill Support Brace root/knot into global support state so raft + knot tools include them.
    useEffect(() => {
        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            const root = supportBraceState.roots[supportBrace.rootId];
            if (root && !state.roots[root.id]) {
                addRoot(root);
            }

            const hostKnot = supportBraceState.knots[supportBrace.hostKnotId];
            if (hostKnot && !state.knots[hostKnot.id]) {
                addKnot(hostKnot);
            }
        }

        const trunkRootIds = new Set(Object.values(state.trunks).map((trunk) => trunk.rootId));
        const supportBraceRootIds = new Set(Object.values(supportBraceState.supportBraces).map((supportBrace) => supportBrace.rootId));
        for (const rootId of Object.keys(state.roots)) {
            if (trunkRootIds.has(rootId)) continue;
            if (supportBraceRootIds.has(rootId)) continue;
            removeRootById(rootId);
        }
    }, [supportBraceState.supportBraces, supportBraceState.roots, supportBraceState.knots, state.trunks]);

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
            const isSelectedModelSupport = !!activeModelId && !!modelId && modelId === activeModelId;
            if (isSelectedModelSupport) return '#ff8800';

            const isHoveredModelSupport = !activeModelId && !!effectiveHoverModelId && !!modelId && modelId === effectiveHoverModelId;
            if (isHoveredModelSupport) return hoveredColor;

            return baseHex;
        };
    }, [activeModelId, effectiveHoverModelId]);

    const selectedTrunkIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const trunk of Object.values(state.trunks)) {
            const isTrunkSelected = selectedId === trunk.id;
            const isChildSelected = trunk.segments.some((segment) =>
                segment.id === selectedId
                || segment.topJoint?.id === selectedId
                || segment.bottomJoint?.id === selectedId,
            );
            if (isTrunkSelected || isChildSelected) selected.add(trunk.id);
        }

        return selected;
    }, [state.trunks, state.selectedId]);

    const selectedBranchIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const branch of Object.values(state.branches)) {
            const isBranchSelected = selectedId === branch.id;
            const isKnotSelected = branch.parentKnotId === selectedId;
            const isChildSelected = branch.segments.some((segment) =>
                segment.id === selectedId
                || segment.topJoint?.id === selectedId
                || segment.bottomJoint?.id === selectedId,
            );
            if (isBranchSelected || isKnotSelected || isChildSelected) selected.add(branch.id);
        }

        return selected;
    }, [state.branches, state.selectedId]);

    const selectedBraceIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const brace of Object.values(state.braces)) {
            const isBraceSelected = selectedId === brace.id;
            const isSegmentSelected = selectedId === `braceSegment:${brace.id}`;
            const isEndpointSelected = selectedId === brace.startKnotId || selectedId === brace.endKnotId;
            if (isBraceSelected || isSegmentSelected || isEndpointSelected) selected.add(brace.id);
        }

        return selected;
    }, [state.braces, state.selectedId]);

    const trunkShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        const rootsSettings = settings.roots;
        const baseFlare = settings.baseFlare;
        const baseFlareEnabled = baseFlare.enabled;

        for (const trunk of Object.values(state.trunks)) {
            if (restrictToActiveModel && trunk.modelId !== activeModelId) continue;
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
            if (restrictToActiveModel && branch.modelId !== activeModelId) continue;
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
            if (restrictToActiveModel && brace.modelId !== activeModelId) continue;
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

    const sceneBatchedBraceShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const brace of Object.values(state.braces)) {
            if (restrictToActiveModel && brace.modelId !== activeModelId) continue;
            const shaftSet = braceShaftsBySupport.get(brace.id);
            if (!shaftSet) continue;

            if (selectedBraceIds.has(brace.id)) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(shaftSet.modelId);

            const shaftsForColor = grouped.get(color);
            if (shaftsForColor) {
                shaftsForColor.push(...shaftSet.shafts);
            } else {
                grouped.set(color, [...shaftSet.shafts]);
            }
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [state.braces, dimNonSelected, resolveBaseColor, braceShaftsBySupport, selectedBraceIds, restrictToActiveModel, activeModelId]);

    const sceneBatchedTrunkShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const trunk of Object.values(state.trunks)) {
            if (restrictToActiveModel && trunk.modelId !== activeModelId) continue;
            const shaftSet = trunkShaftsBySupport.get(trunk.id);
            if (!shaftSet) continue;

            if (selectedTrunkIds.has(trunk.id)) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(shaftSet.modelId);
            const shaftsForColor = grouped.get(color) ?? [];
            shaftsForColor.push(...shaftSet.shafts);

            if (shaftsForColor.length > 0) grouped.set(color, shaftsForColor);
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [state.trunks, dimNonSelected, resolveBaseColor, trunkShaftsBySupport, selectedTrunkIds, restrictToActiveModel, activeModelId]);

    const sceneBatchedBranchShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const branch of Object.values(state.branches)) {
            if (restrictToActiveModel && branch.modelId !== activeModelId) continue;
            const shaftSet = branchShaftsBySupport.get(branch.id);
            if (!shaftSet) continue;

            if (selectedBranchIds.has(branch.id)) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(shaftSet.modelId);
            const shaftsForColor = grouped.get(color) ?? [];
            shaftsForColor.push(...shaftSet.shafts);

            if (shaftsForColor.length > 0) {
                grouped.set(color, shaftsForColor);
            }
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [state.branches, dimNonSelected, resolveBaseColor, branchShaftsBySupport, selectedBranchIds, restrictToActiveModel, activeModelId]);

    const hoveredSupportShaftSet = useMemo(() => {
        const hoveredSupportId = sceneHoveredSupportId ?? (state.hoveredCategory === 'support' ? state.hoveredId : null);
        if (!hoveredSupportId) return null;

        const trunkSet = trunkShaftsBySupport.get(hoveredSupportId);
        if (trunkSet) return trunkSet;

        const branchSet = branchShaftsBySupport.get(hoveredSupportId);
        if (branchSet) return branchSet;

        const braceSet = braceShaftsBySupport.get(hoveredSupportId);
        if (braceSet) return braceSet;

        return null;
    }, [sceneHoveredSupportId, state.hoveredCategory, state.hoveredId, trunkShaftsBySupport, branchShaftsBySupport, braceShaftsBySupport]);

    const hoveredSupportOverlayShafts = useMemo(() => {
        if (!hoveredSupportShaftSet) return [] as InstancedShaft[];

        return hoveredSupportShaftSet.shafts.map((shaft) => ({
            ...shaft,
            diameter: shaft.diameter * 1.02,
        }));
    }, [hoveredSupportShaftSet]);

    const handleSceneBatchedShaftClick = React.useCallback((shaft: InstancedShaft, event: { nativeEvent?: Event }) => {
        if (!shaft.supportId) return;
        handleSupportClick(event, shaft.supportId, isInteractable);
    }, [isInteractable]);

    const handleSceneBatchedShaftPointerMove = React.useCallback((shaft: InstancedShaft) => {
        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = shaft.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(shaft.modelId ?? null);
    }, []);

    const handleSceneBatchedShaftPointerOut = React.useCallback(() => {
        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
        }

        pendingSceneHoverClearFrameRef.current = requestAnimationFrame(() => {
            pendingSceneHoverClearFrameRef.current = null;
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
        });
    }, []);

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

        root.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.material) return;

            if (Array.isArray(mesh.material)) {
                mesh.material.forEach(applyMaterialClipping);
            } else {
                applyMaterialClipping(mesh.material);
            }
        });
    }, [clippingPlanes]);

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
                <InstancedShaftGroup
                    key={`scene-trunk-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                    onShaftClick={handleSceneBatchedShaftClick}
                    onShaftPointerMove={handleSceneBatchedShaftPointerMove}
                    onShaftPointerOut={handleSceneBatchedShaftPointerOut}
                />
            ))}

            {hoveredSupportOverlayShafts.length > 0 && hoveredSupportShaftSet && (
                <InstancedShaftGroup
                    key={`scene-hover-overlay:${hoveredSupportShaftSet.supportId}:${hoveredSupportOverlayShafts.length}`}
                    shafts={hoveredSupportOverlayShafts}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportShaftSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.3}
                    radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                    onShaftClick={handleSceneBatchedShaftClick}
                    onShaftPointerMove={handleSceneBatchedShaftPointerMove}
                    onShaftPointerOut={handleSceneBatchedShaftPointerOut}
                />
            )}

            {Object.values(state.trunks).map(trunk => {
                if (restrictToActiveModel && trunk.modelId !== activeModelId) return null;
                const root = state.roots[trunk.rootId];
                if (!root) return null;

                const isTrunkSelected = state.selectedId === trunk.id;
                const isChildSelected = trunk.segments.some(s =>
                    (s.topJoint?.id && s.topJoint.id === state.selectedId) ||
                    (s.bottomJoint?.id && s.bottomJoint.id === state.selectedId) ||
                    s.id === state.selectedId
                );
                const effectiveSelected = isTrunkSelected || isChildSelected;
                const isTrunkHovered = (state.hoveredCategory === 'support' && state.hoveredId === trunk.id)
                    || sceneHoveredSupportId === trunk.id;
                const hasBezierSegment = trunk.segments.some((s) => s.type === 'bezier');
                const deferTrunkInteractionToSceneBatch = !effectiveSelected && !hasBezierSegment;

                return (
                    <group key={trunk.id}>
                    <TrunkRenderer
                        key={trunk.id}
                        trunk={trunk}
                        root={root}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isTrunkHovered}
                        baseColor={resolveBaseColor(trunk.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected}
                        deferInteractionToSceneBatch={deferTrunkInteractionToSceneBatch}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                    />
                    </group>
                );
            })}

            {/* Render Branches */}
            {sceneBatchedBranchShaftGroups.map((group) => (
                <InstancedShaftGroup
                    key={`scene-branch-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                    onShaftClick={handleSceneBatchedShaftClick}
                    onShaftPointerMove={handleSceneBatchedShaftPointerMove}
                    onShaftPointerOut={handleSceneBatchedShaftPointerOut}
                />
            ))}

            {Object.values(state.branches).map(branch => {
                if (restrictToActiveModel && branch.modelId !== activeModelId) return null;
                const knot = state.knots[branch.parentKnotId];
                if (!knot) return null;

                const isBranchSelected = state.selectedId === branch.id;
                const isKnotSelected = knot.id === state.selectedId;
                const isChildSelected = branch.segments.some(s =>
                    (s.topJoint?.id && s.topJoint.id === state.selectedId) ||
                    (s.bottomJoint?.id && s.bottomJoint.id === state.selectedId) ||
                    s.id === state.selectedId
                );
                const effectiveSelected = isBranchSelected || isKnotSelected || isChildSelected;
                const isBranchHovered = (state.hoveredCategory === 'support' && state.hoveredId === branch.id)
                    || sceneHoveredSupportId === branch.id;
                const hasBezierSegment = branch.segments.some((s) => s.type === 'bezier');
                const deferBranchInteractionToSceneBatch = !effectiveSelected && !hasBezierSegment;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={branch.id}>
                    <BranchRenderer
                        key={branch.id}
                        branch={branch}
                        parentKnot={knot}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isBranchHovered}
                        baseColor={resolveBaseColor(branch.modelId)}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected}
                        deferInteractionToSceneBatch={deferBranchInteractionToSceneBatch}
                    />
                    </group>
                );
            })}

            {/* Render Leaves */}
            {Object.values(state.leaves).map(leaf => {
                if (restrictToActiveModel && leaf.modelId !== activeModelId) return null;
                const knot = state.knots[leaf.parentKnotId];
                if (!knot) return null;

                const isLeafSelected = state.selectedId === leaf.id;
                const isKnotSelected = knot.id === state.selectedId;
                const effectiveSelected = isLeafSelected || isKnotSelected;
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
                    />
                    </group>
                );
            })}

            {/* Render Twigs */}
            {Object.values(state.twigs).map(twig => {
                if (restrictToActiveModel && twig.modelId !== activeModelId) return null;
                const isTwigSelected = state.selectedId === twig.id;
                const isChildSelected = twig.segments.some(s =>
                    (s.topJoint?.id && s.topJoint.id === state.selectedId) ||
                    (s.bottomJoint?.id && s.bottomJoint.id === state.selectedId) ||
                    s.id === state.selectedId
                );
                const effectiveSelected = isTwigSelected || isChildSelected;

                return (
                    <group key={twig.id}>
                    <TwigRenderer
                        key={twig.id}
                        twig={twig}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        baseColor={resolveBaseColor(twig.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
                    </group>
                );
            })}

            {/* Render Sticks */}
            {Object.values(state.sticks).map(stick => {
                if (restrictToActiveModel && stick.modelId !== activeModelId) return null;
                const isStickSelected = state.selectedId === stick.id;
                const isChildSelected = stick.segments.some(s =>
                    (s.topJoint?.id && s.topJoint.id === state.selectedId) ||
                    (s.bottomJoint?.id && s.bottomJoint.id === state.selectedId) ||
                    s.id === state.selectedId
                );
                const effectiveSelected = isStickSelected || isChildSelected;

                return (
                    <group key={stick.id}>
                    <StickRenderer
                        key={stick.id}
                        stick={stick}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        baseColor={resolveBaseColor(stick.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
                    </group>
                );
            })}

            {/* Render Braces */}
            {sceneBatchedBraceShaftGroups.map((group) => (
                <InstancedShaftGroup
                    key={`scene-brace-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                    onShaftClick={handleSceneBatchedShaftClick}
                    onShaftPointerMove={handleSceneBatchedShaftPointerMove}
                    onShaftPointerOut={handleSceneBatchedShaftPointerOut}
                />
            ))}

            {Object.values(state.braces).map(brace => {
                if (restrictToActiveModel && brace.modelId !== activeModelId) return null;
                const startKnot = state.knots[brace.startKnotId];
                const endKnot = state.knots[brace.endKnotId];
                if (!startKnot || !endKnot) return null;

                const isBraceSelected = state.selectedId === brace.id;
                const isSegmentSelected = state.selectedId === `braceSegment:${brace.id}`;
                const isEndpointSelected = state.selectedId === startKnot.id || state.selectedId === endKnot.id;
                const effectiveSelected = isBraceSelected || isSegmentSelected || isEndpointSelected;
                const isBraceHovered = (state.hoveredCategory === 'support' && state.hoveredId === brace.id)
                    || sceneHoveredSupportId === brace.id;
                const deferBraceInteractionToSceneBatch = !effectiveSelected && brace.curve?.type !== 'bezier';
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
                        deferStraightShaftToSceneBatch={!effectiveSelected && brace.curve?.type !== 'bezier'}
                        deferInteractionToSceneBatch={deferBraceInteractionToSceneBatch}
                        debugSectionColors={settings.autoBracing.debugSectionColorsEnabled}
                    />
                    </group>
                );
            })}

            {/* Render Support Braces */}
            {Object.values(supportBraceState.supportBraces).map((supportBrace) => {
                if (restrictToActiveModel && supportBrace.modelId !== activeModelId) return null;
                const root = state.roots[supportBrace.rootId];
                const hostKnot = state.knots[supportBrace.hostKnotId];
                if (!root || !hostKnot) return null;

                const isSupportBraceSelected = state.selectedId === supportBrace.id;
                const isHostKnotSelected = state.selectedId === hostKnot.id;
                const isChildSelected = supportBrace.segments.some(
                    (segment) =>
                        segment.id === state.selectedId
                        || segment.bottomJoint?.id === state.selectedId
                        || segment.topJoint?.id === state.selectedId,
                );
                const effectiveSelected = isSupportBraceSelected || isHostKnotSelected || isChildSelected;
                const showKnot = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={supportBrace.id}>
                    <SupportBraceRenderer
                        key={supportBrace.id}
                        supportBrace={supportBrace}
                        root={root}
                        hostKnot={hostKnot}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        baseColor={resolveBaseColor(supportBrace.modelId)}
                        showKnot={showKnot}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                    />
                    </group>
                );
            })}
        </group>
    );
});

SupportRenderer.displayName = 'SupportRenderer';
