# Contact Primitive Architecture Plan - Phase 2: The Contact Sphere

## Goal
Implement the **Contact Sphere ("The Cap")** as an alternative contact method.
This method uses a spherical buffer object to create a consistent circular contact patch while naturally providing offset from the model.

## 1. The Concept: "The Ball Joint"

Instead of a complex mathematical intersection, visualize a **Ball Bearing** glued to the model surface.
-   The **Sphere** acts as a universal adapter. It sits on the surface.
-   The **Support Cone** connects to the back of the sphere, like a socket.
-   The **Bulk** of the sphere physically pushes the connection point away from the model, creating the necessary "Standoff" gap.

### Why this works for Steep Angles
-   A flat cone tip would intersect an angled wall as an **Oval** (Oblong).
-   A Sphere intersecting a flat plane (the wall) is **ALWAYS a Circle**.
-   **Natural Standoff:** If the sphere is large enough, it protrudes like a doorknob. The support shaft can connect to the back of this "doorknob" without clipping the wall, even at steep angles.

## 2. The Geometry Logic

### A. Contact Diameter vs Sphere Size
To ensure the contact scar is exactly the target size (e.g., 0.4mm), the Sphere must be **Larger** than the contact size.
-   **Sphere Radius ($R$)**: Must be $> r_{contact}$.
-   **Penetration ($d$)**: We "dip" the sphere into the model just enough to get the target ring size.

### B. Variable Sizing (Future Logic)
While the sphere naturally handles many angles, extreme angles might require **Scaling**.
-   **Scenario:** Very steep angle (near 90°).
-   **Problem:** A standard sphere might not stick out far enough to prevent the shaft from hitting the wall.
-   **Solution:** Dynamically scale the Sphere Radius up.
    -   Larger Sphere = More Protrusion = More Standoff.
    -   We simply adjust the Penetration $d$ to maintain the *same* contact size despite the larger sphere.

## 3. Proposed Specification

### Visual Description
A smooth sphere partially embedded in the model.
-   **Look:** Like a ball joint or organic connection.
-   **Connection:** The Support Cone intersects the sphere surface.

### Data Structure
```typescript
export interface ContactSphereProfile {
    type: 'sphere';
    // Base ratio: How much bigger is the sphere than the contact spot?
    // e.g. 1.5x means for a 0.4mm contact, we use a 0.6mm sphere.
    sphereRadiusRatio: number; 
    
    // Optional: Logic to scale up at steep angles
    enableAngleScaling?: boolean; 
    maxScaleRatio?: number; 
}
```

## 4. Comparison to Disk
-   **Disk**: "Active" Standoff. The nib grows/shrinks explicitly. Precise, engineering look.
-   **Sphere**: "Passive" Standoff. The sphere's bulk creates the gap. Organic, robust look.
