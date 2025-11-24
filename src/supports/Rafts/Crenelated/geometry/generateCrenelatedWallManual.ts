import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';

/**
 * Generate a crenelated wall by manually building geometry with rectangular gaps.
 * Places 3 evenly-spaced rectangular gaps on each straight edge segment.
 */
export function generateCrenelatedWallManual(
  topProfile: FootprintProfile,
  settings: Pick<RaftSettings, 'thickness' | 'wallThickness' | 'wallHeight' | 'crenulationGapWidth' | 'crenulationSpacing'>
): THREE.Mesh {
  const wallHeight = Math.max(0, settings.wallHeight);
  const wallThickness = Math.max(0, settings.wallThickness);
  const gapWidth = Math.max(0, settings.crenulationGapWidth);
  
  if (!topProfile || topProfile.length < 3 || wallHeight === 0 || wallThickness === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const outer = topProfile;
  const inner = insetConvexPolygon(outer, wallThickness);
  const n = outer.length;
  const zBase = settings.thickness;
  const zTop = zBase + wallHeight;

  // Build edge info
  const edges: Array<{ dir: THREE.Vector2; len: number; isStraight: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const dir = new THREE.Vector2().subVectors(outer[next], outer[i]);
    const len = dir.length();
    dir.normalize();
    
    // Check if this edge is part of a straight run
    const iPrev = (i - 1 + n) % n;
    const prevDir = new THREE.Vector2().subVectors(outer[i], outer[iPrev]).normalize();
    const dot = THREE.MathUtils.clamp(prevDir.dot(dir), -1, 1);
    const ang = Math.acos(dot) * 180 / Math.PI;
    const isStraight = ang <= 15.0 && len > 5.0; // Straight if angle < 15° and edge > 5mm
    
    edges.push({ dir, len, isStraight });
  }

  const positions: number[] = [];
  const indices: number[] = [];
  let vertexCount = 0;

  function addQuad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, flip = false) {
    const base = vertexCount;
    positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
    if (flip) {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    vertexCount += 4;
  }

  // For each edge, build wall segments with gaps on straight edges
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const edge = edges[i];
    
    const outerStart = outer[i];
    const outerEnd = outer[next];
    const innerStart = inner[i];
    const innerEnd = inner[next];

    if (!edge.isStraight) {
      // Solid wall segment for curved edges
      const o0 = new THREE.Vector3(outerStart.x, outerStart.y, zBase);
      const o1 = new THREE.Vector3(outerEnd.x, outerEnd.y, zBase);
      const o2 = new THREE.Vector3(outerEnd.x, outerEnd.y, zTop);
      const o3 = new THREE.Vector3(outerStart.x, outerStart.y, zTop);
      
      const i0 = new THREE.Vector3(innerStart.x, innerStart.y, zBase);
      const i1 = new THREE.Vector3(innerEnd.x, innerEnd.y, zBase);
      const i2 = new THREE.Vector3(innerEnd.x, innerEnd.y, zTop);
      const i3 = new THREE.Vector3(innerStart.x, innerStart.y, zTop);

      // Outer face
      addQuad(o0, o1, o2, o3, false);
      // Inner face
      addQuad(i0, i3, i2, i1, false);
      // Top face
      addQuad(o3, o2, i2, i3, false);
      // Bottom face
      addQuad(o0, i0, i1, o1, false);
    } else {
      // Straight edge: place 3 gaps
      const tangent = edge.dir;
      const normal = new THREE.Vector2(-tangent.y, tangent.x); // Inward normal
      
      const gapCount = 1;
      const margin = 1.0;
      const usableLen = Math.max(0, edge.len - 2 * margin);
      const segmentLen = usableLen / gapCount;
      const halfGap = gapWidth / 2;

      // Build segments between gaps and track gap positions for side faces
      const segments: Array<{ start: number; end: number }> = [];
      const gaps: Array<{ start: number; end: number }> = [];
      
      for (let g = 0; g < gapCount; g++) {
        const gapCenter = margin + segmentLen * (g + 0.5);
        const gapStart = Math.max(0, gapCenter - halfGap);
        const gapEnd = Math.min(edge.len, gapCenter + halfGap);
        
        gaps.push({ start: gapStart, end: gapEnd });
        
        // Segment before this gap
        const segStart = g === 0 ? 0 : segments[segments.length - 1].end;
        const segEnd = gapStart;
        
        if (segEnd > segStart + 0.1) {
          segments.push({ start: segStart, end: segEnd });
        }
        
        // After last gap, add final segment
        if (g === gapCount - 1) {
          const finalStart = gapEnd;
          const finalEnd = edge.len;
          if (finalEnd > finalStart + 0.1) {
            segments.push({ start: finalStart, end: finalEnd });
          }
        }
      }

      // Build each solid segment
      for (const seg of segments) {
        const outerS = new THREE.Vector2(outerStart.x + tangent.x * seg.start, outerStart.y + tangent.y * seg.start);
        const outerE = new THREE.Vector2(outerStart.x + tangent.x * seg.end, outerStart.y + tangent.y * seg.end);
        const innerS = new THREE.Vector2(outerS.x + normal.x * wallThickness, outerS.y + normal.y * wallThickness);
        const innerE = new THREE.Vector2(outerE.x + normal.x * wallThickness, outerE.y + normal.y * wallThickness);

        const o0 = new THREE.Vector3(outerS.x, outerS.y, zBase);
        const o1 = new THREE.Vector3(outerE.x, outerE.y, zBase);
        const o2 = new THREE.Vector3(outerE.x, outerE.y, zTop);
        const o3 = new THREE.Vector3(outerS.x, outerS.y, zTop);
        
        const i0 = new THREE.Vector3(innerS.x, innerS.y, zBase);
        const i1 = new THREE.Vector3(innerE.x, innerE.y, zBase);
        const i2 = new THREE.Vector3(innerE.x, innerE.y, zTop);
        const i3 = new THREE.Vector3(innerS.x, innerS.y, zTop);

        // Outer face
        addQuad(o0, o1, o2, o3, false);
        // Inner face
        addQuad(i0, i3, i2, i1, false);
        // Top face
        addQuad(o3, o2, i2, i3, false);
        // Bottom face
        addQuad(o0, i0, i1, o1, false);
      }

      // Add perpendicular side faces at each gap to close the mesh
      for (const gap of gaps) {
        const outerS = new THREE.Vector2(outerStart.x + tangent.x * gap.start, outerStart.y + tangent.y * gap.start);
        const outerE = new THREE.Vector2(outerStart.x + tangent.x * gap.end, outerStart.y + tangent.y * gap.end);
        const innerS = new THREE.Vector2(outerS.x + normal.x * wallThickness, outerS.y + normal.y * wallThickness);
        const innerE = new THREE.Vector2(outerE.x + normal.x * wallThickness, outerE.y + normal.y * wallThickness);

        // Left side face (at gap start)
        const leftOuter0 = new THREE.Vector3(outerS.x, outerS.y, zBase);
        const leftOuter1 = new THREE.Vector3(outerS.x, outerS.y, zTop);
        const leftInner0 = new THREE.Vector3(innerS.x, innerS.y, zBase);
        const leftInner1 = new THREE.Vector3(innerS.x, innerS.y, zTop);
        addQuad(leftOuter0, leftInner0, leftInner1, leftOuter1, false);

        // Right side face (at gap end)
        const rightOuter0 = new THREE.Vector3(outerE.x, outerE.y, zBase);
        const rightOuter1 = new THREE.Vector3(outerE.x, outerE.y, zTop);
        const rightInner0 = new THREE.Vector3(innerE.x, innerE.y, zBase);
        const rightInner1 = new THREE.Vector3(innerE.x, innerE.y, zTop);
        addQuad(rightOuter0, rightOuter1, rightInner1, rightInner0, false);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return new THREE.Mesh(geometry);
}
