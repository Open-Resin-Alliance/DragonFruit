# Scan Positioning Helper

## Purpose

Scan-based visualizations (voxels, island overlays, and future features that use island scan data) all depend on a consistent coordinate system. The scan pipeline already operates on **world-space transformed geometry** – including rotation, scale, and auto-lifted position.

The scan positioning helper centralizes how these visualizations should be positioned in the scene so that:

- We **don’t double-apply** transforms (especially rotation and auto-lift Z).
- All scan-based features follow the **same policy** for how they attach to the model.
- New features can reuse a small, explicit API instead of re-implementing math.

---

## Scan Coordinate System (Recap)

### 1. Model Transform & Auto-Lift

- `useModelTransform` tracks the live `transform`:
  - `position: THREE.Vector3`
  - `rotation: THREE.Euler`
  - `scale: THREE.Vector3`
- Auto-lift logic:
  - `getLowestWorldZ()` clones the geometry and applies:
    - mesh centering offset (`-center`),
    - current `rotation` and `scale`,
    - current `position`.
  - `snapToLift(currentLowestWorldZ, liftDistance)` computes:
    - `offset = liftDistance - currentLowestWorldZ`
    - adds `offset` to `position.z`.
  - Result: lowest vertex in world space is exactly `liftDistance` after snap.

### 2. Scan Pipeline

When the user clicks **Scan**:

- `onRunIslandScan` in `page.tsx`:
  - Clones `geom.geometry` → `transformedGeom`.
  - Computes the `centerOffset` (from the original bounding box).
  - Applies `transformedGeom.translate(-centerOffset.x, -centerOffset.y, -centerOffset.z)`.
  - Builds a matrix from the **current** transform:
    - position = `transform.position` (includes auto-lift Z)
    - rotation = `transform.rotation`
    - scale = `transform.scale`
  - Applies `transformedGeom.applyMatrix4(matrix)`.
  - Computes `transformedBBox` and passes `{ geometry: transformedGeom, bbox: transformedBBox }` into `runIslandScan`.

**Key:** the scan sees geometry already positioned and oriented **exactly as rendered**, including:

- mesh centering offset,
- rotation,
- scale,
- auto-lifted position.

The scan’s `ScanResults` and `scanBBox` are therefore in **world space**.

### 3. Voxel & Overlay World Z

- Voxel Z:
  - `zOffset = scanBBox.min.z`
  - `layerZ = zOffset + layerIndex * layerHeightMm`
- Overlay/markers:
  - `computeIslandMarkers(scanData, scanBBox, ...)` uses `scanBBox` to build marker geometries directly in world space.

Z is already correct at the output of the scan.

---

## The Helper Module

**File:** `src/utils/scanPositioning.ts`

### `getWorldZForLayer(scanBBox, layerHeightMm, layerIndex)`

```ts
getWorldZForLayer(scanBBox: THREE.Box3, layerHeightMm: number, layerIndex: number): number
```

- **Inputs:**
  - `scanBBox`: bounding box of the transformed geometry used for scanning.
  - `layerHeightMm`: slice thickness in mm.
  - `layerIndex`: 0-based index (0, 1, 2, ...).
- **Behavior:**
  - Computes `zOffset = scanBBox.min.z`.
  - Returns `zOffset + layerIndex * layerHeightMm`.
- **Use when:** you need to convert a logical slice index back into a world-space Z value (e.g., debug markers, labeling, future tools that visualize per-layer data).

### `getScanVisualPosition(transform?)`

```ts
getScanVisualPosition(transform?: ModelTransform): THREE.Vector3
```

- **Inputs:**
  - `transform`: current live model transform (from `useModelTransform`). May be `undefined`.
- **Behavior:**
  - If `transform` is missing → returns `(0, 0, 0)`.
  - If present → returns a new `THREE.Vector3`:
    - `x = transform.position.x`
    - `y = transform.position.y`
    - `z = 0`
- **Policy:**
  - Scan-based geometries (voxels, markers, etc.) are already in **world space** with rotation + auto-lift baked in.
  - We only want them to **follow X/Y movement** of the model after scan.
  - We do **not** reapply rotation or Z, because that would double-apply auto-lift and orientation.

This function is the standard way to position the outer `<group>` for any scan-based visualization.

---

## How to Use the Helper

### 1. Voxel Visualization

**File:** `src/components/scene/IslandVoxelVisualization.tsx`

- Import the helper:

```ts
import { getScanVisualPosition } from '@/utils/scanPositioning';
```

- Use it for the outer group:

```tsx
if (!enabled) return null;

return (
  <group position={getScanVisualPosition(transform)}>
    {islandMeshData.map((data) => (
      <IslandSmoothMesh
        key={data.id}
        geometry={data.geometry}
        color={data.color}
        opacity={data.opacity}
        isSelected={data.isSelected}
        clippingPlanes={clippingPlanes}
      />
    ))}
  </group>
);
```

Notes:

- `islandMeshData` geometries are built using world-space positions from the scan (including auto-lift).
- The group’s position is only an **X/Y translation** so voxels follow moves after the scan.
- No rotation, no scale, no Z should be applied here.

### 2. Island Overlay Markers

**File:** `src/components/scene/IslandOverlay.tsx`

- Import the helper:

```ts
import { getScanVisualPosition } from '@/utils/scanPositioning';
```

- Use it for the outer group:

```tsx
// Apply X/Y translation only - marker geometries are already in world space (including auto-lift and rotation)
return (
  <group position={getScanVisualPosition(transform)}>
    {markers.map((marker) => {
      if (!marker.geometry) return null;
      // ... render selected / unselected meshes
    })}
  </group>
);
```

Notes:

- `markers` are built using `computeIslandMarkers` with `scanBBox`, i.e., they are already in world-space.
- Again, we only add X/Y translation from the live transform so markers follow moves after scan.

### 3. New Scan-Based Features (Guidelines)

When adding any new visualization that depends on island scan results (e.g., debug shapes, arrows, per-layer indicators):

1. **For Z / layers:** use `getWorldZForLayer(scanBBox, layerHeightMm, layerIndex)` instead of manually doing `scanBBox.min.z + layerIndex * layerHeightMm`.
2. **For attaching to the model:** wrap your visualization meshes in a `<group>` whose `position` comes from `getScanVisualPosition(transform)`.
3. **Do not** reapply rotation or scale to scan-based geometries unless you are deliberately re-orienting them for some UI purpose.
4. **Do not** reapply `position.z` to scan-based geometries; auto-lift is already baked into the transformed geometry used for the scan.

Following this pattern keeps all scan-based visuals consistent with how the model is scanned and rendered.

---

## Why This Matters

Without the helper, each component had to remember:

- That scan geometry is already in world space.
- That auto-lift and rotation are already applied before scanning.
- That Z and rotation should **not** be reapplied at render time.

This led to bugs such as:

- Voxels being too high or misaligned after rotation + auto-lift + rescan.
- Double-application of auto-lift and rotation in the rendering layer.

By centralizing the policy in `scanPositioning.ts` and using `getScanVisualPosition` everywhere, we:

- Reduce the chance of regressions when adding new features.
- Make the intended coordinate system and behavior explicit.
- Keep future features simpler: they call helpers instead of re-deriving math.
