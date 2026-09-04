# Contact Disk

The contact disk — "the nib" — is the flat terminal piece that interfaces a twig with the model. It is the twig's counterpart to the [Contact Cone](contact-cone.md).

## What it is

- A short flat cylinder seated on the model surface.
- The terminal element of a [Twig](twig.md), which carries two of them (`contactDiskA`, `contactDiskB`).
- Distinct from a contact cone: a cone tapers from a small tip into a socket, a disk is a flat standoff pad. **Twigs are the only support type that uses disks** — trunks, branches and leaves end in one cone, and sticks in two.

## Geometry

- Body: a cylinder whose axis is aligned to the model's surface normal at the contact point.
- Centered at `pos + normal × (thickness / 2)`, so its lower face sits on the recorded contact point.
- Main dimensions:
  - contact diameter (the footprint on the model)
  - thickness (computed — see below, not authored)

## Thickness: the standoff rule

Disk thickness is **derived, not set**. It answers one problem: when a twig meets the model at a shallow angle, a fixed-thickness pad lets the body clip into the wall. The disk grows to hold the body off.

The input is the angle between the disk's surface normal and the cone axis — `0` when the support points straight out of the surface, larger as it lies down against it:

- At or below `standoffAngleThreshold` (default 45°), thickness is `diskThicknessMm` (default 0.1 mm).
- Above the threshold, thickness interpolates linearly toward `maxStandoffMm`, reaching it at ~81°.
- Degenerate normals or a missing profile fall back to the minimum thickness.

Implemented in `calculateDiskThickness` (`src/supports/SupportPrimitives/ContactDisk/contactDiskUtils.ts`).

!!! warning "Legacy clamp on `maxStandoffMm`"
    A `maxStandoffMm` of exactly `1.5` is treated as the old default and silently clamped to `0.35`; any other value is used as authored. A user who deliberately sets 1.5 gets 0.35. Keep this in mind before trusting a profile's stored number — and before changing the default, which would change which profiles the clamp catches.

## Behavior

- The disk is draggable across the model surface: `ContactDiskHud` renders a ring gizmo around it, and `contactDiskDragController` runs the drag session.
- During a drag the surface normal is re-derived from the mesh (`calculateSmoothedNormal`) rather than carried over, so the disk re-seats itself as it moves. Clip bounds are respected.
- Because thickness follows the angle, moving a disk onto a steeper face thickens it on its own.
- `placementSurface` records whether the contact landed on the model's interior or exterior.

## Profiles

`profile` is a `ContactDiskProfile`, one variant of the shared `SupportTipProfile` union declared in `src/supports/SupportPrimitives/ContactCone/types.ts`. The other variant is `ContactSphereProfile` ("the ball joint"), a spherical buffer. The union is also what a contact cone's tip uses, so "disk" names both this twig terminal element **and** a tip shape a cone can wear — check which one a piece of code means.

## Constraints

- A disk contacts the model only; it never seats on the plate, the raft, or another support.
- Thickness is computed on read — do not persist it as an authored value.
- `diskLengthOverride` bypasses the computed thickness where a caller needs a fixed one.

## Related

- [Contact Cone](contact-cone.md) — the tapered terminal used by every other type
- [Twig](twig.md) — the only support type that carries disks
- [Contact Tip Research](contact-tip-research.md) — the design exploration these profiles came out of
