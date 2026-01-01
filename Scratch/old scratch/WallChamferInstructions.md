# Implementing Chamfered Raft Walls

This guide details how to modify the Crenelated Raft system so the outer wall slopes inward to match the base chamfer angle, rather than extruding vertically.

## 1. Update `generateCrenelatedWallManual.ts`

**Goal:** Modify the mesh generation logic to accept `chamferAngle` and offset the top vertices inward.

**Location:** `src/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual.ts`

### Step 1.1: Update Function Signature
Add `chamferAngle` to the `settings` object type definition.

```typescript
export function generateCrenelatedWallManual(
  topProfile: FootprintProfile,
  settings: Pick<RaftSettings, 'thickness' | 'wallThickness' | 'wallHeight' | 'crenulationGapWidth' | 'crenulationSpacing' | 'chamferAngle'>
): THREE.Mesh {
```

### Step 1.2: Calculate Top Inset
At the start of the function, calculate how much the top of the wall needs to move inward based on the height and angle.

```typescript
  const wallHeight = Math.max(0, settings.wallHeight);
  // ... existing constants ...

  // Calculate top inset based on chamfer angle
  // Angle is 45..90. 90 = vertical. <90 = slopes inward.
  // tan(angle) = height / inset -> inset = height / tan(angle)
  const angleRad = (Math.max(45, Math.min(90, settings.chamferAngle ?? 90))) * Math.PI / 180;
  // If nearly 90 degrees, offset is 0
  const topInset = Math.abs(angleRad - Math.PI / 2) < 0.001 ? 0 : wallHeight / Math.tan(angleRad);
```

### Step 1.3: Generate Top Profiles
Create inset versions of the outer and inner loops for the top of the wall.

```typescript
  const outer = topProfile;
  const inner = insetConvexPolygon(outer, wallThickness);
  
  // Inset the top loops to create the slope
  // If topInset is 0, topOuter === outer (vertical wall)
  const topOuter = topInset > 0.001 ? insetConvexPolygon(outer, topInset) : outer;
  const topInner = topInset > 0.001 ? insetConvexPolygon(inner, topInset) : inner;
```

### Step 1.4: Update Quad Generation Loop
Inside the main loop iterating over edges (`for (let i = 0; i < n; i++)`), retrieve the top vertices from the new `topOuter` / `topInner` arrays instead of using `outer` / `inner` at `zTop`.

**Retrieve Top Points:**
```typescript
    const topOuterStart = topOuter[i];
    const topOuterEnd = topOuter[next];
    const topInnerStart = topInner[i];
    const topInnerEnd = topInner[next];
```

**Update Curved Segments:**
Replace the `zTop` vectors:
```typescript
    if (!edge.isStraight) {
      // ... base vectors o0, o1 unchanged ...
      
      // OLD: const o2 = new THREE.Vector3(outerEnd.x, outerEnd.y, zTop);
      const o2 = new THREE.Vector3(topOuterEnd.x, topOuterEnd.y, zTop);
      const o3 = new THREE.Vector3(topOuterStart.x, topOuterStart.y, zTop);
      
      // ... base vectors i0, i1 unchanged ...

      // OLD: const i2 = new THREE.Vector3(innerEnd.x, innerEnd.y, zTop);
      const i2 = new THREE.Vector3(topInnerEnd.x, topInnerEnd.y, zTop);
      const i3 = new THREE.Vector3(topInnerStart.x, topInnerStart.y, zTop);

      // ... quad addition calls unchanged ...
    }
```

**Update Straight Segments (Interpolation):**
For the crenelated sections, we must interpolate positions along the top edge just like the bottom edge.

```typescript
      for (const seg of segments) {
        const tStart = seg.start / edge.len;
        const tEnd = seg.end / edge.len;

        // Base interpolation (unchanged)
        const outerS = new THREE.Vector2().lerpVectors(outerStart, outerEnd, tStart);
        const outerE = new THREE.Vector2().lerpVectors(outerStart, outerEnd, tEnd);
        const innerS = new THREE.Vector2().lerpVectors(innerStart, innerEnd, tStart);
        const innerE = new THREE.Vector2().lerpVectors(innerStart, innerEnd, tEnd);

        // Top interpolation (NEW)
        const topOuterS = new THREE.Vector2().lerpVectors(topOuterStart, topOuterEnd, tStart);
        const topOuterE = new THREE.Vector2().lerpVectors(topOuterStart, topOuterEnd, tEnd);
        const topInnerS = new THREE.Vector2().lerpVectors(topInnerStart, topInnerEnd, tStart);
        const topInnerE = new THREE.Vector2().lerpVectors(topInnerStart, topInnerEnd, tEnd);

        // Build vectors
        const o0 = new THREE.Vector3(outerS.x, outerS.y, zBase);
        const o1 = new THREE.Vector3(outerE.x, outerE.y, zBase);
        // Use interpolated top points
        const o2 = new THREE.Vector3(topOuterE.x, topOuterE.y, zTop);
        const o3 = new THREE.Vector3(topOuterS.x, topOuterS.y, zTop);
        
        const i0 = new THREE.Vector3(innerS.x, innerS.y, zBase);
        const i1 = new THREE.Vector3(innerE.x, innerE.y, zBase);
        const i2 = new THREE.Vector3(topInnerE.x, topInnerE.y, zTop);
        const i3 = new THREE.Vector3(topInnerS.x, topInnerS.y, zTop);

        // Add quads...
      }
```

**Update Gap Side Faces:**
Do the same interpolation logic for the `gaps` loop to close the mesh sides correctly.

```typescript
      for (const gap of gaps) {
        const tStart = gap.start / edge.len;
        const tEnd = gap.end / edge.len;
        
        // ... interpolate outerS/E, innerS/E, topOuterS/E, topInnerS/E ...

        // Left side face (start of gap)
        const leftOuter0 = new THREE.Vector3(outerS.x, outerS.y, zBase);
        const leftOuter1 = new THREE.Vector3(topOuterS.x, topOuterS.y, zTop); // Use topOuterS
        const leftInner0 = new THREE.Vector3(innerS.x, innerS.y, zBase);
        const leftInner1 = new THREE.Vector3(topInnerS.x, topInnerS.y, zTop); // Use topInnerS
        addQuad(leftOuter0, leftInner0, leftInner1, leftOuter1, false);

        // Right side face (end of gap)
        const rightOuter0 = new THREE.Vector3(outerE.x, outerE.y, zBase);
        const rightOuter1 = new THREE.Vector3(topOuterE.x, topOuterE.y, zTop); // Use topOuterE
        const rightInner0 = new THREE.Vector3(innerE.x, innerE.y, zBase);
        const rightInner1 = new THREE.Vector3(topInnerE.x, topInnerE.y, zTop); // Use topInnerE
        addQuad(rightOuter0, rightOuter1, rightInner1, rightInner0, false);
      }
```

---

## 2. Update `RaftRenderer.tsx`

**Goal:** Pass the `chamferAngle` setting to the generator function.

**Location:** `src/supports/Rafts/Crenelated/rendering/RaftRenderer.tsx`

Look for the call to `generateCrenelatedWallManual` inside `useMemo`.

```typescript
    const wallMesh = useCrenels
      ? generateCrenelatedWallManual(profile, {
          wallHeight: raft.wallHeight,
          wallThickness: raft.wallThickness,
          crenulationGapWidth: raft.crenulationGapWidth,
          crenulationSpacing: raft.crenulationSpacing,
          thickness: raft.thickness,
          chamferAngle: raft.chamferAngle, // <--- ADD THIS LINE
        })
      : generatePerimeterWall(profile, { ... });
```

Also update the dependency array of `useMemo`:
```typescript
  }, [supportState, raft.enabled, raft.thickness, raft.chamferAngle, raft.wallHeight, raft.wallThickness, raft.crenulationGapWidth, raft.crenulationSpacing]);
```

---

## Summary of Behavior
- **Vertical Wall (90°)**: `topInset` becomes 0. `topOuter` === `outer`. Behavior is identical to before.
- **Chamfered Wall (<90°)**: `topInset` is positive. The top edge of the wall shrinks inward, creating a "pyramid" slope that matches the `chamferAngle`.
- The straight segments and gaps will linearly interpolate between the wide base and the narrow top, maintaining the wall integrity and manifold status.
