# Dragonfruit Support System V2 - Architecture & Handoff Guide

## 📐 Code Organization & Structure Guide

To maintain scalability and clarity, this project follows a **Domain-Driven** folder structure rather than a type-based one (e.g., avoiding generic `hooks/` or `components/` folders at the top level of the feature).

### Core Principles

1.  **Domain Grouping**: Group files by **Feature** (e.g., `Joint/`, `Trunk/`), not by file type.
    *   *Good*: `src/supports/Joint/useJointCreation.ts`
    *   *Bad*: `src/supports/hooks/useJointCreation.ts`
2.  **Separation of Concerns**:
    *   **`types.ts`**: Pure interface definitions. No logic.
    *   **`state.ts`**: Global store and mutation logic. No UI.
    *   **`interaction/`**: Universal logic reusable across multiple features (e.g., Snapping, Highlighting, Picking).
    *   **Feature Folders** (`Joint/`, `Trunk/`): Contain EVERYTHING related to that feature:
        *   **Renderers** (`TrunkRenderer.tsx`)
        *   **Logic/Hooks** (`useTrunkPlacement.ts`)
        *   **Sub-components** (`TrunkPlacementPreview.tsx`)
3.  **Logic Flow**:
    *   **Page (`page.tsx`)**: Handles global inputs (Hotkeys) and high-level mode switching.
    *   **Orchestrator (`SupportRenderer.tsx`)**: Connects Global State to Feature Renderers.
    *   **Manager/Hook**: Handles the specific interactivity.

### Folder Layout

```
src/supports/
├── types.ts                    # 1. Definitions (Single source of truth)
├── state.ts                    # 2. Data Store (Zustand/ExternalStore)
├── constants.ts                # 3. Derived constants (joint sizing math)
├── SupportRenderer.tsx         # 4. Root Component (Orchestrator)
│
├── Rafts/                      # 4b. Raft domain (bottom modes + perimeter wall)
│   └── Crenelated/             # Primary raft implementation
│       ├── RaftTypes.ts        # Raft settings + geometry types
│       ├── RaftDefaults.ts     # Default raft settings
│       ├── RaftState.ts        # Raft store + invariants (e.g. wall off when bottom off)
│       ├── rendering/          # R3F renderers for raft meshes
│       └── geometry/           # Footprint + mesh generators (base/wall/line raft)
│
├── SupportPrimitives/          # 5. Primitive Parts (building blocks)
│   ├── Roots/                  # Base footprint element
│   │   └── RootsRenderer.tsx
│   ├── Shaft/                  # Cylindrical segment
│   │   └── ShaftRenderer.tsx
│   ├── Knot/                   # Sliding attachment point along a shaft
│   │   ├── KnotRenderer.tsx
│   │   ├── KnotGizmo.tsx
│   │   ├── useKnotInteraction.ts
│   │   └── knotUtils.ts
│   ├── Joint/                  # Spherical articulation + gizmo + creation
│   │   ├── JointRenderer.tsx
│   │   ├── JointGizmo.tsx
│   │   ├── useJointCreation.ts
│   │   └── ...
│   └── ContactCone/            # Terminal contact piece
│       ├── types.ts
│       ├── contactConeUtils.ts
│       ├── ContactConeRenderer.tsx
│       └── index.ts
│
├── SupportTypes/               # 6. Support Type Definitions
│   ├── Trunk/                  # Vertical column from plate
│   │   ├── TrunkRenderer.tsx
│   │   ├── trunkBuilder.ts     # Defines: roots + shafts + joints + cone
│   │   └── useTrunkPlacement.ts
│   │   └── TrunkReplacement/   # Planner + execution for trunk promotion/replacement
│   ├── Branch/                 # Column from knot on parent
│   │   └── BranchRenderer.tsx
│   ├── Twig/                   # (Future) Both ends touch model
│   ├── Stick/                  # (Future) Vertical, no roots
│   └── Brace/                  # Horizontal stabilizer
│
├── rendering/                  # 7. Unified Rendering System
│   ├── SupportBuilder.tsx      # Generic renderer (preview + placement)
│   └── index.ts
│
├── PlacementLogic/             # 7b. Shared placement solvers + policies
│   ├── StandardPlacement.ts    # Primary trunk placement + angle checks
│   ├── SmartPlacement.ts       # Collision-aware trunk placement
│   ├── ConeAxisPolicy.ts       # Cone axis policy (Normal/Locked/Adaptive)
│   └── Grid/                   # Grid placement + merging logic (self-contained)
│       ├── gridPlacement.ts    # decideGridPlacement (authoritative)
│       ├── gridMath.ts         # grid key math
│       └── types.ts
│
├── Settings/                   # 8. User Settings
│   ├── defaults.ts
│   ├── types.ts
│   ├── state.ts
│   ├── presets.ts
│   ├── SupportSidebar.tsx
│   └── components/
│
└── interaction/                # 9. Universal Logic
    ├── SnappingManager.ts
    ├── useSnapping.ts
    ├── useHighlight.ts
    ├── useInteractionStatus.ts
    └── SupportSelection.ts     # Centralized selection logic
```

### Key Organizational Principle

**Two main groupings:**
- **`SupportPrimitives/`** — The building blocks (Roots, Shaft, Joint, ContactCone)
- **`SupportTypes/`** — Support types that combine primitives (Trunk, Branch, Twig, Stick, Brace)

**Support Type Definitions:**
| Type | Made Of |
|------|---------|
| Trunk | Roots + Shafts + Joints + ContactCone |
| Branch | Knot + Shafts + Joints + ContactCone |
| Twig | ContactCone + Shaft + ContactCone (both ends touch model) |
| Stick | Shafts + Joints + ContactCone (no roots, vertical) |
| Brace | Knot + Shaft + Knot (horizontal stabilizer; two knots, one on each host) |
| Support Brace | Root + Shafts/Joints + Host Knot (rooted auxiliary support attached to trunk/branch shaft) |

Each support type has a `*Builder.ts` that defines what primitives it uses. The `SupportBuilder.tsx` renders any combination.

---

## Grid Trunk Promotion / Trunk Replacement (V2)

When Grid mode is enabled, placement at an existing node can result in **trunk replacement**:

Grid toggle behavior:

- Grid enable/disable is treated as a **global toggle**.
- Switching presets does not override `grid.enabled`; it is preserved across preset changes.

- The authoritative decision point is `src/supports/PlacementLogic/Grid/gridPlacement.ts` (`decideGridPlacement`).
- If a new candidate contact is higher than the existing trunk contact at that node, `decideGridPlacement` returns `kind: 'replace_trunk'`.
- The placement commit path lives in `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts`.

### TrunkReplacement Module

Reusable trunk-domain logic lives under:

- `src/supports/SupportTypes/Trunk/TrunkReplacement/`
  - `planTrunkReplacement.ts` (pure planner)
  - `applyTrunkReplacement.ts` (executes plan via `src/supports/state.ts`)

Key behaviors:

- Replacement rehosts dependents onto the new trunk **before** removing the old trunk to avoid cascade-delete side effects.
- Undo/Redo is modeled as a **single history action** storing full before/after state snapshots.

Trunk deletion behavior:

- Deleting a trunk attempts a trunk replacement in `mode: 'delete_trunk_promote_next_highest'`.
- The promoted candidate is the **highest-contact direct child branch**.
- In delete mode, the old trunk contact is **not** preserved as a branch.

### Stepwise Trunk Diameter Profile (Adaptive Trunk)

Trunks now support an **adaptive stepwise diameter profile** driven only by **branch demand** (and trunk contact tip demand):

- Step boundaries are defined by the **trunk-hosted branch knot** height (the knot position on the trunk), not the branch tip contact.
- Trunk demand sources:
  - Branches attached to trunk-hosted knots (shaft diameter demand)
  - Trunk contact demand (tip/body/contact cone demand)
- Joints at step transitions are sized based on the **larger adjacent shaft** (i.e. the thicker side).

**Authoritative implementation:**
- `src/supports/SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter.ts`
  - `computeAndApplyTrunkDiameterProfile(...)`

**Integration points:**
- Grid placement host update:
  - `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts`
- Trunk replacement / trunk deletion promote flow:
  - `src/supports/SupportTypes/Trunk/TrunkReplacement/applyTrunkReplacement.ts`
  - When promoting a branch to a trunk:
    - The trunk baseline shaft diameter inherits the promoted branch diameter.
    - The trunk contact cone preserves the promoted branch cone profile.
    - The trunk socket joint is re-positioned after cone profile swap so the shaft remains linked to the cone.

**Baseline diameter stability (critical):**
- Trunks store `baseDiameterMm` at creation/promotion so the adaptive profile does not depend on the currently active preset.
- This prevents cases where placing a thin trunk first and switching to a thicker preset later would incorrectly thicken the trunk all the way to the tip.

**Branch deletion:**
- Deleting a branch recomputes the affected trunk’s profile so the trunk can shrink down to the next-largest remaining demand.
- This is wired from:
  - `src/features/supports/useSupportInteractionManager.ts`

**Undo/Redo notes:**
- Branch delete history payload includes optional trunk/knot updates so profile changes remain undo-safe:
  - `src/supports/history/actionTypes.ts` (`SupportBranchRemovePayload`)
  - `src/supports/history/useSupportHistoryHandlers.ts`

---

## Support Brace: History + Cascade Delete + Raft Sync (V2)

Authoritative files:

- `src/supports/SupportTypes/SupportBrace/`
- `src/supports/history/actionTypes.ts`
- `src/supports/history/useSupportHistoryHandlers.ts`
- `src/supports/state.ts`
- `src/supports/SupportRenderer.tsx`

Current contract:

1. **Placement history parity**
   - Support Brace placement pushes a dedicated history action (`support:add-support-brace`).
   - Undo/redo removes/restores Support Brace + root + host knot atomically.

2. **Recursive host delete behavior**
   - If a host support (trunk/branch path) is deleted, attached Support Braces are deleted recursively.
   - Removal snapshots include Support Brace build payloads so undo can restore dependents in the same action.

3. **Raft synchronization rule (critical)**
   - Raft footprint derives from global `supportState.roots`.
   - Any Support Brace root no longer referenced by an active trunk or active Support Brace must be pruned from global roots to prevent persistent raft islands.
   - `SupportRenderer` performs this orphan-root pruning as part of the Support Brace root/knot backfill effect.

4. **Interaction parity with core support hosts**
   - Support Brace segment IDs are now valid host IDs for knot drag and manual brace snapping paths.
   - Knot interaction resolves Support Brace segment endpoints using Support Brace root top + segment joints + host knot fallback.
   - Brace placement target collection includes Support Brace segments so braces can be authored/edited against Support Brace shafts directly.

---

## 🎯 Current Status: TRUNK STRUCTURE & JOINT GIZMO COMPLETE

**Build Status**: ✅ **Fixed**  
**Visual Test**: ✅ **Verified** (Supports render, highlight, and select)  
**Interaction**: ✅ **GPU Picking & Snapping Working** (Joint creation via 'J' key functional)  
**Gizmo**: ✅ **Joint Gizmo Working** (Select joint, drag to move)

---

## Contact Disk Length Override (Joint Editing Contract)

When editing supports via the Joint Gizmo, the contact disk thickness must remain a stable geometric result and must not be influenced by camera movement or transient collision solver instability.

Current contract:

- While dragging a joint, OrbitControls are disabled to prevent camera motion from affecting drag math.
- Joint editing does not persist collision-based `diskLengthOverride` values. Disk thickness is treated as angle-based during joint edits to prevent unintended snap-to-extended tip geometry from being baked into exports.

---

## 📋 What's Been Completed

### ✅ Phase 1: Data Layer (DONE)
**Location**: `src/supports/`
*... (No changes)*

---

## LYS Import System (Native)

**Location**: `src/components/lys-import/`

### Goal
Import Lychee Slicer (`.lys`) scenes directly without external Python dependencies, preserving exact positioning and orientation.

### Core Components
1. **`LysParser.ts`**:
   - Parses the binary LYS format.
   - Decrypts `scene.bin` using a hardcoded key (`DEFAULT_APP_ID`).
   - Extracts geometry (largest `.bin` file).
   - **Crucial**: Converts geometry to **Non-Indexed** (`toNonIndexed()`) to ensure **Flat Shading** (sharp edges), matching STL behavior and avoiding smoothing artifacts.

2. **`useLysImport.ts`**:
   - React hook that manages file parsing, support reconstruction handoff, and model transform extraction.
   - **Canonical model lift solve** for LYS import now happens here:
     - Build local transform as `rotationScale * centerOffset(-geometryCenter)`.
     - Compute transformed lowest point using `computeLowestZ(...)` (vertex-accurate, not rotated AABB).
     - Solve model group Z as `finalModelZ = lycheeLiftZ - transformedMinZ`.
   - Applies matching support Z offset so support geometry remains vertically aligned with the solved model placement.

3. **`useSceneCollectionManager.ts` (Integration)**:
   - Consumes import-provided transform directly for LYS models (no second Z re-solve in scene layer).
   - This keeps model lift deterministic and avoids model/support desync from duplicate placement calculations.

### LYS Support Reconstruction Contract (Current)

Authoritative implementation lives in:
- `src/components/lys-import/LysConverter.ts`

Current behavioral contract:

1. **Ownership routing (multi-object safe)**
   - Support owner resolution priority:
     1) `objectIdTip` if valid,
     2) `objectIdBase` if valid,
     3) fallback object (`o15`, then first with `supportsBase`, else first object).
   - Mixed valid ownership (`objectIdTip !== objectIdBase`) uses `objectIdTip` and logs warning.

2. **Transform staging**
   - Stage A (reconstruction): apply object scale + rotation + `position.z` to support points.
   - Stage B (placement): after reconstruction, apply only object `position.x/y` to generated entities.
   - Model lift parity rule: after transform staging, model placement uses transformed-geometry lowest point (vertex-based) to honor Lychee lift exactly.

3. **Root/base transform special case**
   - Root base uses floor policy and explicit XY handling.
   - Base XY receives scale but not object rotation for root floor anchoring.

4. **Tip normal handling**
   - `tipNormal` is transformed with inverse scale + object rotation, then normalized.
   - Tip cone/socket solver prefers this transformed Lychee normal when available.

5. **Knee vs socket solve split (critical parity behavior)**
   - Visible knee joint height source priority:
     - `settings.base.joinLength` -> `settings.base.newJoinLength` -> root-cap fallback.
   - Socket solve anchor height source priority:
     - `settings.base.newJoinLength` -> `settings.base.joinLength` -> root-cap fallback.
   - This split is required to match current Lychee side-view trunk geometry.

6. **Tip cone/socket solve policy**
   - Tip cone joint (socket) is solved from fixed tip length and cone axis.
   - With Lychee normal present, solver evaluates both `+n` and `-n` and chooses the socket candidate closer to the shaft start anchor.
   - Root/branch import paths use strict Lychee coordinate mode (no raycast-based tip re-snapping for parity path).

7. **Load-time knot normalization safeguard (brace endpoints)**
   - During `loadFromLychee`, host-knot reprojection is normally used to keep knots aligned to shaft geometry.
   - For brace host knots, if reprojection clamps to an endpoint (`t≈0` or `t≈1`) with a large move (>2mm), authored knot position is preserved to avoid pathological brace clustering in edge-case scenes.
   - Host-derived diameter updates are still applied.
   - Trunk host endpoint reconstruction used by normalization now derives root top from imported root geometry (`root.diskHeight` + `root.coneHeight`) rather than live global root settings, preventing import-time knot drift when current presets differ.

8. **Support Brace source classification + host graph integration**
   - Grounded single-parent supports with explicit parent endpoint hints are classified as Support Brace candidates for Lychee `type:1` and `type:0` variants.
   - Imported Support Braces are registered into the host projection graph so later regular braces can resolve to Support Brace segments.

9. **Support Brace shape parity policy (Lychee join-length driven)**
   - Support Brace import computes host attach using join-length-biased probing and applies layout overrides derived from Lychee join-length semantics for closer top-angle parity.

10. **Brace diameter parity policy**
   - Imported brace body diameter priority: `settings.tip.diameter` -> `settings.baseTip.diameter` -> `settings.base.joinDiameter` -> fallback.
   - Brace rendering is uniform-diameter from `brace.profile.diameter` (no endpoint host taper) for one-to-one Lychee parity when authored diameter is constant.

11. **Explicit single-parent branch hint side-order safeguard**
   - For branch candidates with explicit parent hints, importer validates knot/tip vertical side ordering against source Lychee endpoint ordering (`tip.z - base.z`).
   - If projected host placement would invert that ordering, importer preserves authored attach endpoint for the knot position.
   - This prevents upside-down/misplaced branch origins in common explicit-hint scenes while keeping branch tips sourced from Lychee tip payloads.

---

## Mesh Smoothing (STL)

Mesh smoothing is implemented as a dedicated feature domain under:

- `src/features/mesh-smoothing/`

### Goals

- Keep interaction smooth while dragging.
- Defer heavy geometry work until stroke end.
- Provide a gap-free, Photoshop/Blender-like visual preview while painting.
- Prevent transparency stacking in the preview (overlaps must not darken).

### Authoritative Entry Points

- Pointer interactions are driven from:
  - `src/components/scene/SceneCanvas/StlMesh.tsx`
- Global scene bindings (e.g. pointer-up finalize, wheel-to-resize) live in:
  - `src/features/mesh-smoothing/SceneMeshSmoothingBindings.tsx`

### Brush State + Preview Buffers

- Brush state is an external store in:
  - `src/features/mesh-smoothing/brushController.ts`
- During a stroke we record *samples* (point + normal) into fixed-capacity typed arrays.
- Large cursor jumps are filled by inserting intermediate samples so the preview remains continuous.

### GPU Preview Overlay (During Stroke)

- Rendered by:
  - `src/features/mesh-smoothing/MeshSmoothingBrushCursor.tsx`
- Preview is drawn as an **instanced stamp** marker (a union of brush-sized circles), aligned to the surface normal per sample.
- A dedicated **stencil bit** is used so each pixel shades at most once per frame (no opacity stacking), even when stamps overlap.
- The WebGL canvas must enable stencil:
  - `src/components/scene/SceneCanvas/SceneCanvas.tsx` (`gl={{ stencil: true }}`)

### Geometry Smoothing (On Stroke End)

- Engine + worker orchestration:
  - `src/features/mesh-smoothing/meshSmoothingEngine.ts`
  - `src/features/mesh-smoothing/meshSmoothing.worker.ts`
- Heavy topology prep is cached per geometry and is a primary source of first-use cost:
  - `src/features/mesh-smoothing/topologyCache.ts`

---

### ✅ Phase 2: Rendering (DONE)
**Location**: `src/supports/` (domain folders)

1.  **`Roots/RootsRenderer.tsx`**: Renders the base/footprint element.
    *   **Structure**: Bottom disk (0.5mm) → Truncated cone → Spherical top
    *   **Sphere**: Trunk shaft embeds into this (same as joints)

2.  **`Trunk/TrunkRenderer.tsx`**: Renders trunk supports.
    *   **Uses**: `RootsRenderer`, `ShaftRenderer`, `JointRenderer`
    *   **Default Structure**: 2 segments with 1 joint between them
    *   **First Segment**: Always vertical (from Roots sphere to joint)
    *   **Second Segment**: Angles to reach contact point

3.  **`Shaft/ShaftRenderer.tsx`**: Renders cylindrical segments between joints.

4.  **`Joint/JointRenderer.tsx`**: Renders spherical joints with GPU picking support.

### ✅ Phase 2b: Anatomy Preview System (DONE)
**Location**: `src/supports/Settings/AnatomyPreview/`

A high-fidelity mini-viewport embedded in the settings sidebar to visualize support parameters in real-time.

1.  **`SupportAnatomyPreviewCanvas.tsx`**: The main R3F canvas.
    *   **Isolated Scene**: Renders a dummy support (not part of main scene).
    *   **Smart Camera**: Implements focus-driven camera movement (`AnatomyPreviewCameraLogic.ts`) to focus on the active setting key.
        *   Camera presets are defined per preview kind under `Settings/AnatomyPreview/PreviewTypes/*/camera.ts`.
        *   The canvas calls `getTargetFocusState(kind, key)` and uses `key = null` as the kind-aware "home" focus state.
    *   **Highlight System**: Uses `AnatomyPreviewConfig.ts` to define colors (Pink Focus, Grey Context). Maps active setting keys to specific anatomy parts (Disk vs Cone vs Shaft).

#### Raft Settings Preview (Focus-Driven)

The Raft tab uses the same Anatomy Preview viewport, but renders a dedicated raft model and uses focus keys from the settings inputs to drive both camera poses and coloring.

Key pieces:

- **Focus Key Store**: `src/supports/Settings/AnatomyPreview/previewState.ts`
  - `activeSettingKey` is set/cleared on input focus/blur.
- **Focus Key Wiring (Raft Inputs)**: `src/supports/Settings/components/RaftSettingsCard.tsx`
  - Raft fields set focus keys such as:
    - `raft.thickness`
    - `raft.chamferAngle`
    - `raft.wallHeight`
    - `raft.wallThickness`
    - `raft.crenulationGapWidth`
    - `raft.lineWidthMm`
    - `raft.lineHeightMm`
    - `raft.lineChamferAngle`
- **Camera Focus Map**: `src/supports/Settings/AnatomyPreview/AnatomyPreviewCameraLogic.ts`
  - Dispatcher that routes to per-kind camera preset maps.
  - Raft and Trunk presets live under:
    - `src/supports/Settings/AnatomyPreview/PreviewTypes/Raft/camera.ts`
    - `src/supports/Settings/AnatomyPreview/PreviewTypes/Trunk/camera.ts`
  - Each focus key maps to a camera pose (position/target/zoom).
  - Home/Reset behavior uses `getTargetFocusState(kind, null)` so values are not duplicated in multiple places.
- **Raft Preview Rendering + Highlighting**: `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewCanvas.tsx`
  - Raft geometry is generated from the raft pipeline (base + wall) for the preview.
  - Raft preview recolors use `ANATOMY_CONFIG.colors`.

---

## Line Raft (Clean Topology) Notes

Line raft geometry is generated from trunk root XY positions using Delaunay triangulation + pruning.

Key implementation detail:

- The **interior line network** is generated as a single mesh using **2D polygon union + extrude** (fast + avoids overlapping faces).
  - Implementation: `src/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh.ts`
  - Uses `clipper-lib` for union and robust PolyTree parsing.
- The **perimeter border** is a dedicated single manifold ring mesh with chamfer:
  - `src/supports/Rafts/Crenelated/geometry/generatePerimeterBorderBeam.ts`
- Current visual decision: interior union mesh is **flat**; chamfer is applied only to the perimeter border ring.

---

## Export Pipeline (Raft)

STL export is coordinated by:

- `src/features/export/logic/ExportManager.ts`

Export includes raft geometry when `includeRaft` is enabled:

- Solid bottom exports the chamfered base + optional wall.
- Line bottom exports:
  - unioned interior line network
  - chamfered perimeter border ring
  - optional wall whose thickness uses Line Height in line mode

---

## Sidebar Settings Save/Restore (LocalStorage)

The Support sidebar (`src/supports/Settings/SupportSidebar.tsx`) currently provides a simple Save/Restore mechanism:

- **Save** persists support settings via `src/supports/Settings/state.ts` and raft settings under a separate localStorage key.
- **Restore Defaults** clears those localStorage keys and resets stores to built-in defaults.
- The Save/Restore controls are implemented as a pinned footer so content scrolls above them.
  - Focus highlighting rules:
    - Thickness/Chamfer: base highlighted, wall dimmed.
    - Wall Height/Wall Thickness/Gap Width: wall highlighted, base dimmed.
  - Preview tuner supports camera tuning without camera snapback while orbiting.

## Support Presets System (V2) - v109

The Support Presets system has been overhauled to support persistence, customization, and advanced UX flows.

### Storage & Persistence
- **Storage**: Presets are saved to `localStorage` under `support-presets-v1`.
- **Loading Strategy**: On load, stored presets are merged with built-in defaults.
  - Stored values take precedence for settings/names.
  - Built-in IDs (`detail`, `structure`, `anchor`) are preserved.
  - New built-in defaults are adopted if no storage exists for them.

### Drift Detection (Smart Deselection)
- **Logic**: When settings change, `checkPresetDrift(currentSettings)` runs.
- **Comparison**: Deep compares essential fields against the active preset.
- **Exclusions**: Specifically IGNORES fields that should be independent of presets:
  - `grid` (Spacing, Enabled)
  - `tip.coneAngle*` (Normal/Locked/Adaptive)
  - `raft` (Managed separately)
- **Result**: If a mismatch is found in a non-excluded field, the active preset is set to `null` (deselected).

### Save Workflow
- **Exclusions**: Saving a preset reads current values BUT explicitly restores the *preset's original values* for excluded fields (Grid/ConeAngle) to ensure they don't pollute the preset.
- **Confirmation**: A strictly local UI state in `PresetSelector` intercepts the save action to show an overlay.


2.  **`AnatomyPreviewConfig.ts`**: Centralized configuration.
    *   **Colors**: Define Highlight/Dim/Normal colors.
    *   **Camera**: FOV, Initial Position, Zoom limits.
    *   **Tuner**: Toggle `showPreviewTuner` to show a live debug overlay for tweaking camera/lighting.

3.  **Reactivity**:
    *   Uses `useSyncExternalStore` to listen to global settings.
    *   Updates immediately on keystroke/slider change.
    *   Smoothly animates camera transitions using a physics-based lerp loop.

### ✅ Phase 3: Interaction & Snapping (DONE)
**Location**: `src/supports/interaction/` & `src/supports/Joint/`

1.  **`SnappingManager.ts`**: "Universal Logic" state machine.
    *   Implements `Idle` -> `Seeking` -> `Locked` states.
    *   **Hybrid Snapping**: Prioritizes GPU Picking (visual hit) but falls back to **3D Ray Snapping** (spatial proximity) if visual hit ID is unresolved (e.g., picking "trunk" but needing "segment").
    *   Uses composite IDs (`trunkId:segmentId`) for precise sub-object targeting.

### Universal Snapping System (Required for New Support Types)

Any placement workflow that attaches to existing supports (Knots, Braces, future tools) must use the shared snapping pipeline.
This prevents fragmented “one-off snapping” logic and ensures consistent behavior across support types.

**Authoritative components:**
- `src/supports/interaction/SnappingManager.ts`
  - The snapping state machine (GPU pick + spatial fallback + hysteresis).
- `src/supports/interaction/useSnapping.ts`
  - The R3F hook that feeds camera/pointer + picking into the manager.

**Rule: Never custom-snap in a new support type**
- New placement controllers should not implement their own ray/segment distance snapping.
- Instead:
  - Generate `SnapTarget[]` for all candidate shafts.
  - Provide `getTarget(id)` and `getPotentialTargets()` to `useSnapping`.
  - Require `snapResult.state === 'locked'` before committing a support.

**Knot-based supports (Branch / Leaf / Brace) requirements**
When a placement creates a Knot, it must persist the data needed for “stay attached when the shaft changes” behavior:
- `parentShaftId`
- `t` (0..1 along the snapped segment)
- `pos` (world position at that `t`)

This is what allows global recomputation when geometry changes (joint delete/merge, bezier toggles, shaft edits).

**Implementation checklist for a new support type (example: Brace)**
1. Create a Canvas-level placement controller that uses `useSnapping`.
2. Snap each brace endpoint to a shaft using `SnapTarget` paths.
3. Only allow placement/commit when both endpoints are `locked` (each has a valid `t`).
4. Store Knots using the knot contract (`parentShaftId`, `t`, `pos`).
5. Route any shaft edits through the authoritative state mutation paths so knots get recomputed.

2.  **`useJointCreation.ts`**: Hook driving the joint creation workflow.
    *   **Global State**: Consumes `jointCreationStore` (driven by `page.tsx` hotkeys) to toggle active state.
    *   **Target Generation**: Iterates trunk segments to build accurate `SnapTarget` geometry (reconstructing paths from data).
    *   **Loop**: Runs `useFrame` to constantly update snapping via `SnappingManager`.
    *   **Action**: Splits shaft segments on click to insert new joints.

3.  **`useHighlight.ts`**: Universal visual state hook.
    *   Decouples interaction logic from renderers.
    *   Manages GPU picking registration and determines visual state (color/emissive) based on hover/selection/suppression props.

4.  **`PickingProvider` Integration**:
    *   **CRITICAL FIX**: The SceneCanvas implementation now *always* renders `PickingProvider`, ensuring `usePicking` context is available even when debug mode is off. `gpuPickingTest` now only toggles the debug overlay.
        *   **Implementation**: `src/components/scene/SceneCanvas/SceneCanvas.tsx`
        *   **Public entry point**: `src/components/scene/SceneCanvas.tsx` (re-export)

    *   **SceneCanvas internal layout** (kept small and self-contained):
        *   `src/components/scene/SceneCanvas/SceneCanvas.tsx` (main viewport orchestrator)
        *   `src/components/scene/SceneCanvas/SceneEnvironment.tsx` (lights/helpers/camera utilities)
        *   `src/components/scene/SceneCanvas/SceneSelectionAndPicking.tsx` (picking + selection wrappers)
        *   `src/components/scene/SceneCanvas/StlMesh.tsx` (interactive STL mesh)

5.  **STL Load Camera Intro (Viewport UX)**:
    *   **Location**: `src/components/scene/camera/useStlLoadCameraIntro.ts` + `src/components/scene/camera/CameraIntroController.tsx` (wired from `src/components/scene/SceneCanvas/SceneCanvas.tsx`)
    *   **Behavior**:
        *   On the first model load (0 models → 1 model), the camera performs a smooth (~1s) intro movement.
        *   The final camera position is computed from scene bounds so the full model fits in view, regardless of model size.
        *   The camera target is set to the model center (bounds center) so OrbitControls rotates around the loaded model (not world origin).

6.  **Camera Focus Hotkey (F Refocus)**:
    *   **Hotkey wiring**: `src/hotkeys/useCameraFocusHotkey.ts` (key binding in `src/hotkeys/hotkeyConfig.ts`)
    *   **Camera logic**: `src/components/scene/camera/CameraFocusHotkeyController.tsx`
    *   **Behavior**:
        *   Pressing `F` refocuses the OrbitControls target to the current mouse hover point on the STL mesh.
        *   If the mouse is not over the STL mesh, the hotkey does nothing.

7.  **Viewport Lighting (Camera Headlight Fill)**:
    *   **Goal**: Lychee-like “front fill” highlights while preserving overhead shadows.
    *   **Implementation**: `src/components/scene/SceneCanvas/SceneEnvironment.tsx`
        *   Headlight is a camera-following point light.
        *   Uses **no distance falloff** (`decay=0`) so it remains effective at any zoom.
    *   **Default intensity**: `1.0` (wired from `src/components/scene/SceneCanvas/SceneCanvas.tsx`, via `headlightIntensity ?? 1.0`)

### ✅ Phase 4: Refactoring & Interaction Polish (DONE)
**Location**: `src/features/` and `src/supports/interaction/`

1.  **Domain Feature Hooks (`src/features/`)**:
    *   `page.tsx` has been refactored to delegate logic to specific hooks:
    *   `useSceneManager`: Scene settings, lighting, file loading.
    *   `useSlicingManager`: Layer height, slider state.
    *   `useTransformManager`: Transform controls, auto-lift logic.
    *   `useIslandManager`: Island scanning and overlay.
    *   `useSupportInteractionManager`: Orchestrates support placement and interaction status.

2.  **Interaction Modes**:
    *   **Prepare Mode**: Only Model is selectable (via Gizmo). Supports are **non-interactable** (no click, no hover).
    *   **Support Mode**: Supports are selectable. Model click places support. Background click deselects.
    *   **Prepare Mode Controls**: `TransformToolbar` (in `src/components/controls/TransformToolbar.tsx`) provides the explicit **Select** / **Transform** toggle that rides above the canvas. When `transformMode === 'transform'`, the detailed panel in `TransformControls.tsx` becomes visible for numeric translation/rotation/scale input. These controls live in the page layout but depend on `useTransformManager` for state.

3.  **Joint Interaction Rules**:
    *   **Selection Hierarchy**: Clicking a joint on an unselected support selects the **Support** first. Clicking a joint on a *selected* support selects the **Joint**.
    *   **Editability**: Joints are only draggable/editable when the parent support or the joint itself is selected.
    *   **Hover**: Joints only show hover highlight when parent support is selected.

4.  **Decluttered Editable Visuals (Joints + Knots)**:
    *   **Goal**: The *default* view of supports should be visually clean; joints/knots should only visually “pop” when the user is actively editing a selected support.
    *   **Default (support not selected)**:
        *   **Joints** render at the **shaft diameter** and use the **same color as the shaft/support** (they visually blend into the support).
        *   **Knots** render at the **shaft diameter** and use the **same color as the shaft/support**.
    *   **Editable (support selected)**:
        *   **Joints** render at **shaft + 0.1mm** and display as **gray** to indicate editability.
        *   **Knots** render at **shaft + 0.1mm** and display as **green** to indicate editability.
    *   **Implementation**:
        *   The “+0.1mm” contract is centralized in `src/supports/constants.ts` (`JOINT_DIAMETER_OFFSET_MM`).
        *   The blending/popping behavior lives in:
            *   `src/supports/SupportPrimitives/Joint/JointRenderer.tsx`
            *   `src/supports/SupportPrimitives/Knot/KnotRenderer.tsx`
        *   Support renderers pass the support’s base color into the primitives, and the primitives decide whether to show the “editable” color based on `isParentSelected`.

5.  **Improved Joint UX**:
    *   **Hitbox**: Joints use an invisible sphere 2.5x the visual radius for easier clicking.
    *   **Picking Separation**: `TrunkRenderer` uses separate Picking Groups for Shafts vs Joints to ensure hovering a joint triggers the Joint ID, not the Trunk ID.
    *   **Undo/Redo Hooks**: Joint drags now push history snapshots through `useJointInteraction.ts` / `JointGizmo.tsx`, enabling Ctrl+Z to revert joint edits without affecting placements.

---

### ✅ Phase 5: History & Hotkeys (DONE)
**Location**: `src/history/`, `src/hotkeys/`, `src/supports/history/`

1. **Shared History Store** (`src/history/historyStore.ts` + `types.ts`)
   * Central undo/redo stack with handler registry + subscriber API.
   * Actions are plain objects `{ type, payload }` so any domain can participate.

2. **Support History Handlers** (`src/supports/history/useSupportHistoryHandlers.ts`)
   * Registers undo/redo logic for trunk add/remove/update.
   * Registers undo/redo logic for branch updates (used by branch joint deletion).
   * Mounted inside `SupportRenderer` so handlers live exactly as long as the supports domain.

3. **History Producers**
   * `useTrunkPlacementV2` pushes `support:add-trunk` actions with trunk/root snapshots.
   * `useJointInteraction` and `JointGizmo` push `support:update-trunk` actions (before/after snapshots) on drag end.
   * The global delete handler can push `support:update-branch` when deleting a selected branch joint.
   * `removeTrunk` returns snapshots to support `support:remove-trunk` entries.
     - **Important**: trunk deletion is a **cascade delete**. The history payload must store the trunk/root plus any removed dependent entities (knots/leaves/braces/branches) so undo/redo restores a valid graph.

4. **Global Hotkeys** (`src/hotkeys/useUndoRedoHotkeys.ts`)
   * Mounted once in `page.tsx`.
   * `Ctrl/Cmd + Z` → `undo()`, `Ctrl/Cmd + Shift + Z` → `redo()` while ignoring text inputs.

These pieces ensure every placement and joint move is reversible out of the box, and the pattern is ready for future mutations (deletions, branch tweaks, etc.).

### ✅ Phase 6: Global Delete Flow (DONE)
**Location**: `src/features/delete/`, `src/features/supports/`, `src/features/scene/`

1. **Delete Registry & Hotkey** (`src/features/delete`)  
   * `deleteRegistry.ts` exposes `registerDeleteHandler`, `getActiveDeleteHandler`, and `triggerDelete()`.  
   * `useDeleteHotkey.ts` mounts in `page.tsx`, listens for `Delete` / `Backspace`, ignores text inputs, and routes to the active handler.

2. **Support Domain Handler** (`src/features/supports/useSupportInteractionManager.ts`)  
   * Registers a Delete handler whenever Support Mode is active.  
   * Deletes **selected joints** by merging adjacent shaft segments via the new `removeJointById` helper in `supports/state.ts`, then pushes `support:update-trunk` history entries.  
   * Deletes **selected trunks** via `removeTrunk`.
     - This is a **cascade delete**: trunk/root are removed, plus trunk-hosted knots and any dependent branches/leaves/braces.
     - The delete handler pushes a `support:remove-trunk` history entry that includes snapshots of all removed dependents so undo/redo restores safely.
   * Clears selection/hover state so no stale gizmo references linger.

3. **Scene / STL Handler** (`src/features/scene/useSceneManager.ts`)  
   * When in **Prepare Mode** with a mesh loaded, Delete revokes the blob URL, clears `fileUrl` / `fileName`, and hides the mesh.  
   * The file input resets after every load so re-importing the same STL works.

4. **Priority Routing**  
   * Support deletions register at higher priority (`100`) so a selected joint/support takes precedence over scene deletions.  
   * Scene handler uses a lower priority (`10`), acting as the fallback when nothing in supports is deletable.

With these pieces, Delete is now a single global flow that respects selection context across domains and stays undo-safe.

## 📂 Key File Locations

### New V2 System
```
src/supports/
├── types.ts                    # Entity definitions
├── state.ts                    # State management
├── constants.ts                # Derived constants (joint sizing)
├── SupportRenderer.tsx         # Main entry point (receives mode prop)
│
├── SupportPrimitives/          # Building blocks
│   ├── Roots/
│   ├── Shaft/
│   ├── Joint/
│   │   ├── JointRenderer.tsx   # Handles hitbox & selection logic
│   └── ContactCone/
│
├── SupportTypes/               # Support type definitions
│   ├── Trunk/                  # trunkBuilder.ts + TrunkRenderer.tsx
│   ├── Branch/
│   ├── Twig/                   # (Future)
│   ├── Stick/                  # (Future)
│   └── Brace/                  # (Future)
│
├── rendering/
│   └── SupportBuilder.tsx      # Unified renderer (preview + placement)
│
├── Settings/
│   └── ...
│
└── interaction/
    ├── clickHandlers.ts        # Shared click logic (propagation stop)
    ├── selectionUtils.ts       # Selection helpers
    ├── SupportSelection.ts     # Centralized selection API
    ├── useHighlight.ts         # Visual state logic
    └── useInteractionStatus.ts # Global interaction blocking
```

### Reference Documentation
*... (No changes)*

---

## 🔑 Key Architectural Decisions

### Interaction Layering
1.  **Page Level**: Handles Hotkeys (`page.tsx` -> `jointCreationStore`).
2.  **Canvas Level**: `SupportRenderer` orchestrates child components based on `mode`.
3.  **Logic Level**: `useJointCreation` / `useJointInteraction` react to store/mode.
4.  **Engine Level**: `SnappingManager` (pure TS) handles math/state.

### Decoupled Highlighting
Visual feedback is handled by `useHighlight` in `src/supports/interaction/`. Renderers like `TrunkRenderer` simply consume this hook and props (`suppressHover`), keeping them pure. **New**: `useHighlight` and Renderers now support `isInteractable` prop to completely disable interaction in Prepare mode.

**Selection Dimming (Viewport)**
- When any support element is selected, all other supports render in a dim grey while the selected support remains cyan.
- Implementation approach:
  - `SupportRenderer.tsx` computes `dimNonSelected` from `state.selectedId` and passes it down into each support type renderer.
  - Each support type renderer (Trunk/Branch/Leaf/Brace/Twig/Stick) uses `dimNonSelected` to override the `useHighlight` `baseColor` for non-selected supports.

### User-Adjustable Defaults
**Location**: `src/supports/Settings/defaults.ts`

All user-adjustable default values are centralized in one file for easy editing:

```typescript
// --- Tip (Contact Cone) ---
DEFAULT_TIP_CONTACT_DIAMETER_MM = 0.3
DEFAULT_TIP_BODY_DIAMETER_MM = 1.0
DEFAULT_TIP_LENGTH_MM = 2.5

// --- Shaft ---
DEFAULT_SHAFT_DIAMETER_MM = 1.0

// --- Roots (Base) ---
DEFAULT_ROOTS_DIAMETER_MM = 3.0
DEFAULT_ROOTS_DISK_HEIGHT_MM = 0.5
DEFAULT_ROOTS_CONE_HEIGHT_MM = 1.5

// --- Base Flare ---
DEFAULT_BASE_FLARE_ENABLED = true
DEFAULT_BASE_FLARE_DIAMETER_MM = 3.0

// --- Joint ---
DEFAULT_JOINT_BALL_DIAMETER_MM = 1.5

// --- Grid ---
DEFAULT_GRID_ENABLED = false
DEFAULT_GRID_SPACING_MM = 4.0
```

**Rule**: Edit `Settings/defaults.ts` to change initial values. These flow into `createDefaultSettings()` and presets.

### Derived Constants
**Location**: `src/supports/constants.ts`

Contains only calculated/derived values (not user-adjustable):
- `JOINT_DIAMETER_OFFSET_MM` (0.1mm) — How much larger joints are than shafts
- `getJointDiameter(shaftDiameter)` — Returns shaft + offset
- `getJointRadius(shaftDiameter)` — Returns (shaft + offset) / 2

### Centralized Interaction Blocking
**Problem**: Different tools (Placement, Gizmo, Editing) were fighting for control.
**Solution**:
1.  **`useInteractionStatus.ts`**: Checks `hoveredCategory` / `selectedCategory`.
2.  **`PickingStateSyncer.tsx`**: Syncs GPU Picking results to global store.
3.  **Preview Auto-Clear**: `useTrunkPlacement` and `SceneCanvas` monitor `isPlacementDisabled` and force-clear/hide the preview if disabled (e.g., hovering another support).

### Centralized Support Selection (New)
**Problem**: Selection logic was scattered and event bubbling caused immediate deselection.
**Solution**:
1.  **`interaction/clickHandlers.ts`**: Shared handlers (`handleSupportClick`, `handleJointClick`) that manage `stopPropagation` and `nativeEvent.stopImmediatePropagation`.
2.  **Renderers**: Use these handlers to ensure consistent behavior across Trunks and Branches.
3.  **SceneCanvas**: Handles background clicks but respects the propagation stop from 3D objects.

---

## 🧷 Universal Knot Attachment System (Read This Before Adding Braces)

This project treats **Knots** as the universal way to attach one support to another support’s **shaft geometry**.
That means the “stay connected when the shaft changes” behavior must live in shared plumbing, not inside each new support type.

### What a Knot stores (the contract)
Each `Knot` must store:
- `parentShaftId`: the segment ID the knot rides on
- `t`: normalized position along that segment (`0..1`)
- `pos`: the world position derived from `(parentShaftId, t)`

### Where the universal logic lives
The “always remain attached” logic is enforced by these shared layers:

1. **Curve/segment math**
   - `src/supports/SupportPrimitives/Knot/knotUtils.ts`
   - Uses `calculateKnotPositionOnSegmentFromT(...)` so knots work on:
     - straight segments
     - bezier segments (evaluates on the cubic curve)

2. **State mutation routes (authoritative)**
   - `src/supports/state.ts`
   - Any code that changes shaft geometry must go through:
     - `updateTrunk(trunk)`
     - `updateBranch(branch)`
     - `updateKnot(knot)` (direct knot drag)
   These functions are responsible for recomputing knot positions for any knots that are attached to the modified shaft.

3. **Topology changes (joint delete / segment merge)
   - Also in `src/supports/state.ts`
   - When deleting a joint, a segment may be removed/merged.
     Knots that were attached to the removed segment must be **rebound** to the merged segment.

4. **Interactive dragging behavior**
   - `src/supports/SupportPrimitives/Knot/useKnotInteraction.ts`
   - Handles real-time dragging of a knot along its host shaft and applies any constraints.

---

## 🧩 Brace Shafts: Curvature + Manifold Taper (Implemented)

This section documents the brace work completed so braces behave like first-class shafts (same rendering primitives, same snapping contract, same drag behavior) and remain suitable for export.

### 1) Braces render using the actual Shaft primitives

**Goal**: Braces should not have bespoke shaft mesh code.

**Implementation**:
- Braces now render straight segments using:
  - `src/supports/SupportPrimitives/Shaft/ShaftRenderer.tsx`
- Braces now render curved segments using:
  - `src/supports/Renderers/BezierRenderer.tsx`
- The brace renderer (`src/supports/SupportTypes/Brace/BraceRenderer.tsx`) was refactored to use these primitives instead of stitching many small cylinders.

### 2) Curved brace shafts are a single tapered tube (manifold)

**Problem**: `THREE.TubeGeometry` is constant-radius by default, but brace endpoints need to taper with knot/joint diameter.

**Solution**:
- `BezierRenderer` now supports `diameterStart` / `diameterEnd`.
- Internally it builds one `TubeGeometry` and scales each ring’s vertices to the correct interpolated radius.

**Why this matters**:
- Avoids visible seams from “stacked cylinders”.
- Produces a single continuous surface (no cracks) for curved brace shafts.

### 3) Curve editing + selection behavior

**Hotkey**:
- Pressing `C` while a brace is selected toggles curve mode for the brace without needing secondary selection.

**Bezier handles**:
- Bezier handles are shown whenever a curved element is selected (no requirement to hold `C`).
- Brace handle contexts are created when selecting either:
  - `brace.id`
  - `braceSegment:<braceId>`

**Selection coupling**:
- Selecting `braceSegment:<braceId>` is treated as selecting the brace for renderer state (matching trunk/branch child-selection behavior).

### 4) Knot adherence and sliding on curved hosts

There are two different “stay attached” mechanisms:

1. **State recompute (authoritative)**
   - `src/supports/state.ts` includes `recomputeBraceSegmentKnotGeometry(...)`.
   - This reprojects knots whose `parentShaftId` is `braceSegment:<braceId>` using their stored `t`.

2. **Interactive drag projection (real-time)**
   - `src/supports/SupportPrimitives/Knot/useKnotInteraction.ts` now projects knots onto Bezier curves when the host is:
     - a curved brace segment (`braceSegment:<id>`)
     - a curved trunk/branch segment (Bezier segment)

**Critical rule**:
- Any knot that is attached to a shaft must store a valid `t`.
- Placement controllers must not create shaft-attached knots without `t`, otherwise the recompute step cannot keep them glued.

### 5) Files touched (brace feature)

- `src/supports/SupportTypes/Brace/BraceRenderer.tsx`
- `src/supports/Renderers/BezierRenderer.tsx`
- `src/supports/SupportPrimitives/Shaft/ShaftRenderer.tsx`
- `src/supports/Curves/BezierGizmo/BezierGizmoManager.tsx`
- `src/supports/SupportRenderer.tsx`
- `src/supports/SupportPrimitives/Knot/useKnotInteraction.ts`
- `src/supports/SupportTypes/Leaf/LeafPlacementController.tsx`

---

### Extension point for future knot-dependent geometry (Braces will use this)
When knot positions change due to shaft edits, some supports must update derived geometry.

Current extension point:
- `src/supports/state.ts` → `recomputeKnotDependentGeometry(...)`

Today it updates Leaf cone axis/length because Leaf depends on its parent knot position.
When Braces are added, this is where brace endpoints (two knots) should update any derived brace geometry.

### Brace implementation checklist (keep this true for future support types)
When implementing a support type that attaches to shafts (including Braces):

1. **Data model**
   - Brace should reference both knot IDs (e.g. `startKnotId`, `endKnotId`) or store both `parentShaftId+t` endpoints.

2. **Creation**
   - Create two `Knot` entities (each with `parentShaftId`, `t`, `pos`).

3. **Editing / shaft changes**
   - Ensure all shaft edits route through `updateTrunk` / `updateBranch` / `toggleSegmentCurve`.
   - Avoid directly mutating `state.trunks[...]` or `state.branches[...]` outside these functions.

4. **Derived geometry updates**
   - Add brace-specific recompute logic into `recomputeKnotDependentGeometry(...)`.

If you follow this checklist, the brace knots will stay snapped during:
- joint create/move/delete
- curve reshape
- bezier <-> straight toggles

---

## ⚠️ Gotchas & Lessons Learned

### 1. GPU Picking Lifecycle
**Issue**: `PickingProvider` was conditionally rendered.
**Fix**: Always mount it.

### 2. State Subscription in Loops
**Issue**: Reading getters without subscription.
**Fix**: Use `useSyncExternalStore`.

### 3. Composite IDs
**Issue**: GPU Picking returns object-level ID.
**Fix**: Use composite IDs where needed or fallback to spatial queries.

### 4. Preview Visibility / Freezing
**Issue**: Preview overlapped existing supports or "froze" when moving fast.
**Fix**: `SceneCanvas` explicitly guards rendering of `SupportBuilder` using `!blockSupportPlacement`. `useTrunkPlacement` also clears state on status change.
    *   **Implementation**: `src/components/scene/SceneCanvas/SceneCanvas.tsx`

### 4b. Preview Can Steal Hover (Raycast + GPU Picking)
**Issue**: During placement, preview geometry can cross under the cursor and steal the hover hit, causing the model hit to drop out and the preview to flicker/disappear.

**Fix**: Preview geometry must be non-interactive for hover targeting in *both* systems:
- **Three.js Raycasting**: ensure every mesh in preview render trees honors the `raycast={() => null}` override (watch for “secondary meshes” inside a renderer).
- **GPU Picking**: preview supports must not register pickables (e.g., preview shafts should opt out of `usePicking.register(...)`).

**Implementation example**:
- `SupportBuilder` renders preview shafts with picking disabled.
- `ShaftRenderer` supports an `enablePicking` switch for this.

### 5. Gizmo Deselection on Release
**Issue**: Releasing the gizmo handle caused the joint to deselect (click propagated to canvas).
**Fix**: `JointGizmo` sets `window.__gizmoDragEndedThisFrame = true` in `onMoveEnd`. `SceneCanvas.handleCanvasClick` checks this flag and skips deselection.
    *   **Implementation**: `src/components/scene/SceneCanvas/SceneCanvas.tsx`

### 6. Preview Responsiveness (Geometry + Click Feedback)
**Issue**: Preview interactions could feel visually “clunky” due to heavy per-update geometry work and/or waiting for the next `useFrame` tick to show feedback after a click.

**Fixes**:
- Preview shafts avoid rebuilding `CylinderGeometry` when the length changes; instead they render a unit-height cylinder and scale it to the current length.
- Brace placement provides immediate click feedback when starting a brace by setting a zero-length preview directly inside the click handler (instead of waiting for the next snapping update).

### 7. R3F vs DOM Event Propagation
**Issue**: Clicking a support triggered `onClick` on the mesh (R3F) AND `onClick` on the parent Div (DOM), causing immediate deselection.
**Fix**: Handlers must call `e.nativeEvent.stopImmediatePropagation()` to prevent the DOM click handler on the Canvas wrapper from firing.

---

## 📦 Multi-Model System (New)

The system now supports loading, selecting, and transforming multiple STL models simultaneously.

### Architecture
1.  **State Source**: `useSceneCollectionManager` holds the `models` array and `activeModelId`. It provides helper methods (`updateModelTransform`, `deleteModel`, etc.).
2.  **Active Model Pattern**: The editor features (`transformMgr`, `slicing`, `islands`) generally operate on the *active* model. `page.tsx` synchronizes the active model's state into these feature managers when selection changes.
3.  **Selection Sync**:
    *   **Sidebar**: `ModelManagerPanel` drives `scene.setActiveModelId`.
    *   **Viewport**: `StlMesh` click drives `scene.setActiveModelId`.
    *   **Coordination**: `page.tsx` updates a local `displayActiveModelId` only *after* synchronizing the `transformMgr` state. This prevents a 1-frame flicker where the new active model would render with the old model's transform.

### Key Interactions
*   **Auto-Lift**: 
    *   **On Load**: `useSceneCollectionManager` calculates the initial Z position to sit on the plate (respecting user preference).
    *   **On Rotation**: `useTransformManager` auto-snaps to floor after rotation. `page.tsx` listens for `transform` changes and persists them to the model store.
*   **Selection/Deselection**:
    *   **Model Click**: Sets active model. Sets `window.__modelClickedThisFrame` to prevent background click from immediately deselecting.
    *   **Background Click**: `SceneCanvas` wrapper handles clicks. If no model was clicked in the same frame, it calls `onActiveModelChange(null)` to deselect.
        *   **Implementation**: `src/components/scene/SceneCanvas/SceneCanvas.tsx`
*   **Persistence**: Transform changes (Gizmo or Auto-Lift) are synced back to `scene.models` via a `useEffect` in `page.tsx`, ensuring state is preserved when switching models.

---

## 🛡️ Limitation & Warning System (New)

A comprehensive system to guide users towards viable support placement angles.

### 1. Angle Classification
Implemented in `src/supports/PlacementLogic/StandardPlacement.ts`.
Angles are measured relative to the global Up vector (Z+).

| Zone | Surface Angle Range | Color | Behavior | Meaning |
|------|---------------------|-------|----------|---------|
| **Error** | < 90° *(Normal mode)* | 🔴 Red | **Block** | Upward-facing surfaces. |
| **Error** | < 85° *(Locked/Adaptive mode)* | 🔴 Red | **Block** | Upward-facing surfaces, with a small extra allowance down to 85° for edge cases. |
| **Valid** | MinAngle - 180° | Gradient | **Allow** | Valid placement range. Color indicates safety. |

**Important distinction**:
*   The *angle shown + used for warnings/colors* is the **surface angle** (from the surface normal).
*   The **contact disk** stays aligned to the **surface normal** at the clicked position.
*   The **contact cone axis** may be modified for stability depending on `Cone Angle Mode` (details below).

**3-Stage Gradient (Visualization):**
Instead of discrete buckets, we use a continuous gradient to show safety levels:
*   **91° (Start)**: 🟠 **Orange** (Risky/Steep). Just past vertical.
*   **120° (Mid)**: 🟡 **Yellow** (Warning). Transition point.
*   **180° (End)**: 🟢 **Green** (Safe). Flat ceiling / strong overhang.

### 1b. Cone Angle Mode (Cone Axis Policy)
The tip has a user setting that controls whether we bias the **cone axis** to be more vertical (stronger) while keeping the **disk** at the clicked point.

**Setting Location**:
*   `src/supports/Settings/components/TipSettingsCard.tsx`
*   `src/supports/Settings/types.ts` → `tip.coneAngleMode` and `tip.adaptiveConeAngleOffsetDeg`

**Modes**:
*   **Normal**:
    *   Uses the surface normal for the cone axis in general.
    *   Includes a special-case near the vertical wall boundary (90–95° surface angle) to avoid a perfectly horizontal cone axis.
    *   Minimum surface angle allowed: **90°**.
*   **Locked**:
    *   Snaps cone axis to target angles for stability:
        *   Surface 110–140 ⇒ cone axis forced to 140
        *   Surface 85–110 ⇒ cone axis forced to 110
        *   More ceiling-like than 140 ⇒ unchanged (uses surface normal)
    *   Minimum surface angle allowed: **85°**.
*   **Adaptive**:
    *   Smoothly biases toward more vertical by adding up to **+N degrees** (user-controlled) near 90°, fading out by 150°.
    *   The magnitude is controlled by `tip.adaptiveConeAngleOffsetDeg`.
    *   Minimum surface angle allowed: **85°**.

**Authoritative logic**:
*   `src/supports/PlacementLogic/ConeAxisPolicy.ts` (encapsulates all cone-axis rules)
*   `src/supports/PlacementLogic/StandardPlacement.ts` calls `resolveConeAxisPolicy(...)` and returns `coneAxis`.
*   `src/supports/PlacementLogic/SmartPlacement.ts` preserves `coneAxis` so collision-solving does not change the cone axis.
*   `src/supports/SupportTypes/Trunk/trunkBuilder.ts` uses `coneAxis` for socket placement and for `ContactCone.normal`.

### 2. Smoothed Normals
**Problem**: Raw triangle normals cause supports to shoot off at chaotic angles on curved surfaces.
**Solution**: `src/supports/PlacementLogic/PlacementUtils.ts`
*   **`calculateSmoothedNormal`**: Uses Barycentric coordinates to interpolate vertex normals at the exact hit point.
*   Result: Supports align perpendicularly to the *smooth* surface curvature, not the faceted polygon.

### 3. Visual Feedback Architecture
*   **Tooltip**: `SupportLimitationFeedback.tsx` renders a floating tooltip next to the cursor (offset 65px right).
*   **Preview Color**: `SupportBuilder.tsx` handles material color changes based on `data.error` or `data.angle`.
    *   Uses a 3-stage linear gradient (Orange -> Yellow -> Green).
    *   Falls back to calculating angle from `contactCone` normal if data is missing.
*   **Angle Overlay**: `SupportBuilder.tsx` renders a persistent **HTML Text Overlay** (`<Html>`) next to the support tip in preview mode.
    *   Displays exact angle (e.g., "95°").
    *   Uses HTML to ensure text always faces camera and remains legible (no 3D rotation issues).
*   **Data Flow**:
    1.  `useTrunkPlacementV2` calculates placement & limitation status.
    2.  Status is stored in `SupportData` (`error`, `warning`, `angle` fields).
    3.  `SupportBuilder` consumes data to set color and render text.
    4.  `SceneCanvas` consumes data to render tooltip.
        *   **Implementation**: `src/components/scene/SceneCanvas/SceneCanvas.tsx`

### 4. Interaction Rules
*   **Errors**: `onSupportClick` aborts immediately. No support created.
*   **Warnings**: `onSupportClick` proceeds. Support is created (user acknowledges risk).

### 5. Codes & Messages Reference
Defined in `src/supports/PlacementLogic/SupportLimitations.tsx`.

**Errors (Block Placement):**
*   `ANGLE_TOO_STEEP`: "Surface angle is upward facing. Supports cannot be placed here."
*   `COLLISION_WITH_MODEL`: "Support would collide with the model geometry."
*   `TOO_CLOSE_TO_EXISTING`: "Too close to an existing support."
*   `OUT_OF_BOUNDS`: "Support placement is outside the build volume."

**Warnings (Allow with Alert):**
*   `ANGLE_VERTICAL_WARNING`: "Horizontal angles are not good for holding up overhangs. They are only good for lateral stability."

---

### 6. Smart Support Placement (New)
**Problem**: Standard vertical supports pass through model geometry on complex overhangs.
**Solution**: `src/supports/PlacementLogic/SmartPlacement.ts`
A collision-aware solver that "bends" supports around obstacles.

**Key Features:**
*   **Iterative "Knee" Solver**: If a straight path is blocked, it adds a Joint ("Knee") to route around the obstacle. Supports up to 3 joints.
*   **Compass Search**: When blocked, it checks 8 directions (360°) around the collision to find the best escape path.
*   **Multi-Radius Search**: Tests variable horizontal offsets (`[2, 5, 10, 15, 20]mm`) to find the tightest valid turn.
*   **High Knee Logic**: Prioritizes placing the turn near the start (Socket) to create an immediate "Elbow" rather than a late turn deep in the stack.
*   **Angle Constraints**:
    *   **Max Angle**: 70° from vertical.
    *   **Horizontal Exception**: Segments < 2mm can be flatter (up to 90°), allowing tiny connectors.
    *   **Enforcement**: If a proposed segment is too flat/long, the solver pushes the Knee Z position down until the angle is valid.
*   **Robust Collision**: Uses `CollisionUtils.ts` with **9-Ray Whiskers** (Center + 8 Perimeter) and a **0.25mm Safety Margin** to prevent fusing.

**Architecture Update**:
*   `trunkBuilder.ts` now accepts an optional `mesh` parameter. If present, it delegates to `SmartPlacement`.
*   `trunkBuilder.ts` supports dynamic segment generation (N-Joints) based on the solver result.

---

## 🔗 Support-Model Linkage (New)

To ensure supports are correctly associated with their parent models and cleaned up when models are deleted, we implemented a robust linkage system.

### 1. The `SupportEntity` Contract
Defined in `src/supports/types.ts`.
Every support type (Trunk, Branch, etc.) must extend `SupportEntity`, which mandates a `modelId`.
```typescript
export interface SupportEntity {
    id: string;
    modelId: string; // The model this support belongs to
}
```

### 2. The `SupportModelLinker`
Located at `src/supports/PlacementLogic/SupportModelLinker.ts`.
This module isolates the logic for:
*   Querying all supports owned by a specific model (`getSupportsForModel`).
*   Orchestrating the deletion of those supports (`deleteSupportsForModel`).
    - Current delete sweep covers trunks, branches, braces, leaves, twigs, sticks, and any remaining support-brace store entities for the model.

### 3. Lifecycle Integration
*   **Creation**: `useTrunkPlacement` extracts `modelId` from the raycast hit (`hit.object.userData.modelId`) and passes it to the builder.
*   **Deletion**: `useSceneCollectionManager` calls `deleteSupportsForModel` immediately after removing a model from the scene.

### 4. Developer Guide
A new master guide for creating support types has been added: `1. Documentation/LogicBible/NewSupportTypeGuide.md`.
It covers:
*   Implementing the Builder pattern.
*   Ensuring Lychee Import compatibility.
*   Wiring up History and Deletion logic.

---

## 📤 Export System (New)

The STL export feature operates on a unique architecture designed to keep the UI responsive and ensure 100% accurate geometry export.

### Architecture
1.  **Detached Scene ("Offline Export")**:
    *   We do **not** try to export the React Three Fiber scene directly (which contains UI helpers, gizmos, and react state).
    *   Instead, we spin up a temporary, invisible `THREE.Scene` in `ExportManager.ts`.
    *   We reconstruct the entire model + support geometry from pure data.

2.  **Pure Geometry Generator**:
    *   **`SupportGeometryGenerator.ts`**: A class that takes `SupportData` and outputs raw `THREE.Mesh` or `THREE.Group` objects.
    *   It replicates the visual output of `RootsRenderer`, `ShaftRenderer`, etc., but using pure Three.js code (no React).
    *   **Benefit**: This allows the export logic to run in a Web Worker (future optimization) and ensures the exported STL is purely the printable geometry, stripping away all editor visuals.

3.  **Data Flow**:
    *   `ExportPanel` triggers `ExportManager`.
    *   `ExportManager` reads `SupportState` (Zustand).
    *   It iterates through all trunks/branches.
    *   It calls `SupportGeometryGenerator` for each support.
    *   It clones the active model geometry.
    *   It merges everything into the offline scene and runs `STLExporter`.

4.  **Key Features**:
    *   **Raft Integration**: Roots are automatically lifted and resized if a raft is generated.
    *   **Model Alignment**: The export scene replicates the exact "Center Offset" logic of the viewport `StlMesh` to ensure supports line up perfectly with the model.
    *   **Z-Up Correction**: All cylinders and cones are rotated 90° X to match standard STL orientation.

---

## 🚀 Immediate Next Steps

### Step 1: Branch Placement (Next Priority)
1.  Refactor `useBranchPlacement` to use `SnappingManager` (reuse logic!).
2.  Target `Knot` creation or snapping to existing Shafts.

### Step 2: Contact Cone Refinement ✅ DONE
Contact cone has been refactored into its own feature folder:
- `ContactCone/types.ts` — `ContactCone` and `SupportTipProfile` interfaces
- `ContactCone/contactConeUtils.ts` — Geometry helpers (`getSocketPosition`, `getConeCenterPosition`, etc.)
- `ContactCone/ContactConeRenderer.tsx` — Renders cone body + socket joint

**Next**: Implement angle-aware contact tip (see `1. Documentation/LogicBible/AnatomyOfSupports/Contact-Tip-Research.md`).

---

## 📏 Trunk Default Structure

Per spec, a newly placed trunk has:
1.  **Roots**: Disk (0.5mm) + Cone (1.5mm) + Sphere (shaft diameter)
2.  **First Segment**: Vertical shaft from Roots sphere to Joint
3.  **Joint**: Spherical break at midpoint height (shaft diameter + 0.1mm)
4.  **Second Segment**: Angled shaft from Joint to Contact Cone socket
5.  **Contact Cone**: Terminal piece at model surface with socket joint

The first segment is **always vertical** on placement. The second segment angles to reach the contact point.

**Default Dimensions** (from `Settings/defaults.ts`):
- Tip contact: 0.3mm, body: 1.0mm, length: 2.5mm
- Shaft diameter: 1.0mm
- Joint diameter: shaft + 0.1mm (derived)
- Roots diameter: 3.0mm, disk: 0.5mm, cone: 1.5mm

**Settings Flow**:
1. User adjusts values in sidebar → `Settings/state.ts` updates
2. `useTrunkPlacement` calls `buildTrunkData()` which reads `getSettings()`
3. Same `buildTrunkData()` is used for both preview and placement (no duplication)

### SupportBuilder Pattern

**Problem**: Preview geometry was duplicated from placement geometry, causing mismatches.

**Solution**: One builder function, one renderer.

```
trunkBuilder.ts:
  buildTrunkData(tipPos, tipNormal) → { root, trunk, supportData }

useTrunkPlacement.ts:
  onHover → buildTrunkData() → setPreviewData()
  onClick → buildTrunkData() → addToStore()

SupportBuilder.tsx:
  Renders any SupportData with isPreview prop for material switching
```

**Benefits**:
- Preview always matches placed support exactly
- Single source of truth for support structure
- Easy to add new support types (just create a builder)

---

## � Reference Anatomy Preview System (Dynamic + Tunable)

A dedicated "Mini-Viewport" at the top of the settings sidebar that visualizes exactly what the current parameters do to the support anatomy.

### Architecture

1.  **Isolation**: The preview runs in its own detached R3F Canvas (`SupportAnatomyPreviewCanvas`) isolated from the main scene. It uses `gl-scissor` to render only within its DOM container (`SupportAnatomyPreviewSlot`).
2.  **Live Configuration**:
    *   **Sidebar Settings**: As the user drags main sliders, `liveConfig` updates in real-time.
    *   **Preview Tuner**: A developer overlay controlled by `ANATOMY_CONFIG.rendering.showPreviewTuner`.
        *   Camera-only controls (position/target/zoom) with copy-to-clipboard for updating camera presets.
        *   Includes an **Auto Camera** toggle:
            *   **On**: clicking a setting focuses the camera to that setting’s preset.
            *   **Off**: camera is locked 1:1 for copying values (tuner edits automatically switch Auto Camera off).
3.  **Ref-Based Reactivity**:
    *   To support 60fps updates while typing or dragging, the animation loop uses a `liveConfigRef` pattern to read the latest values directly from the input stream, bypassing React render closure staleness.

### Dynamic Camera Intelligence

The camera doesn't just look at the support; it **adapts** to the support's shape.

**1. Context-Aware Focus States:**
The camera smoothly animates to different viewpoints based on which setting is focused:
*   **Tip Contact Focus** (e.g., *Contact Diameter*): Zooms extremely close to the tip-model interface.
*   **Tip Cone Focus** (e.g., *Cone Length*): Pulls back slightly to frame the entire cone.
*   **Trunk Focus**: Frames the main shaft and joints.
*   **Roots Focus**: Frames the base/pad on the floor.

**2. Dynamic Zoom & Pan:**
*   **Contact Diameter**:
    *   **Small Tip (0.12mm)** → **Zoom 140x** (Macro view)
    *   **Large Tip (1.0mm)** → **Zoom 35x** (Wide view)
    *   *Result*: The tip disk always visually fills ~30% of the viewport, regardless of actual size.
    *   *Framing Note*: When cone control angle shifts the preview tip horizontally, Contact Diameter focus adjusts X framing to keep the tip in view.
*   **Cone Length**:
    *   **Short Cone (1mm)** → **Zoom 58x** (Close)
    *   **Long Cone (4mm)** → **Zoom 24x** (Far) + **Target Pan** (shifts X to keep centered)
    *   *Result*: The cone never clips out of frame as it grows.


## 🖥️ UI Architecture (Docked Sidebar + Floating Panels)

The UI uses a hybrid layout:

*   A **docked right sidebar** (full height under the top header) is used for mode-specific settings/inspectors.
*   A **floating panel stack** remains for panels that are not yet migrated (or are intentionally kept floating).
*   The **canvas always fills the remaining width** left of the docked sidebar.

### 1. Main Layout & Mode Composition (Authoritative)
**Location**: `src/app/page.tsx`

*   Renders `TopBar`.
*   Lays out `SceneCanvas` and a docked right `Sidebar` in a flex row under the header.
*   Provides a **single mode → sidebar content slot**, so only one mode-specific sidebar panel renders at a time.

### 2. Docked Sidebar Primitive
**Location**: `src/components/ui/Sidebar.tsx`

*   Supports right anchoring via `side="right"`.
*   Supports docked layout via `fixed={false}` so the sidebar participates in the app shell layout (not fixed-position).
*   The sidebar’s internal content area is the scroll container (`overflow-y-auto`).

### 3. Support Settings (Current Migration State)
**Location**: `src/supports/Settings/SupportSidebar.tsx`

*   `SupportSidebar` is now docked sidebar content (fills available width/height) rather than a fixed-width floating card.

### 4. Floating Panel System (Still in Use)
**Location**: `src/components/layout/FloatingPanelStack.tsx`

*   Panels float above the canvas in a pointer-events-safe container.
*   Container is positioned under the header (`top-[56px]`) and allows click-through where there is no UI.
*   The prior “shadow padding” insets were reduced to remove wasted space.

### 5. Layer Slider Placement
**Location**: `src/components/controls/LayerSlider.tsx`

*   Renders as an overlay inside the canvas region.
*   Positioned flush to the left edge of the docked sidebar by anchoring it to the canvas container (`right: 0` relative to the canvas region).
