/**
 * Shared test-support factories for the two `model_triangle_count` frames.
 *
 * NOT a test file (the suite glob is `src/**\/*.test.{ts,tsx}`), and not
 * production code — it exists so that a fixture has to SAY which frame it is
 * modelling. Every synthetic `model_triangle_count` in the tree was written by
 * hand, in a tree where the two frames were the same type; no test could have
 * caught the conflation because no test could express the difference.
 *
 * See `@/utils/triangleCountFrames` for what (A) and (B) are, and
 * `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`
 * for the census the factories were derived from.
 *
 * ## Design rule these factories follow
 *
 * **They take every field and default nothing.** The local `mapWith` /
 * `runtimeMap` / `makeModel` helpers around the suite each carry their own
 * defaults (`sourceTriangleCount` is 3 168 in one file and 11 228 556 in
 * another; `droppedNonFiniteTriangles` is 0 in one and 3 in another), and those
 * defaults are part of what each test asserts. A factory that supplied its own
 * would quietly convert a passing test into a *different* passing test. So each
 * local helper keeps its defaults and calls a factory to say which frame the
 * result is in — which is the only thing the factory adds, and the only thing
 * that was missing.
 */
import { asFileFrameCount, asGeometryFrameCount } from '@/utils/triangleCountFrames';
import type { ImportRunMap, ImportRunMapSummary } from '@/utils/importRunMap';
import type { MeshHealthReport } from '@/utils/meshRepair';

/** Plain-number mirror of {@link ImportRunMap}, so overrides stay ergonomic. */
export type FileFrameRunMapFixture = {
  runs: Uint32Array;
  sourceTriangleCount: number;
  /** FRAME (A) — a SOURCE-FILE triangle count. */
  modelTriangleCount: number;
  droppedNonFiniteTriangles: number;
  totalRunCount: number;
};

/** Plain-number mirror of {@link ImportRunMapSummary}. */
export type FileFrameRunMapSummaryFixture = {
  entryCount: number;
  sourceTriangleCount: number;
  /** FRAME (A) — a SOURCE-FILE triangle count. */
  modelTriangleCount: number;
  droppedNonFiniteTriangles: number;
  totalRunCount: number;
};

/**
 * FRAME (A) — the runtime import run map, in SOURCE-FILE triangle indices.
 *
 * What the DFST header carries and what the run-map splice consumes. Its
 * `modelTriangleCount` is the count `classify_import` measured over the whole
 * original file; on a decimated preview it addresses triangles the scene buffer
 * does not contain.
 */
export function makeFileFrameRunMap(input: FileFrameRunMapFixture): ImportRunMap {
  return {
    runs: input.runs,
    sourceTriangleCount: input.sourceTriangleCount,
    modelTriangleCount: asFileFrameCount(input.modelTriangleCount),
    droppedNonFiniteTriangles: input.droppedNonFiniteTriangles,
    totalRunCount: input.totalRunCount,
  };
}

/**
 * FRAME (A) — the run-map summary persisted in the VOXL `MODL` chunk and
 * carried on `nativePreview.runMap`. Same frame as {@link makeFileFrameRunMap};
 * this is its textual form.
 */
export function makeFileFrameRunMapSummary(
  input: FileFrameRunMapSummaryFixture,
): ImportRunMapSummary {
  return {
    entryCount: input.entryCount,
    sourceTriangleCount: input.sourceTriangleCount,
    modelTriangleCount: asFileFrameCount(input.modelTriangleCount),
    droppedNonFiniteTriangles: input.droppedNonFiniteTriangles,
    totalRunCount: input.totalRunCount,
  };
}

/**
 * FRAME (B) — the two `MeshHealthReport` fields every `nativeRepairReport`
 * fixture in the suite sets, and no others.
 *
 * Deliberately a `Pick`, not a whole report: the fixtures it replaces set
 * exactly these two keys inside an `as unknown as LoadedModel` cast, and
 * filling in the other fourteen would change what each fixture models. The
 * count is (B) — measured on the buffer the report is attached to, and
 * therefore a valid index into it, decimated previews included.
 */
export function makeGeometryFrameReport(input: {
  /** FRAME (B) — indexes the fixture's own position buffer. `null` = no split. */
  modelTriangleCount: number | null;
  likelySupportGeometry: boolean;
}): Pick<MeshHealthReport, 'model_triangle_count' | 'likely_support_geometry'> {
  return {
    model_triangle_count:
      input.modelTriangleCount == null ? null : asGeometryFrameCount(input.modelTriangleCount),
    likely_support_geometry: input.likelySupportGeometry,
  };
}
