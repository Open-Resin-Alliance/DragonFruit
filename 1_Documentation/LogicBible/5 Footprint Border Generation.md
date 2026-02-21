# 5 Footprint Border Generation

## Overview

The **Footprint Border** is a blue outline rendered on the build plate (at Z = -1mm) that shows the combined footprint of the model and raft with a configurable margin. This provides users with a visual preview of the total build plate area that will be occupied.

**Location**: `src/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer.tsx`

---

## Purpose

The footprint border serves multiple purposes:

1. **Build Plate Organization**: Shows exactly how much space the print will occupy
2. **Raft Visualization**: Displays the outer boundary of the raft when enabled
3. **Multi-Model Planning**: Helps users plan placement of multiple models on the build plate
4. **Safety Margin**: Includes a configurable margin (default 1mm) beyond the actual footprint

---

## Algorithm Overview

The footprint generation uses a **four-stage pipeline**:

```
1. Collect Points (Raft + Model)
   ↓
2. Compute Convex Hull
   ↓
3. Apply Margin Offset
   ↓
4. Render as Line Geometry
```

---

## Stage 1: Point Collection

### A. Raft Footprint

The footprint border is only computed when:
- Raft bottom is enabled (`bottomMode !== 'off'`)
- `showFootprintBorder` is true

When supports exist:

1. Extract all support base circles (position + radius)
2. Use `computeFootprint()` to generate the base raft profile
3. Use `computeRaftOuterBoundary()` to account for chamfer and walls
4. Add all resulting points to the collection

### B. Model Footprint - Raycast Approach

The model footprint uses **BVH-accelerated raycasting** to create an accurate "shadow" of the model:

#### Why Raycasting?

- ✅ **Accurate**: Captures the actual model shape, not just a bounding box
- ✅ **Fast**: BVH acceleration makes it extremely efficient (typically <10ms)
- ✅ **Transform-aware**: Correctly handles rotation, scaling, and translation
- ✅ **Memory-efficient**: Doesn't iterate all vertices (which could be millions)

#### The "100 Little Lights" Concept

Think of it as shining a grid of lights from above the build plate:
- Each "light" is a ray cast from above the model downward (Z = -1 direction)
- If a ray hits the model, we record the XY position of that hit
- The collection of all hit points forms the model's "shadow"

#### Implementation Details

```typescript
// 1. Compute world-space bounding box
const corners = [/* 8 bbox corners */];
for (const corner of corners) {
  corner.applyMatrix4(transformMatrix);
  // Track min/max X, Y, Z
}

// 2. Create grid of rays
const GRID_SIZE = 50; // (GRID_SIZE+1)^2 = 2,601 rays
const stepX = (maxX - minX) / GRID_SIZE;
const stepY = (maxY - minY) / GRID_SIZE;

// 3. Cast rays in grid pattern
for (let i = 0; i <= GRID_SIZE; i++) {
  for (let j = 0; j <= GRID_SIZE; j++) {
    const worldX = minX + i * stepX;
    const worldY = minY + j * stepY;
    
    // Set up ray starting 10mm above model
    rayOrigin.set(worldX, worldY, maxZ + 10);
    raycaster.ray.origin.copy(rayOrigin);
    raycaster.ray.direction.set(0, 0, -1);
    
    // Transform to local space for BVH query
    raycaster.ray.applyMatrix4(inverseMatrix);
    
    // Cast ray using BVH
    const hit = bvh.raycastFirst(raycaster.ray, THREE.DoubleSide);
    
    if (hit) {
      // Transform hit point back to world space
      const worldHit = hit.point.clone().applyMatrix4(transformMatrix);
      allPoints.push(new THREE.Vector2(worldHit.x, worldHit.y));
    }
  }
}
```

#### Grid Resolution Trade-offs

| Grid Size | Total Rays | Performance | Accuracy |
|-----------|------------|-------------|----------|
| 25 | 676 | ~2-3ms | Good |
| **50** | **2,601** | **~5-8ms** | **Excellent** ⭐ |
| 75 | 5,776 | ~10-15ms | Outstanding |
| 100 | 10,201 | ~20-30ms | Overkill |

**Current setting**: 50x50 provides excellent accuracy with minimal performance impact.

#### Fallback Behavior

If BVH is not available (shouldn't happen in normal operation):
- Falls back to using the 8 corners of the transformed bounding box
- Less accurate but ensures the feature always works

---

## Stage 2: Convex Hull Computation

Once all points are collected (raft + model), we compute the **convex hull** using the **Monotonic Chain Algorithm** (Andrew's algorithm):

### Why Convex Hull?

- Simplifies the border to essential outer points
- Removes internal points and concave features
- Creates a clean, continuous outline
- Efficient: O(n log n) complexity

### Algorithm Steps

1. **Sort points** by X coordinate (then Y if X is equal)
2. **Build lower hull**: Scan left to right, maintaining convex property
3. **Build upper hull**: Scan right to left, maintaining convex property
4. **Concatenate**: Join lower and upper hulls to form complete outline

```typescript
function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  // Sort points
  const pts = points.sort((a, b) => 
    a.x === b.x ? a.y - b.y : a.x - b.x
  );
  
  // Cross product to determine turn direction
  const cross = (o, a, b) => 
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  
  // Build lower hull
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && 
           cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  
  // Build upper hull (same process, reversed)
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    // ... similar logic
  }
  
  // Concatenate (remove duplicates at ends)
  return lower.concat(upper);
}
```

---

## Stage 3: Margin Offset

The convex hull is expanded outward by a configurable margin (default: 1mm).

### Offset Algorithm

For each vertex in the hull:

1. **Calculate edge normals**: Get perpendicular vectors for adjacent edges
2. **Average normals**: Combine normals at the vertex
3. **Account for angle**: Adjust distance based on the angle between edges
4. **Offset vertex**: Move along averaged normal by calculated distance

```typescript
function offsetPolygonOutward(polygon: THREE.Vector2[], distance: number) {
  for each vertex i {
    // Get adjacent edges
    const edge1 = normalize(curr - prev);
    const edge2 = normalize(next - curr);
    
    // Perpendicular normals (right-hand rule for CCW polygon)
    const normal1 = new Vector2(edge1.y, -edge1.x);
    const normal2 = new Vector2(edge2.y, -edge2.x);
    
    // Average and normalize
    const avgNormal = normalize(normal1 + normal2);
    
    // Adjust for angle (prevents sharp corners from overshooting)
    const cosAngle = dot(normal1, normal2);
    const offsetDist = distance / sqrt((1 + cosAngle) / 2);
    
    // Apply offset
    offsetVertex = curr + avgNormal * offsetDist;
  }
}
```

### Why This Approach?

- ✅ Uniform offset for straight edges
- ✅ Smooth corners without gaps or overlaps
- ✅ Handles both convex and reflex angles correctly

---

## Stage 4: Rendering

The final offset polygon is converted to a THREE.js `Line`:

```typescript
// Convert 2D points to 3D at Z = -1mm (below build plate)
const points = borderProfile.map(p => 
  new THREE.Vector3(p.x, p.y, -1.0)
);

// Close the loop
points.push(points[0].clone());

// Create line geometry
const geometry = new THREE.BufferGeometry().setFromPoints(points);

// Render with blue material
<Line geometry={geometry} material={{
  color: '#3b82f6',
  linewidth: 5,
  opacity: 0.5,
  transparent: true
}} />
```

**Why Z = -1mm?**
- Positions the line just below the build plate (Z = 0)
- Visible when viewing from above
- Doesn't interfere with model or supports

---

## Performance Characteristics

### Complexity Analysis

| Stage | Complexity | Typical Time |
|-------|-----------|--------------|
| Raft Footprint | O(s) | <1ms |
| Model Raycast | O(g²) | 5-8ms |
| Convex Hull | O(n log n) | <1ms |
| Margin Offset | O(h) | <1ms |
| Rendering | O(h) | <1ms |

**Where:**
- s = number of supports
- g = grid size setting (`GRID_SIZE`, which yields (g+1)^2 ray samples)
- n = total collected points (~2,600+)
- h = hull vertices (~20-50)

### Total Performance

**Typical execution time**: 6-10ms
- BVH acceleration is the key to fast raycasting
- Negligible impact on frame rate
- Updates only when model transforms or raft settings change (`useMemo` dependency)

---

## Configuration

### Settings (from `RaftState`)

```typescript
interface RaftSettings {
  bottomMode: 'off' | 'solid' | 'line';
  showFootprintBorder: boolean;      // Toggle border visibility
  footprintBorderMargin: number;     // Margin in mm (default: 1.0)
}
```

### Tuning Grid Resolution

To adjust accuracy vs. performance, modify `GRID_SIZE` in `FootprintBorderRenderer.tsx`:

```typescript
const GRID_SIZE = 50; // Current value

// Higher = more accurate but slower
// Lower = faster but less accurate
// Recommended range: 25-75
```

---

## Edge Cases & Robustness

### No Model
- Returns `null`, no border rendered
- Checks: `if (!modelGeometry || !modelTransform) return null`

### No BVH
- Graceful fallback to bounding box corners
- Rare case (BVH should always be initialized)

### No Raft
- The border is disabled when raft bottom mode is off (`bottomMode === 'off'`), even if a model is loaded.
- If raft bottom mode is enabled but there are no supports, raft point collection contributes no points and the border can still be based on the model footprint.

### Insufficient Points
- Requires at least 3 points for valid hull
- Checks: `if (allPoints.length < 3) return null`

### Transform Changes
- Automatically recomputes via `useMemo` dependency array
- Triggers on: `[modelGeometry, modelTransform, supports, raft]`

---

## Related Components

- `computeFootprint`: Generates raft base profile from support circles
- `computeRaftOuterBoundary`: Expands raft profile with chamfer/walls
- `useStlGeometry`: Provides geometry with BVH acceleration
- `useModelTransform`: Provides transform matrix

---

## Future Enhancements

Potential improvements:

1. **Adaptive Grid**: Vary grid density based on model complexity
2. **Caching**: Cache results for unchanged models
3. **Hollowing Support**: Account for model hollowing in footprint
4. **Multi-Material**: Different colors for model vs. raft footprint
5. **Distance Field**: Use signed distance field for ultra-precise footprint

---

## Debugging

### Console Logs

The border renderer includes timing logs:

```
[FootprintBorderRenderer] Computing footprint...
[FootprintBorderRenderer] Footprint computed in 7.23ms. Points: 2601
```

### Visualization Tips

- Border color: `#3b82f6` (blue)
- Border appears at Z = -1mm
- Opacity: 0.5 (semi-transparent)
- Toggle visibility: Raft settings → Show Footprint Border

### Common Issues

**Border not appearing:**
- Check if raft is enabled AND `showFootprintBorder` is true
- Verify model has geometry and transform

**Border too large/small:**
- Adjust `footprintBorderMargin` in raft settings
- Default: 2.0mm

**Performance issues:**
- Reduce `GRID_SIZE` (try 25 instead of 50)
- Check if BVH is properly initialized

---

## References

- **Monotonic Chain Algorithm**: Andrew, A. M. (1979). "Another efficient algorithm for convex hulls in two dimensions"
- **BVH Raycasting**: three-mesh-bvh library documentation
- **Polygon Offset**: Computational Geometry algorithms
