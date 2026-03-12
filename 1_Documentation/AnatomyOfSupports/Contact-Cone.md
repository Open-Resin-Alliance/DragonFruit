# Contact cone (Element) — Source of Truth

## Plain Language Overview
*   **What it is**: The final piece of the support structure that interfaces with the model.
*   **Purpose**: To provide a clean, minimal contact point with the model surface.
*   **Key Characteristics**:
    *   Small end touches model, large end plugs into support.
    *   No extra parts between cone and joint.

## Anatomy & Geometry
*   **Visual Description**: A conical segment.
*   **Parts**:
    *   **Tip**: The tiny contact face that touches the model; may embed slightly.
    *   **Cone body**: The conical segment between the tip and the socket side (defines overall length and angles).
    *   **Socket joint**: A spherical [[Joint]] at the socket side; there is no [[Shaft]] between the cone body and this Joint.
*   **Dimensions**: Defined by `SupportTipProfile` (length, diameters, angle).

## Placement & Creation
*   **Creation Method**: Automatically created as the terminal piece of [[Trunk]]s, [[Branch]]es, [[Leaf]]s, [[Twig]]s, and [[Stick]]s.
*   **Input Flow**: Placed when the user defines a support tip location on the model.
*   **Initial State**: Points straight out from the model surface (perpendicular to averaged normal).

## Connections & Relationships
*   **Parent**: Connects to the last [[Shaft]] of a support via a standard [[Joint]].
*   **Children**: None (terminal element).
*   **Connection Logic**: Socket side connects directly to a [[Joint]].
*   **Constraints**: Contact face goes to model only; socket side goes to [[Joint]] only. Never connects directly to a Shaft.

## Behavior & Rules
*   **Movement**: Moves with the support tip.
*   **Editing**: Can be resized via settings.
*   **Interaction**:
    *   **Alignment**: Cone axis follows averaged surface direction under contact area (area-weighted average of triangle normals).
    *   **Penetration**: Pushes contact face slightly into model along axis.

## Technical Appendix
*   **Parameters** (from `SupportTipProfile`):
    *   `shape`: 'cone'
    *   `contactDiameterMm`: Small end touching model.
    *   `bodyDiameterMm`: Larger end (socket side).
    *   `lengthMm`: Total cone length.
    *   `penetrationMm`: Embed depth.
    *   `coneAngleDeg`: Overall cone profile.
    *   `breakpointMm`: Optional internal breakpoint for a two-stage cone.
*   **Validation**:
    *   Watertight join at socket-to-joint interface.
    *   Respects minimum spacing between nearby contact cones.

## Notes & Terminology
*   **Research**: See [[Contact-Tip-Research]] for constant-area tip concepts.
