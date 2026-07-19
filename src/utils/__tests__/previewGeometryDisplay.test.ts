import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import {
  actualSceneTriangleCount,
  carryPreviewMarkerForward,
  getPreviewBadgeInfo,
  resolveDisplayPolygonCount,
} from '../previewGeometryDisplay';

/**
 * Phase 2b — CP1 preview-honesty contract (STL-import decimation remediation;
 * docs in `agents/Claude/STL-import-perf/`).
 *
 * CONTRACT: the displayed `polygonCount` of a native-preview model must reflect
 * the ACTUAL scene geometry it holds (the reduced preview), NOT the concealed
 * `nativePreview.originalTriangleCount`. Today the reverse is true
 * (useSceneCollectionManager.ts import/hydration sites:
 * `polygonCount: nativePreview?.originalTriangleCount ?? actual`), so a 12M
 * import that renders a ~2M preview reports "12M triangles" while showing 2M —
 * the concealment the audit surfaced.
 *
 * BOUNDARY: `polygonCount` is assembled inline inside a React hook and is not
 * unit-testable in isolation, so Phase 2b extracts the pure
 * `resolveDisplayPolygonCount(geometry)` helper the hook now delegates to
 * (plan Phase 2 step 1). This test pins that boundary. It is RED at CP1 (the
 * helper mirrors today's concealment) and GREEN at CP2 (helper returns actual).
 */

function buildPreviewGeometry(): GeometryWithBounds {
  // Two-triangle stand-in for the reduced preview; the marker claims the
  // original file had 12M triangles (concealment target).
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 2, 0, 1, 0, 2, 1],
      3,
    ),
  );
  g.computeBoundingBox();
  const bbox = g.boundingBox?.clone() ?? new THREE.Box3();
  return {
    geometry: g,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
    nativePreview: {
      originalTriangleCount: 12_000_000,
      previewTriangleCount: 2,
      achievedError: 0.00042,
      budgetTriangles: 2,
    },
  };
}

test('actualSceneTriangleCount reports the real buffer triangle count', () => {
  const geom = buildPreviewGeometry();
  try {
    assert.equal(actualSceneTriangleCount(geom), 2);
  } finally {
    geom.geometry.dispose();
  }
});

test('resolveDisplayPolygonCount reflects the ACTUAL scene geometry, not originalTriangleCount', () => {
  const geom = buildPreviewGeometry();
  try {
    assert.equal(
      resolveDisplayPolygonCount(geom),
      2,
      'the displayed polygon count for a native-preview model must be the actual '
        + 'scene triangle count (2), not the concealed original (12,000,000): the '
        + 'preview IS the scene geometry, and the count must not lie about it '
        + '(plan Phase 2 step 1).',
    );
  } finally {
    geom.geometry.dispose();
  }
});

test('resolveDisplayPolygonCount is a plain count for a non-preview model', () => {
  const geom = buildPreviewGeometry();
  delete (geom as { nativePreview?: unknown }).nativePreview;
  try {
    assert.equal(resolveDisplayPolygonCount(geom), 2);
  } finally {
    geom.geometry.dispose();
  }
});

/**
 * CP4 — badge-lifecycle rule (census finding 3). A geometry write-back whose
 * input was a preview must carry the marker forward so the badge keeps firing;
 * a non-preview input must NOT gain a marker (default-safe).
 */
test('carryPreviewMarkerForward propagates a marker as a fresh copy', () => {
  const prior = buildPreviewGeometry();
  try {
    const carried = carryPreviewMarkerForward(prior);
    assert.ok(carried, 'a preview input must carry a marker forward');
    assert.notEqual(carried, prior.nativePreview, 'must be a fresh copy, not an alias');
    assert.equal(carried?.originalTriangleCount, 12_000_000);
    assert.equal(carried?.achievedError, 0.00042);
  } finally {
    prior.geometry.dispose();
  }
});

test('carryPreviewMarkerForward is default-safe for a non-preview input', () => {
  const prior = buildPreviewGeometry();
  delete (prior as { nativePreview?: unknown }).nativePreview;
  try {
    assert.equal(carryPreviewMarkerForward(prior), undefined);
  } finally {
    prior.geometry.dispose();
  }
});

test('carryPreviewMarkerForward clears the marker when the caller asks (future full-res path)', () => {
  const prior = buildPreviewGeometry();
  try {
    assert.equal(carryPreviewMarkerForward(prior, { clearNativePreview: true }), undefined);
  } finally {
    prior.geometry.dispose();
  }
});

test('the badge still fires after a preview-derived write-back changes the buffer', () => {
  const prior = buildPreviewGeometry();
  // Simulate a hollow/punch output: a DIFFERENT buffer (one triangle here),
  // rebuilt via replaceModelGeometry's rule (marker carried forward).
  const nextBuffer = new THREE.BufferGeometry();
  nextBuffer.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  nextBuffer.computeBoundingBox();
  const carried = carryPreviewMarkerForward(prior);
  const nextGeometry: GeometryWithBounds = {
    geometry: nextBuffer,
    bbox: nextBuffer.boundingBox?.clone() ?? new THREE.Box3(),
    center: new THREE.Vector3(),
    size: new THREE.Vector3(),
    flatteningPlanes: [],
    ...(carried ? { nativePreview: carried } : {}),
  };
  try {
    const badge = getPreviewBadgeInfo(nextGeometry);
    assert.ok(badge, 'preview badge must still fire on a preview-derived geometry');
    assert.equal(badge?.previewTriangleCount, 1, 'preview count reflects the NEW buffer (actual)');
    assert.equal(badge?.originalTriangleCount, 12_000_000, 'full count is preserved for "(full: N)"');
    // Honest polygonCount for the mutated model = the actual new buffer count.
    assert.equal(resolveDisplayPolygonCount(nextGeometry), 1);
  } finally {
    prior.geometry.dispose();
    nextBuffer.dispose();
  }
});
