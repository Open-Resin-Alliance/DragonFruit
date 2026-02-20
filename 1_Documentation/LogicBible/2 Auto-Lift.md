# 2 Auto-Lift

Auto-lift automatically positions a model above the build plate by a configurable distance. This keeps the model elevated for support generation and prevents accidental contact with the platform.

## What it does

When enabled, auto-lift ensures the **lowest point** of the model sits at the configured lift distance (default 5mm) above the build plate plane (world Z=0).

- **On import:** Model is initially placed with its lowest point at the lift distance.
- **After rotation:** Model snaps back to the lift distance, compensating for how rotation changes which part of the model is lowest.

## Key concepts

- **Lowest world Z:** The Z coordinate of the model's lowest vertex after all transforms (position, rotation, scale) are applied.
- **Lift distance:** User-configurable distance in mm (stored in localStorage, default 5mm).
- **Auto-snap:** The mechanism that adjusts position to maintain the lift distance.

## Coordinate system and STL normalization (current behavior)

The app treats **Z as up** for the build plate, lifting, and layer-based features.

Separately, STL geometry is normalized on load by:
- Centering local X and Z around 0
- Shifting local Y so the geometry's minimum Y becomes 0

This normalization step is independent from auto-lift. Auto-lift and platform placement are still computed using **world Z**.

## How it works

### 0. Initial placement on import

When a model is loaded, the app computes an initial Z position using the geometry bounding box (in Z) so the model starts with its lowest point at either Z=0 (platform) or Z=liftDistance (auto-lift).

### 1. Computing lowest world Z

The system builds a full transform matrix combining:
1. **Offset matrix** — centers geometry at its bounding box center
2. **Rotation/scale matrix** — applies current rotation and scale
3. **Position matrix** — applies current position

Each vertex is transformed through this matrix, and the minimum Z value is found. This runs efficiently using direct buffer access without cloning geometry.

Note: this computation uses a bounding-box-center offset to match how the model is rendered (the render mesh is centered within its group using the same bounding box center).

### 2. Snap calculation

Once we know the current lowest Z:
```
offset = liftDistance - lowestWorldZ
newPositionZ = currentPositionZ + offset
```

If auto-lift is disabled, the model snaps to the platform instead:
```
offset = 0 - lowestWorldZ
```

### 3. When auto-snap triggers

Auto-snap runs:
- After rotation completes (gizmo release or input field change)
- When lift distance setting changes
- When auto-lift toggle changes

On import, the model's initial Z placement is handled directly during model load (rather than via auto-snap).

Auto-snap intentionally does **not** run at the end of translate/move operations — this lets users override the lift position intentionally.

## Settings

| Setting | Location | Default | Persisted |
|---------|----------|---------|-----------|
| Auto-lift enabled | Transform controls panel (Prepare mode) | Off | localStorage (`autoLift`) |
| Lift distance (mm) | Transform controls panel (Prepare mode) | 5 | localStorage (`liftDistance`) |

## Related behavior

- **Rotation invalidates island scan:** When rotation completes, island scan data is cleared since the geometry orientation changed.
- **Manual Z override:** Because auto-snap is not invoked at the end of translate/move, manual Z positioning persists until the next rotation end event or an auto-lift setting change.

## Files involved

- `src/hooks/useStlGeometry.ts` — STL loading + geometry normalization; calls BVH acceleration for fast raycasting
- `src/features/scene/useSceneCollectionManager.ts` — computes initial placement Z on import (platform vs liftDistance)
- `src/features/transform/useTransformManager.ts` — `getLowestWorldZ()`, localStorage-backed `autoLift`/`liftDistance`, and auto-snap orchestration via `performAutoSnap()`
- `src/hooks/useModelTransform.ts` — `snapToLift()`, `snapToPlatform()`, `autoSnapEnabled`
- `src/utils/geometry.ts` — `computeLowestZ()` optimized vertex scanning
- `src/components/controls/TransformControls.tsx` — UI for auto-lift toggle and distance input; triggers `onRotationComplete` for rotation field changes
- `src/components/scene/SceneCanvas.tsx` — calls `onTransformEnd('rotate')` on gizmo rotate end
- `src/app/page.tsx` — clears island scan on rotation completion and calls `transformMgr.performAutoSnap()` on rotation end
