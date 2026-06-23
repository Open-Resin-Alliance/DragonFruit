import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  normalizeSupportReconstructionResult,
  transformTriangleSoupToWorld,
} from '../nativeSupportReconstruction';

function validResult(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    analyzerVersion: '0.4.0-profile',
    modelTriangleCount: 1,
    supportTriangleCount: 1,
    components: [],
    graph: {
      roots: [],
      axialCandidates: [],
      endpoints: [],
      joints: [],
      contacts: [],
      attachments: [],
      topologyCandidates: [],
      edges: [],
    },
    coverage: {
      sourceTriangleCount: 1,
      matchedTriangleCount: 0,
      unmatchedTriangleCount: 1,
      surfaceCoverage: 0,
    },
    warnings: [],
    timings: { preprocessMs: 0, componentAnalysisMs: 0, totalMs: 0 },
  };
}

test('normalizes the supported reconstruction schema', () => {
  const input = validResult();
  assert.equal(normalizeSupportReconstructionResult(input), input);
});

test('rejects unknown schemas and non-finite diagnostics', () => {
  assert.throws(
    () => normalizeSupportReconstructionResult({ ...validResult(), schemaVersion: 2 }),
    /Unsupported support reconstruction schema 2/,
  );
  const nonFinite = validResult();
  (nonFinite.timings as Record<string, unknown>).totalMs = Number.NaN;
  assert.throws(
    () => normalizeSupportReconstructionResult(nonFinite),
    /non-finite number at result\.timings\.totalMs/,
  );
});

test('transforms classified triangle soup into world space', () => {
  const source = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(5, 6, 7),
    new THREE.Quaternion(),
    new THREE.Vector3(2, 3, 4),
  );
  assert.deepEqual(
    Array.from(transformTriangleSoupToWorld(source, matrix)),
    [5, 6, 7, 7, 6, 7, 5, 9, 7],
  );
});
