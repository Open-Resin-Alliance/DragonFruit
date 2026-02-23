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

export const SupportRenderer = forwardRef<THREE.Group, SupportRendererProps>(({ mode, hidePlateContactPrimitives = false, clipLower, clipUpper, activeModelId = null, hoverModelId = null }, ref) => {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const supportBraceState = useSupportBraceStoreState();
    const { isActive: isJointCreationActive } = useJointCreationState();
    const { altActive: braceAltActive } = useBracePlacementState();

    const dimNonSelected = state.selectedId !== null;
    const hideUnselectedKnots = state.selectedId !== null;

    const isInteractable = mode === 'support';
    const suppressHover = isJointCreationActive || !isInteractable || braceAltActive;
    const [immediateModelHoverId, setImmediateModelHoverId] = React.useState<string | null>(null);

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

    const sceneBatchedBraceShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const brace of Object.values(state.braces)) {
            const startKnot = state.knots[brace.startKnotId];
            const endKnot = state.knots[brace.endKnotId];
            if (!startKnot || !endKnot) continue;

            const isBraceSelected = state.selectedId === brace.id;
            const isSegmentSelected = state.selectedId === `braceSegment:${brace.id}`;
            const isEndpointSelected = state.selectedId === startKnot.id || state.selectedId === endKnot.id;
            const effectiveSelected = isBraceSelected || isSegmentSelected || isEndpointSelected;

            const isBraceHovered = state.hoveredCategory === 'support' && state.hoveredId === brace.id;
            const isBezierBrace = brace.curve?.type === 'bezier';

            if (effectiveSelected || isBraceHovered || isBezierBrace) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(brace.modelId);
            const diameter = Math.max(0.001, brace.profile?.diameter ?? 1.0);

            const shaftsForColor = grouped.get(color);
            const shaft: InstancedShaft = {
                id: `braceSegment:${brace.id}`,
                start: startKnot.pos,
                end: endKnot.pos,
                diameter,
            };

            if (shaftsForColor) {
                shaftsForColor.push(shaft);
            } else {
                grouped.set(color, [shaft]);
            }
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [state.braces, state.knots, state.selectedId, state.hoveredCategory, state.hoveredId, dimNonSelected, resolveBaseColor]);

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
            {Object.values(state.trunks).map(trunk => {
                const root = state.roots[trunk.rootId];
                if (!root) return null;

                const isTrunkSelected = state.selectedId === trunk.id;
                const isChildSelected = trunk.segments.some(s =>
                    (s.topJoint?.id && s.topJoint.id === state.selectedId) ||
                    (s.bottomJoint?.id && s.bottomJoint.id === state.selectedId) ||
                    s.id === state.selectedId
                );
                const effectiveSelected = isTrunkSelected || isChildSelected;

                return (
                    <group key={trunk.id}>
                    <TrunkRenderer
                        key={trunk.id}
                        trunk={trunk}
                        root={root}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        baseColor={resolveBaseColor(trunk.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                    />
                    </group>
                );
            })}

            {/* Render Branches */}
            {Object.values(state.branches).map(branch => {
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
                        baseColor={resolveBaseColor(branch.modelId)}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
                    </group>
                );
            })}

            {/* Render Leaves */}
            {Object.values(state.leaves).map(leaf => {
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
                />
            ))}

            {Object.values(state.braces).map(brace => {
                const startKnot = state.knots[brace.startKnotId];
                const endKnot = state.knots[brace.endKnotId];
                if (!startKnot || !endKnot) return null;

                const isBraceSelected = state.selectedId === brace.id;
                const isSegmentSelected = state.selectedId === `braceSegment:${brace.id}`;
                const isEndpointSelected = state.selectedId === startKnot.id || state.selectedId === endKnot.id;
                const effectiveSelected = isBraceSelected || isSegmentSelected || isEndpointSelected;
                const isBraceHovered = state.hoveredCategory === 'support' && state.hoveredId === brace.id;
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
                        deferStraightShaftToSceneBatch={!effectiveSelected && !isBraceHovered && brace.curve?.type !== 'bezier'}
                        debugSectionColors={settings.autoBracing.debugSectionColorsEnabled}
                    />
                    </group>
                );
            })}

            {/* Render Support Braces */}
            {Object.values(supportBraceState.supportBraces).map((supportBrace) => {
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
