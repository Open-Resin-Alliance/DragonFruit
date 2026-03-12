# Brace (Element, Stabilizer) — Source of Truth

## Plain Language Overview
* **What it is**: A `shaft` with a `[[Knot]]` at both ends that connects support → support. Never touches the model.
* **Purpose**: Primarily increases stability and stiffness of support networks, but is not limited to lateral stability.
* **Key Characteristics**:
  * Ends are always `[[Knot]]`s snapping to a `[[Shaft]]` (no `[[Contact cone]]`, no `[[Leaf]]`).
  * Can connect to any support type’s `[[Shaft]]`: `[[Trunk]]`, `[[Branch]]`, `[[Stick]]`, `[[Twig]]`, or another `[[Brace]]`.
  * Optional internal `[[Joint]]`s along the brace (default 0; max 1, controlled by settings).

## Anatomy & Geometry
* **Visual Description**: A straight cylindrical segment between two knots (v1). Curvature may be enabled later via settings.
* **Parts**:
  * **Knot A & Knot B**: Endpoints that seat on host `[[Shaft]]`s. Never contact the model.
  * **Brace Shaft**: The continuous body between the knots.
  * **Optional Joints**: Up to 1 internal `[[Joint]]` along the brace, if enabled.
* **Dimensions**:
  * End diameters inherit from their host `[[Shaft]]`s. If Knot A sits on a 1.00 mm shaft and Knot B on a 2.00 mm shaft, the brace end at A is 1.00 mm and the end at B is 2.00 mm.
  * The brace transitions between the two end sizes along its length (profile/transition style is settings-driven).
  * Knot style/size and seat depth are settings-driven; manual per-end overrides may be exposed, but defaults follow the host shafts.

## Placement & Creation
* **Creation Method**: Hold `Alt`. Alt + click on a support begins Brace creation (preview). Alt + click on the model invokes `[[Branch]]` creation; this page only covers braces.
* **Input Flow**:
  1. **Alt + Click** a host `[[Shaft]]` to set Knot A.
  2. **Preview** the brace toward the pointer.
  3. **Click** another host `[[Shaft]]` (can be `Trunk/Branch/Stick/Twig/Brace`) to set Knot B and commit.
* **Initial State**: Straight segment between two knots, each seated on its host shaft.

## Connections & Relationships
* **Allowed Targets**: Any support `[[Shaft]]`, including a `[[Brace]]` shaft.
* **Same-Support**: A brace may connect two positions on the same shaft (subject to minimum separation rules).
* **Shared Knots**: Multiple braces may share the same `[[Knot]]` on a host shaft (see Merge behavior).
* **Never**: Model contact, `[[Contact cone]]`, or `[[Leaf]]` at brace ends.
* **Connection Logic**: Host Shaft ↔ Knot ↔ Brace Shaft ↔ Knot ↔ Host Shaft.

## Snapping, Merge, and Non-Overlap Rules
* **Trigger**: When placing Knot C (second end) near an existing Knot A on a shaft.
* **Merge Confirmation**: Show a modal: “Combine these knots into a single knot?”
  * **Combine**: Merge into a single `[[Knot]]` at A; reparent attached braces; undo-safe.
  * **Keep separate**: Place a distinct knot C with automatic offset (see below). Knots must never overlap.
* **Automatic Offset (Keep separate)**:
  * Minimum longitudinal separation along the host shaft: `0.05 mm` (settings-driven).
  * Choose above/below deterministically using the other end (Knot B):
    * Let T be the shaft tangent at A; V = normalize(B − A).
    * If dot(V, T) ≥ 0, place C at A + T · min_sep; else at A − T · min_sep.
  * If that slot is occupied (< min_sep), search ±k multiples of min_sep, preferring the side implied by B.
  * Optional angular separation may be applied if the seat supports circumferential offsets (settings).
* **Density Guardrails**: Enforce max braces per knot/region via settings. If exceeded, default to Keep separate with offset or reject.

## Behavior & Rules
* **Movement**: Dragging a knot slides/re-snaps along the host `[[Shaft]]`; the brace updates accordingly.
* **Editing**:
  * Joints on Brace: Default 0; max 1 per brace (settings). Placement may be auto at fractional positions (e.g., 50%).
  * End diameters: By default inherit from host shafts; optional manual adjustment may be allowed per knot (if enabled in settings).
  * Split shared knot: Provide UI to split out a selected brace from a shared knot and create a new offset knot.
* **Deletion**: Removing a host support or brace that owns a shared knot prompts to reassign or delete dependent braces; undo-safe.
* **Selection**: Selecting either knot selects the brace; shared knot selection exposes attached braces.

## Constraints & Validation
* **No Model Contact**: Hard fail if any brace knot or shaft intersects the model.
* **Non-Overlapping Knots**: Knots must never occupy the exact same position unless merged; enforce min separation.
* **Removability**: Maintain access for cutting and avoid trapped resin volumes.

## Settings (not exhaustive; values are not hardcoded)
* Brace diameter/profile.
* Knot style/size and seat behavior on shafts.
* Max braces per knot and per local region; min longitudinal/angular separation; snap tolerance.
* Joints on brace: enabled, max count (1), and placement strategy.
* Same-support bracing toggle and minimum separation.
* Merge confirmation: show modal on/off; default action if disabled (Combine vs Keep separate).
* Preview style: straight (v1) vs curved.

## Notes & Future
* **Auto-Bracing**: To be added later (heuristics for intervals, triangulation, peel vector alignment, slenderness).
* **Z-Up / Units**: Z points up; lengths in millimeters.
