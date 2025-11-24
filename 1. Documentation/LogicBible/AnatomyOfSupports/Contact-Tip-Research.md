# Contact Tip Research (Constant-Area Concepts)

## Purpose
Explore designs that keep the contact surface area at the model exactly as intended (e.g., a 0.4 mm circular footprint), even when the support isn’t perfectly perpendicular to the surface.

## Candidate designs

### 1) Micro‑disc + short blend (hybrid)
- Idea: A tiny flat disc at the tip, always perpendicular to the averaged model normal. Disc diameter equals target contact diameter. The cone blends into the disc with a short, smooth transition.
- Goals: guarantee a precise circular contact footprint; keep the tip visually clean; preserve cone strength.
- Angle-aware standoff: disc thickness (or a tiny standoff) increases slightly at steeper angles to reduce resin fusion risk.
- Tunables (no numbers locked yet):
  - discDiameterMm = targetContactDiameterMm
  - discThicknessMm (auto-adjust vs tilt)
  - blendLengthMm (may scale modestly with tilt)
  - min/max standoff to preserve strength and finish

### 2) Spherical‑cap with depth compensation
- Idea: Use a small spherical cap at the tip and adjust its offset (and/or effective radius) so the cross‑section on the model stays the target diameter at any tilt.
- Goals: maintain circular footprint across angles; smooth transition by nature of the cap.
- Considerations: at large tilts the cap may need a larger radius and a controlled surface offset; needs angle-aware compensation logic.
- Tunables (no numbers locked yet):
  - capRadiusMm (may grow with tilt)
  - offset/penetration along averaged normal
  - max tilt handling to avoid extreme shapes

## Shared alignment rule
- Tip axis aligns to the averaged model surface normal under the contact footprint.

## Open questions
- Maximum supported tilt before constraining geometry?
- Preferred visual look versus strict material minimization?
- Interaction with tip spacing/clearance in dense areas?

## Next steps (when ready)
- Prototype micro‑disc + blend with angle-aware standoff.
- Compare with spherical‑cap compensation for extreme tilt cases.
- Validate print results (contact scar size, adhesion, cleanup) on test models.
