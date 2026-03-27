import React, { useSyncExternalStore } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Trunk, Roots } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, startContactDiskDragSession, type ContactDiskDragHit, type ContactDiskDragSession } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { useJointDragPreview } from '../../interaction/jointDragPreview';
import { getSnapshot, updateTrunk } from '../../state';
import { subscribeToSettings, getSettingsSnapshot } from '../../Settings';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

interface TrunkRendererProps {
    trunk: Trunk;
    root: Roots;
    isSelected?: boolean;
    selectedId?: string | null;
    dimNonSelected?: boolean;
    isHovered?: boolean; // Legacy prop
    suppressHover?: boolean;
    isInteractable?: boolean;
    deferStraightShaftsToSceneBatch?: boolean;
    deferInteractionToSceneBatch?: boolean;
    deferRootsToSceneBatch?: boolean;
    deferContactConesToSceneBatch?: boolean;
    hidePlateContactPrimitives?: boolean;
    baseColor?: string;
    hoverColor?: string;
    selectedColor?: string;
    onContactDiskHudHoverChange?: (hovered: boolean) => void;
}

export const TrunkRenderer = React.memo(function TrunkRenderer({ trunk, root, isSelected, selectedId, dimNonSelected, isHovered: propHovered, suppressHover, isInteractable = true, deferStraightShaftsToSceneBatch = false, deferInteractionToSceneBatch = false, deferRootsToSceneBatch = false, deferContactConesToSceneBatch = false, hidePlateContactPrimitives = false, baseColor = '#ff8800', hoverColor, selectedColor = '#80fffd', onContactDiskHudHoverChange }: TrunkRendererProps) {
    const { camera, scene, gl } = useThree();
    const highDetailPrimitiveSegments = 24;
    const lowDetailPrimitiveSegments = 8;
    const useLowDetailPrimitives = !isSelected && !propHovered;
    const previewTrunk = useJointDragPreview<Trunk>('trunk', trunk.id);
    const dragSessionRef = React.useRef<ContactDiskDragSession | null>(null);
    const liveDragConeRef = React.useRef<import('../../SupportPrimitives/ContactCone/types').ContactCone | null>(null);
    const beforeHistoryRef = React.useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const [, setDragTick] = React.useState(0);

    // Use universal highlight hook
    const { pickRef, visuals, isPickingHovered } = useHighlight({
        id: trunk.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
        selectedColor,
        hoverColor,
    });

    // Subscribe to settings for Base Flare reactivity
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const baseFlare = settings.baseFlare;
    const rootsSettings = settings.roots;
    const baseFlareEnabled = baseFlare.enabled;

    // Handle Click
    const handleClick = (e: any) => {
        if (!isPickingHovered && !isSelected) return;
        handleSupportClick(e, trunk.id, !!isInteractable);
    };

    const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
        if (!isSelected || !trunk.contactCone) return;
        if (!isPrimaryPointerPress(e)) return;

        const socketAnchor = getFinalSocketPosition(trunk.contactCone);
        beforeHistoryRef.current = captureSupportEditSnapshot();

        dragSessionRef.current?.stop();
        dragSessionRef.current = startContactDiskDragSession({
            camera,
            domElement: gl.domElement,
            scene,
            initialEvent: e,
            modelId: trunk.modelId,
            onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
                const latest = getSnapshot().trunks[trunk.id];
                if (!latest?.contactCone) return;
                liveDragConeRef.current = recomputeContactConeForMovedDisk(latest.contactCone, point, surfaceNormal, socketAnchor);
                setDragTick(t => t + 1);
            },
            onEnd: () => {
                if (liveDragConeRef.current) {
                    const latest = getSnapshot().trunks[trunk.id];
                    if (latest) updateTrunk({ ...latest, contactCone: liveDragConeRef.current });
                    if (beforeHistoryRef.current) {
                        pushSupportEditHistory('Move trunk tip', beforeHistoryRef.current, captureSupportEditSnapshot());
                    }
                }
                liveDragConeRef.current = null;
                dragSessionRef.current = null;
                beforeHistoryRef.current = null;
            },
        });
    }, [camera, gl.domElement, isSelected, scene, trunk.id, trunk.contactCone, trunk.modelId]);

    const handleContactDiskHudPointerUp = React.useCallback(() => {
        dragSessionRef.current?.stop();
        dragSessionRef.current = null;
    }, []);
    // --- Roots parameters for segment start calculation ---
    const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
    // Matches RootsRenderer logic
    // TODO: Handle Raft vertical offset logic if needed here too? 
    // RootsRenderer applies verticalOffset, but Trunk usually connects to the top of the root.
    // If root.pos is at Z=0, and RootsRenderer lifts it, Trunk needs to know.
    // However, TrunkRenderer usually relies on standard geometry.
    // Let's check if RootsRenderer lifts it purely visually or physically.
    // RootsRenderer: `const basePos = ... root.transform.pos.z + verticalOffset`
    // So the Visual Root is lifted. The Trunk logic must also lift the start point.
    
    // Fetch Raft settings to sync vertical offset
    // We can't easily import Raft store here without adding dependency.
    // For now, let's assume standard Z=0 behavior unless we see gaps.
    // Actually, we should probably align the logic.
    
    const diskHeight = rootsSettings.diskHeightMm; // Use global setting
    const coneHeight = baseFlareEnabled ? baseFlare.heightMm : (root.coneHeight || 1.5);
    
    // Effective Cone Height depends on Base Flare setting
    const effectiveConeHeight = baseFlareEnabled ? coneHeight : 0;

    const shaftDiameter = trunk.segments[0]?.diameter ?? 1.5;

    // --- Render Segments ---
    // Segments start at the CENTER of the Roots sphere (same as joints)
    // Sphere center is at diskHeight + effectiveConeHeight
    let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, diskHeight + effectiveConeHeight));

    const shafts: React.ReactNode[] = [];
    const batchedStraightShafts: InstancedShaft[] = [];
    const joints: React.ReactNode[] = [];

    const effectiveTrunk = previewTrunk ?? trunk;

    effectiveTrunk.segments.forEach((seg, index) => {
        if (seg.bottomJoint) {
            currentStart = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
        }

        let endPoint: THREE.Vector3;
        
        if (seg.topJoint) {
            endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
        } else if (effectiveTrunk.contactCone) {
            // Shaft ends at the cone's socket position
            const socketPos = getFinalSocketPosition(effectiveTrunk.contactCone);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else {
            endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
        }
        
        const startPos = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
        const endPos = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

        currentStart = endPoint;

        const isSegSelected = selectedId === seg.id;

        // Add Shaft
        const canBatchShaft = !isSelected && !deferStraightShaftsToSceneBatch && seg.type !== 'bezier';

        if (canBatchShaft) {
            batchedStraightShafts.push({
                id: seg.id,
                start: startPos,
                end: endPos,
                diameter: seg.diameter,
            });
        } else if (seg.type === 'bezier') {
            const bezierColor = isSelected ? '#ff00ff' : visuals.color;
            shafts.push(
                <BezierRenderer
                    key={`shaft-${seg.id}`}
                    id={seg.id}
                    start={startPos}
                    end={endPos}
                    control1={seg.controlPoint1}
                    control2={seg.controlPoint2}
                    diameter={seg.diameter}
                    resolution={seg.resolution}
                    color={bezierColor}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isParentSelected={isSelected}
                    isInteractable={isInteractable}
                    isSelected={isSegSelected}
                    onClick={() => selectPrimitiveById(seg.id)}
                />
            );
        } else if (!deferStraightShaftsToSceneBatch || isSelected) {
            shafts.push(
                <ShaftRenderer
                    key={`shaft-${seg.id}`}
                    id={seg.id}
                    start={startPos}
                    end={endPos}
                    diameter={seg.diameter}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isParentSelected={isSelected}
                    isInteractable={isInteractable}
                    isSelected={isSegSelected}
                    onClick={() => selectPrimitiveById(seg.id)}
                />
            );
        }

        // Add Joint
        if (isSelected && seg.topJoint) {
            joints.push(
                <JointRenderer
                    key={`joint-${seg.topJoint.id}`}
                    joint={{
                        id: seg.topJoint.id,
                        pos: seg.topJoint.pos,
                        diameter: seg.topJoint.diameter
                    }}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />
            );
        }
    });

    // --- Render Contact Cone ---
    const effectiveCone = liveDragConeRef.current ?? effectiveTrunk.contactCone;
    let coneRender = null;
    if (effectiveCone && !deferContactConesToSceneBatch) {
        const isConeSelected = !!effectiveCone.id && selectedId === effectiveCone.id;
        coneRender = (
            <ContactConeRenderer
                contactDiskId={effectiveCone.id}
                pos={effectiveCone.pos}
                normal={effectiveCone.normal}
                surfaceNormal={effectiveCone.surfaceNormal}
                diskLengthOverride={effectiveCone.diskLengthOverride}
                profile={effectiveCone.profile}
                color={visuals.color}
                emissive={visuals.emissive}
                emissiveIntensity={visuals.emissiveIntensity}
                radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                socketJointId={effectiveCone.socketJointId}
                isInteractable={isInteractable}
                isParentSelected={isSelected}
                isContactDiskSelected={isConeSelected}
                onDiskHudHoverChange={onContactDiskHudHoverChange}
                onDiskHudPointerDown={handleContactDiskHudPointerDown}
                onDiskHudPointerUp={handleContactDiskHudPointerUp}
            />
        );
    }

    return (
        <group
            onClick={handleClick}
        >
            {/* Trunk Picking Group - Contains Roots, Shafts, Cones */}
            <group ref={pickRef as any}>
                {!hidePlateContactPrimitives && !deferRootsToSceneBatch && (
                    <RootsRenderer
                        root={root}
                        shaftDiameter={shaftDiameter}
                        color={visuals.color}
                        emissive={visuals.emissive}
                        emissiveIntensity={visuals.emissiveIntensity}
                        radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                        sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                    />
                )}
                <InstancedShaftGroup
                    shafts={batchedStraightShafts}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                />
                {shafts}
                {coneRender}
            </group>

            {/* Joints - Separate picking */}
            {joints}
        </group>
    );
});

TrunkRenderer.displayName = 'TrunkRenderer';
