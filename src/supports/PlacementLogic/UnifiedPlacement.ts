import * as THREE from 'three';
import { Vec3 } from '../types';
import {
  getSnapshot as getSupportSnapshot,
  addRoot,
  addTrunk,
  addAnchor,
  addBranch,
  addKnot,
  updateKnot,
  updateTrunk,
  addTwig,
  addStick,
} from '@/supports/state';
import { getSettings } from '@/supports/Settings';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { decideGridPlacement } from '@/supports/PlacementLogic/Grid/gridPlacement';
import { computeAndApplyTrunkDiameterProfile } from '@/supports/SupportTypes/Trunk/TrunkReplacement';
import { buildTwig } from '@/supports/SupportTypes/Twig/twigBuilder';
import { buildStick } from '@/supports/SupportTypes/Stick/stickBuilder';

export interface UnifiedPlacementInput {
  tipPos: Vec3;
  tipNormal: Vec3;
  modelId: string;
  mesh?: THREE.Mesh;
  roiId?: string;
}

export interface UnifiedPlacementResult {
  success: boolean;
  placedType?: 'trunk' | 'branch' | 'anchor' | 'twig' | 'stick';
  supportId?: string;
  error?: string;
}

/**
 * Validates a proposed support tip destination using standard SDF pathfinding.
 * Returns true if accepted (collision-free and printable), false otherwise.
 */
export function validateSupportPlacement(
  tipPos: Vec3,
  tipNormal: Vec3,
  modelId: string,
  mesh?: THREE.Mesh
): boolean {
  const build = buildTrunkData({
    tipPos,
    tipNormal,
    modelId,
    mesh,
  });
  return !build.stagnated && !build.exhaustedBudget && !build.error;
}

/**
 * Unified placement solver. Takes a tip coordinate and automatically routes, snap-grids,
 * recovers from cavities via sticks/twigs, and commits the support transaction.
 */
export function placeSupportUnified(input: UnifiedPlacementInput): UnifiedPlacementResult {
  const { tipPos, tipNormal, modelId, mesh, roiId } = input;
  const settings = getSettings();

  // 1. Run main support placement routing via trunkBuilder
  const build = buildTrunkData({
    tipPos,
    tipNormal,
    modelId,
    mesh,
  });

  // 2. If pathfinding stagnated or exhausted budget, fall back to cavity stick/twig
  if (build.stagnated || build.exhaustedBudget || build.error) {
    if (mesh) {
      const cavity = placeCavityStick(tipPos, tipNormal, modelId, mesh, roiId);
      if (cavity) {
        return {
          success: true,
          placedType: cavity.kind,
          supportId: cavity.id,
        };
      }
    }
    return {
      success: false,
      error: build.error || 'COLLISION_WITH_MODEL',
    };
  }

  // 3. Grid snapped snaps & branching decisions
  const snapshot = getSupportSnapshot();
  const decision = decideGridPlacement({
    settings,
    snapshot,
    candidate: build,
    tipPos,
    tipNormal,
    modelId,
    mesh,
  });

  if (decision.kind === 'place_trunk') {
    const tb = decision.trunkBuild;
    if (tb?.trunk && !tb.stagnated && !tb.exhaustedBudget && !tb.error) {
      if (roiId) {
        if (tb.root) tb.root.roiId = roiId;
        tb.trunk.roiId = roiId;
      }
      addRoot(tb.root);
      addTrunk(tb.trunk);
      return { success: true, placedType: 'trunk', supportId: tb.trunk.id };
    }
  } else if (decision.kind === 'place_branch') {
    if (roiId) {
      decision.branch.roiId = roiId;
    }
    addKnot(decision.knot);
    addBranch(decision.branch);

    const snapshotAfterAdd = getSupportSnapshot();
    const hostTrunk = snapshotAfterAdd.trunks[decision.hostTrunkId];
    if (hostTrunk) {
      const applied = computeAndApplyTrunkDiameterProfile(snapshotAfterAdd, decision.hostTrunkId);
      if (applied) {
        for (const u of applied.knotUpdates) {
          updateKnot(u.after);
        }
        updateTrunk(applied.trunk);
      }
    }
    return { success: true, placedType: 'branch', supportId: decision.branch.id };
  } else if (decision.kind === 'place_anchor') {
    if (roiId) {
      decision.anchor.roiId = roiId;
    }
    addAnchor(decision.anchor);
    return { success: true, placedType: 'anchor', supportId: decision.anchor.id };
  } else if (decision.kind === 'replace_trunk') {
    if (roiId) {
      decision.promoteBranch.roiId = roiId;
    }
    addKnot(decision.promoteKnot);
    addBranch(decision.promoteBranch);

    const tb = decision.trunkBuild;
    if (tb?.trunk) {
      if (roiId) {
        if (tb.root) tb.root.roiId = roiId;
        tb.trunk.roiId = roiId;
      }
      addRoot(tb.root);
      addTrunk(tb.trunk);
      return { success: true, placedType: 'trunk', supportId: tb.trunk.id };
    }
  }

  return {
    success: false,
    error: 'PLACEMENT_DECISION_FAILED',
  };
}

const _cavityRaycaster = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, 0, -1);

function placeCavityStick(
  tipPos: Vec3,
  tipNormal: Vec3,
  modelId: string,
  mesh: THREE.Mesh,
  roiId?: string
): { kind: 'stick' | 'twig'; id: string } | null {
  _cavityRaycaster.set(
    new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z),
    _downDir
  );
  const OFFSET_MM = 0.5;
  _cavityRaycaster.ray.origin.addScaledVector(
    new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
    OFFSET_MM
  );
  _cavityRaycaster.ray.origin.z -= OFFSET_MM * 0.1;

  const hits = _cavityRaycaster.intersectObject(mesh, false);
  if (hits.length === 0) return null;

  const BELOW_EPS_MM = 0.1;
  const FLOOR_Z_MIN = 0.35;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

  type Candidate = { hit: THREE.Intersection; normal: THREE.Vector3 };
  const MAX_HIT_SCAN = 64;
  let scanned = 0;
  let firstBelowCandidate: Candidate | null = null;
  let floorCandidate: Candidate | null = null;

  for (const h of hits) {
    scanned += 1;
    if (scanned > MAX_HIT_SCAN) break;
    if (h.point.z >= tipPos.z - BELOW_EPS_MM) continue;
    if (!h.face) continue;
    const n = h.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();
    const candidate = { hit: h, normal: n };
    if (!firstBelowCandidate) firstBelowCandidate = candidate;
    if (n.z >= FLOOR_Z_MIN) {
      floorCandidate = candidate;
      break;
    }
  }

  const chosen = floorCandidate ?? firstBelowCandidate;
  if (!chosen) return null;

  const bPos = { x: chosen.hit.point.x, y: chosen.hit.point.y, z: chosen.hit.point.z };
  const bNormal = { x: chosen.normal.x, y: chosen.normal.y, z: chosen.normal.z };

  const settings = getSettings();
  const cutoff = settings.meshToMesh?.stickVsTwigCutoffMm ?? 5;
  const dx = tipPos.x - bPos.x;
  const dy = tipPos.y - bPos.y;
  const dz = tipPos.z - bPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const kind: 'twig' | 'stick' = dist > cutoff ? 'stick' : 'twig';

  if (kind === 'twig') {
    const { twig } = buildTwig({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });
    if (roiId) twig.roiId = roiId;
    addTwig(twig);
    return { kind: 'twig', id: twig.id };
  }

  const { stick } = buildStick({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });
  if (roiId) stick.roiId = roiId;
  addStick(stick);
  return { kind: 'stick', id: stick.id };
}
