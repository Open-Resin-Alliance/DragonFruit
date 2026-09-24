import * as THREE from 'three';
import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';
import { measurePoseStability, needsToppleCoverage, posedPositions } from './poseStability';

/**
 * Stabilization: a model that prints fine on its own can still fail because
 * nothing holds it — a corner resting on a point, or a long edge on a line.
 * Formation overhang detection never sees these (the faces are steep enough
 * to print), so a separate pass scores how the oriented mesh bears on the
 * build plate and emits anchor contacts along the low edge skeleton to
 * broaden a deficient base.
 *
 * Pure geometry, deterministic: welded edge graph + bearing hull + surface
 * centroid, then teeth sampled along every low edge at fixed spacing. No RNG,
 * no slicing.
 *
 * The verdict is also logged (see `logVerdict`) so it can be diffed against
 * the Rust topple report on real models — that report computes the moment the
 * thresholds here stand in for.
 */

/** Low surface within this height of the minimum counts as the bearing locus. */
const BEARING_BAND_MM = 2.0;
/** A projected bearing hull smaller than this (mm²) is a point/edge/sliver —
 *  unstable regardless of where the centroid sits. */
const MIN_BEARING_AREA_MM2 = 4.0;
/** The projected centroid may sit up to this far outside the bearing hull
 *  before the pose is declared unstable. */
const MARGIN_MM = 2.0;
/** Tooth spacing (mm) along the low edges. */
const SPACING_MM = 2.5;
/** Most anchors one run emits. Generous enough that a tall blade keeps both a
 *  dense bottom line and buttresses up its long edges (two 60mm edges fully
 *  toothed is ~48). */
const MAX_ANCHORS = 48;
/** When the part already rests on a low edge, flank teeth climb only this far
 *  up the faces (mm) — enough to brace sideways without climbing the part. */
const FLANK_RISE_MM = 4.0;
/** When the part rests on a lone point (no bearing edge), teeth climb the
 *  radiating edges this far (mm) to reach the widest base points. */
const CORNER_RISE_MM = 12.0;
/** Buttresses/flanks also climb a fraction of the part's height up the rising
 *  edges, so a tall blade on its edge gets braced partway up instead of only
 *  at the base. */
const BUTTRESS_HEIGHT_FRACTION = 0.35;
/** Hard cap on how far any anchor climbs above the base (mm). */
const MAX_RISE_MM = 30.0;
/** Above this many vertices, skip the pass entirely (memory/latency guard). */
const VERT_CAP = 3_000_000;
/** Spacing (mm) between buttress teeth along a rising edge. A buttress is a
 *  structural member, not a contact line: the base line needs the dense 2.5mm
 *  to be continuous, a brace only needs to be there. Without this a 50mm face
 *  gets twenty teeth a side and reads as a carpet. */
const BUTTRESS_SPACING_MM = 8.0;

export interface StabilizationAnchor {
    x: number;
    y: number;
    z: number;
}

/**
 * Compute stabilization anchors for a mesh (matrixWorld must be current).
 * Returns an empty array when the pose is stable — the common case, so a
 * flat-printed model changes nothing.
 */
export function computeStabilizationAnchors(mesh: THREE.Mesh): StabilizationAnchor[] {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geometry.getAttribute('position');
    if (!posAttr || posAttr.itemSize !== 3 || posAttr.count < 3 || posAttr.count > VERT_CAP) return [];
    const positions = posAttr.array as ArrayLike<number>;
    const indexAttr = geometry.getIndex();
    const index = indexAttr ? (indexAttr.array as ArrayLike<number>) : null;
    const triCount = index ? Math.floor(indexAttr!.count / 3) : Math.floor(posAttr.count / 3);
    if (triCount <= 0) return [];

    const e = mesh.matrixWorld.elements;
    const toX = (x: number, y: number, z: number): number => e[0] * x + e[4] * y + e[8] * z + e[12];
    const toY = (x: number, y: number, z: number): number => e[1] * x + e[5] * y + e[9] * z + e[13];
    const toZ = (x: number, y: number, z: number): number => e[2] * x + e[6] * y + e[10] * z + e[14];

    // Welded graph: unique world vertices + unique edges, built in one pass
    // over the triangles alongside the surface-centroid accumulation.
    const weld = new Map<string, number>();
    const vx: number[] = [];
    const vy: number[] = [];
    const vz: number[] = [];
    const edges = new Set<string>();
    const vertexAt = (li: number): number => {
        const x = positions[li];
        const y = positions[li + 1];
        const z = positions[li + 2];
        const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
        let id = weld.get(key);
        if (id === undefined) {
            id = vx.length;
            weld.set(key, id);
            vx.push(toX(x, y, z));
            vy.push(toY(x, y, z));
            vz.push(toZ(x, y, z));
        }
        return id;
    };
    const link = (a: number, b: number): void => {
        if (a === b) return;
        edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    };

    let comX = 0;
    let comY = 0;
    let totalArea = 0;
    for (let t = 0; t < triCount; t++) {
        const ia = (index ? index[t * 3] : t * 3) * 3;
        const ib = (index ? index[t * 3 + 1] : t * 3 + 1) * 3;
        const ic = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;

        // Zero-area triangles are a mesh defect — a stray vertex on collapsed
        // faces — and they must not join the vertex set: one stray vertex
        // below the model otherwise defines zMin, empties the bearing band and
        // turns its own degenerate edges into climb edges, so the anchors climb
        // the defect instead of the part's base. Tested in the RAW frame, where
        // it costs one cross product: an affine world transform maps collinear
        // points to collinear points, so degeneracy is preserved. No-op for any
        // mesh without such triangles. Mirrors `compute_stability_report`.
        const rx = positions[ib] - positions[ia];
        const ry = positions[ib + 1] - positions[ia + 1];
        const rz = positions[ib + 2] - positions[ia + 2];
        const sx = positions[ic] - positions[ia];
        const sy = positions[ic + 1] - positions[ia + 1];
        const sz = positions[ic + 2] - positions[ia + 2];
        const nx = ry * sz - rz * sy;
        const ny = rz * sx - rx * sz;
        const nz = rx * sy - ry * sx;
        if (nx * nx + ny * ny + nz * nz <= 0) continue;

        const a = vertexAt(ia);
        const b = vertexAt(ib);
        const c = vertexAt(ic);
        link(a, b);
        link(b, c);
        link(c, a);

        const ax = toX(positions[ia], positions[ia + 1], positions[ia + 2]);
        const ay = toY(positions[ia], positions[ia + 1], positions[ia + 2]);
        const bx = toX(positions[ib], positions[ib + 1], positions[ib + 2]);
        const by = toY(positions[ib], positions[ib + 1], positions[ib + 2]);
        const cx = toX(positions[ic], positions[ic + 1], positions[ic + 2]);
        const cy = toY(positions[ic], positions[ic + 1], positions[ic + 2]);
        // A vertical face projects to zero XY area and is legitimate — it is
        // skipped for the footprint centroid only, not for the vertex set.
        const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
        if (area <= 0) continue;
        totalArea += area;
        comX += area * (ax + bx + cx) / 3;
        comY += area * (ay + by + cy) / 3;
    }

    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < vx.length; i++) {
        if (vz[i] < zMin) zMin = vz[i];
        if (vz[i] > zMax) zMax = vz[i];
    }
    if (!Number.isFinite(zMin)) return [];
    if (totalArea > 0) {
        comX /= totalArea;
        comY /= totalArea;
    }

    // Bearing locus: projected hull of the low surface.
    const bearing: THREE.Vector2[] = [];
    for (let i = 0; i < vx.length; i++) {
        if (vz[i] - zMin <= BEARING_BAND_MM) bearing.push(new THREE.Vector2(vx[i], vy[i]));
    }
    const hull = convexHull2d(bearing);
    const bearingAreaMm2 = hull.length >= 3 ? hullArea(hull) : 0;
    const depthMm = centroidDepth(comX, comY, hull);

    // Stable = enough bearing area AND the centroid over (or within a margin
    // of) that area. Either failing means the part can tip — and so does the
    // adhesion verdict: a part can stand on its base and still lift off it when
    // the peel drag outweighs the plate adhesion. That comparison needs one
    // constant, so it is run conservatively (see CONSERVATIVE_P_SIGMA) and its
    // geometry comes from the same report the log line prints.
    // The measurement must see the POSE, not the authored geometry: this pass
    // applies `matrixWorld` to every vertex itself (toX/toY/toZ), and a model
    // whose transform carries the orientation is upright in its own frame — so
    // measuring the raw attribute array reported a flat-topped part with no
    // drag, and the brace reach fell back to a fraction of the height.
    const worldPositions = posedPositions(mesh);
    const poseStability = measurePoseStability(
        worldPositions,
        (indexAttr ? (indexAttr.array as ArrayLike<number>) : null),
        0,
        0,
    );
    const standsOnBase = hull.length >= 3 && bearingAreaMm2 >= MIN_BEARING_AREA_MM2 && depthMm >= -MARGIN_MM;
    if (standsOnBase && !needsToppleCoverage(poseStability)) {
        logVerdict('stable', 0, bearingAreaMm2, depthMm);
        return [];
    }

    // Unstable: lay teeth along the low edge skeleton. Two regimes — an
    // edge/face contact already gives a low line, so teeth go along it plus a
    // short flank up each face; a lone point has no line, so teeth climb the
    // radiating edges to the widest base points (a tripod).
    const isBearing = (id: number): boolean => vz[id] - zMin <= BEARING_BAND_MM;
    const bearingEdges: Array<[number, number]> = [];
    const climbEdges: Array<[number, number]> = [];
    for (const edgeKey of edges) {
        const sep = edgeKey.indexOf(',');
        const a = parseInt(edgeKey.slice(0, sep));
        const b = parseInt(edgeKey.slice(sep + 1));
        const ba = isBearing(a);
        const bb = isBearing(b);
        if (ba && bb) bearingEdges.push([a, b]);
        else if (ba || bb) climbEdges.push([a, b]);
    }

    // Climb the rising edges to where the moment actually acts. The report's
    // moment-weighted drag height is the lever the toppling turns on, and a
    // brace only resists once it reaches that height — so the old
    // "0.35 × height, capped at 30mm" guess is replaced by the measured reach
    // when the pose leans hard enough to have one. A short cube keeps short
    // flanks, a tall blade gets buttresses up to its drag.
    const partHeight = zMax - zMin;
    const baseRise = bearingEdges.length > 0 ? FLANK_RISE_MM : CORNER_RISE_MM;
    // Measured reach wins when the pose drags: the moment peaks at the top of
    // the highest dragging face, so a brace that stops short of it resists
    // nothing there. The old fraction-and-cap only stands in when there is no
    // drag to measure.
    const riseCap =
        poseStability.dragTopMm > 0
            ? Math.min(partHeight, Math.max(baseRise, poseStability.dragTopMm))
            : Math.min(MAX_RISE_MM, Math.max(baseRise, partHeight * BUTTRESS_HEIGHT_FRACTION));

    // Half-spacing XY cell: teeth on a 45° climb edge sit ~1.77mm apart in XY
    // (2.5mm along the edge), so a full-spacing cell would merge consecutive
    // teeth on the SAME edge, not just the near-duplicates from parallel edges.
    const cell = SPACING_MM * 0.5;
    // Rank, then keep: 0 = the bearing line (the stance — always first, it is
    // what broadens the base), 1 = a brace on the side the part lifts (the
    // longest lever from the tipping edge), 2 = the rest. The anchor cap then
    // spends its budget where the toppling is actually resisted instead of
    // spreading it evenly around the part.
    interface Tooth extends StabilizationAnchor {
        tier: number;
    }
    const best = new Map<string, Tooth>();
    const put = (x: number, y: number, z: number, tier: number): void => {
        const key = `${Math.round(x / cell)},${Math.round(y / cell)}`;
        const existing = best.get(key);
        const tooth = { x, y, z, tier };
        // One contact per XY cell: the placement cannot put two trunks in the
        // same spot, so the cell keeps whichever tooth is worth more — and
        // "lowest wins" would hand every cell to the base line and leave a
        // leaning part braced only at its foot.
        if (!existing || betterThan(tooth, existing)) best.set(key, tooth);
    };
    // The drag pushes the part over the edge on `pushDirDeg`; the material that
    // lifts is on the far side. Azimuth 0 = +X, 90 = +Y.
    const tensionRad = ((poseStability.pushDirDeg + 180) * Math.PI) / 180;
    const tensionX = Math.cos(tensionRad);
    const tensionY = Math.sin(tensionRad);
    const tensionSide = (id: number): boolean =>
        (vx[id] - comX) * tensionX + (vy[id] - comY) * tensionY > 0;
    const emitEdge = (a: number, b: number, cap: number, spacing: number, tier: number): void => {
        const lo = vz[a] <= vz[b] ? a : b;
        const hi = lo === a ? b : a;
        const lx = vx[lo];
        const ly = vy[lo];
        const lz = vz[lo];
        const hx = vx[hi];
        const hy = vy[hi];
        const hz = vz[hi];
        if (lz - zMin > cap) return;
        const len = Math.hypot(hx - lx, hy - ly, hz - lz);
        if (len <= 1e-9) return;
        const steps = Math.floor(len / spacing);
        for (let k = 0; k <= steps; k++) {
            const t = (k * spacing) / len;
            const z = lz + (hz - lz) * t;
            if (z - zMin > cap + 1e-9) break;
            put(lx + (hx - lx) * t, ly + (hy - ly) * t, z, tier);
        }
    };
    // What a tooth is worth. A support's resistance is its tip: a tip at 38mm
    // holds the part at every height below it, a tip at 8mm holds nothing above
    // 8mm — so among braces, higher is better. The tension side beats the far
    // side, and a brace beats a base-line tooth, because on a thin part they
    // compete for the same XY cells (every contact on a 2mm-thick plank is
    // within the placement's own 3mm "already supported" radius) and only one
    // of them can exist there. The base line is a continuous contact, so losing
    // a tooth to a brace costs it nothing; losing a brace to a tooth costs the
    // part its reach.
    const worth = (t: Tooth): number => (t.tier === 1 ? 0 : t.tier === 0 ? 1 : 2);
    const byRank = (a: Tooth, b: Tooth): number =>
        worth(a) - worth(b) || (a.tier === 0 ? a.z - b.z : b.z - a.z);
    const betterThan = (a: Tooth, b: Tooth): boolean => byRank(a, b) < 0;

    if (bearingEdges.length > 0) {
        // Edge/face contact: the bearing line is the stance; braces climb the
        // adjacent faces, tension side first.
        for (const e of bearingEdges) emitEdge(e[0], e[1], Infinity, SPACING_MM, 0);
        for (const e of climbEdges) {
            const tier = tensionSide(e[0]) || tensionSide(e[1]) ? 1 : 2;
            emitEdge(e[0], e[1], riseCap, BUTTRESS_SPACING_MM, tier);
        }
        const capped = [...best.values()].sort(byRank).slice(0, MAX_ANCHORS);
        logVerdict('unstable (edge contact)', capped.length, bearingAreaMm2, depthMm);
        return capped.map(({ x, y, z }) => ({ x, y, z }));
    }
    // Lone point: climb the radiating edges for a wide tripod, spreading the
    // cap across the z range so the widest vertices are reached. Deliberately
    // NOT biased to the tension side: a point contact has no static margin in
    // any direction, so the tripod has to cover all of them.
    for (const e of climbEdges) emitEdge(e[0], e[1], riseCap, SPACING_MM, 1);
    const all = [...best.values()].sort(byRank);
    if (all.length <= MAX_ANCHORS) {
        logVerdict('unstable (point contact)', all.length, bearingAreaMm2, depthMm);
        return all.map(({ x, y, z }) => ({ x, y, z }));
    }
    const anchors: StabilizationAnchor[] = [];
    for (let i = 0; i < MAX_ANCHORS; i++) {
        const { x, y, z } = all[Math.floor((i * (all.length - 1)) / (MAX_ANCHORS - 1))];
        anchors.push({ x, y, z });
    }
    logVerdict('unstable (point contact)', anchors.length, bearingAreaMm2, depthMm);
    return anchors;
}

/**
 * Calibration diagnostics, not behaviour: `compute_stability_report`
 * (`src-tauri/src/overhang.rs`) logs the same pose as a moment margin. Both
 * lines exist so this gate's verdict can be diffed against that margin on real
 * models before the fixed thresholds here are replaced by it.
 */
function logVerdict(verdict: string, anchors: number, bearingAreaMm2: number, depthMm: number): void {
    const depth = Number.isFinite(depthMm) ? `${depthMm.toFixed(2)}mm` : 'n/a';
    console.log(
        '[Stabilization]',
        `${verdict}${anchors > 0 ? ` → ${anchors} anchors` : ''} · bearing ${bearingAreaMm2.toFixed(1)}mm² · centroid depth ${depth}`,
    );
}

function hullArea(hull: THREE.Vector2[]): number {
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
        const p = hull[i];
        const q = hull[(i + 1) % hull.length];
        area += p.x * q.y - q.x * p.y;
    }
    return Math.abs(area) / 2;
}

/**
 * Signed distance from (px,py) to the hull's nearest edge, positive inside —
 * the same depth the Rust topple report measures, so the two logs compare.
 * `Infinity` for a hull with no edges (a point or line contact).
 */
function centroidDepth(px: number, py: number, hull: THREE.Vector2[]): number {
    let minDepth = Infinity;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const len = Math.hypot(ex, ey) || 1;
        const nx = -ey / len;
        const ny = ex / len;
        const depth = (px - a.x) * nx + (py - a.y) * ny;
        if (depth < minDepth) minDepth = depth;
    }
    return minDepth;
}
