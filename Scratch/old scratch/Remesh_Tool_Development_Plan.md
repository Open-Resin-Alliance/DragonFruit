# Remesh Tool (Add Resolution) — Development Plan

## Objective
Create a dedicated **Remesh Tool** that increases local mesh resolution by subdividing triangles in a brushed area.

This tool exists to solve a practical problem in Dragonfruit: many STL models (especially “moderate” resolution ones) do not have enough local triangle density for brush-based surface tools (like smoothing) to feel strong, controllable, and “live”. If a region has very large triangles, smoothing can only move a handful of vertices and the result looks weak or chunky.

The Remesh Tool does not add artistic detail. It only adds **geometric resolution** (more triangles) so subsequent tools can produce better results.

This tool must **not** require converting the entire mesh to an indexed/welded editable representation. It must remain compatible with existing codebase assumptions (triangle-soup geometry in many places).

## Why we’re doing it (and why not full Blender dyntopo)
Blender’s dyntopo is a full sculpting topology system. It continuously edits topology and typically relies on an editable mesh representation and complex operations (refine, collapse, simplify, adaptivity).

Dragonfruit has a different goal: basic, fast, safe pre-support mesh touch-ups. Many parts of the app assume triangle-soup workflows and could break if we introduce a full editable-mesh pipeline.

So for V1 we want the smallest, safest feature that achieves the outcome:
- **Local-only** triangle subdivision where you brush.
- **Strict caps** so it doesn’t stall the UI.
- **Explicit cache/BVH refresh** so other features keep working.

## User-facing behavior (how it should feel)
- The tool is its own mode/tool (like smoothing).
- When you brush, the mesh region under the brush becomes **denser** (smaller triangles).
- You should be able to do multiple passes to keep adding resolution until you reach a target.
- The tool should feel responsive; if safety caps are reached it should simply stop adding triangles for that dab/stroke (no freezing).
- The visual “feedback” is primarily that wireframe density increases; the surface shape should not change significantly just because remesh ran.

## Scope (V1)
- A new tool: **Remesh (Add Resolution)**.
- Operates as a brush in prepare mode.
- Increases triangle density *locally* around the brush.
- Provides settings to control target resolution and safety caps.
- Updates geometry safely:
  - recompute normals
  - recompute bounds
  - refit/rebuild BVH
  - invalidate any topology caches that depend on vertex layout

## Non-goals (V1)
- Global remesh across the full model.
- Decimation / simplification (triangle reduction).
- True Blender dyntopo feature parity (continuous topology operations, edge collapse, adaptive simplify).
- GPU compute.

## Key constraints / invariants
- Must preserve compatibility with existing features that assume:
  - non-indexed geometry (“triangle soup”) is acceptable
  - triangle order and counts may be used by some systems, so changes must be carefully managed
- Must avoid long UI stalls.
- Must not corrupt geometry (no NaN/Infinity positions).
- Must rebuild/refit acceleration structures (BVH) after edits.

## Proposed architecture
Create a new feature folder:
- `src/features/remesh/`
  - `settings.ts` (tool settings, persistence)
  - `remeshEngine.ts` (core remesh ops, BVH integration, safety caps)
  - `remesh.worker.ts` (optional later: heavy subdivision off main thread)
  - `brushController.ts` (hover/stroke state + listeners)
  - `types.ts` (message types if worker is used)

UI integration:
- Add a new `transformMode` entry, e.g. `remesh`.
- Add a toolbar entry + settings panel, similar to smoothing.
- SceneCanvas pointer plumbing similar to smoothing:
  - begin stroke
  - step while dragging (with spacing)
  - end stroke

## Algorithm (V1): Local triangle subdivision by target edge length
Goal: in the brush region, split triangles whose edges exceed a target length.

**Inputs**
- brush center (local)
- brush radius
- target edge length (mm)
- max splits per dab
- max total added triangles per stroke

**High-level steps per dab**
1. Identify candidate triangles intersecting the brush sphere.
   - Prefer BVH shapecast for large radii.
   - Consider spatial hash / coarse bucket tests for small radii (optional).
2. For each candidate triangle:
   - Compute edge lengths.
   - If the longest edge is above the threshold:
     - Split the triangle (e.g. longest-edge split).
3. Apply hard caps:
   - stop after `maxSplitsPerDab`
   - stop if stroke total exceeds `maxAddedTrianglesPerStroke`
4. Update geometry:
   - append new triangle vertex data to position buffer (triangle soup)
   - update normals + bounds
   - rebuild/refit BVH
   - invalidate mesh smoothing topology cache (neighbors/groups/originalToUnique need rebuild)

**Split strategy (simple + robust)**
- Longest-edge split:
  - compute midpoint of longest edge
  - replace 1 triangle with 2 triangles
- (Optional V2) 1→4 split if triangle is very large (split all edges)

## Safety + performance policies
- **Strict caps** are mandatory.
- Use stroke spacing (like smoothing) so we don’t subdivide on tiny mouse jitter.
- Use a low default “max splits per dab” and allow increasing via settings.

Performance expectations:
- Remesh must not introduce multi-second stalls during normal use.
- If a model is too heavy for the chosen settings, the tool should degrade gracefully by hitting caps rather than freezing.

Suggested initial defaults (V1)
- target edge length: 0.5–1.0 mm
- brush radius: 2–5 mm
- max splits per dab: 200
- max added triangles per stroke: 10,000

## Data/cache invalidation
After remesh edits, the following must be refreshed:
- Geometry:
  - `computeVertexNormals`
  - `computeBoundingBox`
  - `computeBoundingSphere`
- BVH:
  - refit if possible, otherwise rebuild
- Any feature caches that depend on vertex count/layout:
  - mesh smoothing topology cache must be invalidated for that geometry

## Tool settings
Create a dedicated Remesh settings object:
- brushSizeMm
- targetEdgeLengthMm (or “resolution”)
- maxSplitsPerDab
- maxAddedTrianglesPerStroke
- strokeSpacingFactor

Persist settings in localStorage, like smoothing.

## UX expectations
- Must feel responsive.
- Prefer progressive refinement while dragging.
- If caps are hit, it should still feel stable (just stops adding triangles).

## Testing / verification checklist
- Functional
  - remesh increases polygons in brushed region
  - does not change mesh outside brush area
  - repeated passes continue to refine until threshold met
- Stability
  - no NaN/Infinity in vertex positions
  - mesh never disappears
  - no console errors
- Integration
  - BVH raycasts still work after remesh
  - smoothing still works after remesh (topology rebuild happens)
  - supports placement still works
- Performance
  - no multi-second stall on first use
  - typical dab time stays within a target budget

## Milestones
1. Add tool skeleton + UI plumbing (mode + settings panel).
2. Implement CPU remesh engine with strict caps.
3. Integrate safe geometry updates + BVH rebuild/refit + cache invalidation.
4. Tune defaults for “moderate meshes” and confirm it feels responsive.
5. (Optional) worker offload if CPU still stalls.

## Notes / open questions
- What should be the user-facing term?
  - “Remesh (Increase Resolution)”
  - “Add Resolution”
  - “Refine”
- Do we want this tool to automatically follow smoothing (e.g. “auto-refine when smoothing”) or keep it strictly separate?
