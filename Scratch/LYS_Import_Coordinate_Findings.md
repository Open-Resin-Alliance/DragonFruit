# LYS Import Coordinate Findings (Current)

## Purpose
Capture the current coordinate-space conclusions from repeated Lychee export experiments.

## Confirmed Findings

1. **Support data behaves model-relative, not world-relative, for placement/orientation values.**
   - In the rotation-only experiment (model rotated, supports untouched), support endpoint/settings values remained stable while object rotation changed.

2. **Support fields we can reliably track and compare between exports:**
   - `base` (shaft base position)
   - `tip` (contact position)
   - `tipNormal` (tip orientation vector)
   - `settings.tip.length`
   - `settings.tip.angle`
   - `settings.base.joinLength` (knee/first-joint length driver)
   - object linkage fields (`objectIdTip`, `objectIdBase`)

3. **The support base plate behavior has a world-space exception on Z.**
   - Practical rule from testing: the base shaft anchoring references plate Z behavior, while the rest of support geometry follows model-relative behavior.

4. **The import puzzle is now narrowed.**
   - The remaining gap is not “do we have enough support fields?”
   - The remaining gap is selecting and applying the correct model pivot/transform chain consistently for those fields.

## Strongly Likely (Working Hypothesis)

1. **`formerCenter` is likely the model pivot center used for support-relative interpretation.**
2. That pivot likely needs to be consistently paired with object rotation/scale when reconstructing support world positions.

## Important Precision Note

- We should treat the `formerCenter` statement as **high confidence, not absolute proof yet** until we run one direct pivot-validation experiment (below).

## Next Verification to Finalize 100%

Run one controlled export test:

1. Keep supports unchanged.
2. Rotate model only (already done once and useful).
3. Then shift model center/pivot context in Lychee (if available) without editing supports.
4. Re-export and compare whether support values move exactly as predicted by `formerCenter`-based transform math.

If this matches, we can mark the pivot conclusion as confirmed.

## Practical Working Rule (Safe to Use Now)

For importer debugging and parity checks:

- Treat support geometry fields as model-relative.
- Treat base-shaft Z anchoring as the special plate/world exception.
- Track `tipNormal` + `tip` + `base.joinLength` together (not in isolation).
- Use object link IDs to ensure supports are interpreted in the correct model frame.
