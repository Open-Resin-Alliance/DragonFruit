# Curved Supports Development Plan

## Development Checklist

### Phase 1: Foundation
- [x] **Step 1.1**: Create Bezier utilities and mathematical functions (`src/supports/Curves/BezierUtils.ts`)
  - [x] `calculateBezierControlPoints()` - Solve for control points with tangent constraints
  - [x] `getBezierPointAtT()` - Sample points along curve
  - [x] `getBezierTangentAtT()` - Get tangent direction at any point
  - [x] `validateBezierConstraints()` - Check curvature and overhang limits
  - [x] `bezierToLineSegments()` - Convert curve to printable segments
- [x] **Step 1.2**: Extend data structures for curved segments
  - [x] Add `BezierSegment` interface with tension parameter
  - [x] Update `SupportData` to support curved segments
  - [x] Add curve type discrimination in existing support logic
- [x] **Step 1.3**: Implement basic Bezier renderer (`src/supports/Renderers/BezierRenderer.tsx`)
  - [x] Generate tube geometry along Bezier path
  - [x] Handle real-time updates during interaction
  - [x] Add visual feedback for constraint violations

### Phase 2: Interaction System
- [x] **Step 2.1**: Implement hotkey system for curve mode
  - [x] Add 'C' key detection to existing hotkey system
  - [x] Modify gizmo interaction to detect curve mode activation
  - [x] Update cursor/visual feedback for curve mode
- [x] **Step 2.2**: Extend gizmo system with curve functionality
  - [x] Add curve mode to joint gizmo interaction
  - [x] Implement live Bezier preview during dragging
  - [x] Maintain tangent constraints during gizmo movement
- [x] **Step 2.3**: Create curve settings card component
  - [x] Design pop-up card UI separate from main sidebar
  - [x] Implement tension slider control (0.1 - 2.0 range)
  - [x] Add "Remove Curve" button functionality
  - [x] Handle card visibility (show on curve selection, hide on deselect)

### Phase 3: Integration & Logic
- [x] **Step 3.1**: Integrate with support builder system
  - [x] Detect curve mode activation in support creation
  - [x] Calculate tangents from neighboring segments
  - [x] Generate Bezier data instead of straight segment data
  - [x] Maintain compatibility with existing support workflow
- [x] **Step 3.2**: Extend collision detection for curves
  - [x] Update `CollisionUtils.ts` for curve sampling
  - [x] Implement multi-point collision testing along Bezier
  - [x] Integrate with existing smart placement system
- [x] **Step 3.3**: Update export functionality
  - [x] Convert Bezier curves to printable line segments (TubeGeometry handles this for STL)
  - [x] Maintain compatibility with existing export formats
  - [x] Preserve curve metadata for future use

### Phase 4: Polish & Testing
- [ ] **Step 4.1**: Performance optimization
  - [ ] Optimize Bezier calculations for real-time updates
  - [ ] Implement efficient sampling strategies
  - [ ] Add caching for curve calculations where appropriate
- [ ] **Step 4.2**: Advanced constraint handling
  - [ ] Implement maximum curvature validation
  - [ ] Add overhang angle checking along curve length
  - [ ] Handle edge cases and constraint violations gracefully
- [x] **Step 4.3**: User experience refinements
  - [x] Add visual indicators for tension changes
  - [x] Implement smooth transitions between straight/curved states (Sticky Mode)
  - [ ] Add undo/redo support for curve operations
- [ ] **Step 4.4**: Testing & validation
  - [ ] Unit tests for Bezier calculations
  - [ ] Integration tests for gizmo interaction
  - [ ] Print quality validation for exported curves
  - [ ] Performance testing with multiple curved supports

## Implementation Progress & Breakthroughs (Current Status)

### Critical Solved Issues

#### 1. The "Straight Curve" Paradox (Vertical Tangents)
**Problem**: Supports appearing straight despite being in curve mode.
**Cause**: A mathematical check `tangent.x !== 0` was rejecting valid vertical tangents (0,0,1), causing the system to fallback to linear interpolation.
**Solution**: Relaxed the tangent validation to accept vertical vectors, allowing curves to launch straight up from the base or cone.

#### 2. The "Cyan Top Segment" (End Position Resolution)
**Problem**: The top-most segment connecting to the Contact Cone remained straight (Cyan) while the bottom segment curved correctly (Magenta).
**Cause**: The system relied on `seg.topJoint` to find the end position, but the top segment connects to a `ContactCone`, not a joint.
**Solution**: Implemented a robust `getPos` resolver that explicitly checks for `trunk.contactCone` when the segment has no top joint, properly anchoring the curve to the cone's socket position.

#### 3. Connectivity Data Desync (Sequential Fallback)
**Problem**: Some segments failed to update because their `bottomJoint` ID didn't match the moved joint's ID (likely due to data structure inconsistencies during splitting).
**Solution**: Implemented a **Sequential Fallback Strategy**. If looking up the outgoing segment by ID fails, the system assumes the next segment in the linear array (`index + 1`) is the correct outgoing segment. This leverages the renderer's implicit sequential logic to ensure logical connectivity.

#### 4. UX Friction: "Sticky" Curve Mode
**Problem**: Dragging a curved support without holding 'C' would revert it to straight, frustrating users.
**Solution**: Implemented "Sticky Mode". If a segment is *already* Bezier, the drag operation automatically defaults to Curve Mode behavior, preserving the curve. The 'C' hotkey is only needed to *initiate* a curve on a straight support.

---

## Overview

**Goal**: Create curved support segments that allow users to bend supports around obstacles while maintaining printability and smooth connections.

**What This Accomplishes**: Instead of only straight support segments, users can create smooth curved segments that:
- Navigate around model features that would block straight supports
- Maintain proper tangent continuity (no sharp corners at joints)
- Respect 3D printing constraints (overhang angles, minimum curvature)
- Provide intuitive control through tension adjustment

**User Experience**: 
- Hold 'C' + drag any joint to create a curve instead of moving the joint
- A settings card appears with a tension slider to control how "curvy" the segment is
- Curves automatically connect smoothly to neighboring straight segments
- "Remove Curve" button converts back to straight segments without losing joint positions

**Technical Approach**: Use cubic Bezier curves with mathematical constraints to ensure the curves are both visually smooth and printable. The system calculates the proper curve shape based on the start/end joint positions and the directions of neighboring segments.

## Technical Approach

### 1. Mathematical Foundation
- **Curve Type**: Cubic Bezier curves for precise tangent control
- **Continuity**: C1 continuity (tangent matching) at all joints
- **Constraints**: 
  - Start tangent aligns with previous segment direction
  - End tangent aligns with next segment direction
  - Maximum curvature limits for printability
  - Overhang angle constraints along curve length

### 2. Data Structure Extensions

```typescript
// New segment type
interface BezierSegment {
  type: 'bezier'
  startPoint: Vec3
  endPoint: Vec3
  controlPoint1: Vec3
  controlPoint2: Vec3
  startTangent: Vec3
  endTangent: Vec3
  tension: number      // 0.1 = gentle curve, 2.0 = tight tangent following
  resolution: number   // Number of curve segments (8-64, default: 16)
  radius: number       // shaft diameter
}

// Extended support data
interface SupportData {
  segments: (StraightSegment | BezierSegment)[]
  joints: JointData[]
  // ... existing fields
}
```

### 3. Core Components

#### 3.1 Bezier Utilities (`src/supports/Curves/BezierUtils.ts`)
- `calculateBezierControlPoints()` - Solve for control points given start/end points and tangents
- `getBezierPointAtT()` - Sample points along curve for rendering/collision
- `getBezierTangentAtT()` - Get tangent direction at any point
- `validateBezierConstraints()` - Check curvature and overhang limits
- `bezierToLineSegments()` - Convert curve to printable segments
- `calculateOptimalResolution()` - Auto-calculate resolution based on curve length and radius
- `generateCurveGeometry()` - Create tube mesh with specified resolution

#### 3.2 Bezier Renderer (`src/supports/Renderers/BezierRenderer.tsx`)
- Generate tube geometry along Bezier path
- Real-time updates during gizmo interaction
- Visual feedback for constraint violations

#### 3.3 Curve Gizmo System
- Extend existing joint gizmo with "curve mode"
- Visual curve preview during dragging
- Constraint visualization (min radius, overhang warnings)

### 4. Integration Points

#### 4.1 Support Builder Integration
- Detect when curve mode is enabled
- Calculate tangents from neighboring segments
- Generate Bezier data instead of straight segment data
- Maintain compatibility with existing support logic

#### 4.2 Collision Detection
- Extend `CollisionUtils.ts` for curve sampling
- Sample multiple points along Bezier for collision testing
- Integrate with existing smart placement system

#### 4.3 Export System
- Convert Bezier curves to printable line segments
- Maintain compatibility with existing export formats
- Preserve curve metadata for potential future use

### 5. User Interaction Design

#### 5.1 Gizmo Modes
- **Standard Mode**: Current joint rotation behavior
- **Curve Mode**: Creates Bezier curve through dragged position (activated with 'C' hotkey)
- **Toggle**: Hold 'C' + click gizmo handle to enter Curve Mode

#### 5.2 Curve Settings Panel
- **Type**: Fixed settings panel (NOT a tooltip or mouse-following element)
- **Position**: Fixed location to the right of the main support settings panel
- **Styling**: Matches existing UI design system and component styles
- **Trigger**: Appears automatically when joint becomes curved
- **Visibility**: Shows only when curved joint is selected, hides on deselect
- **Controls**:
  - Tension slider (0.1 - 2.0)
  - Resolution slider (8 - 64 segments, default: 16)
  - Auto-resolution toggle (based on curve length/radius)
  - "Remove Curve" button (converts back to straight segments)
- **Behavior**: Real-time curve updates as settings change
- **Performance indicators**: Polygon count estimate, performance warning for high resolution

#### 5.3 Interaction Flow
1. User selects joint and holds 'C' + clicks gizmo handle
2. Dragging shows live Bezier preview with tangent constraints
3. System maintains tangent constraints automatically
4. Visual feedback for constraint violations
5. Commit on mouse release
6. Curve settings card appears with controls
7. User can adjust tension and other parameters in real-time
8. "Remove Curve" button converts segments back to straight lines
9. Deselecting joint hides settings card

### 6. Technical Challenges & Solutions

#### 6.1 Tangent Continuity
**Challenge**: Curves must smoothly connect to straight segments
**Solution**: Calculate tangents from neighboring joint positions, solve for Bezier control points that satisfy both position and tangent constraints

#### 6.2 Printability Constraints
**Challenge**: Curves must not violate overhang angles
**Solution**: Sample curve at multiple intervals, check tangent angles against print limits, reject or adjust curves that violate constraints

#### 6.3 Collision Detection
**Challenge**: Curved paths need more complex collision testing
**Solution**: Sample points along curve at regular intervals, perform collision checks at each sample point

#### 6.4 Performance & Resolution Management
**Challenge**: Balancing visual quality with polygon count and performance
**Solution**: 
- Implement adaptive resolution based on curve complexity and viewport distance
- Provide user controls for resolution (8-64 segments)
- Add performance indicators showing polygon count impact
- Use lower resolution for interaction preview, higher for final export
- Cache geometry calculations to avoid real-time regeneration

### 7. Implementation Phases

#### Phase 1: Foundation
- [x] Create Bezier utilities and data structures
- [x] Implement basic Bezier renderer
- [x] Add curve segment type to support system

#### Phase 2: Interaction
- [x] Extend gizmo system with curve mode
- [x] Implement tangent constraint calculations
- [x] Add visual feedback and constraint validation

#### Phase 3: Integration
- [x] Integrate with collision detection system
- [x] Update export functionality
- [x] Add undo/redo support for curve operations

#### Phase 4: Polish
- [ ] Performance optimization
- [ ] Advanced constraint handling
- [ ] User experience refinements

### 8. Testing Strategy

#### 8.1 Unit Tests
- Bezier calculation accuracy
- Tangent continuity verification
- Constraint validation logic

#### 8.2 Integration Tests
- Gizmo interaction workflows
- Collision detection with curves
- Export functionality

#### 8.3 User Testing
- Intuitive curve creation
- Performance with multiple curved supports
- Print quality validation

### 9. Success Criteria

- Users can create smooth curved support segments
- Curves maintain proper tangent continuity at joints
- All printability constraints are enforced
- Performance remains acceptable with complex curved structures
- Integration is seamless with existing support workflow

### 10. Future Considerations

- Automatic curve generation for obstacle avoidance
- Variable radius curves (tapering)
- Curve library of common support patterns
- Advanced constraint systems for specific materials/printers
