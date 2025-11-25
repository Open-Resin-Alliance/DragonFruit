# GPU Picking Integration Guide

This guide explains how to integrate the GPU picking system into existing components that currently use R3F pointer events (`onPointerEnter`/`onPointerLeave`) for hover detection.

## Overview

The GPU picking system provides centralized, authoritative "what's under the mouse" detection using color-based picking. Instead of each component doing its own raycasting, a single offscreen render pass determines what's hovered.

**Location:** `src/components/picking/`

## When to Use GPU Picking

Use GPU picking when:
- Multiple overlapping objects need hover detection
- Raycasting is unreliable (thin geometry, transparency, etc.)
- You want consistent hover behavior across the app

## Integration Steps

### 1. Add Imports

```tsx
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';
```

For non-gizmo components, you may need different types:
```tsx
import type { PickableCategory } from '@/components/picking/types';
```

### 2. Add Refs and State

Inside your component, add:

```tsx
// GPU Picking registration
const pickMeshRef = useRef<THREE.Mesh>(null);
const pickIdRef = useRef<number | null>(null);
const { register, unregister, hit } = usePicking();
```

### 3. Define Handle Type

For gizmo handles:
```tsx
const handleType: GizmoHandleType = 'move-x'; // or 'rotate-y', 'scale-z', etc.
```

For other pickable objects (supports, joints, etc.):
```tsx
const category: PickableCategory = 'support'; // or 'joint', 'model', 'raft'
```

### 4. Register with Picking System

Add a `useEffect` to register the pickable mesh:

```tsx
useEffect(() => {
  if (!pickMeshRef.current) return;
  
  pickIdRef.current = register({
    category: 'gizmo',        // or 'support', 'joint', etc.
    objectId: null,           // for supports: the support UUID
    gizmoHandle: handleType,  // only for gizmo category
    object: pickMeshRef.current,
  });
  
  return () => {
    if (pickIdRef.current !== null) {
      unregister(pickIdRef.current);
      pickIdRef.current = null;
    }
  };
}, [register, unregister, handleType]);
```

### 5. Check Hover State from Picking

```tsx
// For gizmo handles:
const isPickingHovered = hit.category === 'gizmo' && 
  'gizmoHandle' in hit && 
  hit.gizmoHandle === handleType;

// For other objects (e.g., supports):
const isPickingHovered = hit.category === 'support' && 
  hit.objectId === myObjectId;
```

### 6. Combine with Prop-Based Hover (Fallback)

```tsx
const effectiveHovered = isPickingHovered || isHovered;
```

Then use `effectiveHovered` instead of `isHovered` throughout the component.

### 7. Update the Pickable Mesh

Add `ref={pickMeshRef}` to the invisible hitbox mesh:

**Before:**
```tsx
<mesh 
  onPointerEnter={onPointerEnter}
  onPointerLeave={onPointerLeave}
>
  <sphereGeometry args={[0.5, 16, 16]} />
  <meshBasicMaterial visible={false} />
</mesh>
```

**After:**
```tsx
<mesh ref={pickMeshRef}>
  <sphereGeometry args={[0.5, 16, 16]} />
  <meshBasicMaterial visible={false} />
</mesh>
```

Remove `onPointerEnter` and `onPointerLeave` - hover is now handled by GPU picking.

**Keep `onPointerDown`** - click/drag still uses R3F events.

### 8. Wrap with PickingProvider

The component must be inside a `<PickingProvider>` for picking to work. Currently this is done in `SceneCanvas.tsx` when `gpuPickingTest={true}`.

## Complete Example

See `src/components/gizmo/rotate/GizmoRotation.tsx` for a complete implementation.

## Gizmo Handle Types

```typescript
type GizmoHandleType =
  | 'move-x' | 'move-y' | 'move-z' | 'move-center'
  | 'rotate-x' | 'rotate-y' | 'rotate-z'
  | 'scale-x' | 'scale-y' | 'scale-z' | 'scale-uniform';
```

## Pickable Categories

```typescript
type PickableCategory = 
  | 'model'    // The main STL model
  | 'support'  // Support structures
  | 'joint'    // Ball joints on supports
  | 'raft'     // Raft geometry
  | 'gizmo'    // Transform gizmo handles
  | 'none';    // Nothing (background)
```

## Testing

1. Set `gpuPickingTest={true}` in `page.tsx` on the `<SceneCanvas>` component
2. The debug overlay in the top-right shows what's under the cursor
3. Verify the correct handle type appears when hovering

## Files Modified for Gizmo Integration

- `src/components/gizmo/move/GizmoMove.tsx` ✅
- `src/components/gizmo/move/GizmoCenter.tsx` ✅
- `src/components/gizmo/rotate/GizmoRotation.tsx` ✅
- `src/components/gizmo/scale/GizmoScale.tsx` ✅

## Next Steps: Support Handles

To integrate GPU picking with support components:

1. `src/supports/components/BallJoint.tsx` - Joint spheres
2. `src/supports/SupportRenderer.tsx` - Support structures
3. Any other pickable support geometry

Follow the same pattern - register the hitbox mesh, check `hit.category === 'support'` and `hit.objectId`, combine with prop-based hover.
