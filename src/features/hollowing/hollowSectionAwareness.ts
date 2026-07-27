/**
 * Ph3b — HOLLOW SECTION-AWARENESS. The seam.
 *
 * ## The problem this closes
 *
 * Hollowing voxelises whatever is staged. For a pre-supported import past the
 * decimation budget, Phase 4 routed that staging to the ORIGINAL file — which
 * fixed the resolution and left the *scope* wrong: the supports were voxelised,
 * shelled and smoothed along with the model body. Ph3 built the run-map splice
 * that makes the model/support partition available at full resolution in
 * SOURCE-FILE indices, and deliberately stopped short of consuming it here,
 * because half-wiring it would trade an honest suboptimality (supports get
 * hollowed) for a silent geometry error (supports duplicated or dropped).
 *
 * The plan's design, implemented here: **stage the model section, hollow it,
 * re-append the untouched support section from the same run-map walk.**
 *
 * ## Why this is a module and not code inside the hook
 *
 * `useHollowingManager.ts` is a ~1 700-line React hook with no exported surface
 * — the Ph2 AAR recorded that its three degrade sites could not be unit-tested
 * for exactly that reason. Two of the decisions Ph3b adds are ones the user only
 * discovers on a printed part:
 *
 * 1. **whether to section at all** — getting this wrong on a model whose scene
 *    geometry already holds its supports drops them entirely;
 * 2. **whether the support block that came back is the one the model pass
 *    skipped** — getting this wrong duplicates or drops a support block with
 *    full confidence.
 *
 * Both are pure functions of data, so they live here where a test can reach
 * them. The hook keeps the IO, the toasts and the React state.
 *
 * ## What this module deliberately does NOT decide
 *
 * It does not re-derive the model/support partition. {@link resolveOutputSectionPlan}
 * (Ph3) is the sanctioned answer to "what does the section split mean for this
 * model", and {@link planImportSectionSplice} (Ph1/Ph3) is the sanctioned reader
 * of the run map. Asking either question a second way, in a second place, is
 * precisely the Ph2 finding F3 mistake — a guard that reads as one check while
 * working as another.
 */
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { FullResMutatorSource } from '@/utils/fullResMutatorStaging';
import { resolveOutputSectionPlan } from '@/features/mesh-modifiers/prepareModelGeometry';
import { planImportSectionSplice, type ImportRunMapRecomputeReason } from '@/utils/importRunMap';

/**
 * What a hollow operation should stage, and with what map.
 *
 * `whole` is the pre-Ph3b behaviour, byte-for-byte: one whole-file pass, the
 * supports voxelised with the body. Every reason for it is stated rather than
 * inferred, because "we hollowed the supports" must never be the silent default
 * of a code path that meant to do something else.
 *
 * - `not-full-res` — the mutator is not re-sourcing the original file at all
 *   (Ph2's decimated toggle, a missing `cPre`, a non-preview model). The scene
 *   geometry it stages already contains its supports; sectioning it would drop
 *   them.
 * - `sections-not-spliced` — Ph3's `resolveOutputSectionPlan` did not answer
 *   `spliced-sections`, so the split is either absent or expressed elsewhere.
 * - `no-split` / `no-support-verdict` — {@link planImportSectionSplice}'s own
 *   two whole-file verdicts, passed through unchanged.
 * - `support-read-failed` — the support read-back threw (missing/stale source,
 *   a map that cannot describe the file). Set by the CALLER after the fact; see
 *   the degrade note below.
 */
export type HollowSectionSplicePlan =
  | {
      kind: 'whole';
      reason:
        | 'not-full-res'
        | 'sections-not-spliced'
        | 'no-split'
        | 'no-support-verdict'
        | 'support-read-failed';
    }
  | {
      kind: 'sections';
      /** Flat `[start0, len0, …]` in SOURCE-FILE indices, or `null` to recompute. */
      runs: Uint32Array | null;
      recomputeReason: ImportRunMapRecomputeReason | null;
    };

/**
 * Decides whether this model's hollow stages the model section alone.
 *
 * `fullResSource` is the mutator's own full-res gate (`planMutatorFullResStaging`),
 * NOT `resolveOutputGeometrySource` — the permanent mutators route on
 * `resolveFullResSourceForModel` because a mutator's Apply IS the modifier bake.
 * Sectioning is gated on BOTH that plan and Ph3's `spliced-sections` verdict, so
 * a model that is full-res for the mutator but not splice-eligible for output
 * (an unbaked hollowing modifier, say) stays whole. That is conservative on
 * purpose: whole is today's honest behaviour, and this is not the place to
 * widen Ph3's definition of eligibility.
 */
export function planHollowSectionSplice(
  model: LoadedModel,
  fullResSource: FullResMutatorSource | null,
): HollowSectionSplicePlan {
  if (!fullResSource) return { kind: 'whole', reason: 'not-full-res' };

  if (resolveOutputSectionPlan(model).kind !== 'spliced-sections') {
    return { kind: 'whole', reason: 'sections-not-spliced' };
  }

  return planImportSectionSplice({
    runtime: model.geometry.importRunMap ?? null,
    summary: model.geometry.nativePreview?.runMap ?? null,
    persistedRuns: model.geometry.importRunMap?.runs ?? null,
    storedRecompute: model.geometry.importRunMapRecompute ?? null,
    // FRAME NOTE (audit §3.1 site 9, step R7). A frame-(B) value — measured on
    // the scene buffer — answering a frame-(A) question ("does the SOURCE FILE
    // have a split?"). Boolean use only, and only as `planImportSectionSplice`'s
    // last resort. Narrower here than at the other two proxy sites: this call is
    // already gated on `spliced-sections`, so a run map or summary was almost
    // certainly present and the last resort is not reached. If the two frames
    // ever disagree, the hollow stages the whole file instead of the model
    // section — the pre-Ph3b behaviour, a degrade rather than a corruption.
    reportSplitExists:
      (model.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0) > 0,
  });
}

/**
 * The suffix that distinguishes a sectioned hollow PREVIEW RESULT from a
 * whole-file one in `hollowPreviewResultCacheRef`.
 *
 * (The Rust-side staging capture is keyed separately, inside
 * `stageHollowPreviewSource`, which folds the section into its own key. Two
 * caches, one rule: a whole-file answer must never be served to a sectioned
 * request. A sectioned capture answered from a whole one would hollow the
 * supports while the caller re-appends them — every support triangle twice.)
 *
 * Empty string for `whole` on purpose: every pre-Ph3b key stays byte-identical,
 * so an existing cached preview is neither invalidated nor mis-served.
 */
export function hollowSectionStagingKeySuffix(plan: HollowSectionSplicePlan): string {
  return plan.kind === 'sections' ? '::section-model' : '';
}

export type SupportSectionPartitionCheck =
  | { ok: true; supportTriangleCount: number }
  | { ok: false; message: string };

/**
 * THE GUARD. The model pass and the support pass are two independent reads of
 * the same file through the same map; between them they must account for every
 * triangle in it, exactly once.
 *
 * This is checked rather than trusted because the failure is invisible: a
 * support block one triangle short, or one triangle long, produces a mesh that
 * looks entirely plausible in the viewport and is wrong on the plate. A
 * mismatch cannot be caused by user input or by a stale file (both passes verify
 * the import fingerprint), so it means the map does not describe the file — and
 * the correct response to that is to refuse, not to approximate.
 */
export function checkSupportSectionPartition(input: {
  modelName: string;
  /** `stagedTriangleCount` from the MODEL pass. */
  stagedTriangleCount: number;
  /** `skippedTriangleCount` from the MODEL pass — what the support pass owes. */
  skippedTriangleCount: number;
  /** `sourceTriangleCount` from the MODEL pass. */
  sourceTriangleCount: number;
  /** `Float32Array.length` of the support read-back (9 floats per triangle). */
  supportPositionFloatCount: number;
}): SupportSectionPartitionCheck {
  const { modelName, stagedTriangleCount, skippedTriangleCount, sourceTriangleCount } = input;

  if (input.supportPositionFloatCount % 9 !== 0) {
    return {
      ok: false,
      message:
        `The full-resolution support section for "${modelName}" came back as `
        + `${input.supportPositionFloatCount.toLocaleString()} floats, which is not whole triangles. `
        + 'Hollowing was stopped rather than rebuilding the model around a truncated support block.',
    };
  }
  const supportTriangleCount = input.supportPositionFloatCount / 9;

  if (supportTriangleCount !== skippedTriangleCount) {
    return {
      ok: false,
      message:
        `The full-resolution sections of "${modelName}" do not partition its source file: the `
        + `model pass staged ${stagedTriangleCount.toLocaleString()} triangles and skipped `
        + `${skippedTriangleCount.toLocaleString()}, but the support pass returned `
        + `${supportTriangleCount.toLocaleString()}. Hollowing was stopped rather than rebuilding `
        + 'the model with supports dropped or duplicated.',
    };
  }

  if (stagedTriangleCount + supportTriangleCount !== sourceTriangleCount) {
    return {
      ok: false,
      message:
        `The full-resolution sections of "${modelName}" account for `
        + `${(stagedTriangleCount + supportTriangleCount).toLocaleString()} of `
        + `${sourceTriangleCount.toLocaleString()} source triangles. Hollowing was stopped rather `
        + 'than rebuilding the model from an incomplete file.',
    };
  }

  return { ok: true, supportTriangleCount };
}

/**
 * Joins the hollow output and the untouched support section into one position
 * buffer, MODEL FIRST.
 *
 * Order is load-bearing beyond aesthetics: model-then-support is the layout a
 * `model_triangle_count` would index, so a later phase that re-classifies the
 * mutated mesh (see the Ph3b AAR — `replaceModelGeometry` currently drops the
 * classification, which is why nothing indexes it today) finds the sections
 * where the classifier's own convention puts them.
 */
export function concatHollowOutputWithSupportSection(
  hollowedPositions: Float32Array,
  supportPositions: Float32Array,
): Float32Array {
  if (supportPositions.length === 0) return hollowedPositions;
  const joined = new Float32Array(hollowedPositions.length + supportPositions.length);
  joined.set(hollowedPositions, 0);
  joined.set(supportPositions, hollowedPositions.length);
  return joined;
}
