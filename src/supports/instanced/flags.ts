/**
 * The instanced support renderer's flags, one per primitive kind, each selecting
 * a capacity-managed batch in Support mode instead of the legacy per-colour
 * groups.
 *
 * Step 1 draws the unselected supports' joints. On is the tested state for step
 * 1. Every consumer keeps its legacy per-colour `InstancedJointGroup` — and the
 * joint hover/marquee overlays — when this is false, so the rollback is this one
 * line rather than a second code path.
 *
 * Declared `boolean`, not `false`: a literal type would let TypeScript narrow
 * every `SUPPORT_INSTANCED_JOINTS ? new : legacy` in a consumer to the legacy
 * branch and report the instanced branch as dead code.
 */
export const SUPPORT_INSTANCED_JOINTS: boolean = true;

/**
 * Step 2: the unselected supports' straight *and tapered* shafts, drawn as one
 * capacity batch for the straight ones plus one per quantized taper ratio.
 *
 * On is the tested state. With it false the producer keeps dropping tapered
 * supports and every consumer keeps its legacy per-colour `InstancedShaftGroup`,
 * so the rollback is this one line rather than a second code path.
 *
 * On, tapered twigs, kickstands and straight braces stay in the producer's groups
 * with both end diameters and draw as cone instances instead of per-segment
 * detail (one 16-segment `ShaftRenderer` plus a zero-alpha pick shell each). That
 * is Support mode only: the simple and navigation views have no batch, so they
 * keep the legacy drop and their detail meshes. Tapered supports stay visible
 * either way; what changes is *how* they are drawn and how a hover lifts them —
 * the instanced palette and the x1.02 matrix scale replace the detail renderer's
 * hover colour and emissive. That is the intended change and belongs in the A/B
 * set. Curved shafts are unaffected: a tapered curve still goes to its detail
 * renderer, because a merged tube has one radius.
 *
 * Declared `boolean`, not `false`, for the same reason as the joint flag: a
 * literal type would let TypeScript narrow every `SUPPORT_INSTANCED_SHAFTS ? new
 * : legacy` in a consumer to the legacy branch and report the instanced branch
 * as dead code.
 */
export const SUPPORT_INSTANCED_SHAFTS: boolean = true;
