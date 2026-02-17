# Lychee Slicer (LYS) Conversion Master Bible

**Last Updated:** February 15, 2026  
**Status:** Canonical Reference (Current Workflow)

## 1) Purpose

This document is the exact, implementation-aligned reference for Dragonfruit LYS import behavior.

This document defines:
- the authoritative transform order,
- ownership routing,
- support reconstruction rules,
- and exact field-level semantics used for parity with Lychee.

This document is **not** a roadmap. It is a behavioral contract.

---

## 2) Canonical Nomenclature (Use These Terms)

To avoid ambiguity, use the names below consistently:

1. **Root / Foot**
   - Dragonfruit: `Roots`
   - Lychee source fields: `base`, `settings.base.*`
   - Platform-anchored support origin.

2. **Knee Joint** (the one user identified visually)
   - Dragonfruit: first trunk joint above root (`joint0`)
   - Visible knee height source: `settings.base.joinLength`

3. **Tip Cone Joint** (user terminology; also called Socket Joint)
   - Dragonfruit: `socketJoint` at base of contact cone
   - Solved from tip position, tip length, and cone axis normal.

4. **Tip Contact Point**
   - Dragonfruit: `contactCone.pos`
   - Lychee source: `tip`

5. **Cone Axis / Tip Orientation**
   - Dragonfruit: `contactCone.normal`
   - Lychee source: `tipNormal` (transformed into object-applied support space)

---

## 3) End-to-End Import Contract

### 3.1 Primary Input
- Import from `.lys` scene.
- No external Python converter is required in the canonical path.

### 3.2 Two-Stage Transform Contract

1. **Stage A (support reconstruction frame):**
   - Use per-object transform context.
   - Apply object **scale**, then **rotation**, then **position.z** to support payload points.
   - Reconstruct supports (roots/trunks/branches/braces/leaves) in this model-private interpretation.

2. **Stage B (world placement):**
   - Apply only object `position.x` and `position.y` to generated entities.
   - Do not re-solve support geometry from Stage B translation.

### 3.3 Pivot Policy
- Canonical pivot field: `formerCenter`.
- Fallback chain: `formerCenter` -> `center` -> `{ x: 0, y: 0, z: 0 }`.

---

## 4) Ownership and Grouping Rules

## 4.1 Object Scope
- Never assume single-object scenes.

### 4.2 Support Ownership Priority
For each support, ownership resolution is deterministic:
1. If `objectIdTip` resolves to an existing object, use it.
2. Else if `objectIdBase` resolves to an existing object, use it.
3. Else use fallback object (preferred `o15`, else first object with `supportsBase`, else first object id).

### 4.3 Mixed Ownership
- If both `objectIdTip` and `objectIdBase` exist and differ, importer logs a warning and uses `objectIdTip`.

---

## 5) Exact Transform Math Used for Support Geometry

## 5.1 Point Transform (`base` / `tip` payload)
For object-scoped support points:
- Start from source payload point `(x, y, z)`.
- Multiply by object scale.
- Apply object quaternion (`XYZ` euler-derived).
- Add object lift vector `(0, 0, position.z)`.

### 5.2 Root Base Special-Case Transform
Root/base XY is intentionally treated differently:
- Start from `(base.x, base.y, 0)`.
- Apply only object scale on XY.
- Do **not** rotate base XY for floor anchoring logic.

### 5.3 Normal Transform (`tipNormal`)
When `tipNormal` exists:
- Build vector from payload as-is `(x, y, z)`.
- Apply inverse scale per component.
- Apply object quaternion.
- Normalize.

This transformed normal is the preferred normal for tip cone socket solving.

---

## 6) Root/Trunk Synthesis Contract

### 6.1 Root Entity
- Root position: `{ x: transformedBaseX, y: transformedBaseY, z: 0 }`.
- Root remains explicitly floor-anchored.

### 6.2 Diameter Sources
- Trunk pillar diameter priority:
  1. `settings.base.joinDiameter`
  2. `settings.tip.diameter`
  3. Dragonfruit shaft default

### 6.3 Knee Joint vs Tip Solve Anchor (Critical)
Lychee contains two relevant knee-related values:
- `settings.base.joinLength`
- `settings.base.newJoinLength`

Importer uses them for **different purposes**:

1. **Visible Knee Joint Height**
   - Source priority: `joinLength`, fallback `newJoinLength`, then fallback to root cap height.
   - Clamped to be above root cap by small epsilon.

2. **Tip Cone Solve Anchor Height**
   - Source priority: `newJoinLength`, fallback `joinLength`, then fallback to root cap height.
   - Used for contact cone/socket solve start position.

This split is intentional and required for current Lychee visual parity.

### 6.4 Root Trunk Segment Structure
Current trunk from root is two straight segments:
1. Root-top -> Knee joint (`joint0`)
2. Knee joint -> Tip cone joint (`socketJoint`)

---

## 7) Contact Assembly (Tip Cone) Contract

Contact assembly is shared across roots and branches.

### 7.1 Inputs
- Tip point (`tipWorld`)
- Start/anchor point (knee solve point for roots, knot point for branches)
- Tip settings (`length`, `diameter`, `pointDiameter`)
- Optional transformed Lychee tip normal

### 7.2 Tip Cone Joint (Socket Joint) Solve
If a valid Lychee normal is present:
1. Normalize the normal.
2. Build two candidate axes (`+n`, `-n`).
3. Build two candidate socket points at `tip + axis * tipLength`.
4. Pick candidate whose socket is closer to start anchor.

If no valid Lychee normal:
- Use geometric fallback from start->tip vector and tip length constraints.

### 7.3 Strict Lychee Coordinate Mode
Current root and branch import calls use strict mode:
- Do not raycast-adjust tip point.
- Do not apply contact disk standoff offset.
- Trust Lychee tip payload and normal directly.

Result:
- `contactCone.pos` remains the Lychee tip position in transformed support space.
- `socketJoint` is aligned from that tip by solved cone axis and fixed tip length.

---

## 8) Branch / Leaf / Brace Classification Rules

### 8.1 Parent Inference
Parent ids are read from:
- `parentId` (array/string/number variants)
- fallback from `parentBaseId` + `parentTipId`

### 8.2 Type Classification
- Parent count = 0 -> root candidate
- Parent count = 1 -> branch candidate
- Parent count >= 2 -> brace candidate

### 8.3 Leaf Threshold
For single-parent children:
- Compute shaft length = distance(knot, tipPoint) - tipLength
- If shaft length <= `0.2`, classify as leaf; else branch

---

## 9) Stage B World XY Placement Rules

After each object slice is reconstructed:
- Apply object XY offset to:
  - root positions,
  - trunk/branch joints,
  - branch bezier control points,
  - cones,
  - leaves,
  - knots.

Joint IDs are deduplicated during shift to avoid double-translation.

---

## 10) Field-Level Reference (What Matters)

### 10.1 Object Fields
- `objects.present.byId.<id>.position`
- `objects.present.byId.<id>.rotation`
- `objects.present.byId.<id>.scale`
- `objects.present.byId.<id>.formerCenter` / `center`

### 10.2 Support Fields (Geometry-Relevant)
- `supports.present.byId.<id>.base`
- `supports.present.byId.<id>.tip`
- `supports.present.byId.<id>.tipNormal`
- `supports.present.byId.<id>.settings.base.joinLength`
- `supports.present.byId.<id>.settings.base.newJoinLength`
- `supports.present.byId.<id>.settings.base.joinDiameter`
- `supports.present.byId.<id>.settings.tip.length`
- `supports.present.byId.<id>.settings.tip.diameter`
- `supports.present.byId.<id>.settings.tip.pointDiameter`
- `supports.present.byId.<id>.objectIdTip` / `objectIdBase`
- `supports.present.byId.<id>.parentId` / `parentBaseId` / `parentTipId`

### 10.3 Metadata / Noise Fields (Usually Non-Geometry)
- `updatedAt`
- `slicerSettingsUpdatedAt`
- `supports.present.changedIds`

---

## 11) Validation Protocol (Required)

1. **World-Position-Only Diff Test**
   - Move model in Lychee plate XY.
   - Expect object `position` changes.
   - Expect support payload (`base`, `tip`, `tipNormal`, key lengths) unchanged.

2. **Knee Parity Check (Side View)**
   - Verify visible knee matches `settings.base.joinLength` height behavior.
   - Verify tip cone joint remains fixed-length from tip contact point.

3. **Tip Normal Orientation Check**
   - Confirm cone axis follows transformed Lychee tip normal direction (with sign chosen by nearest anchor candidate).

4. **Multi-Object Ownership Check**
   - Mixed-object support scenes must route by `objectIdTip`/`objectIdBase` and place each object slice with its own Stage B XY.

---

## 12) Operational Rules (Do Not Violate)

1. Prefer direct Lychee fields over inferred heuristics.
2. Keep Stage A reconstruction and Stage B placement separate.
3. Keep root floor anchoring explicit.
4. Keep Z-up interpretation in docs.
5. Treat this document as canonical; log experiments in Scratch docs.

Related experiment logs:
- `Scratch/LYS_Import_Coordinate_Findings.md`
- `Scratch/LYS_TipCone_Baseline_V1.md`
- `Scratch/LYS_Importer_OnePass_Development_Plan.md`
