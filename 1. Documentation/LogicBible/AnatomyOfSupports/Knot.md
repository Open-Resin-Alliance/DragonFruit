# Knot (Anchor) — Source of Truth

## Plain Language Overview
*   **What it is**: A spherical break point used to connect one support to another.
*   **Purpose**: To attach a support (like a Branch) to another support's shaft.
*   **Key Characteristics**:
    *   Similar shape to a Joint but different behavior.
    *   Maintains connection to another element; does not move freely in 3D.

## Anatomy & Geometry
*   **Visual Description**: Always a sphere.
*   **Parts**:
    *   **Sphere**: The knot body.
*   **Dimensions**: Diameter = host shaft diameter + 0.1 mm.

## Placement & Creation
*   **Creation Method**: Created automatically as the base of a [[Branch]] or integrated into a [[Leaf]].
*   **Input Flow**: Placed when creating a Branch or Leaf.
*   **Initial State**: Snapped to a host shaft.

## Connections & Relationships
*   **Parent**: Lives on a [[Shaft]] of a trunk or branch.
*   **Children**: Acts as the base for a [[Branch]] or the anchor for a [[Leaf]].
*   **Connection Logic**: Programmatic connection to a host shaft.
*   **Constraints**: Connects only to a shaft of another trunk or branch (never to model/plate).

## Behavior & Rules
*   **Movement**: Can only slide along the axis of the host shaft. No off-axis movement.
*   **Editing**: Sliding is allowed as long as there is a shaft to slide on.
*   **Interaction**: Pickable element (GPU picking).

## Technical Appendix
*   **Parameters**:
    *   Diameter: Host shaft diameter + 0.1mm.
*   **Validation**:
    *   Must remain on host shaft.

## Notes & Terminology
*   **Terminology**: "Anchor" is an accepted alias.
*   **Snapping**: Uses universal [[Snapping]] logic.
