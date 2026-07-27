/**
 * Staging for Rust-side ANALYSIS commands that read the shared staged mesh
 * (STL-import support-aware import, Ph2 — the SDF / A* row of the consumer
 * census).
 *
 * THE PROBLEM THIS NAMES. `compute_sdf_from_staged` (src-tauri/src/sdf.rs) and
 * its siblings do not take geometry at all — they read the process-global
 * `staged_mesh()` and cache on its stats. Whatever was staged LAST is what they
 * analyse. There is therefore no call site where a resolver could be applied by
 * a future author following the local idiom, and no compiler signal when the
 * thing last staged happens to be a decimated preview. That is precisely the
 * failure mode Ph2 exists to make impossible.
 *
 * THE CONTRACT. Anything that intends to analyse "this model" Rust-side stages
 * it through {@link stageModelForRustAnalysis}, which resolves the source at the
 * one chokepoint (`resolveOutputGeometrySource`) and therefore honours the
 * user's Original/Decimated toggle for free. A consumer that legitimately wants
 * the preview says so with `resolvePreviewGeometryForRustConsumer(model, reason)`.
 *
 * SCOPE FENCE (plan §Ph2). The SDF CACHE is not made flag-aware here — it is
 * keyed by mesh stats and owned by support placement. Ph2 ships the staging
 * contract; it does not rewire pathfinding. Note also that
 * `tryLoadPrecomputedSDFForMesh` (SmartPlacementV2.ts) currently has NO
 * production caller, so the SDF precompute path is dormant — recorded in the
 * Ph2 AAR rather than silently "routed".
 */
import type * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  resolveOutputGeometrySource,
  type FullResSourceFile,
} from '@/features/mesh-modifiers/prepareModelGeometry';
import {
  planMutatorFullResStaging,
  stageFullResMutatorSource,
  describeFullResMutatorSpliceError,
  type FullResMutatorSource,
} from '@/utils/fullResMutatorStaging';
import { stageGeometrySoupToStagedMesh, isTauriRuntime } from '@/utils/meshRepair';

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView, opts?: { headers?: Record<string, string> }) => Promise<T>;

/**
 * What a Rust analysis command will actually see for this model. Pure and
 * synchronous so the routing decision is unit-testable without Tauri.
 */
export type ModelRustAnalysisStagingPlan =
  | { kind: 'fullres-source-file'; source: FullResSourceFile; mutatorSource: FullResMutatorSource | null }
  | { kind: 'scene-geometry'; geometry: THREE.BufferGeometry };

export function planModelRustAnalysisStaging(model: LoadedModel): ModelRustAnalysisStagingPlan {
  const source = resolveOutputGeometrySource(model);
  if (source.kind === 'scene-geometry') {
    return { kind: 'scene-geometry', geometry: source.geometry };
  }
  // Analysis commands read the staged buffer in the mutators' LOCAL centered
  // frame (raw f32), not the slicing world transport — so the frame datum is
  // the mutator vector T_center, not C_pre. `planMutatorFullResStaging` owns
  // that conversion; see fullResMutatorStaging.ts for why using C_pre here
  // would shift the mesh up in Y by half the model height.
  return {
    kind: 'fullres-source-file',
    source,
    mutatorSource: planMutatorFullResStaging(model),
  };
}

export interface ModelRustAnalysisStagingResult {
  staged: boolean;
  usedFullRes: boolean;
  /** Present when a resolved full-res source failed and we fell back — never silent. */
  degraded?: { reason: string };
}

let tauriCorePromise: Promise<{ invoke: TauriInvoke } | null> | null = null;

async function loadTauriCore(): Promise<{ invoke: TauriInvoke } | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

/**
 * Stages `model` into the shared staged mesh for a Rust ANALYSIS command,
 * through the Ph2 chokepoint. Returns which source was used so the caller can
 * label its result honestly.
 *
 * Every degrade is loud: a resolved full-res source that fails to splice logs
 * and returns a `degraded.reason` rather than quietly analysing the preview.
 */
export async function stageModelForRustAnalysis(
  model: LoadedModel,
): Promise<ModelRustAnalysisStagingResult> {
  const core = await loadTauriCore();
  if (!core) return { staged: false, usedFullRes: false };

  const plan = planModelRustAnalysisStaging(model);
  if (plan.kind === 'scene-geometry') {
    await stageGeometrySoupToStagedMesh(core.invoke, plan.geometry);
    return { staged: true, usedFullRes: false };
  }

  if (!plan.mutatorSource) {
    // Resolved full-res but no usable frame datum. Ph1 established the
    // never-guess-a-center rule; the degrade is announced, not swallowed.
    console.warn(
      `[RustAnalysisStaging] "${model.name}" resolved to its full-resolution source `
      + 'but has no stored import frame datum (cPre) — analysing the reduced preview instead.',
    );
    await stageGeometrySoupToStagedMesh(core.invoke, model.geometry.geometry);
    return {
      staged: true,
      usedFullRes: false,
      degraded: { reason: 'its import frame datum was not stored' },
    };
  }

  try {
    await stageFullResMutatorSource(core.invoke, plan.mutatorSource);
    return { staged: true, usedFullRes: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const reason = describeFullResMutatorSpliceError(raw);
    console.warn(
      `[RustAnalysisStaging] full-res source splice failed for "${model.name}" — `
      + `analysing the reduced preview instead: ${raw}`,
    );
    await stageGeometrySoupToStagedMesh(core.invoke, model.geometry.geometry);
    return { staged: true, usedFullRes: false, degraded: { reason } };
  }
}
