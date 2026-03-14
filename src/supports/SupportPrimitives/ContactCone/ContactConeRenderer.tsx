import React, { useMemo, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../../types';
import { SupportTipProfile, DEFAULT_TIP_PROFILE } from './types';
import { getConeCenterPosition, getConeQuaternion, getSocketPosition } from './contactConeUtils';
import { getJointRadius } from '../../constants';
import { subscribe, getSnapshot } from '../../state';
import { handleContactDiskClick } from '../../interaction/clickHandlers';

// Primitives
import { ContactDiskRenderer, calculateDiskThickness } from '../ContactDisk';
import { JointRenderer } from '../Joint/JointRenderer';

interface ContactConeRendererProps {
    contactDiskId?: string;
    pos: Vec3;                          // Contact point on model
    normal: Vec3;                       // Cone axis (points into model)
    surfaceNormal?: Vec3;               // Actual surface normal (for disk alignment)
    diskLengthOverride?: number;        // Explicit thickness from collision logic
    profile?: SupportTipProfile;        // Cone dimensions
    color?: string;
    diskColor?: string;                 // Explicit override for disk
    bodyColor?: string;                 // Explicit override for body
    emissive?: string;
    emissiveIntensity?: number;
    jointColor?: string;                // Socket joint color (defaults to grey)
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
    radialSegments?: number;
    sphereSegments?: number;

    // Joint Interaction Props
    socketJointId?: string;
    isInteractable?: boolean;
    isParentSelected?: boolean;
    onDiskHudHoverChange?: (hovered: boolean) => void;
    onDiskHudPointerDown?: (e: any) => void;
    onDiskHudPointerUp?: (e: any) => void;
}

/**
 * ContactConeRenderer: Renders the terminal contact cone piece with socket joint.
 * 
 * Structure (per Contact-Cone.md spec):
 * - Contact Primitive (Disk/Sphere): Touches model.
 * - Cone body: Truncated cone from Primitive to Socket.
 * - Socket joint: Spherical joint at socket side (connects to shaft).
 */
export function ContactConeRenderer({
    contactDiskId,
    pos,
    normal,
    surfaceNormal,
    diskLengthOverride,
    profile = DEFAULT_TIP_PROFILE,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    jointColor = '#888888',
    transparent = false,
    opacity = 1,
    raycast,
    radialSegments = 24,
    sphereSegments = 24,
    socketJointId,
    isInteractable = true,
    isParentSelected = false,
    diskColor,
    bodyColor,
    onDiskHudHoverChange,
    onDiskHudPointerDown,
    onDiskHudPointerUp
}: ContactConeRendererProps) {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const contactRadius = profile.contactDiameterMm / 2;
    const bodyRadius = profile.bodyDiameterMm / 2;
    const length = profile.lengthMm;
    const penetrationMm = profile.penetrationMm ?? 0;

    // Resolve accurate colors logic
    const finalDiskColor = diskColor || color;
    const isSelected = !!contactDiskId && state.selectedId === contactDiskId;
    const finalBodyColor = bodyColor || (isSelected ? '#c11f61' : color);

    // Fallback: If no surfaceNormal provided, assume it aligns with cone axis
    const effectiveSurfaceNormal = surfaceNormal || normal;

    // --- 1. Determine Primitive Offset ---
    // If we are using a Disk, the cone body must start *behind* the disk.
    const primitiveThickness = useMemo(() => {
        if (profile.type === 'disk') {
            if (diskLengthOverride !== undefined) {
                return diskLengthOverride;
            }
            return calculateDiskThickness(effectiveSurfaceNormal, normal, profile);
        }
        return 0; // No offset for legacy/undefined
    }, [normal, effectiveSurfaceNormal, profile, diskLengthOverride]);

    // --- 2. Calculate Geometry Positions ---

    // Effective Start Position for the Cone Body
    // It starts at: pos + (normal * primitiveThickness)
    // Note: 'normal' here is the Cone Axis. We push along the Cone Axis.
    // Wait, if the disk is extended, do we push along Surface Normal or Cone Axis?
    // The disk extends along the SURFACE NORMAL.
    // So the cone start position is: pos + (surfaceNormal * primitiveThickness)
    // But the cone connects to the BACK of the disk.
    // If the disk is a cylinder along surfaceNormal, its back face center is at pos + surfaceNormal * thickness.

    const coneStartPos = useMemo(() => {
        return {
            x: pos.x + effectiveSurfaceNormal.x * primitiveThickness,
            y: pos.y + effectiveSurfaceNormal.y * primitiveThickness,
            z: pos.z + effectiveSurfaceNormal.z * primitiveThickness,
        };
    }, [pos, effectiveSurfaceNormal, primitiveThickness]);

    // Calculate cone center (based on shifted start position)
    const center = getConeCenterPosition(coneStartPos, normal, profile);
    const quaternion = getConeQuaternion(normal);
    const handleConeClick = (e: any) => {
        if (!contactDiskId) return;
        handleContactDiskClick(e, contactDiskId, isInteractable, isParentSelected, isSelected);
    };

    // Socket joint position (at the large end of the cone)
    // const socketPos = getSocketPosition(coneStartPos, normal, profile);

    // Joint uses centralized sizing (body diameter + offset)
    // const jointRadius = getJointRadius(profile.bodyDiameterMm);

    return (
        <group>
            {/* --- Contact Primitive (Disk) --- */}
            {profile.type === 'disk' && (
                <ContactDiskRenderer
                    id={contactDiskId}
                    pos={pos}
                    normal={effectiveSurfaceNormal} // Must use Surface Normal!
                    coneAxis={normal}               // The direction of the cone
                    profile={profile}
                    contactDiameterMm={profile.contactDiameterMm}
                    overrideThickness={diskLengthOverride} // Pass the collision override!
                    penetrationMm={penetrationMm}
                    color={finalDiskColor}
                    transparent={transparent}
                    opacity={opacity}
                    radialSegments={radialSegments}
                    sphereSegments={sphereSegments}
                    raycast={raycast}
                    isInteractable={isInteractable}
                    isParentSelected={isParentSelected}
                    onHudHoverChange={onDiskHudHoverChange}
                    onHudPointerDown={onDiskHudPointerDown}
                    onHudPointerUp={onDiskHudPointerUp}
                />
            )}

            {/* --- Cone Body --- */}
            <group
                position={[center.x, center.y, center.z]}
                quaternion={quaternion}
            >
                <mesh raycast={raycast} onClick={handleConeClick}>
                    {/* CylinderGeometry: radiusTop, radiusBottom, height, radialSegments */}
                    {/* Top = contact (small), Bottom = socket (large) in Y-up space */}
                    {/* After rotation, "top" faces the model */}
                    <cylinderGeometry args={[contactRadius, bodyRadius, length, radialSegments]} />
                    <meshStandardMaterial
                        color={finalBodyColor}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                    />
                </mesh>
            </group>

            {/* --- Cone Tip Sphere (The Ball Joint at the Disk) --- */}
            {/* Renders at coneStartPos, size = contactRadius */}
            <group position={[coneStartPos.x, coneStartPos.y, coneStartPos.z]}>
                <mesh raycast={raycast} onClick={handleConeClick}>
                    <sphereGeometry args={[contactRadius, sphereSegments, Math.max(6, Math.floor(sphereSegments * 0.75))]} />
                    <meshStandardMaterial
                        color={finalBodyColor}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                    />
                </mesh>
            </group>
        </group>
    );
}
