"use client";

import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';

import type { Vec3 } from '../../types';
import { collectModelMeshes } from './contactDiskDragController';

// Azimuth samples around the oval. With BVH-accelerated raycasts this stays
// well under a millisecond per recompute, so live gizmo drags can afford it.
const OUTLINE_SEGMENTS = 96;
const OUTLINE_COLOR = '#39ff14';

interface ContactDiskIntersectionOutlineProps {
    /** Surface contact point (world). */
    pos: Vec3;
    /** Disc orientation: local +Y is the disc normal / cast direction. */
    quaternion: THREE.Quaternion;
    radius: number;
    ratio: number;
    angleRad: number;
    thickness: number;
    penetrationMm: number;
}

/**
 * Bright outline tracing the EXACT curve where the contact disc's wall meets
 * the model surface — unlike the flat HUD ellipse, this follows the model's
 * real curvature.
 *
 * Per azimuth, the oval wall is a vertical line (in the disc frame) at the
 * loft's polar-angle radius; casting a ray down that line against the model
 * finds where wall and surface cross. Rays that miss (disc overhanging an
 * edge) leave a gap in the loop rather than inventing points.
 */
export function ContactDiskIntersectionOutline({
    pos,
    quaternion,
    radius,
    ratio,
    angleRad,
    thickness,
    penetrationMm,
}: ContactDiskIntersectionOutlineProps) {
    const scene = useThree((state) => state.scene);
    // Captured once per selection (the component mounts with it); models
    // rarely change while a disc is selected.
    const modelMeshes = React.useMemo(() => collectModelMeshes(scene), [scene]);

    const runs = React.useMemo(() => {
        if (modelMeshes.length === 0) return [] as [number, number, number][][];

        const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
        const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
        const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
        const origin = new THREE.Vector3(pos.x, pos.y, pos.z);
        const dir = yAxis.clone().negate();

        // Start above any plausible surface bulge inside the footprint, end a
        // little below the deepest the surface can dip before the outline
        // stops being meaningful.
        const castStart = thickness + radius * 2 + 0.3;
        const castSpan = castStart + Math.max(0.8, penetrationMm * 4 + radius * 2);

        const raycaster = new THREE.Raycaster();
        (raycaster as { firstHitOnly?: boolean }).firstHitOnly = true;
        raycaster.far = castSpan;

        const semiX = radius * Math.max(0.01, Math.min(1, ratio));
        const cosA = Math.cos(angleRad);
        const sinA = Math.sin(angleRad);
        const rayOrigin = new THREE.Vector3();

        // Sample all azimuths first so the loop can be closed across the wrap.
        const points: ([number, number, number] | null)[] = new Array(OUTLINE_SEGMENTS);
        for (let i = 0; i < OUTLINE_SEGMENTS; i++) {
            const psi = (i / OUTLINE_SEGMENTS) * Math.PI * 2;
            const cosP = Math.cos(psi);
            const sinP = Math.sin(psi);
            // Same polar-angle oval radius the loft wall uses.
            const rho = (semiX * radius) / Math.sqrt(radius * radius * cosP * cosP + semiX * semiX * sinP * sinP);
            // Oval-local → disc-local via the +angle spin about Y (the loft
            // mesh's rotation=[0, +a, 0]).
            const ex = rho * cosP;
            const ez = rho * sinP;
            const lx = ex * cosA + ez * sinA;
            const lz = -ex * sinA + ez * cosA;

            rayOrigin.copy(origin)
                .addScaledVector(xAxis, lx)
                .addScaledVector(zAxis, lz)
                .addScaledVector(yAxis, castStart);
            raycaster.set(rayOrigin, dir);
            const hit = raycaster.intersectObjects(modelMeshes, true)[0];
            points[i] = hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
        }

        // Split into contiguous runs (gaps where rays missed the model).
        const acc: [number, number, number][][] = [];
        let current: [number, number, number][] = [];
        for (let i = 0; i < OUTLINE_SEGMENTS; i++) {
            const p = points[i];
            if (p) {
                current.push(p);
            } else if (current.length) {
                acc.push(current);
                current = [];
            }
        }
        if (current.length) acc.push(current);

        if (acc.length === 1 && acc[0].length === OUTLINE_SEGMENTS) {
            // Every ray hit: close the loop.
            acc[0] = [...acc[0], acc[0][0]];
        } else if (acc.length > 1 && points[0] && points[OUTLINE_SEGMENTS - 1]) {
            // The wrap point is inside a run: stitch last run onto the first.
            const last = acc.pop();
            if (last) acc[0] = [...last, ...acc[0]];
        }
        return acc;
    }, [modelMeshes, pos.x, pos.y, pos.z, quaternion, radius, ratio, angleRad, thickness, penetrationMm]);

    return (
        <>
            {runs.map((points, idx) => (points.length >= 2 ? (
                <Line
                    key={idx}
                    points={points}
                    color={OUTLINE_COLOR}
                    lineWidth={2.2}
                    transparent
                    opacity={0.95}
                    depthTest={false}
                    renderOrder={100001}
                />
            ) : null))}
        </>
    );
}
