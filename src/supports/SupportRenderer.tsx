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

interface SupportRendererProps {
    mode?: SupportMode;
    hidePlateContactPrimitives?: boolean;
    clipLower?: number | null;
    clipUpper?: number | null;
}

export const SupportRenderer = forwardRef<THREE.Group, SupportRendererProps>(({ mode, hidePlateContactPrimitives = false, clipLower, clipUpper }, ref) => {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const supportBraceState = useSupportBraceStoreState();
    const { isActive: isJointCreationActive } = useJointCreationState();
    const { altActive: braceAltActive } = useBracePlacementState();

    const dimNonSelected = state.selectedId !== null;
    const hideUnselectedKnots = state.selectedId !== null;

    const isInteractable = mode === 'support';
    const suppressHover = isJointCreationActive || !isInteractable || braceAltActive;

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
                    <TrunkRenderer
                        key={trunk.id}
                        trunk={trunk}
                        root={root}
                        isSelected={effectiveSelected}
                        selectedId={state.selectedId}
                        dimNonSelected={dimNonSelected}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                    />
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
                    <BranchRenderer
                        key={branch.id}
                        branch={branch}
                        parentKnot={knot}
                        isSelected={effectiveSelected}
                        selectedId={state.selectedId}
                        dimNonSelected={dimNonSelected}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
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
                    <LeafRenderer
                        key={leaf.id}
                        leaf={leaf}
                        parentKnot={knot}
                        isSelected={effectiveSelected}
                        dimNonSelected={dimNonSelected}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
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
                    <TwigRenderer
                        key={twig.id}
                        twig={twig}
                        isSelected={effectiveSelected}
                        selectedId={state.selectedId}
                        dimNonSelected={dimNonSelected}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
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
                    <StickRenderer
                        key={stick.id}
                        stick={stick}
                        isSelected={effectiveSelected}
                        selectedId={state.selectedId}
                        dimNonSelected={dimNonSelected}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
                );
            })}

            {/* Render Braces */}
            {Object.values(state.braces).map(brace => {
                const startKnot = state.knots[brace.startKnotId];
                const endKnot = state.knots[brace.endKnotId];
                if (!startKnot || !endKnot) return null;

                const isBraceSelected = state.selectedId === brace.id;
                const isSegmentSelected = state.selectedId === `braceSegment:${brace.id}`;
                const isEndpointSelected = state.selectedId === startKnot.id || state.selectedId === endKnot.id;
                const effectiveSelected = isBraceSelected || isSegmentSelected || isEndpointSelected;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <BraceRenderer
                        key={brace.id}
                        brace={brace}
                        startKnot={startKnot}
                        endKnot={endKnot}
                        isSelected={effectiveSelected}
                        dimNonSelected={dimNonSelected}
                        showKnots={showKnots}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
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
                    <SupportBraceRenderer
                        key={supportBrace.id}
                        supportBrace={supportBrace}
                        root={root}
                        hostKnot={hostKnot}
                        isSelected={effectiveSelected}
                        selectedId={state.selectedId}
                        dimNonSelected={dimNonSelected}
                        showKnot={showKnot}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                    />
                );
            })}
        </group>
    );
});

SupportRenderer.displayName = 'SupportRenderer';
