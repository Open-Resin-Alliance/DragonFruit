/**
 * Step 1 of the instanced support renderer: the unselected supports' joints,
 * drawn as one capacity-managed batch in Support mode.
 *
 * On is the tested state for step 1. Every consumer keeps its legacy per-colour
 * `InstancedJointGroup` — and the joint hover/marquee overlays — when this is
 * false, so the rollback is this one line rather than a second code path.
 *
 * Declared `boolean`, not `false`: a literal type would let TypeScript narrow
 * every `SUPPORT_INSTANCED_JOINTS ? new : legacy` in a consumer to the legacy
 * branch and report the instanced branch as dead code.
 */
export const SUPPORT_INSTANCED_JOINTS: boolean = true;
