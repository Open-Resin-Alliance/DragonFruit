/**
 * Every raft mesh a cluster of support roots prints, in the order the exporter
 * emits them: the base (or, in line mode, the beam network) and then the wall.
 *
 * The exporter slices these triangles and the resin estimate sums their volume,
 * so both read one raft. Keeping the line-mode beam construction here — not
 * duplicated in the exporter and the estimate — is what stops the two from
 * disagreeing about beams a model is in the way of.
 */

import * as THREE from 'three';

import type { RaftSettings, SupportBaseCircle } from '../RaftTypes';
import type { PolygonWithHoles } from './polygonSet2d';
import { buildLineRaftEdgePairs } from './buildLineRaftEdgePairs';
import { filterLineRaftEdges, generateUnionedLineRaftMesh } from './generateUnionedLineRaftMesh';
import { generateChamferedBeam } from './generateChamferedBeam';
import { buildRaftFootprintMeshes } from './generateRaftFromFootprint';
import { inflateModelPlateClearance } from './computeRaftFootprint';

export interface RaftMeshesForCirclesInput {
  circles: readonly SupportBaseCircle[];
  raft: RaftSettings;
  /** Model footprints the raft has to clear; null or empty means nothing in the way. */
  clearance?: readonly PolygonWithHoles[] | null;
}

/** The raft meshes this cluster prints; empty when nothing stands on the plate. */
export function buildRaftMeshesForCircles({
  circles,
  raft,
  clearance,
}: RaftMeshesForCirclesInput): THREE.Mesh[] {
  const parts = buildRaftFootprintMeshes({ circles, raft, clearance });
  const meshes: THREE.Mesh[] = [];

  if (parts.baseMesh) {
    meshes.push(parts.baseMesh);
  } else if (raft.bottomMode === 'line' && parts.footprint.length > 0) {
    // A model on the plate is never cut through: a beam it is in the way of is
    // dropped whole, so the clusters either side stay separate.
    const nodes2d = circles.map((circle) => new THREE.Vector2(circle.x, circle.y));
    const edgePairs = buildLineRaftEdgePairs(nodes2d, {
      hasBorderRing: true,
      keepFactor: 8,
      absMaxLen: 220,
      enforceConnected: true,
    });
    const beamHeight = Math.max(0.01, raft.lineHeightMm);
    const unionEdges = filterLineRaftEdges(
      edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]),
      inflateModelPlateClearance(clearance ?? []),
      raft.lineWidthMm,
    );

    const unionMesh = generateUnionedLineRaftMesh(unionEdges, {
      widthMm: raft.lineWidthMm,
      heightMm: beamHeight,
      borderProfile: null,
    });
    const unionPosition = unionMesh.geometry.getAttribute('position');
    if (unionPosition && unionPosition.count > 0) {
      meshes.push(unionMesh);
    } else {
      for (const [a, b] of unionEdges) {
        meshes.push(generateChamferedBeam(
          new THREE.Vector3(a.x, a.y, 0),
          new THREE.Vector3(b.x, b.y, 0),
          { widthMm: raft.lineWidthMm, heightMm: beamHeight, chamferAngleDeg: 90 },
        ));
      }
    }
  }

  if (parts.wallMesh) meshes.push(parts.wallMesh);

  return meshes;
}
