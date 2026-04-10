import React, { useMemo } from 'react';
import * as THREE from 'three';
import { usePicking } from '@/components/picking';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';
import { calculateDiskThickness, getDiskCenter, getDiskRotation } from './contactDiskUtils';
import { ContactDiskHud } from './ContactDiskHud';
import { handleContactDiskClick } from '../../interaction/clickHandlers';
import { setContactDiskHudDraggingActive, setContactDiskHudHoverActive, setContactDiskHudInteractionTarget, setContactDiskHudPointerCaptureActive } from './contactDiskHudInteraction';
import { setHoveredState } from '../../state';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';

interface ContactDiskRendererProps {
    id?: string;
    pos: Vec3;
    normal: Vec3;           // Surface Normal
    coneAxis: Vec3;         // Cone Axis (Direction of support)
    profile: ContactDiskProfile;
    contactDiameterMm: number;
    overrideThickness?: number; // Explicit thickness from collision logic
    penetrationMm?: number;
    color?: string;
    transparent?: boolean;
    opacity?: number;
    radialSegments?: number;
    sphereSegments?: number;
    raycast?: any;
    isInteractable?: boolean;
    isParentSelected?: boolean;
    isContactDiskSelected?: boolean;
    onHudHoverChange?: (hovered: boolean) => void;
    onHudPointerDown?: (e: any) => void;
    onHudPointerUp?: (e: any) => void;
}

export function ContactDiskRenderer({
    id,
    pos,
    normal,
    coneAxis,
    profile,
    contactDiameterMm,
    overrideThickness,
    penetrationMm = 0,
    color = '#ff8800',
    transparent = false,
    opacity = 1,
    radialSegments = 24,
    sphereSegments = 24,
    raycast,
    isInteractable = true,
    isParentSelected = false,
    isContactDiskSelected = false,
    onHudHoverChange,
    onHudPointerDown,
    onHudPointerUp,
}: ContactDiskRendererProps) {
    const groupRef = React.useRef<any>(null);
    const pickIdRef = React.useRef<number | null>(null);
    const [isHovered, setIsHovered] = React.useState(false);
    const { register, unregister } = usePicking();
    
    // Calculate geometry based on angle between Surface Normal and Cone Axis
    // Use overrideThickness if provided (from collision logic)
    const thickness = useMemo(() => {
        if (overrideThickness !== undefined) return overrideThickness;
        return calculateDiskThickness(normal, coneAxis, profile);
    }, [normal, coneAxis, profile, overrideThickness]);
    
    const center = useMemo(() => getDiskCenter(pos, normal, thickness), [pos, normal, thickness]);
    const rotation = useMemo(() => getDiskRotation(normal), [normal]);

    const radius = contactDiameterMm / 2;

    // We want a Flat Base (Model Side) and a Round Tip (Cone Side).
    // We also want Center-to-Center alignment:
    // The Center of the Tip Sphere should be at 'thickness' distance from surface.
    // The Cylinder Shaft should go from Surface (0) to Tip Center (thickness).
    
    // Our Group is centered at 'thickness / 2' (by getDiskCenter).
    // Local Y=0 is at Global 'thickness / 2'.
    // Surface is at Local Y = -thickness / 2.
    // Tip Center is at Local Y = +thickness / 2.

    const effectivePenetration = Math.max(0, penetrationMm);
    const hoverVisible = isHovered && isInteractable && isParentSelected;
    const displayColor = isContactDiskSelected ? '#c11f61' : color;
    const displayEmissive = hoverVisible ? '#efd8c2' : '#000000';
    const displayEmissiveIntensity = hoverVisible ? 0.16 : 0;

    const handleClick = (e: any) => {
        if (!id) return;
        handleContactDiskClick(e, id, isInteractable, isParentSelected, isContactDiskSelected);
    };

    const handlePointerMove = React.useCallback((e: any) => {
        if (!id || !isInteractable || (!isParentSelected && !isContactDiskSelected)) {
            setIsHovered(false);
            return;
        }

        if (isSupportEditInteractionActive()) {
            emitImmediateModelHover(null);
            setHoveredState('none', null);
            setIsHovered(false);
            return;
        }

        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            emitImmediateModelHover(frontModelId);
            setHoveredState('none', null);
            setIsHovered(false);
            return;
        }

        emitImmediateModelHover(null);
        setHoveredState('contactDisk', id);
        setIsHovered(true);
    }, [id, isInteractable, isParentSelected, isContactDiskSelected]);

    const handlePointerOut = React.useCallback(() => {
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

    const handleHudHoverChange = React.useCallback((hovered: boolean) => {
        setContactDiskHudHoverActive(hovered);
        if (onHudHoverChange) onHudHoverChange(hovered);
    }, [onHudHoverChange]);

    const handleHudDragStateChange = React.useCallback((dragging: boolean) => {
        setContactDiskHudDraggingActive(dragging);
    }, []);

    const handleHudPointerDown = React.useCallback((e: any) => {
        setContactDiskHudPointerCaptureActive(true);
        if (onHudPointerDown) onHudPointerDown(e);
    }, [onHudPointerDown]);

    const handleHudPointerUp = React.useCallback((e: any) => {
        setContactDiskHudPointerCaptureActive(false);
        if (onHudPointerUp) onHudPointerUp(e);
    }, [onHudPointerUp]);

    React.useEffect(() => {
        if (!isContactDiskSelected || !id) return;
        setContactDiskHudInteractionTarget(id);
        return () => {
            setContactDiskHudPointerCaptureActive(false);
            setContactDiskHudDraggingActive(false);
            setContactDiskHudHoverActive(false);
            setContactDiskHudInteractionTarget(null);
        };
    }, [id, isContactDiskSelected]);

    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const clearPointerCapture = () => {
            setContactDiskHudPointerCaptureActive(false);
        };
        window.addEventListener('pointerup', clearPointerCapture, true);
        window.addEventListener('pointercancel', clearPointerCapture, true);
        window.addEventListener('blur', clearPointerCapture);
        return () => {
            window.removeEventListener('pointerup', clearPointerCapture, true);
            window.removeEventListener('pointercancel', clearPointerCapture, true);
            window.removeEventListener('blur', clearPointerCapture);
        };
    }, []);

    React.useEffect(() => {
        const canPick = !!groupRef.current && !!id && isInteractable && (isParentSelected || isContactDiskSelected);
        if (!canPick) {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
            return;
        }

        pickIdRef.current = register({
            category: 'contactDisk',
            objectId: id,
            object: groupRef.current,
        });

        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, id, isInteractable, isParentSelected, isContactDiskSelected]);

    return (
        <group ref={groupRef} position={[center.x, center.y, center.z]} quaternion={rotation}>
            {isContactDiskSelected ? (
                <group position={[0, -thickness / 2, 0]}>
                    <ContactDiskHud
                        radius={radius}
                        color="#ffffff"
                        isInteractable={true}
                        onHoverChange={handleHudHoverChange}
                        onDragStateChange={handleHudDragStateChange}
                        onPointerDown={handleHudPointerDown}
                        onPointerUp={handleHudPointerUp}
                    />
                </group>
            ) : null}
            <mesh position={[0, -effectivePenetration / 2, 0]} raycast={raycast} onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
                {/*
                  Extend the disk into the model without moving the cone-side connection.
                  We keep the cone-side "top" aligned by:
                  - increasing height by penetration
                  - shifting the cylinder down by penetration/2
                */}
                <cylinderGeometry args={[radius, radius, thickness + effectivePenetration, radialSegments]} />
                <meshStandardMaterial
                    color={displayColor}
                    emissive={displayEmissive}
                    emissiveIntensity={displayEmissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    polygonOffset
                    polygonOffsetFactor={1}
                    polygonOffsetUnits={1}
                />
            </mesh>

            {/* Round Tip: stays exactly where it was (cone side alignment) */}
            <mesh position={[0, thickness / 2, 0]} raycast={raycast} onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
                <sphereGeometry args={[radius, sphereSegments, Math.max(6, Math.floor(sphereSegments * 0.75))]} />
                <meshStandardMaterial
                    color={displayColor}
                    emissive={displayEmissive}
                    emissiveIntensity={displayEmissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    polygonOffset
                    polygonOffsetFactor={1}
                    polygonOffsetUnits={1}
                />
            </mesh>
        </group>
    );
}
