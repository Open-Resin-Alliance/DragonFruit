# Leaf (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: A minimal support element with a contact face and an integrated [[Knot]].
*   **Purpose**: To add small, precise contacts to the model without adding a shaft.
*   **Key Characteristics**:
    *   No shaft, no joint.
    *   Connects directly from model to parent support.

## Anatomy & Geometry
*   **Visual Description**: A cone attached directly to a sphere on a support shaft.
*   **Parts**:
    *   **Tip**: Contact face touching the model.
    *   **Cone body**: Cone geometry.
    *   **Knot (Anchor)**: Integrated at the socket side (no shaft/joint).
*   **Dimensions**: Tip parameters same as [[Contact cone]]. Knot diameter = host shaft + 0.1mm.

## Placement & Creation
*   **Creation Method**: Hold `Ctrl+Alt` to enter Leaf placement mode.
*   **Input Flow**:
    1.  **First Click**: Sets contact point/normal on model.
    2.  **Move Pointer**: Integrated [[Knot]] snaps to parent shaft.
    3.  **Second Click**: Finalizes Leaf if snapped to support.
*   **Initial State**: Connected between model and parent shaft.

## Connections & Relationships
*   **Parent**: Connects to a [[Shaft]] of a trunk or branch via integrated [[Knot]].
*   **Children**: None.
*   **Connection Logic**: Contact face -> Model. Integrated Knot -> Parent Shaft.
*   **Constraints**: Never connects to a Joint.

## Behavior & Rules
*   **Movement**: Inherits transforms from parent support. Integrated Knot slides along parent shaft.
*   **Editing**: Tip parameters editable.
*   **Interaction**: Removed if parent is removed.

## Technical Appendix
*   **Parameters**:
    *   Tip: `contactDiameterMm`, `bodyDiameterMm`, `lengthMm`, `penetrationMm`, `coneAngleDeg`, `breakpointMm`.
    *   Knot: Host shaft diameter + 0.1mm.
*   **Validation**:
    *   Respects tip spacing/clearance.

## Notes & Terminology
*   **Terminology**: None.
