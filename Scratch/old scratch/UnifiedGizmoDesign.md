# Unified Transform Gizmo System - Design Document

**Purpose:** Single, reusable 3D gizmo for all transform operations across the app  
**Date:** November 16, 2025  
**Status:** Design Phase

---

## 1. Core Concept

A modular gizmo system where components can be enabled/disabled based on context:

**Use Cases:**
1. **Prepare Mode (Model Transform)** - Move + Rotate + Scale
2. **Support Mode (Tip Transform)** - Move + Scale only
3. **Support Mode (Base Transform)** - Move only (constrained to Z=0)
4. **Joint Transform** - Move only (future)

---

## 2. Gizmo Component Design

### Visual Structure

```
         Z axis (cyan)
              ↑
              |
              ●  ← center sphere
            / | \
    Y ←----●--●--●----→ X
  (green)      |      (red)
               |
         [scale cubes]
```

### Components Breakdown

**A. Center Sphere**
- **Purpose:** Origin point, free movement in all directions
- **Visual:** Small sphere (0.15 units radius)
- **Color:** White/light gray
- **Interaction:** Drag to move freely (no axis constraint)
- **When visible:** Always (if move enabled)

**B. Axis Arrows (Move)**
- **Purpose:** Constrained movement along single axis
- **Visual:** Arrow shaft + cone head
  - Shaft: Thin cylinder (0.02 radius, 1.0 length)
  - Head: Cone (0.08 radius, 0.2 height)
- **Colors:**
  - X axis: `#ff4444` (red)
  - Y axis: `#44ff44` (green)
  - Z axis: `#44ffff` (cyan)
- **Interaction:** Drag arrow to move along that axis only
- **When visible:** When move enabled

**C. Axis Planes (Move)**
- **Purpose:** Constrained movement in 2D plane
- **Visual:** Semi-transparent squares between axes
  - Size: 0.3 x 0.3 units
  - Position: 0.3 units from center on both axes
- **Colors:**
  - XY plane: `#ffff44` (yellow, 30% opacity)
  - XZ plane: `#ff44ff` (magenta, 30% opacity)
  - YZ plane: `#44ffff` (cyan, 30% opacity)
- **Interaction:** Drag plane to move in that 2D space
- **When visible:** When move enabled (optional, can disable for simplicity)

**D. Rotation Rings**
- **Purpose:** Rotation around axis
- **Visual:** Torus/ring around each axis with diamond handle
  - Ring: Major radius 0.8 units, minor radius 0.03 units
  - Diamond handle: Octahedron (0.08 radius) positioned on ring
  - Handle rotates around ring during interaction
- **Colors:** 
  - Ring: Gradient color matching axis (semi-transparent)
  - Diamond handle: Solid gradient end color (brighter)
  - X ring: Red → Orange gradient, orange diamond
  - Y ring: Green → Yellow gradient, yellow diamond
  - Z ring: Blue → Cyan gradient, cyan diamond
- **Interaction:** Drag diamond handle to rotate around that axis
- **When visible:** When rotate enabled

**E. Scale Hexagons**
- **Purpose:** Scale along single axis or uniform
- **Visual:** Hexagonal prisms at end of short lines
  - Hexagon: 0.1 radius, 0.05 depth (flat orientation perpendicular to axis)
  - Line length: 0.6 units from center
  - Hexagons face the camera (billboard effect optional)
- **Colors:** 
  - Hexagon faces: Gradient color matching axis
  - X hexagon: Red → Orange gradient
  - Y hexagon: Green → Yellow gradient
  - Z hexagon: Blue → Cyan gradient
  - Edges: Slightly darker for definition
- **Interaction:** 
  - Drag hexagon to scale along that axis
  - Drag center sphere to scale uniformly
- **When visible:** When scale enabled

---

## 3. Configuration System

### Gizmo Props Interface

```typescript
interface GizmoConfig {
  // Which operations are enabled
  enableMove?: boolean;      // Default: true
  enableRotate?: boolean;    // Default: false
  enableScale?: boolean;     // Default: false
  
  // Which components to show
  showMovePlanes?: boolean;  // Default: false (simpler without)
  showCenter?: boolean;      // Default: true
  
  // Size and appearance
  size?: number;             // Scale factor, default: 1.0
  opacity?: number;          // Overall opacity, default: 1.0
  
  // Constraints
  constrainToSurface?: boolean;  // For supports (raycast to model)
  constrainToPlane?: boolean;    // For base (Z=0)
  axisLock?: 'x' | 'y' | 'z' | null; // Lock to specific axis
  
  // Callbacks
  onMove?: (delta: Vector3) => void;
  onRotate?: (axis: 'x' | 'y' | 'z', angle: number) => void;
  onScale?: (axis: 'x' | 'y' | 'z' | 'uniform', factor: number) => void;
  onStart?: () => void;      // Drag started
  onEnd?: () => void;        // Drag ended
}
```

### Usage Examples

```typescript
// Prepare Mode - Full transform
<TransformGizmo
  position={modelPosition}
  enableMove={true}
  enableRotate={true}
  enableScale={true}
  onMove={(delta) => updateModelPosition(delta)}
  onRotate={(axis, angle) => updateModelRotation(axis, angle)}
  onScale={(axis, factor) => updateModelScale(axis, factor)}
/>

// Support Tip - Move + Scale
<TransformGizmo
  position={support.tip}
  enableMove={true}
  enableScale={true}
  constrainToSurface={true}  // Raycast to model
  onMove={(delta) => updateSupportTip(delta)}
  onScale={(axis, factor) => updateSupportDiameter(factor)}
/>

// Support Base - Move only (Z constrained)
<TransformGizmo
  position={support.base}
  enableMove={true}
  constrainToPlane={true}  // Z=0
  onMove={(delta) => updateSupportBase(delta)}
/>
```

---

## 4. Visual Design Details

### Color Palette

**Gradient Colors (matches world axes):**
```typescript
const GIZMO_COLORS = {
  // Axis gradients (start → end)
  xAxis: {
    start: '#ff0000',    // Pure red at center
    end: '#ff8800',      // Orange at tip
  },
  yAxis: {
    start: '#00ff00',    // Pure green at center
    end: '#ffff00',      // Yellow at tip
  },
  zAxis: {
    start: '#0000ff',    // Royal blue at center
    end: '#00ffff',      // Cyan/sky blue at tip
  },
  
  // Rotation ring colors (use gradient on ring, solid end color on diamond)
  xRing: {
    ring: '#ff0000',     // Red ring (with gradient to orange)
    diamond: '#ff8800',  // Orange diamond handle
  },
  yRing: {
    ring: '#00ff00',     // Green ring (with gradient to yellow)
    diamond: '#ffff00',  // Yellow diamond handle
  },
  zRing: {
    ring: '#0000ff',     // Blue ring (with gradient to cyan)
    diamond: '#00ffff',  // Cyan diamond handle
  },
  
  // Solid colors for other elements
  center: '#ffffff',     // White
  xyPlane: '#ffff44',    // Yellow (semi-transparent)
  xzPlane: '#ff44ff',    // Magenta (semi-transparent)
  yzPlane: '#44ffff',    // Cyan (semi-transparent)
  hover: '#ffaa00',      // Orange (highlight on hover)
  active: '#ffffff',     // White (during drag)
};
```

**Design Philosophy:**
- **Arrows** (move): Linear gradients along length - directional, dynamic
- **Diamonds** (rotate): Solid bright colors on rings - precise, elegant  
- **Hexagons** (scale): Radial gradients from center - geometric, distinctive
- All elements use the same color palette for visual consistency

**Note:** Axis arrows use vertex color gradients to match the world axes visual style. This creates a smooth color transition from the center (pure primary color) to the tip (lighter/warmer variant). Hexagons use radial gradients (center to edge) for a unique signature look.

### Size Guidelines
```typescript
const GIZMO_SIZES = {
  centerRadius: 0.15,
  arrowShaftRadius: 0.02,
  arrowShaftLength: 1.0,
  arrowHeadRadius: 0.08,
  arrowHeadLength: 0.2,
  planeSize: 0.3,
  planeOffset: 0.3,
  ringMajorRadius: 0.8,
  ringMinorRadius: 0.03,
  ringDiamondRadius: 0.08,
  scaleLineLength: 0.6,
  scaleHexagonRadius: 0.1,
  scaleHexagonDepth: 0.05,
};
```

### Gradient Implementation

**Vertex Color Gradient for Arrows:**
```typescript
function createGradientArrowGeometry(
  startColor: string, 
  endColor: string,
  length: number = 1.0,
  radius: number = 0.02
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 8);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  
  const start = new THREE.Color(startColor);
  const end = new THREE.Color(endColor);
  
  // Assign colors based on Y position (cylinder is vertical by default)
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    const y = geometry.attributes.position.getY(i);
    const t = (y + length / 2) / length; // Normalize to 0-1
    const color = new THREE.Color().lerpColors(start, end, t);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// Usage in component
<mesh geometry={xAxisGeometry}>
  <meshBasicMaterial vertexColors />
</mesh>
```

**Gradient Ring with Diamond Handle:**
```typescript
function GizmoRotationRing({ 
  axis, 
  startColor, 
  endColor, 
  diamondColor 
}: {
  axis: 'x' | 'y' | 'z';
  startColor: string;
  endColor: string;
  diamondColor: string;
}) {
  const [handleAngle, setHandleAngle] = useState(0);
  
  // Create gradient ring geometry
  const ringGeometry = useMemo(() => {
    const geometry = new THREE.TorusGeometry(0.8, 0.03, 16, 64);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    
    const start = new THREE.Color(startColor);
    const end = new THREE.Color(endColor);
    
    // Apply gradient around the ring
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const pos = geometry.attributes.position;
      const x = pos.getX(i);
      const y = pos.getY(i);
      const angle = Math.atan2(y, x);
      const t = (angle + Math.PI) / (2 * Math.PI); // Normalize to 0-1
      const color = new THREE.Color().lerpColors(start, end, t);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [startColor, endColor]);
  
  // Calculate diamond handle position on ring
  const handlePosition = useMemo(() => {
    const radius = 0.8;
    return {
      x: Math.cos(handleAngle) * radius,
      y: Math.sin(handleAngle) * radius,
      z: 0,
    };
  }, [handleAngle]);
  
  return (
    <group rotation={axis === 'x' ? [0, Math.PI/2, 0] : axis === 'y' ? [Math.PI/2, 0, 0] : [0, 0, 0]}>
      {/* Ring with gradient */}
      <mesh geometry={ringGeometry}>
        <meshBasicMaterial vertexColors transparent opacity={0.6} />
      </mesh>
      
      {/* Diamond handle (octahedron) */}
      <mesh position={[handlePosition.x, handlePosition.y, handlePosition.z]}>
        <octahedronGeometry args={[0.08]} />
        <meshBasicMaterial color={diamondColor} />
      </mesh>
    </group>
  );
}
```

**Gradient Hexagon for Scale:**
```typescript
function GizmoScaleHexagon({ 
  axis, 
  startColor, 
  endColor,
  position 
}: {
  axis: 'x' | 'y' | 'z';
  startColor: string;
  endColor: string;
  position: [number, number, number];
}) {
  // Create hexagonal prism geometry
  const hexGeometry = useMemo(() => {
    const radius = 0.1;
    const depth = 0.05;
    const geometry = new THREE.CylinderGeometry(radius, radius, depth, 6);
    
    // Apply gradient from center to edges
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    const start = new THREE.Color(startColor);
    const end = new THREE.Color(endColor);
    
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const x = geometry.attributes.position.getX(i);
      const z = geometry.attributes.position.getZ(i);
      const distFromCenter = Math.sqrt(x * x + z * z) / radius;
      const t = Math.min(distFromCenter, 1.0); // Normalize to 0-1
      const color = new THREE.Color().lerpColors(start, end, t);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [startColor, endColor]);
  
  // Rotate hexagon to face perpendicular to axis
  const rotation: [number, number, number] = 
    axis === 'x' ? [0, 0, Math.PI / 2] :
    axis === 'y' ? [0, 0, 0] :
    [Math.PI / 2, 0, 0];
  
  return (
    <group position={position}>
      {/* Connection line from center */}
      <mesh position={axis === 'x' ? [-0.3, 0, 0] : axis === 'y' ? [0, -0.3, 0] : [0, 0, -0.3]}>
        <cylinderGeometry args={[0.01, 0.01, 0.6, 8]} />
        <meshBasicMaterial color={startColor} opacity={0.5} transparent />
      </mesh>
      
      {/* Hexagon handle */}
      <mesh geometry={hexGeometry} rotation={rotation}>
        <meshBasicMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
      
      {/* Optional: Add edge outline for definition */}
      <lineSegments>
        <edgesGeometry args={[hexGeometry]} />
        <lineBasicMaterial color="#000000" opacity={0.3} transparent />
      </lineSegments>
    </group>
  );
}
```

### Hover & Active States
- **Hover:** Component glows (increase emissive, add outline)
- **Active (dragging):** Component turns white, others dim to 30% opacity
- **Disabled:** Component hidden (not rendered)
- **Gradient:** Maintained during hover/active states (just add emissive glow)

---

## 5. Implementation Architecture

### File Structure
```
src/components/gizmo/
├── TransformGizmo.tsx          # Main component
├── GizmoCenter.tsx             # Center sphere
├── GizmoAxis.tsx               # Arrow for single axis
├── GizmoPlane.tsx              # Plane for 2-axis movement
├── GizmoRing.tsx               # Ring for rotation
├── GizmoScaleCube.tsx          # Cube for scaling
├── useGizmoDrag.ts             # Drag interaction hook
├── gizmoConfig.ts              # Types and constants
└── gizmoUtils.ts               # Helper functions
```

### Main Component Structure

```typescript
// TransformGizmo.tsx
export function TransformGizmo({
  position,
  rotation = [0, 0, 0],
  enableMove = true,
  enableRotate = false,
  enableScale = false,
  showMovePlanes = false,
  size = 1.0,
  onMove,
  onRotate,
  onScale,
  onStart,
  onEnd,
  constrainToSurface = false,
  constrainToPlane = false,
}: GizmoConfig) {
  const [hoveredPart, setHoveredPart] = useState<string | null>(null);
  const [activePart, setActivePart] = useState<string | null>(null);
  
  return (
    <group position={position} scale={size}>
      {/* Center sphere - always visible if move enabled */}
      {enableMove && (
        <GizmoCenter
          isHovered={hoveredPart === 'center'}
          isActive={activePart === 'center'}
          onDragStart={() => handleDragStart('center')}
          onDrag={(delta) => handleMove(delta)}
          onDragEnd={handleDragEnd}
        />
      )}
      
      {/* Axis arrows - visible if move enabled */}
      {enableMove && ['x', 'y', 'z'].map((axis) => (
        <GizmoAxis
          key={axis}
          axis={axis}
          isHovered={hoveredPart === `axis-${axis}`}
          isActive={activePart === `axis-${axis}`}
          onDragStart={() => handleDragStart(`axis-${axis}`)}
          onDrag={(delta) => handleAxisMove(axis, delta)}
          onDragEnd={handleDragEnd}
        />
      ))}
      
      {/* Planes - optional, visible if move enabled and showMovePlanes */}
      {enableMove && showMovePlanes && (
        <>
          <GizmoPlane plane="xy" ... />
          <GizmoPlane plane="xz" ... />
          <GizmoPlane plane="yz" ... />
        </>
      )}
      
      {/* Rotation rings - visible if rotate enabled */}
      {enableRotate && ['x', 'y', 'z'].map((axis) => (
        <GizmoRing
          key={axis}
          axis={axis}
          isHovered={hoveredPart === `ring-${axis}`}
          isActive={activePart === `ring-${axis}`}
          onDragStart={() => handleDragStart(`ring-${axis}`)}
          onDrag={(angle) => handleRotate(axis, angle)}
          onDragEnd={handleDragEnd}
        />
      ))}
      
      {/* Scale cubes - visible if scale enabled */}
      {enableScale && ['x', 'y', 'z'].map((axis) => (
        <GizmoScaleCube
          key={axis}
          axis={axis}
          isHovered={hoveredPart === `scale-${axis}`}
          isActive={activePart === `scale-${axis}`}
          onDragStart={() => handleDragStart(`scale-${axis}`)}
          onDrag={(factor) => handleScale(axis, factor)}
          onDragEnd={handleDragEnd}
        />
      ))}
    </group>
  );
}
```

---

## 6. Interaction System

### Drag Detection

```typescript
// useGizmoDrag.ts
export function useGizmoDrag(
  onDragStart: () => void,
  onDrag: (delta: Vector3) => void,
  onDragEnd: () => void,
  constrainToAxis?: 'x' | 'y' | 'z',
  constrainToPlane?: 'xy' | 'xz' | 'yz',
) {
  const [isDragging, setIsDragging] = useState(false);
  const startPoint = useRef<Vector3 | null>(null);
  
  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setIsDragging(true);
    startPoint.current = e.point.clone();
    onDragStart();
  };
  
  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!isDragging || !startPoint.current) return;
    
    const delta = e.point.clone().sub(startPoint.current);
    
    // Apply constraints
    if (constrainToAxis) {
      // Zero out other axes
      if (constrainToAxis !== 'x') delta.x = 0;
      if (constrainToAxis !== 'y') delta.y = 0;
      if (constrainToAxis !== 'z') delta.z = 0;
    }
    
    if (constrainToPlane) {
      // Zero out perpendicular axis
      if (constrainToPlane === 'xy') delta.z = 0;
      if (constrainToPlane === 'xz') delta.y = 0;
      if (constrainToPlane === 'yz') delta.x = 0;
    }
    
    onDrag(delta);
    startPoint.current = e.point.clone();
  };
  
  const handlePointerUp = () => {
    setIsDragging(false);
    startPoint.current = null;
    onDragEnd();
  };
  
  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
  };
}
```

### Raycast Constraint (for supports)

```typescript
// When constrainToSurface is true
function constrainToModelSurface(
  position: Vector3,
  raycaster: Raycaster,
  modelMesh: Mesh
): Vector3 {
  // Raycast from above the position downward
  raycaster.set(
    new Vector3(position.x, position.y + 100, position.z),
    new Vector3(0, -1, 0)
  );
  
  const intersects = raycaster.intersectObject(modelMesh);
  
  if (intersects.length > 0) {
    return intersects[0].point;
  }
  
  return position; // Fallback if no hit
}
```

---

## 7. Integration Points

### Prepare Mode Integration
```typescript
// In page.tsx or PrepareMode component
{mode === 'prepare' && selectedModel && (
  <TransformGizmo
    position={modelTransform.position}
    rotation={modelTransform.rotation}
    enableMove={transformMode === 'move'}
    enableRotate={transformMode === 'rotate'}
    enableScale={transformMode === 'scale'}
    onMove={(delta) => {
      transformHook.translate(delta);
    }}
    onRotate={(axis, angle) => {
      transformHook.rotate(axis, angle);
    }}
    onScale={(axis, factor) => {
      transformHook.scale(axis, factor);
    }}
  />
)}
```

### Support Mode Integration
```typescript
// In SupportRenderer or page.tsx
{mode === 'support' && selectedSupport && (
  <TransformGizmo
    position={selectedSupport.tip}
    enableMove={true}
    enableScale={true}
    size={0.5}  // Smaller for supports
    constrainToSurface={true}
    onMove={(delta) => {
      updateSupportTip(selectedSupport.id, delta);
    }}
    onScale={(axis, factor) => {
      updateSupportDiameter(selectedSupport.id, factor);
    }}
  />
)}
```

---

## 8. Implementation Phases

### Phase 1: Core Gizmo (MVP)
- [ ] Create TransformGizmo component structure
- [ ] Implement GizmoCenter (sphere)
- [ ] Implement GizmoAxis (arrows) for X/Y/Z
- [ ] Implement basic drag detection
- [ ] Add hover/active states
- [ ] Test with prepare mode (move only)

### Phase 2: Scale Support
- [ ] Implement GizmoScaleCube
- [ ] Add scale interaction logic
- [ ] Test with prepare mode (scale)
- [ ] Add uniform scale (center sphere in scale mode)

### Phase 3: Rotation Support
- [ ] Implement GizmoRing
- [ ] Add rotation interaction logic
- [ ] Test with prepare mode (rotate)

### Phase 4: Constraints
- [ ] Add constrainToSurface (raycast)
- [ ] Add constrainToPlane (Z=0)
- [ ] Add axis locking (X/Y/Z keys)
- [ ] Test with support mode

### Phase 5: Polish
- [ ] Add smooth animations
- [ ] Add visual feedback (glow, outline)
- [ ] Optimize performance (InstancedMesh if needed)
- [ ] Add configuration presets

---

## 9. Benefits of Unified System

✅ **Consistency** - Same visual language across app  
✅ **Reusability** - Write once, use everywhere  
✅ **Maintainability** - Single place to fix bugs/add features  
✅ **Performance** - Shared geometry/materials  
✅ **Flexibility** - Easy to enable/disable features per context  
✅ **Extensibility** - Easy to add new transform types later  

---

## 10. Next Steps

1. Review and approve design
2. Decide on initial feature set (move only? move + scale?)
3. Create implementation plan with detailed tasks
4. Build Phase 1 (core gizmo with move)
5. Test in prepare mode
6. Extend to support mode
7. Add scale and rotate as needed

**Ready to proceed with implementation?**
