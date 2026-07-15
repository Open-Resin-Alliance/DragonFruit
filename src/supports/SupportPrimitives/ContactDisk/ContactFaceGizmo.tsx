"use client";

import React from 'react';
import * as THREE from 'three';

import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import type { GizmoAxis } from '@/components/gizmo/types';
import { CONTACT_FACE_MIN_RATIO, CONTACT_FACE_MAX_RATIO, type ContactFaceShape } from './contactDiskUtils';
import { commitContactFaceShape } from './contactFaceActions';
import { setContactDiskHudDraggingActive } from './contactDiskHudInteraction';

const LOCAL_Y = new THREE.Vector3(0, 1, 0);

// The squished axis sits at (cos a, 0, -sin a) in disc-local coordinates —
// exactly R_y(+a)·X̂, matching the loft mesh's rotation={[0, +a, 0]} — so the
// gizmo frame composes a POSITIVE spin about local Y to put its scale handle
// on that axis (see gizmoEuler below).
//
// Sign relating GizmoRotation's emitted ring deltas to the entity angle
// (their emission convention is camera-side dependent internally; this was
// tuned live). Flip here if ring drags ever run opposite the handle.
const RING_DELTA_SIGN = -1;

declare global {
    interface Window {
        __gizmoDragEndedThisFrame?: boolean;
    }
}

function dispatchRatioReadout(detail: { active: boolean; ratio?: number }) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('dragonfruit:contact-face-ratio', { detail }));
}

export interface ContactFaceGizmoProps {
    contactId: string;
    /** Disc center in world space (the gizmo anchor). */
    center: { x: number; y: number; z: number };
    /** Disc orientation: local +Y is the cone axis / disc normal. */
    quaternion: THREE.Quaternion;
    /** Committed contact-face shape (store state). */
    faceShape: ContactFaceShape;
    /** In-flight shape while a handle is dragged, or null when idle. */
    liveShape: ContactFaceShape | null;
    /** Live-preview sink — the renderer feeds this into the loft + HUD. */
    onLiveShapeChange: (shape: ContactFaceShape | null) => void;
}

/**
 * ContactFaceGizmo — reshapes the oval contact face with the shared transform
 * widget instead of the old combined polar knob.
 *
 * One rotation ring about the disc normal sets the oval angle (constant
 * sensitivity at any squish, Ctrl = 45° / Ctrl+Shift = 15° snapping, live
 * degree readout — all inherited from GizmoRotation). One double-cone stretch
 * handle riding the squished axis sets the ratio (screen-distance factor
 * relative to drag start, clamped to [CONTACT_FACE_MIN_RATIO, 1]).
 *
 * The gizmo frame is the disc frame spun by +angle about local Y so the
 * stretch handle always sits on the oval's squished axis. During a ring
 * stroke the
 * frame is frozen (HolePunchGizmo convention): the ring is symmetric about Y
 * so nothing visibly jumps, the other handle is hidden by the active drag,
 * and the frame snaps to the new angle on release.
 */
export function ContactFaceGizmo({
    contactId,
    center,
    quaternion,
    faceShape,
    liveShape,
    onLiveShapeChange,
}: ContactFaceGizmoProps) {
    const effectiveShape = liveShape ?? faceShape;
    const effectiveShapeRef = React.useRef(effectiveShape);
    effectiveShapeRef.current = effectiveShape;

    // Drag-stroke state. `latest` mirrors the last emitted live shape so the
    // end handlers commit exactly what the user saw.
    const dragRef = React.useRef<{
        start: ContactFaceShape;
        latest: ContactFaceShape;
        accumulatedAngle: number;
        moved: boolean;
    } | null>(null);
    const [frozenEuler, setFrozenEuler] = React.useState<THREE.Euler | null>(null);

    const gizmoEuler = React.useMemo(() => {
        if (frozenEuler) return frozenEuler;
        const spin = new THREE.Quaternion().setFromAxisAngle(LOCAL_Y, effectiveShape.angleRad);
        return new THREE.Euler().setFromQuaternion(quaternion.clone().multiply(spin));
    }, [frozenEuler, quaternion, effectiveShape.angleRad]);

    const beginDrag = React.useCallback(() => {
        const start = { ...effectiveShapeRef.current };
        dragRef.current = { start, latest: start, accumulatedAngle: 0, moved: false };
        setContactDiskHudDraggingActive(true);
    }, []);

    const endDrag = React.useCallback(() => {
        const drag = dragRef.current;
        dragRef.current = null;
        setContactDiskHudDraggingActive(false);
        // Keep the canvas click handler from deselecting the disc on release.
        if (typeof window !== 'undefined') window.__gizmoDragEndedThisFrame = true;
        if (drag?.moved) commitContactFaceShape(contactId, drag.latest.ratio, drag.latest.angleRad);
        onLiveShapeChange(null);
    }, [contactId, onLiveShapeChange]);

    const handleRotateStart = React.useCallback(() => {
        beginDrag();
        // Freeze the frame for the stroke so the ring handle animation is the
        // only thing moving (the frame itself would otherwise counter-rotate).
        const spin = new THREE.Quaternion().setFromAxisAngle(LOCAL_Y, effectiveShapeRef.current.angleRad);
        setFrozenEuler(new THREE.Euler().setFromQuaternion(quaternion.clone().multiply(spin)));
    }, [beginDrag, quaternion]);

    const handleRotate = React.useCallback((_axis: GizmoAxis, angleDelta: number) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.accumulatedAngle += angleDelta;
        // Continuous during the stroke; commitContactFaceShape wraps to [0, π).
        const angleRad = drag.start.angleRad + RING_DELTA_SIGN * drag.accumulatedAngle;
        drag.latest = { ratio: drag.start.ratio, angleRad };
        drag.moved = true;
        onLiveShapeChange(drag.latest);
    }, [onLiveShapeChange]);

    const handleRotateEnd = React.useCallback(() => {
        setFrozenEuler(null);
        endDrag();
    }, [endDrag]);

    const handleScaleStart = React.useCallback(() => {
        beginDrag();
    }, [beginDrag]);

    const handleScale = React.useCallback((_axis: GizmoAxis | 'uniform', factor: number) => {
        const drag = dragRef.current;
        if (!drag) return;
        const ratio = Math.min(
            CONTACT_FACE_MAX_RATIO,
            Math.max(CONTACT_FACE_MIN_RATIO, drag.start.ratio * factor),
        );
        drag.latest = { ratio, angleRad: drag.start.angleRad };
        drag.moved = true;
        onLiveShapeChange(drag.latest);
        dispatchRatioReadout({ active: true, ratio });
    }, [onLiveShapeChange]);

    const handleScaleEnd = React.useCallback(() => {
        dispatchRatioReadout({ active: false });
        endDrag();
    }, [endDrag]);

    // Never leave suppression or a stale preview behind if the gizmo unmounts
    // mid-drag (deselect via keyboard, support deleted, ...).
    React.useEffect(() => () => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setContactDiskHudDraggingActive(false);
        dispatchRatioReadout({ active: false });
        onLiveShapeChange(null);
    }, [onLiveShapeChange]);

    return (
        <ScreenSpaceGizmo
            position={[center.x, center.y, center.z]}
            rotation={gizmoEuler}
            enableMove={false}
            enableRotate
            enableScale
            rotateAxes={['y']}
            scaleAxes={['x']}
            uniformScaling={false}
            scaleHandleVariant="doubleCone"
            dualScaleHandles
            // Park the stretch glyphs most of the way out toward the ring
            // (ring radius is 4.8 gizmo units; the stock 2.3 sat too close to
            // the disc).
            scaleHandleDistance={3.6}
            dualRotationHandles
            // Ring-local π/2 = gizmo-local ∓Z = the oval's long axis, so the
            // rotate arrows rest at the sides of the oval while the stretch
            // cones own the squished axis (gizmo-local ±X).
            rotationHandleRestAngle={Math.PI / 2}
            showCenter={false}
            followMeshRef={false}
            scaleFactor={0.03}
            handleScale={1.4}
            disableRingBillboard
            disableViewCull
            enableLighting={false}
            onRotateStart={handleRotateStart}
            onRotate={handleRotate}
            onRotateEnd={handleRotateEnd}
            onScaleStart={handleScaleStart}
            onScale={handleScale}
            onScaleEnd={handleScaleEnd}
        />
    );
}
