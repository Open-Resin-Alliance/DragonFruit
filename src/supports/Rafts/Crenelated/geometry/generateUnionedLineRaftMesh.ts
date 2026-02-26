import * as THREE from 'three';
import type { FootprintProfile } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';
import ClipperLib from 'clipper-lib';

type IntPoint = { X: number; Y: number };

const CLIPPER_SCALE = 1000; // mm -> int

function toIntPoint(p: THREE.Vector2): IntPoint {
  return { X: Math.round(p.x * CLIPPER_SCALE), Y: Math.round(p.y * CLIPPER_SCALE) };
}

function toVector2(p: IntPoint): THREE.Vector2 {
  return new THREE.Vector2(p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE);
}

function buildBeamPolygon(a: THREE.Vector2, b: THREE.Vector2, widthMm: number): IntPoint[] {
  const halfW = Math.max(0.001, widthMm / 2);
  const dir = new THREE.Vector2().subVectors(b, a);
  const len = dir.length();
  if (!Number.isFinite(len) || len < 1e-6) return [];
  dir.multiplyScalar(1 / len);

  // Extend both ends by half-width to create square caps.
  // This ensures adjacent beams sharing a node overlap in area rather than
  // merely touching at a point, which helps prevent non-manifold unions.
  const aExt = new THREE.Vector2().copy(a).addScaledVector(dir, -halfW);
  const bExt = new THREE.Vector2().copy(b).addScaledVector(dir, halfW);

  const n = new THREE.Vector2(-dir.y, dir.x);
  const p0 = new THREE.Vector2().copy(aExt).addScaledVector(n, halfW);
  const p1 = new THREE.Vector2().copy(bExt).addScaledVector(n, halfW);
  const p2 = new THREE.Vector2().copy(bExt).addScaledVector(n, -halfW);
  const p3 = new THREE.Vector2().copy(aExt).addScaledVector(n, -halfW);

  return [toIntPoint(p0), toIntPoint(p1), toIntPoint(p2), toIntPoint(p3)];
}

function signedArea(path: IntPoint[]): number {
  let a = 0;
  for (let i = 0; i < path.length; i++) {
    const j = (i + 1) % path.length;
    a += path[i].X * path[j].Y - path[j].X * path[i].Y;
  }
  return a / 2;
}

function ensureOrientation(path: IntPoint[], clockwise: boolean): IntPoint[] {
  const isClockwise = signedArea(path) < 0;
  if (isClockwise === clockwise) return path;
  return [...path].reverse();
}

function polyTreeToShapes(polyTree: any): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];

  function getChildren(node: any): any[] {
    if (!node) return [];
    if (Array.isArray(node.Childs)) return node.Childs;
    if (typeof node.Childs === 'function') {
      const v = node.Childs();
      return Array.isArray(v) ? v : [];
    }
    if (Array.isArray(node.m_Childs)) return node.m_Childs;
    return [];
  }

  function getContour(node: any): IntPoint[] {
    if (!node) return [];
    if (Array.isArray(node.Contour)) return node.Contour;
    if (Array.isArray(node.m_polygon)) return node.m_polygon;
    if (Array.isArray(node.m_Contour)) return node.m_Contour;
    return [];
  }

  function isHoleNode(node: any): boolean {
    if (!node) return false;
    if (typeof node.IsHole === 'function') return !!node.IsHole();
    if (typeof node.IsHole === 'boolean') return node.IsHole;
    if (typeof node.m_IsHole === 'boolean') return node.m_IsHole;
    return false;
  }

  function contourToPath(contour: IntPoint[]): THREE.Path {
    const pts = contour.map(toVector2);
    const path = new THREE.Path();
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    path.closePath();
    return path;
  }

  function nodeToShape(node: any) {
    const contour = getContour(node);
    if (!contour || contour.length < 3) return;

    const shapePts = contour.map(toVector2);
    const shape = new THREE.Shape(shapePts);

    const children = getChildren(node);
    if (children.length) {
      for (const child of children) {
        const childContour = getContour(child);
        if (!childContour || childContour.length < 3) continue;
        const hole = contourToPath(childContour);
        shape.holes.push(hole);

        // Grandchildren are islands inside holes
        const islands = getChildren(child);
        if (islands.length) {
          for (const island of islands) nodeToShape(island);
        }
      }
    }

    shapes.push(shape);
  }

  // Clipper-lib PolyTree can expose children in different ways depending on build.
  // Prefer GetFirst/GetNext traversal if available, else fall back to child arrays.
  if (polyTree && typeof polyTree.GetFirst === 'function') {
    let node = polyTree.GetFirst();
    while (node) {
      // In GetFirst traversal, we'll see both outer contours and hole nodes.
      // Only treat top-level outer contours as shapes; holes are handled via Childs on the node.
      if (!isHoleNode(node)) {
        nodeToShape(node);
      }
      node = typeof node.GetNext === 'function' ? node.GetNext() : null;
    }
  } else {
    const topChildren = getChildren(polyTree);
    for (const child of topChildren) nodeToShape(child);
  }

  return shapes;
}

function toVector2Loop(contour: IntPoint[]): THREE.Vector2[] {
  return contour.map(toVector2);
}

function buildShapeFromContours(outer: IntPoint[], holes: IntPoint[][]): THREE.Shape {
  const outerPts = toVector2Loop(outer);
  const shape = new THREE.Shape(outerPts);
  for (const hole of holes) {
    if (!hole || hole.length < 3) continue;
    const pts = toVector2Loop(hole);
    const path = new THREE.Path();
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

function triangulateCap(outer: IntPoint[], holes: IntPoint[][]): number[] {
  const outerPts = toVector2Loop(outer);
  const holePts = holes.map((h) => toVector2Loop(h));
  const tris = THREE.ShapeUtils.triangulateShape(outerPts, holePts);
  const indices: number[] = [];
  for (const t of tris) indices.push(t[0], t[1], t[2]);
  return indices;
}

function pickLargestPath(paths: IntPoint[][]): IntPoint[] {
  let best: IntPoint[] = [];
  let bestAbsArea = -Infinity;
  for (const p of paths) {
    if (!p || p.length < 3) continue;
    const a = Math.abs(signedArea(p));
    if (a > bestAbsArea) {
      bestAbsArea = a;
      best = p;
    }
  }
  return best;
}

function resampleLoop(points: THREE.Vector2[], targetCount: number): THREE.Vector2[] {
  if (!points || points.length < 3) return [];
  const n = points.length;
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = points[i].distanceTo(points[j]);
    segLen.push(d);
    total += d;
  }
  if (!Number.isFinite(total) || total <= 1e-6) return points.map((p) => p.clone());

  const count = Math.max(3, Math.floor(targetCount));
  const step = total / count;
  const out: THREE.Vector2[] = [];

  let edge = 0;
  let acc = 0;
  let dist = 0;

  let a = points[0].clone();
  let b = points[1].clone();
  let ab = segLen[0];

  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (dist + ab < target && edge < n) {
      dist += ab;
      edge = (edge + 1) % n;
      a = points[edge].clone();
      b = points[(edge + 1) % n].clone();
      ab = segLen[edge];
      if (ab <= 1e-9) break;
    }

    const t = ab <= 1e-9 ? 0 : (target - dist) / ab;
    out.push(new THREE.Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    acc += 1;
  }

  return out;
}

function offsetPathInward(path: IntPoint[], deltaMm: number): IntPoint[] {
  const delta = -deltaMm * CLIPPER_SCALE;
  const co = new ClipperLib.ClipperOffset(2, 2);
  co.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const out: IntPoint[][] = [];
  co.Execute(out, delta);
  return pickLargestPath(out);
}

function polyTreeToOuterPolys(polyTree: any): Array<{ outer: IntPoint[]; holes: IntPoint[][] }> {
  // Convert union PolyTree to a list of {outer, holes[]} where holes are direct children.
  const result: Array<{ outer: IntPoint[]; holes: IntPoint[][] }> = [];

  const getChildren = (node: any): any[] => {
    if (!node) return [];
    if (Array.isArray(node.Childs)) return node.Childs;
    if (typeof node.Childs === 'function') {
      const v = node.Childs();
      return Array.isArray(v) ? v : [];
    }
    if (Array.isArray(node.m_Childs)) return node.m_Childs;
    return [];
  };

  const getContour = (node: any): IntPoint[] => {
    if (!node) return [];
    if (Array.isArray(node.Contour)) return node.Contour;
    if (Array.isArray(node.m_polygon)) return node.m_polygon;
    if (Array.isArray(node.m_Contour)) return node.m_Contour;
    return [];
  };

  const isHoleNode = (node: any): boolean => {
    if (!node) return false;
    if (typeof node.IsHole === 'function') return !!node.IsHole();
    if (typeof node.IsHole === 'boolean') return node.IsHole;
    if (typeof node.m_IsHole === 'boolean') return node.m_IsHole;
    return false;
  };

  const addOuter = (node: any) => {
    const outer = getContour(node);
    if (!outer || outer.length < 3) return;
    const holes: IntPoint[][] = [];
    for (const child of getChildren(node)) {
      if (!child) continue;
      if (!isHoleNode(child)) continue;
      const hc = getContour(child);
      if (hc && hc.length >= 3) holes.push(hc);
    }
    result.push({ outer, holes });
  };

  if (polyTree && typeof polyTree.GetFirst === 'function') {
    let node = polyTree.GetFirst();
    while (node) {
      if (!isHoleNode(node)) addOuter(node);
      node = typeof node.GetNext === 'function' ? node.GetNext() : null;
    }
  } else {
    for (const child of getChildren(polyTree)) {
      if (!isHoleNode(child)) addOuter(child);
    }
  }

  return result;
}

export function generateUnionedLineRaftMesh(
  edges: Array<[THREE.Vector2, THREE.Vector2]>,
  settings: {
    widthMm: number;
    heightMm: number;
    borderProfile?: FootprintProfile | null;
    chamferAngleDeg?: number;
  }
): THREE.Mesh {
  const width = Math.max(0.001, settings.widthMm);
  const height = Math.max(0.001, settings.heightMm);

  const subject: IntPoint[][] = [];

  // Beam rectangles
  for (const [a, b] of edges) {
    const poly = buildBeamPolygon(a, b, width);
    if (poly.length >= 3) subject.push(ensureOrientation(poly, true));
  }

  // Border ring as a polygon with a hole
  if (settings.borderProfile && settings.borderProfile.length >= 3) {
    const outer = settings.borderProfile.map((p) => new THREE.Vector2(p.x, p.y));
    const inner = insetConvexPolygon(outer, width);
    if (inner && inner.length >= 3) {
      const outerPath = ensureOrientation(outer.map(toIntPoint), true);
      const innerPath = ensureOrientation(inner.map(toIntPoint), false);
      subject.push(outerPath);
      subject.push(innerPath);
    }
  }

  if (subject.length === 0) return new THREE.Mesh(new THREE.BufferGeometry());

  const c = new ClipperLib.Clipper();
  // True => preserve colinear edges
  c.StrictlySimple = true;
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);

  const polyTree = new ClipperLib.PolyTree();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );

  const angleDeg = settings.chamferAngleDeg;
  const useChamfer = typeof angleDeg === 'number' && Number.isFinite(angleDeg) && angleDeg < 89.999;

  // Fast fallback: simple extrude
  const shapes = polyTreeToShapes(polyTree);
  if (!shapes.length) return new THREE.Mesh(new THREE.BufferGeometry());

  if (!useChamfer) {
    const geom = new THREE.ExtrudeGeometry(shapes, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 24,
    });
    geom.computeVertexNormals();
    return new THREE.Mesh(geom);
  }

  // Chamfered build: top is full outline; bottom outer is inset inward by chamferInset.
  const aDeg = Math.min(90, Math.max(45, angleDeg));
  const chamferInsetMm = height * Math.tan((Math.PI / 180) * (90 - aDeg));

  const polys = polyTreeToOuterPolys(polyTree);
  if (!polys.length) {
    const geom = new THREE.ExtrudeGeometry(shapes, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 24,
    });
    geom.computeVertexNormals();
    return new THREE.Mesh(geom);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  let baseIndex = 0;

  for (const poly of polys) {
    const topOuter = poly.outer;
    const topHoles = poly.holes;
    const bottomOuter = chamferInsetMm > 1e-6 ? offsetPathInward(topOuter, chamferInsetMm) : topOuter;

    const topOuterV = topOuter.map(toVector2);
    const bottomOuterV = (bottomOuter && bottomOuter.length >= 3 ? bottomOuter : topOuter).map(toVector2);

    // Resample so we can stitch even when ClipperOffset changes vertex counts.
    const targetOuterCount = Math.min(256, Math.max(32, Math.max(topOuterV.length, bottomOuterV.length)));
    const topOuterR = resampleLoop(topOuterV, targetOuterCount);
    const bottomOuterR = resampleLoop(bottomOuterV, targetOuterCount);

    const holeLoopsTop: THREE.Vector2[][] = topHoles
      .filter((h) => h && h.length >= 3)
      .map((h) => resampleLoop(h.map(toVector2), Math.min(128, Math.max(16, h.length))));

    const nOuter = topOuterR.length;
    const holeCounts = holeLoopsTop.map((h) => h.length);
    const holeTotal = holeCounts.reduce((a, b) => a + b, 0);

    // Layout per polygon:
    // outerTop (nOuter)
    // holesTop (holeTotal)
    // outerBottom (nOuter)
    // holesBottom (holeTotal)
    const outerTopStart = baseIndex;
    for (const p of topOuterR) positions.push(p.x, p.y, height);
    baseIndex += nOuter;

    const holesTopStart = baseIndex;
    for (const h of holeLoopsTop) for (const p of h) positions.push(p.x, p.y, height);
    baseIndex += holeTotal;

    const outerBottomStart = baseIndex;
    for (const p of bottomOuterR) positions.push(p.x, p.y, 0);
    baseIndex += nOuter;

    const holesBottomStart = baseIndex;
    for (const h of holeLoopsTop) for (const p of h) positions.push(p.x, p.y, 0);
    baseIndex += holeTotal;

    // Side wall: outer (assumes same vertex count)
    for (let i = 0; i < nOuter; i++) {
      const iNext = (i + 1) % nOuter;
      const a = outerTopStart + i;
      const b = outerTopStart + iNext;
      const c = outerBottomStart + iNext;
      const d = outerBottomStart + i;
      indices.push(a, c, b);
      indices.push(a, d, c);
    }

    // Side walls for holes (vertical)
    let holeOffset = 0;
    for (let hi = 0; hi < holeLoopsTop.length; hi++) {
      const h = holeLoopsTop[hi];
      const hn = h.length;
      const ht = holesTopStart + holeOffset;
      const hb = holesBottomStart + holeOffset;
      for (let i = 0; i < hn; i++) {
        const iNext = (i + 1) % hn;
        const a = hb + i; // bottom
        const b = hb + iNext;
        const c = ht + iNext; // top
        const d = ht + i;
        // wind to face inward toward hole
        indices.push(a, c, b);
        indices.push(a, d, c);
      }
      holeOffset += hn;
    }

    // Caps using triangulation indices (top)
    const topOuterInt: IntPoint[] = topOuterR.map(toIntPoint);
    const topHolesInt: IntPoint[][] = holeLoopsTop.map((h) => h.map(toIntPoint));
    const capTop = triangulateCap(topOuterInt, topHolesInt);
    for (let i = 0; i < capTop.length; i += 3) {
      const ia = capTop[i];
      const ib = capTop[i + 1];
      const ic = capTop[i + 2];
      const mapIndex = (idx: number) => {
        if (idx < nOuter) return outerTopStart + idx;
        return holesTopStart + (idx - nOuter);
      };
      indices.push(mapIndex(ia), mapIndex(ib), mapIndex(ic));
    }

    // Caps (bottom) - reverse winding
    const bottomOuterInt: IntPoint[] = bottomOuterR.map(toIntPoint);
    const capBottom = triangulateCap(bottomOuterInt, topHolesInt);
    for (let i = 0; i < capBottom.length; i += 3) {
      const ia = capBottom[i];
      const ib = capBottom[i + 1];
      const ic = capBottom[i + 2];
      const mapIndex = (idx: number) => {
        if (idx < nOuter) return outerBottomStart + idx;
        return holesBottomStart + (idx - nOuter);
      };
      indices.push(mapIndex(ia), mapIndex(ic), mapIndex(ib));
    }
  }

  const allFinite = positions.every((v) => Number.isFinite(v));
  if (!allFinite) {
    const geom = new THREE.ExtrudeGeometry(shapes, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 24,
    });
    geom.computeVertexNormals();
    return new THREE.Mesh(geom);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return new THREE.Mesh(geom);
}
