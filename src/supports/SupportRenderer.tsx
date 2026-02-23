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
import { emitSupportModelPointerHover, handleSupportClick } from './interaction/clickHandlers';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { getRaftSettings, subscribeToRaftStore } from './Rafts/Crenelated/RaftState';

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
    hoverModelId?: string | null;
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

export const SupportRenderer = forwardRef<THREE.Group, SupportRendererProps>(({ mode, hidePlateContactPrimitives = false, clipLower, clipUpper, activeModelId = null, hoverModelId = null }, ref) => {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const raftSettings = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
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
    const orbitInteractionActiveRef = React.useRef(false);

    useEffect(() => {
        const handleImmediateModelHover = (event: Event) => {
            if (orbitInteractionActiveRef.current) return;
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
            emitSupportModelPointerHover(null);
        };

        const handleOrbitEnd = () => {
            orbitInteractionActiveRef.current = false;
        };

        window.addEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
        window.addEventListener('picking-orbit-start', handleOrbitStartOrChange);
        window.addEventListener('picking-orbit-change', handleOrbitStartOrChange);
        window.addEventListener('picking-orbit-end', handleOrbitEnd);
        return () => {
            window.removeEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
            window.removeEventListener('picking-orbit-start', handleOrbitStartOrChange);
            window.removeEventListener('picking-orbit-change', handleOrbitStartOrChange);
            window.removeEventListener('picking-orbit-end', handleOrbitEnd);
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

    const selectedTwigIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const twig of Object.values(state.twigs)) {
            const isTwigSelected = selectedId === twig.id;
            const isChildSelected = twig.segments.some((segment) =>
                segment.id === selectedId
                || segment.topJoint?.id === selectedId
                || segment.bottomJoint?.id === selectedId,
            );
            if (isTwigSelected || isChildSelected) selected.add(twig.id);
        }

        return selected;
    }, [state.twigs, state.selectedId]);

    const selectedStickIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const stick of Object.values(state.sticks)) {
            const isStickSelected = selectedId === stick.id;
            const isChildSelected = stick.segments.some((segment) =>
                segment.id === selectedId
                || segment.topJoint?.id === selectedId
                || segment.bottomJoint?.id === selectedId,
            );
            if (isStickSelected || isChildSelected) selected.add(stick.id);
        }

        return selected;
    }, [state.sticks, state.selectedId]);

    const selectedSupportBraceIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            const isSupportBraceSelected = selectedId === supportBrace.id;
            const isHostKnotSelected = selectedId === supportBrace.hostKnotId;
            const isChildSelected = supportBrace.segments.some((segment) =>
                segment.id === selectedId
                || segment.topJoint?.id === selectedId
                || segment.bottomJoint?.id === selectedId,
            );
            if (isSupportBraceSelected || isHostKnotSelected || isChildSelected) selected.add(supportBrace.id);
        }

        return selected;
    }, [supportBraceState.supportBraces, state.selectedId]);

    const selectedLeafIds = useMemo(() => {
        const selected = new Set<string>();
        const selectedId = state.selectedId;
        if (!selectedId) return selected;

        for (const leaf of Object.values(state.leaves)) {
            const isLeafSelected = selectedId === leaf.id;
            const isKnotSelected = leaf.parentKnotId === selectedId;
            if (isLeafSelected || isKnotSelected) selected.add(leaf.id);
        }

        return selected;
    }, [state.leaves, state.selectedId]);

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

    const twigShaftsBySupport = useMemo(() => {
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
            if (restrictToActiveModel && twig.modelId !== activeModelId) continue;

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
    }, [state.twigs, restrictToActiveModel, activeModelId]);

    const stickShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const stick of Object.values(state.sticks)) {
            if (restrictToActiveModel && stick.modelId !== activeModelId) continue;

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
            if (restrictToActiveModel && supportBrace.modelId !== activeModelId) continue;

            const root = state.roots[supportBrace.rootId];
            const hostKnot = state.knots[supportBrace.hostKnotId];
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
    }, [supportBraceState.supportBraces, state.roots, state.knots, restrictToActiveModel, activeModelId]);

    const contactConesBySupport = useMemo(() => {
        const result = new Map<string, { supportId: string; modelId?: string; cones: InstancedContactCone[] }>();

        for (const trunk of Object.values(state.trunks)) {
            if (restrictToActiveModel && trunk.modelId !== activeModelId) continue;
            if (!trunk.contactCone) continue;

            result.set(trunk.id, {
                supportId: trunk.id,
                modelId: trunk.modelId,
                cones: [{
                    id: trunk.contactCone.id,
                    supportId: trunk.id,
                    modelId: trunk.modelId,
                    pos: trunk.contactCone.pos,
                    normal: trunk.contactCone.normal,
                    surfaceNormal: trunk.contactCone.surfaceNormal,
                    diskLengthOverride: trunk.contactCone.diskLengthOverride,
                    profile: trunk.contactCone.profile,
                }],
            });
        }

        for (const branch of Object.values(state.branches)) {
            if (restrictToActiveModel && branch.modelId !== activeModelId) continue;
            if (!branch.contactCone) continue;

            result.set(branch.id, {
                supportId: branch.id,
                modelId: branch.modelId,
                cones: [{
                    id: branch.contactCone.id,
                    supportId: branch.id,
                    modelId: branch.modelId,
                    pos: branch.contactCone.pos,
                    normal: branch.contactCone.normal,
                    surfaceNormal: branch.contactCone.surfaceNormal,
                    diskLengthOverride: branch.contactCone.diskLengthOverride,
                    profile: branch.contactCone.profile,
                }],
            });
        }

        for (const stick of Object.values(state.sticks)) {
            if (restrictToActiveModel && stick.modelId !== activeModelId) continue;

            result.set(stick.id, {
                supportId: stick.id,
                modelId: stick.modelId,
                cones: [
                    {
                        id: stick.contactConeA.id,
                        supportId: stick.id,
                        modelId: stick.modelId,
                        pos: stick.contactConeA.pos,
                        normal: stick.contactConeA.normal,
                        surfaceNormal: stick.contactConeA.surfaceNormal,
                        diskLengthOverride: stick.contactConeA.diskLengthOverride,
                        profile: stick.contactConeA.profile,
                    },
                    {
                        id: stick.contactConeB.id,
                        supportId: stick.id,
                        modelId: stick.modelId,
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
            if (restrictToActiveModel && leaf.modelId !== activeModelId) continue;

            result.set(leaf.id, {
                supportId: leaf.id,
                modelId: leaf.modelId,
                cones: [{
                    id: leaf.contactCone.id,
                    supportId: leaf.id,
                    modelId: leaf.modelId,
                    pos: leaf.contactCone.pos,
                    normal: leaf.contactCone.normal,
                    surfaceNormal: leaf.contactCone.surfaceNormal,
                    diskLengthOverride: leaf.contactCone.diskLengthOverride,
                    profile: leaf.contactCone.profile,
                }],
            });
        }

        return result;
    }, [state.trunks, state.branches, state.sticks, state.leaves, restrictToActiveModel, activeModelId]);

    const trunkJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const trunk of Object.values(state.trunks)) {
            if (restrictToActiveModel && trunk.modelId !== activeModelId) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of trunk.segments) {
                if (segment.bottomJoint && !seen.has(segment.bottomJoint.id)) {
                    seen.add(segment.bottomJoint.id);
                    joints.push({
                        id: segment.bottomJoint.id,
                        pos: segment.bottomJoint.pos,
                        diameter: segment.bottomJoint.diameter,
                        supportId: trunk.id,
                        modelId: trunk.modelId,
                    });
                }

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
            if (restrictToActiveModel && branch.modelId !== activeModelId) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of branch.segments) {
                if (segment.bottomJoint && !seen.has(segment.bottomJoint.id)) {
                    seen.add(segment.bottomJoint.id);
                    joints.push({
                        id: segment.bottomJoint.id,
                        pos: segment.bottomJoint.pos,
                        diameter: segment.bottomJoint.diameter,
                        supportId: branch.id,
                        modelId: branch.modelId,
                    });
                }

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
            if (restrictToActiveModel && twig.modelId !== activeModelId) continue;

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
            if (restrictToActiveModel && stick.modelId !== activeModelId) continue;

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
            if (restrictToActiveModel && supportBrace.modelId !== activeModelId) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of supportBrace.segments) {
                if (segment.bottomJoint && !seen.has(segment.bottomJoint.id)) {
                    seen.add(segment.bottomJoint.id);
                    joints.push({
                        id: segment.bottomJoint.id,
                        pos: segment.bottomJoint.pos,
                        diameter: segment.bottomJoint.diameter,
                        supportId: supportBrace.id,
                        modelId: supportBrace.modelId,
                    });
                }

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
            if (existing) {
                existing.push(...joints);
            } else {
                grouped.set(color, [...joints]);
            }
        };

        for (const trunk of Object.values(state.trunks)) {
            if (restrictToActiveModel && trunk.modelId !== activeModelId) continue;
            if (selectedTrunkIds.has(trunk.id)) continue;
            const jointSet = trunkJointsBySupport.get(trunk.id);
            if (!jointSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(trunk.modelId);
            pushJoints(color, jointSet.joints);
        }

        for (const branch of Object.values(state.branches)) {
            if (restrictToActiveModel && branch.modelId !== activeModelId) continue;
            if (selectedBranchIds.has(branch.id)) continue;
            const jointSet = branchJointsBySupport.get(branch.id);
            if (!jointSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(branch.modelId);
            pushJoints(color, jointSet.joints);
        }

        for (const twig of Object.values(state.twigs)) {
            if (restrictToActiveModel && twig.modelId !== activeModelId) continue;
            if (selectedTwigIds.has(twig.id)) continue;
            const jointSet = twigJointsBySupport.get(twig.id);
            if (!jointSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(twig.modelId);
            pushJoints(color, jointSet.joints);
        }

        for (const stick of Object.values(state.sticks)) {
            if (restrictToActiveModel && stick.modelId !== activeModelId) continue;
            if (selectedStickIds.has(stick.id)) continue;
            const jointSet = stickJointsBySupport.get(stick.id);
            if (!jointSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(stick.modelId);
            pushJoints(color, jointSet.joints);
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (restrictToActiveModel && supportBrace.modelId !== activeModelId) continue;
            if (selectedSupportBraceIds.has(supportBrace.id)) continue;
            const jointSet = supportBraceJointsBySupport.get(supportBrace.id);
            if (!jointSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(supportBrace.modelId);
            pushJoints(color, jointSet.joints);
        }

        return Array.from(grouped.entries()).map(([color, joints]) => ({ color, joints }));
    }, [
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
        dimNonSelected,
        resolveBaseColor,
    ]);

    const sceneBatchedTwigShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const twig of Object.values(state.twigs)) {
            if (restrictToActiveModel && twig.modelId !== activeModelId) continue;
            const shaftSet = twigShaftsBySupport.get(twig.id);
            if (!shaftSet) continue;
            if (selectedTwigIds.has(twig.id)) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(shaftSet.modelId);
            const shaftsForColor = grouped.get(color) ?? [];
            shaftsForColor.push(...shaftSet.shafts);
            if (shaftsForColor.length > 0) grouped.set(color, shaftsForColor);
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [state.twigs, dimNonSelected, resolveBaseColor, twigShaftsBySupport, selectedTwigIds, restrictToActiveModel, activeModelId]);

    const sceneBatchedStickShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const stick of Object.values(state.sticks)) {
            if (restrictToActiveModel && stick.modelId !== activeModelId) continue;
            const shaftSet = stickShaftsBySupport.get(stick.id);
            if (!shaftSet) continue;
            if (selectedStickIds.has(stick.id)) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(shaftSet.modelId);
            const shaftsForColor = grouped.get(color) ?? [];
            shaftsForColor.push(...shaftSet.shafts);
            if (shaftsForColor.length > 0) grouped.set(color, shaftsForColor);
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [state.sticks, dimNonSelected, resolveBaseColor, stickShaftsBySupport, selectedStickIds, restrictToActiveModel, activeModelId]);

    const sceneBatchedSupportBraceShaftGroups = useMemo(() => {
        const grouped = new Map<string, InstancedShaft[]>();

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            if (restrictToActiveModel && supportBrace.modelId !== activeModelId) continue;
            const shaftSet = supportBraceShaftsBySupport.get(supportBrace.id);
            if (!shaftSet) continue;
            if (selectedSupportBraceIds.has(supportBrace.id)) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(shaftSet.modelId);
            const shaftsForColor = grouped.get(color) ?? [];
            shaftsForColor.push(...shaftSet.shafts);
            if (shaftsForColor.length > 0) grouped.set(color, shaftsForColor);
        }

        return Array.from(grouped.entries()).map(([color, shafts]) => ({ color, shafts }));
    }, [supportBraceState.supportBraces, dimNonSelected, resolveBaseColor, supportBraceShaftsBySupport, selectedSupportBraceIds, restrictToActiveModel, activeModelId]);

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

    const sceneBatchedTrunkRootGroups = useMemo(() => {
        if (hidePlateContactPrimitives) return [] as Array<{ color: string; roots: InstancedRoot[] }>;

        const grouped = new Map<string, InstancedRoot[]>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const trunk of Object.values(state.trunks)) {
            if (restrictToActiveModel && trunk.modelId !== activeModelId) continue;
            if (selectedTrunkIds.has(trunk.id)) continue;

            const root = state.roots[trunk.rootId];
            if (!root) continue;

            const shaftDiameter = Math.max(0.001, trunk.segments[0]?.diameter ?? 1.5);
            const topRadius = shaftDiameter / 2;
            const bottomRadius = Math.max(0.001, root.diameter / 2);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(trunk.modelId);
            const rootsForColor = grouped.get(color) ?? [];
            rootsForColor.push({
                id: root.id,
                supportId: trunk.id,
                modelId: trunk.modelId,
                basePos: {
                    x: root.transform.pos.x,
                    y: root.transform.pos.y,
                    z: root.transform.pos.z + verticalOffset,
                },
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
        hidePlateContactPrimitives,
        raftSettings.bottomMode,
        raftSettings.thickness,
        state.trunks,
        state.roots,
        dimNonSelected,
        resolveBaseColor,
        selectedTrunkIds,
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

            const color = dimNonSelected ? '#666666' : resolveBaseColor(coneSet.modelId);
            coneSet.cones.forEach((cone) => pushCone(color, cone));
        }

        for (const branch of Object.values(state.branches)) {
            if (selectedBranchIds.has(branch.id)) continue;
            const coneSet = contactConesBySupport.get(branch.id);
            if (!coneSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(coneSet.modelId);
            coneSet.cones.forEach((cone) => pushCone(color, cone));
        }

        for (const stick of Object.values(state.sticks)) {
            if (selectedStickIds.has(stick.id)) continue;
            const coneSet = contactConesBySupport.get(stick.id);
            if (!coneSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(coneSet.modelId);
            coneSet.cones.forEach((cone) => pushCone(color, cone));
        }

        for (const leaf of Object.values(state.leaves)) {
            if (selectedLeafIds.has(leaf.id)) continue;
            const coneSet = contactConesBySupport.get(leaf.id);
            if (!coneSet) continue;

            const color = dimNonSelected ? '#666666' : resolveBaseColor(coneSet.modelId);
            coneSet.cones.forEach((cone) => pushCone(color, cone));
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
        dimNonSelected,
        resolveBaseColor,
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

        const hoveredSupportId = sceneHoveredSupportId ?? (state.hoveredCategory === 'support' ? state.hoveredId : null);
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
    }, [isInteractable, sceneHoveredSupportId, state.hoveredCategory, state.hoveredId, trunkShaftsBySupport, branchShaftsBySupport, braceShaftsBySupport, twigShaftsBySupport, stickShaftsBySupport, supportBraceShaftsBySupport]);

    const hoveredSupportOverlayShafts = useMemo(() => {
        if (!hoveredSupportShaftSet) return [] as InstancedShaft[];

        return hoveredSupportShaftSet.shafts.map((shaft) => ({
            ...shaft,
            diameter: shaft.diameter * 1.02,
        }));
    }, [hoveredSupportShaftSet]);

    const hoveredSupportConeSet = useMemo(() => {
        if (!isInteractable) return null;

        const hoveredSupportId = sceneHoveredSupportId ?? (state.hoveredCategory === 'support' ? state.hoveredId : null);
        if (!hoveredSupportId) return null;

        return contactConesBySupport.get(hoveredSupportId) ?? null;
    }, [isInteractable, sceneHoveredSupportId, state.hoveredCategory, state.hoveredId, contactConesBySupport]);

    const hoveredSupportOverlayCones = useMemo(() => {
        if (!hoveredSupportConeSet) return [] as InstancedContactCone[];
        return hoveredSupportConeSet.cones;
    }, [hoveredSupportConeSet]);

    const hoveredSupportJointSet = useMemo(() => {
        if (!isInteractable) return null;

        const hoveredSupportId = sceneHoveredSupportId ?? (state.hoveredCategory === 'support' ? state.hoveredId : null);
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
        sceneHoveredSupportId,
        state.hoveredCategory,
        state.hoveredId,
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
            diameter: joint.diameter * 1.06,
        }));
    }, [hoveredSupportJointSet]);

    const handleSceneBatchedShaftClick = React.useCallback((shaft: InstancedShaft, event: { nativeEvent?: Event }) => {
        if (!isInteractable) return;
        if (!shaft.supportId) return;
        handleSupportClick(event, shaft.supportId, isInteractable);
    }, [isInteractable]);

    const handleSceneBatchedShaftPointerMove = React.useCallback((shaft: InstancedShaft) => {
        if (!isInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = shaft.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(shaft.modelId ?? null);
    }, [isInteractable]);

    const handleSceneBatchedShaftPointerOut = React.useCallback(() => {
        if (!isInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
        }

        pendingSceneHoverClearFrameRef.current = requestAnimationFrame(() => {
            pendingSceneHoverClearFrameRef.current = null;
            setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
            emitSupportModelPointerHover(null);
        });
    }, [isInteractable]);

    const handleSceneBatchedRootClick = React.useCallback((root: InstancedRoot, event: { nativeEvent?: Event }) => {
        if (!isInteractable) return;
        if (!root.supportId) return;
        handleSupportClick(event, root.supportId, isInteractable);
    }, [isInteractable]);

    const handleSceneBatchedRootPointerMove = React.useCallback((root: InstancedRoot) => {
        if (!isInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = root.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(root.modelId ?? null);
    }, [isInteractable]);

    const handleSceneBatchedConeClick = React.useCallback((cone: InstancedContactCone, event: { nativeEvent?: Event }) => {
        if (!isInteractable) return;
        if (!cone.supportId) return;
        handleSupportClick(event, cone.supportId, isInteractable);
    }, [isInteractable]);

    const handleSceneBatchedConePointerMove = React.useCallback((cone: InstancedContactCone) => {
        if (!isInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = cone.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(cone.modelId ?? null);
    }, [isInteractable]);

    const handleSceneBatchedJointClick = React.useCallback((joint: InstancedJoint, event: { nativeEvent?: Event }) => {
        if (!isInteractable) return;
        if (!joint.supportId) return;
        handleSupportClick(event, joint.supportId, isInteractable);
    }, [isInteractable]);

    const handleSceneBatchedJointPointerMove = React.useCallback((joint: InstancedJoint) => {
        if (!isInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        if (pendingSceneHoverClearFrameRef.current != null) {
            cancelAnimationFrame(pendingSceneHoverClearFrameRef.current);
            pendingSceneHoverClearFrameRef.current = null;
        }

        const nextSupportId = joint.supportId ?? null;
        setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
        emitSupportModelPointerHover(joint.modelId ?? null);
    }, [isInteractable]);

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
                    radialSegments={sceneBatchedShaftRadialSegments}
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {sceneBatchedJointGroups.map((group) => (
                <InstancedJointGroup
                    key={`scene-joint-batch:${group.color}:${group.joints.length}`}
                    joints={group.joints}
                    color={group.color}
                    widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                    heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                    onJointClick={isInteractable ? handleSceneBatchedJointClick : undefined}
                    onJointPointerMove={isInteractable ? handleSceneBatchedJointPointerMove : undefined}
                    onJointPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {sceneBatchedTrunkRootGroups.map((group) => (
                <InstancedRootsGroup
                    key={`scene-trunk-root-batch:${group.color}:${group.roots.length}`}
                    roots={group.roots}
                    color={group.color}
                    onRootClick={isInteractable ? handleSceneBatchedRootClick : undefined}
                    onRootPointerMove={isInteractable ? handleSceneBatchedRootPointerMove : undefined}
                    onRootPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {sceneBatchedContactConeGroups.map((group) => (
                <InstancedContactConeGroup
                    key={`scene-cone-batch:${group.color}:${group.cones.length}`}
                    cones={group.cones}
                    color={group.color}
                    onConeClick={isInteractable ? handleSceneBatchedConeClick : undefined}
                    onConePointerMove={isInteractable ? handleSceneBatchedConePointerMove : undefined}
                    onConePointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
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
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {hoveredSupportOverlayCones.length > 0 && hoveredSupportConeSet && (
                <InstancedContactConeGroup
                    key={`scene-cone-hover-overlay:${hoveredSupportConeSet.supportId}:${hoveredSupportOverlayCones.length}`}
                    cones={hoveredSupportOverlayCones}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportConeSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.3}
                    onConeClick={isInteractable ? handleSceneBatchedConeClick : undefined}
                    onConePointerMove={isInteractable ? handleSceneBatchedConePointerMove : undefined}
                    onConePointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {hoveredSupportOverlayJoints.length > 0 && hoveredSupportJointSet && (
                <InstancedJointGroup
                    key={`scene-joint-hover-overlay:${hoveredSupportJointSet.supportId}:${hoveredSupportOverlayJoints.length}`}
                    joints={hoveredSupportOverlayJoints}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportJointSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.3}
                    widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                    heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                    onJointClick={isInteractable ? handleSceneBatchedJointClick : undefined}
                    onJointPointerMove={isInteractable ? handleSceneBatchedJointPointerMove : undefined}
                    onJointPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
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
                        deferRootsToSceneBatch={!effectiveSelected}
                        deferContactConesToSceneBatch={!effectiveSelected && !!trunk.contactCone}
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
                    radialSegments={sceneBatchedShaftRadialSegments}
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
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
                        deferContactConesToSceneBatch={!effectiveSelected && !!branch.contactCone}
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
                        deferContactConesToSceneBatch={!effectiveSelected && !!leaf.contactCone}
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
                const isTwigHovered = (state.hoveredCategory === 'support' && state.hoveredId === twig.id)
                    || sceneHoveredSupportId === twig.id;
                const deferTwigInteractionToSceneBatch = !effectiveSelected && twigShaftsBySupport.has(twig.id);

                return (
                    <group key={twig.id}>
                    <TwigRenderer
                        key={twig.id}
                        twig={twig}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isTwigHovered}
                        baseColor={resolveBaseColor(twig.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && twigShaftsBySupport.has(twig.id)}
                        deferInteractionToSceneBatch={deferTwigInteractionToSceneBatch}
                    />
                    </group>
                );
            })}

            {sceneBatchedTwigShaftGroups.map((group) => (
                <InstancedShaftGroup
                    key={`scene-twig-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={sceneBatchedShaftRadialSegments}
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

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
                const isStickHovered = (state.hoveredCategory === 'support' && state.hoveredId === stick.id)
                    || sceneHoveredSupportId === stick.id;
                const deferStickInteractionToSceneBatch = !effectiveSelected && stickShaftsBySupport.has(stick.id);

                return (
                    <group key={stick.id}>
                    <StickRenderer
                        key={stick.id}
                        stick={stick}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? state.selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isStickHovered}
                        baseColor={resolveBaseColor(stick.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && stickShaftsBySupport.has(stick.id)}
                        deferInteractionToSceneBatch={deferStickInteractionToSceneBatch}
                        deferContactConesToSceneBatch={!effectiveSelected}
                    />
                    </group>
                );
            })}

            {sceneBatchedStickShaftGroups.map((group) => (
                <InstancedShaftGroup
                    key={`scene-stick-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={sceneBatchedShaftRadialSegments}
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}

            {/* Render Braces */}
            {sceneBatchedBraceShaftGroups.map((group) => (
                <InstancedShaftGroup
                    key={`scene-brace-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={sceneBatchedShaftRadialSegments}
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
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
                const isSupportBraceHovered = (state.hoveredCategory === 'support' && state.hoveredId === supportBrace.id)
                    || sceneHoveredSupportId === supportBrace.id;
                const deferSupportBraceInteractionToSceneBatch = !effectiveSelected && supportBraceShaftsBySupport.has(supportBrace.id);
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
                        isHovered={isSupportBraceHovered}
                        baseColor={resolveBaseColor(supportBrace.modelId)}
                        showKnot={showKnot}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && supportBraceShaftsBySupport.has(supportBrace.id)}
                        deferInteractionToSceneBatch={deferSupportBraceInteractionToSceneBatch}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                    />
                    </group>
                );
            })}

            {sceneBatchedSupportBraceShaftGroups.map((group) => (
                <InstancedShaftGroup
                    key={`scene-support-brace-batch:${group.color}:${group.shafts.length}`}
                    shafts={group.shafts}
                    color={group.color}
                    radialSegments={sceneBatchedShaftRadialSegments}
                    onShaftClick={isInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            ))}
        </group>
    );
});

SupportRenderer.displayName = 'SupportRenderer';
