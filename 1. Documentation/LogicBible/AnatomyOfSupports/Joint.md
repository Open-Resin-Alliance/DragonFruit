# Joint (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: A spherical break in a support’s shaft.
*   **Purpose**: Allows changing the angle of adjacent shaft segments without moving the ends.
*   **Key Characteristics**:
    *   Splits shaft into segments.
    *   Can exist on trunks and branches.

## Anatomy & Geometry
*   **Visual Description**: Always a sphere.
*   **Parts**:
    *   **Sphere**: The joint body itself.
*   **Dimensions**: Diameter = shaft diameter + 0.1 mm (0.1 mm larger than connected shaft).

## Placement & Creation
*   **Creation Method**: Hold `J` to enter joint creation mode.
*   **Input Flow**:
    1.  **Hold `J`**: Hover over a support shaft to preview snap.
    2.  **Click**: Splits the shaft and inserts a new Joint at the snapped location.
    3.  **Release `J`**: Exits creation mode.
*   **Initial State**: Inserted at the snapped location, splitting the shaft.

## Connections & Relationships
*   **Parent**: Lives between two [[Shaft]] segments.
*   **Children**: None (connects segments).
*   **Connection Logic**: Connects two shaft segments.
*   **Constraints**: Ordered from bottom to top along a support.

## Behavior & Rules
*   **Movement**: Moving a Joint changes the angle of shaft segments directly above and below it. Tip and base anchors do not move.
*   **Editing**:
    *   **Scaling**: Controls diameter of shaft on both sides uniformly (no taper across a joint).
    *   **Arc Mode (Potential)**: Hold hotkey to shape adjacent shaft as an arc through the joint.
*   **Interaction**: Pickable element (GPU picking).

## Technical Appendix
*   **Parameters**:
    *   Diameter: Defined by shaft settings + 0.1mm.
*   **Validation**:
    *   Enforces equal shaft diameters on both connected sides.

## Notes & Terminology
*   **Terminology**: None.
