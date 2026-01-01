import React from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { Roots, Trunk, Branch, Segment, Joint, Vec3, Knot, LimitationCode, WarningCode, ContactDisk } from '../types';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { JointRenderer } from '../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../SupportPrimitives/Shaft/ShaftRenderer';
import { RootsRenderer } from '../SupportPrimitives/Roots/RootsRenderer';
import { ContactConeRenderer, getSocketPosition, getFinalSocketPosition } from '../SupportPrimitives/ContactCone';
import { ContactDiskRenderer } from '../SupportPrimitives/ContactDisk';
import { KnotRenderer } from '../SupportPrimitives/Knot/KnotRenderer';
import { getSettings } from '../Settings';
import { useSyncExternalStore } from 'react';
import { getRaftSettings, subscribeToRaftStore } from '../Rafts/Crenelated/RaftState';

/**
 * Generic support data that SupportBuilder can render.
 * This is agnostic to support type (trunk, branch, twig, etc.)
 */
export interface SupportData {
    id: string;
    // Optional components - render what's present
    roots?: Roots;
    segments: Segment[];
    contactCone?: ContactCone;
    contactCones?: ContactCone[];
    contactDisks?: ContactDisk[];
    // Optional knot (used by Leaf preview)
    knot?: Knot;
    // For branches: starting position (from knot)
    startPos?: Vec3;
    // Validation state
    error?: LimitationCode;
    warning?: WarningCode;
    angle?: number;
}

// --- Anatomy Highlight Colors ---
export interface AnatomyColors {
    roots?: string;      // Base (Fallback)
    rootsDisk?: string;  // Base Disk
    rootsCone?: string;  // Base Cone
    shaft?: string;      // Trunks/Shafts
    joint?: string;      // Joints
    tipBody?: string;    // Cone Body
    tipDisk?: string;    // Contact Disk
}

interface SupportBuilderProps {
    data: SupportData;
    isPreview?: boolean;
    showPreviewAngleLabel?: boolean;
    hidePlateContactPrimitives?: boolean;
    // For real supports: interaction callbacks
    onClick?: (id: string, point: Vec3) => void;
    onJointSelect?: (supportId: string, jointId: string) => void;
    // For real supports: visual state
    isSelected?: boolean;
    suppressHover?: boolean;
    // Optional raft override (e.g. for preview)
    raftOverride?: { bottomMode: 'off' | 'solid' | 'line'; thickness: number };
    // Optional visual overrides
    highlightJoints?: boolean;
    previewMaterialOverride?: { color?: string; opacity?: number };
    rootsDiskMaterialOverride?: { transparent?: boolean; opacity?: number; depthWrite?: boolean };
    anatomyOverrides?: AnatomyColors; // Granular highlight overrides
}

// Preview material settings
const PREVIEW_COLOR = '#00ff00';
const PREVIEW_ERROR_COLOR = '#ff0000'; // Red for invalid placement
const PREVIEW_WARNING_COLOR = '#ffcc00'; // Yellow for warning
const PREVIEW_ORANGE_COLOR = '#ff6600'; // Orange for steep vertical warning
const PREVIEW_OPACITY = 0.5;
const PREVIEW_ERROR_OPACITY = 0.15;

// Normal material settings
const NORMAL_COLOR = '#ff8800';
const SELECTED_COLOR = '#80fffd';

/**
 * SupportBuilder - Generic renderer for any support type.
 * 
 * Renders whatever primitives are present in the data:
 * - roots → RootsRenderer
 * - segments → ShaftRenderer for each
 * - joints (from segments) → JointRenderer for each
 * - contactCone → ContactConeRenderer
 * 
 * Does NOT know what a "trunk" or "branch" is.
 * The data structure defines what gets rendered.
 */
export function SupportBuilder({
    data,
    isPreview = false,
    showPreviewAngleLabel = false,
    hidePlateContactPrimitives = false,
    onClick,
    onJointSelect,
    isSelected = false,
    suppressHover = false,
    raftOverride,
    highlightJoints = false,
    previewMaterialOverride,
    rootsDiskMaterialOverride,
    anatomyOverrides
}: SupportBuilderProps) {
    const storeRaft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

    // Determine colors based on preview/selected state
    const getBaseColor = () => {
        if (isPreview) {
            if (data.error) return PREVIEW_ERROR_COLOR;

            if (previewMaterialOverride?.color) {
                return previewMaterialOverride.color;
            }

            // Gradient Logic for Valid Placement
            let angle = data.angle;

            // Fallback: Calculate angle from contact cone if missing
            if (angle === undefined && data.contactCone) {
                const normal = new THREE.Vector3(
                    data.contactCone.normal.x,
                    data.contactCone.normal.y,
                    data.contactCone.normal.z
                );
                const up = new THREE.Vector3(0, 0, 1);
                angle = normal.angleTo(up) * (180 / Math.PI);
            }

            if (angle !== undefined) {
                // 91 degrees = Green (Vertical Wall)
                // 115 degrees = Yellow (Warning Threshold)
                // > 115 degrees = Yellow (Steeper Overhangs remain yellow)

                const startAngle = 91;
                const midAngle = 120; // Yellow midpoint (skewed towards Orange)
                const endAngle = 180; // Full range up to flat ceiling

                let finalColor: THREE.Color;

                if (angle <= midAngle) {
                    // First segment: Orange -> Yellow (90 -> 120)
                    // Normalize t from 0 to 1 within this segment
                    const t = Math.max(0, (angle - startAngle) / (midAngle - startAngle));
                    const c1 = new THREE.Color(PREVIEW_ORANGE_COLOR);
                    const c2 = new THREE.Color(PREVIEW_WARNING_COLOR);
                    finalColor = c1.lerp(c2, t);
                } else {
                    // Second segment: Yellow -> Green (120 -> 180)
                    // Normalize t from 0 to 1 within this segment
                    const t = Math.min(1, (angle - midAngle) / (endAngle - midAngle));
                    const c1 = new THREE.Color(PREVIEW_WARNING_COLOR);
                    const c2 = new THREE.Color(PREVIEW_COLOR);
                    finalColor = c1.lerp(c2, t);
                }

                return '#' + finalColor.getHexString();
            } else {
                // Debug: Why is angle undefined?
                // console.warn('SupportData angle is undefined');
            }

            if (data.warning) return PREVIEW_WARNING_COLOR;
            return PREVIEW_COLOR;
        }
        return isSelected ? SELECTED_COLOR : NORMAL_COLOR;
    };

    const getOpacity = () => {
        if (!isPreview) return 1;
        if (data.error) return PREVIEW_ERROR_OPACITY;
        if (previewMaterialOverride?.opacity !== undefined) return previewMaterialOverride.opacity;
        return PREVIEW_OPACITY;
    };

    const color = getBaseColor();
    const opacity = getOpacity();
    const emissive = isSelected ? '#80fffd' : '#000000';
    const emissiveIntensity = isSelected ? 0.3 : 0;

    // Handle click on the support
    const handleClick = (e: any) => {
        if (isPreview) return; // Previews aren't clickable
        e.stopPropagation();
        if (onClick) {
            onClick(data.id, { x: e.point.x, y: e.point.y, z: e.point.z });
        }
    };

    // Handle joint selection
    const handleJointSelect = (jointId: string) => {
        if (isPreview) return;
        if (onJointSelect) onJointSelect(data.id, jointId);
    };

    // Define nullRaycast for previews to prevent blocking interaction
    const nullRaycast = isPreview ? () => null : undefined;

    // --- Calculate segment start position ---
    let currentStart: THREE.Vector3;

    if (data.roots) {
        // Start from roots sphere center
        const basePos = new THREE.Vector3(
            data.roots.transform.pos.x,
            data.roots.transform.pos.y,
            data.roots.transform.pos.z
        );

        const raft = raftOverride || storeRaft;
        const diskHeight = data.roots.diskHeight;
        const coneHeight = data.roots.coneHeight;
        const hasSolidBottom = (raft as any).bottomMode === 'solid';
        const effectiveDiskHeight = hasSolidBottom ? 0.05 : diskHeight;
        currentStart = basePos.clone().add(new THREE.Vector3(0, 0, effectiveDiskHeight + coneHeight));
    } else if (data.startPos) {
        // Start from provided position (e.g., knot for branches)
        currentStart = new THREE.Vector3(data.startPos.x, data.startPos.y, data.startPos.z);
    } else {
        // Fallback
        currentStart = new THREE.Vector3(0, 0, 0);
    }

    const uniqueJoints = new Map<string, Joint>();
    for (const seg of data.segments) {
        if (seg.bottomJoint) uniqueJoints.set(seg.bottomJoint.id, seg.bottomJoint);
        if (seg.topJoint) uniqueJoints.set(seg.topJoint.id, seg.topJoint);
    }

    // --- Render Segments ---
    const shaftDiameter = data.segments[0]?.diameter ?? 1.0;

    const renderedSegments = data.segments.map((seg, index) => {
        let endPoint: THREE.Vector3;

        if (seg.topJoint) {
            endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
        } else if (data.contactCone) {
            // Shaft ends at the cone's socket position
            // Must use getFinalSocketPosition to account for disk offset
            const socketPos = getFinalSocketPosition(data.contactCone);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else {
            // Fallback: extend upward
            endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
        }

        const startPos = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
        const endPos = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

        // Move start for next segment
        const segmentStart = currentStart.clone();
        currentStart = endPoint;

        return (
            <React.Fragment key={seg.id}>
                <ShaftRenderer
                    id={seg.id}
                    start={startPos}
                    end={endPos}
                    diameter={seg.diameter}
                    color={anatomyOverrides?.shaft || color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={isPreview}
                    opacity={opacity}
                    raycast={nullRaycast}
                    enablePicking={!isPreview}
                />
            </React.Fragment>
        );
    });

    // --- Material props for preview ---
    const materialProps = isPreview ? {
        transparent: true,
        opacity: opacity,
        depthWrite: false,
    } : {};

    // --- Calculate Angle for Display ---
    let displayAngle: number | undefined = data.angle;
    if (displayAngle === undefined && data.contactCone) {
        const normal = new THREE.Vector3(
            data.contactCone.normal.x,
            data.contactCone.normal.y,
            data.contactCone.normal.z
        );
        const up = new THREE.Vector3(0, 0, 1);
        displayAngle = normal.angleTo(up) * (180 / Math.PI);
    }

    return (
        <group onClick={handleClick}>
            {/* Debug Angle Text */}
            {isPreview && showPreviewAngleLabel && displayAngle !== undefined && data.contactCone && (
                <Html
                    position={[data.contactCone.pos.x + 0.75, data.contactCone.pos.y, data.contactCone.pos.z + 0.75]}
                    center
                    style={{
                        color: 'white',
                        fontSize: '12px',
                        textShadow: '1px 1px 2px black',
                        fontFamily: 'sans-serif',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap'
                    }}
                >
                    {Math.round(displayAngle)}°
                </Html>
            )}

            {/* Roots (if present) */}
            {data.roots && !hidePlateContactPrimitives && (
                <RootsRenderer
                    root={data.roots}
                    shaftDiameter={shaftDiameter}
                    color={color}
                    diskColor={anatomyOverrides?.rootsDisk || anatomyOverrides?.roots}
                    coneColor={anatomyOverrides?.rootsCone || anatomyOverrides?.roots}
                    diskMaterialOverride={rootsDiskMaterialOverride}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={isPreview}
                    opacity={opacity}
                    raycast={nullRaycast}
                    raftOverride={raftOverride}
                />
            )}

            {/* Segments */}
            {renderedSegments}

            {/* Joints */}
            {/* Joints */}
            {Array.from(uniqueJoints.values()).map((joint) => {
                const isSocketJoint = data.contactCone?.socketJointId === joint.id;
                // Only highlight if it's NOT the socket joint (when using the highlightJoints override)
                // Real selection (isSelected) should probably still apply if the parent is selected? 
                // Actually, isParentSelected usually means "all joints are editable". 
                // Use logic: Normal Selection OR (Highlight Requested AND Not Socket)
                const shouldHighlight = isSelected || (highlightJoints && !isSocketJoint);

                return (
                    <JointRenderer
                        key={joint.id}
                        joint={{
                            id: joint.id,
                            pos: joint.pos,
                            diameter: joint.diameter,
                        }}
                        color={anatomyOverrides?.joint || color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        onSelect={handleJointSelect}
                        transparent={isPreview}
                        opacity={opacity}
                        raycast={nullRaycast}
                        enablePicking={!isPreview}
                        isParentSelected={shouldHighlight}
                    />
                );
            })}

            {/* Knot (if present) */}
            {data.knot && (
                <KnotRenderer
                    knot={data.knot}
                    color={anatomyOverrides?.joint || color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={isPreview}
                    opacity={opacity}
                    raycast={nullRaycast}
                    enablePicking={!isPreview}
                />
            )}

            {/* Contact Disks (if present) */}
            {data.contactDisks && (
                data.contactDisks.map((disk) => (
                    <ContactDiskRenderer
                        key={disk.id}
                        pos={disk.pos}
                        normal={disk.surfaceNormal}
                        coneAxis={disk.coneAxis}
                        profile={disk.profile}
                        contactDiameterMm={disk.contactDiameterMm}
                        overrideThickness={disk.diskLengthOverride}
                        color={anatomyOverrides?.tipDisk || color}
                        transparent={isPreview}
                        opacity={opacity}
                        raycast={nullRaycast}
                    />
                ))
            )}

            {/* Contact Cones (if present) */}
            {data.contactCones ? (
                data.contactCones.map((cone) => (
                    <ContactConeRenderer
                        key={cone.id}
                        pos={cone.pos}
                        normal={cone.normal}
                        surfaceNormal={cone.surfaceNormal}
                        diskLengthOverride={cone.diskLengthOverride}
                        profile={cone.profile}
                        color={color}
                        diskColor={anatomyOverrides?.tipDisk}
                        bodyColor={anatomyOverrides?.tipBody}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={isPreview}
                        opacity={opacity}
                        raycast={nullRaycast}
                    />
                ))
            ) : (
                data.contactCone && (
                    <ContactConeRenderer
                        pos={data.contactCone.pos}
                        normal={data.contactCone.normal}
                        surfaceNormal={data.contactCone.surfaceNormal}
                        diskLengthOverride={data.contactCone.diskLengthOverride}
                        profile={data.contactCone.profile}
                        color={color}
                        diskColor={anatomyOverrides?.tipDisk}
                        bodyColor={anatomyOverrides?.tipBody}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={isPreview}
                        opacity={opacity}
                        raycast={nullRaycast}
                    />
                )
            )}
        </group>
    );
}
