# Lychee Slicer (LYS) Conversion Master Bible

**Last Updated:** December 4, 2025
**Status:** Active / In-Development

## 1. Executive Summary & Philosophy

This document serves as the single source of truth for the Lychee Slicer (`.lys`) to Dragonfruit import system. It consolidates all previous architectural notes, roadmaps, and mapping strategies into one comprehensive guide.

### The "Smart Retargeting" Philosophy
Our approach is **High-Fidelity Mapping** to Dragonfruit's native system.
1.  **System Logic**: We use Dragonfruit's *logic* for how components behave (e.g., Roots, Base Flares, Joint visualization).
2.  **Instance Data**: We use Lychee's *data* for critical dimensions (Positions, Angles, Diameters, Lengths).

**Correction:** We DO replicate Lychee's visual settings (Diameters, Lengths) by mapping them to the specific properties of the generated Dragonfruit support instances.
*   If Lychee has a 0.8mm tip, the imported Dragonfruit support will have a 0.8mm tip.
*   If Lychee has a 5mm shaft, the imported support will have a 5mm shaft.

**Goal:** The imported support is a native Dragonfruit entity "hydrated" with Lychee's specific dimensions. It is fully editable and behaves like a support the user placed manually with those specific settings.

---

## 2. Technical Architecture

### 2.1 The Coordinate System Challenge
Lychee uses a complex, implicit coordinate system that combines "Object Space", "World Space", and "Intrinsic Offsets". Dragonfruit uses a pure Z-Up World Space.

#### The "Golden Rule" of Transformation
Lychee objects possess a `center` property that is NOT just metadata—it is an **Intrinsic Geometric Offset**. To align our Normalized STL (Bottom-Centered at 0,0,0) with Lychee's data, we apply the following transform:

```typescript
FinalPosition = Position + (Center * Scale)
```

*   `Position`: The explicit translation from the JSON.
*   `Center`: The implicit offset vector from the JSON.
*   `Scale`: The scaling vector.

#### Point Transformation Logic
Supports in Lychee are stored in mixed spaces:

1.  **Support Tip (Contact Point)**:
    *   Stored in **Local Object Space**.
    *   Formula: `WorldTip = (LocalTip + Center) * Scale + Position`
2.  **Support Base (Root Point)**:
    *   Stored in a hybrid World Space relative to the Object Position.
    *   Formula: `WorldBase = Position + LocalBase` (simplified for X/Y).
    *   *Note: Z-height scaling logic handles the difference between "Floor" and "Object" relative heights.*

### 2.2 Data Models

#### Lychee (Source)
A flat list of entities with loose references.
*   **Format**: JSON (`scene.decrypted.json`).
*   **Structure**: `supports.present.byId` (Map of ID -> Support).
*   **Key Fields**:
    *   `base`: {x,y,z}
    *   `tip`: {x,y,z}
    *   `parentId`: String[] (Implicit hierarchy).
    *   `settings`: **CRITICAL**. Contains overrides for `tip.diameter`, `base.joinDiameter` (shaft), etc.

#### Dragonfruit (Target)
A strictly typed, graph-based structure defined in `AnatomyOfSupports`.
*   **Roots**: The anchor on the build plate. (Disk + Cone).
*   **Trunk**: Main vertical column. (List of Segments).
*   **Branch**: Child column originating from another support.
*   **Knot**: The connection point on a parent shaft.
*   **Contact Cone**: The interface with the model.

### 2.3 System Anatomy & Nomenclature (The Rosetta Stone)

To avoid confusion with Lychee's internal naming (e.g., `baseTip`), we use the following standardized mapping to Dragonfruit's anatomy.

| Concept | Lychee JSON Term | Dragonfruit Anatomy | Description |
| :--- | :--- | :--- | :--- |
| **The Foot** | `base` | **Roots** | The anchor point on the build plate (Disk + Transition Cone). |
| **First Segment** | `baseTip` | **Segment 0** | The vertical shaft segment connecting the Roots to the first Joint. |
| **First Joint** | *Implicit* (Top of `baseTip`) | **Joint 0** | The spherical joint where the first segment ends and the main shaft begins. |
| **Main Shaft** | `mid` | **Segment 1** | The main shaft segment connecting Joint 0 to the Contact Cone. |
| **The Head** | `tip` | **Contact Cone** | The connection assembly (Cone + Sphere) touching the model. |
| **The Socket** | *Implicit* (Bottom of `tip`) | **Socket Joint** | The point where the Shaft connects to the Head. |

**Note on "baseTip"**: In Dragonfruit terms, this defines the geometry of **Segment 0**. It dictates the height of the first **Joint** (Joint 0) relative to the Roots.

---

## 3. Conversion Logic (The Pipeline)

The conversion process is compartmentalized in `src/features/lys-conversion/`.

### Phase 1: Pre-Processing
1.  **Load JSON**: Parse `.lys` (or decrypted JSON).
2.  **Extract Transform**: Identify the target object and calculate the `Position`, `Scale`, and `Center`.
3.  **Load STL**: User provides the STL file.
4.  **Normalize & Align**: The STL is loaded, normalized to bottom-center, and then the "Golden Rule" transform is applied to visually match the Lychee scene.

### Phase 1.5: Ghost Mesh for Surface Alignment (Raycast Snap)

To ensure Contact Disks are placed **flush** on the model surface (not floating or buried), we create an invisible "Ghost Mesh" and raycast against it.

#### The Problem
Lychee's tip coordinates are often slightly off the actual surface due to slicer tolerances. We need to "snap" the tip to the exact surface point and capture the surface normal for correct disk orientation.

#### The Solution: Ghost Mesh + Raycast
1.  **Create Ghost Mesh**: In `useLycheeImport.ts`, we spawn a temporary `THREE.Mesh` using the loaded STL geometry.
2.  **Replicate Visual Transform**: The ghost mesh MUST be positioned identically to the visible `StlMesh` component.
3.  **Raycast**: For each support, cast a ray from the Socket towards the Tip. The intersection point becomes the snapped position; the face normal becomes the `surfaceNormal`.

#### Ray Origin: Start at Socket (v69 Fix)
The ray **MUST** originate at the Socket Joint, not far behind it.

**Why?** If the ray starts 50mm behind the socket, it will hit the **outer wall** of hollow geometry (cylinders, tubes) before reaching the actual contact point on the inner surface. Starting at the socket ensures the ray only travels through the cone's path and hits the correct surface.

#### CRITICAL: The Center Offset Bug (v12 Fix)

The visible `StlMesh` component uses a **nested transform structure**:
```
<group position={finalPosition} rotation={finalRotation} scale={finalScale}>
  <mesh position={-geometry.center} />  <!-- Center offset! -->
</group>
```

The ghost mesh MUST replicate this hierarchy:
```typescript
// useLycheeImport.ts
const ghostGroup = new THREE.Group();
ghostGroup.position.copy(finalPosition);
ghostGroup.scale.copy(finalScale);
ghostGroup.rotation.copy(finalRotation);

const mesh = new THREE.Mesh(geometry.geometry, material);
mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z); // CRITICAL!

ghostGroup.add(mesh);
ghostGroup.updateMatrixWorld(true);
```

**Without the center offset**, the ghost mesh is displaced from the visible mesh, causing all raycasts to MISS.

### Phase 2: Entity Mapping (Retargeting)

The `LysConverter.convert` function takes the Lychee Data and the **Current Dragonfruit Settings** (as defaults).

#### 3.1 Roots & Trunks (Type 1 - Grounded)
Supports with `parentBaseId: null` are Roots.
1.  **Placement**:
    *   Base/Tip Positions calculated using transforms.
    *   **Base Transform**: Use `v.x + pos.x` (World Relative to Object Pos, Z is Floor).
    *   **Tip Transform**: Use `(v + center) * scale + pos` (Full Object Space).
2.  **Trunk Construction (Joint 0 Logic)**:
    *   **Joint 0 (The Knee)**: Placed explicitly at the top of the Dragonfruit Root visual structure.
    *   **Z Calculation**: `Root.z + TotalBaseHeight` (e.g., 0.8mm). We **IGNORE** Lychee's `baseTip.length` for positioning to prevent the "High Knee" issue on scaled supports.
    *   **Result**: Segment 0 is embedded in the root or just above it, ensuring the shaft emerges cleanly.
3.  **Socket Placement (Vertical Priority)**:
    *   Lychee supports typically feature a vertical main shaft with an angled tip cone.
    *   **Logic**:
        *   Calculate Horizontal Distance (`H`) between Knee and Tip.
        *   If `H <= TipLength`: **Force Vertical**. Place Socket directly above Knee. `Socket.z = Tip.z - sqrt(TipLen^2 - H^2)`.
        *   If `H > TipLength`: **Fallback to Lean**. Project Socket from Tip towards Knee.
4.  **Geometry Mapping (Hydration)**:
    *   **Shaft Diameter**: `Lychee.settings.base.joinDiameter` -> `Trunk.segment.diameter`.
    *   **Tip Diameter**: `Lychee.settings.tip.diameter` -> `Trunk.contactCone.profile.bodyDiameterMm`.
    *   **Tip Length**: `Lychee.settings.tip.length` -> `Trunk.contactCone.profile.lengthMm`.
    *   **Roots**: Use Dragonfruit Global Defaults (Diameter/Height). *Reason: Lychee roots are often mesh-based or malformed; we prefer clean Dragonfruit roots.*
5.  **Reactivity**:
    *   Generated supports are standard Dragonfruit data structures.
    *   They react to "Base Flare" toggles because the *Renderer* observes the global setting.
    *   They are editable because they are valid `Trunk` objects.

#### 3.2 Branches (Type 1 - Child) - *IN PROGRESS*
Supports with `parentBaseId: "sXXX"` are Branches.
1.  **Dependency Order**: Must process Parents before Children.
2.  **Knot Calculation**:
    *   The child's `base` point in Lychee is a point in space.
    *   We project this point onto the **Parent's Shaft Segment**.
    *   We calculate the `t` value (0.0 - 1.0) along the segment.
3.  **Creation**:
    *   Create a `Knot` on the parent at `t`.
    *   Create a `Branch` entity linked to that Knot.
    *   **Style**: Inherit diameter from Lychee settings (just like Trunks).

#### 3.3 Braces (Type 0) - *PLANNED*
Supports connecting two existing supports.
*   Lychee: `parentBaseId` (Start) and `parentTipId` (End).
*   Dragonfruit: `Brace` entity connecting `Knot A` (Start) to `Knot B` (End).

---

## 4. Entity Mapping Table

| Lychee Property | Dragonfruit Property | Logic |
| :--- | :--- | :--- |
| `settings.baseTip` | **Joint 0** | Defines the location of the first joint above roots. |
| `settings.baseTip.length` | `Joint.z` (Offset) | Adds to Root Z + Base Z to find Joint 0 Height. |
| `settings.baseTip.diameter` | `Segment[0].diameter` | Diameter of the first segment (Roots -> Joint 0). |
| `settings.base.joinDiameter` | `Segment[1].diameter` | Diameter of the main shaft (Joint 0 -> Socket). |
| `settings.tip.diameter` | `ContactCone.profile.bodyDiameterMm` | Upper tip thickness. |
| `settings.tip.pointDiameter` | `ContactCone.profile.contactDiameterMm` | Contact point thickness. |
| `settings.tip.length` | `ContactCone.profile.lengthMm` | Length of the tip cone/disk. |
| `base` (Coordinates) | `Roots.transform.pos` | Ground position. |
| `tip` (Coordinates) | `ContactCone.pos` | Contact position. |

---

## 5. Implementation Status & Roadmap

### ✅ Completed
*   **File Processing**: JSON parsing and STL normalization.
*   **Coordinate Transforms**: The "Golden Rule" is verified and working.
*   **Roots & Trunks**: Type 1 supports generate correctly.
*   **Reactivity**: Base Flare settings update imported supports live.
*   **Surface Alignment (v12)**: Ghost Mesh raycast snaps Contact Disks flush to model surface with correct normals.

### 🚧 In Progress
*   **Dimension Mapping**:
    *   [ ] Update `LysConverter` to use `Lychee.settings` for diameters/lengths instead of overriding with global defaults.
*   **Branching Logic**:
    *   [ ] Implement Topological Sort (or Two-Pass) for dependency handling.
    *   [ ] Implement "Point-to-Segment" projection math for Knot placement.
    *   [ ] Update `LysConverter` to generate `Branches` instead of `Trunks` for children.

### 📅 Planned
*   **Bracing**:
    *   [ ] Map Type 0 supports to Brace entities.
*   **Optimization**:
    *   [ ] Handle large file performance (thousands of supports).
*   **Branching Logic**:
    *   [ ] Implement Topological Sort (or Two-Pass) for dependency handling.
    *   [ ] Implement "Point-to-Segment" projection math for Knot placement.
    *   [ ] Update `LysConverter` to generate `Branches` instead of `Trunks` for children.

### 📅 Planned
*   **Bracing**:
    *   [ ] Map Type 0 supports to Brace entities.
*   **Optimization**:
    *   [ ] Handle large file performance (thousands of supports).
