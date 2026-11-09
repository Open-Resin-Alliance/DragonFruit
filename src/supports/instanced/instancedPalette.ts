import * as THREE from 'three';

/**
 * The joint colours SupportRenderer resolves today, in the one place an
 * instanced batch can read them from.
 *
 * A batch has one material for every joint, so the three visual states the
 * legacy renderer draws as three separate meshes — the base colour batch, the
 * hover overlay and the marquee overlay — have to become per-instance values.
 * The legends below name the anchor each constant mirrors; keep them in sync
 * with `SupportRenderer.tsx` rather than inventing a second palette.
 */

/** `#666666`: `resolveSceneSupportColor`'s colour while anything is selected. */
export const JOINT_DIM_COLOR = '#666666';

/** `#80fffd`: `BULK_MULTI_SELECTED_COLOR`, also the marquee joint overlay. */
export const JOINT_MARQUEE_COLOR = '#80fffd';

/** The hover and marquee overlays' `emissive`. */
export const JOINT_HOVER_EMISSIVE_COLOR = '#ffffff';

/** The hover and marquee overlays' `emissiveIntensity`. */
export const JOINT_HOVER_EMISSIVE_INTENSITY = 0.12;

/**
 * The hover/marquee overlays draw joints at `diameter * 1.06`, so a highlighted
 * joint is measurably larger, not just brighter.
 */
export const JOINT_HOVER_DIAMETER_SCALE = 1.06;

/**
 * The three states one joint slot can be drawn in.
 *
 * `base` is whatever colour the slot list resolved for the support (model
 * colour, dimmed colour, origin debug colour or bulk selection colour). `hover`
 * is that same colour lifted by the hover emissive; `marquee` is the bulk
 * colour lifted the same way.
 */
export type InstancedJointVisualState = 'base' | 'hover' | 'marquee';

/**
 * The diameter multiplier a state is drawn with.
 */
export function jointVisualScale(state: InstancedJointVisualState): number {
  return state === 'base' ? 1 : JOINT_HOVER_DIAMETER_SCALE;
}

/**
 * Resolve one slot's colour into `target`, avoiding an allocation per instance.
 *
 * The lit programs add emissive after shading, but one batch has one material
 * and therefore one emissive uniform. Step 1 approximates the overlay's
 * `emissive #ffffff × 0.12` by lifting the instance colour itself by 0.12 in
 * linear space (clamped at white). That is exact for the unlit part of the
 * shading and slightly under-bright in shadowed areas, where a real emissive
 * term dominates — the only visual difference step 1 accepts.
 *
 * `baseColor` is a CSS/hex colour, so `set` performs the same sRGB-to-linear
 * conversion the legacy material's `color` prop went through.
 */
export function resolveJointVisualColor(
  baseColor: string,
  state: InstancedJointVisualState,
  target: THREE.Color,
): THREE.Color {
  target.set(state === 'marquee' ? JOINT_MARQUEE_COLOR : baseColor);
  if (state === 'base') return target;

  const lift = JOINT_HOVER_EMISSIVE_INTENSITY;
  target.setRGB(
    Math.min(1, target.r + lift),
    Math.min(1, target.g + lift),
    Math.min(1, target.b + lift),
  );
  return target;
}
