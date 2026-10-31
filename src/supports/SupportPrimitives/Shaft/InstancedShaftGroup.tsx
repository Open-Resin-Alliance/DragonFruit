import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import {
    buildBatchedBezierTubes,
    hasCachedBezierTube,
    resolveCurvedShaftIndexForFace,
    splitBatchedShafts,
    warmBezierTube,
} from '../../Curves/batchedBezierTubeGeometry';
import type { BatchedBezierTubes } from '../../Curves/batchedBezierTubeGeometry';
import { buildProxyHoverIndex, createProxyHoverRaycast, type ProxyHoverTarget } from '../../proxyHoverIndex';
import { supportAnswersPointer } from '@/features/scene/plates/plateInteractivity';
import { HIDDEN_INSTANCE_MATRIX } from '../hiddenInstanceMatrix';
import { INSTANCED_MESH_RAYCAST } from '../instancedRaycast';
import { noteActivity } from '@/utils/debug/heartbeatContext';
import { quantizeToScale } from '@/utils/math';
import { writeInstanceColors } from '../instanceColorWriter';

export interface InstancedShaft {
    id: string;
    start: Vec3;
    end: Vec3;
    diameter: number;
    /** The width at `end`. Set and differing, the shaft leaves the batch. */
    diameterEnd?: number;
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
    /**
     * Per-instance colour, for a caller that tints a subset of the batch (the
     * selection). Every instance must be given one: the colour buffer starts
     * black, and the group's own `color` is not used once this is set.
     */
    instanceColor?: (shaft: InstancedShaft) => THREE.Color;
    /**
     * Instances to hide, by the primitive they draw. The world layer keeps an
     * excluded model in its arrays and hides it here, so an activation change
     * costs the changed instances rather than a full re-layout. Curved shafts
     * are not hidden this way: they are merged into one tube mesh.
     */
    isHidden?: (shaft: InstancedShaft) => boolean;
    /**
     * Grab radius in world units at a distance along the ray, for a caller whose
     * straight batch is large enough that three's per-instance walk is the cost
     * of a hover. Given one, the straight batch answers hover through an index of
     * its own instances and never walks them; without one it uses three's raycast.
     *
     * The index is built here, from the same list the mesh draws, because a
     * target's `index` is the instance index the event reports: built anywhere
     * else it can be shifted against the drawn list - a zero-length shaft is not
     * drawn - and every hit past it resolves to a neighbouring support.
     */
    grabRadiusAt?: (distance: number) => number;
    /**
     * Models whose supports answer no pointer — the ones standing on another bed. Their
     * shafts are left out of the hover index rather than tested and discarded: the index
     * is the whole per-move cost of this batch, so a bed nobody is working on costs
     * nothing to sweep the cursor over.
     */
    pointerSceneryModelIds?: ReadonlySet<string>;
    onShaftClick?: (shaft: InstancedShaft, event: ThreeEvent<MouseEvent>) => void;
    onShaftPointerDown?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
    onShaftPointerMove?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
    onShaftPointerOut?: (shaft: InstancedShaft | null, event: ThreeEvent<PointerEvent>) => void;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Layout scratch: layouts are synchronous, so the batch kinds can share it. */
const scratchObject = new THREE.Object3D();
const shaftStart = new THREE.Vector3();
const shaftEnd = new THREE.Vector3();
const shaftDirection = new THREE.Vector3();
const shaftMidpoint = new THREE.Vector3();
const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => {};

/** Grouping key for curved shafts a caller does not tint: not a colour. */
const NO_TINT_KEY = 'no-tint';

/** How many swept tubes one idle slice may build; ~10 ms of work each. */
const CURVED_TUBE_SLICE = 160;

/** The browser idle scheduler, which is feature-detected rather than assumed. */
type IdleSchedulerWindow = {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
};

/** True when this shaft's two ends differ enough to need a cone. */
export function isTaperedShaft(shaft: InstancedShaft): boolean {
    return shaft.diameterEnd != null
        && Math.abs(shaft.diameterEnd - shaft.diameter) > 1e-6;
}

/**
 * Tapered shafts sharing one end-to-end ratio, which one instanced cone draws.
 *
 * A cone of radius `ratio` over radius 1 scales to any width and length, so a
 * ratio is all a bucket needs -- the same shape-keyed batching the roots use.
 */
interface TaperBucket {
    key: string;
    ratio: number;
    shafts: InstancedShaft[];
}

/**
 * Quantization of a tapered shaft's end-to-end ratio, in ratio units.
 *
 * The ratio is the one dimension the instance matrix cannot carry, so it is part
 * of the bucket key — and a key is a draw call. At 0.001 a continuously varying
 * taper profile would make one bucket per shaft; 0.05 is a 2.5% end-radius error
 * (microns at print scale) and collapses it to a handful. Same trade, and the
 * same number, as the cone batch.
 *
 * Exported because the scene-wide shaft slot index buckets by the same rule: two
 * passes that quantize a ratio must quantize it identically, or one shaft renders
 * at two widths.
 */
export const TAPER_RATIO_STEP = 0.05;
export const TAPER_RATIO_BUCKETS_PER_UNIT = 1 / TAPER_RATIO_STEP;

function taperBuckets(shafts: readonly InstancedShaft[]): TaperBucket[] {
    const grouped = new Map<string, TaperBucket>();
    for (const shaft of shafts) {
        const ratio = quantizeToScale((shaft.diameterEnd ?? shaft.diameter) / shaft.diameter, TAPER_RATIO_BUCKETS_PER_UNIT);
        const key = String(ratio);
        const existing = grouped.get(key);
        if (existing) existing.shafts.push(shaft);
        else grouped.set(key, { key, ratio, shafts: [shaft] });
    }
    return [...grouped.values()];
}

/**
 * One bucket of tapered shafts, instanced like the straight batch.
 *
 * The base cone is `ratio` over 1, so the shared (diameter, length, diameter)
 * scale lands each shaft's two ends where they belong.
 */
function TaperedShaftBucket({
    bucket,
    radialSegments,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    instanceColor,
    isHidden,
    onShaftClick,
    onShaftPointerDown,
    onShaftPointerMove,
    onShaftPointerOut,
}: {
    bucket: TaperBucket;
    radialSegments: number;
    color: string;
    emissive: string;
    emissiveIntensity: number;
    transparent: boolean;
    opacity: number;
    clippingPlanes: THREE.Plane[] | null;
    instanceColor?: (shaft: InstancedShaft) => THREE.Color;
    isHidden?: (shaft: InstancedShaft) => boolean;
    onShaftClick?: (shaft: InstancedShaft, event: ThreeEvent<MouseEvent>) => void;
    onShaftPointerDown?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
    onShaftPointerMove?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
    onShaftPointerOut?: (shaft: InstancedShaft | null, event: ThreeEvent<PointerEvent>) => void;
}) {
    const meshRef = useRef<THREE.InstancedMesh>(null);

    useLayoutEffect(() => {
        const mesh = meshRef.current;
        if (!mesh) return;
        bucket.shafts.forEach((shaft, index) => {
            if (isHidden?.(shaft)) {
                mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
                return;
            }
            shaftStart.set(shaft.start.x, shaft.start.y, shaft.start.z);
            shaftEnd.set(shaft.end.x, shaft.end.y, shaft.end.z);
            shaftDirection.subVectors(shaftEnd, shaftStart);
            const length = shaftDirection.length();
            if (length < 0.001) {
                mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
                return;
            }
            shaftDirection.divideScalar(length);
            shaftMidpoint.addVectors(shaftStart, shaftEnd).multiplyScalar(0.5);
            scratchObject.position.copy(shaftMidpoint);
            scratchObject.quaternion.setFromUnitVectors(UP, shaftDirection);
            scratchObject.scale.set(shaft.diameter, length, shaft.diameter);
            scratchObject.updateMatrix();
            mesh.setMatrixAt(index, scratchObject.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (instanceColor) writeInstanceColors(mesh, bucket.shafts, instanceColor);
    }, [bucket, isHidden, instanceColor]);

    const shaftAt = (event: { instanceId?: number }) => (
        event.instanceId == null ? null : bucket.shafts[event.instanceId] ?? null
    );

    return (
        <instancedMesh
            ref={meshRef}
            args={[undefined, undefined, bucket.shafts.length]}
            frustumCulled={false}
            raycast={INSTANCED_MESH_RAYCAST}
            onClick={onShaftClick ? (event) => {
                const shaft = shaftAt(event);
                if (shaft) { event.stopPropagation(); onShaftClick(shaft, event); }
            } : undefined}
            onPointerDown={onShaftPointerDown ? (event) => {
                const shaft = shaftAt(event);
                if (shaft) { event.stopPropagation(); onShaftPointerDown(shaft, event); }
            } : undefined}
            onPointerMove={onShaftPointerMove ? (event) => {
                const shaft = shaftAt(event);
                if (shaft) { event.stopPropagation(); onShaftPointerMove(shaft, event); }
            } : undefined}
            onPointerOut={onShaftPointerOut ? (event) => onShaftPointerOut(null, event) : undefined}
        >
            <cylinderGeometry args={[bucket.ratio / 2, 0.5, 1, radialSegments]} />
            <meshStandardMaterial
                color={instanceColor ? undefined : color}
                emissive={emissive}
                emissiveIntensity={emissiveIntensity}
                transparent={transparent}
                opacity={opacity}
                depthWrite={!transparent}
                clippingPlanes={clippingPlanes ?? undefined}
            />
        </instancedMesh>
    );
}

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
    instanceColor,
    isHidden,
    grabRadiusAt,
    pointerSceneryModelIds,
    onShaftClick,
    onShaftPointerDown,
    onShaftPointerMove,
    onShaftPointerOut,
}: InstancedShaftGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const overlayMeshRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredShaftRef = useRef<InstancedShaft | null>(null);

    const { straightShafts: allStraightShafts, curvedShafts } = useMemo(() => splitBatchedShafts(shafts), [shafts]);

    // One instance is a cylinder scaled by a matrix, which cannot narrow.
    const { straightShafts, taperedShafts } = useMemo(() => {
        const straight: InstancedShaft[] = [];
        const tapered: InstancedShaft[] = [];
        for (const shaft of allStraightShafts) {
            (isTaperedShaft(shaft) ? tapered : straight).push(shaft);
        }
        return { straightShafts: straight, taperedShafts: tapered };
    }, [allStraightShafts]);

    // The straight batch draws every shaft of every model in one mesh, so three's
    // own raycast would walk all of them (~0.11 us each, 13 ms at 100k) on every
    // pointer move. Built from this batch's own list, so a target's index is the
    // instance index the event reports.
    const straightRaycast = useMemo(() => {
        if (!grabRadiusAt || straightShafts.length === 0) return undefined;
        const targets: ProxyHoverTarget[] = straightShafts.map((shaft, index) => ({
            modelId: shaft.modelId,
            index,
            start: shaft.start,
            end: shaft.end,
            radius: Math.max(0.2, shaft.diameter / 2),
        })).filter((target) => supportAnswersPointer(target.modelId, pointerSceneryModelIds));
        const index = buildProxyHoverIndex(targets);
        return index ? createProxyHoverRaycast(index, grabRadiusAt) : undefined;
    }, [grabRadiusAt, straightShafts, pointerSceneryModelIds]);

    // A merged tube mesh has one material, so a caller that tints individual
    // shafts gets one merged mesh per colour rather than vertex colours: the
    // colour then rides on the material, the same way an instanced shaft's does,
    // and two shafts that should look alike cannot diverge by which path drew
    // them. The selection tints at most two colours.
    //
    // The tube geometries are built in idle slices, not during render: a
    // supported plate's batch is thousands of swept curves, and building them in
    // one go blocked the main thread for ~0.9 s — inside the camera intro on a
    // load, and at the commit of a model move. The previous batch stays drawn
    // until the new one is assembled (one buffer copy, now typed).
    const [curvedTubeGroups, setCurvedTubeGroups] = React.useState<
        Array<{ color: string; shafts: InstancedShaft[]; tubes: BatchedBezierTubes }>
    >([]);

    useEffect(() => {
        if (curvedShafts.length === 0) {
            setCurvedTubeGroups((previous) => (previous.length === 0 ? previous : []));
            return;
        }

        let cancelled = false;
        let cursor = 0;
        const handles: number[] = [];
        // Feature-detected, not assumed: the DOM lib types it as always present.
        const scheduler = window as unknown as IdleSchedulerWindow;
        const schedule = (run: () => void) => {
            if (typeof scheduler.requestIdleCallback === 'function') {
                handles.push(scheduler.requestIdleCallback(run, { timeout: 120 }));
                return;
            }
            handles.push(setTimeout(run, 0) as unknown as number);
        };

        const step = () => {
            if (cancelled) return;
            noteActivity('support-mode:curved-shaft-tubes');
            let built = 0;
            while (cursor < curvedShafts.length && built < CURVED_TUBE_SLICE) {
                const shaft = curvedShafts[cursor];
                cursor += 1;
                if (hasCachedBezierTube(shaft)) continue;
                warmBezierTube(shaft, radialSegments);
                built += 1;
            }
            if (cursor < curvedShafts.length) {
                schedule(step);
                return;
            }

            const byColor = new Map<string, InstancedShaft[]>();
            for (const shaft of curvedShafts) {
                const color = instanceColor ? instanceColor(shaft).getHexString() : NO_TINT_KEY;
                const bucket = byColor.get(color);
                if (bucket) bucket.push(shaft);
                else byColor.set(color, [shaft]);
            }
            const groups = [...byColor.entries()].flatMap(([color, group]) => {
                const tubes = buildBatchedBezierTubes(group, radialSegments);
                return tubes ? [{ color, shafts: group, tubes }] : [];
            });
            setCurvedTubeGroups(groups);
        };

        schedule(step);

        return () => {
            cancelled = true;
            for (const handle of handles) {
                if (typeof scheduler.cancelIdleCallback === 'function') scheduler.cancelIdleCallback(handle);
                clearTimeout(handle);
            }
        };
    }, [curvedShafts, radialSegments, instanceColor]);

    useEffect(() => {
        return () => {
            for (const group of curvedTubeGroups) group.tubes.geometry.dispose();
        };
    }, [curvedTubeGroups]);

    // One instanced cone per taper ratio, so a taper costs no draw call each.
    const taperedBuckets = useMemo(() => taperBuckets(taperedShafts), [taperedShafts]);

    const hasOverlay = !!outOfBoundsMaterial;

    const hiddenStateRef = React.useRef<Map<InstancedShaft, boolean>>(new Map());

    const writeInstanceMatrix = React.useCallback((
        mesh: THREE.InstancedMesh,
        index: number,
        shaft: InstancedShaft,
        hidden: boolean,
    ) => {
        if (hidden) {
            mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
            return;
        }
        shaftStart.set(shaft.start.x, shaft.start.y, shaft.start.z);
        shaftEnd.set(shaft.end.x, shaft.end.y, shaft.end.z);
        shaftDirection.subVectors(shaftEnd, shaftStart);
        const length = shaftDirection.length();
        if (length < 0.001) {
            mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
            return;
        }
        shaftDirection.divideScalar(length);
        shaftMidpoint.addVectors(shaftStart, shaftEnd).multiplyScalar(0.5);
        scratchObject.position.copy(shaftMidpoint);
        scratchObject.quaternion.setFromUnitVectors(UP, shaftDirection);
        scratchObject.scale.set(shaft.diameter, length, shaft.diameter);
        scratchObject.updateMatrix();
        mesh.setMatrixAt(index, scratchObject.matrix);
    }, []);

    useLayoutEffect(() => {
        const mesh = meshRef.current;
        const overlayMesh = overlayMeshRef.current;
        if (!mesh) return;

        for (let i = 0; i < straightShafts.length; i += 1) {
            const shaft = straightShafts[i];
            writeInstanceMatrix(mesh, i, shaft, false);
            if (overlayMesh) writeInstanceMatrix(overlayMesh, i, shaft, false);
        }

        mesh.count = straightShafts.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (overlayMesh) {
            overlayMesh.count = straightShafts.length;
            overlayMesh.instanceMatrix.needsUpdate = true;
        }
        // The batch was just rewritten with every instance visible, so the hide
        // pass's memo of what it has already applied is stale. Without this it
        // skips the excluded instances and they render at their committed
        // position, which is the ghost of a dragged model's supports.
        hiddenStateRef.current.clear();
    }, [straightShafts, hasOverlay, writeInstanceMatrix]);

    // Hiding an instance writes one matrix, not the whole batch: this is what an
    // activation change pays, and it must not re-derive every other instance.
    useLayoutEffect(() => {
        const mesh = meshRef.current;
        const overlayMesh = overlayMeshRef.current;
        if (!mesh || !isHidden) return;

        const hiddenState = hiddenStateRef.current;
        let touched = false;
        for (let i = 0; i < straightShafts.length; i += 1) {
            const shaft = straightShafts[i];
            const hidden = isHidden(shaft);
            if ((hiddenState.get(shaft) ?? false) === hidden) continue;
            hiddenState.set(shaft, hidden);
            touched = true;
            writeInstanceMatrix(mesh, i, shaft, hidden);
            if (overlayMesh) writeInstanceMatrix(overlayMesh, i, shaft, hidden);
        }

        if (!touched) return;
        mesh.instanceMatrix.needsUpdate = true;
        if (overlayMesh) overlayMesh.instanceMatrix.needsUpdate = true;
    }, [straightShafts, hasOverlay, isHidden, writeInstanceMatrix]);

    // Colours are a separate pass: a selection changes them and nothing else, and
    // it must not re-derive every instance matrix to do it.
    useLayoutEffect(() => {
        const mesh = meshRef.current;
        if (!mesh || !instanceColor) return;
        writeInstanceColors(mesh, straightShafts, instanceColor);
    }, [straightShafts, instanceColor]);

    if (straightShafts.length === 0 && curvedTubeGroups.length === 0) return null;

    const handleClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onShaftClick) return;
        event.stopPropagation();
        const instanceId = event.instanceId;
        if (instanceId == null) return;
        const shaft = straightShafts[instanceId];
        if (!shaft) return;
        onShaftClick(shaft, event);
    };

    const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerDown) return;
        event.stopPropagation();
        const instanceId = event.instanceId;
        if (instanceId == null) return;
        const shaft = straightShafts[instanceId];
        if (!shaft) return;
        onShaftPointerDown(shaft, event);
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

    const resolveCurvedShaft = (event: { faceIndex?: number | null; object?: THREE.Object3D }): InstancedShaft | null => {
        const faceIndex = event.faceIndex;
        if (faceIndex == null) return null;
        // The tube meshes share one handler set, so which one was hit decides
        // which curve list the face index belongs to.
        const hitGeometry = event.object && 'geometry' in event.object ? event.object.geometry : null;
        const group = curvedTubeGroups.find((candidate) => candidate.tubes.geometry === hitGeometry);
        if (!group) return null;
        const index = resolveCurvedShaftIndexForFace(group.tubes.triangleRangeEnds, faceIndex);
        return index >= 0 ? group.shafts[index] ?? null : null;
    };

    const handleCurvedClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onShaftClick) return;
        event.stopPropagation();
        const shaft = resolveCurvedShaft(event);
        if (!shaft) return;
        onShaftClick(shaft, event);
    };


    const handleCurvedPointerDown = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerDown) return;
        event.stopPropagation();
        const shaft = resolveCurvedShaft(event);
        if (!shaft) return;
        onShaftPointerDown(shaft, event);
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
                    raycast={straightRaycast ?? INSTANCED_MESH_RAYCAST}
                    onClick={onShaftClick ? handleClick : undefined}
                    onPointerDown={onShaftPointerDown ? handlePointerDown : undefined}
                    onPointerMove={onShaftPointerMove ? handlePointerMove : undefined}
                    onPointerOut={onShaftPointerOut ? handlePointerOut : undefined}
                >
                    <cylinderGeometry args={[0.5, 0.5, 1, radialSegments, 1, false]} />
                    <meshStandardMaterial
                        color={instanceColor ? '#ffffff' : color}
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
            {curvedTubeGroups.map((group) => (
                <mesh
                    key={`curved:${group.color}`}
                    geometry={group.tubes.geometry}
                    frustumCulled={false}
                    renderOrder={100000}
                    onClick={onShaftClick ? handleCurvedClick : undefined}
                    onPointerDown={onShaftPointerDown ? handleCurvedPointerDown : undefined}
                    onPointerMove={onShaftPointerMove ? handleCurvedPointerMove : undefined}
                    onPointerOut={onShaftPointerOut ? handlePointerOut : undefined}
                >
                    <meshStandardMaterial
                        color={instanceColor ? `#${group.color}` : color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                        clippingPlanes={clippingPlanes ?? undefined}
                    />
                </mesh>
            ))}
            {curvedTubeGroups.map((group) => (outOfBoundsMaterial ? (
                <mesh
                    key={`curved-overlay:${group.color}`}
                    geometry={group.tubes.geometry}
                    frustumCulled={false}
                    raycast={NOOP_RAYCAST}
                    renderOrder={100000}
                    material={outOfBoundsMaterial}
                />
            ) : null))}
            {taperedBuckets.map((bucket) => (
                <TaperedShaftBucket
                    key={`tapered:${bucket.key}`}
                    bucket={bucket}
                    radialSegments={radialSegments}
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    clippingPlanes={clippingPlanes}
                    instanceColor={instanceColor}
                    isHidden={isHidden}
                    onShaftClick={onShaftClick}
                    onShaftPointerDown={onShaftPointerDown}
                    onShaftPointerMove={onShaftPointerMove}
                    onShaftPointerOut={onShaftPointerOut}
                />
            ))}
        </>
    );
}
