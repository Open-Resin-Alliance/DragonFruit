# Auto-Lift

Auto-lift automatically positions a model above the build plate by a configurable distance. This keeps the model elevated for support generation and prevents accidental contact with the platform.

## What it does

When enabled, auto-lift ensures the **lowest point** of the model sits at the configured lift distance (default 5mm) above Z=0.

- **On import:** Model is placed with its lowest point at the lift distance.
- **After rotation:** Model snaps back to the lift distance, compensating for how rotation changes which part of the model is lowest.

## Key concepts

- **Lowest world Z:** The Z coordinate of the model's lowest vertex after all transforms (position, rotation, scale) are applied.
- **Lift distance:** User-configurable distance in mm (stored in localStorage, default 5mm).
- **Auto-snap:** The mechanism that adjusts position to maintain the lift distance.

## How it works

### 1. Computing lowest world Z

The system builds a full transform matrix combining:
1. **Offset matrix** — centers geometry at its center of mass
2. **Rotation/scale matrix** — applies current rotation and scale
3. **Position matrix** — applies current position

Each vertex is transformed through this matrix, and the minimum Z value is found. This runs efficiently using direct buffer access without cloning geometry.

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
- When a model is first loaded
- After rotation completes (gizmo release or input field change)
- When lift distance setting changes
- When auto-lift toggle changes

Auto-snap does **not** run during manual Z movement with the translate gizmo — this lets users override the lift position intentionally.

## Settings

| Setting | Location | Default | Persisted |
|---------|----------|---------|-----------|
| Auto-lift enabled | Move controls card | Off | localStorage |
| Lift distance (mm) | Move controls card | 5 | localStorage |

## Related behavior

- **Rotation invalidates island scan:** When rotation completes, island scan data is cleared since the geometry orientation changed.
- **Manual Z override:** Moving the model vertically with the translate gizmo disables auto-snap until the next rotation or setting change.

## Files involved

- `src/app/page.tsx` — `getLowestWorldZ()`, auto-snap effects, gizmo callbacks
- `src/hooks/useModelTransform.ts` — `snapToLift()`, `snapToPlatform()`, `autoSnapEnabled` state
- `src/utils/geometry.ts` — `computeLowestZ()` optimized vertex scanning
- `src/components/controls/MoveControls.tsx` — UI for auto-lift toggle and distance input
- `src/components/controls/RotateControls.tsx` — triggers `onRotationComplete` for input field changes
- `src/components/scene/SceneCanvas.tsx` — wires `onRotateEnd` to trigger auto-snap for custom gizmo
