import React, { useMemo } from 'react';
import { usePicking } from '@/components/picking';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';
import { type ContactFaceShape, createContactDiskLoftGeometry, getContactDiskGeometrySpec, resolveContactDiskRadialSegments, resolveContactFaceShape } from './contactDiskUtils';
import { commitContactFaceShape } from './contactFaceActions';
import { ContactDiskHud } from './ContactDiskHud';
import { ContactDiskIntersectionOutline } from './ContactDiskIntersectionOutline';
import { ContactFaceGizmo } from './ContactFaceGizmo';
import { handleContactDiskClick } from '../../interaction/clickHandlers';
import { setContactDiskHudDraggingActive, setContactDiskHudHoverActive, setContactDiskHudInteractionTarget, setContactDiskHudPointerCaptureActive } from './contactDiskHudInteraction';
import { setHoveredState } from '../../state';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';

// Gap between the disc edge and the HUD indicator ring.
const CONTACT_DISK_HUD_GAP = 0.18;

interface ContactDiskRendererProps {
    id?: string;
    pos: Vec3;
    normal: Vec3;           // Surface Normal
    coneAxis: Vec3;         // Cone Axis (Direction of support)
    profile: ContactDiskProfile;
    contactDiameterMm: number;
    overrideThickness?: number; // Explicit thickness from collision logic
    penetrationMm?: number;     // Explicit override; defaults to profile.penetrationMm
    contactFaceRatio?: number;   // Oval contact face: squished-axis fraction (1/absent = circle)
    contactFaceAngleRad?: number; // Oval contact face: rotation about the disc normal
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
    contactFaceRatio,
    contactFaceAngleRad,
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

    // Oval contact face (per-disc). Absent fields resolve to a circle.
    const faceShape = useMemo(
        () => resolveContactFaceShape({ contactFaceRatio, contactFaceAngleRad }),
        [contactFaceRatio, contactFaceAngleRad],
    );

    // Live shape while a ContactFaceGizmo handle is dragged (the gizmo
    // commits on release; this is preview-only).
    const [liveFaceShape, setLiveFaceShape] = React.useState<ContactFaceShape | null>(null);
    const effectiveFaceShape = liveFaceShape ?? faceShape;

    // Disk solid: two-stage loft — full oval through the penetration zone
    // (so the drawn oval is exactly what crosses the model skin), blending to
    // a circle across the standoff thickness. ratio 1 === plain cylinder.
    const diskGeometry = useMemo(() => createContactDiskLoftGeometry({
        radius,
        ratio: effectiveFaceShape.ratio,
        thickness: spec.thickness,
        penetrationMm: spec.penetrationMm,
        // Ovals always render fine-walled (24, or 12 in low-detail mode);
        // untouched circles keep the caller's base tessellation.
        radialSegments: resolveContactDiskRadialSegments(radialSegments, effectiveFaceShape.ratio),
    }), [radius, effectiveFaceShape.ratio, spec.thickness, spec.penetrationMm, radialSegments]);

    React.useEffect(() => () => diskGeometry.dispose(), [diskGeometry]);

    // Layout (local Y along the surface normal, group centered on the cylinder):
    // - Cylinder spans ±height/2: from (surface - penetration) up to the tip center.
    // - Model surface sits at local Y = -(thickness - penetration) / 2.
    // - Tip Center (round cap, cone side) sits at local Y = +height / 2. The
    //   ball is as wide as the contact face, so calculateDiskThickness floors
    //   the standoff at (contact radius + clearance) to keep it off the model.

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

    // Double-click the HUD ring/fill: reset to a perfect circle (orientation
    // kept so re-squishing resumes where the user left off).
    const handleFaceResetDoubleClick = React.useCallback(() => {
        if (!id) return;
        commitContactFaceShape(id, 1, faceShape.angleRad);
    }, [id, faceShape.angleRad]);

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
        <>
        {isContactDiskSelected && id ? (
            // World-space sibling of the disc group: the gizmo manages its own
            // position/orientation (screen-space constant size). Anchored on
            // the surface contact point; ring about the disc normal rotates
            // the oval, the scale cube along the squished axis sets the ratio.
            <ContactFaceGizmo
                contactId={id}
                center={pos}
                quaternion={rotation}
                faceShape={faceShape}
                liveShape={liveFaceShape}
                onLiveShapeChange={setLiveFaceShape}
            />
        ) : null}
        {isContactDiskSelected ? (
            // Surface-accurate border: traces the exact disc/model
            // intersection curve (world space, follows model curvature),
            // live-updating with the gizmo preview shape.
            <ContactDiskIntersectionOutline
                pos={pos}
                quaternion={rotation}
                radius={radius}
                ratio={effectiveFaceShape.ratio}
                angleRad={effectiveFaceShape.angleRad}
                thickness={spec.thickness}
                penetrationMm={spec.penetrationMm}
            />
        ) : null}
        <group ref={groupRef} position={[center.x, center.y, center.z]} quaternion={rotation}>
            {isContactDiskSelected ? (
                <group position={[0, -(spec.thickness - spec.penetrationMm) / 2, 0]}>
                    <ContactDiskHud
                        radius={radius}
                        gap={CONTACT_DISK_HUD_GAP}
                        color="#ffffff"
                        isInteractable={true}
                        faceRatio={effectiveFaceShape.ratio}
                        faceAngleRad={effectiveFaceShape.angleRad}
                        // Test: stroke ring hidden while evaluating the
                        // surface-accurate intersection outline as the primary
                        // shape indicator. Flip back to true to restore.
                        showRing={false}
                        onRingDoubleClick={handleFaceResetDoubleClick}
                        onHoverChange={handleHudHoverChange}
                        onDragStateChange={handleHudDragStateChange}
                        onPointerDown={handleHudPointerDown}
                        onPointerUp={handleHudPointerUp}
                    />
                </group>
            ) : null}
            {/*
              The loft extends into the model without moving the cone-side
              connection: its height already includes the penetration depth and
              spec.center is penetration-aware, so the tip center stays fixed.
              The oval orientation rotates about local Y (the disc normal).
            */}
            <mesh geometry={diskGeometry} rotation={[0, effectiveFaceShape.angleRad, 0]} raycast={raycast} onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
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
        </>
    );
}
