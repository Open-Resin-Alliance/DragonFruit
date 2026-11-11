export interface PrintTimePlan {
  plateCount: number;
  unplacedCount: number;
  passes: readonly {
    plateId: string | null;
    modelIds: readonly string[];
  }[];
}

function totalPrintHeight(
  plan: PrintTimePlan,
  heightByModelId: ReadonlyMap<string, number>,
  fixedHeightByPlate: ReadonlyMap<string, number>,
): number {
  const heightByPlate = new Map(fixedHeightByPlate);
  let total = 0;
  for (const pass of plan.passes) {
    let height = pass.plateId === null ? 0 : (heightByPlate.get(pass.plateId) ?? 0);
    for (const modelId of pass.modelIds) {
      height = Math.max(height, heightByModelId.get(modelId)!);
    }
    if (pass.plateId === null) {
      total += height;
    } else {
      heightByPlate.set(pass.plateId, height);
    }
  }
  for (const height of heightByPlate.values()) {
    total += height;
  }
  return total;
}

/** Keep the Compact plate budget and fit rate, then minimize the sum of plate print heights. */
export function improvesPrintTimePlan(
  candidate: PrintTimePlan,
  baseline: PrintTimePlan,
  heightByModelId: ReadonlyMap<string, number>,
  fixedHeightByPlate: ReadonlyMap<string, number>,
): boolean {
  if (candidate.plateCount > baseline.plateCount || candidate.unplacedCount > baseline.unplacedCount) {
    return false;
  }
  if (candidate.unplacedCount < baseline.unplacedCount) return true;
  const candidateHeight = totalPrintHeight(candidate, heightByModelId, fixedHeightByPlate);
  const baselineHeight = totalPrintHeight(baseline, heightByModelId, fixedHeightByPlate);
  if (candidateHeight !== baselineHeight) return candidateHeight < baselineHeight;
  return candidate.plateCount < baseline.plateCount;
}
