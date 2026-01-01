# Dynamic Raft Design Specification

## Overview
A dynamically-shaped sacrificial raft that minimizes footprint while providing optimal adhesion and suction relief for resin 3D printing. The raft automatically encompasses all support bases with chamfered edges and a crenulated perimeter wall.

## Raft Structure

### Base Plate
- **Thickness**: 0.5mm (default, adjustable)
- **Shape**: Dynamically computed to minimize footprint
- **Coverage**: Encompasses all support bases with minimal excess area
- **Top surface**: Flat platform for support bases to sit on
- **Bottom surface**: Contacts build plate

### Chamfered Edges
- **Purpose**: Reduce peel forces and improve adhesion
- **Direction**: Always angles outward (wider at top than bottom)
- **Angle range**: 90° (vertical) to 45° (maximum outward angle)
- **Default angle**: TBD (suggest 60-70° for balance)
- **Application**: Applied to entire outer perimeter of raft

### Perimeter Wall
- **Location**: Around the outer edge of the raft
- **Integration**: Integrated into edge (whichever is simpler to implement)
- **Height**: TBD (suggest 0.3-0.5mm above raft surface)
- **Thickness**: Adjustable, thicker than base raft
- **Outer face**: Follows the same chamfer angle as raft edge
- **Pattern**: Crenulated (castellated) with regular gaps

### Crenulation (Suction Relief)
- **Purpose**: Allow resin/air to escape during peel, reducing suction forces
- **Pattern**: Alternating solid sections (merlons) and gaps (crenels)
- **Controls**:
  - Gap spacing (distance between relief slots)
  - Gap width (how wide each relief slot is)
  - Merlon width (solid section between gaps)
- **Application**: Only on perimeter wall, not on interior

## Dynamic Footprint Algorithm

### Requirements
1. **Input**: Array of support base positions and radii
2. **Output**: Minimal 2D shape that encompasses all bases
3. **Constraints**:
   - Every support base must be fully contained within raft
   - Minimize total raft area to reduce material waste
   - Maintain smooth, printable perimeter

### Approach Options
1. **Convex hull** - Simplest, may include excess area
2. **Alpha shape** - Better fit for scattered supports
3. **Union of circles + offset** - Precise coverage with buffer zone
4. **Voronoi-based boundary** - Complex but optimal

**Recommended**: Start with convex hull for MVP, optimize later if needed

## UI Requirements

### New Control Card: "Raft Settings"
**Location**: Support settings sidebar (left panel)

**Controls**:
1. **Enable Raft** - Toggle checkbox (default: enabled)
2. **Raft Thickness** - Numeric input with slider (0.1-2.0mm, default 0.5mm)
3. **Edge Chamfer Angle** - Numeric input with slider (45-90°, default 60°)
4. **Wall Height** - Numeric input with slider (0.1-1.0mm, default 0.3mm)
5. **Wall Thickness** - Numeric input with slider (0.2-2.0mm, default 0.8mm)
6. **Crenulation Gap Width** - Numeric input with slider (0.5-3.0mm, default 1.5mm)
7. **Crenulation Spacing** - Numeric input with slider (2.0-10.0mm, default 5.0mm)

**Visual feedback**: Live preview updates in 3D scene as settings change

## Technical Implementation

### Geometry Generation

#### Base Plate
1. Compute 2D footprint from support base positions
2. Extrude footprint to raft thickness
3. Position at Z=0 (build plate level)

#### Chamfered Edge
1. Create inner profile (top surface of raft)
2. Create outer profile (bottom surface, offset by chamfer)
3. Connect profiles with angled faces
4. Angle calculation: `offset = thickness * tan(90° - chamferAngle)`

#### Perimeter Wall
1. Offset inner profile outward by wall thickness
2. Extrude upward by wall height
3. Apply same chamfer angle to outer face
4. Generate crenulation pattern along perimeter

#### Crenulation Pattern
1. Divide perimeter into segments based on spacing
2. Alternate solid (merlon) and gap (crenel) sections
3. Gap width determines size of relief slots
4. Ensure gaps cut through full wall height

### Data Structure

```typescript
interface RaftSettings {
  enabled: boolean;
  thickness: number;           // mm
  chamferAngle: number;        // degrees (45-90)
  wallHeight: number;          // mm
  wallThickness: number;       // mm
  crenulationGapWidth: number; // mm
  crenulationSpacing: number;  // mm
}

interface RaftGeometry {
  baseProfile: Vector2[];      // 2D footprint points
  baseMesh: THREE.Mesh;         // Main raft plate
  wallMesh: THREE.Mesh;         // Perimeter wall with crenulations
  boundingBox: THREE.Box3;      // For collision detection
}
```

## Development Checklist

### Phase 1: Foundation
- [ ] Create `src/supports/Raft/` directory structure
- [ ] Create `raftTypes.ts` with RaftSettings and RaftGeometry interfaces
- [ ] Create `raftDefaults.ts` with default settings values
- [ ] Add raft state to main page.tsx or support context
- [ ] Create RaftSettings control card component in `src/supports/Raft/components/RaftSettingsCard.tsx`

### Phase 2: Footprint Calculation
- [ ] Create `src/supports/Raft/geometry/computeFootprint.ts`
- [ ] Implement convex hull algorithm for support base positions
- [ ] Add buffer/margin around hull for safety clearance
- [ ] Test with various support configurations
- [ ] Add unit tests for edge cases (single support, collinear supports, etc.)

### Phase 3: Base Plate Geometry
- [ ] Create `src/supports/Raft/geometry/generateBasePlate.ts`
- [ ] Convert 2D footprint to THREE.Shape
- [ ] Extrude to raft thickness
- [ ] Position at Z=0
- [ ] Apply material and rendering properties

### Phase 4: Chamfered Edge
- [ ] Create `src/supports/Raft/geometry/generateChamferedEdge.ts`
- [ ] Calculate offset based on thickness and angle
- [ ] Generate inner and outer profiles
- [ ] Create angled connecting faces
- [ ] Merge with base plate geometry

### Phase 5: Perimeter Wall
- [ ] Create `src/supports/Raft/geometry/generatePerimeterWall.ts`
- [ ] Offset profile for wall thickness
- [ ] Extrude upward by wall height
- [ ] Apply chamfer to outer face
- [ ] Ensure proper connection to base plate

### Phase 6: Crenulation Pattern
- [ ] Create `src/supports/Raft/geometry/generateCrenulations.ts`
- [ ] Calculate perimeter length and segment positions
- [ ] Generate alternating solid/gap pattern
- [ ] Cut gaps through wall geometry (CSG or vertex manipulation)
- [ ] Ensure gaps are printable (no floating geometry)

### Phase 7: Rendering Component
- [ ] Create `src/supports/Raft/rendering/RaftVisualization.tsx`
- [ ] Render base plate mesh
- [ ] Render perimeter wall mesh
- [ ] Apply appropriate materials (semi-transparent for preview?)
- [ ] Handle visibility toggle
- [ ] Integrate with scene transforms

### Phase 8: Integration
- [ ] Add raft state management to page.tsx or support context
- [ ] Connect RaftSettingsCard to state
- [ ] Trigger raft regeneration when settings or supports change
- [ ] Add raft to SceneCanvas rendering
- [ ] Ensure raft updates when supports are added/removed/moved

### Phase 9: Polish & Optimization
- [ ] Add debouncing for live preview updates
- [ ] Optimize geometry generation for performance
- [ ] Add visual feedback during regeneration
- [ ] Implement raft export for STL output
- [ ] Add raft statistics to model info overlay (area, volume, etc.)
- [ ] Create documentation in `Documentation/` folder

### Phase 10: Testing & Validation
- [ ] Test with single support
- [ ] Test with multiple scattered supports
- [ ] Test with clustered supports
- [ ] Test with linear arrangements
- [ ] Verify chamfer angles render correctly
- [ ] Verify crenulations are evenly spaced
- [ ] Test extreme settings values
- [ ] Validate printability of generated geometry

## Future Enhancements (Post-MVP)
- [ ] Smart footprint optimization (alpha shapes, better algorithms)
- [ ] Raft texture/pattern on top surface for better adhesion
- [ ] Drainage holes in large flat areas
- [ ] Multiple raft islands for widely separated support groups
- [ ] Raft strength analysis and warnings
- [ ] Custom raft shapes (rectangular, circular, user-defined)
- [ ] Raft presets for different printer/resin combinations

## Notes
- Raft always sits at Z=0 (build plate level)
- Support bases should sit on top of raft surface (Z = raftThickness)
- Chamfer angle never goes inward, only outward (45-90°)
- Crenulations are for suction relief in resin printing
- All dimensions in millimeters
- Follow domain-first organization: `src/supports/Raft/`

## References
- Support Types documentation: `Documentation/4. SupportTypes.md`
- Project README: `1. README.md`
- Existing support structure: `src/supports/`
