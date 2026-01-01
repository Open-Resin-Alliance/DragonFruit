# Support Joints Development Checklist

**Project:** STL Slicer - Support System Phase 4  
**Goal:** Variable joint count supports with interactive creation and gizmo manipulation  
**Date Created:** November 18, 2025  
**Last Updated:** November 18, 2025

---

## ✅ Completed Foundation Work

**Modular Joints System Created** (`src/supports/Joints/`)

All core utility modules have been implemented in a clean, modular architecture:

### Created Files:
1. **`types.ts`** - Complete type definitions for joints, segments, states, and results
2. **`geometry.ts`** - 3D math utilities (distance, vectors, angles, projection, interpolation)
3. **`validation.ts`** - Comprehensive validation (spacing, bounds, angles, diameter, movement)
4. **`factory.ts`** - Joint creation, updates, serialization/deserialization
5. **`shaftSplitting.ts`** - Segment splitting, joint insertion, chain management
6. **`shaftRecalculation.ts`** - Segment updates when joints move, invariant validation
7. **`raycasting.ts`** - Mouse interaction, hit detection, magnetic snapping
8. **`index.ts`** - Centralized barrel exports
9. **`README.md`** - Complete documentation with usage examples

### Updated Files:
- **`src/supports/types.ts`** - Added `defaultJointCount` to `SupportJointSettings`, added `joints` array to `SupportInstance`

### Key Features Implemented:
- ✅ Variable joint count (0 to N joints per support)
- ✅ Comprehensive validation with detailed error messages
- ✅ Shaft splitting with order management
- ✅ Shaft recalculation preserving tip/base positions (critical invariant)
- ✅ Raycasting for shafts and joints
- ✅ Magnetic snapping with configurable thresholds
- ✅ Immutable update functions
- ✅ Serialization for save/load
- ✅ Full TypeScript type safety

### Phase 4A Integration - COMPLETE ✅

**Rendering System:**
- ✅ `BallJoint.tsx` - Spherical joint rendering with selection/hover states
- ✅ `ShaftSegment.tsx` - Dynamic cylinder rendering between points
- ✅ `SupportRenderer.tsx` - Updated for multi-segment supports with joints

**Support Creation:**
- ✅ `placement.ts` - Integrated `createDefaultJoints()` into support creation workflow
- ✅ `presets.ts` - Added `defaultJointCount` to all 3 presets:
  - Detail: 0 joints
  - Structure: 1 joint  
  - Anchor: 2 joints

**Status:** Supports now automatically create with joints based on active preset. Rendering handles 0 to N joints dynamically.

### Next Steps:
- Phase 4A Testing: Verify rendering with different joint counts
- Phase 4B: Interactive joint creation mode (J key, preview, snapping)
- Phase 4D: Joint transformation with gizmo integration

---

## Pre-Development Review

- [x] Review existing support data model in codebase
- [ ] Review existing gizmo implementation (Move/Scale components)
- [ ] Review existing support rendering system
- [ ] Review existing raycasting system
- [x] Identify all files that need modification
- [ ] Create backup before starting

---

## Phase 4A: Variable Joint Count Foundation

### Step 1: Data Model Extensions
- [x] **1.1** Locate SupportSettings interface
- [x] **1.2** Add `jointDefaults` object with:
  - `ballDiameterMm: number`
  - `maxRotationDeg: number`
  - `maxSlideMm: number`
  - `defaultJointCount: number`
- [x] **1.3** Locate SupportJoint interface (created in Joints/types.ts)
- [x] **1.4** Add `order: number` field to SupportJoint
- [x] **1.5** Verify `joints?: SupportJoint[]` exists in SupportInstance
- [x] **1.6** Test: TypeScript compiles without errors

### Step 2: Joint Validation Utilities
- [x] **2.1** Create `src/supports/Joints/validation.ts` (modular location)
- [x] **2.2** Implement `validateJointSpacing()` function
  - Check minimum distance between joints
  - Return boolean + error message
- [x] **2.3** Implement `validateJointBounds()` function
  - Check joint is within shaft start/end
  - Return boolean + error message
- [x] **2.4** Implement `validateJointCount()` function
  - Check against maximum allowed joints
  - Return boolean + error message
- [x] **2.5** Additional: `validateJointPlacement()`, `validateJointMovement()`, `validateJointAngle()`, `validateJointDiameter()`
- [ ] **2.6** Test: Unit tests for validation functions

### Step 3: Shaft Splitting Utilities
- [x] **3.1** Create `src/supports/Joints/shaftSplitting.ts` (modular location)
- [x] **3.2** Implement `findTargetShaftSegment()` function
  - Identify which shaft segment contains the new joint position
  - Return shaft index or null
- [x] **3.3** Implement `calculateSplitPoint()` function
  - Get exact 3D position along shaft for joint placement
  - Return Vector3 position
- [x] **3.4** Implement `splitShaftAtJoint()` function
  - Shorten existing shaft to joint position
  - Create new shaft from joint to next joint/tip
  - Update joint chain order
  - Preserve shaft settings (diameter, material)
  - Return updated support instance
- [x] **3.5** Additional: `getShaftSegments()`, `removeJointFromChain()`
- [ ] **3.6** Test: Unit tests for shaft splitting logic

### Step 4: Support Creation with Default Joints
- [x] **4.1** Created `src/supports/Joints/factory.ts` with joint creation functions
- [x] **4.2** Implement `createDefaultJoints()` - reads `defaultJointCount` from settings
- [x] **4.3** Implement `distributePointsAlongSegment()` in geometry.ts
  - Calculate joint positions along shaft length
  - Create joint objects with correct order
  - Return joints array
- [x] **4.4** Additional factory functions: `createJoint()`, `updateJointPosition()`, `updateJointDiameter()`, `serializeJoints()`, `deserializeJoints()`
- [x] **4.5** Update support creation workflow to call `createDefaultJoints()` in placement.ts
- [ ] **4.6** Test: Create support with 0, 1, 2, 3 joints

### Step 5: Multi-Segment Rendering Foundation
- [x] **5.1** Locate SupportRenderer component
- [x] **5.2** Add logic to handle `joints` array (0 to N joints)
- [x] **5.3** Use `getShaftSegments()` utility for segment calculation:
  - If 0 joints: single shaft from base to tip
  - If N joints: N+1 segments (base→joint1, joint1→joint2, ..., jointN→tip)
- [x] **5.4** Created ShaftSegment component - handles positions and rotations
- [ ] **5.5** Test: Render support with 0 joints (should look like current)

### Step 6: Ball Joint Rendering
- [x] **6.1** Create `src/supports/components/BallJoint.tsx`
- [x] **6.2** Implement spherical geometry rendering
  - Use `<sphereGeometry>` with configurable segments
  - Position at joint.position
  - Size based on joint.ballDiameterMm
- [x] **6.3** Add material with hover/selection states (gray, light gray, blue)
- [x] **6.4** Add to SupportRenderer for each joint
- [x] **6.5** Added joint selection and hover callbacks
- [ ] **6.6** Test: Render support with 1, 2, 3 joints - verify spheres appear

### Step 7: Segment Connection to Joints
- [x] **7.1** ShaftSegment component connects to joint surfaces automatically
- [x] **7.2** `getShaftSegments()` calculates segment start/end points:
  - Base segment: base position → first joint position
  - Mid segments: joint N → joint N+1
  - Tip segment: last joint → tip position
- [x] **7.3** ShaftSegment uses cylinder geometry with dynamic rotation
- [ ] **7.4** Test: Verify segments connect smoothly to joint spheres

### Step 8: Serialization & Persistence
- [x] **8.1** Created `serializeJoints()` and `deserializeJoints()` in factory.ts
- [ ] **8.2** Integrate with existing save/load functions for supports
- [ ] **8.3** Add migration for existing supports (add empty joints array)
- [ ] **8.4** Test: Save support with joints, reload, verify joints persist

### Step 9: Preset Integration - Data
- [x] **9.1** Locate preset definitions (Detail/Structure/Anchor)
- [x] **9.2** Add `defaultJointCount` to each preset:
  - Detail: 0 joints (fine control)
  - Structure: 1 joint (default, from createDefaultSupportSettings)
  - Anchor: 2 joints (heavy supports)
- [x] **9.3** Default values for joint settings already in place
- [ ] **9.4** Test: Load each preset, verify joint count

### Step 10: Phase 4A Testing & Validation
- [ ] **10.1** Test: Create support with 0 joints
- [ ] **10.2** Test: Create support with 1 joint
- [ ] **10.3** Test: Create support with 2 joints
- [ ] **10.4** Test: Create support with 3+ joints
- [ ] **10.5** Test: Save/load supports with various joint counts
- [ ] **10.6** Test: All 3 presets create supports correctly
- [ ] **10.7** Test: Rendering performance with 10 supports, 5 joints each
- [ ] **10.8** Fix any bugs found
- [ ] **10.9** Code review Phase 4A changes
- [ ] **10.10** Commit Phase 4A: "feat: variable joint count foundation"

---

## Phase 4B: Interactive Joint Creation Mode

### Step 11: Joint Creation State
- [ ] **11.1** Add state to page.tsx or support context:
  - `jointCreationMode: boolean`
  - `jointPreviewPosition: Vector3 | null`
  - `jointPreviewTargetSupport: string | null`
- [ ] **11.2** Test: State updates correctly

### Step 12: Hotkey-Hold Detection
- [ ] **12.1** Add keyboard event listener for 'j' key
- [ ] **12.2** On keydown: set `jointCreationMode = true`
- [ ] **12.3** On keyup: set `jointCreationMode = false`
- [ ] **12.4** Add check to ignore if typing in input field
- [ ] **12.5** Test: Hold J key, mode activates; release, mode deactivates

### Step 13: Mode Indicator UI
- [ ] **13.1** Create `src/supports/components/JointCreationIndicator.tsx`
- [ ] **13.2** Show "Joint Creation Mode" message when active
- [ ] **13.3** Position at top center of viewport
- [ ] **13.4** Style with blue background, white text
- [ ] **13.5** Add to SceneCanvas or page.tsx
- [ ] **13.6** Test: Indicator appears/disappears with J key

### Step 14: Cursor Change
- [ ] **14.1** Add CSS class for joint creation cursor
- [ ] **14.2** Apply cursor class when `jointCreationMode = true`
- [ ] **14.3** Use crosshair or custom cursor
- [ ] **14.4** Test: Cursor changes when holding J key

### Step 15: Raycast Detection for Shafts
- [x] **15.1** Create `src/supports/Joints/raycasting.ts` (modular location)
- [x] **15.2** Implement `raycastToShafts()` function
  - Cast ray from mouse position
  - Check intersection with support shaft cylinders
  - Return closest shaft hit + position
- [x] **15.3** Additional: `raycastToJoints()`, `isPointNearShaft()`, `isPointInJoint()`, `findSupportsNearPoint()`, `findClosestJoint()`
- [ ] **15.4** Integrate raycasting on mouse move when mode active
- [ ] **15.5** Test: Console log when hovering over shaft

### Step 16: Preview Sphere Component
- [ ] **16.1** Create `src/supports/components/JointPreviewSphere.tsx`
- [ ] **16.2** Render semi-transparent sphere at preview position
- [ ] **16.3** Use current preset's joint diameter for size
- [ ] **16.4** Use distinct color (e.g., cyan with 50% opacity)
- [ ] **16.5** Only render when `jointPreviewPosition !== null`
- [ ] **16.6** Test: Preview sphere appears when hovering shaft

### Step 17: Magnetic Snapping - Basic
- [x] **17.1** Implement `projectPointOntoSegment()` in geometry.ts
  - Calculate closest point on shaft line segment to mouse position
  - Return Vector3 position on shaft
- [x] **17.2** Implement `calculateSnapPosition()` in raycasting.ts
- [ ] **17.3** Update preview position to use snapped position
- [ ] **17.4** Test: Preview sphere snaps to shaft, not raw mouse position

### Step 18: Magnetic Snapping - Advanced
- [x] **18.1** Add snap distance threshold (implemented in `calculateSnapPosition()`)
- [x] **18.2** Implement `shouldBreakSnap()` for movement threshold
- [ ] **18.3** Integrate snap logic with preview sphere rendering
- [ ] **18.4** Handle multiple nearby shafts (choose closest) - implemented in `raycastToShafts()`
- [ ] **18.5** Test: Snapping feels smooth and predictable

### Step 19: Click-to-Place Logic
- [ ] **19.1** Add click event handler when mode active
- [ ] **19.2** On click, validate preview position
- [ ] **19.3** If valid, call shaft splitting function
- [ ] **19.4** Update support instance with new joint
- [ ] **19.5** Clear preview after placement
- [ ] **19.6** Test: Click places joint at preview position

### Step 20: Joint Placement Validation
- [ ] **20.1** Before placement, check minimum spacing
- [ ] **20.2** Check joint is within shaft bounds
- [ ] **20.3** Check maximum joint count (if configured)
- [ ] **20.4** If invalid, show error message
- [ ] **20.5** If invalid, don't place joint
- [ ] **20.6** Test: Try placing joints too close together (should fail)

### Step 21: Shaft Splitting on Placement
- [ ] **21.1** Identify target shaft segment
- [ ] **21.2** Call `splitShaftAtJoint()` utility
- [ ] **21.3** Insert new joint into joints array at correct order
- [ ] **21.4** Update support instance in store
- [ ] **21.5** Trigger re-render
- [ ] **21.6** Test: Shaft splits correctly, new segment appears

### Step 22: Visual Feedback
- [ ] **22.1** Add success animation/flash when joint placed
- [ ] **22.2** Add error shake/red flash for invalid placement
- [ ] **22.3** Optional: Add sound effects
- [ ] **22.4** Test: Feedback is clear and immediate

### Step 23: Error Messages
- [ ] **23.1** Create toast/notification system (if not exists)
- [ ] **23.2** Show error message for invalid placements:
  - "Joints must be at least X mm apart"
  - "Joint must be within shaft bounds"
  - "Maximum joint count reached"
- [ ] **23.3** Test: Error messages appear for each validation failure

### Step 24: Undo/Redo Integration
- [ ] **24.1** Locate undo/redo system
- [ ] **24.2** Add joint placement to undo history
- [ ] **24.3** Implement undo for joint placement
- [ ] **24.4** Implement redo for joint placement
- [ ] **24.5** Test: Undo removes placed joint, redo adds it back

### Step 25: Phase 4B Testing & Validation
- [ ] **25.1** Test: Hold J key, hover shaft, preview appears
- [ ] **25.2** Test: Release J key, preview disappears
- [ ] **25.3** Test: Click to place joint on shaft
- [ ] **25.4** Test: Shaft splits correctly
- [ ] **25.5** Test: Place multiple joints on same support
- [ ] **25.6** Test: Validation prevents invalid placements
- [ ] **25.7** Test: Error messages show correctly
- [ ] **25.8** Test: Undo/redo works for joint placement
- [ ] **25.9** Test: Performance with rapid joint placement
- [ ] **25.10** Fix any bugs found
- [ ] **25.11** Code review Phase 4B changes
- [ ] **25.12** Commit Phase 4B: "feat: interactive joint creation mode"

---

## Phase 4C: Preset UI Integration

### Step 26: Preset UI - Default Joint Count Field
- [ ] **26.1** Locate preset editor UI component
- [ ] **26.2** Add "Default Joint Count" numeric input field
- [ ] **26.3** Add label and help text
- [ ] **26.4** Set min=0, max=10
- [ ] **26.5** Test: Field appears in preset editor

### Step 27: Preset Validation
- [ ] **27.1** Add validation for joint count (0-10 range)
- [ ] **27.2** Show error if out of range
- [ ] **27.3** Prevent saving invalid values
- [ ] **27.4** Test: Try setting joint count to -1 or 20 (should fail)

### Step 28: Preset Save/Load
- [ ] **28.1** Verify defaultJointCount saves with preset
- [ ] **28.2** Verify defaultJointCount loads with preset
- [ ] **28.3** Add migration for existing presets (default to 1)
- [ ] **28.4** Test: Save preset with joint count, reload, verify value

### Step 29: Phase 4C Testing & Validation
- [ ] **29.1** Test: Edit Light preset, set joint count to 0
- [ ] **29.2** Test: Edit Medium preset, set joint count to 2
- [ ] **29.3** Test: Edit Heavy preset, set joint count to 3
- [ ] **29.4** Test: Create support with each preset, verify joint count
- [ ] **29.5** Test: Save/load presets, verify joint count persists
- [ ] **29.6** Fix any bugs found
- [ ] **29.7** Code review Phase 4C changes
- [ ] **29.8** Commit Phase 4C: "feat: preset integration for joint count"

---

## Phase 4D: Joint Transformation with Gizmo

### Step 30: Joint Selection State
- [ ] **30.1** Add state to page.tsx or support context:
  - `selectedJointId: string | null`
  - `selectedJointSupportId: string | null`
- [ ] **30.2** Test: State updates correctly

### Step 31: Joint Click Detection
- [ ] **31.1** Add click event handler for joint spheres
- [x] **31.2** Implement `raycastToJoints()` in raycasting.ts to detect joint sphere hits
- [ ] **31.3** Integrate click handler: set `selectedJointId` and `selectedJointSupportId`
- [ ] **31.4** Require support to be selected first
- [ ] **31.5** Test: Click on joint, verify selection state updates

### Step 32: Joint Hover Highlighting
- [ ] **32.1** Add hover state to BallJoint component
- [ ] **32.2** Change joint color on hover (e.g., light gray)
- [ ] **32.3** Only enable hover when support is selected
- [ ] **32.4** Test: Hover over joint, color changes

### Step 33: Joint Selection Highlighting
- [ ] **33.1** Add selected state to BallJoint component
- [ ] **33.2** Change joint color when selected (e.g., blue)
- [ ] **33.3** Make selected joint more prominent
- [ ] **33.4** Test: Selected joint shows blue color

### Step 34: Move Gizmo Integration - Setup
- [ ] **34.1** Locate existing Move gizmo component
- [ ] **34.2** Add gizmo to SceneCanvas when joint selected
- [ ] **34.3** Position gizmo at selected joint position
- [ ] **34.4** Test: Gizmo appears at joint when selected

### Step 35: Move Gizmo Integration - Drag Handling
- [ ] **35.1** Add drag event handlers for Move gizmo
- [ ] **35.2** Update joint position in real-time during drag
- [ ] **35.3** Update support instance in store
- [ ] **35.4** Test: Drag gizmo, joint moves

### Step 36: Shaft Recalculation - Find Adjacent Segments
- [x] **36.1** Create `src/supports/Joints/shaftRecalculation.ts` (modular location)
- [x] **36.2** Implement `findAdjacentSegments()` function
  - Find segment below joint (parent)
  - Find segment above joint (child)
  - Return segment indices
- [ ] **36.3** Test: Function returns correct segments

### Step 37: Shaft Recalculation - Update Directions
- [x] **37.1** Implement `recalculateShaftSegments()` function
- [x] **37.2** Calculate new direction vector for lower segment
  - From previous joint/base to moved joint
- [x] **37.3** Calculate new direction vector for upper segment
  - From moved joint to next joint/tip
- [x] **37.4** Preserve segment lengths (or adjust as needed)
- [ ] **37.5** Test: Segment directions update correctly

### Step 38: Shaft Recalculation - Update Rotations
- [x] **38.1** Implement `calculateSegmentRotation()` for Euler angles
- [x] **38.2** Rotation calculation included in `recalculateShaftSegments()`
- [ ] **38.3** Integrate rotation application to segment geometries in renderer
- [ ] **38.4** Test: Segments rotate to point at new joint position

### Step 39: Critical Constraint - Preserve Endpoints
- [x] **39.1** Implemented `validateShaftInvariants()` in shaftRecalculation.ts
- [x] **39.2** Validation checks tip position unchanged
- [x] **39.3** Validation checks base position unchanged
- [x] **39.4** Validation checks segment connectivity
- [ ] **39.5** Integrate validation into drag workflow
- [ ] **39.6** Test: Move joint, verify tip and base don't move

### Step 40: Real-Time Visual Feedback
- [x] **40.1** Created `updateSegmentsAfterJointMove()` helper in shaftRecalculation.ts
- [ ] **40.2** Integrate recalculation on every gizmo drag event
- [ ] **40.3** Update rendering in real-time (< 16ms per frame)
- [ ] **40.4** Optimize recalculation for performance (already O(1) - only adjacent segments)
- [ ] **40.5** Test: Dragging feels smooth, no lag

### Step 41: Scale Gizmo Integration - Setup
- [ ] **41.1** Locate existing Scale gizmo component
- [ ] **41.2** Add Scale gizmo to joint (uniform scale only)
- [ ] **41.3** Position gizmo at selected joint position
- [ ] **41.4** Test: Scale gizmo appears with Move gizmo

### Step 42: Scale Gizmo Integration - Resize Handling
- [ ] **42.1** Add drag event handlers for Scale gizmo
- [x] **42.2** Created `updateJointDiameter()` helper in factory.ts
- [ ] **42.3** Integrate diameter update in real-time during drag
- [ ] **42.4** Test: Drag scale gizmo, joint resizes

### Step 43: Scale Clamping
- [x] **43.1** Implemented `validateJointDiameter()` in validation.ts (min 0.5mm, max 5mm)
- [ ] **43.2** Integrate clamping in scale gizmo handler
- [ ] **43.3** Show warning if trying to scale beyond limits
- [ ] **43.4** Test: Try scaling very small/large (should clamp)

### Step 44: Deselection
- [ ] **44.1** Add click handler for empty space
- [ ] **44.2** On click outside joint, clear `selectedJointId`
- [ ] **44.3** Hide gizmo when deselected
- [ ] **44.4** Test: Click elsewhere, gizmo disappears

### Step 45: Undo/Redo for Joint Transformation
- [ ] **45.1** Add joint movement to undo history
- [ ] **45.2** Add joint scaling to undo history
- [ ] **45.3** Implement undo for joint transformation
- [ ] **45.4** Implement redo for joint transformation
- [ ] **45.5** Test: Undo/redo works for joint moves and scales

### Step 46: Validation - Collision Detection
- [ ] **46.1** Implement joint-model collision detection (future enhancement)
- [ ] **46.2** Prevent moving joint into model geometry
- [ ] **46.3** Show warning if collision detected
- [ ] **46.4** Test: Try moving joint into model (should prevent/warn)

### Step 47: Validation - Angle Constraints
- [x] **47.1** Implemented `validateJointAngle()` in validation.ts
- [x] **47.2** Implemented `validateJointMovement()` - checks against `maxRotationDeg` setting
- [ ] **47.3** Integrate angle validation in gizmo drag handler
- [ ] **47.4** Show warning if angle too large
- [ ] **47.5** Test: Try creating sharp angle (should prevent/warn)

### Step 48: Multi-Joint Support Testing
- [ ] **48.1** Create support with 3 joints
- [ ] **48.2** Select and move middle joint
- [ ] **48.3** Verify only adjacent segments update
- [ ] **48.4** Verify other joints unaffected
- [ ] **48.5** Test: Move each joint individually

### Step 49: Phase 4D Testing & Validation
- [ ] **49.1** Test: Click on joint, gizmo appears
- [ ] **49.2** Test: Drag Move gizmo, joint moves in 3D
- [ ] **49.3** Test: Shafts remain connected during move
- [ ] **49.4** Test: Tip and base positions unchanged
- [ ] **49.5** Test: Drag Scale gizmo, joint resizes
- [ ] **49.6** Test: Scale clamping works
- [ ] **49.7** Test: Click elsewhere, gizmo disappears
- [ ] **49.8** Test: Undo/redo works for transformations
- [ ] **49.9** Test: Collision detection prevents invalid moves
- [ ] **49.10** Test: Angle constraints prevent sharp bends
- [ ] **49.11** Test: Multi-joint support (3+ joints)
- [ ] **49.12** Test: Performance with gizmo manipulation (60fps)
- [ ] **49.13** Fix any bugs found
- [ ] **49.14** Code review Phase 4D changes
- [ ] **49.15** Commit Phase 4D: "feat: joint transformation with gizmo"

---

## Final Integration & Testing

### Step 50: End-to-End Testing
- [ ] **50.1** Test: Create support with Light preset (0 joints)
- [ ] **50.2** Test: Add 2 joints using J key
- [ ] **50.3** Test: Move joints with gizmo
- [ ] **50.4** Test: Scale joints with gizmo
- [ ] **50.5** Test: Save and reload scene
- [ ] **50.6** Test: Undo/redo entire workflow
- [ ] **50.7** Test: Switch between presets
- [ ] **50.8** Test: Performance with 20 supports, 3 joints each

### Step 51: Performance Optimization
- [ ] **51.1** Profile joint rendering performance
- [ ] **51.2** Optimize with InstancedMesh if needed
- [ ] **51.3** Profile shaft recalculation performance
- [ ] **51.4** Optimize raycasting for joint creation
- [ ] **51.5** Test: Verify < 16ms frame time

### Step 52: Documentation
- [ ] **52.1** Update README with joint system description
- [ ] **52.2** Document hotkeys (J for joint creation)
- [ ] **52.3** Document gizmo workflow
- [ ] **52.4** Add inline code comments
- [ ] **52.5** Create user guide for joint system

### Step 53: Final Review
- [ ] **53.1** Code review all changes
- [ ] **53.2** Check for TypeScript errors
- [ ] **53.3** Check for console warnings
- [ ] **53.4** Verify all success criteria met
- [ ] **53.5** Final commit: "feat: complete support joints system"

---

## Success Criteria Verification

### Phase 4A - Variable Joint Count
- [ ] Supports can have 0 to N joints
- [ ] Default joint count configurable in presets
- [ ] Joints render as spheres at correct positions
- [ ] Multi-segment shafts connect properly to joints
- [ ] Joints persist in save/load
- [ ] Works with all 3 presets

### Phase 4B - Interactive Joint Creation
- [ ] Holding J key activates joint creation mode
- [ ] Releasing J key deactivates mode
- [ ] Preview sphere appears when hovering over support shaft
- [ ] Preview snaps magnetically to shaft
- [ ] Click places joint at preview position
- [ ] Shaft splits correctly when joint is placed
- [ ] New segment created between joints
- [ ] Validation prevents invalid placements
- [ ] Visual feedback for successful/failed placement
- [ ] Changes added to undo/redo history

### Phase 4D - Joint Transformation with Gizmo
- [ ] Clicking on joint selects it
- [ ] Move and Scale gizmo appears on selected joint
- [ ] Dragging Move gizmo translates joint in 3D space
- [ ] Dragging Scale gizmo resizes joint ball diameter
- [ ] Shafts remain connected to joints at all times
- [ ] Moving joint recalculates adjacent shaft angles
- [ ] Tip and base positions remain fixed
- [ ] Real-time visual feedback during manipulation
- [ ] Clicking elsewhere deselects joint and hides gizmo
- [ ] Joint hover shows highlight
- [ ] Selected joint shows different color
- [ ] Changes added to undo/redo history
- [ ] Validation prevents invalid joint positions
- [ ] Works correctly with multi-joint supports (3+ joints)

### Performance Targets
- [ ] Joint rendering < 5ms per support
- [ ] Joint creation preview updates < 16ms (60fps)
- [ ] Joint transformation updates < 16ms (60fps)
- [ ] Shaft recalculation < 5ms per joint move
- [ ] Magnetic snapping feels responsive
- [ ] No lag during gizmo manipulation

---

## Notes

**Critical Invariants:**
- Shafts ALWAYS remain connected to joints
- Tip and base positions NEVER move when moving joints
- Only adjacent segments affected by joint movement

**Development Order Rationale:**
1. Phase 4A first - establishes data foundation
2. Phase 4B second - enables user interaction
3. Phase 4C third - integrates with existing presets
4. Phase 4D fourth - adds advanced manipulation

**Skipped Features (Deprecated):**
- Phase 4E: Grab Tool (replaced by gizmo)
- Phase 4F: Advanced Grab Features (replaced by gizmo)

**Risk Mitigation:**
- Test each phase thoroughly before moving to next
- Create backups before each phase
- Use feature flags if needed for gradual rollout
- Profile performance early and often
