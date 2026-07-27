/**
 * Per-model output policy — the Original/Decimated toggle (STL-import
 * support-aware import, Ph2; plan
 * `agents/Claude/STL-import-perf/20260725-Plan-support-aware-import-FINAL.md`
 * §Ph2).
 *
 * A `>budget` native import is replaced in the scene by a reduced preview while
 * the ORIGINAL file stays on disk; since Phase 1 every output-bearing path
 * re-reads that original Rust-side. This flag is how the user says "don't —
 * treat the decimated mesh AS the original for everything" (user answer #12).
 *
 * Deliberately its own module, not a field parked on some feature type:
 *  - `LoadedModel` (useSceneCollectionManager.ts) and the resolver
 *    (prepareModelGeometry.ts) both need it, and both already import from each
 *    other's neighbourhood — a shared leaf module keeps that acyclic;
 *  - Ph7 adds per-section decimation policy. The field is reserved as
 *    `outputPolicy: { mode }` rather than a bare `outputMode` string so Ph7
 *    EXTENDS one field family instead of minting a second one beside it.
 *
 * THE DEFAULT IS `'original'` AND MUST STAY SO. Absence means original: a model
 * that has never met the toggle (every model in every file written before Ph5)
 * keeps full-resolution output. Nothing may infer `'decimated'` from silence.
 */

export type ModelOutputMode = 'original' | 'decimated';

export interface ModelOutputPolicy {
  mode: ModelOutputMode;
}

export const DEFAULT_MODEL_OUTPUT_MODE: ModelOutputMode = 'original';

/** Anything carrying (or omitting) an output policy — model, VOXL entry, DTO. */
export interface HasOutputPolicy {
  outputPolicy?: ModelOutputPolicy | null;
}

/**
 * The effective output mode. Unknown/garbage values from a hand-edited or
 * future-version file degrade to `'original'` — the honest, lossless direction.
 */
export function resolveModelOutputMode(model: HasOutputPolicy | null | undefined): ModelOutputMode {
  return model?.outputPolicy?.mode === 'decimated' ? 'decimated' : DEFAULT_MODEL_OUTPUT_MODE;
}

/** True when the model's outputs must come from the scene (decimated) mesh. */
export function prefersDecimatedOutput(model: HasOutputPolicy | null | undefined): boolean {
  return resolveModelOutputMode(model) === 'decimated';
}

/**
 * Normalises a persisted policy for writing. Returns `undefined` for the
 * default so a scene that never touched the toggle serialises byte-identically
 * to a pre-Ph2 file (the additive-field contract every VOXL extension in this
 * arc follows).
 */
export function normalizeOutputPolicyForPersistence(
  policy: ModelOutputPolicy | null | undefined,
): ModelOutputPolicy | undefined {
  return policy?.mode === 'decimated' ? { mode: 'decimated' } : undefined;
}
