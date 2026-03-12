# Trunk (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: The main support column that connects to the build plate (via [[Roots]]).
*   **Purpose**: To support the model from the ground up.
*   **Key Characteristics**:
    *   Rooted to plate/raft.
    *   Parent anchor for attached supports.

## Anatomy & Geometry
*   **Visual Description**: A chain of shafts starting from [[Roots]].
*   **Parts**:
    *   **Roots**: The base element.
    *   **Shaft(s)**: Vertical segments.
    *   **Joints**: Spherical connections.
    *   **Contact cone**: Terminal element at model.
*   **Dimensions**: Auto-adjusts length to placement height.

## Placement & Creation
*   **Creation Method**: Standard support placement (Click on model).
*   **Input Flow**: Click on model surface to place.
*   **Initial State**: Vertical by default.

## Connections & Relationships
*   **Parent**: Connects to [[Roots]] (which sit on Plate/Raft).
*   **Children**: Can support [[Branch]]es and [[Leaf]]s.
*   **Connection Logic**: Trunk shaft embeds into Roots sphere.
*   **Constraints**: Exactly one trunk per Roots.

## Behavior & Rules
*   **Movement**: User can change angle. Length auto-adjusts.
*   **Editing**: Angle/Length editable.
*   **Interaction**:
    *   **Roots Connection**: Solid, watertight interface.

## Technical Appendix
*   **Parameters**:
    *   Length: Dynamic.
*   **Validation**:
    *   First segment above Roots always has a joint at the top.

## Notes & Terminology
*   **Terminology**: None.
