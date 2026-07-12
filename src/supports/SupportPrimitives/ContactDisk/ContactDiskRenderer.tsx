import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';
import { CONTACT_FACE_MIN_RATIO, createContactDiskLoftGeometry, getContactDiskGeometrySpec, resolveContactDiskRadialSegments, resolveContactFaceShape } from './contactDiskUtils';
import { commitContactFaceShape } from './contactFaceActions';
import { isPrimaryPointerPress } from './contactDiskDragController';
import { ContactDiskHud } from './ContactDiskHud';
import { handleContactDiskClick } from '../../interaction/clickHandlers';
import { setContactDiskHudDraggingActive, setContactDiskHudHoverActive, setContactDiskHudInteractionTarget, setContactDiskHudPointerCaptureActive } from './contactDiskHudInteraction';
import { setHoveredState } from '../../state';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';

// Must match ContactDiskHud's default gap — the reshape drag math maps the
// ring radius (disc radius + gap) to squish ratio 1.0.
const CONTACT_DISK_HUD_GAP = 0.18;

// 15° angle snapping while Shift is held during a reshape drag.
const RESHAPE_ANGLE_SNAP_RAD = Math.PI / 12;

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
    const { camera, gl } = useThree();
    
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

    // Live shape while the reshape handle is being dragged (committed on release).
    const [liveFaceShape, setLiveFaceShape] = React.useState<{ ratio: number; angleRad: number } | null>(null);
    const liveFaceShapeRef = React.useRef<{ ratio: number; angleRad: number } | null>(null);
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

    // --- Oval contact-face reshape drag (the HUD "squish knob") ---
    // Fully self-contained: polar drag in the disc plane, live preview via
    // local state, committed by id through commitContactFaceShape (which
    // resolves the owning support and records one undo entry).
    const handleReshapePointerDown = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        // Not gated on isInteractable: HUD hover suppresses support-wide
        // interactivity by design, but the HUD (and its knob) exempt themselves.
        if (!id) return;
        if (!isPrimaryPointerPress(e)) return;

        setContactDiskHudPointerCaptureActive(true);
        setContactDiskHudDraggingActive(true);
        document.body.style.cursor = 'grabbing';

        // Drag math lives in the disc plane (through the contact point,
        // perpendicular to the surface normal): distance from center maps to
        // squish ratio, azimuth maps to the oval angle.
        const origin = new THREE.Vector3(pos.x, pos.y, pos.z);
        const planeNormal = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, origin);
        const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
        const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const hit = new THREE.Vector3();
        const ringInnerRadius = radius + CONTACT_DISK_HUD_GAP;
        const startShape = liveFaceShapeRef.current ?? faceShape;

        const pointerPolar = (ev: PointerEvent): { d: number; angle: number } | null => {
            const rect = gl.domElement.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            ndc.set(
                ((ev.clientX - rect.left) / rect.width) * 2 - 1,
                -((ev.clientY - rect.top) / rect.height) * 2 + 1,
            );
            raycaster.setFromCamera(ndc, camera);
            if (!raycaster.ray.intersectPlane(plane, hit)) return null;
            hit.sub(origin);
            const lx = hit.dot(xAxis);
            const lz = hit.dot(zAxis);
            const d = Math.hypot(lx, lz);
            // The loft's squished axis (local X rotated by angle about Y)
            // points along (cos a, -sin a) in the disc plane → a = atan2(-z, x).
            return { d, angle: d > 1e-6 ? Math.atan2(-lz, lx) : startShape.angleRad };
        };

        // Polar grab offset: the shape follows the handle, not the raw cursor,
        // so grabbing the knob off-center doesn't jump the oval.
        const startPointer = pointerPolar(e.nativeEvent);
        const offsetD = startPointer ? ringInnerRadius * startShape.ratio - startPointer.d : 0;
        const offsetAngle = startPointer ? startShape.angleRad - startPointer.angle : 0;

        let latest = { ...startShape };
        let moved = false;
        let rafId: number | null = null;
        let pending: PointerEvent | null = null;

        const sample = (ev: PointerEvent) => {
            const polar = pointerPolar(ev);
            if (!polar) return;
            const ratio = Math.min(1, Math.max(CONTACT_FACE_MIN_RATIO, (polar.d + offsetD) / ringInnerRadius));
            let angleRad = polar.angle + offsetAngle;
            if (ev.shiftKey) angleRad = Math.round(angleRad / RESHAPE_ANGLE_SNAP_RAD) * RESHAPE_ANGLE_SNAP_RAD;
            if (Math.abs(ratio - latest.ratio) < 1e-4 && Math.abs(angleRad - latest.angleRad) < 1e-4) return;
            latest = { ratio, angleRad };
            moved = true;
            liveFaceShapeRef.current = latest;
            setLiveFaceShape(latest);
        };

        const onMove = (ev: PointerEvent) => {
            pending = ev;
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (pending) sample(pending);
                pending = null;
            });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
            if (rafId !== null) cancelAnimationFrame(rafId);
            document.body.style.cursor = '';
            setContactDiskHudPointerCaptureActive(false);
            setContactDiskHudDraggingActive(false);
            if (moved) commitContactFaceShape(id, latest.ratio, latest.angleRad);
            liveFaceShapeRef.current = null;
            setLiveFaceShape(null);
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
    }, [id, pos, normal, rotation, radius, faceShape, camera, gl]);

    // Double-click the knob: reset to a perfect circle (orientation kept so
    // re-squishing resumes where the user left off).
    const handleReshapeDoubleClick = React.useCallback(() => {
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
                        reshapeHandle={id ? (() => {
                            // NOTE: deliberately NOT gated on isInteractable —
                            // hovering the HUD sets contactDiskHudHoverActive,
                            // which flips the support-wide isInteractable false
                            // (SupportRenderer suppression). The HUD exempts
                            // itself from that suppression; the knob must too,
                            // or it unmounts the moment the ring is hovered.
                            // Handle sits along the oval's squished axis; its
                            // distance from center encodes the ratio (on the
                            // ring = circle, pulled inward = squished).
                            // HUD-local mapping: (x, y) ↔ disc-plane (x, z)
                            // with the squished axis at (cos a, -sin a).
                            const d = (radius + CONTACT_DISK_HUD_GAP) * effectiveFaceShape.ratio;
                            return {
                                x: d * Math.cos(effectiveFaceShape.angleRad),
                                y: -d * Math.sin(effectiveFaceShape.angleRad),
                                onPointerDown: handleReshapePointerDown,
                                onDoubleClick: handleReshapeDoubleClick,
                            };
                        })() : undefined}
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
    );
}
