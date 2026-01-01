# Support Joints & Grab Tool - Development Plan

**Phase:** #4 of Support Development Roadmap  
**Date:** November 16, 2025  
**Prerequisites:** ✅ Data model foundation, ✅ Preset architecture, ✅ Placement validation

---

## 1. Overview

Implement multi-segment supports with ball joints (spheres) and interactive tools for editing. This enables complex support structures that can bend and adapt to model geometry while maintaining structural integrity.

**Core Concepts:**
- **Lychee Standard**: 2 joints per support (base trunk → joint → mid trunk → joint → cone tip)
- **Our Current State**: 1 joint per support (base trunk → joint → tip)
- **Our Goal**: Variable joint count - users can add as many joints as needed, with configurable defaults

**Core Features:**
- Spherical ball joints connecting support segments
- Interactive joint creation mode with hotkey activation
- Preview and magnetic snapping for precise joint placement
- Joint transformation with gizmo (move and scale)
- Shafts always connected to joints - moving joints reshapes support structure
- Support selection → joint selection → gizmo manipulation workflow
- Joint angle constraints and collision detection
- Visual joint indicators

---

## 2. Goals

### Must Have - Joint Creation System
- [ ] Hotkey-hold activation for joint creation mode (not toggle - must hold key)
- [ ] Preview sphere appears when hovering over support shaft
- [ ] Magnetic snapping - mouse "sticks" to support shaft with movement threshold
- [ ] Click to place joint at preview position
- [ ] Shaft splitting logic - existing shaft shortens to joint, new shaft created to next joint
- [ ] Configurable default joint count per support
- [ ] Support for 0 to N joints per support (not limited to Lychee's 2)
- [ ] Spherical ball joint geometry rendering

### Must Have - Joint Transformation System
- [ ] Support selection enables joint selection
- [ ] Click on joint to select it
- [ ] Gizmo appears on selected joint (Move and Scale components only)
- [ ] Move gizmo allows 3D translation of joint position
- [ ] Scale gizmo allows resizing of joint ball diameter
- [ ] Shafts ALWAYS remain connected to joints (critical constraint)
- [ ] Moving joint updates shaft angles automatically
- [ ] Shaft recalculation maintains tip and base positions
- [ ] Visual feedback during joint manipulation
- [ ] Deselect joint to hide gizmo

### Should Have
- [ ] Joint rotation constraints (max angle)
- [ ] Axis-locked movement (X/Y/Z keys during grab)
- [ ] Rotate tool (R key) for joint rotation
- [ ] Scale tool (S key) for diameter adjustment
- [ ] Joint collision detection with model
- [ ] Visual indicators showing joint placement constraints
- [ ] Undo/redo support for joint creation/deletion

### Could Have
- [ ] Auto-joint insertion based on support length
- [ ] Joint optimization (minimize angles)
- [ ] Joint strength analysis
- [ ] Visual joint angle indicators
- [ ] Joint presets (stiff vs flexible)
- [ ] Smooth joint transitions (bezier curves)
- [ ] Joint deletion mode (remove joints from chain)
- [ ] Joint sliding (move existing joint along shaft)

---

## 3. Technical Design

### 3.1 Joint Data Model

**Schema Requirements:**
```typescript
interface SupportSettings {
  jointDefaults: {
    ballDiameterMm: number;      // Size of spherical ball joint
    maxRotationDeg: number;      // Max angle between segments
    maxSlideMm: number;          // Max linear movement
    defaultJointCount: number;   // Default number of joints for new supports (0-N)
  };
}

interface SupportInstance {
  joints?: SupportJoint[];       // Array of joints along support (variable length)
}

interface SupportJoint {
  id: string;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  ballDiameterMm: number;
  parentSegmentId?: string;      // Segment below this joint
  childSegmentId?: string;       // Segment above this joint
  order: number;                 // Position in chain (0 = closest to base)
}
```

**Joint Structure:**
- **Variable count**: Supports can have 0 to N joints (not limited to Lychee's 2)
- **Default behavior**: New supports created with `defaultJointCount` joints
- **Lychee compatibility**: Can import/export 2-joint Lychee supports
- **Chain order**: Joints ordered from base (0) to tip (N-1)
- **Segments**: Each joint creates a segment break in the support shaft

### 3.2 Joint Rendering

**Ball Joint Geometry:**
```typescript
// Sphere at joint position
<mesh position={[joint.x, joint.y, joint.z]}>
  <sphereGeometry args={[joint.ballDiameterMm / 2, 16, 16]} />
  <meshStandardMaterial color="#888888" />
</mesh>
```

**Segment Connection:**
- Tip segment: tip → joint (cone/cylinder)
- Base segment: joint → base (cylinder)
- Segments connect to ball joint surface

### 3.3 Interactive Joint Creation System

**Activation:**
- **Hotkey-hold mode**: User holds a specific key (e.g., J key) to activate joint creation mode
- **Not a toggle**: Mode is only active while key is held down
- **Visual mode indicator**: UI shows "Joint Creation Mode" while active
- **Cursor change**: Cursor changes to indicate joint creation mode

**Preview System:**
- **Hover detection**: Raycast from mouse to detect support shafts
- **Preview sphere**: Spherical ball joint preview appears at mouse position on shaft
- **Real-time positioning**: Preview updates as mouse moves along shaft
- **Visual styling**: Preview uses semi-transparent material to indicate it's not placed yet
- **Size preview**: Preview sphere uses current preset's joint diameter

**Magnetic Snapping:**
- **Shaft alignment**: Mouse position "sticks" to the nearest point on the support shaft
- **Movement threshold**: Mouse must move beyond threshold distance to break away from shaft
- **Snap distance**: Define maximum distance from shaft where snapping occurs
- **Visual feedback**: Preview sphere position snaps to shaft, not raw mouse position
- **Multi-support handling**: If multiple supports are nearby, snap to closest shaft

**Placement:**
- **Click to create**: Left-click while preview is visible creates the joint
- **Validation**: Check if joint position is valid (not too close to existing joints, within shaft bounds)
- **Shaft splitting**: When joint is placed, trigger shaft split logic
- **Feedback**: Visual/audio confirmation of successful placement
- **Error handling**: Show error message if placement is invalid

**Shaft Splitting Logic:**
1. **Identify target shaft**: Determine which shaft segment the joint is being added to
2. **Calculate split point**: Get exact position along shaft where joint will be placed
3. **Shorten existing shaft**: Update existing shaft endpoint to stop at new joint position
4. **Create new shaft segment**: Generate new shaft from new joint to next joint up the chain
5. **Update joint chain**: Insert new joint into joints array at correct order position
6. **Preserve settings**: New shaft segment inherits diameter/material settings from original shaft
7. **Update IDs**: Link segments and joints with proper parent/child IDs

**Constraints:**
- **Minimum spacing**: Prevent joints from being placed too close to existing joints
- **Shaft bounds**: Only allow placement within shaft length (not beyond tip or base)
- **Maximum joints**: Optional limit on total joints per support (configurable)

### 3.4 Joint Transformation with Gizmo

**Selection Workflow:**
1. **Support selection**: User clicks on support to select it
2. **Joint selection**: User clicks on a joint sphere within selected support
3. **Gizmo activation**: Move and Scale gizmo appears at joint position
4. **Manipulation**: User drags gizmo handles to transform joint
5. **Deselection**: Click elsewhere to deselect joint and hide gizmo

**Gizmo Components:**
- **Move gizmo**: 3-axis arrows (X/Y/Z) for translating joint in 3D space
- **Scale gizmo**: Uniform scale handles for resizing joint ball diameter
- **No rotation**: Joints are spherical, rotation not needed
- **Reuse existing gizmo**: Use same gizmo system as model transform (Move and Scale only)

**Critical Constraint - Shaft Connectivity:**
- **Shafts ALWAYS connected to joints**: This is an invariant that must never be violated
- **Moving a joint**: Updates the angles of connected shaft segments
- **Tip and base remain fixed**: Only joint positions change, endpoints stay anchored
- **Shaft recalculation**: When joint moves, recalculate shaft segment directions and rotations
- **Multi-joint chain**: Moving one joint only affects adjacent segments, not entire chain

**Shaft Recalculation Logic:**
When a joint is moved:
1. **Identify connected segments**: Find shaft segments above and below the joint
2. **Update lower segment**: Recalculate direction from previous joint/base to moved joint
3. **Update upper segment**: Recalculate direction from moved joint to next joint/tip
4. **Preserve endpoints**: Tip and base positions remain unchanged
5. **Update rotations**: Calculate new rotation angles for shaft cylinders
6. **Maintain diameters**: Shaft diameters unchanged, only angles/directions update

**Scale Behavior:**
- **Scaling joint**: Changes `ballDiameterMm` of the joint sphere
- **Visual update**: Joint sphere resizes in real-time
- **No shaft impact**: Scaling joint does not affect shaft segments
- **Validation**: Prevent scaling below minimum or above maximum diameter

**Visual Feedback:**
- **Selected joint**: Highlight with different color (e.g., blue)
- **Gizmo visibility**: Only visible when joint is selected
- **Shaft preview**: Show shaft angles updating in real-time during drag
- **Hover state**: Joints highlight on hover to indicate selectability

### 3.5 Grab Tool System (Deprecated - Replaced by Gizmo)

**Tool Modes:**
```typescript
type EditTool = 'none' | 'grab' | 'rotate' | 'scale';

interface EditState {
  tool: EditTool;
  targetSupportId: string | null;
  targetJointId: string | null;
  startPosition: { x: number; y: number; z: number };
  currentPosition: { x: number; y: number; z: number };
  axisLock: 'none' | 'x' | 'y' | 'z';
}
```

**Grab Tool Flow:**
1. Select support (click on it)
2. Press G key → enter grab mode
3. Move mouse → support tip follows cursor (raycasted to model surface)
4. Press X/Y/Z → lock to axis
5. Click → confirm new position
6. ESC → cancel

**Rotate Tool Flow:**
1. Select support
2. Press R key → enter rotate mode
3. Move mouse → rotate joint angle
4. Click → confirm rotation
5. ESC → cancel

**Scale Tool Flow:**
1. Select support
2. Press S key → enter scale mode
3. Move mouse → adjust diameter
4. Click → confirm scale
5. ESC → cancel

### 3.6 Joint Constraints

**Angle Constraint:**
```typescript
function validateJointAngle(
  segmentA: Vector3,
  segmentB: Vector3,
  maxAngleDeg: number
): boolean {
  const angle = segmentA.angleTo(segmentB) * (180 / Math.PI);
  return angle <= maxAngleDeg;
}
```

**Collision Detection:**
- Check if joint position intersects model
- Check if segments intersect model
- Prevent invalid joint placements

---

## 4. Implementation Tasks

### 4.1 Joint Data & Factory

**Extend existing types with:**
- `defaultJointCount` in `SupportSettings.jointDefaults`
- `order` field in `SupportJoint` interface
- Joint validation helpers (minimum spacing, shaft bounds)
- Shaft splitting utilities

**Tasks:**
- [ ] Add `defaultJointCount` to SupportSettings schema
- [ ] Add `order` field to SupportJoint interface
- [ ] Create joint validation helpers (spacing, bounds checking)
- [ ] Create shaft splitting utility functions
- [ ] Add joint insertion logic (insert at correct order position)
- [ ] Add joint removal logic (merge segments when joint deleted)

---

### 4.2 Joint Rendering

**Update support renderer to handle variable joint counts:**
- Render spherical ball joints at each joint position
- Split support shaft into N+1 segments (where N = number of joints)
- Connect segments to joint surfaces
- Handle highlighting for hovered/selected joints

**Tasks:**
- [ ] Add spherical ball joint rendering
- [ ] Implement multi-segment shaft rendering (handle 0 to N joints)
- [ ] Calculate segment positions and rotations for each joint
- [ ] Add joint hover/selection highlighting
- [ ] Optimize rendering (use InstancedMesh for multiple joints)
- [ ] Add preview sphere rendering (semi-transparent for joint creation mode)

---

### 4.3 Interactive Joint Creation Mode

**Create new joint creation system with hotkey-hold activation:**

**Tasks:**
- [ ] Add joint creation mode state (active when key held)
- [ ] Implement hotkey-hold detection (J key or configurable)
- [ ] Add mode indicator UI (shows "Joint Creation Mode")
- [ ] Change cursor during joint creation mode
- [ ] Implement raycast detection for support shafts on hover
- [ ] Create preview sphere component (semi-transparent)
- [ ] Implement magnetic snapping to shaft
  - [ ] Calculate closest point on shaft to mouse
  - [ ] Add movement threshold for breaking away
  - [ ] Define snap distance radius
- [ ] Implement click-to-place joint logic
- [ ] Add joint placement validation
  - [ ] Check minimum spacing from existing joints
  - [ ] Check within shaft bounds
  - [ ] Check maximum joint count (if configured)
- [ ] Implement shaft splitting on joint placement
  - [ ] Identify target shaft segment
  - [ ] Shorten existing shaft to joint position
  - [ ] Create new shaft segment from joint to next joint
  - [ ] Update joint chain order
  - [ ] Preserve shaft settings
- [ ] Add visual/audio feedback for successful placement
- [ ] Add error messages for invalid placements
- [ ] Add to undo/redo history

---

### 4.4 Default Joint Count Configuration

**Add preset/settings for default joint count:**

**Tasks:**
- [ ] Add `defaultJointCount` field to preset UI
- [ ] Add validation (0 to reasonable max, e.g., 10)
- [ ] Update support creation to use `defaultJointCount`
- [ ] Distribute joints evenly along shaft when creating support
- [ ] Save/load default joint count with presets

---

### 4.5 Joint Transformation with Gizmo

**Integrate existing gizmo system for joint manipulation:**

**Tasks:**
- [ ] Add joint selection state (selectedJointId)
- [ ] Implement joint click detection (raycast to joint spheres)
- [ ] Add joint hover highlighting
- [ ] Add joint selection highlighting (different color)
- [ ] Integrate existing Move gizmo for joint translation
  - [ ] Position gizmo at selected joint position
  - [ ] Handle gizmo drag events
  - [ ] Update joint position in real-time
- [ ] Integrate existing Scale gizmo for joint resizing
  - [ ] Handle uniform scale only
  - [ ] Update `ballDiameterMm` based on scale
  - [ ] Clamp scale to min/max diameter limits
- [ ] Implement shaft recalculation on joint move
  - [ ] Find adjacent segments (above and below joint)
  - [ ] Recalculate segment directions
  - [ ] Update segment rotations
  - [ ] Preserve tip and base positions (critical)
- [ ] Add real-time visual feedback during drag
- [ ] Implement deselection (click elsewhere)
- [ ] Add to undo/redo history
- [ ] Validate joint movements (collision detection, angle constraints)

---

### 4.6 Grab Tool Implementation (Deprecated - May Remove)

```typescript
export class GrabTool {
  private active: boolean = false;
  private targetSupportId: string | null = null;
  private startPosition: Vector3 | null = null;
  private axisLock: 'none' | 'x' | 'y' | 'z' = 'none';
  
  activate(supportId: string): void;
  deactivate(): void;
  setAxisLock(axis: 'x' | 'y' | 'z'): void;
  updatePosition(newPosition: Vector3): void;
  confirm(): void;
  cancel(): void;
}
```

**Tasks:**
- [ ] Create GrabTool class
- [ ] Implement activate/deactivate
- [ ] Implement axis locking (X/Y/Z keys)
- [ ] Implement position update with raycasting
- [ ] Implement confirm/cancel
- [ ] Add visual feedback (ghost preview)

---

### 4.7 Hotkey System (Deprecated - May Remove)

**File:** `src/app/page.tsx` (update existing)

Add tool hotkeys:
```typescript
useEffect(() => {
  const handleToolHotkey = (e: KeyboardEvent) => {
    if (mode !== 'support') return;
    if (!selectedSupportId) return;
    
    // Ignore if typing in input
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    
    const key = e.key.toLowerCase();
    
    if (key === 'g') {
      // Enter grab mode
      setEditTool('grab');
    } else if (key === 'r') {
      // Enter rotate mode
      setEditTool('rotate');
    } else if (key === 's') {
      // Enter scale mode
      setEditTool('scale');
    } else if (key === 'escape') {
      // Cancel tool
      setEditTool('none');
    } else if (key === 'x' || key === 'y' || key === 'z') {
      // Axis lock
      setAxisLock(key as 'x' | 'y' | 'z');
    }
  };
  
  window.addEventListener('keydown', handleToolHotkey);
  return () => window.removeEventListener('keydown', handleToolHotkey);
}, [mode, selectedSupportId]);
```

**Tasks:**
- [ ] Add edit tool state (grab/rotate/scale)
- [ ] Add G/R/S hotkey handlers
- [ ] Add X/Y/Z axis lock handlers
- [ ] Add ESC cancel handler
- [ ] Add visual tool indicator

---

### 4.8 Tool UI Feedback (Deprecated - May Remove)

**File:** `src/supports/ToolIndicator.tsx` (new)

Visual indicator showing active tool and instructions:
```tsx
export function ToolIndicator({ tool, axisLock }: { tool: EditTool; axisLock: string }) {
  if (tool === 'none') return null;
  
  return (
    <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg">
      <div className="font-semibold">
        {tool === 'grab' && 'Grab Mode'}
        {tool === 'rotate' && 'Rotate Mode'}
        {tool === 'scale' && 'Scale Mode'}
      </div>
      <div className="text-xs mt-1">
        {axisLock !== 'none' ? `Locked to ${axisLock.toUpperCase()} axis` : 'Press X/Y/Z to lock axis'}
        • Click to confirm • ESC to cancel
      </div>
    </div>
  );
}
```

**Tasks:**
- [ ] Create ToolIndicator component
- [ ] Show active tool name
- [ ] Show axis lock status
- [ ] Show instructions (click/ESC)
- [ ] Add to page.tsx

---

## 5. Execution Checklist

> Update as each item is completed

### Phase 4A - Variable Joint Count Foundation
1. [ ] Add `defaultJointCount` to SupportSettings schema
2. [ ] Add `order` field to SupportJoint interface
3. [ ] Create joint validation helpers (spacing, bounds)
4. [ ] Create shaft splitting utility functions
5. [ ] Update support creation to use `defaultJointCount`
6. [ ] Distribute joints evenly when creating support
7. [ ] Update SupportRenderer to handle 0 to N joints
8. [ ] Add spherical ball joint rendering
9. [ ] Implement multi-segment shaft rendering
10. [ ] Update serialization to include joints array
11. [ ] Test with 0, 1, 2, and 3+ joints

### Phase 4B - Interactive Joint Creation Mode
12. [ ] Add joint creation mode state
13. [ ] Implement J key hotkey-hold detection
14. [ ] Add "Joint Creation Mode" UI indicator
15. [ ] Change cursor during joint creation mode
16. [ ] Implement raycast detection for support shafts
17. [ ] Create semi-transparent preview sphere component
18. [ ] Implement magnetic snapping to shaft
19. [ ] Calculate closest point on shaft to mouse
20. [ ] Add movement threshold for snap breaking
21. [ ] Implement click-to-place joint logic
22. [ ] Add joint placement validation (spacing, bounds)
23. [ ] Implement shaft splitting on placement
24. [ ] Add visual/audio feedback for placement
25. [ ] Add error messages for invalid placements
26. [ ] Add to undo/redo history

### Phase 4C - Preset Integration
27. [ ] Add `defaultJointCount` field to preset UI
28. [ ] Add validation (0-10 range)
29. [ ] Save/load default joint count with presets
30. [ ] Test all 3 presets with different joint counts

### Phase 4D - Joint Transformation with Gizmo
31. [ ] Add joint selection state (selectedJointId)
32. [ ] Implement joint click detection (raycast to spheres)
33. [ ] Add joint hover highlighting
34. [ ] Add joint selection highlighting (blue color)
35. [ ] Integrate Move gizmo at selected joint position
36. [ ] Handle Move gizmo drag events
37. [ ] Update joint position in real-time during drag
38. [ ] Implement shaft recalculation on joint move
39. [ ] Find adjacent segments (above/below joint)
40. [ ] Recalculate segment directions
41. [ ] Update segment rotations
42. [ ] Preserve tip and base positions (critical)
43. [ ] Integrate Scale gizmo for joint resizing
44. [ ] Update `ballDiameterMm` based on scale
45. [ ] Clamp scale to min/max diameter
46. [ ] Add real-time visual feedback during manipulation
47. [ ] Implement deselection (click elsewhere)
48. [ ] Add to undo/redo history
49. [ ] Validate joint movements (collision, angle constraints)
50. [ ] Test with multi-joint supports (3+ joints)

### Phase 4E - Grab Tool (Deprecated - May Skip)
51. [ ] Create GrabTool class with activate/deactivate
52. [ ] Add G hotkey to enter grab mode
53. [ ] Implement tip position update via raycasting
54. [ ] Add visual feedback (ghost preview or highlight)
55. [ ] Add click to confirm, ESC to cancel
56. [ ] Update support position in store
57. [ ] Add to undo/redo history

### Phase 4F - Advanced Grab Features (Deprecated - May Skip)
58. [ ] Add X/Y/Z axis locking
59. [ ] Add ToolIndicator UI component
60. [ ] Add grab mode cursor change
61. [ ] Test grab with validation (prevent invalid positions)

---

## 6. Success Criteria

**Definition of Done (Phase 4A - Variable Joint Count):**
- ✅ Supports can have 0 to N joints (not limited to 2)
- ✅ Default joint count configurable in presets
- ✅ Joints render as spheres at correct positions
- ✅ Multi-segment shafts connect properly to joints
- ✅ Joints persist in save/load
- ✅ Works with all 3 presets
- ✅ Can import/export Lychee 2-joint supports

**Definition of Done (Phase 4B - Interactive Joint Creation):**
- ✅ Holding J key activates joint creation mode
- ✅ Releasing J key deactivates mode
- ✅ Preview sphere appears when hovering over support shaft
- ✅ Preview snaps magnetically to shaft
- ✅ Click places joint at preview position
- ✅ Shaft splits correctly when joint is placed
- ✅ New segment created between joints
- ✅ Validation prevents invalid placements (too close, out of bounds)
- ✅ Visual feedback for successful/failed placement
- ✅ Changes added to undo/redo history

**Definition of Done (Phase 4D - Joint Transformation with Gizmo):**
- ✅ Clicking on joint selects it
- ✅ Move and Scale gizmo appears on selected joint
- ✅ Dragging Move gizmo translates joint in 3D space
- ✅ Dragging Scale gizmo resizes joint ball diameter
- ✅ Shafts remain connected to joints at all times (invariant)
- ✅ Moving joint recalculates adjacent shaft angles
- ✅ Tip and base positions remain fixed when moving joints
- ✅ Real-time visual feedback during manipulation
- ✅ Clicking elsewhere deselects joint and hides gizmo
- ✅ Joint hover shows highlight
- ✅ Selected joint shows different color
- ✅ Changes added to undo/redo history
- ✅ Validation prevents invalid joint positions
- ✅ Works correctly with multi-joint supports (3+ joints)

**Performance Targets:**
- Joint rendering < 5ms per support (even with 10 joints)
- Joint creation preview updates < 16ms (60fps)
- Joint transformation updates < 16ms (60fps)
- Shaft recalculation < 5ms per joint move
- Magnetic snapping feels responsive
- No lag during gizmo manipulation

---

## 7. Future Enhancements

**After Phase 4 Complete:**
- Joint deletion mode (remove joints from existing supports)
- Joint sliding (move existing joint along shaft without recreating)
- Auto-joint insertion based on support length
- Joint optimization (minimize angles for strength)
- Joint strength analysis and warnings
- Smooth joint transitions (bezier curves between segments)
- Joint presets (stiff vs flexible articulation)
- Visual joint angle indicators (show degrees between segments)
- Joint snapping to model surface
- Batch joint operations (add/remove joints from multiple supports)

---

## 8. Dependencies & Risks

**Dependencies:**
- ✅ Support store with undo/redo (Phase 1) - COMPLETE
- ✅ Support rendering system (Phase 1) - COMPLETE
- ✅ Support selection system (Phase 1) - COMPLETE
- Raycasting system (already exists)
- Three.js geometry utilities

**Risks:**
- Joint rendering performance with many supports and many joints per support (mitigated by InstancedMesh)
- Complex segment rotation calculations (start simple, iterate)
- Magnetic snapping UX may feel sticky or unresponsive (needs tuning)
- Shaft splitting logic complexity with multiple joints (needs thorough testing)
- Raycasting performance when detecting shafts for joint creation (optimize with bounding boxes)
- Joint angle constraints may be too restrictive (make configurable)
- Grab tool UX complexity (follow Blender patterns)

**Mitigation:**
- Use InstancedMesh for joint rendering optimization
- Use simple sphere geometry for joints
- Implement configurable snap threshold and movement tolerance
- Test shaft splitting with edge cases (0 joints, 10 joints, joints very close together)
- Optimize raycasting with spatial indexing if needed
- Follow established Blender hotkey patterns
- Make all constraints configurable in settings
- Start with conservative defaults, allow users to customize

---

## 9. Notes

**Design Philosophy:**
- Variable joint count (0 to N) is core, not optional - enables flexibility beyond Lychee
- Interactive joint creation with hotkey-hold is more intuitive than preset-only approach
- Magnetic snapping reduces precision burden on users
- Shaft splitting must preserve settings and maintain chain integrity
- **CRITICAL INVARIANT**: Shafts ALWAYS remain connected to joints - this must never be violated
- Gizmo-based joint manipulation provides direct, visual control
- Moving joints reshapes support structure by changing shaft angles

**Implementation Priorities:**
1. Variable joint count foundation (Phase 4A) - enables all other features
2. Interactive joint creation (Phase 4B) - key differentiator from Lychee
3. Preset integration (Phase 4C) - convenience for common use cases
4. Joint transformation with gizmo (Phase 4D) - manual shaping capability
5. Deprecated features (Phase 4E+) - may skip Grab/Rotate/Scale hotkey tools in favor of gizmo

**Key Considerations:**
- Lychee compatibility requires 2-joint support for import/export
- Our system is more flexible - users can have 0, 1, 2, 3+ joints
- Default joint count should be configurable per preset
- Joint creation mode should feel responsive and predictable
- Validation prevents invalid placements but doesn't block creativity
- All joint operations must be undoable
- Joint system should work seamlessly with existing validation
- Consider adding "straighten support" tool to remove all joints from a support

**Critical Shaft Connectivity:**
- Shafts ALWAYS connected to joints - this is a non-negotiable invariant
- Moving a joint updates shaft angles, not shaft endpoints
- Tip and base positions are anchored - only joints move
- Shaft recalculation must happen in real-time during gizmo drag
- Only adjacent segments affected when moving a joint (not entire chain)
- Shaft diameter and material settings unchanged by joint movement

**Gizmo Integration:**
- Reuse existing Move and Scale gizmo components from model transform system
- No Rotate gizmo needed (joints are spherical)
- Gizmo appears only when joint is selected
- Selection workflow: support → joint → gizmo
- Deselection hides gizmo
- Gizmo handles should be sized appropriately for joint scale
