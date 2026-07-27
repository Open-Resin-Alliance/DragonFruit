/**
 * The import run map — model-section triangle runs in SOURCE-FILE indices.
 *
 * ## What it is
 *
 * `classify_import` partitions a native import into a model section and a
 * support section, and emits the model section as maximal runs of consecutive
 * triangles **as the source file numbers them**. The support section is the
 * complement. Ph3's full-resolution splice re-reads the original STL record by
 * record, so file indices are the only index space that means anything to it —
 * welded indices drift the moment the intake drops a non-finite triangle, and
 * preview indices are a different mesh entirely.
 *
 * ## Why it is capped
 *
 * Runs are cheap for ordinary geometry (a plate's model body is a handful of
 * contiguous blocks) and unbounded for pathological geometry (thousands of
 * finely interleaved components). {@link IMPORT_RUN_MAP_MAX_ENTRIES} is the
 * ceiling on both the IPC transport (`STL_RESPONSE_RUN_MAP_MAX_ENTRIES` in
 * `mesh_repair.rs`) and the persisted VOXL chunk, deliberately the SAME number:
 * a map that cannot be persisted is one the splice would have to recompute on
 * the very next load anyway, so carrying it would buy one session of speed in
 * exchange for two behaviours to reason about.
 *
 * ## What happens when it is missing
 *
 * Absence is never silent and never fatal. {@link resolveImportRunMap} returns a
 * `recompute` verdict with the reason — over cap, never persisted, a file
 * written before the map existed, or a chunk an older writer dropped — and the
 * consumer re-derives the map from the source file. Ph1 establishes the map, the
 * persistence and this resolver; the recompute itself is Ph3's, because the
 * splice is its only consumer.
 */

/** `(start: u32, len: u32)`. */
export const IMPORT_RUN_MAP_BYTES_PER_ENTRY = 8;

/** 64 KiB per model — the cap named in the Ph1 plan. */
export const IMPORT_RUN_MAP_MAX_BYTES = 64 * 1024;

/** 8 192 runs. Mirrored by `STL_RESPONSE_RUN_MAP_MAX_ENTRIES` in `mesh_repair.rs`. */
export const IMPORT_RUN_MAP_MAX_ENTRIES = IMPORT_RUN_MAP_MAX_BYTES / IMPORT_RUN_MAP_BYTES_PER_ENTRY;

/**
 * The runtime form, carried on `GeometryWithBounds.importRunMap`.
 *
 * `runs` is flat `[start0, len0, start1, len1, …]` rather than an array of
 * objects: it is copied straight out of the IPC buffer and straight into a VOXL
 * chunk, and an object array would mean two conversions and a per-entry
 * allocation for a structure that is only ever walked in pairs.
 */
export type ImportRunMap = {
  runs: Uint32Array;
  /** Triangle count as the SOURCE FILE numbers them — the space `runs` addresses. */
  sourceTriangleCount: number;
  /** Model-section triangle count. Equals the sum of the run lengths. */
  modelTriangleCount: number;
  /** Triangles the intake dropped for a non-finite coordinate; already compensated for. */
  droppedNonFiniteTriangles: number;
  /**
   * Runs the classifier PRODUCED. Greater than `runs.length / 2` means the map
   * exceeded the cap and what is here is nothing, not a prefix.
   */
  totalRunCount: number;
};

/**
 * The summary persisted alongside a model in the VOXL `MODL` chunk. The run
 * array itself lives in a separate `RUNM` chunk; this stays small enough to be
 * unconditional, so a reader can always tell what the file MEANT to carry even
 * when the array is absent.
 */
export type ImportRunMapSummary = {
  entryCount: number;
  sourceTriangleCount: number;
  modelTriangleCount: number;
  droppedNonFiniteTriangles: number;
  totalRunCount: number;
};

export function summarizeImportRunMap(map: ImportRunMap): ImportRunMapSummary {
  return {
    entryCount: map.runs.length / 2,
    sourceTriangleCount: map.sourceTriangleCount,
    modelTriangleCount: map.modelTriangleCount,
    droppedNonFiniteTriangles: map.droppedNonFiniteTriangles,
    totalRunCount: map.totalRunCount,
  };
}

export function importRunMapExceedsCap(entryCount: number): boolean {
  return entryCount > IMPORT_RUN_MAP_MAX_ENTRIES;
}

/**
 * Encodes the run array as the `RUNM` chunk payload: little-endian `u32` pairs,
 * byte-for-byte the same encoding the DFST response uses.
 *
 * Returns `null` when the map is empty or exceeds the cap — in both cases no
 * chunk is written, and the summary alone tells the reader which it was.
 */
export function encodeImportRunMapChunk(map: ImportRunMap): Uint8Array | null {
  const entryCount = map.runs.length / 2;
  if (entryCount === 0 || importRunMapExceedsCap(entryCount)) return null;
  const out = new Uint8Array(entryCount * IMPORT_RUN_MAP_BYTES_PER_ENTRY);
  const view = new DataView(out.buffer);
  for (let i = 0; i < map.runs.length; i += 1) {
    view.setUint32(i * 4, map.runs[i], true);
  }
  return out;
}

/**
 * Decodes a `RUNM` chunk payload. Returns `null` for anything that is not a
 * whole number of entries — a truncated chunk is not a short run map, it is a
 * damaged one, and the recompute path handles it correctly.
 */
export function decodeImportRunMapChunk(bytes: Uint8Array): Uint32Array | null {
  if (bytes.length === 0 || bytes.length % IMPORT_RUN_MAP_BYTES_PER_ENTRY !== 0) return null;
  const entryCount = bytes.length / IMPORT_RUN_MAP_BYTES_PER_ENTRY;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const runs = new Uint32Array(entryCount * 2);
  for (let i = 0; i < runs.length; i += 1) {
    runs[i] = view.getUint32(i * 4, true);
  }
  return runs;
}

/**
 * Why a run map has to be re-derived from the source file.
 *
 * All four have the SAME remedy — Ph3's splice hands the source path to Rust
 * with no map and `stage_fullres_mesh_from_source` re-runs `classify_import`
 * over it. They differ in diagnosis, not in cure, which is why the reason is
 * carried into the log line rather than branched on.
 */
export type ImportRunMapRecomputeReason =
  | 'over-cap'
  | 'not-persisted'
  | 'chunk-missing'
  | 'chunk-damaged';

export type ImportRunMapResolution =
  | { kind: 'available'; map: ImportRunMap }
  /** No split exists, so there is nothing to recompute and nothing to splice. */
  | { kind: 'none' }
  | { kind: 'recompute'; reason: ImportRunMapRecomputeReason };

/** One line of user/console-facing prose per recompute reason. */
export function describeImportRunMapRecompute(reason: ImportRunMapRecomputeReason): string {
  switch (reason) {
    case 'over-cap':
      return `the import produced more than ${IMPORT_RUN_MAP_MAX_ENTRIES.toLocaleString()} `
        + 'model runs, which is past the transport and save cap';
    case 'not-persisted':
      return 'this model records a support section but no run map was ever saved for it';
    case 'chunk-missing':
      return 'the saved file expected a run-map chunk that is not in it';
    case 'chunk-damaged':
      return 'the saved run-map chunk does not match the summary that describes it';
    default:
      return 'the run map is unavailable';
  }
}

/**
 * The single place that decides whether a model's run map can be used as-is or
 * has to be re-derived from the source file.
 *
 * Consumers must never reach past this into `geometry.importRunMap` or a VOXL
 * chunk directly: an over-cap map and an absent map are indistinguishable by
 * looking at the array (both are empty), and only the summary's `totalRunCount`
 * tells them apart. Getting that wrong means treating a heavily-interleaved
 * pre-supported plate as having no support section at all — silently slicing
 * supports as model, which is the exact class of failure this arc exists to
 * remove.
 */
export function resolveImportRunMap(input: {
  /** The in-session map, when this model was imported in this session. */
  runtime?: ImportRunMap | null;
  /** The summary persisted in `MODL`, when this model came back from a VOXL. */
  summary?: ImportRunMapSummary | null;
  /** The decoded `RUNM` chunk, when the file carried one. */
  persistedRuns?: Uint32Array | null;
}): ImportRunMapResolution {
  const { runtime, summary, persistedRuns } = input;

  if (runtime) {
    if (runtime.totalRunCount === 0) return { kind: 'none' };
    if (runtime.runs.length === 0) return { kind: 'recompute', reason: 'over-cap' };
    return { kind: 'available', map: runtime };
  }

  if (!summary) return { kind: 'recompute', reason: 'not-persisted' };
  if (summary.totalRunCount === 0) return { kind: 'none' };
  if (summary.entryCount === 0) return { kind: 'recompute', reason: 'over-cap' };
  if (!persistedRuns) return { kind: 'recompute', reason: 'chunk-missing' };
  if (persistedRuns.length !== summary.entryCount * 2) {
    return { kind: 'recompute', reason: 'chunk-damaged' };
  }

  return {
    kind: 'available',
    map: {
      runs: persistedRuns,
      sourceTriangleCount: summary.sourceTriangleCount,
      modelTriangleCount: summary.modelTriangleCount,
      droppedNonFiniteTriangles: summary.droppedNonFiniteTriangles,
      totalRunCount: summary.totalRunCount,
    },
  };
}

/**
 * Ph3 — what the section-aware splice should do with one model.
 *
 * `whole` reproduces the pre-Ph3 splice byte-for-byte: one pass over the whole
 * file. `sections` means two passes (model, then support) with a single split
 * index able to describe the result — with `runs` when a live map exists, or
 * with `recomputeReason` when Rust has to re-derive it.
 */
export type ImportSectionSplicePlan =
  | {
      kind: 'whole';
      /**
       * `no-split` — the classifier looked and found one section.
       * `no-support-verdict` — nothing ever recorded whether this model has a
       * support section (a pre-Ph1 save, or a model that never went through the
       * native importer). Splicing it whole is the honest answer: an unknown
       * partition must not be invented, and this is exactly what the pre-Ph3
       * splice did for every model.
       */
      reason: 'no-split' | 'no-support-verdict';
    }
  | {
      kind: 'sections';
      /** Flat `[start0, len0, …]` in SOURCE-FILE indices, or `null` to recompute. */
      runs: Uint32Array | null;
      recomputeReason: ImportRunMapRecomputeReason | null;
    };

/**
 * Decides the plan above from everything that can know about a model's
 * partition, in priority order. The ONLY caller-visible entry point for the
 * splice; {@link resolveImportRunMap} remains the reader it is built on.
 *
 * `reportSplitExists` is the last-resort signal: the classification's
 * `model_triangle_count`. It is what distinguishes "a split is known but its map
 * was never written" (`not-persisted`, recompute) from "nothing here ever said
 * there was a split" (splice whole). Reading the second as the first would
 * charge every ordinary import a full re-classification; reading the first as
 * the second would slice a pre-supported plate's supports as model, which is the
 * failure this arc exists to remove.
 */
export function planImportSectionSplice(input: {
  runtime?: ImportRunMap | null;
  summary?: ImportRunMapSummary | null;
  persistedRuns?: Uint32Array | null;
  /**
   * A recompute verdict already reached by an earlier `resolveImportRunMap`
   * call — VOXL reload decides it while the `RUNM` chunk is still in hand, and
   * `chunk-damaged` in particular cannot be re-derived afterwards (a damaged
   * chunk and an absent one look identical once dropped).
   */
  storedRecompute?: ImportRunMapRecomputeReason | null;
  /** True when the classification reports a model/support split for this model. */
  reportSplitExists: boolean;
}): ImportSectionSplicePlan {
  const { runtime, summary, persistedRuns, storedRecompute, reportSplitExists } = input;

  if (runtime || summary) {
    const resolution = resolveImportRunMap({ runtime, summary, persistedRuns });
    if (resolution.kind === 'none') return { kind: 'whole', reason: 'no-split' };
    if (resolution.kind === 'available') {
      return { kind: 'sections', runs: resolution.map.runs, recomputeReason: null };
    }
    return {
      kind: 'sections',
      runs: null,
      // The stored verdict was reached with more evidence than is available
      // here, so it wins where the two disagree.
      recomputeReason: storedRecompute ?? resolution.reason,
    };
  }

  if (storedRecompute) {
    return { kind: 'sections', runs: null, recomputeReason: storedRecompute };
  }
  if (reportSplitExists) {
    return { kind: 'sections', runs: null, recomputeReason: 'not-persisted' };
  }
  return { kind: 'whole', reason: 'no-support-verdict' };
}

/**
 * Builds the runtime map from what the DFST response carried. `null` when the
 * import found no model/support split at all — which is the ABSENCE of a split,
 * not a split covering everything, and must not be recorded as one.
 */
export function importRunMapFromResponse(input: {
  runs: Uint32Array | null;
  modelTriangleCount: number | null;
  sourceTriangleCount: number;
  droppedNonFiniteTriangles: number;
  totalRunCount: number;
}): ImportRunMap | null {
  if (input.modelTriangleCount == null || input.totalRunCount === 0) return null;
  return {
    runs: input.runs ?? new Uint32Array(0),
    sourceTriangleCount: input.sourceTriangleCount,
    modelTriangleCount: input.modelTriangleCount,
    droppedNonFiniteTriangles: input.droppedNonFiniteTriangles,
    totalRunCount: input.totalRunCount,
  };
}
