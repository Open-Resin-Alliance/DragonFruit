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
import { KickstandRenderer } from './SupportTypes/Kickstand/KickstandRenderer';
import { AnchorRenderer } from './SupportTypes/Anchor/AnchorRenderer';
import { InstancedShaftGroup, type InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import { InstancedJointGroup, type InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import { InstancedRootsGroup, type InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import { InstancedContactConeGroup, type InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { useBracePlacementState } from './SupportTypes/Brace/bracePlacementState';
import { useKickstandStoreState } from './SupportTypes/Kickstand/kickstandStore';
import { useKickstandPlacementState } from './SupportTypes/Kickstand/kickstandPlacementState';
import { useJointInteraction } from './SupportPrimitives/Joint/useJointInteraction';
import { useKnotInteraction } from './SupportPrimitives/Knot/useKnotInteraction';
import { useActiveJointDragPreview, useJointDragPreviewOverrides } from './interaction/jointDragPreview';
import { useActiveKnotDragPreview } from './interaction/knotDragPreview';
import { buildBranchCandidateKnotIdsByBranchId, buildBranchesByParentKnotId, buildBraceIdsByKnotId, buildLeafIdsByParentKnotId, collectGhostedBraceIds, collectPreviewLeavesById, computeCascadedPreviewKnotOverrides } from './interaction/supportPreviewOverlay';
import { JointCreationManager } from './SupportPrimitives/Joint/JointCreationManager';
import { JointGizmo } from './SupportPrimitives/Joint/JointGizmo';
import { KnotGizmo } from './SupportPrimitives/Knot/KnotGizmo';
import { BezierGizmoManager } from './Curves/BezierGizmo/BezierGizmoManager';
import { ContactDisk, SupportMode, BezierSegment, type Knot, type Leaf } from './types';
import { bezierToLineSegments, calculateAdaptiveBezierResolution } from './Curves/BezierUtils';
import type { SupportData } from './rendering';
import type { BracePreviewData } from './SupportTypes/Brace/bracePlacementState';
import { useJointCreationState } from './SupportPrimitives/Joint/jointCreationState';
import { useSupportHistoryHandlers } from './history/useSupportHistoryHandlers';
import { subscribeToSettings, getSettingsSnapshot } from './Settings/state';
import { emitSupportModelPointerHover, emitSupportModelPointerSelect, handleSupportClick } from './interaction/clickHandlers';
import { useResolvedSelectionState } from './interaction/shared/selection/resolvedSelectionStore';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { getRaftSettings, subscribeToRaftStore } from './Rafts/Crenelated/RaftState';
import { JOINT_DIAMETER_OFFSET_MM } from './constants';
import { DEBUG_SECTION_COLORS as AUTO_BRACING_DEBUG_SECTION_COLORS } from './autoBracing/settings';
import { VoronoiSeedDebugMarkers } from './autoBracing/VoronoiSeedDebugMarkers';
import { clearSupportMarqueeHover, setSupportMarqueeHoverBlocked, useSupportMarqueeHoverState } from './interaction/shared/hover/sceneHoverMarquee';
import { applySceneHoverWriteDecision, resolveSceneBatchedShaftHoverWriteDecision, resolveSceneBatchedShaftPointerOutWriteDecision, resolveSceneBatchedSupportHoverWriteDecision, shouldClearSceneHoverForSelectedPrimitiveSuppression, shouldClearSceneHoverForSelectionChange } from './interaction/shared/hover/sceneHoverController';
import { cancelPendingSceneHoverClearFrame, clearImmediateModelHover } from './interaction/shared/hover/sceneHoverReset';
import { isJointHoverCategory, resolveHoveredSupportOwnerId, resolveHoveredSupportVisualState, resolveRawSupportHoverSuppressionState, resolveSelectedPrimitiveHoverSuppression } from './interaction/shared/hover/supportHoverResolver';
import { setSceneHoveredSupportId as setSharedSceneHoveredSupportId, useSceneHoveredSupportId } from './interaction/shared/hover/sceneHoverStore';
import { useSupportRenderLookup } from './interaction/useSupportRenderLookup';

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
    trunkPlacementPreview?: SupportData | null;
    branchPlacementPreview?: SupportData | null;
    leafPlacementPreview?: SupportData | null;
    bracePlacementPreview?: BracePreviewData | null;
    kickstandPlacementPreview?: SupportData | null;
}

interface PlacementPreviewBatch {
    id: string;
    color: string;
    opacity: number;
    shafts: InstancedShaft[];
    joints: InstancedJoint[];
    roots: InstancedRoot[];
    cones: InstancedContactCone[];
}

function applyBatchedBezierSeamOverlap(
    points: Array<{ x: number; y: number; z: number }>,
    index: number,
    diameter: number,
) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const length = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));

    if (length < 1e-6) {
        return { start, end };
    }

    const invLen = 1 / length;
    const ux = dx * invLen;
    const uy = dy * invLen;
    const uz = dz * invLen;

    const baseOverlap = Math.max(0.015, Math.min(0.45, diameter * 0.22));
    const overlap = Math.min(baseOverlap, Math.max(0, length * 0.45));
    const isFirst = index === 0;
    const isLast = index === points.length - 2;
    const startShift = isFirst ? 0 : overlap;
    const endShift = isLast ? 0 : overlap;

    return {
        start: {
            x: start.x - (ux * startShift),
            y: start.y - (uy * startShift),
            z: start.z - (uz * startShift),
        },
        end: {
            x: end.x + (ux * endShift),
            y: end.y + (uy * endShift),
            z: end.z + (uz * endShift),
        },
    };
}

/** Tessellate a bezier segment into multiple straight InstancedShaft entries for batched rendering. */
function tesselllateBezierToShafts(
    segment: BezierSegment,
    startPos: { x: number; y: number; z: number },
    endPos: { x: number; y: number; z: number },
    supportId: string,
    modelId?: string,
): InstancedShaft[] {
    const BATCHED_BEZIER_MIN_RESOLUTION = 4;
    const BATCHED_BEZIER_MAX_RESOLUTION = 24;
    const adaptiveResolution = calculateAdaptiveBezierResolution(
        startPos,
        segment.controlPoint1,
        segment.controlPoint2,
        endPos,
        {
            minResolution: BATCHED_BEZIER_MIN_RESOLUTION,
            maxResolution: BATCHED_BEZIER_MAX_RESOLUTION,
            targetChordLengthMm: 2.5,
            curvatureWeight: 2.0,
        },
    );
    const res = Math.max(2, segment.resolution ?? adaptiveResolution);
    const points = bezierToLineSegments(startPos, segment.controlPoint1, segment.controlPoint2, endPos, res);
    const shafts: InstancedShaft[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const overlapped = applyBatchedBezierSeamOverlap(points, i, segment.diameter);
        shafts.push({
            id: segment.id,
            start: overlapped.start,
            end: overlapped.end,
            diameter: segment.diameter,
            supportId,
            modelId,
        });
    }
    return shafts;
}

function tessellateBraceBezierToShafts(
    segmentId: string,
    startPos: { x: number; y: number; z: number },
    endPos: { x: number; y: number; z: number },
    controlPoint1: { x: number; y: number; z: number },
    controlPoint2: { x: number; y: number; z: number },
    diameter: number,
    supportId: string,
    modelId?: string,
): InstancedShaft[] {
    const adaptiveResolution = calculateAdaptiveBezierResolution(
        startPos,
        controlPoint1,
        controlPoint2,
        endPos,
        {
            minResolution: 4,
            maxResolution: 24,
            targetChordLengthMm: 2.5,
            curvatureWeight: 2.0,
        },
    );
    const points = bezierToLineSegments(startPos, controlPoint1, controlPoint2, endPos, adaptiveResolution);
    const shafts: InstancedShaft[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const overlapped = applyBatchedBezierSeamOverlap(points, i, diameter);
        shafts.push({
            id: segmentId,
            start: overlapped.start,
            end: overlapped.end,
            diameter,
            supportId,
            modelId,
        });
    }
    return shafts;
}

function recomputeLeafPreviewContactCone(
    leaf: Leaf,
    previewKnotPos: { x: number; y: number; z: number },
) {
    const cone = leaf.contactCone;
    if (!cone?.surfaceNormal) return leaf;

    const tip = new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z);
    const sn = new THREE.Vector3(cone.surfaceNormal.x, cone.surfaceNormal.y, cone.surfaceNormal.z);
    const knot = new THREE.Vector3(previewKnotPos.x, previewKnotPos.y, previewKnotPos.z);

    let axis = knot.clone().sub(tip);
    if (axis.lengthSq() < 0.000001) {
        axis.set(sn.x, sn.y, sn.z);
    }
    axis.normalize();

    let finalLength = Math.max(0.1, knot.distanceTo(tip));

    for (let i = 0; i < 3; i++) {
        const axisVec3 = { x: axis.x, y: axis.y, z: axis.z };
        const thickness = cone.profile.type === 'disk'
            ? calculateDiskThickness(cone.surfaceNormal, axisVec3, cone.profile)
            : 0;

        const start = tip.clone().add(sn.clone().multiplyScalar(thickness));
        const coneVec = knot.clone().sub(start);
        const len = coneVec.length();
        if (len > 0.000001) {
            axis = coneVec.normalize();
            finalLength = Math.max(0.1, len);
        }
    }

    const oldNormal = cone.normal;
    const oldLen = cone.profile.lengthMm;
    if (
        oldLen === finalLength
        && oldNormal.x === axis.x
        && oldNormal.y === axis.y
        && oldNormal.z === axis.z
    ) {
        return leaf;
    }

    return {
        ...leaf,
        contactCone: {
            ...cone,
            normal: { x: axis.x, y: axis.y, z: axis.z },
            profile: {
                ...cone.profile,
                lengthMm: finalLength,
            },
        },
    };
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
const EMPTY_SUPPORT_ID_LIST: readonly string[] = Object.freeze([]);

const PLACEMENT_PREVIEW_COLOR = '#00ff00';
const PLACEMENT_PREVIEW_ERROR_COLOR = '#ff0000';
const PLACEMENT_PREVIEW_WARNING_COLOR = '#ffcc00';
const PLACEMENT_PREVIEW_ORANGE_COLOR = '#c7722f';
const PLACEMENT_PREVIEW_OPACITY = 0.5;
const PLACEMENT_PREVIEW_ERROR_OPACITY = 0.15;
const FREEZE_DEPENDENT_PREVIEW_DURING_JOINT_DRAG = true;
const EMPTY_KNOT_DRAG_BRANCH_SEGMENTS_BY_ID: Record<string, never> = Object.freeze({});

function resolvePlacementPreviewMaterial(preview: SupportData): { color: string; opacity: number } {
    if (preview.error) {
        return {
            color: PLACEMENT_PREVIEW_ERROR_COLOR,
            opacity: PLACEMENT_PREVIEW_ERROR_OPACITY,
        };
    }

    let angle = preview.angle;
    if (angle === undefined && preview.contactCone) {
        const normal = new THREE.Vector3(
            preview.contactCone.normal.x,
            preview.contactCone.normal.y,
            preview.contactCone.normal.z,
        );
        const up = new THREE.Vector3(0, 0, 1);
        angle = normal.angleTo(up) * (180 / Math.PI);
    }

    if (angle !== undefined) {
        const startAngle = 91;
        const midAngle = 120;
        const endAngle = 180;

        let finalColor: THREE.Color;
        if (angle <= midAngle) {
            const t = Math.max(0, (angle - startAngle) / (midAngle - startAngle));
            const c1 = new THREE.Color(PLACEMENT_PREVIEW_ORANGE_COLOR);
            const c2 = new THREE.Color(PLACEMENT_PREVIEW_WARNING_COLOR);
            finalColor = c1.lerp(c2, t);
        } else {
            const t = Math.min(1, (angle - midAngle) / (endAngle - midAngle));
            const c1 = new THREE.Color(PLACEMENT_PREVIEW_WARNING_COLOR);
            const c2 = new THREE.Color(PLACEMENT_PREVIEW_COLOR);
            finalColor = c1.lerp(c2, t);
        }

        return {
            color: `#${finalColor.getHexString()}`,
            opacity: PLACEMENT_PREVIEW_OPACITY,
        };
    }

    if (preview.warning) {
        return {
            color: PLACEMENT_PREVIEW_WARNING_COLOR,
            opacity: PLACEMENT_PREVIEW_OPACITY,
        };
    }

    return {
        color: PLACEMENT_PREVIEW_COLOR,
        opacity: PLACEMENT_PREVIEW_OPACITY,
    };
}

function buildSupportPlacementPreviewBatch(
    id: string,
    preview: SupportData,
    hasSolidBottom: boolean,
    raftThickness: number,
): PlacementPreviewBatch | null {
    const shafts: InstancedShaft[] = [];
    const jointsMap = new Map<string, InstancedJoint>();
    const roots: InstancedRoot[] = [];
    const cones: InstancedContactCone[] = [];

    let currentStart: THREE.Vector3;

    if (preview.roots) {
        const root = preview.roots;
        const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
        const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
        const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;
        const shaftDiameter = Math.max(0.001, preview.segments[0]?.diameter ?? root.diameter);

        roots.push({
            id: root.id,
            supportId: id,
            modelId: root.modelId,
            basePos: {
                x: basePos.x,
                y: basePos.y,
                z: basePos.z + verticalOffset,
            },
            bottomRadius: Math.max(0.001, root.diameter / 2),
            topRadius: shaftDiameter / 2,
            effectiveDiskHeight,
            coneHeight: Math.max(0, root.coneHeight),
        });

        currentStart = basePos.clone().add(new THREE.Vector3(0, 0, verticalOffset + effectiveDiskHeight + Math.max(0, root.coneHeight)));
    } else if (preview.startPos) {
        currentStart = new THREE.Vector3(preview.startPos.x, preview.startPos.y, preview.startPos.z);
    } else if (preview.contactCones && preview.contactCones.length > 0) {
        const socketPos = getFinalSocketPosition(preview.contactCones[0]);
        currentStart = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else if (preview.contactCone) {
        const socketPos = getFinalSocketPosition(preview.contactCone);
        currentStart = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else if (preview.segments[0]?.bottomJoint) {
        const p = preview.segments[0].bottomJoint.pos;
        currentStart = new THREE.Vector3(p.x, p.y, p.z);
    } else {
        currentStart = new THREE.Vector3(0, 0, 0);
    }

    if (preview.knot && preview.segments.length > 0) {
        jointsMap.set(preview.knot.id, {
            id: preview.knot.id,
            pos: preview.knot.pos,
            diameter: Math.max(0.001, preview.knot.diameter ?? ((preview.segments[0]?.diameter ?? 1) + 0.1)),
            supportId: id,
        });
    }

    for (const segment of preview.segments) {
        if (segment.bottomJoint) {
            jointsMap.set(segment.bottomJoint.id, {
                id: segment.bottomJoint.id,
                pos: segment.bottomJoint.pos,
                diameter: segment.bottomJoint.diameter,
                supportId: id,
            });
        }
        if (segment.topJoint) {
            jointsMap.set(segment.topJoint.id, {
                id: segment.topJoint.id,
                pos: segment.topJoint.pos,
                diameter: segment.topJoint.diameter,
                supportId: id,
            });
        }
    }

    const lastSegmentIndex = preview.segments.length - 1;
    preview.segments.forEach((segment, index) => {
        if (segment.bottomJoint) {
            currentStart = new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z);
        }

        let endPoint: THREE.Vector3;
        if (segment.topJoint) {
            endPoint = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
        } else if (preview.contactCone && index === lastSegmentIndex) {
            const socketPos = getFinalSocketPosition(preview.contactCone);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else if (preview.contactCones && preview.contactCones.length > 0 && index === lastSegmentIndex) {
            const socketPos = getFinalSocketPosition(preview.contactCones[preview.contactCones.length - 1]);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else {
            endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
        }

        if (segment.type === 'bezier') {
            shafts.push(
                ...tesselllateBezierToShafts(
                    segment as BezierSegment,
                    { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                    { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                    id,
                ),
            );
        } else {
            shafts.push({
                id: segment.id,
                start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                diameter: segment.diameter,
                supportId: id,
            });
        }

        currentStart = endPoint;
    });

    const allCones = preview.contactCones?.length
        ? preview.contactCones
        : preview.contactCone
            ? [preview.contactCone]
            : [];

    allCones.forEach((cone, index) => {
        cones.push({
            id: cone.id ?? `${id}:cone:${index}`,
            supportId: id,
            pos: cone.pos,
            normal: cone.normal,
            surfaceNormal: cone.surfaceNormal,
            diskLengthOverride: cone.diskLengthOverride,
            profile: cone.profile,
        });
    });

    if (shafts.length === 0 && jointsMap.size === 0 && roots.length === 0 && cones.length === 0) {
        return null;
    }

    const { color, opacity } = resolvePlacementPreviewMaterial(preview);
    return {
        id,
        color,
        opacity,
        shafts,
        joints: Array.from(jointsMap.values()),
        roots,
        cones,
    };
}

function buildBracePlacementPreviewBatch(id: string, preview: BracePreviewData): PlacementPreviewBatch | null {
    const start = preview.start;
    const end = preview.end;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const lenSq = dx * dx + dy * dy + dz * dz;
    const startDiameter = Math.max(0.001, preview.startDiameterMm);
    const endDiameter = Math.max(0.001, preview.endDiameterMm);
    const knotStartDiameter = Math.max(0.001, preview.startDiameterMm + 0.1);
    const knotEndDiameter = Math.max(0.001, preview.endDiameterMm + 0.1);

    const joints: InstancedJoint[] = [
        {
            id: `${id}:start-joint`,
            pos: start,
            diameter: knotStartDiameter,
            supportId: id,
        },
    ];

    const shafts: InstancedShaft[] = [];
    if (lenSq >= 1e-6) {
        shafts.push({
            id: `${id}:shaft`,
            start,
            end,
            diameter: (startDiameter + endDiameter) / 2,
            supportId: id,
        });

        joints.push({
            id: `${id}:end-joint`,
            pos: end,
            diameter: knotEndDiameter,
            supportId: id,
        });
    }

    return {
        id,
        color: PLACEMENT_PREVIEW_COLOR,
        opacity: PLACEMENT_PREVIEW_OPACITY,
        shafts,
        joints,
        roots: [],
        cones: [],
    };
}

export const SupportRenderer = forwardRef<THREE.Group, SupportRendererProps>(({ mode, navigationLodActive = false, hidePlateContactPrimitives = false, clipLower, clipUpper, activeModelId = null, selectedModelIds = [], hoverModelId = null, modelDropOffsetsById, modelFilterId = null, excludeModelId = null, excludeModelIds = [], passive = false, disableSelectionAndHover = false, ghostOpacity = 1, ghostRenderOrder = 0, trunkPlacementPreview = null, branchPlacementPreview = null, leafPlacementPreview = null, bracePlacementPreview = null, kickstandPlacementPreview = null }, ref) => {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const resolvedSelection = useResolvedSelectionState();
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const raftSettings = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
    const kickstandState = useKickstandStoreState();
    const activeJointDragPreview = useActiveJointDragPreview();
    const { isActive: isJointCreationActive } = useJointCreationState();
    const { altActive: braceAltActive } = useBracePlacementState();
    const { hotkeyActive: kickstandHotkeyActive } = useKickstandPlacementState();

    const selectionEnabled = mode === 'support';
    const effectiveSelectedSupportIds = selectionEnabled ? resolvedSelection.selectedIds : [];
    const selectedSupportIdSet = useMemo(() => new Set(effectiveSelectedSupportIds), [effectiveSelectedSupportIds]);
    const selectedId = selectionEnabled ? resolvedSelection.selectedId : null;
    const selectedCategory = selectionEnabled ? resolvedSelection.selectedCategory : null;
    const hasSupportMultiSelection = effectiveSelectedSupportIds.length > 0;
    const useMultiSelectionDetail = hasSupportMultiSelection && effectiveSelectedSupportIds.length <= MULTI_SELECTION_DETAIL_THRESHOLD;
    const dimNonSelected = selectedId !== null || hasSupportMultiSelection;
    const hideUnselectedKnots = selectedId !== null || hasSupportMultiSelection;
    const enableTwigSceneBatching = false;

    const interactionHooksEnabled = !passive;
    const [gizmoInteractionLockActive, setGizmoInteractionLockActive] = React.useState(false);
    const knotGizmoInteractionLockTimeoutRef = React.useRef<number | null>(null);
    const [contactDiskHudHoverActive, setContactDiskHudHoverActive] = React.useState(false);
    useEffect(() => {
        if (typeof window === 'undefined') return;

        const handleContactDiskHudInteractionChange = (event: Event) => {
            const detail = (event as CustomEvent<{ active?: boolean }>).detail;
            setContactDiskHudHoverActive(!!detail?.active);
        };

        window.addEventListener('contact-disk-hud-interaction-change', handleContactDiskHudInteractionChange as EventListener);
        return () => {
            window.removeEventListener('contact-disk-hud-interaction-change', handleContactDiskHudInteractionChange as EventListener);
        };
    }, []);
    const rawHoveredCategory = state.hoveredCategory as string | null | undefined;
    const {
        primitiveHoverSuppressesSceneShaftHover,
        jointCategoryHoverSuppressed,
    } = resolveRawSupportHoverSuppressionState(rawHoveredCategory);
    const supportInteractionSuppressed = mode === 'support' && (disableSelectionAndHover || gizmoInteractionLockActive || contactDiskHudHoverActive);
    const supportSelectionAndHoverSuppressed = supportInteractionSuppressed;
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
    const filteredActiveModelId = restrictToActiveModel ? activeModelId : null;
    const suppressHover = supportSelectionAndHoverSuppressed || isJointCreationActive || !isInteractable || braceAltActive;
    const [immediateModelHoverId, setImmediateModelHoverId] = React.useState<string | null>(null);
    const [immediatePrepareActiveModelId, setImmediatePrepareActiveModelId] = React.useState<string | null>(null);
    const lastSyncedPrepareActiveModelIdRef = React.useRef<string | null>(activeModelId ?? null);
    const sceneHoveredSupportId = useSceneHoveredSupportId();
    const setSceneHoveredSupportId = setSharedSceneHoveredSupportId;
    const pendingSceneHoverClearFrameRef = React.useRef<number | null>(null);
    const orbitInteractionActiveRef = React.useRef(false);
    const marqueeHover = useSupportMarqueeHoverState();
    const marqueeHoveredSupportId = supportSelectionAndHoverSuppressed ? null : marqueeHover.supportId;
    const marqueeHoveredSupportIds = supportSelectionAndHoverSuppressed ? EMPTY_SUPPORT_ID_LIST : marqueeHover.supportIds;
    const marqueeHoveredSupportIdSet = useMemo(() => new Set(marqueeHoveredSupportIds), [marqueeHoveredSupportIds]);
    const activeKnotDragPreview = useActiveKnotDragPreview();
    const supportRenderLookupInput = useMemo(() => ({
        state: {
            roots: state.roots,
            trunks: state.trunks,
            branches: state.branches,
            leaves: state.leaves,
            twigs: state.twigs,
            sticks: state.sticks,
            braces: state.braces,
            knots: state.knots,
        },
        kickstandState: {
            kickstands: kickstandState.kickstands,
            knots: kickstandState.knots,
        },
        // Keep worker lookups driven by committed state only.
        // Drag previews are resolved locally in this renderer to avoid per-frame
        // structured-clone payload churn during joint dragging.
        activePreviewSupport: null,
    }), [
        state.roots,
        state.trunks,
        state.branches,
        state.leaves,
        state.twigs,
        state.sticks,
        state.braces,
        state.knots,
        kickstandState.kickstands,
        kickstandState.knots,
    ]);
    const supportRenderLookup = useSupportRenderLookup(supportRenderLookupInput);

    const trunkList = useMemo(() => Object.values(state.trunks), [state.trunks]);
    const branchList = useMemo(() => Object.values(state.branches), [state.branches]);
    const leafList = useMemo(() => Object.values(state.leaves), [state.leaves]);
    const twigList = useMemo(() => Object.values(state.twigs), [state.twigs]);
    const stickList = useMemo(() => Object.values(state.sticks), [state.sticks]);
    const braceList = useMemo(() => Object.values(state.braces), [state.braces]);
    const anchorList = useMemo(() => Object.values(state.anchors), [state.anchors]);
    const kickstandList = useMemo(() => Object.values(kickstandState.kickstands), [kickstandState.kickstands]);
    const knotList = useMemo(() => Object.values(state.knots), [state.knots]);
    const kickstandKnotList = useMemo(() => Object.values(kickstandState.knots), [kickstandState.knots]);

    const entitySegmentModelIdById = useMemo(() => {
        const map = new Map<string, string | undefined>();
        for (const [id, modelId] of Object.entries(supportRenderLookup.entitySegmentModelIdById)) {
            map.set(id, modelId);
        }
        return map;
    }, [supportRenderLookup.entitySegmentModelIdById]);

    const entityModelIdByKnotId = useMemo(() => {
        const map = new Map<string, string | undefined>();
        for (const [id, modelId] of Object.entries(supportRenderLookup.entityModelIdByKnotId)) {
            map.set(id, modelId);
        }
        return map;
    }, [supportRenderLookup.entityModelIdByKnotId]);

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

        const kickstand = kickstandState.kickstands[supportId];
        if (kickstand) {
            return kickstand.modelId
                ?? kickstandState.roots[kickstand.rootId]?.modelId
                ?? entityModelIdByKnotId.get(kickstand.hostKnotId);
        }

        return undefined;
    }, [state.trunks, state.branches, state.leaves, state.braces, state.twigs, state.sticks, kickstandState.kickstands, kickstandState.roots, entityModelIdByKnotId]);

    const isModelVisible = React.useCallback((modelId?: string, supportId?: string) => {
        const resolvedModelId = resolveSupportModelId(modelId, supportId);

        if ((restrictToActiveModel || modelFilterId || excludeModelId || excludedModelIdSet.size > 0) && !resolvedModelId) return false;
        if (restrictToActiveModel && resolvedModelId !== filteredActiveModelId) return false;
        if (modelFilterId && resolvedModelId !== modelFilterId) return false;
        if (excludeModelId && resolvedModelId === excludeModelId) return false;
        if (resolvedModelId && excludedModelIdSet.has(resolvedModelId)) return false;
        return true;
    }, [resolveSupportModelId, restrictToActiveModel, filteredActiveModelId, modelFilterId, excludeModelId, excludedModelIdSet]);

    useEffect(() => {
        setSupportMarqueeHoverBlocked(!interactionHooksEnabled || supportSelectionAndHoverSuppressed);
        return () => {
            setSupportMarqueeHoverBlocked(false);
        };
    }, [interactionHooksEnabled, supportSelectionAndHoverSuppressed]);

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
            cancelPendingSceneHoverClearFrame(pendingSceneHoverClearFrameRef);
            applySceneHoverWriteDecision(
                { type: 'clear', reason: 'interaction-suppressed' },
                pendingSceneHoverClearFrameRef,
                setSceneHoveredSupportId,
                emitSupportModelPointerHover,
            );
            clearSupportMarqueeHover();
        };

        const handleOrbitEnd = () => {
            orbitInteractionActiveRef.current = false;
        };

        const forceOrbitInactive = () => {
            orbitInteractionActiveRef.current = false;
        };

        window.addEventListener('model-pointer-hover-immediate', handleImmediateModelHover as EventListener);
        window.addEventListener('picking-orbit-start', handleOrbitStartOrChange);
        window.addEventListener('picking-orbit-change', handleOrbitStartOrChange);
        window.addEventListener('picking-orbit-end', handleOrbitEnd);
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
            const bezierDragging = !!w.__bezierGizmoDragging;
            const dragging = knotDragging || jointDragging || bezierDragging;
            const knotGuardUntil = typeof w.__knotGizmoGuardUntil === 'number' ? w.__knotGizmoGuardUntil : 0;
            const jointGuardUntil = typeof w.__jointGizmoGuardUntil === 'number' ? w.__jointGizmoGuardUntil : 0;
            const bezierGuardUntil = typeof w.__bezierGizmoGuardUntil === 'number' ? w.__bezierGizmoGuardUntil : 0;
            const guardUntil = Math.max(knotGuardUntil, jointGuardUntil, bezierGuardUntil);
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

        const handleBezierGizmoInteractionLock = (event: Event) => {
            const detail = (event as CustomEvent<{ active?: boolean; guardUntil?: number }>).detail;
            if (typeof detail?.active !== 'boolean') {
                refreshFromGlobals();
                return;
            }

            const w = window as any;
            if (typeof detail.active === 'boolean') {
                w.__bezierGizmoDragging = detail.active;
            }
            if (typeof detail.guardUntil === 'number') {
                w.__bezierGizmoGuardUntil = detail.guardUntil;
            }

            refreshFromGlobals();
        };

        refreshFromGlobals();
        window.addEventListener('knot-gizmo-interaction-lock', handleKnotGizmoInteractionLock as EventListener);
        window.addEventListener('joint-gizmo-interaction-lock', handleJointGizmoInteractionLock as EventListener);
        window.addEventListener('bezier-gizmo-interaction-lock', handleBezierGizmoInteractionLock as EventListener);
        return () => {
            window.removeEventListener('knot-gizmo-interaction-lock', handleKnotGizmoInteractionLock as EventListener);
            window.removeEventListener('joint-gizmo-interaction-lock', handleJointGizmoInteractionLock as EventListener);
            window.removeEventListener('bezier-gizmo-interaction-lock', handleBezierGizmoInteractionLock as EventListener);
            if (knotGizmoInteractionLockTimeoutRef.current != null) {
                window.clearTimeout(knotGizmoInteractionLockTimeoutRef.current);
                knotGizmoInteractionLockTimeoutRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!supportSelectionAndHoverSuppressed) return;

        cancelPendingSceneHoverClearFrame(pendingSceneHoverClearFrameRef);
        applySceneHoverWriteDecision(
            { type: 'clear', reason: 'interaction-suppressed' },
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
        clearSupportMarqueeHover();
        clearImmediateModelHover(setImmediateModelHoverId);
    }, [supportSelectionAndHoverSuppressed]);

    useEffect(() => {
        return () => {
            cancelPendingSceneHoverClearFrame(pendingSceneHoverClearFrameRef);
        };
    }, []);

    const effectiveHoverModelId = supportSelectionAndHoverSuppressed ? null : (immediateModelHoverId ?? hoverModelId);
    const effectiveVisualActiveModelId = mode === 'prepare'
        ? (immediatePrepareActiveModelId ?? activeModelId)
        : activeModelId;
    const hoveredCategoryForVisual = supportSelectionAndHoverSuppressed ? 'none' : state.hoveredCategory;
    const hoveredIdForVisual = supportSelectionAndHoverSuppressed ? null : state.hoveredId;
    const supportIdBySegmentId = useMemo(() => {
        const map = new Map<string, string>();
        for (const [id, supportId] of Object.entries(supportRenderLookup.supportIdBySegmentId)) map.set(id, supportId);
        return map;
    }, [supportRenderLookup.supportIdBySegmentId]);

    const supportIdByJointId = useMemo(() => {
        const map = new Map<string, string>();
        for (const [id, supportId] of Object.entries(supportRenderLookup.supportIdByJointId)) map.set(id, supportId);
        return map;
    }, [supportRenderLookup.supportIdByJointId]);

    const supportIdByKnotId = useMemo(() => {
        const map = new Map<string, string>();
        for (const [id, supportId] of Object.entries(supportRenderLookup.supportIdByKnotId)) map.set(id, supportId);
        return map;
    }, [supportRenderLookup.supportIdByKnotId]);

    const supportIdByContactDiskId = useMemo(() => {
        const map = new Map<string, string>();
        for (const [id, supportId] of Object.entries(supportRenderLookup.supportIdByContactDiskId)) map.set(id, supportId);
        // Add anchor contact cones (not indexed by render lookup worker)
        for (const anchor of anchorList) {
            if (anchor.contactCone?.id) map.set(anchor.contactCone.id, anchor.id);
        }
        return map;
    }, [supportRenderLookup.supportIdByContactDiskId, anchorList]);

    const hoveredSupportIdFromPicking = useMemo(() => {
        return resolveHoveredSupportOwnerId(
            hoveredIdForVisual,
            hoveredCategoryForVisual,
            supportIdBySegmentId,
            supportIdByJointId,
            supportIdByKnotId,
            supportIdByContactDiskId,
        );
    }, [hoveredCategoryForVisual, hoveredIdForVisual, supportIdBySegmentId, supportIdByJointId, supportIdByKnotId, supportIdByContactDiskId]);

    const selectedPrimitiveSupportId = useMemo(() => {
        if (!selectedId) return null;
        if (selectedCategory === 'joint') return supportIdByJointId.get(selectedId) ?? null;
        if (selectedCategory === 'segment') return supportIdBySegmentId.get(selectedId) ?? null;
        if (selectedCategory === 'contactDisk') return supportIdByContactDiskId.get(selectedId) ?? null;
        if (selectedCategory === 'knot') return supportIdByKnotId.get(selectedId) ?? null;
        return null;
    }, [selectedCategory, selectedId, supportIdByContactDiskId, supportIdByJointId, supportIdByKnotId, supportIdBySegmentId]);

    const {
        primitiveHoverOnSelectedSupport,
        selectedPrimitiveHoverActive,
        suppressSupportHoverForSelectedKnotSupport,
        suppressSupportHoverForSelectedJointSupport,
    } = resolveSelectedPrimitiveHoverSuppression(
        hoveredSupportIdFromPicking,
        hoveredCategoryForVisual,
        hoveredIdForVisual,
        selectedId,
        selectedCategory,
        selectedSupportIdSet,
        selectedPrimitiveSupportId,
    );

    const {
        hoveredSupportIdForVisual,
        hoveredSupportIsSelected,
    } = resolveHoveredSupportVisualState(
        marqueeHoveredSupportId,
        hoveredSupportIdFromPicking,
        sceneHoveredSupportId,
        hoveredCategoryForVisual,
        selectedPrimitiveHoverActive,
        suppressSupportHoverForSelectedKnotSupport,
        selectedSupportIdSet,
        selectedPrimitiveSupportId,
    );
    const previousSelectionKeyRef = React.useRef<string>('');

    useEffect(() => {
        const selectionKey = `${selectedId ?? ''}|${effectiveSelectedSupportIds.join(',')}`;
        if (previousSelectionKeyRef.current === selectionKey) return;
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;

        if (!shouldClearSceneHoverForSelectionChange(previousSelectionKey, selectionKey, sceneHoveredSupportId)) return;

        cancelPendingSceneHoverClearFrame(pendingSceneHoverClearFrameRef);
        applySceneHoverWriteDecision(
            { type: 'clear', reason: 'selection-changed' },
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
    }, [sceneHoveredSupportId, selectedId, effectiveSelectedSupportIds]);

    useEffect(() => {
        const clearForJointParent = selectedPrimitiveSupportId !== null
            && sceneHoveredSupportId !== null
            && sceneHoveredSupportId === selectedPrimitiveSupportId;

        if (!shouldClearSceneHoverForSelectedPrimitiveSuppression(
            selectedPrimitiveHoverActive,
            suppressSupportHoverForSelectedKnotSupport,
            suppressSupportHoverForSelectedJointSupport,
        ) && !clearForJointParent) return;

        cancelPendingSceneHoverClearFrame(pendingSceneHoverClearFrameRef);
        applySceneHoverWriteDecision(
            { type: 'clear', reason: 'selected-primitive-suppressed' },
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
    }, [selectedPrimitiveHoverActive, suppressSupportHoverForSelectedKnotSupport, suppressSupportHoverForSelectedJointSupport, selectedPrimitiveSupportId, sceneHoveredSupportId]);

    useEffect(() => {
        if (mode !== 'prepare') {
            setImmediatePrepareActiveModelId((prev) => (prev === null ? prev : null));
            return;
        }

        const handleModelClicked = (event: Event) => {
            const customEvent = event as CustomEvent<{ modelId?: string | null }>;
            const modelId = customEvent.detail?.modelId ?? null;
            setImmediatePrepareActiveModelId((prev) => (prev === modelId ? prev : modelId));
        };

        const handleModelDeselected = () => {
            setImmediatePrepareActiveModelId((prev) => (prev === null ? prev : null));
        };

        window.addEventListener('model-clicked', handleModelClicked as EventListener);
        window.addEventListener('model-deselected', handleModelDeselected);

        return () => {
            window.removeEventListener('model-clicked', handleModelClicked as EventListener);
            window.removeEventListener('model-deselected', handleModelDeselected);
        };
    }, [mode]);

    useEffect(() => {
        const next = (mode === 'prepare' && !passive) ? (activeModelId ?? null) : null;
        if (lastSyncedPrepareActiveModelIdRef.current === next) return;
        lastSyncedPrepareActiveModelIdRef.current = next;
        setImmediatePrepareActiveModelId((prev) => (prev === next ? prev : next));
    }, [activeModelId, mode, passive]);

    useEffect(() => {
        if (mode !== 'prepare') return;
        if (!immediatePrepareActiveModelId) return;
        if (selectedModelIdSet.has(immediatePrepareActiveModelId)) return;
        setImmediatePrepareActiveModelId((prev) => (prev === null ? prev : null));
    }, [immediatePrepareActiveModelId, mode, selectedModelIdSet]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const w = window as any;
        const knotGuardUntil = typeof w.__knotGizmoGuardUntil === 'number' ? w.__knotGizmoGuardUntil : 0;
        const jointGuardUntil = typeof w.__jointGizmoGuardUntil === 'number' ? w.__jointGizmoGuardUntil : 0;
        const bezierGuardUntil = typeof w.__bezierGizmoGuardUntil === 'number' ? w.__bezierGizmoGuardUntil : 0;
        const guardUntil = Math.max(knotGuardUntil, jointGuardUntil, bezierGuardUntil);
        w.__supportRendererDebug = {
            supportInteractionSuppressed,
            supportSelectionAndHoverSuppressed,
            disableSelectionAndHover,
            gizmoInteractionLockActive,
            jointCategoryHoverSuppressed,
            knotGizmoDragging: !!w.__knotGizmoDragging,
            jointGizmoDragging: !!w.__jointGizmoDragging,
            bezierGizmoDragging: !!w.__bezierGizmoDragging,
            knotGizmoGuardUntil: guardUntil,
            knotOnlyGuardUntil: knotGuardUntil,
            jointOnlyGuardUntil: jointGuardUntil,
            bezierOnlyGuardUntil: bezierGuardUntil,
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

    // Backfill Kickstand root/knot into global support state so raft + knot tools include them.
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

        for (const kickstand of kickstandList) {
            const root = kickstandState.roots[kickstand.rootId];
            if (root) {
                const existingRoot = state.roots[root.id] as typeof root | undefined;
                if (!existingRoot || rootDiffers(existingRoot, root)) {
                    addRoot(root);
                }
            }

            const hostKnot = kickstandState.knots[kickstand.hostKnotId];
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
        const kickstandRootIds = new Set(Object.values(kickstandState.kickstands).map((kickstand) => kickstand.rootId));
        for (const rootId of Object.keys(state.roots)) {
            if (trunkRootIds.has(rootId)) continue;
            if (kickstandRootIds.has(rootId)) continue;
            removeRootById(rootId);
        }
    }, [kickstandState.kickstands, kickstandState.roots, kickstandState.knots, state.roots, state.knots, state.trunks, interactionHooksEnabled]);

    // Enable joint dragging
    useJointInteraction(isInteractable);
    // Enable knot sliding
    useKnotInteraction(isInteractable);

    // Expose the group ref to parent components
    const groupRef = React.useRef<THREE.Group>(null);
    useImperativeHandle(ref, () => groupRef.current!);

    // Derive clipping planes synchronously so a freshly mounted renderer
    // (e.g. after support refresh key changes) is clipped correctly on its
    // very first render, without waiting for a post-commit effect.
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
        const baseHex = '#9a9a9a';
        const selectedHex = '#c8752a';
        const hoverTintHex = '#d18a4a';
        const hoveredColor = new THREE.Color(baseHex).lerp(new THREE.Color(hoverTintHex), 0.35).getStyle();

        return (modelId?: string) => {
            const isSelectedModelSupport = !!modelId && selectedModelIdSet.has(modelId);
            if (isSelectedModelSupport) return selectedHex;

            const isHoveredModelSupport = !!effectiveHoverModelId && !!modelId && modelId === effectiveHoverModelId;
            if (isHoveredModelSupport) return hoveredColor;

            return baseHex;
        };
    }, [effectiveHoverModelId, selectedModelIdSet]);

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

    const trunkIdByRootIdForSelection = useMemo(() => {
        const map = new Map<string, string>();
        for (const trunk of trunkList) {
            map.set(trunk.rootId, trunk.id);
        }
        return map;
    }, [trunkList]);

    const branchIdsByParentKnotIdForSelection = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const branch of branchList) {
            const list = map.get(branch.parentKnotId);
            if (list) {
                list.push(branch.id);
            } else {
                map.set(branch.parentKnotId, [branch.id]);
            }
        }
        return map;
    }, [branchList]);

    const leafIdsByParentKnotIdForSelection = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const leaf of leafList) {
            const list = map.get(leaf.parentKnotId);
            if (list) {
                list.push(leaf.id);
            } else {
                map.set(leaf.parentKnotId, [leaf.id]);
            }
        }
        return map;
    }, [leafList]);

    const braceIdsByKnotIdForSelection = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const brace of braceList) {
            const startList = map.get(brace.startKnotId);
            if (startList) {
                startList.push(brace.id);
            } else {
                map.set(brace.startKnotId, [brace.id]);
            }

            const endList = map.get(brace.endKnotId);
            if (endList) {
                endList.push(brace.id);
            } else {
                map.set(brace.endKnotId, [brace.id]);
            }
        }
        return map;
    }, [braceList]);

    const kickstandIdsByHostKnotIdForSelection = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const kickstand of kickstandList) {
            const list = map.get(kickstand.hostKnotId);
            if (list) {
                list.push(kickstand.id);
            } else {
                map.set(kickstand.hostKnotId, [kickstand.id]);
            }
        }
        return map;
    }, [kickstandList]);

    const fallbackSupportIdByPrimitiveForSelection = useMemo(() => {
        const map = new Map<string, string>();

        for (const kickstand of kickstandList) {
            map.set(kickstand.id, kickstand.id);
            map.set(kickstand.hostKnotId, kickstand.id);
            for (const segment of kickstand.segments) {
                map.set(segment.id, kickstand.id);
                if (segment.topJoint?.id) map.set(segment.topJoint.id, kickstand.id);
                if (segment.bottomJoint?.id) map.set(segment.bottomJoint.id, kickstand.id);
            }
        }

        for (const brace of braceList) {
            map.set(`braceSegment:${brace.id}`, brace.id);
        }

        return map;
    }, [kickstandList, braceList]);

    const singleSelectedSupportId = useMemo(() => {
        if (!selectedId) return null;

        if (selectedCategory === 'knot') {
            return null;
        }

        if (selectedCategory === 'root') {
            return trunkIdByRootIdForSelection.get(selectedId) ?? null;
        }

        if (
            selectedCategory === 'trunk'
            || selectedCategory === 'branch'
            || selectedCategory === 'leaf'
            || selectedCategory === 'twig'
            || selectedCategory === 'stick'
            || selectedCategory === 'brace'
            || selectedCategory === 'anchor'
        ) {
            return selectedId;
        }

        return selectedPrimitiveSupportId
            ?? fallbackSupportIdByPrimitiveForSelection.get(selectedId)
            ?? null;
    }, [
        selectedId,
        selectedCategory,
        selectedPrimitiveSupportId,
        fallbackSupportIdByPrimitiveForSelection,
        trunkIdByRootIdForSelection,
    ]);

    const selectedTrunkIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.trunks[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.trunks[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        return selected;
    }, [singleSelectedSupportId, selectedSupportIdSet, state.trunks, useMultiSelectionDetail]);

    const selectedBranchIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.branches[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.branches[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        if (selectedCategory === 'knot' && selectedId) {
            const branchIds = branchIdsByParentKnotIdForSelection.get(selectedId) ?? [];
            for (const id of branchIds) selected.add(id);
        }

        return selected;
    }, [
        branchIdsByParentKnotIdForSelection,
        selectedCategory,
        selectedId,
        selectedSupportIdSet,
        singleSelectedSupportId,
        state.branches,
        useMultiSelectionDetail,
    ]);

    const selectedBraceIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.braces[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.braces[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        if (selectedCategory === 'segment' && selectedId?.startsWith('braceSegment:')) {
            selected.add(selectedId.slice('braceSegment:'.length));
        }

        if (selectedCategory === 'knot' && selectedId) {
            const braceIds = braceIdsByKnotIdForSelection.get(selectedId) ?? [];
            for (const id of braceIds) selected.add(id);
        }

        return selected;
    }, [
        braceIdsByKnotIdForSelection,
        selectedCategory,
        selectedId,
        selectedSupportIdSet,
        singleSelectedSupportId,
        state.braces,
        useMultiSelectionDetail,
    ]);

    const selectedTwigIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.twigs[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.twigs[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        return selected;
    }, [singleSelectedSupportId, selectedSupportIdSet, state.twigs, useMultiSelectionDetail]);

    const selectedStickIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.sticks[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.sticks[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        return selected;
    }, [singleSelectedSupportId, selectedSupportIdSet, state.sticks, useMultiSelectionDetail]);

    const selectedAnchorIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.anchors[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.anchors[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        return selected;
    }, [singleSelectedSupportId, selectedSupportIdSet, state.anchors, useMultiSelectionDetail]);

    const selectedKickstandIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (kickstandState.kickstands[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && kickstandState.kickstands[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        if (selectedCategory === 'knot' && selectedId) {
            const kickstandIds = kickstandIdsByHostKnotIdForSelection.get(selectedId) ?? [];
            for (const id of kickstandIds) selected.add(id);
        }

        return selected;
    }, [
        kickstandIdsByHostKnotIdForSelection,
        kickstandState.kickstands,
        selectedCategory,
        selectedId,
        selectedSupportIdSet,
        singleSelectedSupportId,
        useMultiSelectionDetail,
    ]);

    const selectedLeafIds = useMemo(() => {
        const selected = new Set<string>();
        if (useMultiSelectionDetail) {
            for (const supportId of selectedSupportIdSet) {
                if (state.leaves[supportId]) selected.add(supportId);
            }
        }

        if (singleSelectedSupportId && state.leaves[singleSelectedSupportId]) {
            selected.add(singleSelectedSupportId);
        }

        if (selectedCategory === 'knot' && selectedId) {
            const leafIds = leafIdsByParentKnotIdForSelection.get(selectedId) ?? [];
            for (const id of leafIds) selected.add(id);
        }

        return selected;
    }, [
        leafIdsByParentKnotIdForSelection,
        selectedCategory,
        selectedId,
        selectedSupportIdSet,
        singleSelectedSupportId,
        state.leaves,
        useMultiSelectionDetail,
    ]);

    const knotIdsByParentShaftId = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const [id, knots] of Object.entries(supportRenderLookup.knotIdsByParentShaftId)) map.set(id, knots);
        return map;
    }, [supportRenderLookup.knotIdsByParentShaftId]);

    const kickstandKnotIdsByParentShaftId = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const [id, knots] of Object.entries(supportRenderLookup.kickstandKnotIdsByParentShaftId)) map.set(id, knots);
        return map;
    }, [supportRenderLookup.kickstandKnotIdsByParentShaftId]);

    const previewCandidateKnots = useMemo(() => {
        const result: Record<string, Knot> = {};
        const previewSupport = activeJointDragPreview?.support;
        if (!previewSupport) return result;

        for (const segment of previewSupport.segments) {
            const sharedIds = knotIdsByParentShaftId.get(segment.id) ?? [];
            for (const knotId of sharedIds) {
                const knot = state.knots[knotId];
                if (knot) result[knotId] = knot;
            }

            const kickstandIds = kickstandKnotIdsByParentShaftId.get(segment.id) ?? [];
            for (const knotId of kickstandIds) {
                const knot = kickstandState.knots[knotId];
                if (knot) result[knotId] = knot;
            }
        }

        return result;
    }, [activeJointDragPreview, knotIdsByParentShaftId, kickstandKnotIdsByParentShaftId, state.knots, kickstandState.knots]);

    const basePreviewKnotOverrides = useJointDragPreviewOverrides({
        roots: state.roots,
        knots: state.knots,
        kickstandKnots: kickstandState.knots,
        candidateKnots: previewCandidateKnots,
    });

    const branchesByParentKnotId = useMemo(() => buildBranchesByParentKnotId(branchList), [branchList]);
    const leafIdsByParentKnotId = useMemo(() => buildLeafIdsByParentKnotId(leafList), [leafList]);
    const braceIdsByKnotId = useMemo(() => buildBraceIdsByKnotId(braceList), [braceList]);
    const branchCandidateKnotIdsByBranchId = useMemo(
        () => buildBranchCandidateKnotIdsByBranchId(branchList, knotIdsByParentShaftId),
        [branchList, knotIdsByParentShaftId],
    );

    const freezeDependentPreviewDuringJointDrag = FREEZE_DEPENDENT_PREVIEW_DURING_JOINT_DRAG
        && !!activeJointDragPreview?.support;

    const previewSeedKnotOverrides = useMemo(() => {
        const knotPreview = activeKnotDragPreview?.knot;
        if (!knotPreview) return basePreviewKnotOverrides;
        if (basePreviewKnotOverrides[knotPreview.id] === knotPreview) return basePreviewKnotOverrides;
        return {
            ...basePreviewKnotOverrides,
            [knotPreview.id]: knotPreview,
        };
    }, [basePreviewKnotOverrides, activeKnotDragPreview]);

    const shouldCascadeDependentPreview = !freezeDependentPreviewDuringJointDrag
        && (!!activeJointDragPreview?.support || !!activeKnotDragPreview?.knot);

    const previewKnotOverrides = useMemo(() => {
        return computeCascadedPreviewKnotOverrides({
            enableCascade: shouldCascadeDependentPreview,
            basePreviewKnotOverrides: previewSeedKnotOverrides,
            branchesByParentKnotId,
            branchCandidateKnotIdsByBranchId,
            branchesById: state.branches,
            committedKnotsById: state.knots,
        });
    }, [shouldCascadeDependentPreview, previewSeedKnotOverrides, branchesByParentKnotId, branchCandidateKnotIdsByBranchId, state.branches, state.knots]);

    const previewKnotOverrideIds = useMemo(() => Object.keys(previewKnotOverrides), [previewKnotOverrides]);
    const hasPreviewKnotOverrides = previewKnotOverrideIds.length > 0;

    const previewLeavesById = useMemo(() => {
        if (!hasPreviewKnotOverrides) return new Map<string, Leaf>();
        return collectPreviewLeavesById({
            previewKnotOverrideIds,
            previewKnotOverrides,
            leafIdsByParentKnotId,
            leavesById: state.leaves,
            recomputeLeafPreviewContactCone,
        });
    }, [hasPreviewKnotOverrides, previewKnotOverrideIds, previewKnotOverrides, leafIdsByParentKnotId, state.leaves]);

    const activePreviewTrunk = activeJointDragPreview?.kind === 'trunk'
        ? (activeJointDragPreview.support as (typeof state.trunks)[string])
        : null;
    const activePreviewBranch = activeJointDragPreview?.kind === 'branch'
        ? (activeJointDragPreview.support as (typeof state.branches)[string])
        : null;
    const activePreviewKickstand = activeJointDragPreview?.kind === 'kickstand'
        ? (activeJointDragPreview.support as (typeof kickstandState.kickstands)[string])
        : null;

    const renderLeavesById = useMemo(() => {
        if (previewLeavesById.size === 0) return state.leaves;
        const leaves = Object.create(state.leaves) as typeof state.leaves;
        for (const [leafId, previewLeaf] of previewLeavesById) {
            leaves[leafId] = previewLeaf;
        }
        return leaves;
    }, [state.leaves, previewLeavesById]);

    const renderBracesById = state.braces;
    const ghostedBraceIdSet = useMemo(() => {
        return collectGhostedBraceIds({
            activeJointDragPreview,
            previewKnotOverrideIds,
            braceIdsByKnotId,
            bracesById: state.braces,
            isBraceVisible: (brace) => isModelVisible(brace.modelId, brace.id),
        });
    }, [activeJointDragPreview, hasPreviewKnotOverrides, previewKnotOverrideIds, braceIdsByKnotId, state.braces, isModelVisible]);
    const renderKnotsById = useMemo(() => {
        if (!hasPreviewKnotOverrides) return state.knots;
        const knots = Object.create(state.knots) as typeof state.knots;
        for (const knotId of previewKnotOverrideIds) {
            knots[knotId] = previewKnotOverrides[knotId];
        }
        return knots;
    }, [state.knots, previewKnotOverrides, previewKnotOverrideIds, hasPreviewKnotOverrides]);
    const renderKickstandKnotsById = useMemo(() => {
        if (!hasPreviewKnotOverrides) return kickstandState.knots;
        const knots = Object.create(kickstandState.knots) as typeof kickstandState.knots;
        for (const knotId of previewKnotOverrideIds) {
            knots[knotId] = previewKnotOverrides[knotId];
        }
        return knots;
    }, [kickstandState.knots, previewKnotOverrides, previewKnotOverrideIds, hasPreviewKnotOverrides]);

    const activeKnotDragPreviewKnotId = activeKnotDragPreview?.knot.id ?? null;
    const enableBraceLivePreviewForActiveBraceEdit = !!activeKnotDragPreviewKnotId
        && (braceIdsByKnotId.get(activeKnotDragPreviewKnotId)?.length ?? 0) > 0;
    const braceRenderKnotsById = useMemo(() => {
        return enableBraceLivePreviewForActiveBraceEdit ? renderKnotsById : state.knots;
    }, [enableBraceLivePreviewForActiveBraceEdit, renderKnotsById, state.knots]);

    const knotDragPreviewBranchSegmentsById = activeKnotDragPreview?.branchSegmentsById ?? EMPTY_KNOT_DRAG_BRANCH_SEGMENTS_BY_ID;
    const knotDragPreviewBranchIds = useMemo(() => Object.keys(knotDragPreviewBranchSegmentsById), [knotDragPreviewBranchSegmentsById]);
    const branchListWithKnotDragPreview = useMemo(() => {
        if (knotDragPreviewBranchIds.length === 0) return branchList;
        return branchList.map((branch) => {
            const previewSegments = knotDragPreviewBranchSegmentsById[branch.id];
            if (!previewSegments || previewSegments === branch.segments) return branch;
            return { ...branch, segments: previewSegments };
        });
    }, [branchList, knotDragPreviewBranchSegmentsById, knotDragPreviewBranchIds]);

    const renderTrunkList = useMemo(() => {
        if (!activePreviewTrunk) return trunkList;

        let replaced = false;
        const result = trunkList.map((trunk) => {
            if (trunk.id !== activePreviewTrunk.id) return trunk;
            replaced = true;
            return activePreviewTrunk;
        });

        if (!replaced) result.push(activePreviewTrunk);
        return result;
    }, [trunkList, activePreviewTrunk]);

    const renderBranchList = useMemo(() => {
        if (!activePreviewBranch) return branchList;

        let replaced = false;
        const result = branchListWithKnotDragPreview.map((branch) => {
            if (branch.id !== activePreviewBranch.id) return branch;
            replaced = true;
            return activePreviewBranch;
        });

        if (!replaced) result.push(activePreviewBranch);
        return result;
    }, [branchListWithKnotDragPreview, activePreviewBranch]);

    const renderLeafList = useMemo(() => {
        if (previewLeavesById.size === 0) return leafList;
        return leafList.map((leaf) => previewLeavesById.get(leaf.id) ?? leaf);
    }, [leafList, previewLeavesById]);
    const renderTwigList = twigList;
    const renderStickList = stickList;
    const renderBraceList = braceList;
    const renderKickstandList = useMemo(() => {
        if (!activePreviewKickstand) return kickstandList;

        let replaced = false;
        const result = kickstandList.map((kickstand) => {
            if (kickstand.id !== activePreviewKickstand.id) return kickstand;
            replaced = true;
            return activePreviewKickstand;
        });

        if (!replaced) result.push(activePreviewKickstand);
        return result;
    }, [kickstandList, activePreviewKickstand]);
    const renderKnotList = useMemo(() => {
        if (!hasPreviewKnotOverrides) return knotList;
        return knotList.map((knot) => previewKnotOverrides[knot.id] ?? knot);
    }, [hasPreviewKnotOverrides, knotList, previewKnotOverrides]);
    const renderKickstandKnotList = useMemo(() => {
        if (!hasPreviewKnotOverrides) return kickstandKnotList;
        return kickstandKnotList.map((knot) => previewKnotOverrides[knot.id] ?? knot);
    }, [hasPreviewKnotOverrides, kickstandKnotList, previewKnotOverrides]);

    const resolvePreviewKnot = React.useCallback((knotId: string) => {
        return previewKnotOverrides[knotId] ?? state.knots[knotId] ?? kickstandState.knots[knotId] ?? null;
    }, [previewKnotOverrides, state.knots, kickstandState.knots]);

    const trunkShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const trunk of renderTrunkList) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;

            const root = state.roots[trunk.rootId];
            if (!root) continue;

            const shafts: InstancedShaft[] = [];

            const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;
            let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, verticalOffset + effectiveDiskHeight + Math.max(0, root.coneHeight)));

            for (const segment of trunk.segments) {
                if (segment.bottomJoint) {
                    currentStart = new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z);
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

                if (segment.type === 'bezier') {
                    shafts.push(...tesselllateBezierToShafts(segment, currentStart, endPoint, trunk.id, trunk.modelId));
                    currentStart = endPoint;
                    continue;
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
    }, [raftSettings.bottomMode, raftSettings.thickness, renderTrunkList, state.roots, isModelVisible]);

    const branchShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const branch of renderBranchList) {
            if (!isModelVisible(branch.modelId, branch.id)) continue;
            const parentKnot = renderKnotsById[branch.parentKnotId];
            if (!parentKnot) continue;

            const shafts: InstancedShaft[] = [];
            let currentStart = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);

            for (const segment of branch.segments) {
                let endPoint: THREE.Vector3;
                if (segment.topJoint) {
                    endPoint = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
                } else if (branch.contactCone) {
                    const socketPos = getFinalSocketPosition(branch.contactCone);
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 5));
                }

                if (segment.type === 'bezier') {
                    shafts.push(...tesselllateBezierToShafts(segment, currentStart, endPoint, branch.id, branch.modelId));
                    currentStart = endPoint;
                    continue;
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
    }, [renderBranchList, renderKnotsById, isModelVisible]);

    const braceShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const brace of renderBraceList) {
            if (!isModelVisible(brace.modelId, brace.id)) continue;

            // Keep braces anchored to committed knots during non-brace edits,
            // but allow live preview while the user is directly editing a brace knot.
            const startKnot = braceRenderKnotsById[brace.startKnotId];
            const endKnot = braceRenderKnotsById[brace.endKnotId];
            if (!startKnot || !endKnot) continue;

            const profileDiameter = Math.max(0.001, brace.profile?.diameter ?? 1.0);
            const startHostDiameter = Math.max(
                0.001,
                (startKnot.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
            );
            const endHostDiameter = Math.max(
                0.001,
                (endKnot.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
            );
            const isTaperedBrace = Math.abs(startHostDiameter - endHostDiameter) > 1e-4;

            // Tapered braces are rendered in the detailed path so we can preserve
            // dynamic start/end diameters. Uniform braces remain batched for speed.
            if (isTaperedBrace) {
                continue;
            }

            const diameter = (startHostDiameter + endHostDiameter) * 0.5;
            const segmentId = `braceSegment:${brace.id}`;
            const shafts = brace.curve?.type === 'bezier'
                ? tessellateBraceBezierToShafts(
                    segmentId,
                    startKnot.pos,
                    endKnot.pos,
                    brace.curve.controlPoint1,
                    brace.curve.controlPoint2,
                    diameter,
                    brace.id,
                    brace.modelId,
                )
                : [{
                    id: segmentId,
                    start: startKnot.pos,
                    end: endKnot.pos,
                    diameter,
                    supportId: brace.id,
                    modelId: brace.modelId,
                }];

            result.set(brace.id, {
                supportId: brace.id,
                modelId: brace.modelId,
                shafts,
            });
        }

        return result;
    }, [renderBraceList, braceRenderKnotsById, isModelVisible]);

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

        for (const twig of renderTwigList) {
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
                if (!isUniformDiameter) {
                    fullyBatchable = false;
                }

                if (segment.type === 'bezier') {
                    shafts.push(...tesselllateBezierToShafts(segment, startPoint, endPoint, twig.id, twig.modelId));
                } else if (isUniformDiameter) {
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
    }, [renderTwigList, isModelVisible, enableTwigSceneBatching]);

    const stickShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();

        for (const stick of renderStickList) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;

            const shafts: InstancedShaft[] = [];

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
                    shafts.push(...tesselllateBezierToShafts(segment, startPoint, endPoint, stick.id, stick.modelId));
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

            if (shafts.length > 0) {
                result.set(stick.id, {
                    supportId: stick.id,
                    modelId: stick.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [renderStickList, isModelVisible]);

    const kickstandShaftsBySupport = useMemo(() => {
        const result = new Map<string, SupportShaftSet>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const kickstand of renderKickstandList) {
            if (!isModelVisible(kickstand.modelId, kickstand.id)) continue;

            const root = kickstandState.roots[kickstand.rootId];
            const hostKnot = renderKickstandKnotsById[kickstand.hostKnotId];
            if (!root || !hostKnot) continue;

            const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;
            let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, verticalOffset + effectiveDiskHeight + Math.max(0, root.coneHeight)));

            const shafts: InstancedShaft[] = [];
            let fullyBatchable = true;

            kickstand.segments.forEach((segment, index) => {
                const isLast = index === kickstand.segments.length - 1;

                const endPoint = segment.topJoint
                    ? new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z)
                    : new THREE.Vector3(hostKnot.pos.x, hostKnot.pos.y, hostKnot.pos.z);

                const diameterStart = isLast ? kickstand.profile.terminalStartDiameterMm : undefined;
                const diameterEnd = isLast ? kickstand.profile.terminalEndDiameterMm : undefined;
                const isUniformDiameter = (diameterStart == null && diameterEnd == null)
                    || (diameterStart != null && diameterEnd != null && Math.abs(diameterStart - diameterEnd) < 1e-6);

                if (!isUniformDiameter) {
                    fullyBatchable = false;
                }

                if (segment.type === 'bezier') {
                    shafts.push(...tesselllateBezierToShafts(segment, currentStart, endPoint, kickstand.id, kickstand.modelId));
                } else if (isUniformDiameter) {
                    shafts.push({
                        id: segment.id,
                        start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        diameter: segment.diameter,
                        supportId: kickstand.id,
                        modelId: kickstand.modelId,
                    });
                }

                currentStart = endPoint;
            });

            if (fullyBatchable && shafts.length > 0) {
                result.set(kickstand.id, {
                    supportId: kickstand.id,
                    modelId: kickstand.modelId,
                    shafts,
                });
            }
        }

        return result;
    }, [renderKickstandList, kickstandState.roots, renderKickstandKnotsById, isModelVisible, raftSettings.bottomMode, raftSettings.thickness]);

    const segmentModelIdById = useMemo(() => {
        const map = new Map<string, string | undefined>();

        for (const trunk of renderTrunkList) {
            for (const segment of trunk.segments) {
                map.set(segment.id, trunk.modelId);
            }
        }

        for (const branch of renderBranchList) {
            for (const segment of branch.segments) {
                map.set(segment.id, branch.modelId);
            }
        }

        for (const twig of renderTwigList) {
            for (const segment of twig.segments) {
                map.set(segment.id, twig.modelId);
            }
        }

        for (const stick of renderStickList) {
            for (const segment of stick.segments) {
                map.set(segment.id, stick.modelId);
            }
        }

        for (const kickstand of renderKickstandList) {
            for (const segment of kickstand.segments) {
                map.set(segment.id, kickstand.modelId);
            }
        }

        return map;
    }, [renderTrunkList, renderBranchList, renderTwigList, renderStickList, renderKickstandList]);

    const modelIdByKnotId = useMemo(() => {
        const map = new Map<string, string | undefined>();

        for (const knot of renderKnotList) {
            const parentShaftId = knot.parentShaftId;
            let modelId: string | undefined;

            if (parentShaftId.startsWith('braceSegment:')) {
                const braceId = parentShaftId.slice('braceSegment:'.length);
                modelId = renderBracesById[braceId]?.modelId;
            } else if (parentShaftId.startsWith('leafCone:')) {
                const leafId = parentShaftId.slice('leafCone:'.length);
                modelId = renderLeavesById[leafId]?.modelId;
            } else {
                modelId = segmentModelIdById.get(parentShaftId);
            }

            map.set(knot.id, modelId);
        }

        for (const knot of renderKickstandKnotList) {
            const parentShaftId = knot.parentShaftId;
            let modelId: string | undefined;

            if (parentShaftId.startsWith('braceSegment:')) {
                const braceId = parentShaftId.slice('braceSegment:'.length);
                modelId = renderBracesById[braceId]?.modelId;
            } else if (parentShaftId.startsWith('leafCone:')) {
                const leafId = parentShaftId.slice('leafCone:'.length);
                modelId = renderLeavesById[leafId]?.modelId;
            } else {
                modelId = segmentModelIdById.get(parentShaftId);
            }

            map.set(knot.id, modelId);
        }

        return map;
    }, [renderKnotList, renderBracesById, renderLeavesById, renderKickstandKnotList, segmentModelIdById]);

    const contactConesBySupport = useMemo(() => {
        const result = new Map<string, { supportId: string; modelId?: string; cones: InstancedContactCone[] }>();

        for (const trunk of renderTrunkList) {
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

        for (const branch of renderBranchList) {
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

        for (const stick of renderStickList) {
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

        for (const previewLeaf of renderLeafList) {
            const modelId = previewLeaf.modelId ?? modelIdByKnotId.get(previewLeaf.parentKnotId);
            if (!isModelVisible(modelId)) continue;

            result.set(previewLeaf.id, {
                supportId: previewLeaf.id,
                modelId,
                cones: [{
                    id: previewLeaf.contactCone.id,
                    supportId: previewLeaf.id,
                    modelId,
                    pos: previewLeaf.contactCone.pos,
                    normal: previewLeaf.contactCone.normal,
                    surfaceNormal: previewLeaf.contactCone.surfaceNormal,
                    diskLengthOverride: previewLeaf.contactCone.diskLengthOverride,
                    profile: previewLeaf.contactCone.profile,
                }],
            });
        }

        return result;
    }, [renderTrunkList, renderBranchList, renderStickList, renderLeafList, modelIdByKnotId, isModelVisible]);

    const trunkJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const trunk of renderTrunkList) {
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
    }, [renderTrunkList, isModelVisible]);

    const branchJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const branch of renderBranchList) {
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
    }, [renderBranchList, isModelVisible]);

    const twigJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const twig of renderTwigList) {
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
    }, [renderTwigList, isModelVisible]);

    const stickJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const stick of renderStickList) {
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
    }, [renderStickList, isModelVisible]);

    const kickstandJointsBySupport = useMemo(() => {
        const result = new Map<string, SupportJointSet>();

        for (const kickstand of renderKickstandList) {
            if (!isModelVisible(kickstand.modelId, kickstand.id)) continue;

            const seen = new Set<string>();
            const joints: InstancedJoint[] = [];

            for (const segment of kickstand.segments) {
                if (segment.topJoint && !seen.has(segment.topJoint.id)) {
                    seen.add(segment.topJoint.id);
                    joints.push({
                        id: segment.topJoint.id,
                        pos: segment.topJoint.pos,
                        diameter: segment.topJoint.diameter,
                        supportId: kickstand.id,
                        modelId: kickstand.modelId,
                    });
                }
            }

            if (joints.length > 0) {
                result.set(kickstand.id, {
                    supportId: kickstand.id,
                    modelId: kickstand.modelId,
                    joints,
                });
            }
        }

        return result;
    }, [renderKickstandList, isModelVisible]);

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

        for (const trunk of renderTrunkList) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;
            if (selectedTrunkIds.has(trunk.id)) continue;
            const jointSet = trunkJointsBySupport.get(trunk.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(trunk.modelId, trunk.id);
            pushJoints(color, jointSet.joints);
        }

        for (const branch of renderBranchList) {
            if (!isModelVisible(branch.modelId, branch.id)) continue;
            if (selectedBranchIds.has(branch.id)) continue;
            const jointSet = branchJointsBySupport.get(branch.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(branch.modelId, branch.id);
            pushJoints(color, jointSet.joints);
        }

        for (const twig of renderTwigList) {
            if (!isModelVisible(twig.modelId, twig.id)) continue;
            if (selectedTwigIds.has(twig.id)) continue;
            const jointSet = twigJointsBySupport.get(twig.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(twig.modelId, twig.id);
            pushJoints(color, jointSet.joints);
        }

        for (const stick of renderStickList) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;
            if (selectedStickIds.has(stick.id)) continue;
            const jointSet = stickJointsBySupport.get(stick.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(stick.modelId, stick.id);
            pushJoints(color, jointSet.joints);
        }

        for (const kickstand of renderKickstandList) {
            if (!isModelVisible(kickstand.modelId, kickstand.id)) continue;
            if (selectedKickstandIds.has(kickstand.id)) continue;
            const jointSet = kickstandJointsBySupport.get(kickstand.id);
            if (!jointSet) continue;

            const color = resolveSceneSupportColor(kickstand.modelId, kickstand.id);
            pushJoints(color, jointSet.joints);
        }

        return Array.from(grouped.entries()).map(([color, joints]) => ({ color, joints }));
    }, [
        disableSelectionAndHover,
        renderTrunkList,
        renderBranchList,
        renderTwigList,
        renderStickList,
        renderKickstandList,
        isModelVisible,
        selectedTrunkIds,
        selectedBranchIds,
        selectedTwigIds,
        selectedStickIds,
        selectedKickstandIds,
        trunkJointsBySupport,
        branchJointsBySupport,
        twigJointsBySupport,
        stickJointsBySupport,
        kickstandJointsBySupport,
        applyDropToVec3Like,
        dimNonSelected,
        resolveSceneSupportColor,
    ]);

    const sceneBatchedTwigShaftGroups = useMemo(() => {
        if (!enableTwigSceneBatching) {
            return [] as Array<{ modelId?: string; color: string; shafts: InstancedShaft[] }>;
        }

        const grouped = new Map<string, { modelId?: string; color: string; shafts: InstancedShaft[] }>();

        for (const twig of renderTwigList) {
            if (!isModelVisible(twig.modelId, twig.id)) continue;
            const shaftSet = twigShaftsBySupport.get(twig.id);
            if (!shaftSet) continue;
            if (selectedTwigIds.has(twig.id)) continue;

            const color = resolveSceneSupportColor(shaftSet.modelId, twig.id);
            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const groupKey = `${modelKey}:${color}`;
            const existing = grouped.get(groupKey) ?? { modelId: shaftSet.modelId, color, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));
            if (existing.shafts.length > 0) grouped.set(groupKey, existing);
        }

        return Array.from(grouped.values());
    }, [renderTwigList, twigShaftsBySupport, selectedTwigIds, isModelVisible, applyDropToVec3Like, enableTwigSceneBatching, resolveSceneSupportColor]);

    const sceneBatchedStickShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; color: string; shafts: InstancedShaft[] }>();

        for (const stick of renderStickList) {
            if (!isModelVisible(stick.modelId, stick.id)) continue;
            const shaftSet = stickShaftsBySupport.get(stick.id);
            if (!shaftSet) continue;
            if (selectedStickIds.has(stick.id)) continue;

            const color = resolveSceneSupportColor(shaftSet.modelId, stick.id);
            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const groupKey = `${modelKey}:${color}`;
            const existing = grouped.get(groupKey) ?? { modelId: shaftSet.modelId, color, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));
            if (existing.shafts.length > 0) grouped.set(groupKey, existing);
        }

        return Array.from(grouped.values());
    }, [renderStickList, stickShaftsBySupport, selectedStickIds, isModelVisible, applyDropToVec3Like, resolveSceneSupportColor]);

    const sceneBatchedKickstandShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; color: string; shafts: InstancedShaft[] }>();

        for (const kickstand of renderKickstandList) {
            if (!isModelVisible(kickstand.modelId, kickstand.id)) continue;
            const shaftSet = kickstandShaftsBySupport.get(kickstand.id);
            if (!shaftSet) continue;
            if (selectedKickstandIds.has(kickstand.id)) continue;

            const color = resolveSceneSupportColor(shaftSet.modelId, kickstand.id);
            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const groupKey = `${modelKey}:${color}`;
            const existing = grouped.get(groupKey) ?? { modelId: shaftSet.modelId, color, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));
            if (existing.shafts.length > 0) grouped.set(groupKey, existing);
        }

        return Array.from(grouped.values());
    }, [renderKickstandList, kickstandShaftsBySupport, selectedKickstandIds, isModelVisible, applyDropToVec3Like, resolveSceneSupportColor]);

    const sceneBatchedBraceShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; color: string; shafts: InstancedShaft[] }>();

        const sectionColorsEnabled = !!settings.autoBracing.debugSectionColorsEnabled;
        const splitByDebugSection = sectionColorsEnabled && !dimNonSelected;

        for (const brace of renderBraceList) {
            if (!isModelVisible(brace.modelId, brace.id)) continue;
            const shaftSet = braceShaftsBySupport.get(brace.id);
            if (!shaftSet) continue;

            if (selectedBraceIds.has(brace.id) || ghostedBraceIdSet.has(brace.id)) continue;

            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const debugSection = splitByDebugSection
                ? (brace.debugSection ?? null)
                : null;
            const color = debugSection
                ? AUTO_BRACING_DEBUG_SECTION_COLORS[debugSection]
                : resolveSceneSupportColor(shaftSet.modelId, brace.id);
            const groupKey = `${modelKey}:${color}`;

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
                    color,
                    shafts: shaftSet.shafts.map((shaft) => ({
                        ...shaft,
                        start: applyDropToVec3Like(shaft.start, shaft.modelId),
                        end: applyDropToVec3Like(shaft.end, shaft.modelId),
                    })),
                });
            }
        }

        return Array.from(grouped.values());
    }, [renderBraceList, braceShaftsBySupport, selectedBraceIds, ghostedBraceIdSet, isModelVisible, applyDropToVec3Like, settings.autoBracing.debugSectionColorsEnabled, dimNonSelected, resolveSceneSupportColor]);

    const sceneBatchedTrunkShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; color: string; shafts: InstancedShaft[] }>();

        for (const trunk of renderTrunkList) {
            if (!isModelVisible(trunk.modelId, trunk.id)) continue;
            const shaftSet = trunkShaftsBySupport.get(trunk.id);
            if (!shaftSet) continue;

            if (selectedTrunkIds.has(trunk.id)) continue;

            const color = resolveSceneSupportColor(shaftSet.modelId, trunk.id);
            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const groupKey = `${modelKey}:${color}`;
            const existing = grouped.get(groupKey) ?? { modelId: shaftSet.modelId, color, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));

            if (existing.shafts.length > 0) grouped.set(groupKey, existing);
        }

        return Array.from(grouped.values());
    }, [renderTrunkList, trunkShaftsBySupport, selectedTrunkIds, isModelVisible, applyDropToVec3Like, resolveSceneSupportColor]);

    const sceneBatchedBranchShaftGroups = useMemo(() => {
        const grouped = new Map<string, { modelId?: string; color: string; shafts: InstancedShaft[] }>();

        for (const branch of renderBranchList) {
            if (!isModelVisible(branch.modelId)) continue;
            const shaftSet = branchShaftsBySupport.get(branch.id);
            if (!shaftSet) continue;

            if (selectedBranchIds.has(branch.id)) continue;

            const color = resolveSceneSupportColor(shaftSet.modelId, branch.id);
            const modelKey = shaftSet.modelId ?? '__unassigned__';
            const groupKey = `${modelKey}:${color}`;
            const existing = grouped.get(groupKey) ?? { modelId: shaftSet.modelId, color, shafts: [] };
            existing.shafts.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
            })));

            if (existing.shafts.length > 0) {
                grouped.set(groupKey, existing);
            }
        }

        return Array.from(grouped.values());
    }, [renderBranchList, branchShaftsBySupport, selectedBranchIds, isModelVisible, applyDropToVec3Like, resolveSceneSupportColor]);

    const sceneBatchedTrunkRootGroups = useMemo(() => {
        if (hidePlateContactPrimitivesEffective) return [] as Array<{ color: string; roots: InstancedRoot[] }>;

        const grouped = new Map<string, InstancedRoot[]>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const trunk of renderTrunkList) {
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
        renderTrunkList,
        state.roots,
        dimNonSelected,
        resolveBaseColor,
        resolveSceneSupportColor,
        applyDropToVec3Like,
        selectedTrunkIds,
        restrictToActiveModel,
        activeModelId,
    ]);

    const sceneBatchedKickstandRootGroups = useMemo(() => {
        if (hidePlateContactPrimitivesEffective) return [] as Array<{ color: string; roots: InstancedRoot[] }>;

        const grouped = new Map<string, InstancedRoot[]>();
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        for (const kickstand of renderKickstandList) {
            if (!isModelVisible(kickstand.modelId, kickstand.id)) continue;
            if (selectedKickstandIds.has(kickstand.id)) continue;

            const root = kickstandState.roots[kickstand.rootId];
            if (!root) continue;

            const shaftDiameter = Math.max(
                0.001,
                kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm,
            );
            const topRadius = shaftDiameter / 2;
            const bottomRadius = Math.max(0.001, root.diameter / 2);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

            const color = resolveSceneSupportColor(kickstand.modelId, kickstand.id);
            const rootsForColor = grouped.get(color) ?? [];
            rootsForColor.push({
                id: root.id,
                supportId: kickstand.id,
                modelId: kickstand.modelId,
                basePos: applyDropToVec3Like({
                    x: root.transform.pos.x,
                    y: root.transform.pos.y,
                    z: root.transform.pos.z + verticalOffset,
                }, kickstand.modelId),
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
        renderKickstandList,
        kickstandState.roots,
        selectedKickstandIds,
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

        for (const trunk of renderTrunkList) {
            if (selectedTrunkIds.has(trunk.id)) continue;
            const coneSet = contactConesBySupport.get(trunk.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, trunk.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        for (const branch of renderBranchList) {
            if (selectedBranchIds.has(branch.id)) continue;
            const coneSet = contactConesBySupport.get(branch.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, branch.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        for (const stick of renderStickList) {
            if (selectedStickIds.has(stick.id)) continue;
            const coneSet = contactConesBySupport.get(stick.id);
            if (!coneSet) continue;

            const color = resolveSceneSupportColor(coneSet.modelId, stick.id);
            coneSet.cones.forEach((cone) => pushCone(color, {
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            }));
        }

        for (const leaf of renderLeafList) {
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
        renderTrunkList,
        renderBranchList,
        renderStickList,
        renderLeafList,
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
            sceneBatchedKickstandShaftGroups,
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
        sceneBatchedKickstandShaftGroups,
    ]);

    const sceneBatchedShaftRadialSegments = sceneBatchedShaftInstanceCount >= BATCHED_SHAFT_HIGH_INSTANCE_THRESHOLD
        ? BATCHED_SHAFT_LOW_RADIAL_SEGMENTS
        : BATCHED_SHAFT_RADIAL_SEGMENTS;

    const placementPreviewBatches = useMemo(() => {
        if (mode !== 'support') return [] as PlacementPreviewBatch[];

        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;
        const next: PlacementPreviewBatch[] = [];

        const pushSupportPreview = (id: string, preview: SupportData | null) => {
            if (!preview) return;
            const batch = buildSupportPlacementPreviewBatch(id, preview, hasSolidBottom, raftThickness);
            if (!batch) return;

            if (hidePlateContactPrimitivesEffective) {
                next.push({
                    ...batch,
                    roots: [],
                });
                return;
            }

            next.push(batch);
        };

        pushSupportPreview('placement-preview:trunk', trunkPlacementPreview);
        pushSupportPreview('placement-preview:branch', branchPlacementPreview);
        pushSupportPreview('placement-preview:leaf', leafPlacementPreview);
        pushSupportPreview('placement-preview:kickstand', kickstandPlacementPreview);

        if (bracePlacementPreview) {
            const braceBatch = buildBracePlacementPreviewBatch('placement-preview:brace', bracePlacementPreview);
            if (braceBatch) next.push(braceBatch);
        }

        return next;
    }, [
        mode,
        trunkPlacementPreview,
        branchPlacementPreview,
        leafPlacementPreview,
        bracePlacementPreview,
        kickstandPlacementPreview,
        raftSettings.bottomMode,
        raftSettings.thickness,
        hidePlateContactPrimitivesEffective,
    ]);

    const hoveredSupportShaftSet = useMemo(() => {
        if (!isInteractable) return null;
        if (hoveredSupportIsSelected) return null;

        const hoveredSupportId = hoveredSupportIdForVisual;
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

        const kickstandSet = kickstandShaftsBySupport.get(hoveredSupportId);
        if (kickstandSet) return kickstandSet;

        return null;
    }, [isInteractable, hoveredSupportIdForVisual, hoveredSupportIsSelected, trunkShaftsBySupport, branchShaftsBySupport, braceShaftsBySupport, twigShaftsBySupport, stickShaftsBySupport, kickstandShaftsBySupport]);

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
        if (hoveredSupportIsSelected) return null;

        const hoveredSupportId = hoveredSupportIdForVisual;
        if (!hoveredSupportId) return null;

        return contactConesBySupport.get(hoveredSupportId) ?? null;
    }, [isInteractable, hoveredSupportIdForVisual, hoveredSupportIsSelected, contactConesBySupport]);

    const hoveredSupportOverlayCones = useMemo(() => {
        if (!hoveredSupportConeSet) return [] as InstancedContactCone[];
        return hoveredSupportConeSet.cones.map((cone) => ({
            ...cone,
            pos: applyDropToVec3Like(cone.pos, cone.modelId),
        }));
    }, [hoveredSupportConeSet, applyDropToVec3Like]);

    const hoveredSupportJointSet = useMemo(() => {
        if (!isInteractable) return null;
        if (hoveredSupportIsSelected) return null;

        const hoveredSupportId = hoveredSupportIdForVisual;
        if (!hoveredSupportId) return null;

        const trunkSet = trunkJointsBySupport.get(hoveredSupportId);
        if (trunkSet) return trunkSet;

        const branchSet = branchJointsBySupport.get(hoveredSupportId);
        if (branchSet) return branchSet;

        const twigSet = twigJointsBySupport.get(hoveredSupportId);
        if (twigSet) return twigSet;

        const stickSet = stickJointsBySupport.get(hoveredSupportId);
        if (stickSet) return stickSet;

        const kickstandSet = kickstandJointsBySupport.get(hoveredSupportId);
        if (kickstandSet) return kickstandSet;

        return null;
    }, [
        isInteractable,
        hoveredSupportIdForVisual,
        hoveredSupportIsSelected,
        trunkJointsBySupport,
        branchJointsBySupport,
        twigJointsBySupport,
        stickJointsBySupport,
        kickstandJointsBySupport,
    ]);

    const hoveredSupportOverlayJoints = useMemo(() => {
        if (!hoveredSupportJointSet) return [] as InstancedJoint[];

        return hoveredSupportJointSet.joints.map((joint) => ({
            ...joint,
            pos: applyDropToVec3Like(joint.pos, joint.modelId),
            diameter: joint.diameter * 1.06,
        }));
    }, [hoveredSupportJointSet, applyDropToVec3Like]);

    const buildHighlightedRootOverlay = React.useCallback((supportId: string): InstancedRoot | null => {
        const hasSolidBottom = raftSettings.bottomMode === 'solid';
        const raftThickness = raftSettings.thickness ?? 0;

        const trunk = state.trunks[supportId];
        if (trunk) {
            const root = state.roots[trunk.rootId];
            if (!root) return null;

            const shaftDiameter = Math.max(0.001, trunk.segments[0]?.diameter ?? 1.5);
            const topRadius = shaftDiameter / 2;
            const bottomRadius = Math.max(0.001, root.diameter / 2);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

            return {
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
            };
        }

        const kickstand = kickstandState.kickstands[supportId];
        if (kickstand) {
            const root = kickstandState.roots[kickstand.rootId];
            if (!root) return null;

            const shaftDiameter = Math.max(
                0.001,
                kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm,
            );
            const topRadius = shaftDiameter / 2;
            const bottomRadius = Math.max(0.001, root.diameter / 2);
            const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
            const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

            return {
                id: root.id,
                supportId: kickstand.id,
                modelId: kickstand.modelId,
                basePos: applyDropToVec3Like({
                    x: root.transform.pos.x,
                    y: root.transform.pos.y,
                    z: root.transform.pos.z + verticalOffset,
                }, kickstand.modelId),
                bottomRadius,
                topRadius,
                effectiveDiskHeight,
                coneHeight: Math.max(0, root.coneHeight),
            };
        }

        return null;
    }, [
        raftSettings.bottomMode,
        raftSettings.thickness,
        state.trunks,
        state.roots,
        kickstandState.kickstands,
        kickstandState.roots,
        applyDropToVec3Like,
    ]);

    const hoveredSupportOverlayRoots = useMemo(() => {
        if (hidePlateContactPrimitivesEffective) return [] as InstancedRoot[];
        if (!isInteractable) return [] as InstancedRoot[];

        const hoveredSupportId = hoveredSupportIdForVisual;
        if (!hoveredSupportId) return [] as InstancedRoot[];

        const overlay = buildHighlightedRootOverlay(hoveredSupportId);
        return overlay ? [overlay] : [];
    }, [
        hidePlateContactPrimitivesEffective,
        isInteractable,
        hoveredSupportIdForVisual,
        buildHighlightedRootOverlay,
    ]);

    const additionalMarqueeHoveredSupportIds = useMemo(() => {
        if (!isInteractable || marqueeHoveredSupportIds.length <= 1) return EMPTY_SUPPORT_ID_LIST;
        return marqueeHoveredSupportIds.slice(1);
    }, [isInteractable, marqueeHoveredSupportIds]);

    const marqueeHoveredOverlayShafts = useMemo(() => {
        if (additionalMarqueeHoveredSupportIds.length === 0) return [] as InstancedShaft[];

        const overlays: InstancedShaft[] = [];
        for (const supportId of additionalMarqueeHoveredSupportIds) {
            const shaftSet = trunkShaftsBySupport.get(supportId)
                ?? branchShaftsBySupport.get(supportId)
                ?? braceShaftsBySupport.get(supportId)
                ?? twigShaftsBySupport.get(supportId)
                ?? stickShaftsBySupport.get(supportId)
                ?? kickstandShaftsBySupport.get(supportId)
                ?? null;
            if (!shaftSet) continue;
            overlays.push(...shaftSet.shafts.map((shaft) => ({
                ...shaft,
                start: applyDropToVec3Like(shaft.start, shaft.modelId),
                end: applyDropToVec3Like(shaft.end, shaft.modelId),
                diameter: shaft.diameter * 1.02,
            })));
        }
        return overlays;
    }, [additionalMarqueeHoveredSupportIds, trunkShaftsBySupport, branchShaftsBySupport, braceShaftsBySupport, twigShaftsBySupport, stickShaftsBySupport, kickstandShaftsBySupport, applyDropToVec3Like]);

    const marqueeHoveredOverlayCones = useMemo(() => {
        if (additionalMarqueeHoveredSupportIds.length === 0) return [] as InstancedContactCone[];

        const overlays: InstancedContactCone[] = [];
        for (const supportId of additionalMarqueeHoveredSupportIds) {
            const coneSet = contactConesBySupport.get(supportId);
            if (!coneSet) continue;
            overlays.push(...coneSet.cones.map((cone) => ({
                ...cone,
                pos: applyDropToVec3Like(cone.pos, cone.modelId),
            })));
        }
        return overlays;
    }, [additionalMarqueeHoveredSupportIds, contactConesBySupport, applyDropToVec3Like]);

    const marqueeHoveredOverlayJoints = useMemo(() => {
        if (additionalMarqueeHoveredSupportIds.length === 0) return [] as InstancedJoint[];

        const overlays: InstancedJoint[] = [];
        for (const supportId of additionalMarqueeHoveredSupportIds) {
            const jointSet = trunkJointsBySupport.get(supportId)
                ?? branchJointsBySupport.get(supportId)
                ?? twigJointsBySupport.get(supportId)
                ?? stickJointsBySupport.get(supportId)
                ?? kickstandJointsBySupport.get(supportId)
                ?? null;
            if (!jointSet) continue;
            overlays.push(...jointSet.joints.map((joint) => ({
                ...joint,
                pos: applyDropToVec3Like(joint.pos, joint.modelId),
                diameter: joint.diameter * 1.06,
            })));
        }
        return overlays;
    }, [additionalMarqueeHoveredSupportIds, trunkJointsBySupport, branchJointsBySupport, twigJointsBySupport, stickJointsBySupport, kickstandJointsBySupport, applyDropToVec3Like]);

    const marqueeHoveredOverlayRoots = useMemo(() => {
        if (hidePlateContactPrimitivesEffective) return [] as InstancedRoot[];
        if (additionalMarqueeHoveredSupportIds.length === 0) return [] as InstancedRoot[];

        const overlays: InstancedRoot[] = [];

        for (const supportId of additionalMarqueeHoveredSupportIds) {
            const overlay = buildHighlightedRootOverlay(supportId);
            if (overlay) overlays.push(overlay);
        }

        return overlays;
    }, [
        hidePlateContactPrimitivesEffective,
        additionalMarqueeHoveredSupportIds,
        buildHighlightedRootOverlay,
    ]);

    const handleSceneBatchedShaftClick = React.useCallback((shaft: InstancedShaft, event: { nativeEvent?: Event }) => {
        if (!isPointerInteractable) return;
        if (isPreparePointerInteractable) {
            emitSupportModelPointerSelect(shaft.modelId ?? null);
            return;
        }

        if (supportSelectionAndHoverSuppressed || braceAltActive || kickstandHotkeyActive) {
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
    }, [isPointerInteractable, isPreparePointerInteractable, isInteractable, supportSelectionAndHoverSuppressed, braceAltActive, kickstandHotkeyActive]);

    const handleSceneBatchedShaftPointerMove = React.useCallback((shaft: InstancedShaft, event: { point?: { x: number; y: number; z: number } | THREE.Vector3 } | null) => {
        if (!isPointerInteractable) return;
        if (orbitInteractionActiveRef.current) return;

        const jointDragInteractionActive = typeof window !== 'undefined' && !!(window as any).__jointGizmoDragging;
        const allowSuppressedShaftHoverForPlacementPreview = (braceAltActive || kickstandHotkeyActive) && mode === 'support' && !jointDragInteractionActive;

        const sceneHoverWriteDecision = resolveSceneBatchedShaftHoverWriteDecision({
            supportId: shaft.supportId,
            modelId: shaft.modelId,
            selectedCategory,
            selectedPrimitiveHoverActive,
            primitiveHoverOnSelectedSupport,
            selectedSupportIdSet,
            hoverSuppressed: supportSelectionAndHoverSuppressed,
            primitiveHoverSuppressesSceneShaftHover,
            selectedPrimitiveSupportId,
        });
        const point = event?.point
            ? { x: (event.point as any).x, y: (event.point as any).y, z: (event.point as any).z }
            : null;

        if (sceneHoverWriteDecision.type === 'clear' && sceneHoverWriteDecision.reason !== 'interaction-suppressed') {
            // When placement hotkeys are active, always emit shaft-hover so previews can track
            // unselected shafts even when hover suppression logic would otherwise clear it.
            if (allowSuppressedShaftHoverForPlacementPreview) {
                window.dispatchEvent(new CustomEvent('shaft-hover', {
                    detail: { segmentId: shaft.id, point, intersection: event },
                }));
            } else {
                window.dispatchEvent(new CustomEvent('shaft-leave', {
                    detail: { segmentId: shaft.id },
                }));
            }
            applySceneHoverWriteDecision(
                sceneHoverWriteDecision,
                pendingSceneHoverClearFrameRef,
                setSceneHoveredSupportId,
                emitSupportModelPointerHover,
            );
            return;
        }

        if (sceneHoverWriteDecision.type === 'clear' && sceneHoverWriteDecision.reason === 'interaction-suppressed') {
            if (allowSuppressedShaftHoverForPlacementPreview) {
                window.dispatchEvent(new CustomEvent('shaft-hover', {
                    detail: {
                        segmentId: shaft.id,
                        point,
                        intersection: event,
                    },
                }));
            } else {
                window.dispatchEvent(new CustomEvent('shaft-leave', {
                    detail: { segmentId: shaft.id },
                }));
            }
            applySceneHoverWriteDecision(
                sceneHoverWriteDecision,
                pendingSceneHoverClearFrameRef,
                setSceneHoveredSupportId,
                emitSupportModelPointerHover,
            );
            return;
        }

        if (mode === 'support') {
            window.dispatchEvent(new CustomEvent('shaft-hover', {
                detail: {
                    segmentId: shaft.id,
                    point,
                    intersection: event,
                },
            }));
        }

        applySceneHoverWriteDecision(
            sceneHoverWriteDecision,
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
    }, [isPointerInteractable, mode, braceAltActive, kickstandHotkeyActive, primitiveHoverOnSelectedSupport, primitiveHoverSuppressesSceneShaftHover, selectedCategory, selectedPrimitiveSupportId, selectedPrimitiveHoverActive, selectedSupportIdSet, supportSelectionAndHoverSuppressed]);

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

        applySceneHoverWriteDecision(
            resolveSceneBatchedShaftPointerOutWriteDecision(supportSelectionAndHoverSuppressed),
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
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

        applySceneHoverWriteDecision(
            resolveSceneBatchedSupportHoverWriteDecision({
                supportId: root.supportId,
                modelId: root.modelId,
                selectedCategory,
                selectedPrimitiveHoverActive,
                primitiveHoverOnSelectedSupport,
                selectedSupportIdSet,
                hoverSuppressed: supportSelectionAndHoverSuppressed,
                selectedPrimitiveSupportId,
            }),
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
    }, [isPointerInteractable, primitiveHoverOnSelectedSupport, selectedCategory, selectedPrimitiveSupportId, selectedPrimitiveHoverActive, selectedSupportIdSet, supportSelectionAndHoverSuppressed]);

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

        applySceneHoverWriteDecision(
            resolveSceneBatchedSupportHoverWriteDecision({
                supportId: cone.supportId,
                modelId: cone.modelId,
                selectedCategory,
                selectedPrimitiveHoverActive,
                primitiveHoverOnSelectedSupport,
                selectedSupportIdSet,
                hoverSuppressed: supportSelectionAndHoverSuppressed,
                selectedPrimitiveSupportId,
            }),
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
    }, [isPointerInteractable, primitiveHoverOnSelectedSupport, selectedPrimitiveSupportId, selectedPrimitiveHoverActive, selectedSupportIdSet, supportSelectionAndHoverSuppressed]);

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

        applySceneHoverWriteDecision(
            resolveSceneBatchedSupportHoverWriteDecision({
                supportId: joint.supportId,
                modelId: joint.modelId,
                selectedCategory,
                selectedPrimitiveHoverActive,
                primitiveHoverOnSelectedSupport,
                selectedSupportIdSet,
                hoverSuppressed: supportInteractionSuppressed,
                selectedPrimitiveSupportId,
            }),
            pendingSceneHoverClearFrameRef,
            setSceneHoveredSupportId,
            emitSupportModelPointerHover,
        );
    }, [isPointerInteractable, primitiveHoverOnSelectedSupport, selectedCategory, selectedPrimitiveSupportId, selectedPrimitiveHoverActive, selectedSupportIdSet, supportInteractionSuppressed]);

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
            if (!ghostTransparent && Math.abs(ghostOpacityClamped - 1) <= 1e-4) {
                return;
            }

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

        const clearMaterialClipping = (material: THREE.Material) => {
            const m = material as THREE.Material & { clippingPlanes?: THREE.Plane[] | null };
            if (m.clippingPlanes !== null) {
                m.clippingPlanes = null;
                material.needsUpdate = true;
            }
        };

        // Returns true if this object should be exempt from cross-section clipping.
        // Gizmo handles tag themselves with isGizmoHandle. Selected-support groups
        // are tagged with noClipping so their entire subtree is preserved.
        const isClipExempt = (obj: THREE.Object3D): boolean => {
            if (obj.userData.isGizmoHandle === true) return true;
            let cur: THREE.Object3D | null = obj;
            while (cur && cur !== root) {
                if (cur.userData.noClipping === true) return true;
                cur = cur.parent;
            }
            return false;
        };

        root.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.material) return;
            applyMeshRenderOrder(mesh);

            const exempt = isClipExempt(obj);

            if (Array.isArray(mesh.material)) {
                mesh.material.forEach((material) => {
                    if (exempt) {
                        clearMaterialClipping(material);
                    } else {
                        applyMaterialClipping(material);
                    }
                    applyMaterialGhostOpacity(material);
                });
            } else {
                if (exempt) {
                    clearMaterialClipping(mesh.material);
                } else {
                    applyMaterialClipping(mesh.material);
                }
                applyMaterialGhostOpacity(mesh.material);
            }
        });
    }, [
        clippingPlanes,
        ghostOpacityClamped,
        ghostTransparent,
        ghostRenderOrder,
        selectedId,
        // Re-apply clipping when committed support geometry collections change.
        // Without this, newly added meshes can miss clipping until some other
        // dependency (like slider movement) forces a re-run.
        state.roots,
        state.trunks,
        state.branches,
        state.leaves,
        state.twigs,
        state.sticks,
        state.braces,
        state.anchors,
        state.knots,
        kickstandState.roots,
        kickstandState.kickstands,
        kickstandState.knots,
    ]);

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
                <group key={`scene-trunk-batch:${group.modelId ?? 'none'}:${group.color}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={group.color}
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

            {sceneBatchedKickstandRootGroups.map((group) => (
                <InstancedRootsGroup
                    key={`scene-kickstand-root-batch:${group.color}:${group.roots.length}`}
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

            {placementPreviewBatches.map((batch) => (
                <group key={`${batch.id}:${batch.color}:${batch.opacity}`}>
                    {batch.shafts.length > 0 && (
                        <InstancedShaftGroup
                            shafts={batch.shafts}
                            color={batch.color}
                            emissive={batch.color}
                            emissiveIntensity={0.08}
                            transparent
                            opacity={batch.opacity}
                            radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                        />
                    )}
                    {batch.joints.length > 0 && (
                        <InstancedJointGroup
                            joints={batch.joints}
                            color={batch.color}
                            emissive={batch.color}
                            emissiveIntensity={0.08}
                            transparent
                            opacity={batch.opacity}
                            widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                            heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                        />
                    )}
                    {batch.roots.length > 0 && (
                        <InstancedRootsGroup
                            roots={batch.roots}
                            color={batch.color}
                            emissive={batch.color}
                            emissiveIntensity={0.08}
                            transparent
                            opacity={batch.opacity}
                        />
                    )}
                    {batch.cones.length > 0 && (
                        <InstancedContactConeGroup
                            cones={batch.cones}
                            color={batch.color}
                            emissive={batch.color}
                            emissiveIntensity={0.08}
                            transparent
                            opacity={batch.opacity}
                        />
                    )}
                </group>
            ))}

            {hoveredSupportOverlayShafts.length > 0 && hoveredSupportShaftSet && (
                <InstancedShaftGroup
                    key={`scene-hover-overlay:${hoveredSupportShaftSet.supportId}:${hoveredSupportOverlayShafts.length}`}
                    shafts={hoveredSupportOverlayShafts}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportShaftSet.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.12}
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
                    emissiveIntensity={0.12}
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
                    emissiveIntensity={0.12}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                    heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                    onJointClick={isPointerInteractable ? handleSceneBatchedJointClick : undefined}
                    onJointPointerMove={isPointerInteractable ? handleSceneBatchedJointPointerMove : undefined}
                    onJointPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {hoveredSupportOverlayRoots.length > 0 && (
                <InstancedRootsGroup
                    key={`scene-root-hover-overlay:${hoveredSupportOverlayRoots.map((root) => root.supportId ?? root.id).join(':')}:${hoveredSupportOverlayRoots.length}`}
                    roots={hoveredSupportOverlayRoots}
                    color={dimNonSelected ? '#666666' : resolveBaseColor(hoveredSupportOverlayRoots[0]?.modelId)}
                    emissive="#ffffff"
                    emissiveIntensity={0.12}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onRootClick={isPointerInteractable ? handleSceneBatchedRootClick : undefined}
                    onRootPointerMove={isPointerInteractable ? handleSceneBatchedRootPointerMove : undefined}
                    onRootPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {marqueeHoveredOverlayShafts.length > 0 && (
                <InstancedShaftGroup
                    key={`scene-marquee-overlay-shafts:${marqueeHoveredSupportIds.join(':')}:${marqueeHoveredOverlayShafts.length}`}
                    shafts={marqueeHoveredOverlayShafts}
                    color={BULK_MULTI_SELECTED_COLOR}
                    emissive="#ffffff"
                    emissiveIntensity={0.12}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    radialSegments={BATCHED_SHAFT_RADIAL_SEGMENTS}
                    onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                    onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                    onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {marqueeHoveredOverlayCones.length > 0 && (
                <InstancedContactConeGroup
                    key={`scene-marquee-overlay-cones:${marqueeHoveredSupportIds.join(':')}:${marqueeHoveredOverlayCones.length}`}
                    cones={marqueeHoveredOverlayCones}
                    color={BULK_MULTI_SELECTED_COLOR}
                    emissive="#ffffff"
                    emissiveIntensity={0.12}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onConeClick={isPointerInteractable ? handleSceneBatchedConeClick : undefined}
                    onConePointerMove={isPointerInteractable ? handleSceneBatchedConePointerMove : undefined}
                    onConePointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {marqueeHoveredOverlayJoints.length > 0 && (
                <InstancedJointGroup
                    key={`scene-marquee-overlay-joints:${marqueeHoveredSupportIds.join(':')}:${marqueeHoveredOverlayJoints.length}`}
                    joints={marqueeHoveredOverlayJoints}
                    color={BULK_MULTI_SELECTED_COLOR}
                    emissive="#ffffff"
                    emissiveIntensity={0.12}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    widthSegments={BATCHED_JOINT_WIDTH_SEGMENTS}
                    heightSegments={BATCHED_JOINT_HEIGHT_SEGMENTS}
                    onJointClick={isPointerInteractable ? handleSceneBatchedJointClick : undefined}
                    onJointPointerMove={isPointerInteractable ? handleSceneBatchedJointPointerMove : undefined}
                    onJointPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {marqueeHoveredOverlayRoots.length > 0 && (
                <InstancedRootsGroup
                    key={`scene-marquee-overlay-roots:${marqueeHoveredSupportIds.join(':')}:${marqueeHoveredOverlayRoots.length}`}
                    roots={marqueeHoveredOverlayRoots}
                    color={BULK_MULTI_SELECTED_COLOR}
                    emissive="#ffffff"
                    emissiveIntensity={0.12}
                    transparent={ghostTransparent}
                    opacity={ghostOpacityClamped}
                    onRootClick={isPointerInteractable ? handleSceneBatchedRootClick : undefined}
                    onRootPointerMove={isPointerInteractable ? handleSceneBatchedRootPointerMove : undefined}
                    onRootPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                />
            )}

            {renderTrunkList.map(trunk => {
                if (!isModelVisible(trunk.modelId, trunk.id)) return null;
                const root = state.roots[trunk.rootId];
                if (!root) return null;

                const effectiveSelected = selectedTrunkIds.has(trunk.id);
                const renderDetailedTrunk = effectiveSelected;
                if (!renderDetailedTrunk) return null;

                const isTrunkHovered = hoveredSupportIdForVisual === trunk.id
                    || marqueeHoveredSupportIdSet.has(trunk.id);
                const deferTrunkInteractionToSceneBatch = !effectiveSelected;

                return (
                    // noClipping: this trunk is actively selected/edited — exempt it
                    // from cross-section clipping so it always renders fully visible.
                    <group key={trunk.id} userData={{ noClipping: true }}>
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
                <group key={`scene-branch-batch:${group.modelId ?? 'none'}:${group.color}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={group.color}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {renderBranchList.map(branch => {
                if (!isModelVisible(branch.modelId, branch.id)) return null;
                const knot = renderKnotsById[branch.parentKnotId];
                if (!knot) return null;

                const effectiveSelected = selectedBranchIds.has(branch.id);
                const renderDetailedBranch = effectiveSelected;
                if (!renderDetailedBranch) return null;

                const isBranchHovered = hoveredSupportIdForVisual === branch.id
                    || marqueeHoveredSupportIdSet.has(branch.id);
                const deferBranchInteractionToSceneBatch = !effectiveSelected;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={branch.id} userData={{ noClipping: true }}>
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
            {renderLeafList.map(leaf => {
                if (!isModelVisible(leaf.modelId, leaf.id)) return null;
                const knot = renderKnotsById[leaf.parentKnotId];
                if (!knot) return null;

                const effectiveSelected = selectedLeafIds.has(leaf.id);
                if (!effectiveSelected) return null;
                const showKnots = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={leaf.id} userData={{ noClipping: true }}>
                    <LeafRenderer
                        key={leaf.id}
                        leaf={leaf}
                        parentKnot={knot}
                        selectedId={selectedId}
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
            {renderTwigList.map(twig => {
                if (!isModelVisible(twig.modelId, twig.id)) return null;
                const effectiveSelected = selectedTwigIds.has(twig.id);
                const isTwigBatchable = twigShaftsBySupport.has(twig.id);
                const renderDetailedTwig = effectiveSelected || !isTwigBatchable;
                if (!renderDetailedTwig) return null;

                const isTwigHovered = hoveredSupportIdForVisual === twig.id
                    || marqueeHoveredSupportIdSet.has(twig.id);
                const deferTwigInteractionToSceneBatch = !effectiveSelected && isTwigBatchable;

                return (
                    <group key={twig.id} userData={{ noClipping: effectiveSelected }}>
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
                <group key={`scene-twig-batch:${group.modelId ?? 'none'}:${group.color}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={group.color}
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
            {renderStickList.map(stick => {
                if (!isModelVisible(stick.modelId, stick.id)) return null;
                const effectiveSelected = selectedStickIds.has(stick.id);
                const isStickBatchable = stickShaftsBySupport.has(stick.id);
                const renderDetailedStick = effectiveSelected || !isStickBatchable;
                if (!renderDetailedStick) return null;

                const isStickHovered = hoveredSupportIdForVisual === stick.id
                    || marqueeHoveredSupportIdSet.has(stick.id);
                const deferStickInteractionToSceneBatch = !effectiveSelected && isStickBatchable;

                return (
                    <group key={stick.id} userData={{ noClipping: effectiveSelected }}>
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
                <group key={`scene-stick-batch:${group.modelId ?? 'none'}:${group.color}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={group.color}
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
                <group key={`scene-brace-batch:${group.modelId ?? 'none'}:${group.color}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={group.color}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {renderBraceList.map(brace => {
                if (!isModelVisible(brace.modelId, brace.id)) return null;
                const effectiveSelected = selectedBraceIds.has(brace.id);
                const isBraceBatchable = braceShaftsBySupport.has(brace.id);
                const isBraceGhosted = ghostedBraceIdSet.has(brace.id);
                const renderDetailedBrace = effectiveSelected || !isBraceBatchable || isBraceGhosted;
                if (!renderDetailedBrace) return null;

                const isBraceHovered = hoveredSupportIdForVisual === brace.id
                    || marqueeHoveredSupportIdSet.has(brace.id);
                const deferBraceInteractionToSceneBatch = !effectiveSelected && isBraceBatchable;
                const showKnots = !hideUnselectedKnots || effectiveSelected;
                const braceStartKnot = braceRenderKnotsById[brace.startKnotId];
                const braceEndKnot = braceRenderKnotsById[brace.endKnotId];
                if (!braceStartKnot || !braceEndKnot) return null;

                return (
                    <group key={brace.id} userData={{ noClipping: effectiveSelected }}>
                        <BraceRenderer
                            key={brace.id}
                            brace={brace}
                            startKnot={braceStartKnot}
                            endKnot={braceEndKnot}
                            isSelected={effectiveSelected}
                            ghosted={isBraceGhosted}
                            ghostOpacity={ghostOpacityClamped}
                            dimNonSelected={dimNonSelected}
                            baseColor={resolveBaseColor(brace.modelId)}
                            showKnots={showKnots}
                            suppressHover={suppressHover || isBraceGhosted}
                            isHovered={isBraceHovered}
                            isInteractable={isInteractable && !isBraceGhosted}
                            deferStraightShaftToSceneBatch={!effectiveSelected && isBraceBatchable && !isBraceGhosted}
                            deferInteractionToSceneBatch={deferBraceInteractionToSceneBatch || isBraceGhosted}
                            debugSectionColors={settings.autoBracing.debugSectionColorsEnabled}
                        />
                    </group>
                );
            })}

            {/* Render Kickstands */}
            {renderKickstandList.map((kickstand) => {
                if (!isModelVisible(kickstand.modelId, kickstand.id)) return null;
                const root = kickstandState.roots[kickstand.rootId];
                const hostKnot = renderKickstandKnotsById[kickstand.hostKnotId];
                if (!root || !hostKnot) return null;

                const effectiveSelected = selectedKickstandIds.has(kickstand.id);
                const isKickstandBatchable = kickstandShaftsBySupport.has(kickstand.id);
                const renderDetailedKickstand = effectiveSelected || !isKickstandBatchable;
                if (!renderDetailedKickstand) return null;

                const isKickstandHovered = hoveredSupportIdForVisual === kickstand.id
                    || marqueeHoveredSupportIdSet.has(kickstand.id);
                const deferKickstandInteractionToSceneBatch = !effectiveSelected && isKickstandBatchable;
                const showKnot = !hideUnselectedKnots || effectiveSelected;

                return (
                    <group key={kickstand.id} userData={{ noClipping: effectiveSelected }}>
                    <KickstandRenderer
                        key={kickstand.id}
                        kickstand={kickstand}
                        root={root}
                        hostKnot={hostKnot}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isKickstandHovered}
                        baseColor={resolveBaseColor(kickstand.modelId)}
                        showKnot={showKnot}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                        deferStraightShaftsToSceneBatch={!effectiveSelected && isKickstandBatchable}
                        deferInteractionToSceneBatch={deferKickstandInteractionToSceneBatch}
                        hidePlateContactPrimitives={hidePlateContactPrimitivesEffective}
                    />
                    </group>
                );
            })}

            {sceneBatchedKickstandShaftGroups.map((group) => (
                <group key={`scene-kickstand-batch:${group.modelId ?? 'none'}:${group.color}:${group.shafts.length}`} userData={{ modelId: group.modelId ?? null }}>
                    <InstancedShaftGroup
                        shafts={group.shafts}
                        color={group.color}
                        transparent={ghostTransparent}
                        opacity={ghostOpacityClamped}
                        radialSegments={sceneBatchedShaftRadialSegments}
                        onShaftClick={isPointerInteractable ? handleSceneBatchedShaftClick : undefined}
                        onShaftPointerMove={isPointerInteractable ? handleSceneBatchedShaftPointerMove : undefined}
                        onShaftPointerOut={isPointerInteractable ? handleSceneBatchedShaftPointerOut : undefined}
                    />
                </group>
            ))}

            {/* Render Anchors */}
            {anchorList.map(anchor => {
                if (!isModelVisible(anchor.modelId, anchor.id)) return null;
                const effectiveSelected = selectedAnchorIds.has(anchor.id);
                const isAnchorHovered = hoveredSupportIdForVisual === anchor.id
                    || marqueeHoveredSupportIdSet.has(anchor.id);

                return (
                    <group key={anchor.id}>
                    <AnchorRenderer
                        key={anchor.id}
                        anchor={anchor}
                        isSelected={effectiveSelected}
                        selectedId={effectiveSelected ? selectedId : null}
                        dimNonSelected={dimNonSelected}
                        isHovered={isAnchorHovered}
                        baseColor={resolveBaseColor(anchor.modelId)}
                        suppressHover={suppressHover}
                        isInteractable={isInteractable}
                    />
                    </group>
                );
            })}

            {/*
              Auto-bracing debug overlay mount point.
              - This only renders Voronoi seed indicators when the auto-bracing debug toggle is enabled.
              - Core support rendering does not depend on these markers.
              - If needed later, this block can be safely commented out or removed.
            */}
            <VoronoiSeedDebugMarkers
                enabled={!!settings.autoBracing.debugVoronoiSeedsEnabled}
                ghostRenderOrder={ghostRenderOrder}
                isModelVisible={isModelVisible}
                applyDropToVec3Like={applyDropToVec3Like}
            />
        </group>
    );
});

SupportRenderer.displayName = 'SupportRenderer';
