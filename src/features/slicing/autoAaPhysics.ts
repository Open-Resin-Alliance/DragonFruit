/**
 * Physics-based automatic AA parameter prediction for mSLA printers.
 *
 * Derives all AA settings from two measurable physical quantities — pixel pitch
 * (XY) and layer height (Z) — plus empirically calibrated optical constants.
 * No arbitrary heuristic tables or hard-coded step counts are used.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Physical model
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * mSLA prints are composed of voxels defined by two length scales:
 *
 *   pixel pitch (XY) — the lateral size of one display pixel on the build plate
 *   layer height (Z) — the vertical thickness of one cured layer
 *
 * Voxel aspect ratio:  r = layerHeight / pixelPitch
 *
 *   r ≪ 1  →  "pancake" voxel — layers much thinner than pixels; Z steps fine
 *   r ≈ 1  →  cubic voxel     — equal staircase character in all directions
 *   r ≫ 1  →  "pillar" voxel  — layers much thicker than pixels; heavy Z steps
 *
 *
 * UV Bloom
 * ────────
 * UV light (typically 405 nm) passing through the LCD panel and FEP film
 * diffracts and scatters, creating a physical penumbra around each lit pixel.
 * Published edge-characterisation studies on mSLA pixel profiles
 * (Gong et al. 2014; Pan et al. 2012) put the 1/e² bloom radius at roughly
 * 0.25–0.35 × pixel pitch for standard 4–6K printers with 0.04–0.06 mm pitch.
 * High-resolution printers with tighter optics sit near the lower bound.
 *
 * Bloom softens edges "for free" — AA needs only to cover the remaining gap
 * between bloom-provided softening and the total desired edge gradient.
 *
 *
 * AA Strength (supersampling steps)
 * ───────────────────────────────────
 * Supersampling renders each layer at N times the native resolution and then
 * downsamples, distributing sub-pixel coverage across edge boundaries.
 * Perceptual benefit is sub-linear in N: 4× provides ~75 % of the theoretical
 * edge-quality maximum; 8× provides ~88 %; 16× adds less than 5 % more.
 *
 * We model this with a power-law scale anchored at 4× for a 0.05 mm reference
 * pitch.  The sub-linear exponent (0.7) matches the flattening of the
 * perceptual improvement curve reported in sub-pixel rendering literature and
 * avoids the runaway values produced by a linear 1/pitch formula on high-res
 * screens (e.g. 21× for a 12K printer at 0.019 mm pitch).
 *
 *
 * 2D Blur Width
 * ─────────────
 * A box/Gaussian blur applied after supersampling adds physical softening to
 * round off the remaining hard pixel boundary.  The target softening distance
 * (mm) is preset-dependent; bloom is subtracted because the printer already
 * provides that much softening naturally:
 *
 *   blur_px = max(1, round( (target_mm − bloom_mm) / pitch_mm ))
 *
 * This produces 1 px for most printers at Balanced (bloom covers much of the
 * target) and rises to 2–4 px only for very fine-pitch screens where even 1 px
 * of blur = very little physical distance.
 *
 *
 * 3DAA Look-back (blend window)
 * ─────────────────────────────
 * Z-axis anti-aliasing blends adjacent layers at sloped surfaces.  The look-back
 * depth controls how many layers above and below contribute to the blend.
 *
 * Geometric derivation:
 *   On a 45° slope, each layer rises by `layerMm` and moves `layerMm` laterally.
 *   In pixels: that is (layerMm / pitchMm) = aspectRatio pixels per layer.
 *   To traverse one full pixel pitch at 45°: ceil(aspectRatio) layers.
 *
 * Balanced adds +1 safety layer (covers near-45° surfaces with margin).
 * Smooth extends to 1.5× to also cover shallower ≈ 30° slopes
 * (tan(30°) ≈ 0.577 → needs ~1.73× as many layers ≈ 1.5× rounded down).
 *
 *
 * Note on model geometry
 * ─────────────────────
 * Loaded model geometry (slope distribution, surface area) is intentionally NOT
 * incorporated because:
 *   a) The slope-adaptive blending mode inside the Rust slicer already performs
 *      per-pixel geometric analysis during rasterisation.
 *   b) Bounding-box data cannot reliably predict the dominant slope angles of a
 *      complex organic print.
 *   c) Pixel pitch + layer height already encode the worst-case 45° scenario
 *      which is the correct design target for parameter selection.
 */

// ── Physical constants ────────────────────────────────────────────────────────

/**
 * Bloom radius as a fraction of pixel pitch.
 * Midpoint of the 0.25–0.35 range reported for typical 405 nm mSLA optics.
 */
const BLOOM_PITCH_FRACTION = 0.28;

/**
 * Reference pixel pitch (mm) at which base AA step count equals 4.
 * 0.05 mm ≈ a typical 4K mSLA screen (e.g. 2560 × 1440 on 128 × 80 mm plate).
 */
const REFERENCE_PITCH_MM = 0.05;

/**
 * Sub-linear exponent for AA step scaling with pixel pitch.
 *
 * At 0.019 mm pitch (12K printer) vs 0.05 mm reference:
 *   linear  (exp = 1.0): 4 × (0.05 / 0.019) ≈ 10.5 → 11  — overshoot
 *   sub-lin (exp = 0.7): 4 × 2.63^0.7       ≈  7.9 →  8  — sensible cap
 */
const PITCH_SCALE_EXPONENT = 0.7;

/**
 * Hard ceiling on automatically selected supersampling steps.
 *
 * Beyond 8× each doubling of steps costs proportional render time while
 * contributing imperceptible improvement at mSLA print resolution.
 * Users requiring higher values can switch to Advanced mode.
 */
const AA_STEPS_AUTO_MAX = 8;

/**
 * Physical blur targets (mm of desired edge gradient) per preset, before
 * subtracting bloom softening that the printer already provides naturally.
 *
 *   sharp    0.020 mm — minimal rounding; preserves fine detail and lettering
 *   balanced 0.040 mm — clear smoothing without destructive detail loss
 *   smooth   0.075 mm — aggressive softening; suited to organic/curved surfaces
 */
const BLUR_PHYSICAL_TARGET_MM = {
  sharp:    0.020,
  balanced: 0.040,
  smooth:   0.075,
} as const;

/**
 * Aspect ratio threshold below which 3DAA adds negligible benefit.
 *
 * When layerHeight / pixelPitch < 0.30 (e.g. 0.010 mm layers on a 0.047 mm
 * pitch printer), Z steps are sub-pixel in height and virtually invisible.
 * 3DAA blending would waste render time for no perceptible gain.
 */
const MIN_ASPECT_RATIO_FOR_3DAA = 0.30;


// ── Types ─────────────────────────────────────────────────────────────────────

/** Quality intent, matching the Auto mode preset buttons in the UI. */
export type AaPreset = 'sharp' | 'balanced' | 'smooth';

/**
 * Fully computed AA configuration produced by this module.
 * Structurally compatible with the legacy AutoAaConfig type.
 */
export type PhysicalAaConfig = {
  /** 'Blur' = 2D supersampling only; '3DAA' = 2D + Z-axis blending. */
  aaMode: 'Blur' | '3DAA';
  /**
   * Supersampling factor (integer ≥ 2).
   * Higher values resolve finer sub-pixel edge detail at proportional render cost.
   */
  aaSteps: number;
  /**
   * 2D blur kernel radius in printer pixels, applied after supersampling.
   * Compensates for residual edge softness after bloom is accounted for.
   */
  blurBrushRadiusPx: number;
  /**
   * 3DAA blend window: number of adjacent layers (above + below) included in
   * the Z-axis blending pass.  Sized to cover one full 45° slope pixel crossing.
   */
  zBlendLookBack: number;
};


// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Estimate the UV bloom radius (mm) for a given pixel pitch.
 *
 * Bloom softens edges physically — our explicit AA needs only to cover the
 * remaining edge gradient distance after bloom is accounted for.
 */
export function estimateBloomRadiusMm(pitchMm: number): number {
  return Math.max(0, pitchMm) * BLOOM_PITCH_FRACTION;
}

/**
 * Compute physics-grounded automatic AA parameters for an mSLA printer.
 *
 * All output parameters derive from two physical lengths (pixel pitch and
 * layer height) plus empirically calibrated optical constants.
 *
 * @param preset   Quality intent: 'sharp' / 'balanced' / 'smooth'
 * @param pitchMm  Physical pixel pitch in mm — use min(pitchX, pitchY)
 * @param layerMm  Effective layer height in mm from the active material profile
 *
 * Reference outputs for common hardware at 0.05 mm layer height:
 *
 *   Printer      pitch   preset     steps  blur   mode    look-back
 *   ──────────   ──────  ─────────  ─────  ─────  ──────  ─────────
 *   12K (0.019)  0.019   balanced    8×    2 px   3DAA    4 lyr
 *   12K (0.019)  0.019   smooth      8×    4 px   3DAA    5 lyr
 *   12K (0.019)  0.019   sharp       4×    1 px   Blur    —
 *    8K (0.028)  0.028   balanced    6×    1 px   3DAA    3 lyr
 *    4K (0.047)  0.047   balanced    4×    1 px   3DAA    3 lyr
 *   low (0.085)  0.085   balanced    3×    1 px   3DAA    2 lyr
 */
export function computePhysicalAaConfig(
  preset: AaPreset,
  pitchMm: number,
  layerMm: number,
): PhysicalAaConfig {
  const safePitch = Math.max(pitchMm, 1e-4);
  const safeLayer = Math.max(layerMm, 0.001);

  const bloomMm = estimateBloomRadiusMm(safePitch);

  /**
   * Voxel aspect ratio: r = layerHeight / pixelPitch.
   *
   *   r < 1  →  "pancake" voxel — Z steps finer than XY pixels
   *   r ≈ 1  →  cubic voxel     — equal staircase in XY and Z
   *   r > 1  →  "pillar" voxel  — Z stepping very visible on sloped faces
   *
   * This drives the 3DAA look-back depth and the decision to use 3DAA at all.
   */
  const aspectRatio = safeLayer / safePitch;


  // ── AA Steps ──────────────────────────────────────────────────────────────
  //
  // Power-law scaling anchored at 4× for the 0.05 mm reference pitch.
  // Sub-linear exponent models diminishing perceptual returns at fine pitch.
  //
  const baseSteps = clamp(
    Math.round(4 * Math.pow(REFERENCE_PITCH_MM / safePitch, PITCH_SCALE_EXPONENT)),
    2,
    AA_STEPS_AUTO_MAX,
  );

  let aaSteps: number;
  switch (preset) {
    case 'sharp':
      // Crisp intent: AA is a minimal staircase correction, not a smoothing pass.
      // Halve the base, floor at 2, cap at 4 — sharp never needs heavy sampling.
      aaSteps = clamp(Math.round(baseSteps * 0.5), 2, 4);
      break;
    case 'smooth':
      // Max useful smoothing: bump by 2 steps, stay within the auto ceiling.
      aaSteps = clamp(baseSteps + 2, 4, AA_STEPS_AUTO_MAX);
      break;
    default: // 'balanced'
      aaSteps = baseSteps;
  }


  // ── Blur Width ────────────────────────────────────────────────────────────
  //
  // Bloom already softens edges by ~bloomMm.  We only add blur for the delta
  // between bloom and the preset's total target softening distance.
  //
  //   blur_px = max(1, round( (target_mm − bloom_mm) / pitch_mm ))
  //
  // At fine pitch, each pixel spans less physical distance, so more pixels of
  // blur are required to achieve the same mm of physical softening — the
  // formula handles this automatically.
  //
  const remainingBlurMm = Math.max(0, BLUR_PHYSICAL_TARGET_MM[preset] - bloomMm);
  const blurBrushRadiusPx = Math.max(1, Math.round(remainingBlurMm / safePitch));


  // ── 3DAA Mode & Look-back ─────────────────────────────────────────────────
  //
  // Sharp preset is always Blur-only: Z-axis blending works against sharpness.
  //
  // Very thin layers (aspectRatio < threshold) make Z steps sub-pixel and
  // perceptually invisible — 3DAA provides no useful gain.
  //
  const use3DAA = preset !== 'sharp' && aspectRatio >= MIN_ASPECT_RATIO_FOR_3DAA;
  const aaMode: 'Blur' | '3DAA' = use3DAA ? '3DAA' : 'Blur';

  let zBlendLookBack = 2; // safe default; only meaningful when aaMode === '3DAA'

  if (use3DAA) {
    //
    // Geometric derivation of the look-back window:
    //
    // On a 45° slope, each layer rises by `layerMm` and advances `layerMm`
    // laterally.  In XY pixels that is (layerMm / pitchMm) = aspectRatio px
    // per layer.  To complete one full pixel-pitch crossing at 45°:
    //
    //   layers_needed = ceil(aspectRatio)
    //
    // Balanced adds one extra safety layer to handle near-45° surfaces with
    // margin.  Smooth extends to 1.5× to also blend shallower ~30° slopes:
    //
    //   tan(30°) ≈ 0.577 → 1/0.577 ≈ 1.73× more layers than 45° → rounded ↓
    //
    // Note: the auto fade distance (computed separately by the Rust engine and
    // mirrored in autoZBlendFadePx) targets an even shallower 20° surface angle
    // — 1/tan(20°) ≈ 2.747 px per layer-height — providing spatial reach for
    // each contributing layer beyond what the look-back window alone covers.
    //
    const baseWindow = Math.max(1, Math.ceil(aspectRatio));

    switch (preset) {
      case 'smooth':
        zBlendLookBack = clamp(Math.round(baseWindow * 1.5), 2, 12);
        break;
      default: // 'balanced'
        zBlendLookBack = clamp(baseWindow + 1, 2, 8);
    }
  }

  return { aaMode, aaSteps, blurBrushRadiusPx, zBlendLookBack };
}
