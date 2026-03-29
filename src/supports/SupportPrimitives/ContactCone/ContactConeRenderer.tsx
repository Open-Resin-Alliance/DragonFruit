import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import { usePicking } from '@/components/picking';
import { Vec3 } from '../../types';
import { SupportTipProfile, DEFAULT_TIP_PROFILE } from './types';
import { getConeCenterPosition, getConeQuaternion } from './contactConeUtils';
import { handleContactDiskClick } from '../../interaction/clickHandlers';
import { setHoveredState } from '../../state';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';

// Primitives
import { ContactDiskRenderer, calculateDiskThickness } from '../ContactDisk';
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';

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
    isContactDiskSelected?: boolean;
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
    color = '#c8752a',
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
    onDiskHudPointerUp,
    isContactDiskSelected = false,
}: ContactConeRendererProps) {
    const groupRef = React.useRef<any>(null);
    const pickIdRef = React.useRef<number | null>(null);
    const { register, unregister } = usePicking();
    const contactRadius = profile.contactDiameterMm / 2;
    const bodyRadius = profile.bodyDiameterMm / 2;
    const length = profile.lengthMm;
    const penetrationMm = profile.penetrationMm ?? 0;
    const [isHovered, setIsHovered] = useState(false);
    const hoverVisible = isHovered && isInteractable && isParentSelected;

    // Resolve accurate colors logic
    const finalDiskColor = diskColor || color;
    const finalBodyColor = bodyColor || (isContactDiskSelected ? '#c11f61' : color);

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
    const displayEmissive = hoverVisible ? '#efd8c2' : emissive;
    const displayEmissiveIntensity = hoverVisible ? Math.max(emissiveIntensity, 0.16) : emissiveIntensity;

    const handleConeClick = (e: any) => {
        const intersections = Array.isArray(e?.intersections) ? e.intersections : [];
        for (const intersection of intersections) {
            let current = (intersection as { object?: THREE.Object3D | null })?.object ?? null;
            while (current) {
                const primitiveType = current.userData?.supportPrimitiveType;
                if (primitiveType === 'joint' || primitiveType === 'knot') {
                    return;
                }
                current = current.parent;
            }
        }

        if (!contactDiskId) return;
        handleContactDiskClick(e, contactDiskId, isInteractable, isParentSelected, isContactDiskSelected);
    };

    const handleConePointerMove = React.useCallback((e: any) => {
        if (!contactDiskId || !isInteractable || (!isParentSelected && !isContactDiskSelected)) {
            setIsHovered(false);
            return;
        }

        if (isSupportEditInteractionActive()) {
            emitImmediateModelHover(null);
            setHoveredState('none', null);
            setIsHovered(false);
            return;
        }

        const intersections = Array.isArray(e?.intersections) ? e.intersections : [];
        for (const intersection of intersections) {
            let current = (intersection as { object?: THREE.Object3D | null })?.object ?? null;
            while (current) {
                const primitiveType = current.userData?.supportPrimitiveType;
                if (primitiveType === 'joint' || primitiveType === 'knot') {
                    emitImmediateModelHover(null);
                    setHoveredState('none', null);
                    setIsHovered(false);
                    return;
                }
                current = current.parent;
            }
        }

        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            emitImmediateModelHover(frontModelId);
            setHoveredState('none', null);
            setIsHovered(false);
            return;
        }

        emitImmediateModelHover(null);
        setHoveredState('contactDisk', contactDiskId);
        setIsHovered(true);
    }, [contactDiskId, isInteractable, isParentSelected, isContactDiskSelected]);

    const handleConePointerOut = React.useCallback(() => {
        setIsHovered(false);
        if (!isInteractable || (!isParentSelected && !isContactDiskSelected)) return;

        if (isSupportEditInteractionActive()) {
            emitImmediateModelHover(null);
            setHoveredState('none', null);
            return;
        }

        emitImmediateModelHover(null);
        setHoveredState('none', null);
    }, [isInteractable, isParentSelected, isContactDiskSelected]);

    React.useEffect(() => {
        const canPick = !!groupRef.current && !!contactDiskId && isInteractable && (isParentSelected || isContactDiskSelected);
        if (!canPick) {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
            return;
        }

        pickIdRef.current = register({
            category: 'contactDisk',
            objectId: contactDiskId,
            object: groupRef.current,
        });

        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, contactDiskId, isInteractable, isParentSelected, isContactDiskSelected]);

    // Socket joint position (at the large end of the cone)
    // const socketPos = getSocketPosition(coneStartPos, normal, profile);

    // Joint uses centralized sizing (body diameter + offset)
    // const jointRadius = getJointRadius(profile.bodyDiameterMm);

    return (
        <group ref={groupRef}>
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
                    isContactDiskSelected={isContactDiskSelected}
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
                <mesh raycast={raycast} onClick={handleConeClick} onPointerMove={handleConePointerMove} onPointerOut={handleConePointerOut}>
                    {/* CylinderGeometry: radiusTop, radiusBottom, height, radialSegments */}
                    {/* Top = contact (small), Bottom = socket (large) in Y-up space */}
                    {/* After rotation, "top" faces the model */}
                    <cylinderGeometry args={[contactRadius, bodyRadius, length, radialSegments]} />
                    <meshStandardMaterial
                        color={finalBodyColor}
                        emissive={displayEmissive}
                        emissiveIntensity={displayEmissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                    />
                </mesh>
            </group>

            {/* --- Cone Tip Sphere (The Ball Joint at the Disk) --- */}
            {/* Renders at coneStartPos, size = contactRadius */}
            <group position={[coneStartPos.x, coneStartPos.y, coneStartPos.z]}>
                <mesh raycast={raycast} onClick={handleConeClick} onPointerMove={handleConePointerMove} onPointerOut={handleConePointerOut}>
                    <sphereGeometry args={[contactRadius, sphereSegments, Math.max(6, Math.floor(sphereSegments * 0.75))]} />
                    <meshStandardMaterial
                        color={finalBodyColor}
                        emissive={displayEmissive}
                        emissiveIntensity={displayEmissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                    />
                </mesh>
            </group>
        </group>
    );
}
