# Bug Report: Missed Islands in Scanner

**Status**: Identified
**Date**: 2025-12-09
**Modules**: `island/ScanOrchestrator.ts`

## Problem
The Island Scanner appears to be "missing" valid islands (particularly small ones or "toes"), causing them to disappear from the 3D view and downstream logic.

## Analysis
Investigation confirmed that the RLE (Run-Length Encoding) system is **lossless** and identifying all geometry correctly.

The root cause is an **explicit filter** in `ScanOrchestrator.ts` intended to remove noise.

```typescript
// ScanOrchestrator.ts : Line 341
const minAreaMm2 = params.min_island_area_mm2 ?? 0.01; 
// ...
const filteredIslands = realIslands.filter(island => (island.maxAreaMm2 ?? 0) >= minAreaMm2);
```

Any island with a max cross-sectional area smaller than `0.01 mm²` is deleted from the results.

## Proposed Fix
When we return to this task:
1.  **Lower the Threshold**: Reduce `min_island_area_mm2` to `0.001` or `0` to allow all micro-islands.
2.  **Make Configurable**: Ensure the user can toggle "Show Noise" if needed.
