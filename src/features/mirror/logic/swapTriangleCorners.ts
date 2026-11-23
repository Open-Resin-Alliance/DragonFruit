/**
 * Swap corners 1 and 2 of every triangle in a non-indexed attribute array.
 *
 * A reflection reverses every triangle's winding, which a soup expresses by swapping
 * two corners in place. Every per-corner attribute has to swap with the positions,
 * or its values land on corners they were not computed for.
 */
export function swapTriangleCorners(array: { length: number; [index: number]: number }, itemSize: number): void {
  const stride = itemSize * 3;
  const triCount = Math.floor(array.length / stride);
  for (let t = 0; t < triCount; t++) {
    const baseA = t * stride + itemSize;
    const baseB = baseA + itemSize;
    for (let c = 0; c < itemSize; c++) {
      const tmp = array[baseA + c];
      array[baseA + c] = array[baseB + c];
      array[baseB + c] = tmp;
    }
  }
}
