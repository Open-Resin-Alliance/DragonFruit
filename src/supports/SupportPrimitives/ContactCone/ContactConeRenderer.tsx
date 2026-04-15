import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import { usePicking } from '@/components/picking';
import { Vec3 } from '../../types';
import { SupportTipProfile, DEFAULT_TIP_PROFILE } from './types';
import { getConeCenterPosition, getConeQuaternion } from './contactConeUtils';
import { handleContactDiskClick } from '../../interaction/clickHandlers';
import { setHoveredState } from '../../state';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';
import { useJointDragPosition } from '../../interaction/jointDragPosition';

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
    const liveSocketJointPos = useJointDragPosition(socketJointId ?? '');
    const contactRadius = profile.contactDiameterMm / 2;
    const bodyRadius = profile.bodyDiameterMm / 2;
    const penetrationMm = profile.penetrationMm ?? 0;
    const [isHovered, setIsHovered] = useState(false);
    const hoverVisible = isHovered && isInteractable && isParentSelected;

    // Resolve accurate colors logic
    const finalDiskColor = diskColor || color;
    const finalBodyColor = bodyColor || (isContactDiskSelected ? '#c11f61' : color);

    // Fallback: If no surfaceNormal provided, assume it aligns with cone axis
    const effectiveSurfaceNormal = surfaceNormal || normal;

    const renderGeometry = useMemo(() => {
        let renderNormal = { ...normal };
        let renderThickness = 0;
        let renderLength = profile.lengthMm;

        if (profile.type === 'disk') {
            renderThickness = diskLengthOverride !== undefined
                ? diskLengthOverride
                : calculateDiskThickness(effectiveSurfaceNormal, renderNormal, profile);
        }

        // While dragging the socket joint, solve against the *live* joint position so
        // the cone socket stays visually pinned to the joint center in the same frame.
        if (liveSocketJointPos) {
            const contactPos = new THREE.Vector3(pos.x, pos.y, pos.z);
            const socketPos = new THREE.Vector3(liveSocketJointPos.x, liveSocketJointPos.y, liveSocketJointPos.z);
            const surfaceNormalVec = new THREE.Vector3(
                effectiveSurfaceNormal.x,
                effectiveSurfaceNormal.y,
                effectiveSurfaceNormal.z,
            );
            if (surfaceNormalVec.lengthSq() < 0.000001) surfaceNormalVec.set(0, 0, 1);
            surfaceNormalVec.normalize();

            let axis = new THREE.Vector3(renderNormal.x, renderNormal.y, renderNormal.z);
            if (axis.lengthSq() < 0.000001) {
                axis.copy(socketPos).sub(contactPos);
            }
            if (axis.lengthSq() < 0.000001) axis.set(0, 0, 1);
            axis.normalize();

            for (let i = 0; i < 4; i += 1) {
                const thickness = profile.type === 'disk'
                    ? (diskLengthOverride !== undefined
                        ? diskLengthOverride
                        : calculateDiskThickness(
                            { x: surfaceNormalVec.x, y: surfaceNormalVec.y, z: surfaceNormalVec.z },
                            { x: axis.x, y: axis.y, z: axis.z },
                            profile,
                        ))
                    : 0;

                const startPos = contactPos.clone().add(surfaceNormalVec.clone().multiplyScalar(thickness));
                const coneVec = socketPos.clone().sub(startPos);
                const len = coneVec.length();
                renderThickness = thickness;
                if (len > 0.0001) {
                    axis.copy(coneVec).normalize();
                    renderLength = Math.max(0.1, len);
                }
            }

            renderNormal = { x: axis.x, y: axis.y, z: axis.z };
        }

        const coneStartPos = {
            x: pos.x + effectiveSurfaceNormal.x * renderThickness,
            y: pos.y + effectiveSurfaceNormal.y * renderThickness,
            z: pos.z + effectiveSurfaceNormal.z * renderThickness,
        };

        const center = {
            x: coneStartPos.x + renderNormal.x * (renderLength / 2),
            y: coneStartPos.y + renderNormal.y * (renderLength / 2),
            z: coneStartPos.z + renderNormal.z * (renderLength / 2),
        };

        return {
            primitiveThickness: renderThickness,
            length: renderLength,
            normal: renderNormal,
            coneStartPos,
            center,
            quaternion: getConeQuaternion(renderNormal),
        };
    }, [diskLengthOverride, effectiveSurfaceNormal, liveSocketJointPos, normal, pos, profile]);

    const { primitiveThickness, length, normal: renderNormal, coneStartPos, center, quaternion } = renderGeometry;
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
                    coneAxis={renderNormal}         // The direction of the cone
                    profile={profile}
                    contactDiameterMm={profile.contactDiameterMm}
                    overrideThickness={primitiveThickness} // Live drag keeps disk/socket perfectly aligned
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
