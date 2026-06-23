import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeSupportPreview, validateNativeSupportPayload } from '../nativeSupportAdapter';
import type {
  ReconstructionAxialCandidate,
  ReconstructionConfidence,
  ReconstructionEndpointCandidate,
  SupportReconstructionResult,
} from '../nativeSupportReconstruction';

const confidence: ReconstructionConfidence = {
  primitiveFit: 1,
  endpointClassification: 1,
  attachmentFit: 1,
  topology: 1,
  finalConfidence: 1,
};

function axial(id: string, x = 0): ReconstructionAxialCandidate {
  return {
    id,
    sourceComponentId: Number(id.replace(/\D/g, '')) || 0,
    axis: { x: 0, y: 0, z: 1 },
    start: { x, y: 0, z: 0 },
    end: { x, y: 0, z: 10 },
    shaftStart: { x, y: 0, z: 1 },
    shaftEnd: { x, y: 0, z: 9 },
    accepted: true,
    lengthMm: 10,
    shaftLengthMm: 8,
    startTransitionLengthMm: 1,
    endTransitionLengthMm: 1,
    startRadiusMm: 1.5,
    endRadiusMm: 0.4,
    meanRadiusMm: 0.5,
    radialResidualMm: 0.02,
    aspectRatio: 16,
    confidence,
    rejectionCodes: [],
  };
}

function endpoint(id: string, axialCandidateId: string, side: 'start' | 'end', kind: ReconstructionEndpointCandidate['kind'], x = 0): ReconstructionEndpointCandidate {
  const z = side === 'start' ? 0 : 10;
  return {
    id,
    axialCandidateId,
    sourceComponentId: 0,
    side,
    kind,
    sourcePosition: { x, y: 0, z },
    resolvedPosition: { x, y: 0, z },
    distanceMm: 0,
    confidence: 1,
  };
}

function result(overrides: Partial<SupportReconstructionResult['graph']> = {}): SupportReconstructionResult {
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
      ...overrides,
    },
    coverage: { sourceTriangleCount: 1, matchedTriangleCount: 0, unmatchedTriangleCount: 1, surfaceCoverage: 0 },
    warnings: [],
    timings: { preprocessMs: 0, componentAnalysisMs: 0, totalMs: 0 },
  };
}

function ids() {
  let counter = 0;
  return (prefix: string) => `${prefix}-${++counter}`;
}

test('converts a profiled trunk into native root, segment, joint, and contact cone', () => {
  const preview = buildNativeSupportPreview(result({
    axialCandidates: [axial('axial-a')],
    endpoints: [endpoint('ep-root', 'axial-a', 'start', 'plate'), endpoint('ep-contact', 'axial-a', 'end', 'model')],
    roots: [{ id: 'root-a', axialCandidateId: 'axial-a', endpointId: 'ep-root', sourceComponentId: 0, position: { x: 0, y: 0, z: 0 }, diameterMm: 3, confidence }],
    contacts: [{ id: 'contact-a', axialCandidateId: 'axial-a', endpointId: 'ep-contact', sourceComponentId: 0, position: { x: 0, y: 0, z: 10 }, surfaceNormal: { x: 0, y: 0, z: 1 }, diameterMm: 0.8, modelFaceIndex: 12, distanceMm: 0, confidence }],
    topologyCandidates: [{ id: 'topology-a', kind: 'trunk', axialCandidateId: 'axial-a', rootIds: ['root-a'], contactIds: ['contact-a'], attachmentIds: [], confidence, rejectionCodes: [] }],
  }), { modelId: 'model-1', objectCenter: { x: 0, y: 0, z: 0 }, idFactory: ids() });

  assert.equal(preview.rejected.length, 0);
  assert.deepEqual(preview.validationErrors, []);
  assert.equal(preview.payload.roots.length, 1);
  assert.equal(preview.payload.trunks.length, 1);
  assert.equal(preview.payload.trunks[0].segments[0].topJoint?.pos.z, 9);
  assert.equal(preview.payload.trunks[0].contactCone?.profile.lengthMm, 1);
  assert.equal(preview.payload.trunks[0].contactCone?.socketJointId, preview.payload.trunks[0].segments[0].topJoint?.id);
});

test('converts branches and braces through preserved host knots', () => {
  const hostA = axial('axial-host-a', 0);
  const hostB = axial('axial-host-b', 5);
  const branch = axial('axial-branch', 1);
  const brace = axial('axial-brace', 2.5);
  const preview = buildNativeSupportPreview(result({
    axialCandidates: [hostA, hostB, branch, brace],
    endpoints: [
      endpoint('ep-ha-root', hostA.id, 'start', 'plate', 0),
      endpoint('ep-hb-root', hostB.id, 'start', 'plate', 5),
      endpoint('ep-br-attach', branch.id, 'start', 'support', 1),
      endpoint('ep-br-contact', branch.id, 'end', 'model', 1),
      endpoint('ep-bc-a', brace.id, 'start', 'support', 2.5),
      endpoint('ep-bc-b', brace.id, 'end', 'support', 2.5),
    ],
    roots: [
      { id: 'root-ha', axialCandidateId: hostA.id, endpointId: 'ep-ha-root', sourceComponentId: 0, position: { x: 0, y: 0, z: 0 }, diameterMm: 3, confidence },
      { id: 'root-hb', axialCandidateId: hostB.id, endpointId: 'ep-hb-root', sourceComponentId: 1, position: { x: 5, y: 0, z: 0 }, diameterMm: 3, confidence },
    ],
    contacts: [{ id: 'contact-branch', axialCandidateId: branch.id, endpointId: 'ep-br-contact', sourceComponentId: 2, position: { x: 1, y: 0, z: 10 }, surfaceNormal: { x: 0, y: 0, z: 1 }, diameterMm: 0.7, modelFaceIndex: 1, distanceMm: 0, confidence }],
    attachments: [
      { id: 'attach-branch', endpointId: 'ep-br-attach', guestAxialCandidateId: branch.id, sourceComponentId: 2, position: { x: 0, y: 0, z: 5 }, hostAxialCandidateId: hostA.id, hostT: 0.5, distanceMm: 0, confidence },
      { id: 'attach-brace-a', endpointId: 'ep-bc-a', guestAxialCandidateId: brace.id, sourceComponentId: 3, position: { x: 0, y: 0, z: 6 }, hostAxialCandidateId: hostA.id, hostT: 0.625, distanceMm: 0, confidence },
      { id: 'attach-brace-b', endpointId: 'ep-bc-b', guestAxialCandidateId: brace.id, sourceComponentId: 3, position: { x: 5, y: 0, z: 6 }, hostAxialCandidateId: hostB.id, hostT: 0.625, distanceMm: 0, confidence },
    ],
    topologyCandidates: [
      { id: 'top-host-a', kind: 'trunk', axialCandidateId: hostA.id, rootIds: ['root-ha'], contactIds: [], attachmentIds: [], confidence, rejectionCodes: [] },
      { id: 'top-host-b', kind: 'trunk', axialCandidateId: hostB.id, rootIds: ['root-hb'], contactIds: [], attachmentIds: [], confidence, rejectionCodes: [] },
      { id: 'top-branch', kind: 'branch', axialCandidateId: branch.id, rootIds: [], contactIds: ['contact-branch'], attachmentIds: ['attach-branch'], confidence, rejectionCodes: [] },
      { id: 'top-brace', kind: 'brace', axialCandidateId: brace.id, rootIds: [], contactIds: [], attachmentIds: ['attach-brace-a', 'attach-brace-b'], confidence, rejectionCodes: [] },
    ],
  }), { modelId: 'model-1', objectCenter: { x: 0, y: 0, z: 0 }, idFactory: ids() });

  assert.equal(preview.rejected.length, 0);
  assert.deepEqual(preview.validationErrors, []);
  assert.equal(preview.payload.trunks.length, 2);
  assert.equal(preview.payload.branches.length, 1);
  assert.equal(preview.payload.braces.length, 1);
  assert.equal(preview.payload.knots.length, 3);
  const segmentIds = new Set(preview.payload.trunks.flatMap((trunk) => trunk.segments.map((segment) => segment.id)));
  assert.ok(preview.payload.knots.every((knot) => segmentIds.has(knot.parentShaftId)));
});

test('rejects topology with missing contact transition', () => {
  const bad = axial('axial-bad');
  bad.shaftEnd = { x: 0, y: 0, z: 10 };
  const preview = buildNativeSupportPreview(result({
    axialCandidates: [bad],
    endpoints: [endpoint('ep-root', bad.id, 'start', 'plate'), endpoint('ep-contact', bad.id, 'end', 'model')],
    roots: [{ id: 'root-bad', axialCandidateId: bad.id, endpointId: 'ep-root', sourceComponentId: 0, position: { x: 0, y: 0, z: 0 }, diameterMm: 3, confidence }],
    contacts: [{ id: 'contact-bad', axialCandidateId: bad.id, endpointId: 'ep-contact', sourceComponentId: 0, position: { x: 0, y: 0, z: 10 }, surfaceNormal: { x: 0, y: 0, z: 1 }, diameterMm: 0.8, modelFaceIndex: 1, distanceMm: 0, confidence }],
    topologyCandidates: [{ id: 'top-bad', kind: 'trunk', axialCandidateId: bad.id, rootIds: ['root-bad'], contactIds: ['contact-bad'], attachmentIds: [], confidence, rejectionCodes: [] }],
  }), { modelId: 'model-1', objectCenter: { x: 0, y: 0, z: 0 }, idFactory: ids() });

  assert.equal(preview.payload.trunks.length, 0);
  assert.equal(preview.rejected[0].code, 'missing_contact_transition');
  assert.deepEqual(preview.validationErrors, []);
});

test('native payload validator reports dangling references before import merge', () => {
  const preview = buildNativeSupportPreview(result({
    axialCandidates: [axial('axial-a')],
    endpoints: [endpoint('ep-root', 'axial-a', 'start', 'plate')],
    roots: [{ id: 'root-a', axialCandidateId: 'axial-a', endpointId: 'ep-root', sourceComponentId: 0, position: { x: 0, y: 0, z: 0 }, diameterMm: 3, confidence }],
    topologyCandidates: [{ id: 'topology-a', kind: 'trunk', axialCandidateId: 'axial-a', rootIds: ['root-a'], contactIds: [], attachmentIds: [], confidence, rejectionCodes: [] }],
  }), { modelId: 'model-1', objectCenter: { x: 0, y: 0, z: 0 }, idFactory: ids() });

  const broken = {
    ...preview.payload,
    branches: [{
      id: 'branch-broken',
      modelId: 'model-1',
      parentKnotId: 'missing-knot',
      segments: [{ id: 'dangling-segment', diameter: 0.5 }],
    }],
  };
  const errors = validateNativeSupportPayload(broken, 'model-1');

  assert.ok(errors.some((message) => message.includes('missing knot missing-knot')));
});
