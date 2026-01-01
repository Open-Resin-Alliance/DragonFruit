# Contact Primitive Architecture Plan - Phase 1: The Contact Disk

## Goal
Implement the **Contact Disk ("The Nib")** as the primary contact method.
This phase focuses ONLY on the Disk implementation. The Sphere architecture is reserved for Phase 2 but the system will be built to accommodate it later.

## 1. Phase 1: Contact Disk Specification

### Visual Description
A small, flat cylinder (the "puck") that interfaces with the model.
-   **Diameter**: Exact `contactDiameterMm` (e.g., 0.4mm).
-   **Orientation**: Face is always parallel to the surface tangent (perpendicular to normal).
-   **Connection**: A tapered Cone Body connects the back of the Disk to the main Support Shaft.

### The "Smart Standoff" Logic
The key feature is variable thickness based on the surface angle to prevent the Cone Body from colliding with the model.
-   **Flat Surfaces (0-45°)**: Disk is minimal thickness (e.g. `0.1mm`). Just enough to exist.
-   **Steep Surfaces (>45°)**: Disk elongates into a "neck".
    -   Formula (Conceptual): `thickness = baseThickness + (angleFactor * maxStandoff)`
    -   This pushes the wide Cone Body back, ensuring it clears the steep wall.

---

## 2. Detailed Implementation Steps

### Step 1: Define the Data Structures
Location: `src/supports/SupportPrimitives/ContactCone/types.ts`
Action: Add `ContactDiskProfile` interface.
```typescript
export interface ContactDiskProfile {
    type: 'disk';
    diskThicknessMm: number;    // Minimum base thickness
    maxStandoffMm: number;      // Max extension length
    standoffAngleThreshold: number; // Angle (radians) where extension starts
}

// Update SupportTipProfile to include this
export interface SupportTipProfile extends ContactDiskProfile {
    // ... existing dimensions
}
```

### Step 2: Create the Primitive
Location: `src/supports/SupportPrimitives/ContactDisk/`
Files:
1.  **`contactDiskUtils.ts`**:
    -   `calculateDiskThickness(normal: Vec3, profile: ContactDiskProfile): number`
    -   Input: Normal vector.
    -   Logic: Calculate angle from vertical. If steep, interpolate thickness between `diskThicknessMm` and `maxStandoffMm`.
2.  **`ContactDiskRenderer.tsx`**:
    -   Standard R3F component.
    -   Renders a `CylinderGeometry`.
    -   Height = `calculateDiskThickness(...)`.
    -   Position = `pos + (normal * height/2)` (Centered).

### Step 3: Update the Composer (ContactCone)
Location: `src/supports/SupportPrimitives/ContactCone/ContactConeRenderer.tsx`
Action:
1.  Import `ContactDiskRenderer`.
2.  Calculate the dynamic `diskHeight` using the util.
3.  **Offset the Cone Body**:
    -   The Cone Body currently starts at `pos`.
    -   It MUST now start at `pos + (normal * diskHeight)`.
    -   This effectively "shoves" the cone back by the length of the nib.
4.  Render:
    -   `<ContactDiskRenderer ... />` at the tip.
    -   `<ConeBody ... />` starting from the offset position.

---

## 3. File Structure Changes
```text
src/supports/SupportPrimitives/
├── ContactDisk/             <-- NEW
│   ├── ContactDiskRenderer.tsx
│   ├── contactDiskUtils.ts
│   └── index.ts
├── ContactCone/             <-- MODIFIED (The Composer)
│   ├── ContactConeRenderer.tsx
│   ├── contactConeUtils.ts
│   └── types.ts
```

## 4. Verification Plan
1.  Place support on **Top** of a cube (Flat).
    -   Expect: Tiny, thin disk. Cone body right behind it.
2.  Place support on **Side** of a sphere (Steep).
    -   Expect: Long, neck-like disk. Cone body pushed away from the surface.
3.  Verify no visual gaps between Disk and Cone Body.

## 5. Isolation Rules
-   **No Leaky Logic**: The `ContactDisk` logic (calculating standoff) stays inside `ContactDisk/`. The `ContactCone` just asks "How thick are you?" to know where to start the cone.
-   **Pure Components**: Renderers should just take data and render. Math goes in `*Utils.ts`.
