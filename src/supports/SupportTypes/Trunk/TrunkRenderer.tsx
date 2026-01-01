import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { Trunk, Roots, Vec3 } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { validateBezierConstraints } from '../../Curves/BezierUtils';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { setSelectedId } from '../../state';
import { subscribeToSettings, getSettingsSnapshot } from '../../Settings';

interface TrunkRendererProps {
    trunk: Trunk;
    root: Roots;
    isSelected?: boolean;
    selectedId?: string | null;
    dimNonSelected?: boolean;
    isHovered?: boolean; // Legacy prop
    suppressHover?: boolean;
    isInteractable?: boolean;
    hidePlateContactPrimitives?: boolean;
}

export function TrunkRenderer({ trunk, root, isSelected, selectedId, dimNonSelected, isHovered: propHovered, suppressHover, isInteractable = true, hidePlateContactPrimitives = false }: TrunkRendererProps) {
    // Use universal highlight hook
    const { pickRef, visuals } = useHighlight({
        id: trunk.id,
        category: 'support',
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
        selectedColor: '#80fffd'
    });

    // Subscribe to settings for Base Flare reactivity
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const baseFlare = settings.baseFlare;
    const rootsSettings = settings.roots;
    const baseFlareEnabled = baseFlare.enabled;

    // Handle Click
    const handleClick = (e: any) => {
        handleSupportClick(e, trunk.id, !!isInteractable);
    };

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
    const coneHeight = baseFlareEnabled ? baseFlare.heightMm : (root.height || 1.5);
    
    // Effective Cone Height depends on Base Flare setting
    const effectiveConeHeight = baseFlareEnabled ? coneHeight : 0;

    const shaftDiameter = trunk.segments[0]?.diameter ?? 1.5;

    // --- Render Segments ---
    // Segments start at the CENTER of the Roots sphere (same as joints)
    // Sphere center is at diskHeight + effectiveConeHeight
    let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, diskHeight + effectiveConeHeight));

    const shafts: React.ReactNode[] = [];
    const joints: React.ReactNode[] = [];

    trunk.segments.forEach((seg, index) => {
        let endPoint: THREE.Vector3;
        
        if (seg.topJoint) {
            endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
        } else if (trunk.contactCone) {
            // Shaft ends at the cone's socket position
            const socketPos = getFinalSocketPosition(trunk.contactCone);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else {
            endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
        }
        
        const startPos = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
        const endPos = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

        currentStart = endPoint;

        const isSegSelected = selectedId === seg.id;

        // Add Shaft
        if (seg.type === 'bezier') {
            // If parent is selected, Bezier segments appear Magenta to distinguish from Cyan straight segments
            // If not selected, they match the standard Orange color
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
                    isParentSelected={isSelected}
                    isSelected={isSegSelected}
                    onClick={() => setSelectedId(seg.id)}
                />
            );
        } else {
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
                    isParentSelected={isSelected}
                    isSelected={isSegSelected}
                    onClick={() => setSelectedId(seg.id)}
                />
            );
        }

        // Add Joint
        if (seg.topJoint) {
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
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />
            );
        }
    });

    // --- Render Contact Cone ---
    let coneRender = null;
    if (trunk.contactCone) {
        coneRender = (
            <ContactConeRenderer
                pos={trunk.contactCone.pos}
                normal={trunk.contactCone.normal}
                surfaceNormal={trunk.contactCone.surfaceNormal}
                diskLengthOverride={trunk.contactCone.diskLengthOverride}
                profile={trunk.contactCone.profile}
                color={visuals.color}
                emissive={visuals.emissive}
                emissiveIntensity={visuals.emissiveIntensity}
                socketJointId={trunk.contactCone.socketJointId}
                isInteractable={isInteractable}
                isParentSelected={isSelected}
            />
        );
    }

    return (
        <group onClick={handleClick}>
            {/* Trunk Picking Group - Contains Roots, Shafts, Cones */}
            <group ref={pickRef as any}>
                {!hidePlateContactPrimitives && (
                    <RootsRenderer
                        root={root}
                        shaftDiameter={shaftDiameter}
                        color={visuals.color}
                        emissive={visuals.emissive}
                        emissiveIntensity={visuals.emissiveIntensity}
                    />
                )}
                {shafts}
                {coneRender}
            </group>

            {/* Joints - Separate picking */}
            {joints}
        </group>
    );
}
