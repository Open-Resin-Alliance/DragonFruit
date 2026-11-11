export interface HeightRange {
  minHeightMm: number;
  maxHeightMm: number;
}

export interface HeightBucket<M> extends HeightRange {
  models: M[];
}

/** Group finite, nonnegative print heights by their distance from each bucket's tallest model. */
export function bucketModelsByHeight<M>(
  models: readonly M[],
  heightOf: (model: M) => number,
  maxDifferenceMm: number,
): HeightBucket<M>[] {
  const sorted = models.map((model) => ({ model, heightMm: heightOf(model) }));
  sorted.sort((a, b) => b.heightMm - a.heightMm);

  const buckets: HeightBucket<M>[] = [];
  for (const { model, heightMm } of sorted) {
    const bucket = buckets[buckets.length - 1];
    if (bucket && bucket.maxHeightMm - heightMm <= maxDifferenceMm) {
      bucket.models.push(model);
      bucket.minHeightMm = heightMm;
    } else {
      buckets.push({ minHeightMm: heightMm, maxHeightMm: heightMm, models: [model] });
    }
  }
  return buckets;
}

/** An occupied bed can accept a range only if the combined height span fits. */
export function heightRangesFit(
  existing: HeightRange | null,
  incoming: HeightRange,
  maxDifferenceMm: number,
): boolean {
  if (existing === null) return true;
  return Math.max(existing.maxHeightMm, incoming.maxHeightMm)
    - Math.min(existing.minHeightMm, incoming.minHeightMm) <= maxDifferenceMm;
}
