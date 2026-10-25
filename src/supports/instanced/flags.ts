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

/**
 * Step 3a: the unselected supports' contact cones, drawn as one capacity batch
 * per quantized body/contact ratio plus one tip batch and one nib batch.
 *
 * On is the tested state. Off, every consumer keeps its per-colour
 * `InstancedContactConeGroup` and the cone hover/marquee overlays, so the
 * rollback is this one line rather than a second code path.
 *
 * On, the profile split survives as a per-instance data bit rather than a batch:
 * `sphere` and `legacy` cones draw the body and tip, `disk` cones draw the body,
 * tip and nib, and the nib's material needs the legacy `polygonOffset 1/1` or it
 * z-fights the plate exactly as the legacy nib would not. Positions arrive with
 * the model drop offset already applied; the nib's penetration stays a writer
 * input because it follows the active material profile, not scene state.
 *
 * Declared `boolean`, not `false`, for the same reason as the joint flag: a
 * literal type would let TypeScript narrow every `SUPPORT_INSTANCED_CONES ? new
 * : legacy` in a consumer to the legacy branch and report the instanced branch
 * as dead code.
 */
export const SUPPORT_INSTANCED_CONES: boolean = true;

/**
 * Step 3b: the unselected plate roots, drawn as one capacity batch per quantized
 * cone ratio plus one disk and one top-ball batch.
 *
 * On is the tested state. Off, every consumer keeps its per-colour
 * `InstancedRootsGroup` and the root hover/marquee overlays.
 *
 * On, only the disk batch answers the pointer, matching the legacy group — the
 * cone and top ball were `raycast={() => null}` there and must stay inert, or a
 * root's silhouette starts swallowing clicks the plate owns. The 0.01 mm render
 * lift is applied by the writer, because it is a rendering offset the producer
 * never applies to `basePos`.
 *
 * Declared `boolean`, not `false`, for the same reason as the joint flag.
 */
export const SUPPORT_INSTANCED_ROOTS: boolean = true;

/**
 * Whether a joint drag keeps the preview out of the scene's render lists.
 *
 * The dragged support is drawn by its detail renderer, which already subscribes
 * to the part-drag preview and moves itself. Substituting the preview entity in
 * `renderListByType` as well rebuilt every producer and rewrote every instanced
 * batch on each 25 ms publish; with this on, the scene lists keep the committed
 * entity for the gesture and only the detail renderer (and the joint/contact
 * gizmo) follows the pointer.
 *
 * The preview knot overrides still move leaf host knots, so a leaf hanging on the
 * dragged support still follows; dependent branches remain frozen exactly as
 * before. Turn off to restore the old whole-scene substitution.
 */
export const SUPPORT_DETAIL_DRAG_PREVIEW: boolean = true;
