import type { RaftSettings, SupportBaseCircle } from '../RaftTypes';
import { computeFootprint } from './computeFootprint';
import { MODEL_PLATE_CLEARANCE_MM } from './modelPlateFootprint';
import {
  buildClearanceEdgeGrid,
  differencePolygonSets,
  gridSegmentBlocked,
  offsetPolygonSet,
  polygonSetContains,
  ringToPolygon,
  type PolygonWithHoles,
} from './polygonSet2d';

/**
 * The raft footprint as a polygon *set*: the convex hull of the support roots,
 * minus the models' plate footprint inflated by the clearance.
 *
 * The hull is what the old single-ring pipeline produced; the subtraction is what
 * keeps the raft out of a model that stands on the plate (see
 * `modelPlateFootprint.ts`). Everything downstream — base, wall, line network,
 * export, slice — reads the set, so the preview and the sliced raft cannot drift.
 */

type RaftSolidHeightSettings = Pick<RaftSettings, 'bottomMode' | 'thickness' | 'lineHeightMm'>;
type RaftMarginSettings = RaftSolidHeightSettings
  & Pick<RaftSettings, 'chamferAngle' | 'wallEnabled' | 'wallThickness'>;
type RaftBandSettings = RaftSolidHeightSettings & Pick<RaftSettings, 'wallEnabled' | 'wallHeight'>;

/** Material height of the raft body: beam height in line mode, plate thickness otherwise. */
export function raftSolidHeightMm(raft: RaftSolidHeightSettings): number {
  return raft.bottomMode === 'line' ? Math.max(0, raft.lineHeightMm) : Math.max(0, raft.thickness);
}

/**
 * Chamfer is measured in the solid's own height, so the line raft's chamfer is
 * derived from the beam height, not the (unused) plate thickness.
 */
export function raftChamferInsetMm(raft: RaftMarginSettings): number {
  const angle = Math.min(90, Math.max(45, raft.chamferAngle));
  return raftSolidHeightMm(raft) * Math.tan((Math.PI / 180) * (90 - angle));
}

/** Hull margin: clears the chamfer inset and the wall, so both still land on support. */
export function raftDynamicMarginMm(raft: RaftMarginSettings): number {
  const wallInset = raft.wallEnabled ? Math.max(0, raft.wallThickness) : 0;
  return 0.2 + Math.max(raftChamferInsetMm(raft), wallInset);
}

/** Top of the material a model has to clear: plate/beam plus the wall above it. */
export function raftBandTopMm(raft: RaftBandSettings): number {
  return raftSolidHeightMm(raft) + (raft.wallEnabled ? Math.max(0, raft.wallHeight) : 0);
}

/** Z the wall is extruded from — the beam top in line mode, the plate top otherwise. */
export function raftWallBaseHeightMm(raft: RaftSolidHeightSettings): number {
  return raft.bottomMode === 'line'
    ? Math.max(0.01, raft.lineHeightMm)
    : Math.max(0, raft.thickness);
}

/**
 * The region a raft must stay out of: the models' plate footprint grown by the
 * clearance. Dilating keeps the raft 1 mm clear of the model on every side,
 * including the inside of a ring-shaped contact patch (where the dilation shrinks
 * the hole rather than growing it).
 */
export function inflateModelPlateClearance(
  clearance: readonly PolygonWithHoles[],
): PolygonWithHoles[] {
  if (clearance.length === 0) return [];
  return offsetPolygonSet(clearance, MODEL_PLATE_CLEARANCE_MM);
}

/**
 * Split the support roots into groups a model standing on the plate separates.
 *
 * The same rule the line raft applies to its beams: two roots belong to one raft
 * only if the line between them clears the model. A hull over both sides of a
 * model would otherwise wrap around it — a C-shaped raft bridging two clusters
 * that have nothing to do with each other.
 */
function clusterCirclesAroundClearance(
  circles: readonly SupportBaseCircle[],
  clearance: readonly PolygonWithHoles[],
): SupportBaseCircle[][] {
  if (circles.length <= 1) return [circles.slice()];

  // Every pair asks whether the segment between it clears the model. Answered
  // against the whole clearance set that is O(circles^2 x edges) - measured at
  // 19 seconds for one selection on a scene with 1109 roots - so the edges go
  // into a grid and a pair tests only the cells its own short segment crosses.
  const grid = buildClearanceEdgeGrid(clearance);
  if (!grid) return [circles.slice()];

  // A circle inside the clearance is never unioned with anything, and that
  // answer is the same for every pair it appears in. Asked per pair it is
  // O(circles^2 x polygons), and measured 41% of the ~1 s a model selection
  // still cost on a scene with 1109 roots; asked once per circle it is
  // O(circles x polygons).
  const insideClearance = circles.map((circle) => polygonSetContains(clearance, circle.x, circle.y));

  const parent = circles.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      if (insideClearance[i] || insideClearance[j]) continue;
      const a = circles[i];
      const b = circles[j];

      if (!gridSegmentBlocked(grid, a.x, a.y, b.x, b.y)) union(i, j);
    }
  }

  const clusters = new Map<number, SupportBaseCircle[]>();
  for (let i = 0; i < circles.length; i += 1) {
    const root = find(i);
    const cluster = clusters.get(root) ?? [];
    cluster.push(circles[i]);
    clusters.set(root, cluster);
  }
  return [...clusters.values()];
}

export function computeRaftFootprintPolygons(args: {
  circles: readonly SupportBaseCircle[];
  raft: RaftSettings;
  clearance?: readonly PolygonWithHoles[] | null;
  samplesPerCircle?: number;
}): PolygonWithHoles[] {
  const { circles, raft, clearance } = args;
  if (circles.length === 0) return [];

  const marginMm = raftDynamicMarginMm(raft);
  const samplesPerCircle = args.samplesPerCircle ?? 24;

  const inflated = clearance && clearance.length > 0 ? inflateModelPlateClearance(clearance) : [];
  const clusters = inflated.length > 0
    ? clusterCirclesAroundClearance(circles, inflated)
    : [circles.slice()];

  const footprint: PolygonWithHoles[] = [];
  for (const cluster of clusters) {
    const hull = computeFootprint(cluster as SupportBaseCircle[], { marginMm, samplesPerCircle });
    if (hull && hull.length >= 3) footprint.push(ringToPolygon(hull));
  }
  if (footprint.length === 0) return [];
  if (inflated.length === 0) return footprint;

  // Whatever a cluster's hull still covers — a model ringed by roots has no pair
  // to split it — is cut out exactly as before.
  return differencePolygonSets(footprint, inflated);
}
