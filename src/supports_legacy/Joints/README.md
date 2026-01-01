# Joints System

Modular system for multi-segment supports with ball joints and interactive editing.

## Overview

The Joints system enables supports with variable joint counts (0 to N joints per support), providing flexibility beyond traditional 2-joint systems. Joints are spherical ball connections that allow support structures to bend and adapt to model geometry.

## Architecture

The system is organized into focused, single-responsibility modules:

```
Joints/
├── types.ts              # TypeScript interfaces and types
├── geometry.ts           # 3D math utilities (vectors, distances, angles)
├── validation.ts         # Joint placement and constraint validation
├── factory.ts            # Joint creation and serialization
├── shaftSplitting.ts     # Shaft segment splitting when adding joints
├── shaftRecalculation.ts # Shaft updates when moving joints
├── raycasting.ts         # Mouse interaction and hit detection
├── index.ts              # Centralized exports
└── README.md             # This file
```

## Core Concepts

### Joints
- **Ball joints**: Spherical connections between shaft segments
- **Variable count**: 0 to N joints per support (configurable default)
- **Ordered chain**: Joints numbered from base (0) to tip (N-1)
- **Independent sizing**: Each joint has its own `ballDiameterMm`

### Shaft Segments
- **N+1 segments**: A support with N joints has N+1 shaft segments
- **Connected chain**: Base → Joint₁ → Joint₂ → ... → JointN → Tip
- **Automatic recalculation**: Segments update when joints move

### Critical Invariants
1. **Shafts ALWAYS remain connected to joints** - never violated
2. **Tip and base positions NEVER move** when moving joints
3. **Only adjacent segments affected** by joint movement

## Module Documentation

### `types.ts`
Defines all TypeScript interfaces for the joints system.

**Key Types:**
- `SupportJoint` - Single ball joint with position, diameter, order
- `ShaftSegment` - Segment between two points (joints/base/tip)
- `JointCreationState` - State for interactive joint creation mode
- `JointSelectionState` - State for joint selection and transformation
- `JointValidationResult` - Result of validation checks

### `geometry.ts`
Low-level 3D math utilities.

**Key Functions:**
- `calculateDistance(a, b)` - Euclidean distance between points
- `projectPointOntoSegment(point, start, end)` - Closest point on line segment
- `calculateAngleBetweenVectors(a, b)` - Angle in degrees
- `distributePointsAlongSegment(start, end, count)` - Even distribution
- `normalizeVector(v)` - Unit length vector

### `validation.ts`
Validates joint placements and movements.

**Key Functions:**
- `validateJointPlacement(...)` - Comprehensive placement validation
- `validateJointSpacing(position, joints, minSpacing)` - Check minimum spacing
- `validateJointBounds(position, start, end)` - Check within segment
- `validateJointAngle(segmentA, segmentB, maxAngle)` - Angle constraints
- `validateJointMovement(...)` - Validate joint drag operations

**Default Configuration:**
```typescript
{
  defaultJointCount: 1,
  minSpacingMm: 2.0,
  maxJointCount: 10,
  snapDistanceMm: 5.0,
  snapBreakThresholdMm: 0.5,
}
```

### `factory.ts`
Creates and manages joint objects.

**Key Functions:**
- `createJoint(params)` - Create new joint with defaults
- `createDefaultJoints(support, settings)` - Auto-distribute joints
- `updateJointPosition(joint, newPosition)` - Immutable update
- `updateJointDiameter(joint, newDiameter)` - Immutable update
- `serializeJoints(joints)` / `deserializeJoints(data)` - Save/load

**Example:**
```typescript
const joint = createJoint({
  position: { x: 0, y: 0, z: 10 },
  ballDiameterMm: 1.5,
  order: 0,
});
```

### `shaftSplitting.ts`
Handles shaft segment splitting when adding joints.

**Key Functions:**
- `findTargetShaftSegment(support, position)` - Find segment containing position
- `splitShaftAtJoint(params, support)` - Split segment, insert joint
- `getShaftSegments(support)` - Get all segments for rendering
- `removeJointFromChain(joints, jointId)` - Remove joint, merge segments

**Workflow:**
1. User clicks on shaft to place joint
2. `findTargetShaftSegment()` identifies which segment
3. `splitShaftAtJoint()` creates new joint and splits segment
4. Returns updated joints array with correct order values

### `shaftRecalculation.ts`
Recalculates shaft segments when joints move.

**Key Functions:**
- `recalculateShaftSegments(params)` - Update adjacent segments
- `findAdjacentSegments(jointId, joints, tip, base)` - Find affected segments
- `updateSegmentsAfterJointMove(...)` - Apply recalculation
- `validateShaftInvariants(...)` - Verify tip/base unchanged
- `calculateSegmentRotation(start, end)` - Euler angles for Three.js

**Critical Behavior:**
- Only adjacent segments recalculated (not entire chain)
- Tip and base positions preserved (validated)
- Segments maintain connection to joints

**Example:**
```typescript
const result = recalculateShaftSegments({
  supportId: 's1',
  movedJointId: 'joint-0',
  newPosition: { x: 1, y: 2, z: 15 },
  allJoints: support.joints,
  tipPosition: support.tip,
  basePosition: support.base,
});

// result.updatedSegments contains new segment directions
```

### `raycasting.ts`
Mouse interaction and hit detection.

**Key Functions:**
- `raycastToShafts(mousePos, supports, maxDistance)` - Find shaft under mouse
- `raycastToJoints(mousePos, supports, maxDistance)` - Find joint under mouse
- `calculateSnapPosition(mousePos, segment, snapDistance)` - Magnetic snapping
- `shouldBreakSnap(currentPos, snapPos, threshold)` - Break snap detection
- `findClosestJoint(point, supports)` - Nearest joint to point

**Return Types:**
- `ShaftRaycastHit` - Contains supportId, segmentIndex, hitPosition, parameter t
- `JointRaycastHit` - Contains supportId, jointId, joint, distance

**Example:**
```typescript
const hit = raycastToShafts(mousePosition, allSupports, 5.0);
if (hit) {
  // Show preview sphere at hit.hitPosition
  // Store hit.segmentIndex for placement
}
```

## Usage Examples

### Creating Supports with Default Joints

```typescript
import { createDefaultJoints } from '@/supports/Joints';

const support = createSupportInstance({
  id: 's1',
  tip: { x: 0, y: 0, z: 20 },
  base: { x: 0, y: 0, z: 0 },
  settings: {
    ...defaultSettings,
    jointDefaults: {
      ballDiameterMm: 1.5,
      maxRotationDeg: 45,
      maxSlideMm: 5,
      defaultJointCount: 2, // Create 2 joints
    },
  },
});

// Auto-distribute 2 joints evenly along shaft
support.joints = createDefaultJoints(support, support.settings);
```

### Interactive Joint Creation

```typescript
import { 
  raycastToShafts, 
  calculateSnapPosition,
  validateJointPlacement,
  splitShaftAtJoint 
} from '@/supports/Joints';

// 1. Detect shaft under mouse
const hit = raycastToShafts(mousePosition, supports, 5.0);
if (!hit) return;

// 2. Calculate snap position
const snap = calculateSnapPosition(mousePosition, hit.segment, 5.0);
if (!snap) return;

// 3. Validate placement
const validation = validateJointPlacement(
  snap.position,
  hit.segment.startPosition,
  hit.segment.endPosition,
  support.joints || [],
  1.5, // ballDiameterMm
);

if (!validation.isValid) {
  showError(validation.errorMessage);
  return;
}

// 4. Split shaft and add joint
const result = splitShaftAtJoint({
  supportId: hit.supportId,
  segmentIndex: hit.segmentIndex,
  splitParameter: snap.parameter,
  jointPosition: snap.position,
  ballDiameterMm: 1.5,
}, support);

// 5. Update support
support.joints = result.updatedJoints;
```

### Moving Joints with Gizmo

```typescript
import { 
  validateJointMovement,
  recalculateShaftSegments,
  updateJointPosition 
} from '@/supports/Joints';

function onJointDrag(jointId: string, newPosition: Vec3) {
  const support = getSupport(selectedSupportId);
  
  // 1. Validate movement
  const validation = validateJointMovement(
    jointId,
    newPosition,
    support.joints || [],
    support.tip,
    support.base,
    45 // maxAngleDeg
  );
  
  if (!validation.isValid) {
    showWarning(validation.errorMessage);
    return;
  }
  
  // 2. Update joint position
  const updatedJoints = support.joints.map(j =>
    j.id === jointId ? updateJointPosition(j, newPosition) : j
  );
  
  // 3. Recalculate shaft segments
  const result = recalculateShaftSegments({
    supportId: support.id,
    movedJointId: jointId,
    newPosition,
    allJoints: updatedJoints,
    tipPosition: support.tip,
    basePosition: support.base,
  });
  
  // 4. Update support
  support.joints = updatedJoints;
  // Apply result.updatedSegments to rendering
}
```

### Rendering Shaft Segments

```typescript
import { getShaftSegments } from '@/supports/Joints';

function renderSupport(support: SupportInstance) {
  const segments = getShaftSegments(support);
  
  return segments.map(segment => (
    <Cylinder
      key={segment.id}
      start={segment.startPosition}
      end={segment.endPosition}
      radius={segment.diameterMm / 2}
    />
  ));
}
```

## Integration Points

### With Support State
The joints system integrates with the existing support state management:

```typescript
// In support state
interface SupportInstance {
  // ... existing fields
  joints?: SupportJoint[]; // Added for joints system
}

interface SupportSettings {
  // ... existing fields
  jointDefaults: {
    ballDiameterMm: number;
    maxRotationDeg: number;
    maxSlideMm: number;
    defaultJointCount: number; // Added
  };
}
```

### With Undo/Redo
Joint operations should be added to the undo/redo history:

```typescript
// After joint placement
addToHistory({
  type: 'JOINT_ADDED',
  supportId,
  joint: newJoint,
});

// After joint movement
addToHistory({
  type: 'JOINT_MOVED',
  supportId,
  jointId,
  oldPosition,
  newPosition,
});
```

## Performance Considerations

- **Raycasting**: Use spatial indexing if >100 supports
- **Segment rendering**: Use `InstancedMesh` for many segments
- **Validation**: Cache validation results during drag operations
- **Recalculation**: Only adjacent segments updated (O(1) not O(N))

## Testing

Each module includes validation and error handling:

```typescript
// Validation returns detailed error messages
const result = validateJointPlacement(...);
if (!result.isValid) {
  console.error(result.errorMessage);
}

// Recalculation includes success flag
const recalc = recalculateShaftSegments(...);
if (!recalc.success) {
  console.error(recalc.errorMessage);
}

// Invariant validation
const check = validateShaftInvariants(tip, base, segments);
if (!check.isValid) {
  throw new Error(check.errorMessage);
}
```

## Future Enhancements

- Joint deletion mode (remove joints from chain)
- Joint sliding (move along shaft without recreating)
- Auto-joint insertion based on support length
- Joint optimization (minimize angles for strength)
- Smooth transitions (bezier curves between segments)
- Joint collision detection with model geometry
- Batch joint operations (add/remove from multiple supports)
