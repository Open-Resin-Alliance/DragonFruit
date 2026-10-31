import * as THREE from 'three';
import type { InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import type { InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import type { InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import type { InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';

/** The flattened primitive arrays a layer draws, by set. */
export type FlatProxyGeometry = {
  straightShafts: InstancedShaft[];
  curvedShafts: InstancedShaft[];
  roots: InstancedRoot[];
  joints: InstancedJoint[];
  cones: InstancedContactCone[];
};

/**
 * A spatial slice of the shaft/root/joint batches.
 *
 * The batches span the plate, and `frustumCulled={false}` was the only way to
 * draw them as one mesh. That also meant every support instance was vertex-shaded
 * whenever the plate was anywhere on screen, even when the user was zoomed into
 * one model — the asymmetry against models, which cull per mesh. Splitting these
 * three kinds into a small grid gives each tile a real bounding sphere, so three
 * can drop the tiles the camera does not see.
 *
 * Cones are deliberately not tiled: their batch is keyed on the cone shape ratio,
 * and a tile would be its own set of ~34 buckets, multiplying draw calls.
 */
export type ProxyTile = {
  key: string;
  /** Covering sphere for the tile's instances; null when the tile is not culled. */
  sphere: THREE.Sphere | null;
  straightShafts: InstancedShaft[];
  roots: InstancedRoot[];
  joints: InstancedJoint[];
};

const PROXY_TILE_GRID = 3;
const PROXY_TILE_MIN_PRIMITIVES = 3000;
const PROXY_TILE_MARGIN_MM = 8;

export function buildProxyTiles(live: FlatProxyGeometry, scenery: FlatProxyGeometry): {
  live: ProxyTile[];
  scenery: ProxyTile[];
} {
  const total = (geometry: FlatProxyGeometry) => (
    geometry.straightShafts.length + geometry.roots.length + geometry.joints.length
  );
  const primitiveCount = total(live) + total(scenery);
  if (primitiveCount === 0) return { live: [], scenery: [] };

  const child = primitiveCount >= PROXY_TILE_MIN_PRIMITIVES ? PROXY_TILE_GRID : 1;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const expand = (x: number, y: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const geometry of [live, scenery]) {
    for (const shaft of geometry.straightShafts) {
      expand((shaft.start.x + shaft.end.x) * 0.5, (shaft.start.y + shaft.end.y) * 0.5, Math.max(shaft.start.z, shaft.end.z));
    }
    for (const root of geometry.roots) expand(root.basePos.x, root.basePos.y, root.basePos.z);
    for (const joint of geometry.joints) expand(joint.pos.x, joint.pos.y, joint.pos.z);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { live: [], scenery: [] };

  const spanX = Math.max(1e-3, maxX - minX);
  const spanY = Math.max(1e-3, maxY - minY);
  const cellX = spanX / child;
  const cellY = spanY / child;

  const build = (geometry: FlatProxyGeometry): ProxyTile[] => {
    const byCell = new Map<number, ProxyTile>();
    // Bounds from the primitives actually in the tile, not from the cell: a
    // shaft can cross a cell boundary, and a sphere around the cell centre would
    // then cull a shaft whose far end is still visible.
    const bounds = new Map<number, { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }>();
    const ensure = (cx: number, cy: number): { tile: ProxyTile; cell: number } => {
      const cell = Math.min(child - 1, Math.max(0, cy)) * child + Math.min(child - 1, Math.max(0, cx));
      let tile = byCell.get(cell);
      if (!tile) {
        tile = { key: `tile-${cell}`, sphere: null, straightShafts: [], roots: [], joints: [] };
        byCell.set(cell, tile);
        bounds.set(cell, { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity });
      }
      return { tile, cell };
    };
    const extend = (cell: number, x: number, y: number, z: number) => {
      const b = bounds.get(cell)!;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
      if (z < b.minZ) b.minZ = z;
      if (z > b.maxZ) b.maxZ = z;
    };
    const cellOf = (x: number, y: number) => ({
      cx: Math.min(child - 1, Math.max(0, Math.floor((x - minX) / cellX))),
      cy: Math.min(child - 1, Math.max(0, Math.floor((y - minY) / cellY))),
    });

    for (const shaft of geometry.straightShafts) {
      const mid = cellOf((shaft.start.x + shaft.end.x) * 0.5, (shaft.start.y + shaft.end.y) * 0.5);
      const { tile, cell } = ensure(mid.cx, mid.cy);
      tile.straightShafts.push(shaft);
      extend(cell, shaft.start.x, shaft.start.y, shaft.start.z);
      extend(cell, shaft.end.x, shaft.end.y, shaft.end.z);
    }
    for (const root of geometry.roots) {
      const { cx, cy } = cellOf(root.basePos.x, root.basePos.y);
      const { tile, cell } = ensure(cx, cy);
      tile.roots.push(root);
      extend(cell, root.basePos.x, root.basePos.y, root.basePos.z);
      extend(cell, root.basePos.x, root.basePos.y, root.basePos.z + root.coneHeight + root.effectiveDiskHeight);
    }
    for (const joint of geometry.joints) {
      const { cx, cy } = cellOf(joint.pos.x, joint.pos.y);
      const { tile, cell } = ensure(cx, cy);
      tile.joints.push(joint);
      extend(cell, joint.pos.x, joint.pos.y, joint.pos.z);
    }

    for (const [cell, tile] of byCell) {
      if (child <= 1) {
        tile.sphere = null;
        continue;
      }
      const b = bounds.get(cell)!;
      const centerX = (b.minX + b.maxX) * 0.5;
      const centerY = (b.minY + b.maxY) * 0.5;
      const centerZ = (b.minZ + b.maxZ) * 0.5;
      const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) * 0.5 + PROXY_TILE_MARGIN_MM;
      tile.sphere = new THREE.Sphere(new THREE.Vector3(centerX, centerY, centerZ), radius);
    }
    return [...byCell.values()];
  };

  return { live: build(live), scenery: build(scenery) };
}
