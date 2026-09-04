# Contact Tip Research

This page keeps the design notes for constant-area contact tips.

!!! note "Both candidates below have shipped"
    They are no longer open questions. The micro-disc with angle-aware standoff
    is `ContactDiskProfile` ("the nib") and the spherical cap is
    `ContactSphereProfile` ("the ball joint") — two variants of the
    `SupportTipProfile` union in
    `src/supports/SupportPrimitives/ContactCone/types.ts`. See
    [Contact Disk](contact-disk.md) for the standoff rule as implemented. What
    remains open is the evaluation below: which to prefer at extreme tilt, and
    the printed-footprint validation.

## Goal

Explore tip designs that preserve the intended contact footprint on the model even when the support is not perfectly perpendicular to the surface.

## Candidate directions

### Micro-disc with short blend

- Tiny flat disc at the tip.
- Disc stays perpendicular to the averaged model normal.
- A short blend transitions the disc into the cone body.
- Angle-aware standoff can reduce resin fusion risk at steeper angles.

### Spherical cap with compensation

- Small spherical cap at the tip.
- Offset and effective radius can be adjusted to keep the footprint consistent across tilt angles.
- This approach favors smooth curvature, but needs careful compensation logic at large tilts.

## Shared rule

- The tip axis aligns to the averaged model surface normal under the contact footprint.

## Open questions

- How much tilt should the geometry support before it needs to clamp?
- Should the visual design favor strict footprint control or simpler manufacturability?
- How should dense tip spacing interact with the chosen shape?

## Next steps

- Prototype the micro-disc hybrid with angle-aware standoff.
- Compare it against the spherical-cap approach for extreme tilt cases.
- Validate the printed contact size and cleanup behavior on test models.

