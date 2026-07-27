import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelHolePunchPlacement, ModelHollowingModifier } from './types';
import { resolveModelMeshModifiers } from './meshModifierStore';
import {
  buildRotationSignature,
  computeVoxelResolution,
  getRotationQuatTuple,
  getUniformScaleFactorForThickness,
  hashBlockedVoxelIndices,
  resolveBlockedVoxelValidity,
  worldMmToLocalMm,
} from './hollowingGrid';
import { hollowFromGeometry, type HollowOptions } from '@/utils/meshHollowing';
import { punchFromGeometry, type PunchOptions } from '@/utils/meshPunching';
import {
  geometryIsVerbatimImport,
  splitClassifiedSupportGeometry,
} from '@/features/scene/splitClassifiedSupports';
import { prefersDecimatedOutput } from './modelOutputPolicy';
import { resolveImportRunMap } from '@/utils/importRunMap';

/**
 * ═══ THE RUST-BOUND GEOMETRY CHOKEPOINT (Ph2) ═══════════════════════════════
 *
 * ONE question, answered in ONE place: **what geometry does this model send to
 * Rust?** `resolveFullResSourceForModel` is that place;
 * `resolveOutputGeometrySource` is its public face, and the staging planners
 * (`planMutatorFullResStaging`, `planModelRustAnalysisStaging`,
 * `resolveIslandScanFrame`) are built on it.
 *
 * WHY IT IS A CHOKEPOINT AND NOT A CONVENTION. The defect this arc exists to
 * fix is not that some consumer chose preview geometry — it is that consumers
 * got preview geometry by SAYING NOTHING. `model.geometry.geometry` is right
 * there on every model, it always works, and nothing about reaching for it
 * looks wrong at review time. So the census below is not documentation of a
 * past audit; it is the enforced partition:
 *
 *   ROUTED (must ask this module)      — slicing staging, mesh export, VOXL
 *                                        embed, hollow apply + preview, hole
 *                                        punch apply, repair-in-place, islands
 *                                        sideload, Rust analysis staging (SDF).
 *   EXPLICIT OPT-OUT (must name it)    — mesh minima (#11), islands client
 *                                        scan, legacy island scan. See
 *                                        `PREVIEW_GEOMETRY_OPT_OUT_REASONS`.
 *   OUTSIDE THE BOUNDARY (no contract) — viewport render, raycast picking,
 *                                        overlays, thumbnails, arrange hulls,
 *                                        resin estimates, cache keys. These
 *                                        never cross into Rust, so they cannot
 *                                        produce or mutate output.
 *   DEFERRED TO OTHER DEVS             — the in-progress model cutting tool
 *                                        (#12). It is not chased here; the
 *                                        contract it must call is
 *                                        `resolveOutputGeometrySource(model)`,
 *                                        returning either
 *                                        `{kind:'fullres-source-file', sourcePath, cPre, fingerprint}`
 *                                        or `{kind:'scene-geometry', geometry}`.
 *                                        Note the FRAME: the slicing transport
 *                                        reprojects `w = M · (v_raw − cPre)`,
 *                                        while the permanent mutators stage the
 *                                        LOCAL centered soup and must use
 *                                        `T_center = cPre − geometry.center`
 *                                        (see `fullResMutatorStaging.ts`) —
 *                                        that confusion is the single most
 *                                        common way to get this wrong, and it
 *                                        fails as a whole-model Y shift.
 *
 * Full census with anchors and rationale:
 * `agents/Claude/STL-import-perf/20260718-P0-Consumer-census.md`.
 * ════════════════════════════════════════════════════════════════════════════
 */

export type PreparedModelGeometry = {
  model: LoadedModel;
  geometry: THREE.BufferGeometry;
  disposeAfterUse: boolean;
};

/**
 * The output-source contract for output-bearing consumers (slicing staging,
 * mesh export) — STL-import decimation remediation Phase 1.
 *
 * `fullres-source-file`: the model's scene geometry is a reduced native
 * preview of an oversized import; outputs must NOT consume it. The Rust-side
 * splice re-reads `sourcePath` and reprojects `w = M · (v_raw − cPre)` —
 * bytes never enter the WebView (plan §C.2).
 *
 * `scene-geometry`: stage the scene BufferGeometry exactly as before
 * (byte-identical path for every non-preview model).
 */
/**
 * Ph3d — which part of its source file a full-res-backed model occupies.
 *
 * `whole` is every ordinary import. The sectioned arms exist only for
 * Split-to-Bodies halves, and carry the parent's model-run map because that map
 * is what DEFINES both sections; `runs: null` tells Rust to re-derive it.
 */
export type FullResSourceSection =
  | { kind: 'whole' }
  | {
      kind: 'model' | 'support';
      runs: Uint32Array | null;
      recomputeReason: string | null;
    };

export type OutputGeometrySource =
  | {
      kind: 'fullres-source-file';
      sourcePath: string;
      /**
       * Stored import-time pre-centering bbox center (raw-file frame).
       * `null` when the datum was never captured (e.g. models mocked or
       * persisted before Phase 1) — consumers must then degrade to the
       * preview path WITH a user-visible warning, never guess a center.
       */
      cPre: [number, number, number] | null;
      /** Import-time staleness fingerprint; `null` skips the stat compare. */
      fingerprint: { sizeBytes: number; mtimeMs: number } | null;
      originalTriangleCount: number;
      /**
       * Ph3d — WHICH PART of `sourcePath` this model is.
       *
       * `whole` for every ordinary import: the model is the file. A
       * Split-to-Bodies half is `model` or `support`, and re-reading the file
       * for it means re-reading THAT SECTION — all three Rust splice commands
       * already take `section` + `model_runs`, so a consumer forwards this and
       * is correct by construction.
       *
       * IGNORING THIS FIELD IS THE ONE SILENT FAILURE OF Ph3d: a consumer that
       * asks only for `sourcePath` re-reads the WHOLE file for a half, quietly
       * putting the supports back into a hollow, an export or a slice. That is
       * why it lives on the resolved source that every Rust-bound consumer
       * already asks for, rather than on the model where it could be missed.
       */
      section: FullResSourceSection;
    }
  | {
      kind: 'scene-geometry';
      geometry: THREE.BufferGeometry;
    };

/** The full-res arm of {@link OutputGeometrySource}. */
export type FullResSourceFile = Extract<OutputGeometrySource, { kind: 'fullres-source-file' }>;

/**
 * THE SANCTIONED PREVIEW OPT-OUTS (Ph2).
 *
 * A Rust-bound consumer gets its geometry from the chokepoint
 * ({@link resolveOutputGeometrySource} / {@link resolveFullResSourceForModel},
 * or the staging planners built on them) — OR it calls
 * {@link resolvePreviewGeometryForRustConsumer} with one of these reasons.
 * There is no third way, and SILENCE IS NOT ONE: reaching into
 * `model.geometry.geometry` directly on a path that ends at a Tauri command is
 * how a consumer silently acquires preview geometry, which is the defect class
 * this whole arc exists to eliminate.
 *
 * The union is closed on purpose. Adding a preview-consuming Rust caller is
 * then a reviewed diff in THIS file, next to the census, rather than an
 * omission at a call site nobody looks at.
 *
 * - `mesh-minima-full-model` — user ruling #11: mesh-minima behaviour is
 *   UNCHANGED and consumes the full model on that path. Preview-fidelity by
 *   construction; markers still land with correct spatial suppression and
 *   classification. Locked by a test, not just this comment.
 * - `islands-client-scan` — the client-side islands fallback. Frame-correct by
 *   construction (it transforms the scene geometry it was handed); it is the
 *   path the sideload DEGRADES to, so it must stay preview-sourced.
 * - `legacy-island-scan` — the Analysis-tab scanner, superseded by the Support
 *   tab. Preview-sourced, accepted (census row 13).
 *
 * NOT in this union, and deliberately outside this contract: viewport render,
 * raycast picking, overlays, thumbnails, arrange hulls, cache keys. Those never
 * cross the Rust boundary, so they cannot produce or mutate output; the census
 * block above classifies them PREVIEW-OK and they consume the scene geometry
 * directly, as they should.
 */
export const PREVIEW_GEOMETRY_OPT_OUT_REASONS = [
  'mesh-minima-full-model',
  'islands-client-scan',
  'legacy-island-scan',
] as const;

export type PreviewGeometryOptOutReason = typeof PREVIEW_GEOMETRY_OPT_OUT_REASONS[number];

/**
 * Explicit, named opt-out: hand a Rust-bound consumer the SCENE (possibly
 * decimated) geometry on purpose. The `reason` is mandatory and enumerated —
 * that is the whole point of the function; it exists so that "this consumer
 * uses the preview" is a statement in the code rather than the absence of one.
 */
export function resolvePreviewGeometryForRustConsumer(
  model: PreviewGeometryHolder,
  reason: PreviewGeometryOptOutReason,
): THREE.BufferGeometry {
  void reason;
  return model.geometry.geometry;
}

/**
 * Structural minimum for {@link resolvePreviewGeometryForRustConsumer} — a
 * `LoadedModel` satisfies it, and so does a bare `{ geometry: GeometryWithBounds }`
 * (the islands hook holds the wrapper, not the model).
 */
export interface PreviewGeometryHolder {
  geometry: { geometry: THREE.BufferGeometry };
}

/**
 * Core native-preview → full-resolution-source resolution, WITHOUT the
 * slice-time unbaked-hollowing carve-out below. Returns the full-res file
 * descriptor for a native-preview model that still retains its original
 * `sourcePath`, else `null`.
 *
 * The Phase-4 permanent mutators (hollow apply/preview, repair-in-place,
 * hole-punch apply) route on THIS, not on `resolveOutputGeometrySource`: the
 * carve-out is specific to slice-time modifier BAKING
 * (`prepareModelGeometryForOutput`, which bakes an unbaked hollowing modifier
 * onto the staged geometry) — a mutator's Apply IS the bake, so it must consume
 * full resolution even when an unbaked modifier is present. The nativePreview
 * marker's presence also guarantees no prior full-res mutation has baked (those
 * clear the marker), so the original file is the correct source. (Known edge:
 * if a full-res mutation DEGRADED to the preview — missing/stale source, user
 * warned — the marker is retained and a subsequent mutation would re-source the
 * original; documented Phase-4 limitation.)
 */
export function resolveFullResSourceForModel(model: LoadedModel): FullResSourceFile | null {
  // Ph2 — THE TOGGLE, decided HERE and nowhere else.
  //
  // User ruling #12: "treat decimated as the original mesh when the user
  // chooses that toggle." So `decimated` is not a quality setting layered on
  // top of full-res sourcing — it REPLACES the notion of the original for this
  // model, for every Rust round-trip, with no per-consumer override.
  //
  // It is enforced by returning `null` at this one function rather than by
  // teaching five call sites about the flag, because every full-res consumer
  // already has a correct, tested `null` fallback to the scene geometry — that
  // is the whole reason this resolver exists. A consumer added tomorrow
  // inherits the behaviour by asking the question at all; one that reaches past
  // this function for `model.geometry.geometry` is the failure mode the census
  // block above and `resolvePreviewGeometryForRustConsumer` exist to make
  // visible.
  if (prefersDecimatedOutput(model)) return null;

  const nativePreview = model.geometry.nativePreview;
  const sourcePath = typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
    ? model.sourcePath
    : null;
  if (!nativePreview || !sourcePath) return null;
  // Ph3d: a Split-to-Bodies half IS a section of this file. Resolved here, once,
  // so every consumer receives it without having to know Ph3d happened.
  const sourceSection = nativePreview.sourceSection;
  return {
    kind: 'fullres-source-file',
    sourcePath,
    cPre: nativePreview.cPre ?? null,
    fingerprint: nativePreview.sourceFingerprint ?? null,
    originalTriangleCount: nativePreview.originalTriangleCount,
    section: sourceSection
      ? resolveSectionRuns(model, sourceSection.section, sourceSection.recomputeReason ?? null)
      : { kind: 'whole' },
  };
}

/**
 * Ph3d — a half's section plus the runs that define it.
 *
 * The runs live on `importRunMap` (one array, one place — a half carries its
 * parent's map verbatim), but they are NOT read raw. `importRunMap.runs` is an
 * EMPTY array when the classifier's map exceeded the transport cap, which is
 * "too fragmented to carry, recompute it" and not "there are no runs". Handing
 * that empty array to the splice would ask for a model section containing
 * nothing — a half that slices to an empty plate.
 *
 * `resolveImportRunMap` is the only thing that tells those two apart, so it is
 * what answers here, exactly as it does for a whole-file splice.
 */
function resolveSectionRuns(
  model: LoadedModel,
  section: 'model' | 'support',
  storedRecompute: string | null,
): FullResSourceSection {
  const resolved = resolveImportRunMap({
    runtime: model.geometry.importRunMap ?? null,
    summary: model.geometry.nativePreview?.runMap ?? null,
    persistedRuns: model.geometry.importRunMap?.runs ?? null,
  });
  if (resolved.kind === 'available') {
    return { kind: section, runs: resolved.map.runs, recomputeReason: null };
  }
  // `none` and `recompute` both mean "Rust must re-derive the map from the
  // file". They differ only in what the log line says.
  return {
    kind: section,
    runs: null,
    recomputeReason: resolved.kind === 'recompute' ? resolved.reason : storedRecompute,
  };
}

/**
 * Resolves the staging source for an output-bearing consumer. Native-preview
 * models with a retained source path route to the full-resolution file; all
 * other models (and preview models carrying unbaked modifiers — bounded
 * Phase-1 scope, full-res modifier routing is Phase 4) stay on the scene
 * geometry.
 */
export function resolveOutputGeometrySource(model: LoadedModel): OutputGeometrySource {
  const fullRes = resolveFullResSourceForModel(model);
  if (fullRes) {
    // Unbaked hollowing is baked WebView-side from the scene geometry; a
    // full-res splice would silently drop the modifier. Keep such models on
    // the preview path (recorded Phase-4 carryover) rather than lose the
    // user's hollowing.
    const modifiers = resolveModelMeshModifiers(model);
    const hasUnbakedHollowing = Boolean(
      modifiers?.hollowing?.enabled && !modifiers.hollowing.bakedIntoGeometry,
    );
    if (hasUnbakedHollowing) {
      console.warn(
        `[resolveOutputGeometrySource] "${model.name}" is a native preview with unbaked `
        + 'hollowing — staging the preview so the modifier applies (full-res modifier '
        + 'routing is Phase 4).',
      );
      return { kind: 'scene-geometry', geometry: model.geometry.geometry };
    }

    return fullRes;
  }

  return { kind: 'scene-geometry', geometry: model.geometry.geometry };
}

export type PreparedLoadedModelsForOutput = {
  models: LoadedModel[];
  modifiedModelCount: number;
  dispose: () => void;
};

const PREPARED_GEOMETRY_CACHE_LIMIT = 8;
const preparedGeometryCache = new Map<string, Float32Array>();

function computeGeometrySignature(geometry: THREE.BufferGeometry): string {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const vertexCount = position?.count ?? 0;
  const positionVersionRaw = position ? Reflect.get(position as object, 'version') : undefined;
  const positionVersion = typeof positionVersionRaw === 'number' ? positionVersionRaw : 0;
  const indexVersionRaw = index ? Reflect.get(index as object, 'version') : undefined;
  const indexVersion = typeof indexVersionRaw === 'number' ? indexVersionRaw : 0;
  return `${geometry.uuid}:${vertexCount}:${positionVersion}:${indexVersion}`;
}

// The blocked voxels forwarded to slice-time hollowing (and folded into the
// cache signature) must be the same list. Item #7's invalidation effect clears
// stale blockers in the UI; if a stale set still reaches slice time (rotation
// changed in the same frame, or the effect never ran), dropping them beats
// hollowing against a mismatched grid. Callers pass the store-resolved
// `hollowing`, never `model.meshModifiers?.hollowing` directly.
function getEffectiveBlockedVoxelIndices(
  model: LoadedModel,
  hollowing: ModelHollowingModifier,
): number[] {
  const blocked = hollowing.blockedVoxelIndices ?? [];
  if (blocked.length === 0) return blocked;
  const currentQuat = getRotationQuatTuple(model.transform.rotation);
  if (resolveBlockedVoxelValidity(hollowing, currentQuat) === 'stale') {
    return [];
  }
  return blocked;
}

function buildModifierSignature(model: LoadedModel): string | null {
  const modifiers = resolveModelMeshModifiers(model);
  const hollowing = modifiers?.hollowing?.enabled && !modifiers.hollowing.bakedIntoGeometry
    ? modifiers.hollowing
    : null;
  const shouldApplyPunches = !modifiers?.holePunchesBakedIntoGeometry;
  const punches = shouldApplyPunches
    ? (modifiers?.holePunches ?? []).filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0)
    : [];

  if (!hollowing?.enabled && punches.length === 0) {
    return null;
  }

  const normalized = {
    hollowing: hollowing?.enabled ? {
      mode: hollowing.mode,
      voxelSizeMm: hollowing.voxelSizeMm,
      shellThicknessMm: hollowing.shellThicknessMm,
      infillMode: hollowing.infillMode ?? 'lattice',
      infillCellMm: hollowing.infillCellMm ?? 4.2426,
      infillBeamRadiusMm: hollowing.infillBeamRadiusMm ?? 0.35,
      openFace: hollowing.openFace,
      // Rotation and scale change the Rust voxel grid; the blocker hash changes
      // the keep mask. Geometry version does not change on transform (rotation
      // is a transform, geometry is local-space), so without these the cache
      // would serve a cavity computed at a stale rotation/scale/blocker set.
      // Hash (not the raw array) keeps the key O(1)-sized for large lasso
      // selections (audit #23); it covers the *effective* (validity-filtered)
      // list so the signature matches what is actually forwarded.
      rotation: buildRotationSignature(model.transform.rotation),
      scaleFactor: Number(
        getUniformScaleFactorForThickness(model.transform.scale).toFixed(6),
      ),
      blockedVoxelIndicesHash: hashBlockedVoxelIndices(
        getEffectiveBlockedVoxelIndices(model, hollowing),
      ),
    } : null,
    holePunches: punches.map((placement) => ({
      centerNorm: placement.centerNorm,
      radiusMm: placement.radiusMm,
      depthMm: placement.depthMm,
      direction: placement.direction,
    })),
  };

  return JSON.stringify(normalized);
}

function getPreparedGeometryCacheKey(model: LoadedModel): string | null {
  const modifierSignature = buildModifierSignature(model);
  if (!modifierSignature) return null;
  const geometrySignature = computeGeometrySignature(model.geometry.geometry);
  return `${model.id}:${geometrySignature}:${modifierSignature}`;
}

function getCachedPreparedPositions(cacheKey: string): Float32Array | null {
  const hit = preparedGeometryCache.get(cacheKey);
  if (!hit) return null;
  // Refresh LRU order.
  preparedGeometryCache.delete(cacheKey);
  preparedGeometryCache.set(cacheKey, hit);
  return hit;
}

function setCachedPreparedPositions(cacheKey: string, positions: Float32Array): void {
  preparedGeometryCache.set(cacheKey, positions);
  while (preparedGeometryCache.size > PREPARED_GEOMETRY_CACHE_LIMIT) {
    const oldestKey = preparedGeometryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    preparedGeometryCache.delete(oldestKey);
  }
}

function createGeometryFromPositions(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/**
 * True when this model's outputs come from the ORIGINAL file via the Rust-side
 * splice rather than from its scene geometry.
 *
 * Ph1 used this as a FENCE ("do not split, we cannot express the split in the
 * spliced stream"). Ph3 keeps the same answer for the opposite reason: the
 * run-map splice now EXPRESSES the split itself, in source-file indices, by
 * staging the model runs and the support complement as two passes. Splitting
 * the scene geometry as well would double-count — and would still be
 * destructive, because both halves are rebuilt from a bare `Float32Array`
 * (`buildGeometryWithBounds`), carry no `nativePreview`, and would therefore
 * drop straight off the full-res path.
 */
export function isFullResSpliceEligible(model: LoadedModel): boolean {
  return resolveOutputGeometrySource(model).kind === 'fullres-source-file';
}

/**
 * Ph3 — HOW this model's model/support sections reach the output, decided once.
 *
 * ## What this replaces, and why
 *
 * Ph2 finding F3: the old guard compared `nativeRepairReport.model_triangle_count`
 * against the SCENE geometry's triangle count and bailed when the former was
 * larger. Once Ph1's wiring made that count full-resolution, an 11M count
 * against a 2M preview happened to trip the guard — so the code did the right
 * thing for a reason nobody had written down and nothing enforced. It read as a
 * "degenerate classification" check; it was working as a resolution-mismatch
 * check; and the moment a preview happened to be larger than a model section it
 * would have sliced supports as model with complete confidence.
 *
 * The replacement asks a structural question instead of the arithmetic one:
 * **is this geometry a verbatim full-resolution import?** If it is not, the
 * model is left whole and the splice (or Ph3d's re-sourcing) owns its sections.
 *
 * ## ⚠ CORRECTION, 2026-07-27 — why the question below is not the frame question
 *
 * This docblock used to justify the guard by saying `model_triangle_count`
 * describes the SOURCE FILE for a preview and therefore does not index this
 * geometry. **That reasoning is wrong.** It quotes the contract of
 * `ImportClassificationJson.model_triangle_count` (frame (A), the DFST header
 * value) and applies it to `nativeRepairReport.model_triangle_count` (frame (B)),
 * which is a different number: a decimated preview runs its OWN classify pass
 * over its OWN triangles and is reordered to match, so (B) is a VALID index into
 * the preview. See `geometryIsVerbatimImport` and
 * `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`.
 *
 * **The guard is retained anyway, deliberately** (audit step R4, not
 * authorised): `describes-source-file` is what routes a preview's Split-to-Bodies
 * to Ph3d's `resource-sections`, and unwinding that would unwind Ph3d. Its known
 * cost is recorded at the call site below. What must NOT happen is a fourth site
 * copying the guard on the belief that a (B) read needs it.
 */
export type OutputSectionPlan =
  /** The Rust splice stages the model runs and the support complement itself. */
  | { kind: 'spliced-sections' }
  /** Split the scene geometry: the classification indexes it, and it has both. */
  | { kind: 'scene-split'; modelTriangleCount: number; totalTriangleCount: number }
  | {
      kind: 'whole';
      /**
       * `no-split` — no classification, or one that found a single section.
       * `describes-source-file` — the count is full-resolution and the geometry
       *   is a reduced preview, so the count does not index it. Not a degrade:
       *   this is the ordinary shape of a decimated-output model (Ph2's toggle)
       *   and of a preview whose splice is unavailable.
       * `count-exceeds-geometry` — a classification that claims more model
       *   triangles than the geometry it indexes actually holds. A genuine
       *   contradiction; warned about, never acted on.
       *   **UNREACHABLE IN PRODUCTION — a defensive tripwire, not a guard**
       *   (audit §6 / step R6, 2026-07-27). Frame (B) is produced by a classify
       *   pass over the buffer it is attached to and is bounded by
       *   `mesh.triangles.len()` by construction; the only mutator that could
       *   put a report on a differently-sized buffer (`replaceModelGeometry`)
       *   drops the whole `meshDefects` block. Kept — not deleted — because the
       *   reason is surfaced to the user through `SplitUnavailableReason` and
       *   `page.tsx`, and because a tripwire that fires means an invariant broke
       *   upstream. If it ever fires, that is the finding.
       */
      reason: 'no-split' | 'describes-source-file' | 'count-exceeds-geometry';
    };

export function resolveOutputSectionPlan(model: LoadedModel): OutputSectionPlan {
  if (isFullResSpliceEligible(model)) return { kind: 'spliced-sections' };

  const report = model.geometry.meshDefects?.nativeRepairReport;
  const modelTriangleCount = Math.floor(report?.model_triangle_count ?? 0);
  if (modelTriangleCount <= 0) return { kind: 'whole', reason: 'no-split' };

  // A native preview is left whole here and its sections are produced by
  // re-sourcing (Ph3d) rather than by cutting the stand-in.
  //
  // NOT because the count fails to index this buffer — it does (see the
  // correction in this function's docblock and `geometryIsVerbatimImport`).
  //
  // KNOWN COST OF KEEPING THIS ARM (audit §5, step R4 — deliberately NOT taken):
  // it also fires on a preview that is not splice-eligible, e.g. one carrying an
  // UNBAKED HOLLOWING modifier, where the scene buffer IS the output and its own
  // count does index it. Such a model is no longer split into two `LoadedModel`s
  // for output, so `splitClassifiedModelForOutput`'s support half no longer gets
  // `meshModifiers: undefined` — i.e. unbaked hollowing voxelises the imported
  // supports too. Pre-Ph3 that model split and the supports were exempt.
  if (!geometryIsVerbatimImport(model.geometry)) {
    return { kind: 'whole', reason: 'describes-source-file' };
  }

  const geometry = model.geometry.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return { kind: 'whole', reason: 'no-split' };
  const totalTriangleCount = Math.floor((geometry.getIndex()?.count ?? position.count) / 3);

  if (modelTriangleCount >= totalTriangleCount) {
    // TRIPWIRE, not a guard. Unreachable in production: frame (B) cannot exceed
    // its own buffer (audit §6). Retained because if it ever fires, some
    // upstream writer has attached a report to a mesh it does not describe —
    // and that is worth hearing about loudly rather than clamping silently.
    console.warn(
      `[resolveOutputSectionPlan] "${model.name}" carries a model-section count of `
      + `${modelTriangleCount.toLocaleString()} for a geometry holding `
      + `${totalTriangleCount.toLocaleString()} triangles. The classification does not `
      + 'describe this mesh — slicing it whole rather than cutting it at a meaningless index.',
    );
    return { kind: 'whole', reason: 'count-exceeds-geometry' };
  }

  return { kind: 'scene-split', modelTriangleCount, totalTriangleCount };
}

function splitClassifiedModelForOutput(model: LoadedModel): {
  models: LoadedModel[];
  geometries: THREE.BufferGeometry[];
} | null {
  if (resolveOutputSectionPlan(model).kind !== 'scene-split') return null;

  const report = model.geometry.meshDefects?.nativeRepairReport;
  const split = splitClassifiedSupportGeometry(model);
  if (!split) return null;

  const sourceDefects = model.geometry.meshDefects;
  const modelDefects = sourceDefects ? {
    ...sourceDefects,
    nativeRepairReport: undefined,
    supportSectionGeometry: undefined,
    modelSectionGeometry: undefined,
  } : undefined;
  const supportDefects = sourceDefects ? {
    ...sourceDefects,
    supportSectionGeometry: undefined,
    modelSectionGeometry: undefined,
    nativeRepairReport: report ? {
      ...report,
      model_triangle_count: null,
      likely_support_geometry: true,
    } : undefined,
  } : undefined;

  const modelBounds = { ...split.modelGeometry, meshDefects: modelDefects };
  const supportBounds = { ...split.supportGeometry, meshDefects: supportDefects };

  const modelPart: LoadedModel = {
    ...model,
    geometry: modelBounds,
    polygonCount: split.modelTriangleCount,
    transform: {
      position: split.modelPosition,
      rotation: model.transform.rotation.clone(),
      scale: model.transform.scale.clone(),
    },
  };
  const supportPart: LoadedModel = {
    ...model,
    id: `${model.id}:slice-supports`,
    name: `${model.name} (Supports)`,
    geometry: supportBounds,
    polygonCount: split.supportTriangleCount,
    meshModifiers: undefined,
    transform: {
      position: split.supportPosition,
      rotation: model.transform.rotation.clone(),
      scale: model.transform.scale.clone(),
    },
  };

  return {
    models: [modelPart, supportPart],
    geometries: [modelBounds.geometry, supportBounds.geometry],
  };
}

function buildPunchOptionsFromPlacements(
  sourceBounds: { bbox: THREE.Box3; size: THREE.Vector3 },
  placements: ModelHolePunchPlacement[],
): PunchOptions {
  const bbox = sourceBounds.bbox;
  const size = sourceBounds.size;
  const toMm = (norm: number, min: number, span: number) => min + (norm * (Math.abs(span) <= 1e-9 ? 0 : span));

  return {
    punches: placements.map((placement) => {
      const mmCenterX = toMm(placement.centerNorm[0], bbox.min.x, size.x);
      const mmCenterY = toMm(placement.centerNorm[1], bbox.min.y, size.y);
      const mmCenterZ = toMm(placement.centerNorm[2], bbox.min.z, size.z);
      const centerNorm: [number, number, number] = [
        size.x <= 1e-9 ? 0.5 : (mmCenterX - bbox.min.x) / size.x,
        size.y <= 1e-9 ? 0.5 : (mmCenterY - bbox.min.y) / size.y,
        size.z <= 1e-9 ? 0.5 : (mmCenterZ - bbox.min.z) / size.z,
      ];

      return {
        centerNorm,
        radiusMm: placement.radiusMm,
        radiusYMm: placement.radiusYMm,
        direction: placement.direction,
        lengthMm: placement.depthMm,
      };
    }),
  };
}

export async function prepareModelGeometryForOutput(model: LoadedModel): Promise<PreparedModelGeometry> {
  const cacheKey = getPreparedGeometryCacheKey(model);
  if (cacheKey) {
    const cachedPositions = getCachedPreparedPositions(cacheKey);
    if (cachedPositions) {
      return {
        model,
        geometry: createGeometryFromPositions(cachedPositions),
        disposeAfterUse: true,
      };
    }
  }

  // Model objects in React state deliberately carry meshModifiers: undefined
  // (externalized store) — resolve through the store or unbaked hollowing is
  // silently skipped at slice/export time.
  const modifiers = resolveModelMeshModifiers(model);
  const hollowing = modifiers?.hollowing;
  const shouldApplyHollowing = Boolean(hollowing?.enabled && !hollowing.bakedIntoGeometry);
  // Hole punches are never auto-applied during slice/export — the user must
  // explicitly bake them first (via the hole-punch panel's Apply button or a
  // pre-slice confirmation dialog). This prevents unapplied LYS-imported holes
  // from silently corrupting the sliced output.
  const shouldApplyPunches = false;
  const punches: ModelHolePunchPlacement[] = [];

  if (!shouldApplyHollowing && punches.length === 0) {
    return {
      model,
      geometry: model.geometry.geometry,
      disposeAfterUse: false,
    };
  }

  let workingGeometry = model.geometry.geometry;
  let createdGeometry: THREE.BufferGeometry | null = null;
  const sourceBounds = {
    bbox: model.geometry.bbox,
    size: model.geometry.size,
  };

  if (shouldApplyHollowing && hollowing) {
    const maxExtent = Math.max(sourceBounds.size.x, sourceBounds.size.y, sourceBounds.size.z);
    // The voxel grid lives in the model's local space, so world-space mm params
    // (voxel size, shell thickness, infill dims) must be converted to local mm
    // before hollowing — the same conversion the preview (buildHollowingOptions)
    // and Apply paths already apply. For unscaled models this is an exact no-op
    // (worldMmToLocalMm(v, 1) === max(1e-4, v)); scaled models now slice against
    // the same grid the preview showed, so forwarded blockers land on the right
    // voxels.
    const scaleFactor = getUniformScaleFactorForThickness(model.transform.scale);
    const voxelResolution = computeVoxelResolution(
      worldMmToLocalMm(hollowing.voxelSizeMm, scaleFactor),
      maxExtent,
    );
    const quat = new THREE.Quaternion().setFromEuler(model.transform.rotation);
    const hollowOptions: HollowOptions = {
      mode: hollowing.mode,
      voxelResolution,
      shellThicknessMm: worldMmToLocalMm(hollowing.shellThicknessMm, scaleFactor),
      blockedVoxelIndices: getEffectiveBlockedVoxelIndices(model, hollowing),
      infillMode: hollowing.infillMode ?? 'lattice',
      infillCellMm: worldMmToLocalMm(hollowing.infillCellMm ?? 4.2426, scaleFactor),
      infillBeamRadiusMm: worldMmToLocalMm(hollowing.infillBeamRadiusMm ?? 0.35, scaleFactor),
      openFace: hollowing.openFace,
      drainHoles: [],
      previewCavityOnly: false,
      smoothInternalSurfaces: true,
      internalChamferPasses: 2,
      rotationQuat: [quat.x, quat.y, quat.z, quat.w],
    };

    const hollowResult = await hollowFromGeometry(workingGeometry, hollowOptions);
    if (!hollowResult) {
      throw new Error(`Hollowing for "${model.name}" is only available in DragonFruit Desktop.`);
    }

    createdGeometry = createGeometryFromPositions(hollowResult.positions);
    workingGeometry = createdGeometry;
  }

  if (punches.length > 0) {
    const punchOptions = buildPunchOptionsFromPlacements(sourceBounds, punches);
    const punchResult = await punchFromGeometry(workingGeometry, punchOptions);
    if (!punchResult) {
      if (createdGeometry) createdGeometry.dispose();
      throw new Error(`Hole punching for "${model.name}" is only available in DragonFruit Desktop.`);
    }

    if (createdGeometry) {
      createdGeometry.dispose();
    }
    createdGeometry = createGeometryFromPositions(punchResult.positions);
    workingGeometry = createdGeometry;
  }

  if (cacheKey && createdGeometry) {
    const positionAttribute = createdGeometry.getAttribute('position') as THREE.BufferAttribute;
    if (positionAttribute?.array instanceof Float32Array) {
      setCachedPreparedPositions(cacheKey, positionAttribute.array);
    }
  }

  return {
    model,
    geometry: workingGeometry,
    disposeAfterUse: createdGeometry !== null,
  };
}

export async function prepareLoadedModelsForOutput(models: LoadedModel[]): Promise<PreparedLoadedModelsForOutput> {
  const preparedModels: LoadedModel[] = [];
  const temporaryGeometries: THREE.BufferGeometry[] = [];
  let modifiedModelCount = 0;

  try {
    const slicingModels: LoadedModel[] = [];
    for (const model of models) {
      const split = splitClassifiedModelForOutput(model);
      if (split) {
        slicingModels.push(...split.models);
        temporaryGeometries.push(...split.geometries);
      } else {
        slicingModels.push(model);
      }
    }

    for (const model of slicingModels) {
      const prepared = await prepareModelGeometryForOutput(model);
      const geometryChanged = prepared.geometry !== model.geometry.geometry;

      if (prepared.disposeAfterUse) {
        temporaryGeometries.push(prepared.geometry);
      }

      if (!geometryChanged) {
        preparedModels.push(model);
        continue;
      }

      modifiedModelCount += 1;
      preparedModels.push({
        ...model,
        geometry: {
          ...model.geometry,
          geometry: prepared.geometry,
        },
      });
    }
  } catch (error) {
    for (const geometry of temporaryGeometries) {
      try {
        geometry.dispose();
      } catch {
        // no-op
      }
    }
    throw error;
  }

  return {
    models: preparedModels,
    modifiedModelCount,
    dispose: () => {
      for (const geometry of temporaryGeometries) {
        geometry.dispose();
      }
    },
  };
}
