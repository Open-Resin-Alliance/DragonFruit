import * as THREE from 'three';
import { quantizeToScale } from '@/utils/math';
import { buildBatchedBezierTubes, splitBatchedShafts } from '../Curves/batchedBezierTubeGeometry';
import type { InstancedContactCone } from '../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { getConeCenterPosition, getConeQuaternionInto } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness, getDiskCenter, getDiskRotationInto } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { ProxyModelGeometry } from '../SupportProxyMeshLayer';
import type { MergedSupportGeometry } from './types';

/**
 * One model's supports merged into a single world-space geometry.
 *
 * The Prepare view currently draws supports as an instanced proxy: one
 * `InstancedMesh` per batch kind, with the batches tiled spatially. Moving a
 * model then re-uploads an instance matrix per shaft, joint, cone and root.
 * This module flattens the same primitives into one buffer with two material
 * groups, so a model movement is a parent-matrix update and a handful of draws.
 *
 * The primitive shapes, tessellation and placement maths are the proxy's, so
 * the two views read the same: read the instanced groups rather than this file
 * when the fidelity question comes up.
 *
 * Space: world by default. With `localInverse`, the finished buffer is baked
 * into that model's local frame, so the caller can parent it directly to the
 * model group and a model move needs no vertex changes.
 */

/**
 * Tessellation the Prepare proxy layer passes to its groups
 * (`SupportProxyMeshLayer`): 10 segments for shafts, cones and roots, and 8x6
 * for joint and tip spheres.
 */
const SHAFT_RADIAL_SEGMENTS = 10;
const PRIMITIVE_RADIAL_SEGMENTS = 10;
const SPHERE_WIDTH_SEGMENTS = 8;
const SPHERE_HEIGHT_SEGMENTS = 6;

/** Mirrors the proxy's taper quantization (`TAPER_RATIO_STEP`, 0.05). */
const TAPER_RATIO_BUCKETS_PER_UNIT = 20;
/** Mirrors the proxy's root cone quantization (`ROOT_SHAPE_RATIO_STEP`, 0.05). */
const ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT = 20;
/**
 * The proxy lifts every root by a hundredth of a millimetre so its disk does
 * not fight the plate/raft at identical depth (`ROOT_RENDER_LIFT_MM`).
 */
const ROOT_RENDER_LIFT_MM = 0.01;

const UP = new THREE.Vector3(0, 1, 0);
const ROOT_ROTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

/**
 * Unit geometries, shared by every primitive of their kind. Every millimetre
 * dimension rides the per-primitive matrix, so these are built once.
 */
const UNIT_SHAFT = new THREE.CylinderGeometry(0.5, 0.5, 1, SHAFT_RADIAL_SEGMENTS, 1, false);
const UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, PRIMITIVE_RADIAL_SEGMENTS);
const UNIT_SPHERE = new THREE.SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);

/**
 * Frustums whose two radii differ: the taper ratio is the one shape value a
 * matrix cannot carry, so each ratio is its own geometry — the same
 * shape-keyed batching the proxy does, cached across builds.
 */
const taperedShaftGeometryCache = new Map<number, THREE.CylinderGeometry>();
const rootConeGeometryCache = new Map<number, THREE.CylinderGeometry>();
const coneBodyGeometryCache = new Map<number, THREE.CylinderGeometry>();

function taperedShaftGeometry(ratio: number): THREE.CylinderGeometry {
    const quantized = quantizeToScale(ratio, TAPER_RATIO_BUCKETS_PER_UNIT);
    let geometry = taperedShaftGeometryCache.get(quantized);
    if (!geometry) {
        geometry = new THREE.CylinderGeometry(quantized / 2, 0.5, 1, SHAFT_RADIAL_SEGMENTS);
        taperedShaftGeometryCache.set(quantized, geometry);
    }
    return geometry;
}

function rootConeGeometry(shapeRatio: number): THREE.CylinderGeometry {
    const quantized = quantizeToScale(shapeRatio, ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT);
    let geometry = rootConeGeometryCache.get(quantized);
    if (!geometry) {
        geometry = new THREE.CylinderGeometry(quantized, 1, 1, PRIMITIVE_RADIAL_SEGMENTS);
        rootConeGeometryCache.set(quantized, geometry);
    }
    return geometry;
}

/**
 * The contact cone's body frustum: radius 1 at the contact end, the body/contact
 * ratio at the socket end (`coneShapeRatio` in the cone group).
 */
function coneBodyGeometry(shapeRatio: number): THREE.CylinderGeometry {
    let geometry = coneBodyGeometryCache.get(shapeRatio);
    if (!geometry) {
        geometry = new THREE.CylinderGeometry(1, shapeRatio, 1, PRIMITIVE_RADIAL_SEGMENTS);
        coneBodyGeometryCache.set(shapeRatio, geometry);
    }
    return geometry;
}

/**
 * The proxy's disk thickness rule (`getDiskThicknessForCone`): a disk profile's
 * thickness, or zero when the contact primitive is not a disk.
 *
 * The disk group's penetration comes from `resolvePenetration` when the active
 * material profile drives the UI tip offset, and from the cone's own
 * `penetrationMm` otherwise — the proxy's rule, so the two views cannot
 * disagree on disk depth.
 */
function diskThicknessForCone(cone: InstancedContactCone): number {
    if (cone.profile.type !== 'disk') return 0;
    const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
    return cone.diskLengthOverride ?? calculateDiskThickness(effectiveSurfaceNormal, cone.normal, cone.profile);
}

function coneShapeRatio(cone: InstancedContactCone): number {
    const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
    const bodyRadius = Math.max(0.001, cone.profile.bodyDiameterMm / 2);
    return bodyRadius / contactRadius;
}

/**
 * Options that change the merge without changing the primitives.
 */
export type MergedSupportGeometryOptions = {
  /**
   * Resolves one cone's nib depth from the depth the cone was authored with.
   *
   * The proxy asks `calculateTipOffset` when the material's UI shows the tip
   * offset and falls back to the cone's authored `penetrationMm`; taking the
   * authored value as the argument keeps that fallback inside the caller's
   * resolver instead of duplicating it here.
   */
  resolvePenetration?: (authoredPenetrationMm: number | undefined) => number;
  /**
   * Bake the finished world-space buffer into this model's local frame.
   *
   * The transform is one pass over the merged buffer, not one per primitive,
   * and it is the same work the mesh used to do with a group matrix every
   * frame. Normals use its normal matrix so non-uniform model scales keep the
   * lighting correct.
   */
  localInverse?: THREE.Matrix4 | null;
};

/**
 * Build one model's merged support geometry.
 *
 * Three groups, in this order: 0 support bodies, 1 the contact disks (which the
 * proxy draws with `discColor` and a polygon offset), 2 the disc-coloured parts
 * that carry no offset (cone tip spheres and root plate disks).
 */
export function buildMergedSupportGeometry(
    model: ProxyModelGeometry,
    options?: MergedSupportGeometryOptions,
): MergedSupportGeometry {
    const resolvePenetration = options?.resolvePenetration;
    const { straightShafts, curvedShafts } = splitBatchedShafts(model.shafts);
    const plainShafts: InstancedShaft[] = [];
    const taperedShafts: InstancedShaft[] = [];
    for (const shaft of straightShafts) {
        const tapered = shaft.diameterEnd != null && Math.abs(shaft.diameterEnd - shaft.diameter) > 1e-6;
        (tapered ? taperedShafts : plainShafts).push(shaft);
    }
    // The instanced groups' own validity filters.
    const joints = model.joints.filter((joint) => Number.isFinite(joint.diameter) && joint.diameter > 0.001);
    const roots = model.roots.filter((root) => root.bottomRadius > 0 && root.effectiveDiskHeight > 0);
    const cones = model.cones.filter((cone) => {
        const normal = cone.normal;
        return normal.x * normal.x + normal.y * normal.y + normal.z * normal.z > 1e-8;
    });

    // Curves are swept once: the group caches each tube per shaft, and the
    // count pass needs the merged tube geometry's own vertex/index ranges.
    const curvedTubes = buildBatchedBezierTubes(curvedShafts, SHAFT_RADIAL_SEGMENTS);

    const cylinderVertices = UNIT_CYLINDER.getAttribute('position').count;
    const cylinderIndices = UNIT_CYLINDER.getIndex()!.count;
    const sphereVertices = UNIT_SPHERE.getAttribute('position').count;
    const sphereIndices = UNIT_SPHERE.getIndex()!.count;

    // Pass 1: count the exact buffer sizes so the single merged buffer can be
    // allocated once. Filters and geometry kinds decide the counts; no
    // transform has to be built here.
    let vertexCount = 0;
    let bodyIndexCount = 0;
    let discIndexCount = 0;
    let discNoOffsetIndexCount = 0;

    if (curvedTubes) {
        vertexCount += curvedTubes.geometry.getAttribute('position').count;
        bodyIndexCount += curvedTubes.geometry.getIndex()!.count;
    }
    vertexCount += straightShafts.length * cylinderVertices;
    bodyIndexCount += straightShafts.length * cylinderIndices;
    vertexCount += joints.length * sphereVertices;
    bodyIndexCount += joints.length * sphereIndices;
    for (const cone of cones) {
        // Body, plus the tip sphere (drawn for every profile) and, for a disk
        // profile, the contact disk.
        vertexCount += cylinderVertices + sphereVertices;
        bodyIndexCount += cylinderIndices;
        discNoOffsetIndexCount += sphereIndices;
        if (cone.profile.type === 'disk') {
            vertexCount += cylinderVertices;
            discIndexCount += cylinderIndices;
        }
    }
    for (const root of roots) {
        vertexCount += cylinderVertices;
        discNoOffsetIndexCount += cylinderIndices;
        if (root.coneHeight > 0) {
            vertexCount += cylinderVertices + sphereVertices;
            bodyIndexCount += cylinderIndices + sphereIndices;
        }
    }

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(bodyIndexCount + discIndexCount + discNoOffsetIndexCount);

    // Pass 2: write the primitives into that buffer, bodies first so the two
    // material groups are contiguous index ranges.
    const matrix = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const direction = new THREE.Vector3();
    let vertexCursor = 0;
    let indexCursor = 0;

    const writeGeometry = (geometry: THREE.BufferGeometry, transform: THREE.Matrix4 | null) => {
        const sourcePosition = geometry.getAttribute('position') as THREE.BufferAttribute;
        const sourceNormal = geometry.getAttribute('normal') as THREE.BufferAttribute;
        const sourceIndex = geometry.index;
        if (!sourceIndex) return;

        const baseVertex = vertexCursor;
        const sourcePositions = sourcePosition.array;
        const sourceNormals = sourceNormal.array;
        let writeOffset = vertexCursor * 3;
        const vertexTotal = sourcePosition.count;
        if (transform) {
            normalMatrix.getNormalMatrix(transform);
            for (let i = 0, readOffset = 0; i < vertexTotal; i += 1, readOffset += 3) {
                position
                    .set(sourcePositions[readOffset], sourcePositions[readOffset + 1], sourcePositions[readOffset + 2])
                    .applyMatrix4(transform);
                positions[writeOffset] = position.x;
                positions[writeOffset + 1] = position.y;
                positions[writeOffset + 2] = position.z;
                position
                    .set(sourceNormals[readOffset], sourceNormals[readOffset + 1], sourceNormals[readOffset + 2])
                    .applyMatrix3(normalMatrix)
                    .normalize();
                normals[writeOffset] = position.x;
                normals[writeOffset + 1] = position.y;
                normals[writeOffset + 2] = position.z;
                writeOffset += 3;
            }
        } else {
            positions.set(sourcePositions as Float32Array, writeOffset);
            normals.set(sourceNormals as Float32Array, writeOffset);
        }
        for (let i = 0; i < sourceIndex.count; i += 1) {
            indices[indexCursor + i] = baseVertex + sourceIndex.getX(i);
        }
        indexCursor += sourceIndex.count;
        vertexCursor += vertexTotal;
    };

    /** Write one primitive placed by a position, rotation and scale. */
    const writePlaced = (
        geometry: THREE.BufferGeometry,
        x: number,
        y: number,
        z: number,
        rotation: THREE.Quaternion,
        sx: number,
        sy: number,
        sz: number,
    ) => {
        position.set(x, y, z);
        scale.set(sx, sy, sz);
        matrix.compose(position, rotation, scale);
        writeGeometry(geometry, matrix);
    };

    // Bodies: curved shafts (already world-space), straight and tapered shafts,
    // joints, contact cone bodies, and the root cone and top ball.
    if (curvedTubes) writeGeometry(curvedTubes.geometry, null);

    for (const shaft of plainShafts) {
        start.set(shaft.start.x, shaft.start.y, shaft.start.z);
        end.set(shaft.end.x, shaft.end.y, shaft.end.z);
        direction.subVectors(end, start);
        const length = direction.length();
        // splitBatchedShafts already dropped sub-millimetre shafts; this guard
        // mirrors the instanced batch's own length check.
        if (length < 0.001) continue;
        direction.divideScalar(length);
        quaternion.setFromUnitVectors(UP, direction);
        writePlaced(
            UNIT_SHAFT,
            (start.x + end.x) / 2,
            (start.y + end.y) / 2,
            (start.z + end.z) / 2,
            quaternion,
            shaft.diameter,
            length,
            shaft.diameter,
        );
    }

    for (const shaft of taperedShafts) {
        start.set(shaft.start.x, shaft.start.y, shaft.start.z);
        end.set(shaft.end.x, shaft.end.y, shaft.end.z);
        direction.subVectors(end, start);
        const length = direction.length();
        if (length < 0.001) continue;
        direction.divideScalar(length);
        quaternion.setFromUnitVectors(UP, direction);
        const geometry = taperedShaftGeometry((shaft.diameterEnd ?? shaft.diameter) / shaft.diameter);
        writePlaced(
            geometry,
            (start.x + end.x) / 2,
            (start.y + end.y) / 2,
            (start.z + end.z) / 2,
            quaternion,
            shaft.diameter,
            length,
            shaft.diameter,
        );
    }

    const identity = new THREE.Quaternion();
    for (const joint of joints) {
        const radius = Math.max(0.001, joint.diameter * 0.5);
        writePlaced(UNIT_SPHERE, joint.pos.x, joint.pos.y, joint.pos.z, identity, radius, radius, radius);
    }

    for (const cone of cones) {
        const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
        const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
        const thickness = diskThicknessForCone(cone);
        const startX = cone.pos.x + effectiveSurfaceNormal.x * thickness;
        const startY = cone.pos.y + effectiveSurfaceNormal.y * thickness;
        const startZ = cone.pos.z + effectiveSurfaceNormal.z * thickness;

        const center = getConeCenterPosition({ x: startX, y: startY, z: startZ }, cone.normal, cone.profile);
        getConeQuaternionInto(cone.normal, quaternion);
        writePlaced(
            coneBodyGeometry(coneShapeRatio(cone)),
            center.x,
            center.y,
            center.z,
            quaternion,
            contactRadius,
            Math.max(0.001, cone.profile.lengthMm),
            contactRadius,
        );
    }

    for (const root of roots) {
        if (root.coneHeight <= 0) continue;
        const bottomRadius = Math.max(0.001, root.bottomRadius);
        const topRadius = Math.max(0.001, root.topRadius);
        writePlaced(
            rootConeGeometry(topRadius / bottomRadius),
            root.basePos.x,
            root.basePos.y,
            root.basePos.z + ROOT_RENDER_LIFT_MM + root.effectiveDiskHeight + root.coneHeight / 2,
            ROOT_ROTATION,
            bottomRadius,
            Math.max(0.001, root.coneHeight),
            bottomRadius,
        );
        writePlaced(
            UNIT_SPHERE,
            root.basePos.x,
            root.basePos.y,
            root.basePos.z + ROOT_RENDER_LIFT_MM + root.effectiveDiskHeight + root.coneHeight,
            identity,
            topRadius,
            topRadius,
            topRadius,
        );
    }

    const bodyCount = indexCursor;

    // Group 1: contact disks, the only disc-coloured parts the proxy draws with
    // a polygon offset.
    for (const cone of cones) {
        if (cone.profile.type !== 'disk') continue;
        const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
        const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
        const thickness = diskThicknessForCone(cone);
        const penetration = Math.max(
            0,
            resolvePenetration ? resolvePenetration(cone.profile.penetrationMm) : (cone.profile.penetrationMm ?? 0),
        );
        const diskCenter = getDiskCenter(cone.pos, effectiveSurfaceNormal, thickness);
        getDiskRotationInto(effectiveSurfaceNormal, quaternion);
        writePlaced(
            UNIT_CYLINDER,
            diskCenter.x - effectiveSurfaceNormal.x * (penetration / 2),
            diskCenter.y - effectiveSurfaceNormal.y * (penetration / 2),
            diskCenter.z - effectiveSurfaceNormal.z * (penetration / 2),
            quaternion,
            contactRadius,
            Math.max(0.001, thickness + penetration),
            contactRadius,
        );
    }

    const discCount = indexCursor - bodyCount;

    // Group 2: disc-coloured without the polygon offset (cone tip spheres and
    // root plate disks, as the proxy draws them).
    for (const cone of cones) {
        const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
        const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
        const thickness = diskThicknessForCone(cone);
        writePlaced(
            UNIT_SPHERE,
            cone.pos.x + effectiveSurfaceNormal.x * thickness,
            cone.pos.y + effectiveSurfaceNormal.y * thickness,
            cone.pos.z + effectiveSurfaceNormal.z * thickness,
            identity,
            contactRadius,
            contactRadius,
            contactRadius,
        );
    }

    for (const root of roots) {
        const bottomRadius = Math.max(0.001, root.bottomRadius);
        writePlaced(
            UNIT_CYLINDER,
            root.basePos.x,
            root.basePos.y,
            root.basePos.z + ROOT_RENDER_LIFT_MM + root.effectiveDiskHeight / 2,
            ROOT_ROTATION,
            bottomRadius,
            Math.max(0.001, root.effectiveDiskHeight),
            bottomRadius,
        );
    }

    // A primitive can be skipped after the count pass (the instanced batch
    // drops sub-millimetre shafts too). Trim the buffers to what was written,
    // or the unused zeros become degenerate triangles and pull the bounding
    // sphere towards the origin.
    const geometry = new THREE.BufferGeometry();
    const finalPositions = positions.subarray(0, vertexCursor * 3);
    const finalNormals = normals.subarray(0, vertexCursor * 3);
    const localInverse = options?.localInverse;
    if (localInverse) {
        const inverseNormalMatrix = new THREE.Matrix3().getNormalMatrix(localInverse);
        for (let i = 0; i < finalPositions.length; i += 3) {
            position.set(finalPositions[i], finalPositions[i + 1], finalPositions[i + 2]).applyMatrix4(localInverse);
            finalPositions[i] = position.x;
            finalPositions[i + 1] = position.y;
            finalPositions[i + 2] = position.z;
            position.set(finalNormals[i], finalNormals[i + 1], finalNormals[i + 2]).applyMatrix3(inverseNormalMatrix).normalize();
            finalNormals[i] = position.x;
            finalNormals[i + 1] = position.y;
            finalNormals[i + 2] = position.z;
        }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(finalNormals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, indexCursor), 1));
    geometry.addGroup(0, bodyCount, 0);
    geometry.addGroup(bodyCount, discCount, 1);
    geometry.addGroup(bodyCount + discCount, indexCursor - bodyCount - discCount, 2);
    if (vertexCount > 0) {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }

    return {
        geometry,
        triangles: indexCursor / 3,
        ...(model.modelId != null ? { modelId: model.modelId } : {}),
    };
}
