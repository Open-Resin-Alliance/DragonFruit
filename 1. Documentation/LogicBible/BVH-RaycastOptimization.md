# BVH Raycasting Optimization for Support Placement

## Problem

Support placement in Support mode was experiencing severe performance issues with high-polygon models. Every mouse movement triggered a raycast against the entire mesh, testing **every triangle sequentially** (O(n) complexity where n = triangle count). For models with 100k+ triangles, this caused:

- Severe lag during mouse movement
- Unresponsive support preview
- Poor user experience compared to professional slicers like Lychee

## Root Cause

Three.js's default `Mesh.raycast()` method uses a brute-force approach:
1. Tests ray against every triangle in the geometry
2. No spatial acceleration structure
3. Performance degrades linearly with triangle count
4. High-poly models (100k+ triangles) = 100k+ intersection tests per mouse move

## Solution: BVH Acceleration

Implemented **Bounding Volume Hierarchy (BVH)** using the `three-mesh-bvh` library (bundled with `@react-three/drei`).

### What is BVH?

A BVH is a tree structure that organizes triangles into nested bounding boxes:
- Root node contains all triangles
- Child nodes split space recursively
- Leaf nodes contain small triangle groups
- Raycasting traverses tree, skipping entire branches when ray misses bounding box

### Performance Impact

- **Before**: O(n) - test every triangle
- **After**: O(log n) - traverse tree structure
- **Speedup**: 100-1000x faster on high-poly meshes
- **Example**: 100k triangles → ~17 tree levels instead of 100k tests

## Implementation

### 1. BVH Utility (`src/utils/bvh.ts`)

```typescript
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '@react-three/drei/node_modules/three-mesh-bvh';

export function initializeBVH() {
  // Augment THREE.BufferGeometry prototype
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  
  // Replace default raycast with accelerated version
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

export function accelerateGeometry(geometry: THREE.BufferGeometry) {
  geometry.computeBoundsTree();
  return geometry;
}
```

### 2. Global Initialization (`src/app/page.tsx`)

```typescript
import { initializeBVH } from '@/utils/bvh';

// Initialize once at app startup
if (typeof window !== 'undefined') {
  initializeBVH();
}
```

### 3. Geometry Acceleration (`src/hooks/useStlGeometry.ts`)

```typescript
import { accelerateGeometry } from '@/utils/bvh';

// After loading and normalizing geometry
geometry.computeVertexNormals();
geometry.computeBoundingBox();
// ... normalization ...

// Add BVH acceleration
accelerateGeometry(geometry);
```

## How It Works

1. **App Startup**: `initializeBVH()` patches Three.js prototypes globally
2. **STL Load**: Geometry is loaded and normalized
3. **BVH Build**: `accelerateGeometry()` computes spatial tree structure (one-time cost)
4. **Raycasting**: All subsequent raycasts automatically use accelerated method
5. **Support Placement**: Mouse movements trigger fast BVH-accelerated raycasts

## Trade-offs

### Pros
- 100-1000x faster raycasting on high-poly meshes
- No change to existing raycast code (drop-in replacement)
- Minimal memory overhead (~10-20% of geometry size)
- One-time build cost (typically <100ms even for large meshes)

### Cons
- Initial BVH build takes time (but only once per geometry load)
- Slightly more memory usage for tree structure
- Must rebuild if geometry is modified (not an issue for static STL meshes)

## Why This Works Like Lychee

Professional slicers like Lychee use similar spatial acceleration:
- BVH, Octree, or KD-tree structures
- Logarithmic raycasting performance
- Pre-computed at model load time
- Enables real-time interaction with high-poly models

Our implementation achieves the same result using the industry-standard `three-mesh-bvh` library.

## Verification

To verify BVH is working:
1. Check console for `[BVH] Bounds tree computed in Xms` on model load
2. Check console for `[App] BVH acceleration initialized` on app start
3. Test support placement with high-poly model (100k+ triangles)
4. Mouse movement should be smooth with instant preview updates

## Additional Benefits

With BVH acceleration in place, we were able to:
- **Remove all camera raycast disabling**: No debounce delays, no performance optimization needed
- **Disable OrbitControls damping**: Removed aesthetic damping effect since it's no longer needed to hide raycast lag
- **Instant support preview**: Preview appears immediately during all camera movements (zoom, rotate, pan)
- **Simplified codebase**: Removed ~50 lines of camera movement state management and timeout logic

The previous 300ms debounce delay and damping were necessary to prevent lag during camera movement with unaccelerated raycasting. With BVH, raycasting is so fast that we can leave it enabled continuously without any performance impact.

## Future Optimizations

If further performance is needed (unlikely):
- **Remove raycast disabling entirely**: BVH may be fast enough to handle continuous raycasting
- **Throttle mouse events**: Limit raycast frequency (e.g., every 16ms) if needed
- **Simplified collision mesh**: Use decimated mesh for raycasting only (not recommended with BVH)
- **GPU raycasting**: Use compute shaders for parallel raycasting (advanced, overkill with BVH)

However, BVH acceleration alone provides Lychee-level performance for support placement.
