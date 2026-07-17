import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import {
    buildBatchedBezierTubes,
    isCurvedBatchedShaft,
    resolveCurvedShaftIndexForFace,
} from '../../Curves/batchedBezierTubeGeometry';

export interface InstancedShaft {
    id: string;
    start: Vec3;
    end: Vec3;
    diameter: number;
    supportId?: string;
    modelId?: string;
    /**
     * Present on curved (bezier) segments. Curved entries render as a smooth
     * merged tube (visual parity with the detailed BezierRenderer) instead of
     * a straight instanced cylinder; straight entries leave these unset.
     */
    controlPoint1?: Vec3;
    controlPoint2?: Vec3;
    resolution?: number;
}

interface InstancedShaftGroupProps {
    shafts: InstancedShaft[];
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    radialSegments?: number;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    onShaftClick?: (shaft: InstancedShaft, event: ThreeEvent<MouseEvent>) => void;
    onShaftPointerMove?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
    onShaftPointerOut?: (shaft: InstancedShaft | null, event: ThreeEvent<PointerEvent>) => void;
}

const UP = new THREE.Vector3(0, 1, 0);
const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => {};

export function InstancedShaftGroup({
    shafts,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    clippingPlanes = null,
    radialSegments = 12,
    outOfBoundsMaterial = null,
    onShaftClick,
    onShaftPointerMove,
    onShaftPointerOut,
}: InstancedShaftGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const overlayMeshRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredShaftRef = useRef<InstancedShaft | null>(null);

    const { straightShafts, curvedShafts } = useMemo(() => {
        const straight: InstancedShaft[] = [];
        const curved: InstancedShaft[] = [];
        for (const shaft of shafts) {
            if (isCurvedBatchedShaft(shaft)) {
                // Degenerate only when the whole control net collapses to a point.
                const points = [shaft.controlPoint1!, shaft.controlPoint2!, shaft.end];
                const collapsed = points.every((p) => {
                    const dx = p.x - shaft.start.x;
                    const dy = p.y - shaft.start.y;
                    const dz = p.z - shaft.start.z;
                    return dx * dx + dy * dy + dz * dz < 1e-6;
                });
                if (!collapsed) curved.push(shaft);
                continue;
            }
            const dx = shaft.end.x - shaft.start.x;
            const dy = shaft.end.y - shaft.start.y;
            const dz = shaft.end.z - shaft.start.z;
            if (dx * dx + dy * dy + dz * dz >= 1e-6) straight.push(shaft);
        }
        return { straightShafts: straight, curvedShafts: curved };
    }, [shafts]);

    const curvedTubes = useMemo(
        () => buildBatchedBezierTubes(curvedShafts, radialSegments),
        [curvedShafts, radialSegments],
    );

    useEffect(() => {
        return () => {
            curvedTubes?.geometry.dispose();
        };
    }, [curvedTubes]);

    const hasOverlay = !!outOfBoundsMaterial;

    useLayoutEffect(() => {
        const mesh = meshRef.current;
        const overlayMesh = overlayMeshRef.current;
        if (!mesh) return;

        const tempObject = new THREE.Object3D();
        const start = new THREE.Vector3();
        const end = new THREE.Vector3();
        const direction = new THREE.Vector3();
        const midpoint = new THREE.Vector3();

        for (let i = 0; i < straightShafts.length; i += 1) {
            const shaft = straightShafts[i];

            start.set(shaft.start.x, shaft.start.y, shaft.start.z);
            end.set(shaft.end.x, shaft.end.y, shaft.end.z);

            direction.subVectors(end, start);
            const length = direction.length();
            if (length < 0.001) continue;

            direction.divideScalar(length);
            midpoint.addVectors(start, end).multiplyScalar(0.5);

            tempObject.position.copy(midpoint);
            tempObject.quaternion.setFromUnitVectors(UP, direction);
            tempObject.scale.set(shaft.diameter, length, shaft.diameter);
            tempObject.updateMatrix();
            mesh.setMatrixAt(i, tempObject.matrix);
            if (overlayMesh) overlayMesh.setMatrixAt(i, tempObject.matrix);
        }

        mesh.count = straightShafts.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (overlayMesh) {
            overlayMesh.count = straightShafts.length;
            overlayMesh.instanceMatrix.needsUpdate = true;
        }
    }, [straightShafts, hasOverlay]);

    if (straightShafts.length === 0 && !curvedTubes) return null;

    const handleClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onShaftClick) return;
        event.stopPropagation();
        const instanceId = event.instanceId;
        if (instanceId == null) return;
        const shaft = straightShafts[instanceId];
        if (!shaft) return;
        onShaftClick(shaft, event);
    };

    const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerMove) return;
        event.stopPropagation();
        const instanceId = event.instanceId;
        if (instanceId == null) return;
        const shaft = straightShafts[instanceId];
        if (!shaft) return;
        lastHoveredShaftRef.current = shaft;
        onShaftPointerMove(shaft, event);
    };

    const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerOut) return;
        event.stopPropagation();
        onShaftPointerOut(lastHoveredShaftRef.current, event);
        lastHoveredShaftRef.current = null;
    };

    const resolveCurvedShaft = (event: { faceIndex?: number | null }): InstancedShaft | null => {
        if (!curvedTubes) return null;
        const faceIndex = event.faceIndex;
        if (faceIndex == null) return null;
        const index = resolveCurvedShaftIndexForFace(curvedTubes.triangleRangeEnds, faceIndex);
        return index >= 0 ? curvedShafts[index] ?? null : null;
    };

    const handleCurvedClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onShaftClick) return;
        event.stopPropagation();
        const shaft = resolveCurvedShaft(event);
        if (!shaft) return;
        onShaftClick(shaft, event);
    };

    const handleCurvedPointerMove = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerMove) return;
        event.stopPropagation();
        const shaft = resolveCurvedShaft(event);
        if (!shaft) return;
        lastHoveredShaftRef.current = shaft;
        onShaftPointerMove(shaft, event);
    };

    return (
        <>
            {straightShafts.length > 0 && (
                <instancedMesh
                    key={`straight:${straightShafts.length}`}
                    ref={meshRef}
                    args={[undefined, undefined, straightShafts.length]}
                    frustumCulled={false}
                    renderOrder={100000}
                    onClick={onShaftClick ? handleClick : undefined}
                    onPointerMove={onShaftPointerMove ? handlePointerMove : undefined}
                    onPointerOut={onShaftPointerOut ? handlePointerOut : undefined}
                >
                    <cylinderGeometry args={[0.5, 0.5, 1, radialSegments, 1, false]} />
                    <meshStandardMaterial
                        color={color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                        clippingPlanes={clippingPlanes ?? undefined}
                    />
                </instancedMesh>
            )}
            {straightShafts.length > 0 && outOfBoundsMaterial && (
                <instancedMesh
                    key={`straight-overlay:${straightShafts.length}`}
                    ref={overlayMeshRef}
                    args={[undefined, undefined, straightShafts.length]}
                    frustumCulled={false}
                    raycast={NOOP_RAYCAST}
                    renderOrder={100000}
                    material={outOfBoundsMaterial}
                >
                    <cylinderGeometry args={[0.5, 0.5, 1, radialSegments, 1, false]} />
                </instancedMesh>
            )}
            {curvedTubes && (
                <mesh
                    geometry={curvedTubes.geometry}
                    frustumCulled={false}
                    renderOrder={100000}
                    onClick={onShaftClick ? handleCurvedClick : undefined}
                    onPointerMove={onShaftPointerMove ? handleCurvedPointerMove : undefined}
                    onPointerOut={onShaftPointerOut ? handlePointerOut : undefined}
                >
                    <meshStandardMaterial
                        color={color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                        clippingPlanes={clippingPlanes ?? undefined}
                    />
                </mesh>
            )}
            {curvedTubes && outOfBoundsMaterial && (
                <mesh
                    geometry={curvedTubes.geometry}
                    frustumCulled={false}
                    raycast={NOOP_RAYCAST}
                    renderOrder={100000}
                    material={outOfBoundsMaterial}
                />
            )}
        </>
    );
}
