# Lychee to Dragonfruit Support Mapping & Architecture

## Overview
This document serves as the architectural blueprint for the new Dragonfruit support system. It is based on the "Anatomy of Supports" modular design and dictates how Lychee Slicer (LYS) data will be mapped into this new structure.

## 1. Dragonfruit Data Model (The Target)
Based on the `AnatomyOfSupports` documentation, the new system is modular and graph-based.

### Core Entities
*   **Roots**: The anchor point on the build plate/raft.
    *   *Properties*: Transform (Pos, Rot), Diameter, Height.
*   **Trunk**: A support column originating from Roots.
    *   *Properties*: List of Segments (Shafts + Joints).
*   **Branch**: A support column originating from a Knot on another support.
    *   *Properties*: Parent Knot ID, List of Segments.
*   **Brace**: A stabilizer connecting two supports.
    *   *Properties*: Start Knot ID, End Knot ID, Shaft Profile.
*   **Knot (Anchor)**: A connection point on a Shaft.
    *   *Properties*: Parent Shaft ID, T-value (position along shaft), Rotation.
*   **Joint**: A spherical break between Shaft segments.
    *   *Properties*: Position, Diameter.
*   **Contact Cone**: The interface with the model.
    *   *Properties*: Tip Position, Normal, Dimensions.

## 2. Lychee Data Mapping (The Source)
Lychee data (`scene.decrypted.json`) is a flat list of support entities with parent references.

### Entity Mapping Table

| Lychee Entity | Lychee Properties | Dragonfruit Entity | Mapping Logic |
| :--- | :--- | :--- | :--- |
| **Type 1 (Root)** | `parentBaseId: null`, `isBaseTip: false` | **Trunk + Roots** | Create `Roots` at `base`. Create `Trunk` extending to `tip`. |
| **Type 1 (Child)** | `parentBaseId: "sXXX"`, `isBaseTip: true` | **Branch** | Create `Knot` on parent `sXXX`. Create `Branch` from Knot to `tip`. |
| **Type 0** | `parentBaseId: "sXXX"`, `parentTipId: "sYYY"` | **Brace** | Create `Knot A` on `sXXX`. Create `Knot B` on `sYYY`. Create `Brace` between them. |
| **Mini Support** | `"mini": true` | **Trunk/Branch** | Map to `Trunk` or `Branch` but use "Mini" Preset settings (thinner diameters). |
| **Coordinates** | `base: {x,y,z}`, `tip: {x,y,z}` | **World Space** | **CRITICAL**: Lychee coords are relative to Object Center. `DF_Pos = Obj_Center + LYS_Pos`. |

## 3. Conversion Algorithm

### Step 1: Pre-processing
1.  **Load Objects**: Identify the target model and get its `Center` coordinates.
2.  **Index Supports**: Create a lookup map of all Lychee supports by ID.
3.  **Sort by Dependency**: Process supports in topological order (Parents before Children).

### Step 2: Entity Creation
1.  **Iterate Sorted Supports**:
    *   **If Type 1 & No Parent**:
        *   Instantiate `Roots` at `ObjectCenter + base`.
        *   Instantiate `Trunk` segment from `Roots` to `ObjectCenter + tip`.
        *   Attach `Contact Cone` at `tip` if touching model.
    *   **If Type 1 & Has Parent**:
        *   Find Parent Support in Dragonfruit format.
        *   Calculate `Knot` position on Parent Shaft closest to `ObjectCenter + base`.
        *   Instantiate `Knot` at that position.
        *   Instantiate `Branch` from `Knot` to `ObjectCenter + tip`.
    *   **If Type 0 (Brace)**:
        *   Find Start Parent (`parentBaseId`) and End Parent (`parentTipId`).
        *   Instantiate `Knot A` on Start Parent and `Knot B` on End Parent.
        *   Instantiate `Brace` connecting A and B.

### Step 3: Geometry Reconstruction
*   **Shafts**: Lychee supports are often single segments. Dragonfruit supports can be multi-segment. Initially, map 1 Lychee support = 1 Shaft segment.
*   **Joints**: If Lychee `settings` imply curvature or if `mid` points exist (rare in basic LYS), insert `Joints`.
*   **Diameters**: Map `settings.base.diameter`, `settings.tip.diameter` to Dragonfruit profile settings.

## 4. Implementation Plan

### Phase 1: Data Structures
*   [ ] Refactor `types.ts` to strictly follow the `AnatomyOfSupports` (separate interfaces for Roots, Trunk, Branch, Brace, Knot).
*   [ ] Deprecate the generic `SupportInstance` in favor of specific types (`TrunkInstance`, `BranchInstance`, etc.).

### Phase 2: LYS Importer
*   [ ] Create `LycheeImporter` class.
*   [ ] Implement coordinate transformation logic (`World = Center + Local`).
*   [ ] Implement the "Type 1" (Trunk/Branch) builder.
*   [ ] Implement the "Type 0" (Brace) builder.

### Phase 3: Visualization & Verification
*   [ ] Update `SupportRenderer` to handle the new specific types.
*   [ ] Verify imported supports visually match Lychee (position, thickness, hierarchy).

## 5. Key Decisions & Rules
*   **Coordinate System**: Always convert to World Space immediately upon import.
*   **Immutability**: Imported Lychee supports should be editable native Dragonfruit supports, not a special "read-only" type.
*   **Validation**: If a Lychee parent is missing, the child is orphaned (maybe convert to a Trunk rooted at its base position).
