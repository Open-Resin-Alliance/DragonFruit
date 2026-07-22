import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

/**
 * Frame resolution for the islands sideload (CP2 of the islands sideload
 * frame fix; plan in
 * `agents/Claude/STL-import-perf/20260720-Implementation-Plan-islands-sideload-frame-fix.md`).
 *
 * The sideload (`scan_islands_from_path`) re-reads the ORIGINAL file from disk
 * and reprojects RAW file coordinates into world space:
 *
 *     w = M · (v_raw − C_pre)
 *
 * `C_pre` is the pre-centering bbox center captured at import
 * (`GeometryWithBounds.cPre`). The post-centering scene bbox center is NOT a
 * valid substitute — it is only meaningful against SCENE geometry, and using
 * it here displaces the whole scan by `M_linear · T_center` for any source
 * file that is not already origin-centered (the frame bug this module exists
 * to prevent; plan §B1).
 *
 * NEVER-GUESS CONTRACT: when no trustworthy `cPre` is stored — models imported
 * before the datum existed, VOXL reloads without a persisted datum, or any
 * model whose geometry was REPLACED since import (`replaceModelGeometry` drops
 * `cPre`; note `sourcePath` deliberately survives mutation, so the path alone
 * must never authorize a re-read) — this resolver returns `null` and the
 * caller must scan the scene geometry client-side instead
 * (`prepareWorldGeom`), which is frame-correct by construction.
 */

export interface IslandScanFrameInput {
  /** Absolute path of the model's source file, when retained. */
  sourcePath?: string | null;
  /** The model's scene geometry wrapper. */
  geometry: GeometryWithBounds | null | undefined;
}

/** A resolved sideload source: file + the frame datum to reproject it with. */
export interface IslandScanFrame {
  filePath: string;
  /** Subtrahend for raw file coordinates: `w = M · (v_raw − cPre)`. */
  cPre: [number, number, number];
  /**
   * Import-time staleness fingerprint (present for native-preview imports,
   * Phase 1). `null` skips the changed-on-disk compare — CP3 wires it into
   * the Rust command.
   */
  fingerprint: { sizeBytes: number; mtimeMs: number } | null;
}

/**
 * Resolves the sideload source for an islands scan, or `null` when the scan
 * must fall back to the client-side path. Pure and synchronous by design so
 * the frame decision is unit-testable without a React or Tauri harness
 * (`__tests__/islandScanFrame.test.ts` is its regression lock).
 */
export function resolveIslandScanFrame(model: IslandScanFrameInput): IslandScanFrame | null {
  const filePath = typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
    ? model.sourcePath
    : null;
  const cPre = model.geometry?.cPre ?? null;
  if (!filePath || !cPre) return null;
  return {
    filePath,
    cPre,
    fingerprint: model.geometry?.nativePreview?.sourceFingerprint ?? null,
  };
}

/**
 * Maps a sideload failure to a human-readable degrade reason (mirrors the
 * slicing/export/mutator mapping — `describeFullResSpliceError` in
 * `sliceExportOrchestrator.ts`). The MISSING/STALE prefixes arrive once CP3
 * adds the staleness check to the scan commands; raw IO errors pass through.
 */
export function describeIslandScanSourceError(raw: string): string {
  if (raw.includes('FULLRES_SOURCE_MISSING')) return 'the original file is missing or unreadable';
  if (raw.includes('FULLRES_SOURCE_STALE')) return 'the original file changed since import';
  return raw;
}

/**
 * Surfaces an islands degrade event through the editor shell's existing toast
 * subsystem — the SAME `dragonfruit:fullres-degraded` event the slicing
 * orchestrator emits (its listener in page.tsx routes it to the
 * operation-error toast), so no new UI wiring is required. Reserved for
 * QUALITY-relevant degrades (a decimated preview scanned client-side, or a
 * resolved sideload that failed): a client-side scan of ordinary full
 * geometry is same-fidelity and stays quiet.
 */
export function emitIslandScanDegradeWarning(sourceLabel: string, reason: string): void {
  if (typeof window === 'undefined') return;
  const name = sourceLabel.replace(/^.*[\\/]/, '') || sourceLabel;
  window.dispatchEvent(new CustomEvent('dragonfruit:fullres-degraded', {
    detail: {
      message: `Islands scan for "${name}": ${reason} — scanned the scene geometry instead.`,
    },
  }));
}
