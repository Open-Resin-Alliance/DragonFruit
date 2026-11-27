import * as THREE from 'three';
import { CONTAINED, INTERSECTED, NOT_INTERSECTED, type MeshBVH } from 'three-mesh-bvh';

import { modelGeometryOf } from '../autoSupport/meshStore';
import type { PlacementNormalSynthesisMode } from '../autoSupport/types';
import type { LeafCapAnchor } from '../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../types';

export type { PlacementNormalSynthesisMode };

export type PlacementNormalRegime = 'raw' | 'flat' | 'edge-bisector' | 'curved';

export interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

export interface PlacementNormalSynthesisOptions {
    mode: PlacementNormalSynthesisMode;
    contactRadiusMm: number;
    prevNormal?: Vec3Like | THREE.Vector3;
    isDiskHudDrag?: boolean;
    maxDragStepDeg?: number;
    sampleRadiusScale?: number;
    flatThresholdDeg?: number;
    creaseThresholdDeg?: number;
    deadbandScale?: number;
}

export interface PlacementNormalSynthesisResult {
    normal: THREE.Vector3;
    regime: PlacementNormalRegime;
    acceptedSphereTris: number;
    thetaSpreadRad?: number;
    isConcave?: boolean;
}

export interface SphericalCapDescriptor {
    nMean: THREE.Vector3;
    thetaSpreadRad: number;
    rimSlackRad: number;
    thetaCapRad: number;
    coneAngleLimitRad: number;
    concavityRatio: number;
    isConcave: boolean;
    capRadiusMm: number;
    downwardTriCount: number;
}

export interface KnotWeightedCapOptions {
    knotWeight?: number;
    gravityBias?: number;
    maxUpwardSin?: number;
    softKnee?: boolean;
    target?: THREE.Vector3;
}

export interface PlacementNormalAndCapResult {
    synthesis: PlacementNormalSynthesisResult;
    cap: SphericalCapDescriptor;
}

const MAX_LOCAL_TRIS = 256;
const MAX_CLUSTERS = 32;
const DOWNWARD_NZ_LIMIT = Math.sin((5 * Math.PI) / 180);
const DEFAULT_CAP_LIMIT_RAD = (45 * Math.PI) / 180;
const DEFAULT_CAP_DIHEDRAL_COS = Math.cos((125 * Math.PI) / 180);
const EDGE_BISECTOR_MIN_ANGLE_COS = Math.cos((15 * Math.PI) / 180);
const MIN_AREA = 1e-12;
const CONCAVITY_EPS = 1e-4;

// Zero-heap module-scoped scratch math objects and typed-array pools.
const _worldPoint = new THREE.Vector3();
const _rawNormal = new THREE.Vector3();
const _localPoint = new THREE.Vector3();
const _wA = new THREE.Vector3();
const _wB = new THREE.Vector3();
const _wC = new THREE.Vector3();
const _closestPt = new THREE.Vector3();
const _edgeAB = new THREE.Vector3();
const _edgeAC = new THREE.Vector3();
const _triNormal = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _centroid = new THREE.Vector3();
const _cDir = new THREE.Vector3();
const _sumNormal = new THREE.Vector3();
const _outNormal = new THREE.Vector3();
const _prevVec = new THREE.Vector3();
const _ortho = new THREE.Vector3();
const _refAxis = new THREE.Vector3();
const _knotDir = new THREE.Vector3();
const _desiredVec = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _capNormalSum = new THREE.Vector3();
const _capDirSum = new THREE.Vector3();
const _synthDirSum = new THREE.Vector3();
const _capMean = new THREE.Vector3();
const _nAnchor = new THREE.Vector3();
const _baseDown = new THREE.Vector3();
const _wHitPt = new THREE.Vector3();
const _localRayEnd = new THREE.Vector3();

const _localQueryBox = new THREE.Box3();
const _localRay = new THREE.Ray();
const _worldTri = new THREE.Triangle();
const _invMatrix = new THREE.Matrix4();

const _orbitCapDescriptor: SphericalCapDescriptor = {
    nMean: new THREE.Vector3(),
    thetaSpreadRad: 0,
    rimSlackRad: 0,
    thetaCapRad: 0,
    coneAngleLimitRad: DEFAULT_CAP_LIMIT_RAD,
    concavityRatio: 0,
    isConcave: false,
    capRadiusMm: 0,
    downwardTriCount: 0,
};
const _orbitOutVec = new THREE.Vector3();
const _orbitCapOptions: KnotWeightedCapOptions = { target: _orbitOutVec };

interface BoundedTrianglePool {
    nx: Float64Array;
    ny: Float64Array;
    nz: Float64Array;
    dist: Float64Array;
    area: Float64Array;
    triIndex: Int32Array;
    count: number;
    worstSlot: number;
    worstDist: number;
    worstTriIdx: number;
}

function createBoundedPool(): BoundedTrianglePool {
    return {
        nx: new Float64Array(MAX_LOCAL_TRIS),
        ny: new Float64Array(MAX_LOCAL_TRIS),
        nz: new Float64Array(MAX_LOCAL_TRIS),
        dist: new Float64Array(MAX_LOCAL_TRIS),
        area: new Float64Array(MAX_LOCAL_TRIS),
        triIndex: new Int32Array(MAX_LOCAL_TRIS),
        count: 0,
        worstSlot: 0,
        worstDist: -1,
        worstTriIdx: -1,
    };
}

const _synthPool = createBoundedPool();
const _capPool = createBoundedPool();
const _triOrder = new Int32Array(MAX_LOCAL_TRIS);

// Coplanar clustering pool (MAX_CLUSTERS = 32).
const _clusterSeedNx = new Float64Array(MAX_CLUSTERS);
const _clusterSeedNy = new Float64Array(MAX_CLUSTERS);
const _clusterSeedNz = new Float64Array(MAX_CLUSTERS);
const _clusterSumX = new Float64Array(MAX_CLUSTERS);
const _clusterSumY = new Float64Array(MAX_CLUSTERS);
const _clusterSumZ = new Float64Array(MAX_CLUSTERS);
const _clusterMinDist = new Float64Array(MAX_CLUSTERS);
const _clusterWeightSum = new Float64Array(MAX_CLUSTERS);
const _clusterMinTriIdx = new Int32Array(MAX_CLUSTERS);

interface ResolvedSynthesisParams {
    radius: number;
    blendWidth: number;
    dihedralCos: number;
    deadband: number;
    cosFlat: number;
}

function resetBoundedPool(pool: BoundedTrianglePool): void {
    pool.count = 0;
    pool.worstSlot = 0;
    pool.worstDist = -1;
    pool.worstTriIdx = -1;
}

/** Inserts into a fixed `MAX_LOCAL_TRIS` pool, evicting the largest `(dist, triIndex)` on overflow. */
function pushBoundedPool(
    pool: BoundedTrianglePool,
    nx: number,
    ny: number,
    nz: number,
    dist: number,
    area: number,
    triIndex: number,
): void {
    if (pool.count < MAX_LOCAL_TRIS) {
        const slot = pool.count++;
        pool.nx[slot] = nx;
        pool.ny[slot] = ny;
        pool.nz[slot] = nz;
        pool.dist[slot] = dist;
        pool.area[slot] = area;
        pool.triIndex[slot] = triIndex;
        if (slot === 0 || dist > pool.worstDist || (dist === pool.worstDist && triIndex > pool.worstTriIdx)) {
            pool.worstSlot = slot;
            pool.worstDist = dist;
            pool.worstTriIdx = triIndex;
        }
        return;
    }

    if (dist > pool.worstDist || (dist === pool.worstDist && triIndex >= pool.worstTriIdx)) {
        return;
    }

    const slot = pool.worstSlot;
    pool.nx[slot] = nx;
    pool.ny[slot] = ny;
    pool.nz[slot] = nz;
    pool.dist[slot] = dist;
    pool.area[slot] = area;
    pool.triIndex[slot] = triIndex;

    let worstSlot = 0;
    let worstDist = pool.dist[0];
    let worstTriIdx = pool.triIndex[0];
    for (let i = 1; i < MAX_LOCAL_TRIS; i++) {
        const d = pool.dist[i];
        if (d > worstDist || (d === worstDist && pool.triIndex[i] > worstTriIdx)) {
            worstSlot = i;
            worstDist = d;
            worstTriIdx = pool.triIndex[i];
        }
    }
    pool.worstSlot = worstSlot;
    pool.worstDist = worstDist;
    pool.worstTriIdx = worstTriIdx;
}

function normalizeInto(src: Vec3Like, dst: THREE.Vector3, fallbackX = 0, fallbackY = 0, fallbackZ = 1): boolean {
    dst.set(src.x, src.y, src.z);
    const lenSq = dst.lengthSq();
    if (!Number.isFinite(lenSq) || lenSq < 1e-12) {
        dst.set(fallbackX, fallbackY, fallbackZ).normalize();
        return false;
    }
    dst.multiplyScalar(1 / Math.sqrt(lenSq));
    return true;
}

function clampNormalMaxZ(vec: THREE.Vector3, maxUpwardSin: number): void {
    if (vec.z <= maxUpwardSin) return;
    const targetZ = maxUpwardSin - 1e-12;
    const horizLen = Math.hypot(vec.x, vec.y);
    if (horizLen > 1e-9) {
        const horizScale = Math.sqrt(Math.max(0, 1 - targetZ * targetZ)) / horizLen;
        vec.set(vec.x * horizScale, vec.y * horizScale, targetZ).normalize();
    } else {
        vec.set(0, 0, -1);
    }
    if (vec.z > maxUpwardSin) {
        vec.z = maxUpwardSin;
    }
}

function resolveSynthesisParams(options: PlacementNormalSynthesisOptions): ResolvedSynthesisParams {
    const contactRadius = Number.isFinite(options.contactRadiusMm) ? options.contactRadiusMm : 0.15;
    const dDisk = 2 * Math.max(0.05, contactRadius);
    const scale = THREE.MathUtils.clamp(options.sampleRadiusScale ?? 1.0, 0.5, 1.5);
    const flatDeg = THREE.MathUtils.clamp(options.flatThresholdDeg ?? 5, 0, 45);
    const cosFlat = Math.cos((flatDeg * Math.PI) / 180);
    const deadbandScale = Math.max(0, options.deadbandScale ?? 1.0);
    const hasCreaseOverride = options.creaseThresholdDeg !== undefined && options.creaseThresholdDeg > 0;

    if (options.mode === 'crease-lock') {
        const radius = Math.max(0.45, 0.5 * dDisk * scale);
        const creaseDeg = hasCreaseOverride ? options.creaseThresholdDeg! : 55;
        return {
            radius,
            blendWidth: radius,
            dihedralCos: Math.cos((creaseDeg * Math.PI) / 180),
            deadband: 0,
            cosFlat,
        };
    }

    if (options.mode === 'macro-smooth') {
        const radius = Math.min(2.5, Math.max(0.75, 1.5 * dDisk * scale));
        const creaseDeg = hasCreaseOverride ? options.creaseThresholdDeg! : 125;
        return {
            radius,
            blendWidth: radius,
            dihedralCos: Math.cos((creaseDeg * Math.PI) / 180),
            deadband: 0,
            cosFlat,
        };
    }

    // Default: 'bisector'
    const radius = Math.max(0.45, dDisk * scale);
    const blendWidth = Math.min(radius, Math.max(0.30, 0.75 * dDisk * scale));
    const creaseDeg = hasCreaseOverride ? options.creaseThresholdDeg! : 125;
    const deadband = options.isDiskHudDrag
        ? 0
        : THREE.MathUtils.clamp(0.375 * dDisk * deadbandScale, 0, 0.65 * blendWidth);
    return {
        radius,
        blendWidth,
        dihedralCos: Math.cos((creaseDeg * Math.PI) / 180),
        deadband,
        cosFlat,
    };
}

function resolveCapRadiusMm(contactRadiusMm: number): number {
    const contactRadius = Number.isFinite(contactRadiusMm) ? contactRadiusMm : 0.15;
    const dDisk = 2 * Math.max(0.05, contactRadius);
    return Math.max(0.45, 1.5 * dDisk);
}

function getBoundsTree(mesh: THREE.Mesh): MeshBVH | undefined {
    const geom = modelGeometryOf(mesh) as THREE.BufferGeometry & { boundsTree?: MeshBVH };
    const bvh = geom?.boundsTree;
    return bvh && typeof bvh.shapecast === 'function' ? bvh : undefined;
}

function sortPoolByDistThenTriIndex(pool: BoundedTrianglePool): void {
    const count = pool.count;
    for (let i = 0; i < count; i++) {
        _triOrder[i] = i;
    }
    for (let i = 1; i < count; i++) {
        const keySlot = _triOrder[i];
        const keyDist = pool.dist[keySlot];
        const keyTriIdx = pool.triIndex[keySlot];
        let j = i - 1;
        while (j >= 0) {
            const curSlot = _triOrder[j];
            const curDist = pool.dist[curSlot];
            if (curDist < keyDist || (curDist === keyDist && pool.triIndex[curSlot] <= keyTriIdx)) {
                break;
            }
            _triOrder[j + 1] = curSlot;
            j -= 1;
        }
        _triOrder[j + 1] = keySlot;
    }
}

function applyDragSlerpClamp(normal: THREE.Vector3, prevNormal: Vec3Like, maxStepDeg: number): void {
    if (!normalizeInto(prevNormal, _prevVec)) return;
    const clampedDeg = Math.max(0, maxStepDeg);
    if (clampedDeg >= 180) return;

    const maxStepRad = (clampedDeg * Math.PI) / 180;
    const dot = THREE.MathUtils.clamp(_prevVec.dot(normal), -1, 1);
    const angle = Math.acos(dot);
    if (angle <= maxStepRad + 1e-9) return;

    const sinAngle = Math.sin(angle);
    if (sinAngle > 1e-6) {
        const w0 = Math.sin(angle - maxStepRad) / sinAngle;
        const w1 = Math.sin(maxStepRad) / sinAngle;
        normal
            .set(
                _prevVec.x * w0 + normal.x * w1,
                _prevVec.y * w0 + normal.y * w1,
                _prevVec.z * w0 + normal.z * w1,
            )
            .normalize();
        return;
    }

    // Near-antipodal fallback: rotate smoothly along an orthogonal axis perpendicular to prevNormal.
    if (Math.abs(_prevVec.x) < 0.9) {
        _refAxis.set(1, 0, 0);
    } else {
        _refAxis.set(0, 1, 0);
    }
    _ortho.crossVectors(_prevVec, _refAxis).normalize();
    normal
        .copy(_prevVec)
        .multiplyScalar(Math.cos(maxStepRad))
        .addScaledVector(_ortho, Math.sin(maxStepRad))
        .normalize();
}

function evaluateMacroSmooth(pool: BoundedTrianglePool, radius: number, cosFlat: number): PlacementNormalRegime {
    const clipAreaMax = Math.PI * radius * radius;
    const twoSigmaSq = 0.5 * radius * radius;
    _sumNormal.set(0, 0, 0);
    let minDotToRaw = 1;

    for (let i = 0; i < pool.count; i++) {
        const slot = _triOrder[i];
        const dist = pool.dist[slot];
        const areaClip = Math.min(pool.area[slot], clipAreaMax);
        const weight = areaClip * Math.exp(-(dist * dist) / twoSigmaSq);
        const nx = pool.nx[slot];
        const ny = pool.ny[slot];
        const nz = pool.nz[slot];
        _sumNormal.x += nx * weight;
        _sumNormal.y += ny * weight;
        _sumNormal.z += nz * weight;
        const dRaw = nx * _rawNormal.x + ny * _rawNormal.y + nz * _rawNormal.z;
        if (dRaw < minDotToRaw) minDotToRaw = dRaw;
    }

    const lenSq = _sumNormal.lengthSq();
    if (!Number.isFinite(lenSq) || lenSq < 1e-12) {
        _outNormal.copy(_rawNormal);
        return 'raw';
    }
    _outNormal.copy(_sumNormal).multiplyScalar(1 / Math.sqrt(lenSq));
    return minDotToRaw >= cosFlat ? 'flat' : 'curved';
}

function evaluateCoplanarClusters(
    pool: BoundedTrianglePool,
    params: ResolvedSynthesisParams,
): PlacementNormalRegime {
    const { radius, blendWidth, deadband, cosFlat } = params;
    const clipAreaMax = Math.PI * radius * radius;
    const denom = Math.max(1e-6, blendWidth - deadband);

    // Seed C_0 at d_0 = 0 with normalized n_0.
    let clusterCount = 1;
    _clusterSeedNx[0] = _rawNormal.x;
    _clusterSeedNy[0] = _rawNormal.y;
    _clusterSeedNz[0] = _rawNormal.z;
    _clusterSumX[0] = 0;
    _clusterSumY[0] = 0;
    _clusterSumZ[0] = 0;
    _clusterMinDist[0] = 0;
    _clusterWeightSum[0] = 0;
    _clusterMinTriIdx[0] = -1;

    for (let i = 0; i < pool.count; i++) {
        const slot = _triOrder[i];
        const nx = pool.nx[slot];
        const ny = pool.ny[slot];
        const nz = pool.nz[slot];
        const dist = pool.dist[slot];
        const triIdx = pool.triIndex[slot];
        const triWeight = Math.max(1e-6 * radius, radius - dist + 1e-3 * radius) * Math.min(pool.area[slot], clipAreaMax);

        let targetCluster = -1;
        let bestDot = -2;
        for (let k = 0; k < clusterCount; k++) {
            const dot = nx * _clusterSeedNx[k] + ny * _clusterSeedNy[k] + nz * _clusterSeedNz[k];
            if (dot >= cosFlat && dot > bestDot) {
                bestDot = dot;
                targetCluster = k;
            }
        }

        if (targetCluster === -1) {
            if (clusterCount < MAX_CLUSTERS) {
                targetCluster = clusterCount++;
                _clusterSeedNx[targetCluster] = nx;
                _clusterSeedNy[targetCluster] = ny;
                _clusterSeedNz[targetCluster] = nz;
                _clusterSumX[targetCluster] = 0;
                _clusterSumY[targetCluster] = 0;
                _clusterSumZ[targetCluster] = 0;
                _clusterMinDist[targetCluster] = dist;
                _clusterMinTriIdx[targetCluster] = triIdx;
                _clusterWeightSum[targetCluster] = 0;
            } else {
                // Overflow fallback: merge into closest existing cluster seed (k >= 1).
                let fallbackCluster = 1;
                let fallbackDot = -2;
                for (let k = 1; k < clusterCount; k++) {
                    const dot = nx * _clusterSeedNx[k] + ny * _clusterSeedNy[k] + nz * _clusterSeedNz[k];
                    if (dot > fallbackDot) {
                        fallbackDot = dot;
                        fallbackCluster = k;
                    }
                }
                targetCluster = fallbackCluster;
            }
        }

        _clusterSumX[targetCluster] += nx * triWeight;
        _clusterSumY[targetCluster] += ny * triWeight;
        _clusterSumZ[targetCluster] += nz * triWeight;
        _clusterWeightSum[targetCluster] += triWeight;

        if (
            targetCluster > 0
            && (dist < _clusterMinDist[targetCluster]
                || (dist === _clusterMinDist[targetCluster] && triIdx < _clusterMinTriIdx[targetCluster]))
        ) {
            _clusterMinDist[targetCluster] = dist;
            _clusterMinTriIdx[targetCluster] = triIdx;
        }
    }

    let c0x = _rawNormal.x;
    let c0y = _rawNormal.y;
    let c0z = _rawNormal.z;
    if (_clusterWeightSum[0] > 0) {
        const len = Math.hypot(_clusterSumX[0], _clusterSumY[0], _clusterSumZ[0]);
        if (len > 1e-12) {
            c0x = _clusterSumX[0] / len;
            c0y = _clusterSumY[0] / len;
            c0z = _clusterSumZ[0] / len;
        }
    }

    _sumNormal.set(c0x, c0y, c0z);
    let activeNeighbors = 0;
    let minActiveNeighborDot = 1;

    for (let k = 1; k < clusterCount; k++) {
        const dK = _clusterMinDist[k];
        const u = THREE.MathUtils.clamp((dK - deadband) / denom, 0, 1);
        const wK = 1 - (3 * u * u - 2 * u * u * u);
        if (wK <= 0) continue;

        const len = Math.hypot(_clusterSumX[k], _clusterSumY[k], _clusterSumZ[k]);
        if (len <= 1e-12) continue;
        const ckx = _clusterSumX[k] / len;
        const cky = _clusterSumY[k] / len;
        const ckz = _clusterSumZ[k] / len;

        _sumNormal.x += ckx * wK;
        _sumNormal.y += cky * wK;
        _sumNormal.z += ckz * wK;
        activeNeighbors += 1;

        const dot0K = c0x * ckx + c0y * cky + c0z * ckz;
        if (dot0K < minActiveNeighborDot) {
            minActiveNeighborDot = dot0K;
        }
    }

    const finalLenSq = _sumNormal.lengthSq();
    if (!Number.isFinite(finalLenSq) || finalLenSq < 1e-12) {
        _outNormal.copy(_rawNormal);
        return 'raw';
    }
    _outNormal.copy(_sumNormal).multiplyScalar(1 / Math.sqrt(finalLenSq));

    if (activeNeighbors === 0) return 'flat';
    return minActiveNeighborDot < EDGE_BISECTOR_MIN_ANGLE_COS ? 'edge-bisector' : 'curved';
}

function writeSynthesisResult(
    normal: THREE.Vector3,
    regime: PlacementNormalRegime,
    acceptedSphereTris: number,
    thetaSpreadRad = 0,
    isConcave = false,
    target?: PlacementNormalSynthesisResult,
): PlacementNormalSynthesisResult {
    if (target) {
        target.normal.copy(normal);
        target.regime = regime;
        target.acceptedSphereTris = acceptedSphereTris;
        target.thetaSpreadRad = thetaSpreadRad;
        target.isConcave = isConcave;
        return target;
    }
    return {
        normal: normal.clone(),
        regime,
        acceptedSphereTris,
        thetaSpreadRad,
        isConcave,
    };
}

function writeCapDescriptor(
    nMean: THREE.Vector3,
    thetaSpreadRad: number,
    rimSlackRad: number,
    thetaCapRad: number,
    coneAngleLimitRad: number,
    concavityRatio: number,
    isConcave: boolean,
    capRadiusMm: number,
    downwardTriCount: number,
    target?: SphericalCapDescriptor,
): SphericalCapDescriptor {
    if (target) {
        target.nMean.copy(nMean);
        target.thetaSpreadRad = thetaSpreadRad;
        target.rimSlackRad = rimSlackRad;
        target.thetaCapRad = thetaCapRad;
        target.coneAngleLimitRad = coneAngleLimitRad;
        target.concavityRatio = concavityRatio;
        target.isConcave = isConcave;
        target.capRadiusMm = capRadiusMm;
        target.downwardTriCount = downwardTriCount;
        return target;
    }
    return {
        nMean: nMean.clone(),
        thetaSpreadRad,
        rimSlackRad,
        thetaCapRad,
        coneAngleLimitRad,
        concavityRatio,
        isConcave,
        capRadiusMm,
        downwardTriCount,
    };
}

function buildFallbackCap(capRadiusMm: number, leafRimSlackDeg: number, target?: SphericalCapDescriptor): SphericalCapDescriptor {
    _capMean.copy(_rawNormal);
    clampNormalMaxZ(_capMean, DOWNWARD_NZ_LIMIT);
    const rimSlackRad = THREE.MathUtils.degToRad(Math.max(0, leafRimSlackDeg));
    const thetaCapRad = Math.min(DEFAULT_CAP_LIMIT_RAD, rimSlackRad);
    return writeCapDescriptor(
        _capMean,
        0,
        rimSlackRad,
        thetaCapRad,
        DEFAULT_CAP_LIMIT_RAD,
        0,
        false,
        capRadiusMm,
        0,
        target,
    );
}

function finalizeSynthesis(
    synthOptions: PlacementNormalSynthesisOptions,
    params: ResolvedSynthesisParams,
    acceptedSphereTris: number,
    synthDirWeightSum: number,
    target?: PlacementNormalSynthesisResult,
): PlacementNormalSynthesisResult {
    let regime: PlacementNormalRegime;
    if (acceptedSphereTris === 0 || _synthPool.count === 0) {
        _outNormal.copy(_rawNormal);
        regime = 'raw';
    } else {
        sortPoolByDistThenTriIndex(_synthPool);
        regime = synthOptions.mode === 'macro-smooth'
            ? evaluateMacroSmooth(_synthPool, params.radius, params.cosFlat)
            : evaluateCoplanarClusters(_synthPool, params);
    }

    if (synthOptions.isDiskHudDrag && synthOptions.prevNormal) {
        applyDragSlerpClamp(_outNormal, synthOptions.prevNormal, synthOptions.maxDragStepDeg ?? 15);
    }

    let thetaSpreadRad = 0;
    let isConcave = false;
    if (regime !== 'raw' && _synthPool.count > 0) {
        for (let i = 0; i < _synthPool.count; i++) {
            const dot = THREE.MathUtils.clamp(
                _synthPool.nx[i] * _outNormal.x
                + _synthPool.ny[i] * _outNormal.y
                + _synthPool.nz[i] * _outNormal.z,
                -1,
                1,
            );
            const u = params.radius > 1e-9
                ? THREE.MathUtils.clamp(_synthPool.dist[i] / params.radius, 0, 1)
                : 0;
            const tau = (1 - u) * (1 - u);
            const ang = tau * Math.acos(dot);
            if (ang > thetaSpreadRad) thetaSpreadRad = ang;
        }
        isConcave = synthDirWeightSum > 0 && (_synthDirSum.dot(_outNormal) / synthDirWeightSum) > CONCAVITY_EPS;
    }

    return writeSynthesisResult(_outNormal, regime, acceptedSphereTris, thetaSpreadRad, isConcave, target);
}

function finalizeCapDescriptor(
    capTriTotal: number,
    capWeightSum: number,
    capRadiusMm: number,
    leafRimSlackDeg: number,
    synthesisNormal?: THREE.Vector3 | null,
    target?: SphericalCapDescriptor,
): SphericalCapDescriptor {
    if (capTriTotal === 0 || capWeightSum <= 0 || _capNormalSum.lengthSq() < 1e-12) {
        return buildFallbackCap(capRadiusMm, leafRimSlackDeg, target);
    }

    _capMean.copy(_capNormalSum).normalize();
    clampNormalMaxZ(_capMean, DOWNWARD_NZ_LIMIT);

    let thetaSpreadRad = 0;
    for (let i = 0; i < _capPool.count; i++) {
        const dot = THREE.MathUtils.clamp(
            _capPool.nx[i] * _capMean.x + _capPool.ny[i] * _capMean.y + _capPool.nz[i] * _capMean.z,
            -1,
            1,
        );
        const u = capRadiusMm > 1e-9 ? THREE.MathUtils.clamp(_capPool.dist[i] / capRadiusMm, 0, 1) : 0;
        const tau = (1 - u) * (1 - u);
        const ang = tau * Math.acos(dot);
        if (ang > thetaSpreadRad) thetaSpreadRad = ang;
    }

    if (synthesisNormal) {
        _baseDown.copy(synthesisNormal);
        clampNormalMaxZ(_baseDown, DOWNWARD_NZ_LIMIT);
        const baseDot = THREE.MathUtils.clamp(_capMean.dot(_baseDown), -1, 1);
        const baseAng = Math.acos(baseDot);
        if (baseAng > thetaSpreadRad) {
            const delta = 0.5 * (baseAng - thetaSpreadRad);
            _tangent.copy(_baseDown).addScaledVector(_capMean, -baseDot);
            const tanLenSq = _tangent.lengthSq();
            if (tanLenSq > 1e-12) {
                _tangent.multiplyScalar(1 / Math.sqrt(tanLenSq));
                _capMean
                    .multiplyScalar(Math.cos(delta))
                    .addScaledVector(_tangent, Math.sin(delta))
                    .normalize();
                clampNormalMaxZ(_capMean, DOWNWARD_NZ_LIMIT);
            }
            thetaSpreadRad += delta;
        }
    }

    const concavityRatio = _capDirSum.dot(_capMean) / capWeightSum;
    const isConcave = concavityRatio > CONCAVITY_EPS;
    const rimSlackRad = isConcave ? 0 : THREE.MathUtils.degToRad(Math.max(0, leafRimSlackDeg));
    const thetaCapRad = Math.min(DEFAULT_CAP_LIMIT_RAD, thetaSpreadRad + rimSlackRad);

    return writeCapDescriptor(
        _capMean,
        thetaSpreadRad,
        rimSlackRad,
        thetaCapRad,
        DEFAULT_CAP_LIMIT_RAD,
        concavityRatio,
        isConcave,
        capRadiusMm,
        capTriTotal,
        target,
    );
}

function setLocalQueryBox(matrixWorld: THREE.Matrix4, radius: number): void {
    _invMatrix.copy(matrixWorld).invert();
    _localPoint.copy(_worldPoint).applyMatrix4(_invMatrix);
    const e = _invMatrix.elements;
    const hx = radius * Math.hypot(e[0], e[4], e[8]);
    const hy = radius * Math.hypot(e[1], e[5], e[9]);
    const hz = radius * Math.hypot(e[2], e[6], e[10]);
    _localQueryBox.min.set(_localPoint.x - hx, _localPoint.y - hy, _localPoint.z - hz);
    _localQueryBox.max.set(_localPoint.x + hx, _localPoint.y + hy, _localPoint.z + hz);
}

function executeSharedShapecast(
    mesh: THREE.Mesh,
    worldPoint: Vec3Like,
    rawWorldNormal: Vec3Like,
    wantSynthesis: boolean,
    synthOptions: PlacementNormalSynthesisOptions | null,
    wantCap: boolean,
    capRadiusMm: number,
    leafRimSlackDeg: number,
    synthTarget?: PlacementNormalSynthesisResult,
    capTarget?: SphericalCapDescriptor,
): { synthesis: PlacementNormalSynthesisResult | null; cap: SphericalCapDescriptor | null } {
    normalizeInto(rawWorldNormal, _rawNormal);
    _worldPoint.set(worldPoint.x, worldPoint.y, worldPoint.z);

    const bvh = getBoundsTree(mesh);
    const det = bvh ? mesh.matrixWorld.determinant() : 0;
    if (!bvh || !Number.isFinite(det) || Math.abs(det) < 1e-18) {
        return {
            synthesis: wantSynthesis ? writeSynthesisResult(_rawNormal, 'raw', 0, 0, false, synthTarget) : null,
            cap: wantCap ? buildFallbackCap(capRadiusMm, leafRimSlackDeg, capTarget) : null,
        };
    }

    const detSign = det < 0 ? -1 : 1;
    const params = wantSynthesis && synthOptions ? resolveSynthesisParams(synthOptions) : null;
    const rSynth = params ? params.radius : 0;
    const rSynthSq = rSynth * rSynth;
    const rCap = wantCap ? capRadiusMm : 0;
    const rCapSq = rCap * rCap;
    const rQuery = Math.max(rSynth, rCap);
    const rQuerySq = rQuery * rQuery;
    const capClipAreaMax = Math.PI * rCap * rCap;
    const synthDihedralCos = params ? params.dihedralCos : DEFAULT_CAP_DIHEDRAL_COS;

    setLocalQueryBox(mesh.matrixWorld, rQuery);
    resetBoundedPool(_synthPool);
    resetBoundedPool(_capPool);

    let acceptedSphereTris = 0;
    let synthDirWeightSum = 0;
    let capTriTotal = 0;
    let capWeightSum = 0;
    _synthDirSum.set(0, 0, 0);
    _capNormalSum.set(0, 0, 0);
    _capDirSum.set(0, 0, 0);

    bvh.shapecast({
        intersectsBounds: (box: THREE.Box3) => {
            if (!_localQueryBox.intersectsBox(box)) return NOT_INTERSECTED;
            return _localQueryBox.containsBox(box) ? CONTAINED : INTERSECTED;
        },
        intersectsTriangle: (tri, triIndex) => {
            _wA.copy(tri.a).applyMatrix4(mesh.matrixWorld);
            _wB.copy(tri.b).applyMatrix4(mesh.matrixWorld);
            _wC.copy(tri.c).applyMatrix4(mesh.matrixWorld);
            _worldTri.set(_wA, _wB, _wC);
            _worldTri.closestPointToPoint(_worldPoint, _closestPt);

            const distSq = _closestPt.distanceToSquared(_worldPoint);
            if (distSq > rQuerySq) return false;

            _edgeAB.subVectors(_wB, _wA);
            _edgeAC.subVectors(_wC, _wA);
            _triNormal.crossVectors(_edgeAB, _edgeAC);
            const crossLen = Math.sqrt(_triNormal.lengthSq());
            const area = 0.5 * crossLen;
            if (!Number.isFinite(area) || area <= MIN_AREA) return false;

            _triNormal.multiplyScalar(detSign / crossLen);
            const dot0 = _triNormal.dot(_rawNormal);
            if (dot0 < 0.1) {
                _delta.subVectors(_closestPt, _worldPoint);
                if (_delta.dot(_rawNormal) < -0.05 && -_delta.dot(_triNormal) < 0) {
                    return false;
                }
            }

            const dist = Math.sqrt(distSq);

            if (params && distSq <= rSynthSq && dot0 >= synthDihedralCos) {
                acceptedSphereTris += 1;
                pushBoundedPool(_synthPool, _triNormal.x, _triNormal.y, _triNormal.z, dist, area, triIndex);
                const uSynth = rSynth > 1e-9 ? THREE.MathUtils.clamp(dist / rSynth, 0, 1) : 0;
                const wSynth = area * (1 - uSynth) * (1 - uSynth);
                if (wSynth > 0) {
                    _centroid.copy(_wA).add(_wB).add(_wC).multiplyScalar(1 / 3);
                    _cDir.subVectors(_centroid, _closestPt);
                    const cLenSq = _cDir.lengthSq();
                    if (cLenSq > 1e-18) {
                        const invCLen = 1 / Math.sqrt(cLenSq);
                        _synthDirSum.x += _cDir.x * invCLen * wSynth;
                        _synthDirSum.y += _cDir.y * invCLen * wSynth;
                        _synthDirSum.z += _cDir.z * invCLen * wSynth;
                        synthDirWeightSum += wSynth;
                    }
                }
            }

            if (wantCap && distSq <= rCapSq && _triNormal.z <= DOWNWARD_NZ_LIMIT && dot0 >= DEFAULT_CAP_DIHEDRAL_COS) {
                capTriTotal += 1;
                const u = THREE.MathUtils.clamp(dist / rCap, 0, 1);
                const w = Math.min(area, capClipAreaMax) * (1 - u) * (1 - u);
                if (w > 0) {
                    _capNormalSum.x += _triNormal.x * w;
                    _capNormalSum.y += _triNormal.y * w;
                    _capNormalSum.z += _triNormal.z * w;
                    capWeightSum += w;

                    _centroid.copy(_wA).add(_wB).add(_wC).multiplyScalar(1 / 3);
                    _cDir.subVectors(_centroid, _closestPt);
                    const cLenSq = _cDir.lengthSq();
                    if (cLenSq > 1e-18) {
                        const invCLen = 1 / Math.sqrt(cLenSq);
                        _capDirSum.x += _cDir.x * invCLen * w;
                        _capDirSum.y += _cDir.y * invCLen * w;
                        _capDirSum.z += _cDir.z * invCLen * w;
                    }
                }
                pushBoundedPool(_capPool, _triNormal.x, _triNormal.y, _triNormal.z, dist, area, triIndex);
            }

            return false;
        },
    });

    const synthesis = wantSynthesis && synthOptions && params
        ? finalizeSynthesis(synthOptions, params, acceptedSphereTris, synthDirWeightSum, synthTarget)
        : null;
    const expansionSynthesisNormal =
        wantCap && synthesis && synthesis.regime !== 'raw' && capTriTotal > 0
            ? synthesis.normal
            : null;

    return {
        synthesis,
        cap: wantCap
            ? finalizeCapDescriptor(capTriTotal, capWeightSum, rCap, leafRimSlackDeg, expansionSynthesisNormal, capTarget)
            : null,
    };
}

/**
 * Synthesizes a smooth placement surface normal around `worldPoint` using strictly
 * read-only BVH queries against `modelGeometryOf(mesh)` (Issue #797 compliant).
 */
export function synthesizePlacementNormal(
    mesh: THREE.Mesh,
    worldPoint: Vec3Like | THREE.Vector3,
    rawWorldNormal: Vec3Like | THREE.Vector3,
    options: PlacementNormalSynthesisOptions,
    target?: PlacementNormalSynthesisResult,
): PlacementNormalSynthesisResult {
    if (options.mode === 'raw') {
        normalizeInto(rawWorldNormal, _rawNormal);
        return writeSynthesisResult(_rawNormal, 'raw', 0, 0, false, target);
    }

    const { synthesis } = executeSharedShapecast(
        mesh,
        worldPoint,
        rawWorldNormal,
        true,
        options,
        false,
        0,
        0,
        target,
        undefined,
    );
    return synthesis!;
}

/**
 * Extracts a downward spherical-cap descriptor (`G2`) around `worldPoint` using
 * closest-point radial kernel `K(u) = (1 - d_t / R_cap)^2` and normalized concavity test.
 */
export function extractSphericalCapDescriptor(
    mesh: THREE.Mesh,
    worldPoint: Vec3Like | THREE.Vector3,
    rawNormal: Vec3Like | THREE.Vector3,
    contactRadiusMm: number,
    leafRimSlackDeg = 0,
    target?: SphericalCapDescriptor,
): SphericalCapDescriptor {
    const capRadiusMm = resolveCapRadiusMm(contactRadiusMm);
    const { cap } = executeSharedShapecast(
        mesh,
        worldPoint,
        rawNormal,
        false,
        null,
        true,
        capRadiusMm,
        leafRimSlackDeg,
        undefined,
        target,
    );
    return cap!;
}

/**
 * Orbits a contact normal inside `capDescriptor` toward `candidateKnot` using a
 * `C^1` `tanh` soft-knee clamp and enforces the `n_z <= sin(5°)` downward floor guard.
 */
export function resolveKnotWeightedCapNormal(
    worldPoint: Vec3Like | THREE.Vector3,
    candidateKnot: Vec3Like | THREE.Vector3,
    capDescriptor: SphericalCapDescriptor,
    rawNormal: Vec3Like | THREE.Vector3,
    baseSynthesisNormal: Vec3Like | THREE.Vector3,
    coneMaxAngleRad: number,
    options?: KnotWeightedCapOptions,
): THREE.Vector3 {
    const out = options?.target ?? new THREE.Vector3();

    if (capDescriptor.downwardTriCount > 0) {
        normalizeInto(capDescriptor.nMean, _nAnchor);
    } else if (!normalizeInto(baseSynthesisNormal, _nAnchor)) {
        normalizeInto(rawNormal, _nAnchor, 0, 0, -1);
    }

    if (!normalizeInto(baseSynthesisNormal, _desiredVec)) {
        _desiredVec.copy(_nAnchor);
    }

    _knotDir.set(
        candidateKnot.x - worldPoint.x,
        candidateKnot.y - worldPoint.y,
        candidateKnot.z - worldPoint.z,
    );
    const knotLenSq = _knotDir.lengthSq();
    if (Number.isFinite(knotLenSq) && knotLenSq > 1e-12) {
        _knotDir.multiplyScalar(1 / Math.sqrt(knotLenSq));
    } else {
        _knotDir.copy(_desiredVec);
    }

    const beta = THREE.MathUtils.clamp(options?.knotWeight ?? 1.0, 0, 1);
    const gravityBias = options?.gravityBias ?? 0;
    _desiredVec.multiplyScalar(1 - beta).addScaledVector(_knotDir, beta);
    if (gravityBias !== 0) {
        _desiredVec.z -= gravityBias;
    }
    const desiredLenSq = _desiredVec.lengthSq();
    if (Number.isFinite(desiredLenSq) && desiredLenSq > 1e-12) {
        _desiredVec.multiplyScalar(1 / Math.sqrt(desiredLenSq));
    } else {
        _desiredVec.copy(_nAnchor);
    }

    const thetaLimit = Math.max(0, Math.min(capDescriptor.thetaCapRad, coneMaxAngleRad));
    const dot = THREE.MathUtils.clamp(_nAnchor.dot(_desiredVec), -1, 1);
    const theta = Math.acos(dot);

    if (thetaLimit <= 1e-6 || theta <= 1e-9) {
        out.copy(_nAnchor);
    } else {
        const thetaClamped = options?.softKnee === false
            ? Math.min(theta, thetaLimit)
            : thetaLimit * Math.tanh(theta / thetaLimit);

        _tangent.copy(_desiredVec).addScaledVector(_nAnchor, -dot);
        const tanLenSq = _tangent.lengthSq();
        if (tanLenSq > 1e-12) {
            _tangent.multiplyScalar(1 / Math.sqrt(tanLenSq));
        } else {
            if (Math.abs(_nAnchor.x) < 0.9) {
                _refAxis.set(1, 0, 0);
            } else {
                _refAxis.set(0, 1, 0);
            }
            _tangent.crossVectors(_nAnchor, _refAxis).normalize();
        }

        out
            .copy(_nAnchor)
            .multiplyScalar(Math.cos(thetaClamped))
            .addScaledVector(_tangent, Math.sin(thetaClamped))
            .normalize();
    }

    const maxUpwardSin = options?.maxUpwardSin ?? DOWNWARD_NZ_LIMIT;
    clampNormalMaxZ(out, maxUpwardSin);
    return out;
}

/**
 * Computes both placement normal synthesis and `G2` spherical-cap descriptor in
 * a single BVH `shapecast` pass (zero redundant tree traversals).
 */
export function resolvePlacementNormalAndCap(
    mesh: THREE.Mesh,
    worldPoint: Vec3Like | THREE.Vector3,
    rawWorldNormal: Vec3Like | THREE.Vector3,
    options: PlacementNormalSynthesisOptions & { leafRimSlackDeg?: number },
    synthesisTarget?: PlacementNormalSynthesisResult,
    capTarget?: SphericalCapDescriptor,
): PlacementNormalAndCapResult {
    const capRadiusMm = resolveCapRadiusMm(options.contactRadiusMm);
    const leafRimSlackDeg = options.leafRimSlackDeg ?? 0;

    if (options.mode === 'raw') {
        const cap = extractSphericalCapDescriptor(
            mesh,
            worldPoint,
            rawWorldNormal,
            options.contactRadiusMm,
            leafRimSlackDeg,
            capTarget,
        );
        normalizeInto(rawWorldNormal, _rawNormal);
        const synthesis = writeSynthesisResult(_rawNormal, 'raw', 0, 0, false, synthesisTarget);
        return { synthesis, cap };
    }

    const { synthesis, cap } = executeSharedShapecast(
        mesh,
        worldPoint,
        rawWorldNormal,
        true,
        options,
        true,
        capRadiusMm,
        leafRimSlackDeg,
        synthesisTarget,
        capTarget,
    );
    return { synthesis: synthesis!, cap: cap! };
}

/**
 * Builds a plain-cloned runtime `LeafCapAnchor` from a downward spherical-cap descriptor,
 * returning `undefined` when no downward cap triangles exist and the base normal faces upward.
 */
export function buildLeafCapAnchor(
    worldPoint: Vec3Like,
    cap: SphericalCapDescriptor,
    baseSynthesisNormal: Vec3Like,
): LeafCapAnchor | undefined {
    if (cap.downwardTriCount === 0 && baseSynthesisNormal.z > DOWNWARD_NZ_LIMIT) {
        return undefined;
    }

    return {
        nMean: { x: cap.nMean.x, y: cap.nMean.y, z: cap.nMean.z },
        baseNormal: { x: baseSynthesisNormal.x, y: baseSynthesisNormal.y, z: baseSynthesisNormal.z },
        thetaSpreadRad: cap.thetaSpreadRad,
        rimSlackRad: cap.rimSlackRad,
        thetaCapRad: cap.thetaCapRad,
        coneAngleLimitRad: cap.coneAngleLimitRad,
        isConcave: cap.isConcave,
        downwardTriCount: cap.downwardTriCount,
        tipPos: { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z },
    };
}

/**
 * Orbits a leaf contact normal inside `capAnchor` toward `knotPos` using pooled
 * scratch math (`0` heap allocations when `target` is passed).
 */
export function orbitLeafCapAnchorTowardKnot(
    tipPos: Vec3Like,
    knotPos: Vec3Like,
    capAnchor: LeafCapAnchor,
    coneMaxAngleRad = DEFAULT_CAP_LIMIT_RAD,
    target?: Vec3,
): Vec3 {
    _orbitCapDescriptor.nMean.set(capAnchor.nMean.x, capAnchor.nMean.y, capAnchor.nMean.z);
    _orbitCapDescriptor.thetaSpreadRad = capAnchor.thetaSpreadRad;
    _orbitCapDescriptor.rimSlackRad = capAnchor.rimSlackRad;
    _orbitCapDescriptor.thetaCapRad = capAnchor.thetaCapRad;
    _orbitCapDescriptor.coneAngleLimitRad = capAnchor.coneAngleLimitRad;
    _orbitCapDescriptor.isConcave = capAnchor.isConcave;
    _orbitCapDescriptor.downwardTriCount = capAnchor.downwardTriCount;

    resolveKnotWeightedCapNormal(
        tipPos,
        knotPos,
        _orbitCapDescriptor,
        capAnchor.baseNormal,
        capAnchor.baseNormal,
        coneMaxAngleRad,
        _orbitCapOptions,
    );

    if (target) {
        target.x = _orbitOutVec.x;
        target.y = _orbitOutVec.y;
        target.z = _orbitOutVec.z;
        return target;
    }

    return {
        x: _orbitOutVec.x,
        y: _orbitOutVec.y,
        z: _orbitOutVec.z,
    };
}

/**
 * Probes inward from `worldPoint` along `-surfaceNormal` using strictly read-only
 * `DoubleSide` BVH raycasts on `modelGeometryOf(mesh)` (Issue #797) to measure thin-wall
 * thickness and return a safe maximum penetration depth `0.45 * wallThicknessMm`.
 */
export function computeThinWallMaxSafePenetrationMm(
    mesh: THREE.Mesh,
    worldPoint: Vec3Like | THREE.Vector3,
    surfaceNormal: Vec3Like | THREE.Vector3,
    maxProbeMm = 0.80,
): number | undefined {
    if (!Number.isFinite(maxProbeMm) || maxProbeMm <= 0.015) return undefined;
    if (
        !Number.isFinite(worldPoint.x)
        || !Number.isFinite(worldPoint.y)
        || !Number.isFinite(worldPoint.z)
    ) {
        return undefined;
    }

    const bvh = getBoundsTree(mesh);
    if (!bvh || typeof bvh.raycastFirst !== 'function') return undefined;
    const geom = modelGeometryOf(mesh);
    const posAttr = geom.getAttribute('position');
    if (!posAttr) return undefined;

    const det = mesh.matrixWorld.determinant();
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return undefined;
    const detSign = det < 0 ? -1 : 1;

    if (!normalizeInto(surfaceNormal, _rawNormal, 0, 0, 0)) return undefined;
    _rawNormal.multiplyScalar(-1);
    _worldPoint.set(worldPoint.x, worldPoint.y, worldPoint.z);

    _invMatrix.copy(mesh.matrixWorld).invert();
    _localRay.origin.copy(_worldPoint).applyMatrix4(_invMatrix);
    _localRayEnd.copy(_worldPoint).addScaledVector(_rawNormal, maxProbeMm).applyMatrix4(_invMatrix);
    _localRay.direction.subVectors(_localRayEnd, _localRay.origin);
    const farLocal = _localRay.direction.length();
    if (!Number.isFinite(farLocal) || !(farLocal > 1e-12)) return undefined;
    _localRay.direction.multiplyScalar(1 / farLocal);

    const stepEps = farLocal * 1e-4;
    let curNear = farLocal * (0.015 / maxProbeMm);

    for (let iter = 0; iter < 4; iter++) {
        if (curNear >= farLocal) break;
        const hit = bvh.raycastFirst(_localRay, THREE.DoubleSide, curNear, farLocal);
        if (!hit) return undefined;
        if (!hit.face) {
            curNear = hit.distance + stepEps;
            continue;
        }

        _wA.fromBufferAttribute(posAttr, hit.face.a).applyMatrix4(mesh.matrixWorld);
        _wB.fromBufferAttribute(posAttr, hit.face.b).applyMatrix4(mesh.matrixWorld);
        _wC.fromBufferAttribute(posAttr, hit.face.c).applyMatrix4(mesh.matrixWorld);
        _edgeAB.subVectors(_wB, _wA);
        _edgeAC.subVectors(_wC, _wA);
        _triNormal.crossVectors(_edgeAB, _edgeAC);
        const crossLenSq = _triNormal.lengthSq();
        if (!Number.isFinite(crossLenSq) || crossLenSq <= 1e-24) {
            curNear = hit.distance + stepEps;
            continue;
        }
        _triNormal.multiplyScalar(detSign / Math.sqrt(crossLenSq));

        if (_rawNormal.dot(_triNormal) > 0.1) {
            const worldDist = _wHitPt.copy(hit.point).applyMatrix4(mesh.matrixWorld).distanceTo(_worldPoint);
            if (worldDist >= 0.015 && worldDist < maxProbeMm) {
                const clamped = Math.round(0.45 * worldDist * 1e6) / 1e6;
                return clamped === 0 ? 0 : clamped;
            }
            return undefined;
        }

        curNear = hit.distance + stepEps;
    }

    return undefined;
}
