import React, { useMemo } from 'react';
import { usePicking } from '@/components/picking';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';
import { getContactDiskGeometrySpec } from './contactDiskUtils';
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
    penetrationMm?: number;     // Explicit override; defaults to profile.penetrationMm
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
    penetrationMm,
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
    
    // Single-source disk solid spec (thickness, penetration, center, tip) —
    // see getContactDiskGeometrySpec. Uses overrideThickness if provided (from
    // collision logic). Penetration defaults to profile.penetrationMm when the
    // prop is not passed, so every caller gets the universal embed behavior.
    const spec = useMemo(() => getContactDiskGeometrySpec({
        pos,
        surfaceNormal: normal,
        coneAxis,
        profile,
        contactDiameterMm,
        penetrationMm,
        overrideThickness,
    }), [pos, normal, coneAxis, profile, contactDiameterMm, penetrationMm, overrideThickness]);

    const { radius, height, center, rotation } = spec;

    // Layout (local Y along the surface normal, group centered on the cylinder):
    // - Cylinder spans ±height/2: from (surface - penetration) up to the tip center.
    // - Model surface sits at local Y = -(thickness - penetration) / 2.
    // - Tip Center (round cap, cone side) sits at local Y = +height / 2.

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
                <group position={[0, -(spec.thickness - spec.penetrationMm) / 2, 0]}>
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
            <mesh raycast={raycast} onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
                {/*
                  The cylinder extends into the model without moving the cone-side
                  connection: spec.height already includes the penetration depth and
                  spec.center is penetration-aware, so the tip center stays fixed.
                */}
                <cylinderGeometry args={[radius, radius, height, radialSegments]} />
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
            <mesh position={[0, height / 2, 0]} raycast={raycast} onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
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
