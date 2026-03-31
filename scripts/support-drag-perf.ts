#!/usr/bin/env npx tsx
/**
 * Support drag preview performance benchmark.
 *
 * Usage:
 *   npx tsx scripts/support-drag-perf.ts
 */

import { computeJointDragPreviewKnots } from '../src/supports/interaction/jointDragPreviewMath';
import {
  buildBranchCandidateKnotIdsByBranchId,
  buildBranchesByParentKnotId,
  computeCascadedPreviewKnotOverrides,
} from '../src/supports/interaction/supportPreviewOverlay';
import type { Branch, Knot, Roots, Trunk } from '../src/supports/types';

interface BenchResult {
  name: string;
  iterations: number;
  meanMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

function bench(name: string, iterations: number, fn: () => void): BenchResult {
  // Warmup
  for (let i = 0; i < 24; i++) fn();

  const times: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    times[i] = t1 - t0;
  }

  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const meanMs = sum / iterations;
  const p95Ms = times[Math.min(iterations - 1, Math.floor(iterations * 0.95))];
  const minMs = times[0];
  const maxMs = times[iterations - 1];

  return { name, iterations, meanMs, p95Ms, minMs, maxMs };
}

function fmt(ms: number) {
  return ms.toFixed(4);
}

function createRoot(): Roots {
  return {
    id: 'root-0',
    modelId: 'model-0',
    diameter: 2.4,
    diskHeight: 0.3,
    coneHeight: 0.8,
    transform: {
      pos: { x: 0, y: 0, z: 0 },
      rot: { x: 0, y: 0, z: 0 },
    },
  } as Roots;
}

function createTrunk(root: Roots): Trunk {
  return {
    id: 'trunk-0',
    modelId: root.modelId,
    rootId: root.id,
    segments: [
      {
        id: 'trunk-seg-0',
        type: 'straight',
        diameter: 1.8,
        topJoint: {
          id: 'trunk-joint-top-0',
          pos: { x: 0, y: 0, z: 20 },
          diameter: 1.9,
        },
      },
    ],
    contactCone: undefined,
  } as unknown as Trunk;
}

function createBranch(id: number, parentKnotId: string, x: number, zBase: number): Branch {
  return {
    id: `branch-${id}`,
    modelId: 'model-0',
    parentKnotId,
    segments: [
      {
        id: `branch-${id}-seg-0`,
        type: 'straight',
        diameter: 1.2,
        topJoint: {
          id: `branch-${id}-joint-top-0`,
          pos: { x: x + 0.4, y: (id % 3) * 0.2, z: zBase + 1.2 },
          diameter: 1.2,
        },
      },
    ],
    contactCone: undefined,
  } as unknown as Branch;
}

function createKnot(id: string, parentShaftId: string, t: number, x: number, y: number, z: number): Knot {
  return {
    id,
    parentShaftId,
    t,
    diameter: 1.3,
    pos: { x, y, z },
  } as Knot;
}

function buildScenario(branchCount = 320) {
  const root = createRoot();
  const trunk = createTrunk(root);

  const rootKnot = createKnot('knot-root', 'trunk-seg-0', 0.35, 0, 0, 7);

  const branches: Branch[] = [];
  const committedKnotsById: Record<string, Knot> = {
    [rootKnot.id]: rootKnot,
  };

  for (let i = 0; i < branchCount; i++) {
    const parentKnotId = i % 8 === 0 && i > 0
      ? `knot-branch-${Math.max(0, i - 8)}`
      : rootKnot.id;

    const branch = createBranch(i, parentKnotId, (i % 16) * 0.35, 8 + Math.floor(i / 12) * 0.45);
    branches.push(branch);

    const seg = branch.segments[0];
    const knot = createKnot(`knot-branch-${i}`, seg.id, 0.42, seg.topJoint!.pos.x * 0.9, seg.topJoint!.pos.y * 0.9, seg.topJoint!.pos.z * 0.92);
    committedKnotsById[knot.id] = knot;
  }

  const knotIdsByParentShaftId = new Map<string, string[]>();
  for (const knot of Object.values(committedKnotsById)) {
    const list = knotIdsByParentShaftId.get(knot.parentShaftId);
    if (list) list.push(knot.id);
    else knotIdsByParentShaftId.set(knot.parentShaftId, [knot.id]);
  }

  const branchesByParentKnotId = buildBranchesByParentKnotId(branches);
  const branchCandidateKnotIdsByBranchId = buildBranchCandidateKnotIdsByBranchId(branches, knotIdsByParentShaftId);

  const branchesById: Record<string, Branch> = {};
  for (const branch of branches) branchesById[branch.id] = branch;

  const activeBranch = branches[Math.floor(branches.length / 3)];
  const activeBranchPreview: Branch = {
    ...activeBranch,
    segments: activeBranch.segments.map((seg) => ({
      ...seg,
      topJoint: seg.topJoint
        ? {
          ...seg.topJoint,
          pos: {
            x: seg.topJoint.pos.x + 0.15,
            y: seg.topJoint.pos.y + 0.1,
            z: seg.topJoint.pos.z + 0.2,
          },
        }
        : seg.topJoint,
    })),
  };

  const candidateKnots: Record<string, Knot> = {};
  for (const knotId of branchCandidateKnotIdsByBranchId.get(activeBranch.id) ?? []) {
    candidateKnots[knotId] = committedKnotsById[knotId];
  }

  const basePreviewKnotOverrides = computeJointDragPreviewKnots(
    { kind: 'branch', supportId: activeBranch.id, support: activeBranchPreview },
    { parentKnot: committedKnotsById[activeBranch.parentKnotId] },
    candidateKnots,
  );

  return {
    root,
    trunk,
    branches,
    branchesById,
    committedKnotsById,
    branchesByParentKnotId,
    branchCandidateKnotIdsByBranchId,
    activeBranch,
    activeBranchPreview,
    basePreviewKnotOverrides,
    candidateKnots,
  };
}

function printResult(r: BenchResult) {
  console.log(
    `${r.name}\n  iters=${r.iterations}  mean=${fmt(r.meanMs)}ms  p95=${fmt(r.p95Ms)}ms  min=${fmt(r.minMs)}ms  max=${fmt(r.maxMs)}ms`,
  );
}

function main() {
  const iterations = 1200;
  const s = buildScenario();

  const jointPreviewResult = bench('joint preview knot projection', iterations, () => {
    computeJointDragPreviewKnots(
      { kind: 'branch', supportId: s.activeBranch.id, support: s.activeBranchPreview },
      { parentKnot: s.committedKnotsById[s.activeBranch.parentKnotId] },
      s.candidateKnots,
    );
  });

  const cascadedResult = bench('cascaded preview propagation', iterations, () => {
    computeCascadedPreviewKnotOverrides({
      activeJointDragPreview: { kind: 'branch', supportId: s.activeBranch.id, support: s.activeBranchPreview },
      basePreviewKnotOverrides: s.basePreviewKnotOverrides,
      branchesByParentKnotId: s.branchesByParentKnotId,
      branchCandidateKnotIdsByBranchId: s.branchCandidateKnotIdsByBranchId,
      branchesById: s.branchesById,
      committedKnotsById: s.committedKnotsById,
    });
  });

  console.log('Support drag perf benchmark');
  console.log('---------------------------');
  printResult(jointPreviewResult);
  printResult(cascadedResult);
}

main();
