/**
 * Ph3d — HOW a model's classified model/support sections become two bodies,
 * decided once, for the menu affordance and the action alike.
 *
 * ## Why this exists
 *
 * Ph3c closed a defect whose shape is worth keeping in view: the menu enabled
 * Split-to-Bodies from `model_triangle_count` being truthy, and the action cut
 * the scene geometry at that index. For a decimated preview the count indexes
 * the SOURCE FILE, so the affordance promised a split the action could not
 * perform — it flashed a progress panel and did nothing.
 *
 * The fix then was to disable the affordance. The fix now is to make the split
 * WORK by re-sourcing each section from the original file. Either way the
 * invariant is the same and it is the reason this module exists: **the gate and
 * the action must read one answer, not two.** `canSplitSupports` asks this;
 * `splitSupports` acts on it; a test asserts they agree across every shape.
 *
 * ## Why it is not in `splitClassifiedSupports.ts`
 *
 * It needs the Ph2 chokepoint (`resolveOutputSectionPlan`), and
 * `prepareModelGeometry.ts` already imports the splitter — putting it there
 * would be a module cycle. Here the graph stays a DAG:
 * `splitToBodiesStrategy → { prepareModelGeometry, splitClassifiedSupports }`.
 */
import type { LoadedModel } from './useSceneCollectionManager';
import { resolveOutputSectionPlan } from '@/features/mesh-modifiers/prepareModelGeometry';
import {
  planImportSectionSplice,
  type ImportRunMapRecomputeReason,
} from '@/utils/importRunMap';

export type SplitUnavailableReason =
  /** No classification, or one that found a single section. Nothing to split. */
  | 'no-split'
  /** This model is ALREADY one section of a file — it has no internal split. */
  | 'already-a-section'
  /**
   * A classification that claims more model triangles than the geometry it is
   * supposed to index actually holds. A genuine contradiction (Ph3).
   *
   * **UNREACHABLE IN PRODUCTION — a defensive tripwire** (audit §6 / step R6,
   * 2026-07-27). `nativeRepairReport.model_triangle_count` is measured on the
   * buffer it is attached to and bounded by it. Retained, with the arm in
   * `resolveOutputSectionPlan` it mirrors, so that a broken upstream writer is
   * named rather than swallowed.
   */
  | 'count-exceeds-geometry'
  /**
   * The split is real but cannot be performed: the scene mesh is a decimated
   * preview (so the file-derived index does not address it) AND the original
   * file cannot be re-sourced — no retained `sourcePath`, or no stored `cPre`.
   * Never guess a center; that was the islands sideload frame bug.
   */
  | 'source-unavailable';

export type SplitToBodiesStrategy =
  /**
   * Cut the scene geometry. The classification indexes THIS mesh, which is true
   * exactly when the model is not a native preview.
   */
  | { kind: 'scene-split' }
  /**
   * Re-source both sections from the original file, each as its own decimated
   * preview (`load_fullres_section_preview`). The only path that works for a
   * preview, because the index that defines the sections addresses the file.
   */
  | {
    kind: 'resource-sections';
    sourcePath: string;
    cPre: [number, number, number];
    fingerprint: { sizeBytes: number; mtimeMs: number } | null;
    /** The PARENT's model runs — they define both sections. */
    runs: Uint32Array | null;
    recomputeReason: ImportRunMapRecomputeReason | null;
    /**
     * Full-resolution counts the two Rust responses must reproduce, when they
     * are known. The caller cross-checks rather than trusting: model + support
     * must equal the source, or the map does not describe the file.
     */
    expectedModelTriangleCount: number | null;
    expectedSourceTriangleCount: number | null;
  }
  | { kind: 'unavailable'; reason: SplitUnavailableReason };

export function resolveSplitToBodiesStrategy(model: LoadedModel): SplitToBodiesStrategy {
  // A half has no internal split. Its synthesized report says so too, but an
  // explicit arm keeps "you already did this" from being reported as "this file
  // was never classified".
  if (model.geometry.nativePreview?.sourceSection) {
    return { kind: 'unavailable', reason: 'already-a-section' };
  }

  const plan = resolveOutputSectionPlan(model);
  if (plan.kind === 'scene-split') return { kind: 'scene-split' };
  if (plan.kind === 'whole' && plan.reason === 'no-split') {
    return { kind: 'unavailable', reason: 'no-split' };
  }
  if (plan.kind === 'whole' && plan.reason === 'count-exceeds-geometry') {
    return { kind: 'unavailable', reason: 'count-exceeds-geometry' };
  }

  // Everything left is the preview case: `spliced-sections` (splice-eligible) or
  // `whole`/`describes-source-file` (a preview whose splice is unavailable, e.g.
  // the decimated-output toggle). Both mean the classification describes the
  // file, so both re-source.
  const geometry = model.geometry;
  const nativePreview = geometry.nativePreview;
  const splitPlan = planImportSectionSplice({
    runtime: geometry.importRunMap ?? null,
    summary: nativePreview?.runMap ?? null,
    persistedRuns: geometry.importRunMap?.runs ?? null,
    storedRecompute: geometry.importRunMapRecompute ?? null,
    // FRAME NOTE (audit §3.1 site 7, step R7). This is a frame-(B) value —
    // measured on the scene buffer — standing in for a frame-(A) question:
    // "does the SOURCE FILE have a model/support split?". Used as a BOOLEAN
    // only, and only as `planImportSectionSplice`'s last resort, after every
    // run map and summary has been found missing.
    //
    // When they disagree — the file has a split but this preview's own classify
    // pass fused everything into one component (or vice versa) — the splice is
    // planned as `whole` when it should have been `sections`, or the reverse.
    // The consequence is a whole-file splice instead of a sectioned one, which
    // is the pre-Ph3 behaviour and degrades rather than corrupts.
    reportSplitExists:
      (geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0) > 0,
  });
  if (splitPlan.kind === 'whole') {
    return { kind: 'unavailable', reason: 'no-split' };
  }

  const sourcePath = typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
    ? model.sourcePath
    : null;
  const cPre = nativePreview?.cPre ?? null;
  if (!sourcePath || !cPre) {
    return { kind: 'unavailable', reason: 'source-unavailable' };
  }

  const summary = geometry.importRunMap ?? nativePreview?.runMap ?? null;
  return {
    kind: 'resource-sections',
    sourcePath,
    cPre,
    fingerprint: nativePreview?.sourceFingerprint ?? null,
    runs: splitPlan.runs,
    recomputeReason: splitPlan.recomputeReason,
    // FRAME NOTE (audit §3.1 site 8, step R7). These are FULL-RESOLUTION
    // expectations: the caller cross-checks them against what the two Rust
    // section responses report about the SOURCE FILE. Only frame-(A) values
    // belong here — `ImportRunMap` / `ImportRunMapSummary.modelTriangleCount`,
    // both source-file indices.
    //
    // This used to `??`-fall back to
    // `meshDefects.nativeRepairReport.model_triangle_count`, which is frame (B):
    // measured on the SCENE buffer, so on a decimated preview — the only shape
    // that reaches this branch — it is a ~2M-scale number being handed to a
    // check against an 11M-scale file. It was safe only because (A)'s summary is
    // in fact always attached when the file had a split, i.e. the fallback never
    // fired. Removed rather than commented: a null expectation means "do not
    // cross-check", which is honest, where a wrong-frame expectation means "fail
    // a check that should have passed".
    expectedModelTriangleCount: summary?.modelTriangleCount ?? null,
    expectedSourceTriangleCount: summary?.sourceTriangleCount ?? null,
  };
}

/** True when the affordance should be offered at all. */
export function canSplitToBodies(model: LoadedModel): boolean {
  return resolveSplitToBodiesStrategy(model).kind !== 'unavailable';
}
