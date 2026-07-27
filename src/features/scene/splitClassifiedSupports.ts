import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { LoadedModel } from './useSceneCollectionManager';
import { accelerateGeometry } from '@/utils/bvh';
import { computeFlatteningPlanes } from '@/features/placeOnFace/logic/computeFlatteningPlanes';

/**
 * Is this buffer a VERBATIM full-resolution import, or a decimated stand-in?
 *
 * ## ⚠ Read this before reusing the predicate — it was named for a claim that is FALSE
 *
 * This function used to be called `classificationIndexesGeometry`, and its
 * docblock asserted that a `nativePreview` geometry's
 * `nativeRepairReport.model_triangle_count` addresses triangles the buffer does
 * not contain. **That is wrong, and the 2026-07-27 audit measured it wrong** —
 * see `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`.
 *
 * There are two counts. The old docblock quoted the contract of one and applied
 * it to the other:
 *
 * - **(A) file frame** — `ImportClassificationJson.model_triangle_count`, from
 *   the DFST header, measured by `classify_import` on the full-resolution source
 *   file. It travels as `geometry.importRunMap` / `nativePreview.runMap` and is
 *   consumed only by the run-map splice, in source-file indices. It genuinely
 *   does NOT index a decimated preview — and it never reaches a report.
 * - **(B) geometry frame** — `MeshHealthReport.model_triangle_count`, i.e.
 *   `geometry.meshDefects.nativeRepairReport`. A decimated preview runs its OWN
 *   `mesh_classify_staged` pass over its OWN triangles, is reordered model-first
 *   by that pass, and gets a count bounded by its own buffer by construction. It
 *   is a VALID index into the preview. The orange support overlay in `StlMesh`
 *   is built from exactly that index on exactly those previews, today, and it
 *   renders correctly — that is the field evidence.
 *
 * **Every caller of this predicate reads (B).** None reads (A). So this is not a
 * frame test and must never be described as one again.
 *
 * ## What it IS, and why it is still called
 *
 * It answers a narrower, honest question: *is this buffer a verbatim
 * full-resolution import?* Two Ph3c/Ph3d behaviours are built on that answer and
 * are deliberately retained (the user chose to fix forward rather than revert):
 *
 * - `splitClassifiedSupportGeometry` refuses the in-place scene cut for a
 *   preview, because Ph3d re-sources both sections from the original file
 *   instead — a genuinely better answer (full-res halves, per-section budget).
 * - `resolveOutputSectionPlan` returns `describes-source-file` for a preview,
 *   which routes Split-to-Bodies to that re-sourcing path.
 *
 * Both are over-broad relative to the frame question (audit §5, remediation
 * steps R4/R5, NOT authorised). Neither is a frame check. **Do not add a fourth
 * caller on the theory that (B) needs guarding — it does not.** The site that
 * did add one (`effectiveModelTriangleCount`, Ph3e) disabled support
 * anti-aliasing outright and was reverted.
 *
 * The correct predicate for "was THIS buffer reordered to match THIS report" is
 * `geometryMatchesReport` in `useStlGeometry.ts`, which answers YES for a
 * decimated preview.
 */
export function geometryIsVerbatimImport(geometry: Pick<GeometryWithBounds, 'nativePreview'>): boolean {
  return !geometry.nativePreview;
}

export type ClassifiedSupportGeometrySplit = {
  modelGeometry: GeometryWithBounds;
  supportGeometry: GeometryWithBounds;
  modelPosition: THREE.Vector3;
  supportPosition: THREE.Vector3;
  modelTriangleCount: number;
  supportTriangleCount: number;
  totalTriangleCount: number;
};

function buildGeometryWithBounds(
  positions: Float32Array,
  triangleCount: number,
  interactive: boolean,
): GeometryWithBounds {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (interactive) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  if (!interactive) {
    return { geometry, bbox, center, size, flatteningPlanes: [] };
  }

  accelerateGeometry(geometry);
  const flatteningPlanes = triangleCount * 3 < 15_000_000
    ? computeFlatteningPlanes(geometry)
    : [];
  let edgeGeometry: THREE.EdgesGeometry | undefined;
  if (triangleCount < 2_000_000) {
    try {
      edgeGeometry = new THREE.EdgesGeometry(geometry, 30);
    } catch {
      // Edge geometry is optional for very large meshes.
    }
  }

  return { geometry, bbox, center, size, flatteningPlanes, edgeGeometry };
}

export function splitClassifiedSupportGeometry(
  source: LoadedModel,
  options: { interactive?: boolean } = {},
): ClassifiedSupportGeometrySplit | null {
  const modelTriangleCount = Math.floor(
    source.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0,
  );
  if (modelTriangleCount <= 0) return null;

  // Refuse the in-place scene cut for a decimated preview.
  //
  // NOT because the count fails to index this buffer — it does index it (see
  // `geometryIsVerbatimImport`; the count is geometry-framed and this cut would
  // have been correct). The refusal stands because Ph3d routes previews to
  // `resource-sections` instead, which re-reads both halves from the original
  // file at full resolution — a better answer than cutting the stand-in.
  //
  // Known cost, accepted 2026-07-27: a preview with a valid count but no
  // re-readable source (VOXL reload, moved file) reports
  // `unavailable/source-unavailable` where this cut would have worked. Audit
  // step R5 would add it back as a fallback; not authorised.
  if (!geometryIsVerbatimImport(source.geometry)) return null;

  const geometry = source.geometry.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!position) return null;

  const sourcePositions = position.array;
  const positions = sourcePositions instanceof Float32Array
    ? sourcePositions
    : new Float32Array(sourcePositions as unknown as ArrayLike<number>);
  const totalTriangleCount = Math.floor(positions.length / 9);
  const supportTriangleCount = totalTriangleCount - modelTriangleCount;
  if (supportTriangleCount <= 0) return null;

  const modelFloatEnd = modelTriangleCount * 9;
  if (modelFloatEnd >= positions.length) return null;

  // Native classification rewrites the position soup model-first. The
  // context-menu behavior that is known to work slices this storage directly;
  // an index may be attached later and must not redefine this boundary.
  const modelPositions = positions.slice(0, modelFloatEnd);
  const supportPositions = positions.slice(modelFloatEnd);
  const interactive = options.interactive === true;
  const modelGeometry = buildGeometryWithBounds(
    modelPositions,
    modelTriangleCount,
    interactive,
  );
  const supportGeometry = buildGeometryWithBounds(
    supportPositions,
    supportTriangleCount,
    interactive,
  );

  const originalCenter = source.geometry.center;
  const rotation = new THREE.Quaternion().setFromEuler(source.transform.rotation);
  const adjustedPosition = (partCenter: THREE.Vector3) => {
    const offset = partCenter.clone().sub(originalCenter);
    offset.multiply(source.transform.scale).applyQuaternion(rotation);
    return source.transform.position.clone().add(offset);
  };

  return {
    modelGeometry,
    supportGeometry,
    modelPosition: adjustedPosition(modelGeometry.center),
    supportPosition: adjustedPosition(supportGeometry.center),
    modelTriangleCount,
    supportTriangleCount,
    totalTriangleCount,
  };
}
