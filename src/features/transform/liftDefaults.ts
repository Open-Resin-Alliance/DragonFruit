/**
 * Default lift distance for the transform panel, in mm.
 *
 * The lift is how far the model sits above the plate so supports have room to
 * form. It has to cover the root structure as well as the shaft: with the
 * default roots (a 0.5mm disk plus a 1.5mm cone, so a 2mm root top) a 5mm lift
 * left 3mm of actual shaft, which is why lifted models came out as stubs. 7mm
 * leaves 5mm of shaft above the roots.
 *
 * Machine profiles carry their own `liftDistanceMm` for the printer's Z-lift
 * between layers; this one is the model's placement height and is unrelated.
 */
export const DEFAULT_LIFT_DISTANCE_MM = 7;
