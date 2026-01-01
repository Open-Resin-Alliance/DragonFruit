# Support Development Plan (Draft)

> Working document for MSLA support tooling. This version captures raw notes and considerations before we turn it into a formal checklist.

---

## 0. High-Level Reminders

- **Lychee compatibility, not cloning**: Match schema for import/export but deliver novel UX, workflows, and analytics.
- **MSLA only**: Ignore FDM-specific presets, cube tips, grid modes, etc., except when documenting how we intentionally diverge.
- **Scene parity**: Supports must align with transformed geometry (post-center, post-transform) so coordinates remain accurate across saves.
- **No data loss**: Preserve Lychee fields (baseTip, extra diameters, hierarchy) even if UI hides them initially.
- **Unique features**: Plan differentiators (island-driven presets, analytics, collaborative annotations) to avoid cloning accusations.

---

## 1. Notes on Existing Implementation

- Current `supports/` directory already has `types`, `state`, `placement`, `SupportSidebar`, `SupportPreview`, `SupportRenderer`.
- Placement drops straight to plate; no snapping to other supports or bracing logic yet.
- Support settings only cover tip/shaft/base; missing baseTip, join geometry, adaptive base.
- State is module-level in-memory; no persistence or normalized `byId/allIds` store.
- Sidebar edits a single global profile; no preset management or per-instance editing.

---

## 2. Things To Remember / Requirements Dump

1. **Schema alignment**
   - Per-instance data we must support:
     - Hierarchy + relationships: `parentBaseId`, `parentTipId`, `isBaseTip`, `isInFill`, `group`, `tags`.
     - Spatial data: `tip`, `tipNormal`, `base`, `baseNormal`, `gridNodeIndex`, collision flags, visibility flags.
     - Embedded geometry settings: full `tip`, `base`, `baseTip`, `mid`, `extra`, `adaptiveBase`, `isStraight`, plus joint parameters.
   - Tasks:
     1. Extend `SupportInstance`/`SupportSettings` types with these fields.
     2. Update storage (byId/allIds) and scene serialization to persist them.
     3. Ensure import/export layer (conversion codex) documents mappings for each field and stays updated when schema evolves.

2. **Support types as modules**
   - Each support style should live in its own file (e.g., `LightSupport.ts`, `MiniSupport.ts`, `BraceSupport.ts`).
   - Modules should export defaults, validators, and placement/render hooks.
   - Need preset system with custom naming (e.g., Detail, Structure, Anchor) rather than Lychee’s Light/Medium/Heavy labels, plus hotkeys for quick preset application.

3. **Global rules**
   - Snapping order: plate → nearest support base → designated brace nodes.
   - Minimum/maximum length enforcement with UI feedback.
   - Collision detection + acceptance flags (ties into future undo/redo).
   - Collision system must respect multi-joint structure; no support geometry should penetrate model meshes once joints are adjusted.

4. **Nomenclature & multi-section supports**
   - Working terminology (brainstorming, not final):
     - **Trunk** = primary vertical shaft anchored to the plate.
     - **Branch** = angled segment attached via a joint (connects trunk to tip or to other supports).
     - **Twig** = mini-support or small branch extension near the tip.
   - Final naming is TBD; goal is to give end users memorable words for each section when collaborating.
   - Standard Lychee-style structure to emulate:
     1. **Base trunk segment**: vertical section from build plate to first joint (always straight).
     2. **Mid trunk segment**: second section above the base joint; can rotate at the joint to angle toward the target.
     3. **Tip assembly**: attaches to the end of the mid segment.
   - Joint component:
     - Represented by a **ball** inserted where a segment is split; the ball mesh is the physical joint we already use today.
     - Creating a new joint = splitting the shaft, inserting the ball, and generating a new upper segment that inherits settings.
     - Each joint needs its own parameter block (e.g., diameter, rotation limits, friction/locking state) so presets can control articulation feel.
   - Our joints must expose:
     - Z-axis slide controls (move joint up/down the trunk to tune reach).
     - Rotation handles for any segment above the joint (branches/twigs) so users can steer around geometry.
     - Constraints to keep the base trunk locked vertical while allowing all other segments to angle.
   - Provide tooling (hotkey or UI button) to insert additional joints along the trunk so users can progressively branch supports for complex paths.
   - Additional joints should automatically create new branch segments that inherit settings but can be edited independently (length, diameter, tip type).
   - Define how joint rotations propagate: adjusting one joint should only affect segments above it unless user opts to propagate changes downstream.
   - Each support portion (base trunk, mid trunk, tip assembly, joints) needs its own parameter set in presets and UI, so users know exactly which section they are editing.
   - Collision workflow: branches/twigs should be angled away from the model after each joint adjustment, with live collision checks so the user knows if geometry intersects the mesh.

5. **Hierarchy & parenting**
   - Ability to attach supports to other supports (Lychee `parentBaseId`).
   - Visual indicators for parent/child relationships.

6. **UI/UX workflow**
   - Prepare vs Support modes already exist; need dedicated Support toolbar actions (delete, duplicate, convert to mini, etc.).
   - Sidebar should support presets, favorites, and advanced parameters per support segment.
   - Hover preview should indicate snap target and validity.
   - Advanced editing mode = **Grab tool**: separate from the standard Select tool. Select highlights the entire support; switching to Grab lets users hover individual elements (base trunk, joints, tip, branches) and brings up inline pop-overs with relevant parameters (length, diameter, joint size, etc.). This mirrors Blender’s workflow rather than Lychee’s spacebar edit mode.
   - Movement hotkeys inspired by Blender: adopt a "grab" action with axis locking (e.g., G+Z, G+X) so users can quickly constrain segment/joint translation along a single axis, helping them transfer skills to other 3D tools.

7. **Joint/segment manipulation widget**
   - Need a single reusable widget that handles joint rotation + translation + scaling (scaling upsizes joint balls and their connected segments) instead of multiple gizmos.
   - Widget should:
     - Snap to a joint ball and expose handles for orbiting (rotation around joint) and sliding (Z-axis movement) in one UI.
     - Provide scale handles that enlarge/shrink the joint ball, propagating diameter changes to adjacent shaft/tip sections.
     - Potentially replace current Prepare-mode Move/Rotate/Scale tools if we develop a universal 3D transform gizmo.
     - Support context-aware constraints (e.g., lock rotation axis for trunk base, allow free rotation for branches).
     - Be designed for reuse across the app (support editing, future mesh transforms) to reduce UI complexity.
     - Include hover animations that preview behavior (e.g., axis arrows pulsing for translation, cube scaling animation, rotational arcs) for clarity/polish.
   - Research feasibility of custom gizmo vs extending existing R3F TransformControls.

8. **Persistence & conversion**
   - Store supports alongside scene data for future save/export.
   - Provide serialization hooks for both our format and Lychee JSON.

9. **Grid support system**
   - Implement a proprietary grid-support mode inspired by Lychee but with better UX.
   - Auto-activate grid supports for newly imported unsupported models (no manual toggle step).
   - For models that arrive with supports, respect existing grid state but store a flag per model indicating whether grid is active and what cell size (e.g., 4 mm).
   - Expose these flags/measurements in the UI so users can see grid status per object.
   - Persist grid activation + spacing inside our save format alongside other support metadata.

10. **Future differentiators**
   - Island-size guidance: differentiate islands by footprint/volume so larger islands suggest multiple supports while tiny ones suggest fewer (not an all-or-nothing auto placement).
   - Selective island-driven placement: allow users to pick one or multiple islands from the scan UI and spawn supports only at those locations (not all-or-nothing like Lychee).
   - **Stability scoring**: compute a per-island stability score based on support distribution—e.g., number of supports, their XY spread, presence of lateral/brace connections, and joint orientations. Low scores indicate islands that need additional lateral reinforcement.
   - **Resin cost estimates**: sum the volume of each support segment (tip, trunks, branches, bases) plus grid structures to show per-support and per-model resin usage impact before printing. Note: true cost requires resin density (weight-based pricing), so we’ll need a user-specified density profile and clearly warn when only volume-based estimates are available.
   - **Surface smoothing brush**: RuneBrace-style tool that lets users smooth polygons with a small brush (similar to Blender’s smoothing brush) for touch-up work before support placement.

---

## 3. Implementation Phases (Preliminary Outline)

1. **Data Model Upgrade**
   - Expand `SupportSettings` and `SupportInstance` to cover full schema.
   - Introduce normalized store with persistence hooks.

2. **Preset Architecture** ✅ COMPLETE
   - ✅ Three built-in presets (Detail, Structure, Anchor) with hotkeys 1/2/3
   - ✅ Compact preset cards with aligned stats columns
   - ✅ Preset editor for custom presets
   - ✅ localStorage persistence + JSON export/import
   - ✅ Active preset switching updates support settings

3. **Placement Validation** ✅ COMPLETE (Phase 3A)
   - ✅ Surface-to-surface distance validation (0.1mm clearance)
   - ✅ Green/red preview based on validation
   - ✅ Placement blocked if invalid
   - ✅ Toast notification for errors
   - ✅ Works with all preset sizes

4. **Placement & Snapping Rules** (Phase 3B - DEFERRED)
   - Abstract raycast flow; add snapping strategies.
   - Implement validation feedback + preview enhancements.

4. **UI Enhancements**
   - SupportSidebar redesign for presets + per-segment controls.
   - Add support list/selection panel, editing, delete/duplicate shortcuts.

5. **Rendering & Editing**
   - Improve SupportRenderer to handle selection, hover, batching.
   - Add transformation handles or handles for repositioning tips/bases (later phase).

6. **Conversion Layer**
   - Integrate with `SupportConversionCodex` for import/export.
   - Unit tests ensuring round-trip fidelity.

---

## 4. Next Steps Before Checklist

- Refine each phase into actionable tasks with owners/durations.
- Decide file naming conventions for per-support modules.
- Document snapping math and tolerance values.
- Gather UI references for Support mode layout.
- Once the above notes stabilize, rewrite this plan as a prioritized checklist.
