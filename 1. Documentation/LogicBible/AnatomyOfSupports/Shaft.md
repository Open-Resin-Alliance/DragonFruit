# Shaft (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: A straight cylindrical segment of a support.
*   **Purpose**: To span distance between joints or anchors.
*   **Key Characteristics**:
    *   Straight cylinder.
    *   Connects two endpoints.

## Anatomy & Geometry
*   **Visual Description**: Cylindrical.
*   **Parts**:
    *   **Cylinder**: The main body.
*   **Dimensions**: Diameter defined per segment by settings.

## Placement & Creation
*   **Creation Method**: Automatically created between [[Joint]]s, [[Knot]]s, [[Roots]], and [[Contact cone]]s.
*   **Input Flow**: Created as part of Trunk/Branch/Stick/Twig generation.
*   **Initial State**: Straight segment between endpoints.

## Connections & Relationships
*   **Parent**: Connects two endpoints (Joint-Joint, Joint-Anchor, etc.).
*   **Children**: Can host [[Knot]]s (for Branches/Leafs) or [[Joint]]s.
*   **Connection Logic**: Continuous chain.
*   **Constraints**: No taper across a Joint (equal diameters enforced).

## Behavior & Rules
*   **Movement**: Updates orientation/length when endpoints move.
*   **Editing**: Diameter editable.
*   **Interaction**: Pickable element (segment ID).

## Technical Appendix
*   **Parameters**:
    *   Diameter per segment.
*   **Validation**:
    *   Must be straight (curved behavior handled by separate feature).

## Notes & Terminology
*   **Terminology**: None.
