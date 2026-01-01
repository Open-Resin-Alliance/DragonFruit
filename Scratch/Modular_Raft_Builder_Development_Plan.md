# Modular Raft Builder Development Plan

## Overview
We are changing Raft from a single on/off feature into a small “raft builder” where you choose which parts of the raft you want:

- **Bottom**: Off, Solid, or Line
  - **Off** means there is no raft bottom at all.
  - **Solid** means the current solid chamfered base is used.
  - **Line** means the solid base is removed and replaced by a network of line segments connecting trunk roots.
- **Wall**: Off or On
  - When On, the perimeter wall is generated around the outer boundary of the chosen bottom.

The goal is that the UI feels like assembling a raft from parts, and each part only shows the settings that actually matter for that part.

Behavior rules we want:
- Choosing **Line Bottom** automatically disables the solid base and restores “normal” root disks (the root disk becomes the node geometry).
- Choosing **Solid Bottom** uses the existing behavior where root disks become a very thin overlap disk so the solid base is the main bottom surface.
- Only trunk roots participate (the only supports that touch the build plate).
- Line Raft always includes a natural outer ring around the outermost supports.
- Wall is only allowed when Bottom is enabled (Solid or Line). If Bottom is Off, Wall must be Off.
- When Bottom is Line, the Wall is still only generated around the **outer perimeter** (border ring). It must not generate walls along internal line segments.
- When Bottom is Line, the line beams must support a chamfer option (line chamfer), separate from the solid base chamfer.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [ ] **Phase 1: Settings model refactor (foundation)**
  - [x] Replace raft `enabled` with a clear **Bottom Mode** (`off | solid | line`) to avoid conflicts with root disk behavior.
  - [x] Add **Wall Mode** (`off | on`) while preserving the existing wall settings.
  - [x] Add new Line Bottom settings: at minimum **Line Width (mm)**.
  - [x] Add new Line Bottom settings: **Line Chamfer** (angle or size) for the line beams.
  - [x] Define default values that preserve current behavior (default = Solid bottom + Wall on, matching today as closely as possible).
  - [x] Enforce rules:
    - [x] If Bottom = Off, force Wall = Off.
    - [x] If Bottom = Line, Wall generation uses only the outer boundary (no internal walls).

- [ ] **Phase 2: UI updates (raft builder UI)**
  - [x] Update the Raft settings UI to show a Bottom selector (Off / Solid / Line).
  - [x] Update the Raft settings UI to show a Wall selector (Off / On).
  - [ ] Ensure only relevant settings are shown for the selected modes:
    - [x] Solid Bottom: thickness + chamfer (existing).
    - [x] Line Bottom: line width + line chamfer (new).
    - [x] Wall On: wall height + wall thickness + crenel settings (existing).

- [ ] **Phase 3: Rendering & geometry wiring (keep existing behavior working)**
  - [x] Update the existing solid raft renderer to only render when Bottom Mode = Solid.
  - [x] Update root rendering logic:
    - [x] Solid Bottom: root disk becomes thin overlap disk (existing behavior).
    - [x] Line/Off Bottom: root disk uses normal thickness (node geometry).
  - [x] Ensure wall generation is controlled only by Wall Mode (not by Bottom Mode directly).

- [ ] **Phase 4: Line Raft geometry (core feature)**
  - [x] Compute trunk root node points from the root collection (XY positions).
  - [x] Generate interior connectivity using **triangulation** (Delaunay) with pruning rules.
  - [x] Generate a perimeter border ring around the outside footprint.
  - [x] Create beam geometry for each edge and render it at the build plate with explicit Line Height.
  - [x] Implement chamfer for line beams and border ring (top wider, bottom inset) consistent with solid raft semantics.
  - [x] Prevent perimeter duplication (border ring replaces hull-edge beams when present).
  - [x] Ensure bottom-of-chamfer still covers root disks by expanding the footprint used for border/wall.

- [ ] **Phase 4b: Line Raft topology cleanup (clean mesh)**
  - [x] Replace overlapping beam meshes with a single merged mesh using **2D union → extrude**.
  - [ ] Ensure unioned line raft supports holes/islands correctly (Clipper PolyTree traversal + conversion to THREE shapes).
  - [ ] Re-introduce chamfer on the unioned mesh (if needed) while preserving performance.

- [ ] **Phase 5: Export parity**
  - [ ] Ensure the STL/export pipeline includes Line Raft geometry when selected.
  - [ ] Verify Solid vs Line vs Off all export correctly.

- [ ] **Phase 6: Defaults, tuning, and validation**
  - [ ] Choose safe defaults (line width, pruning) so the result looks stable and doesn’t over-connect.
  - [ ] Validate a few scenes with sparse + dense supports.

## Technical Details

### Relevant Files (current)
- `src/supports/Rafts/Crenelated/RaftTypes.ts`
- `src/supports/Rafts/Crenelated/RaftDefaults.ts`
- `src/supports/Rafts/Crenelated/RaftState.ts`
- `src/supports/Rafts/Crenelated/rendering/RaftRenderer.tsx` (solid base rendering)
- `src/supports/Rafts/Crenelated/geometry/generateChamferedBase.ts` (solid base chamfer)
- `src/supports/Rafts/Crenelated/geometry/computeFootprint.ts` (footprint polygon from root circles)
- `src/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer.tsx` (contains a working convex hull implementation)
- `src/supports/SupportPrimitives/Roots/RootsRenderer.tsx` (currently makes root disk thin when raft is enabled)
- `src/supports/Settings/components/RaftSettingsCard.tsx` (current UI)

### Settings structure proposal (conceptual)
- Bottom mode: `off | solid | line`
- Wall mode: `off | on`
- Solid settings: keep existing `thickness`, `chamferAngle`
- Wall settings: keep existing `wallHeight`, `wallThickness`, crenel settings
- Line settings: `lineWidthMm` (minimum)

### Integration notes
- Current root rendering uses `raft.enabled` to force the root disk to `0.05mm` when any raft exists. This must be changed so only **Solid Bottom** triggers the “thin overlap disk” behavior.
- Solid base currently uses the convex footprint of root circles. Line Raft should instead use root centers to build a connectivity graph, and it should always include an outer loop around the outside supports.

### Line Raft algorithm (V1 target)
- Input nodes: trunk root XY positions
- Boundary: convex hull of node points (always included)
- Interior edges: Delaunay triangulation edges (preferred) then prune:
  - Remove duplicates
  - Drop edges longer than a max span (default to be chosen)
  - (Optional) drop crossings if needed
- Geometry: beams with a chamfered cross-section, blended into the root disks at endpoints

### Line Raft topology cleanup (current approach)
- Goal: avoid overlapping internal faces / z-fighting by generating a single clean mesh.
- Approach: build 2D footprints (rectangles for beams + ring for perimeter border), union them in 2D, then extrude once.
- Implementation: `clipper-lib` union + conversion of PolyTree result into THREE shapes.
