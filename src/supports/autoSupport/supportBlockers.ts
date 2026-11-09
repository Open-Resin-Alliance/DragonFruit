import * as THREE from 'three';

export type SupportBlockerListener = () => void;

/**
 * Support blockers ("nogo" paint for supports, M2 of the auto-orientation
 * plan). Per-model set of model-space triangle indices whose surface must
 * never take a support contact, plus the candidate/advisor pruning that
 * enforces it.
 *
 * Deliberately NOT the hollowing voxel blockers: those index a
 * rotation-aligned voxel grid and are cleared on rotation; these index mesh
 * triangles in model space, so they rotate with the model and stay valid
 * across orientation changes. Out-of-range indices (geometry swapped under
 * the mask, e.g. by hollowing) are ignored by every consumer.
 *
 * Store shape mirrors the smoothing brushController: module-level state +
 * version counter, React reads via useSyncExternalStore.
 */

/** Default dab radius (mm); adjustable via the paint-mode slider. */
export const SUPPORT_BLOCKER_BRUSH_RADIUS_MM = 2.5;
export const SUPPORT_BLOCKER_BRUSH_MIN_MM = 0.5;
export const SUPPORT_BLOCKER_BRUSH_MAX_MM = 10;
/** Minimum dab spacing (fraction of radius) — bounds work on fast strokes. */
const DAB_SPACING_FRACTION = 0.5;

let _brushSizeMm = SUPPORT_BLOCKER_BRUSH_RADIUS_MM;

export function getSupportBlockerBrushSizeMm(): number {
    return _brushSizeMm;
}

export function setSupportBlockerBrushSizeMm(next: number): void {
    const clamped = Math.min(SUPPORT_BLOCKER_BRUSH_MAX_MM, Math.max(SUPPORT_BLOCKER_BRUSH_MIN_MM, next));
    if (!Number.isFinite(clamped) || clamped === _brushSizeMm) return;
    _brushSizeMm = clamped;
    notify();
}

interface BlockerEntry {
    tris: Set<number>;
    version: number;
    lastDab: THREE.Vector3 | null;
}

const _entries = new Map<string, BlockerEntry>();
const _listeners = new Set<SupportBlockerListener>();
let _globalVersion = 0;
let _strokeActive = false;

function entryFor(modelId: string): BlockerEntry {
    let entry = _entries.get(modelId);
    if (!entry) {
        entry = { tris: new Set(), version: 0, lastDab: null };
        _entries.set(modelId, entry);
    }
    return entry;
}

function notify(): void {
    _globalVersion++;
    for (const listener of _listeners) listener();
}

export function subscribeSupportBlockers(listener: SupportBlockerListener): () => void {
    _listeners.add(listener);
    return () => {
        _listeners.delete(listener);
    };
}

export function getSupportBlockersVersion(): number {
    return _globalVersion;
}

/** Live blocked-triangle count for one model (drives the Clear affordance). */
export function getSupportBlockedCount(modelId: string): number {
    return _entries.get(modelId)?.tris.size ?? 0;
}

/** Blocked triangles for one model. Consumers copy when they need stability. */
export function getSupportBlockedTriangles(modelId: string): Set<number> {
    return _entries.get(modelId)?.tris ?? new Set<number>();
}

export function isSupportBlocked(modelId: string, triIndex: number): boolean {
    return _entries.get(modelId)?.tris.has(triIndex) ?? false;
}

/**
 * Dab the blocker brush: marks every triangle with a vertex inside the
 * brush radius of the hit point (model-space local frame). Returns
 * the number of newly blocked triangles. Dab-spacing guard keeps fast
 * strokes O(dabs) instead of O(pointer events).
 */
export function paintSupportBlockers(
    modelId: string,
    geometry: THREE.BufferGeometry,
    localPoint: THREE.Vector3,
    radiusMm: number = getSupportBlockerBrushSizeMm(),
): number {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return 0;
    const index = geometry.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    if (triCount <= 0) return 0;

    const entry = entryFor(modelId);
    if (entry.lastDab && entry.lastDab.distanceTo(localPoint) < radiusMm * DAB_SPACING_FRACTION) {
        return 0;
    }
    entry.lastDab = localPoint.clone();

    const r2 = radiusMm * radiusMm;
    // Per-vertex inside/outside, then mark tris touching an inside vertex.
    const inside = new Uint8Array(pos.count);
    const ax = localPoint.x;
    const ay = localPoint.y;
    const az = localPoint.z;
    for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - ax;
        const dy = pos.getY(i) - ay;
        const dz = pos.getZ(i) - az;
        if (dx * dx + dy * dy + dz * dz <= r2) inside[i] = 1;
    }
    let added = 0;
    for (let t = 0; t < triCount; t++) {
        if (entry.tris.has(t)) continue;
        const a = index ? index.getX(t * 3) : t * 3;
        const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (a >= pos.count || b >= pos.count || c >= pos.count) continue;
        if (inside[a] === 1 || inside[b] === 1 || inside[c] === 1) {
            entry.tris.add(t);
            added++;
        }
    }
    if (added > 0) {
        entry.version++;
        notify();
    }
    return added;
}


/** Explicit user clear. Returns true when something was cleared. */
export function clearSupportBlockers(modelId: string): boolean {
    const entry = _entries.get(modelId);
    if (!entry || entry.tris.size === 0) return false;
    entry.tris.clear();
    entry.lastDab = null;
    entry.version++;
    notify();
    return true;
}

/** Stroke boundary — resets the dab-spacing guard and the orbit gate. */
export function endSupportBlockerStroke(modelId: string): void {
    const entry = _entries.get(modelId);
    if (entry) entry.lastDab = null;
    if (_strokeActive) {
        _strokeActive = false;
        notify();
    }
}
export function deleteSupportBlockers(modelId: string): void {
    if (_entries.delete(modelId)) notify();
}

const _contactRaycaster = new THREE.Raycaster();
const _contactOrigin = new THREE.Vector3();
const _contactDirection = new THREE.Vector3(0, 0, 1);

/**
 * Whether a support contact at the given world point lands on blocked
 * surface. The known raycast face short-circuits (grid lattice path); otherwise
 * an upward ray from just below the point resolves the contact face — the
 * same underside the generator would attach to. Empty mask → false with no
 * raycast, so unpainted models pay nothing.
 */
export function isSupportBlockedContact(
    modelId: string,
    mesh: THREE.Mesh,
    x: number,
    y: number,
    z: number,
    knownFaceIndex?: number | null,
): boolean {
    const entry = _entries.get(modelId);
    if (!entry || entry.tris.size === 0) return false;
    if (knownFaceIndex != null) return entry.tris.has(knownFaceIndex);
    mesh.updateMatrixWorld();
    _contactRaycaster.set(_contactOrigin.set(x, y, z - 2), _contactDirection);
    const hits = _contactRaycaster.intersectObject(mesh, false);
    for (const hit of hits) {
        if (hit.faceIndex != null) return entry.tris.has(hit.faceIndex);
    }
    return false;
}

let _hoverPoint: THREE.Vector3 | null = null;
let _hoverNormal: THREE.Vector3 | null = null;

/** Model + snapshot captured at stroke start for the history entry. */
let _strokeModelId: string | null = null;
let _strokeBefore: number[] | null = null;

/** Stroke start: marks the stroke active (orbit gate) and snapshots for history undo. */
export function beginSupportBlockerStroke(modelId: string): number[] {
    _strokeActive = true;
    _strokeModelId = modelId;
    _strokeBefore = snapshotSupportBlockers(modelId);
    notify();
    return _strokeBefore;
}

export function isSupportBlockerStrokeActive(): boolean {
    return _strokeActive;
}

export function snapshotSupportBlockers(modelId: string): number[] {
    return [...(_entries.get(modelId)?.tris ?? [])];
}

/** Replace the mask wholesale — history undo/redo path. */
export function setSupportBlockedTriangles(modelId: string, tris: Iterable<number>): void {
    const entry = entryFor(modelId);
    entry.tris = new Set(tris);
    entry.lastDab = null;
    entry.version++;
    notify();
}

export function setSupportBlockerHover(point: THREE.Vector3 | null, normal: THREE.Vector3 | null): void {
    _hoverPoint = point ? point.clone() : null;
    _hoverNormal = normal ? normal.clone() : null;
    notify();
}

export function getSupportBlockerHover(): { point: THREE.Vector3 | null; normal: THREE.Vector3 | null } {
    return { point: _hoverPoint, normal: _hoverNormal };
}

/**
 * End the active stroke and report its diff for the history entry.
 * Returns null when no stroke is active or nothing changed.
 */
export function finishSupportBlockerStroke(): { modelId: string; before: number[]; after: number[] } | null {
    const modelId = _strokeModelId;
    const before = _strokeBefore;
    _strokeModelId = null;
    _strokeBefore = null;
    if (modelId === null || before === null) {
        if (_strokeActive) {
            _strokeActive = false;
            notify();
        }
        return null;
    }
    const after = snapshotSupportBlockers(modelId);
    endSupportBlockerStroke(modelId);
    if (after.length === before.length && after.every((t, i) => t === before[i])) return null;
    return { modelId, before, after };
}
